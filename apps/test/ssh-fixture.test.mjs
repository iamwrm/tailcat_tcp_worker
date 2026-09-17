import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ssh2 from 'ssh2';
import { startSSHFixture } from './ssh-fixture.mjs';

test('SSH fixture provides a valid encrypted P-256 private key', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tailcat-ssh-fixture-'));
  let fixture;
  try {
    fixture = await startSSHFixture(dir);
    const key = ssh2.utils.parseKey(fixture.privateKey, fixture.passphrase);
    assert.ok(!(key instanceof Error), key.message);
    assert.equal(key.type, 'ecdsa-sha2-nistp256');
    const data = Buffer.from('fixture key round trip');
    assert.equal(key.verify(data, key.sign(data)), true);
    assert.ok(ssh2.utils.parseKey(fixture.privateKey) instanceof Error);
    assert.ok(ssh2.utils.parseKey(fixture.privateKey, 'wrong passphrase') instanceof Error);
  } finally {
    await fixture?.close();
    await rm(dir, { recursive: true, force: true });
  }
});
