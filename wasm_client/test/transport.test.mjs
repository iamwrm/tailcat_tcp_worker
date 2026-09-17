import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, createHash } from 'node:crypto';
import { Writable, PassThrough } from 'node:stream';
import { openTcp } from '../transport-client.mjs';
import { credentials } from '../ssh.mjs';
import { connectSSH, runCommand } from '../../client/ssh-client.mjs';
import { startSSHFixture } from '../../client/test/ssh-fixture.mjs';
import { copyFiles } from '../../client/sftp.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
let fixture, info, dir, sftp;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tailcat-wasm-test-'));
  sftp = await startSSHFixture(dir);
  execFileSync('go', ['build', '-o', join(dir, 'fixture'), './test/fixture'], { cwd: root + 'worker', env: { ...process.env, GOTOOLCHAIN: 'go1.27.1' }, stdio: 'pipe' });
  fixture = spawn(join(dir, 'fixture'), [], { env: { ...process.env, TS_DEBUG_USE_DERP_HTTP: 'true', TEST_SFTP_PORT: String(sftp.port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  fixture.stderr.resume();
  const lines = createInterface({ input: fixture.stdout });
  info = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Fixture startup timeout')), 30000);
    lines.once('line', line => { clearTimeout(timer); resolve(JSON.parse(line)); });
    fixture.once('exit', () => { clearTimeout(timer); reject(new Error('Fixture stopped')); });
  });
}, { timeout: 120000 });
after(async () => { fixture?.kill(); await sftp?.close(); if (dir) await rm(dir, { recursive: true, force: true }); });
const opts = extra => ({ address: info.tailcat_address, derpMapURL: info.map_url, allowLocalRelayForTests: true, timeout: 20, ...extra });
const tcp = (port, extra) => openTcp(opts({ port, ...extra }));
const ssh = extra => connectSSH(opts({ port: 22, username: info.username, privateKey: info.private_key, hostKey: info.host_key_sha256, ...extra }), { openTcp });
async function collect(t) { const out = []; for await (const b of t) out.push(b); return Buffer.concat(out); }
const sink = () => { const chunks = []; return { chunks, stream: new Writable({ write(b, enc, done) { chunks.push(Buffer.from(b)); done(); } }) }; };

