// Opt-in read-only live SSH validation. No network activity unless invoked.
// node apps/test/live.mjs /private/credentials [username]
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

if (!process.argv[2]) throw new Error('Supply an extracted credential directory');
const directory = resolve(process.argv[2]), username = process.argv[3] || 'wr';
const secret = (await readFile(resolve(directory, 'tailcat-address.txt'), 'utf8')).trim();
const sanitize = text => text.replaceAll(secret, '[redacted]');
const cli = fileURLToPath(new URL('../ssh.mjs', import.meta.url));
async function run(command, extra = []) {
  const start = performance.now();
  const child = spawn(process.execPath, [cli, 'exec', '--credentials-dir', directory,
    '--user', username, '--timeout', '60', ...extra, '--', command], {
    // Native ssh/tailcat executables cannot be found by the test process.
    env: { ...process.env, PATH: '/no-native-tools' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '', err = '';
  child.stdout.on('data', bytes => { out += bytes; });
  child.stderr.on('data', bytes => { err += bytes; });
  const timer = setTimeout(() => child.kill('SIGKILL'), 75000);
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  clearTimeout(timer);
  return { code, elapsed_ms: Math.round(performance.now() - start), stdout: sanitize(out), stderr: sanitize(err) };
}
const identity = await run('hostname; id; uname -a');
assert.equal(identity.code, 0, identity.stderr); assert.equal(identity.stderr, '');
const status = await run('printf wasm-stdout; printf wasm-stderr >&2; exit 7');
assert.equal(status.code, 7, status.stderr); assert.equal(status.stdout, 'wasm-stdout'); assert.equal(status.stderr, 'wasm-stderr');
const mismatch = await run('hostname', ['--host-key', 'SHA256:' + 'A'.repeat(43)]);
assert.equal(mismatch.code, 255); assert.equal(mismatch.stdout, ''); assert.match(mismatch.stderr, /host key mismatch/);
console.log(JSON.stringify({ node: process.version, platform: process.platform, arch: process.arch,
  native_tools_on_path: false, identity, nonzero_status: status, wrong_host_key: mismatch }, null, 2));
