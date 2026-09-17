#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';

const dist = new URL('./dist/', import.meta.url);
try {
  const manifest = JSON.parse(await readFile(new URL('manifest.json', dist), 'utf8'));
  if (manifest.format !== 1 || manifest.target !== 'js/wasm') throw new Error('Unexpected manifest');
  const packed = await readFile(new URL('tailcat.wasm.gz', dist));
  const files = {
    'tailcat.wasm.gz': packed,
    'tailcat.wasm': gunzipSync(packed, { maxOutputLength: 64 * 1024 * 1024 }),
    'go-runtime.js': await readFile(new URL('go-runtime.js', dist)),
  };
  for (const [name, data] of Object.entries(files)) {
    if (createHash('sha256').update(data).digest('hex') !== manifest.files[name]?.sha256) throw new Error(`Checksum mismatch: ${name}`);
  }
  console.log(`Verified Tailcat ${manifest.target} artifacts (${manifest.go}), Node ${process.version}`);
} catch (error) { console.error(error.message); process.exitCode = 1; }
