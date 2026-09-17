// Reuse the pinned, reviewed Go transport and its graceful TCP shutdown patch.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
execFileSync(process.execPath, ['scripts/build.mjs'], { cwd: root, stdio: 'inherit' });
const dist = root + 'wasm_client/dist/';
mkdirSync(dist, { recursive: true });
const wasm = readFileSync(root + 'worker/src/generated/tailcat.wasm');
const compressed = gzipSync(wasm, { level: 9 });
writeFileSync(dist + 'tailcat.wasm.gz', compressed);
copyFileSync(root + 'worker/src/generated/go-runtime.js', dist + 'go-runtime.js');
const sha256 = data => createHash('sha256').update(data).digest('hex');
writeFileSync(dist + 'manifest.json', JSON.stringify({
  format: 1, go: 'go1.27.1', target: 'js/wasm',
  source: 'worker/cmd/workerwasm',
  files: {
    'tailcat.wasm.gz': { bytes: compressed.length, sha256: sha256(compressed) },
    'tailcat.wasm': { bytes: wasm.length, sha256: sha256(wasm) },
    'go-runtime.js': { sha256: sha256(readFileSync(dist + 'go-runtime.js')) },
  },
}, null, 2) + '\n');
console.log('Packaged local WASM client (no runtime download or Go installation needed).');
