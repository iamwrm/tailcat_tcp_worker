#!/usr/bin/env node
import { readFile, writeFile, mkdtemp, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fetch as fetchURL, EnvHttpProxyAgent } from 'undici';
import { verifyArtifacts } from './artifacts.mjs';
import { networkCode } from './network.mjs';

// Versioned asset, never /latest. Integrity comes from the committed manifest.
export const RELEASE_URL = 'https://github.com/iamwrm/tailcat_wasm/releases/download/wasm-v0.1.0/tailcat.wasm.gz';

export async function downloadArtifact({ dist = new URL('./dist/', import.meta.url), fetch = fetchURL, dispatcher } = {}) {
  const manifest = JSON.parse(await readFile(new URL('manifest.json', dist), 'utf8'));
  const shim = await readFile(new URL('go-runtime.js', dist));
  const destination = new URL('tailcat.wasm.gz', dist);
  let existing;
  try { existing = await readFile(destination); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (existing) {
    try { verifyArtifacts(manifest, existing, shim); return 'cached'; }
    catch { /* Replace corrupt/stale bytes only after verifying the download. */ }
  }

  const expectedSize = manifest.files?.['tailcat.wasm.gz']?.bytes;
  if (!Number.isSafeInteger(expectedSize) || expectedSize <= 0 || expectedSize > 16 * 1024 * 1024) {
    throw new Error('Invalid WASM download size in manifest');
  }
  let packed;
  try {
    const response = await fetch(RELEASE_URL, { dispatcher, signal: AbortSignal.timeout(120000) });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Release download returned HTTP ${response.status}`);
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > expectedSize) throw new Error('Release download exceeds manifest size');
      chunks.push(chunk);
    }
    packed = Buffer.concat(chunks);
  } catch (error) {
    // Do not expose proxy URLs/credentials from underlying network errors.
    if (/^Release download /.test(error.message)) throw error;
    throw new Error(`Release download failed (${networkCode(error)})`);
  }
  verifyArtifacts(manifest, packed, shim);
  const temporary = await mkdtemp(new URL('.download-', dist));
  try {
    const file = join(temporary, 'tailcat.wasm.gz');
    await writeFile(file, packed);
    await rename(file, fileURLToPath(destination));
  } finally { await rm(temporary, { recursive: true, force: true }); }
  return 'downloaded';
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const dispatcher = new EnvHttpProxyAgent();
  try {
    const result = await downloadArtifact({ dispatcher });
    console.log(`WASM ${result} and verified against transport/dist/manifest.json`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
  finally { await dispatcher.close(); }
}
