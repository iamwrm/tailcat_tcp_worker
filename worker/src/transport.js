import wasm from './generated/tailcat.wasm';
import { makeGo } from './generated/go-runtime.js';
import { runtimeScope, acquireRuntime } from './runtime.js';

const WINDOW = 65536, FRAME = 16384;
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
  return { tcp: true, tailcat_address: address, tailcat_client_key: m.client_key,
    port, timeout_seconds: timeout, derp_map_url: env.DERP_MAP_URL || 'https://tailcat.dev/derpmap.json', allow_embedded_relay: false };
}

export function transportWebSocket(request, env, ctx) {
  const pair = new WebSocketPair(), client = pair[0], ws = pair[1];
  ws.binaryType = 'arraybuffer';
  ws.accept();
  let state = 'opening', ended = false, stopped = false, inputFin = false;
  let uploadCredit = WINDOW, outstanding = 0, queued = [], readWait, creditWait;
  let runtime, release, lifetime, stallTimer;
  const aborter = new AbortController();
  const send = value => { if (!ended) ws.send(JSON.stringify(value)); };
  const stopIO = () => {
    if (stopped) return;
    stopped = true; queued = [];
    readWait?.reject(new Error('Transport stopped')); readWait = null;
    creditWait?.reject(new Error('Transport stopped')); creditWait = null;
  };
  const finish = (code = 1000) => {
    if (ended) return;
    ended = true; clearTimeout(openTimer); clearTimeout(lifetime); clearTimeout(stallTimer);
    stopIO(); aborter.abort();
    try { ws.close(code, code === 1000 ? 'Transport closed' : 'Transport failed'); } catch {}
  };
  const fail = (code, message) => { send({ type: 'error', code, message }); finish(1008); };
  const openTimer = setTimeout(() => fail('open_timeout', 'Send open within 10 seconds'), 10000);
  function watchCredit() {
    clearTimeout(stallTimer);
    if (outstanding) stallTimer = setTimeout(() => fail('consumer_timeout', 'No output credit received for 30 seconds'), 30000);
  }
  async function run(input) {
    try {
      runtime = runtimeScope({ signal: aborter.signal }, input, json => {
        const event = JSON.parse(json);
        if (event.type === 'metrics') return;
        if (event.type === 'opened') state = 'open';
        send(event);
        if (event.type === 'error') finish(1011);
      });
      runtime.scope.transportRead = () => {
        if (stopped) return Promise.reject(new Error('Transport stopped'));
        if (queued.length) return Promise.resolve(queued.shift());
        if (inputFin) return Promise.resolve(null);
        return new Promise((resolve, reject) => { readWait = { resolve, reject }; });
      };
      runtime.scope.transportConsumed = n => {
        if (stopped) return;
        uploadCredit += n;
        send({ type: 'window_update', bytes: n });
      };
      runtime.scope.transportWrite = async bytes => {
        while (!stopped && outstanding + bytes.byteLength > WINDOW) {
          await new Promise((resolve, reject) => { creditWait = { resolve, reject }; });
        }
        if (stopped) throw new Error('Transport stopped');
        outstanding += bytes.byteLength;
        ws.send(bytes);
        // Start a timer only on the first byte; sending more cannot postpone it.
        if (!stallTimer) watchCredit();
      };
      runtime.scope.transportStop = stopIO;
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
        if (state !== 'open' || inputFin || !(event.data instanceof ArrayBuffer)) throw new Error('Unexpected binary data');
        const bytes = new Uint8Array(event.data);
        if (!bytes.byteLength || bytes.byteLength > FRAME || bytes.byteLength > uploadCredit) throw new Error('Input exceeds frame or flow-control limit');
        uploadCredit -= bytes.byteLength;
        if (readWait) { const waiter = readWait; readWait = null; waiter.resolve(bytes); }
        else queued.push(bytes);
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
      if (m.type === 'window_update') {
        if (!Number.isInteger(m.bytes) || m.bytes <= 0 || m.bytes > outstanding) throw new Error('Invalid output credit');
        outstanding -= m.bytes; clearTimeout(stallTimer); stallTimer = null; watchCredit();
        creditWait?.resolve(); creditWait = null;
      } else if (m.type === 'fin' && !inputFin) {
        inputFin = true;
        if (readWait) { const waiter = readWait; readWait = null; waiter.resolve(null); }
      } else throw new Error('Unknown or duplicate control message');
    } catch (e) { fail('protocol_error', e instanceof SyntaxError ? 'Invalid JSON' : e.message); }
  });
  ws.addEventListener('close', () => finish());
  ws.addEventListener('error', () => finish(1011));
  send({ type: 'hello', version: 1 });
  return new Response(null, { status: 101, webSocket: client, headers: { 'Cache-Control': 'no-store' } });
}
