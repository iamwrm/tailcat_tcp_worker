// Runs in a Node worker thread. Only the Tailcat credential crosses this
// boundary; SSH keys and application protocol handling stay with the caller.
import { parentPort, workerData } from 'node:worker_threads';
import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { createHash, webcrypto } from 'node:crypto';
import { createBridge } from '../worker/src/bridge.js';
import { runtimeScope } from '../worker/src/runtime.js';
import { createNetwork } from './network.mjs';

let runtime, network, finished = false, networkFailure;
const aborter = new AbortController();
const send = message => { if (!finished) parentPort.postMessage(message); };
function fail(code, message) {
  send({ type: 'error', code, message });
  finished = true; bridge.stop(); aborter.abort(); runtime?.dispose();
  parentPort.close();
}
const bridge = createBridge({
  sendControl: send,
  // postMessage clones synchronously: the Go/bridge output buffer is reusable.
  sendData: bytes => send({ type: 'data', bytes }),
  onError: fail,
});
parentPort.on('message', message => {
  if (finished) return;
  try {
    if (message.type === 'data') bridge.receive(message.bytes);
    else if (message.type === 'fin') bridge.endInput();
    else if (message.type === 'ack') bridge.acknowledge(message.bytes);
    else throw new Error('Invalid message');
  } catch { fail('protocol_error', 'Invalid local transport message'); }
});

try {
  const dist = new URL('./dist/', import.meta.url);
  const manifest = JSON.parse(await readFile(new URL('manifest.json', dist), 'utf8'));
  const packed = await readFile(new URL('tailcat.wasm.gz', dist));
  const shim = await readFile(new URL('go-runtime.js', dist));
  const verify = (bytes, name) => {
    if (createHash('sha256').update(bytes).digest('hex') !== manifest.files[name]?.sha256) {
      throw new Error('Artifact checksum mismatch');
    }
  };
  verify(packed, 'tailcat.wasm.gz'); verify(shim, 'go-runtime.js');
  const wasm = gunzipSync(packed, { maxOutputLength: 64 * 1024 * 1024 });
  verify(wasm, 'tailcat.wasm');
  const { makeGo } = await import('./dist/go-runtime.js');
  network = await createNetwork({ mapURL: workerData.input.derp_map_url,
    mapFile: workerData.derpMapFile, liveRelayMap: workerData.liveRelayMap,
    onFailure(message, { stage }) {
      // Optional HTTPS probes may fail during teardown or in restricted
      // sandboxes. They must not overwrite the actual map/WebSocket failure.
      if (stage === 'relay_map' || stage === 'relay_websocket') networkFailure = message;
    },
    onDiagnostic(event) { if (workerData.diagnostics) send({ type: 'diagnostic', event }); },
  });
  runtime = runtimeScope({ signal: aborter.signal }, workerData.input, json => {
    const event = JSON.parse(json);
    if (event.type === 'metrics') return;
    if (event.type === 'error') {
      if (event.code === 'tailcat_connection_failed' && networkFailure) event.message = networkFailure;
      fail(event.code, event.message); return;
    }
    if (event.type === 'fin' || event.type === 'closed') bridge.flush();
    send(event);
  });
  workerData.input = undefined;
  // wasm_exec installs a minimal process shim. Hiding Node's process.argv0
  // selects Go's browser Fetch implementation instead of its Node TCP path.
  Object.defineProperties(runtime.scope, {
    process: { value: undefined, writable: true },
    fs: { value: undefined, writable: true },
    // Node's global getters require globalThis as their receiver; Go uses a
    // private scope, so give it concrete values rather than inherited getters.
    crypto: { value: webcrypto },
    performance: { value: globalThis.performance },
    navigator: { value: undefined },
  });
  runtime.scope.transportRead = bridge.read;
  runtime.scope.transportConsumed = bridge.consumed;
  runtime.scope.transportWrite = bridge.write;
  runtime.scope.transportStop = bridge.stop;
  runtime.scope.fetch = (url, options = {}) => network.fetch(url, {
    ...options, signal: AbortSignal.any([aborter.signal, options.signal].filter(Boolean)), redirect: 'error',
  });
  runtime.scope.WebSocket = network.WebSocket;
  const go = makeGo(runtime.scope);
  go.env = { GOMEMLIMIT: '80MiB', GOGC: '50' };
  if (workerData.allowLocalRelayForTests) go.env.TS_DEBUG_USE_DERP_HTTP = 'true';
  go.exit = code => { if (code) fail('runtime_failed', 'Tailcat WASM runtime stopped'); };
  const { instance } = await WebAssembly.instantiate(wasm, go.importObject);
  await go.run(instance);
} catch {
  fail('runtime_failed', 'Could not load or run Tailcat WASM; verify the packaged artifacts and Node version');
} finally {
  bridge.stop(); aborter.abort(); runtime?.dispose(); await network?.close(); parentPort.close();
}
