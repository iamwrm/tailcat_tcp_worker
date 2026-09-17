import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNetwork, networkCode, DEFAULT_MAP } from '../network.mjs';

test('bundled public map loads without accessing an unreachable HTTPS proxy', async () => {
  const n = await createNetwork({ env: { HTTPS_PROXY: 'http://127.0.0.1:1' } });
  try {
    const response = await n.fetch(DEFAULT_MAP);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).Regions[304].Nodes[0].HostName, 'tc304a.ipn.dev');
  } finally { await n.close(); }
});
test('explicit live map fetch uses the proxy and returns a redacted failure code', async () => {
  let diagnostic;
  const n = await createNetwork({ liveRelayMap: true, env: { HTTPS_PROXY: 'http://secret-user:secret-pass@127.0.0.1:1' }, onFailure: message => { diagnostic = message; } });
  try {
    await assert.rejects(n.fetch(DEFAULT_MAP), /Relay map fetch failed \(ECONNREFUSED\)/);
    assert.match(diagnostic, /ECONNREFUSED/);
    assert.ok(!diagnostic.includes('secret-'));
  } finally { await n.close(); }
});
test('network diagnostics only expose allowlisted codes, including TLS failures', () => {
  assert.equal(networkCode({ cause: { code: 'SELF_SIGNED_CERT_IN_CHAIN', message: 'secret' } }), 'SELF_SIGNED_CERT_IN_CHAIN');
  assert.equal(networkCode({ errors: [{ cause: { code: 'ENOTFOUND' } }] }), 'ENOTFOUND');
  assert.equal(networkCode({ code: 'secret-value', message: 'secret' }), 'NETWORK_ERROR');
});