test('HTTP over real local DERP + WASM; client FIN and graceful close', async () => {
  const t = await tcp(80), result = collect(t);
  await t.write(Buffer.from('GET /hello HTTP/1.1\r\nHost: fixture\r\nConnection: close\r\n\r\n')); t.end();
  assert.match((await result).toString(), /HTTP through generic TCP/); await t.closed;
});
test('17 MiB binary echo retains exact bytes with bounded flow control', { timeout: 60000 }, async () => {
  const t = await tcp(7001, { timeout: 50 });
  const expected = createHash('sha256'), actual = createHash('sha256'); let size = 0;
  const reading = (async () => { for await (const bytes of t) { actual.update(bytes); size += bytes.length; } })();
  const block = randomBytes(65536);
  for (let i = 0; i < 273; i++) { expected.update(block); await t.write(block); }
  t.end(); await reading; await t.closed;
  assert.equal(size, block.length * 273); assert.equal(actual.digest('hex'), expected.digest('hex'));
});
test('response after client FIN and upload after server FIN', async () => {
  const t = await tcp(7002), data = randomBytes(170003), result = collect(t);
  await t.write(data); t.end();
  assert.equal((await result).toString(), createHash('sha256').update(data).digest('hex')); await t.closed;
  const half = await tcp(7003);
  assert.equal((await collect(half)).toString(), 'server-fin\n');
  await half.write(randomBytes(50003)); half.end(); await half.closed;
  assert.equal((await (await fetch(info.stats_url)).json()).half_close_bytes, 50003);
});
test('SSH preserves separate output streams and remote nonzero status', async () => {
  const s = await ssh(), out = sink(), err = sink();
  try {
    assert.equal(await runCommand(s, 'probe', { input: null, output: out.stream, errorOutput: err.stream }), 7);
    assert.equal(Buffer.concat(out.chunks).toString(), 'hello from SSH through Tailcat\n');
    assert.equal(Buffer.concat(err.chunks).toString(), 'stderr is separate\n');
  } finally { s.close(); }
});
test('host mismatch is rejected before SSH authentication; wrong user key rejected', async () => {
  const before = sftp.stats.authentications;
  await assert.rejects(ssh({ ...sftp, port: 7006, hostKey: 'SHA256:' + 'A'.repeat(43) }), /host key mismatch/);
  assert.equal(sftp.stats.authentications, before);
  await assert.rejects(ssh({ privateKey: info.wrong_private_key }), /authentication/i);
});
test('SFTP upload/download with encrypted private key and binary integrity', async () => {
  const s = await ssh({ ...sftp, port: 7006 }), payload = randomBytes(256 * 1024 + 3);
  try {
    await writeFile(join(dir, 'input.bin'), payload);
    await copyFiles(s, 'upload', join(dir, 'input.bin'), '/wasm.bin');
    await copyFiles(s, 'download', '/wasm.bin', join(dir, 'output.bin'));
    assert.deepEqual(await readFile(join(dir, 'output.bin')), payload);
  } finally { s.close(); }
});
test('interactive PTY over WASM', async () => {
  const s = await ssh(), input = new PassThrough(), output = sink(), errorOutput = sink();
  try {
    const result = runCommand(s, '', { input, output: output.stream, errorOutput: errorOutput.stream, shell: { term: 'xterm', rows: 31, cols: 91 }, onChannel(channel) {
      channel.once('data', () => input.end('exit\n'));
    } });
    assert.equal(await result, 0);
    assert.match(Buffer.concat(output.chunks).toString(), /PTY ready:31x91/);
  } finally { s.close(); }
});
test('timeout and cancellation stop the WASM runtime', async () => {
  const t = await tcp(7005, { timeout: 2 });
  await assert.rejects(t.closed, /timed out|timeout/);
  const controller = new AbortController(), next = await tcp(7005, { signal: controller.signal });
  controller.abort(); await assert.rejects(next.closed, /aborted/);
  await assert.rejects(tcp(22, { signal: controller.signal }), /aborted/);
});
test('independent concurrent connections and a paused reader retain ordered bytes', async () => {
  const [first, second] = await Promise.all([tcp(7004), tcp(7001)]);
  const iterator = first[Symbol.asyncIterator]();
  const initial = await iterator.next();
  // Delaying the next iterator call must not credit the held chunk.
  const snapshot = Buffer.from(initial.value);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.deepEqual(Buffer.from(initial.value), snapshot);
  const echo = collect(second), payload = randomBytes(90001);
  await second.write(payload); second.end(); assert.deepEqual(await echo, payload); await second.closed;
  const chunks = [snapshot];
  for (let result = await iterator.next(); !result.done; result = await iterator.next()) chunks.push(Buffer.from(result.value));
  first.end(); await first.closed;
  assert.deepEqual(Buffer.concat(chunks), Buffer.concat(Array.from({ length: 16 }, (_, i) => Buffer.alloc(16384, i))));
});
test('credential files produce the pinned host fingerprint without printing secrets', async () => {
  await writeFile(join(dir, 'id_ed25519'), info.private_key, { mode: 0o600 });
  await writeFile(join(dir, 'tailcat-address.txt'), info.tailcat_address, { mode: 0o600 });
  await writeFile(join(dir, 'ssh-host-key.pub'), info.host_key_public);
  const { args, env } = await credentials(['exec', '--credentials-dir', dir, '--user', info.username, '--', 'probe'], { TAILCAT_URL: 'https://must-not-contact.invalid' });
  assert.equal(env.SSH_HOST_KEY, info.host_key_sha256); assert.equal(env.TAILCAT_ADDR, info.tailcat_address);
  assert.equal(env.TAILCAT_URL, undefined); assert.deepEqual(args, ['exec', '--user', info.username, '--', 'probe']);
  await assert.rejects(credentials(['exec', '--url', 'https://worker.invalid', '--', 'probe']), /gateway options/);
});
test('invalid credentials and insecure relay map are rejected without a network attempt', async () => {
  await assert.rejects(openTcp({ address: 'secret-invalid', port: 22 }), /valid Tailcat/);
  await assert.rejects(tcp(0), /TCP port/);
  await assert.rejects(tcp(22, { derpMapURL: 'http://example.com/map', allowLocalRelayForTests: false }), /HTTPS/);
});
