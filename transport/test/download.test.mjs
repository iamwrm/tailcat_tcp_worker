import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { downloadArtifact, RELEASE_URL } from '../download.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'tailcat-download-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const dist = pathToFileURL(directory + '/');
  const wasm = Buffer.from('test wasm bytes'), shim = Buffer.from('test shim');
  const packed = gzipSync(wasm);
  const entry = bytes => ({ bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  const manifest = { format: 1, target: 'js/wasm', files: {
    'tailcat.wasm.gz': entry(packed), 'tailcat.wasm': entry(wasm), 'go-runtime.js': entry(shim),
  } };
  const saveManifest = () => writeFile(new URL('manifest.json', dist), JSON.stringify(manifest));
  await saveManifest();
  await writeFile(new URL('go-runtime.js', dist), shim);
  return { dist, packed, manifest, saveManifest, destination: new URL('tailcat.wasm.gz', dist) };
}

test('downloads pinned release, verifies it, then reuses it offline', async t => {
  const f = await fixture(t);
  assert.equal(await downloadArtifact({ dist: f.dist, fetch: async (url, options) => {
    assert.equal(url, RELEASE_URL);
    assert.match(url, /\/releases\/download\/wasm-v0\.1\.0\/tailcat\.wasm\.gz$/);
    assert.ok(options.signal instanceof AbortSignal);
    return new Response(f.packed);
  } }), 'downloaded');
  assert.deepEqual(await readFile(f.destination), f.packed);
  assert.equal(await downloadArtifact({ dist: f.dist, fetch: () => assert.fail('Unexpected network access') }), 'cached');
  assert.deepEqual((await readdir(f.dist)).sort(), ['go-runtime.js', 'manifest.json', 'tailcat.wasm.gz']);
});

test('replaces a stale local artifact with a verified release', async t => {
  const f = await fixture(t);
  await writeFile(f.destination, 'stale');
  assert.equal(await downloadArtifact({ dist: f.dist, fetch: async () => new Response(f.packed) }), 'downloaded');
  assert.deepEqual(await readFile(f.destination), f.packed);
});

for (const failure of ['HTTP', 'truncated', 'oversized', 'checksum', 'uncompressed checksum', 'shim checksum', 'network']) {
  test(`rejects ${failure} failure without overwriting the local file`, async t => {
    const f = await fixture(t);
    const old = Buffer.from('previous artifact');
    await writeFile(f.destination, old);
    let fetch = async () => new Response(f.packed);
    let expected;
    switch (failure) {
      case 'HTTP': fetch = async () => new Response('missing', { status: 404 }); expected = /HTTP 404/; break;
      case 'truncated': fetch = async () => new Response(f.packed.subarray(0, -1)); expected = /Checksum mismatch/; break;
      case 'oversized': fetch = async () => new Response(Buffer.concat([f.packed, Buffer.from('extra')])); expected = /exceeds manifest size/; break;
      case 'checksum': {
        const corrupt = Buffer.from(f.packed); corrupt[0] ^= 1;
        fetch = async () => new Response(corrupt); expected = /Checksum mismatch: tailcat.wasm.gz/; break;
      }
      case 'uncompressed checksum': f.manifest.files['tailcat.wasm'].sha256 = '0'.repeat(64); expected = /Checksum mismatch: tailcat.wasm$/; break;
      case 'shim checksum': await writeFile(new URL('go-runtime.js', f.dist), 'wrong shim'); expected = /Checksum mismatch: go-runtime.js/; break;
      case 'network': fetch = async () => { throw new Error('https://user:secret@proxy.invalid'); }; expected = /^Error: Release download failed \(NETWORK_ERROR\)$/; break;
    }
    await f.saveManifest();
    await assert.rejects(downloadArtifact({ dist: f.dist, fetch }), expected);
    assert.deepEqual(await readFile(f.destination), old);
    assert.deepEqual((await readdir(f.dist)).sort(), ['go-runtime.js', 'manifest.json', 'tailcat.wasm.gz']);
  });
}

test('failed first download does not install an artifact', async t => {
  const f = await fixture(t);
  await assert.rejects(downloadArtifact({ dist: f.dist, fetch: async () => new Response('bad') }), /Checksum mismatch/);
  await assert.rejects(readFile(f.destination), { code: 'ENOENT' });
});
