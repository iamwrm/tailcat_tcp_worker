import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';

export function verifyArtifacts(manifest, packed, shim) {
  if (manifest.format !== 1 || manifest.target !== 'js/wasm') throw new Error('Unexpected manifest');
  const verify = (name, bytes) => {
    const expected = manifest.files?.[name];
    if ((expected?.bytes !== undefined && expected.bytes !== bytes.length)
        || createHash('sha256').update(bytes).digest('hex') !== expected?.sha256) {
      throw new Error(`Checksum mismatch: ${name}`);
    }
  };
  // Authenticate the compressed bytes before attempting decompression.
  verify('tailcat.wasm.gz', packed);
  verify('go-runtime.js', shim);
  verify('tailcat.wasm', gunzipSync(packed, { maxOutputLength: 64 * 1024 * 1024 }));
}
