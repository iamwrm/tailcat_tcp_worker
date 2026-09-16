import wasm from './generated/tailcat.wasm';
import { makeGo } from './generated/go-runtime.js';
import { runtimeScope, acquireRuntime } from './runtime.js';

import { createBridge } from './bridge.js';
function openRequest(m, env) {
  const only = (o, keys) => o && typeof o === 'object' && !Array.isArray(o) && Object.keys(o).every(k => keys.includes(k));
  if (!only(m, ['type','version','target','client_key','timeout_seconds']) || m.type !== 'open' || m.version !== 1) throw new Error('Expected a version 1 open message');
  if (!only(m.target, ['type','address','port']) || m.target.type !== 'tailcat') throw new Error('Expected a Tailcat target');
  const { address, port } = m.target;
  if (typeof address !== 'string' || address.length > 4096 || !/^tc[A-Za-z0-9_-]+$/.test(address)) throw new Error('Invalid Tailcat address');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port');
  if (m.client_key !== undefined && (typeof m.client_key !== 'string' || m.client_key.length > 256)) throw new Error('Invalid client key');
  const timeout = m.timeout_seconds ?? 1800;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 3600) throw new Error('Timeout must be 1–3600 seconds');
  return { tailcat_address: address, tailcat_client_key: m.client_key,
    port, timeout_seconds: timeout, derp_map_url: env.DERP_MAP_URL || 'https://tailcat.dev/derpmap.json', allow_embedded_relay: false };
}

export function transportWebSocket(request, env, ctx) {
  const pair = new WebSocketPair(), client = pair[0], ws = pair[1];
  ws.binaryType = 'arraybuffer';
  ws.accept();
  let state = 'opening', ended = false;
  let runtime, release, lifetime;
  const aborter = new AbortController();
  const send = value => { if (!ended) ws.send(JSON.stringify(value)); };
  const finish = (code = 1000) => {
    if (ended) return;
    ended = true; clearTimeout(openTimer); clearTimeout(lifetime);
    bridge.stop(); aborter.abort();
    try { ws.close(code, code === 1000 ? 'Transport closed' : 'Transport failed'); } catch {}
  };
  const fail = (code, message) => { send({ type: 'error', code, message }); finish(1008); };
  const openTimer = setTimeout(() => fail('open_timeout', 'Send open within 10 seconds'), 10000);
  const bridge = createBridge({ sendControl: send, sendData: bytes => ws.send(bytes), onError: fail });
  async function run(input) {
    try {
      runtime = runtimeScope({ signal: aborter.signal }, input, json => {
        const event = JSON.parse(json);
        if (event.type === 'metrics') return;
        if (event.type === 'opened') state = 'open';
        if (event.type === 'fin' || event.type === 'closed') bridge.flush();
        send(event);
        if (event.type === 'error') finish(1011);
      });
      runtime.scope.transportRead = bridge.read;
      runtime.scope.transportConsumed = bridge.consumed;
      runtime.scope.transportWrite = bridge.write;
      runtime.scope.transportStop = bridge.stop;
      const go = makeGo(runtime.scope);
      go.env = { GOMEMLIMIT: '80MiB', GOGC: '50' };
      if (env.TEST_DERP_HTTP === '1') go.env.TS_DEBUG_USE_DERP_HTTP = 'true';
      go.exit = code => { if (code) fail('runtime_failed', 'Transport runtime stopped'); };
      const instance = await WebAssembly.instantiate(wasm, go.importObject);
      await go.run(instance);
    } catch { if (!ended) fail('runtime_failed', 'Could not complete the transport'); }
    finally { finish(); runtime?.dispose(); release?.(); }
  }
  ws.addEventListener('message', event => {
    if (ended) return;
    try {
      if (typeof event.data !== 'string') {
        if (state !== 'open' || !(event.data instanceof ArrayBuffer)) throw new Error('Unexpected binary data');
        bridge.receive(new Uint8Array(event.data));
        return;
      }
      if (event.data.length > 8192) throw new Error('Control message too large');
      const m = JSON.parse(event.data);
      if (state === 'opening') {
        const input = openRequest(m, env);
        release = acquireRuntime();
        if (!release) { fail('busy', 'This isolate is busy; retry shortly'); return; }
        clearTimeout(openTimer); state = 'connecting';
        lifetime = setTimeout(() => fail('timeout', 'Transport lifetime exceeded'), input.timeout_seconds * 1000);
        ctx.waitUntil(run(input));
        return;
      }
      if (!m || typeof m !== 'object' || Array.isArray(m)) throw new Error('Invalid control message');
      if (m.type === 'reset') { finish(); return; }
      if (state !== 'open') throw new Error('Wait for opened');
      if (m.type === 'window_update') bridge.acknowledge(m.bytes);
      else if (m.type === 'fin') bridge.endInput();
      else throw new Error('Unknown control message');
    } catch (e) { fail('protocol_error', e instanceof SyntaxError ? 'Invalid JSON' : e.message); }
  });
  ws.addEventListener('close', () => finish());
  ws.addEventListener('error', () => finish(1011));
  send({ type: 'hello', version: 1 });
  return new Response(null, { status: 101, webSocket: client, headers: { 'Cache-Control': 'no-store' } });
}
