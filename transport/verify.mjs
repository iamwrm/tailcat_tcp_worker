#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { verifyArtifacts } from './artifacts.mjs';

const dist = new URL('./dist/', import.meta.url);
try {
  const manifest = JSON.parse(await readFile(new URL('manifest.json', dist), 'utf8'));
  const packed = await readFile(new URL('tailcat.wasm.gz', dist));
  verifyArtifacts(manifest, packed, await readFile(new URL('go-runtime.js', dist)));
  console.log(`Verified Tailcat ${manifest.target} artifacts (${manifest.go}), Node ${process.version}`);
} catch (error) {
  console.error(error.code === 'ENOENT' ? 'Missing WASM artifacts: run npm run download or npm run build' : error.message);
  process.exitCode = 1;
}
