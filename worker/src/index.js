import wasm from './generated/tailcat.wasm';
import { makeGo } from './generated/go-runtime.js';
import { parseShell } from './shell.js';
import { shellWebSocket } from './shell-websocket.js';
import { runtimeScope, acquireRuntime } from './runtime.js';
import { transportWebSocket } from './transport.js';

const maxBody = 256 * 1024;
const encoder = new TextEncoder();
const headers = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};
function error(status, message) {
  return Response.json({ error: message }, { status, headers });
}

async function parseRequest(request) {
  if (Number(request.headers.get('content-length')) > maxBody) throw new Error('Request exceeds 256 KiB');
  const reader = request.body?.getReader();
  if (!reader) throw new Error('Request body is required');
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBody) { await reader.cancel(); throw new Error('Request exceeds 256 KiB'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const body = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { body.set(c, at); at += c.length; }
  const type = request.headers.get('content-type') || '';
  let data;
  if (type.startsWith('application/json')) {
    try { data = JSON.parse(new TextDecoder().decode(body)); }
    catch { throw new Error('Invalid JSON'); }
  } else if (type.startsWith('multipart/form-data') || type.startsWith('application/x-www-form-urlencoded')) {
    let form;
    try { form = await new Response(body, { headers: { 'content-type': type } }).formData(); }
    catch { throw new Error('Invalid form body'); }
    data = {};
    for (const [name, value] of form) {
      if (Object.hasOwn(data, name)) throw new Error('Duplicate form field');
      Object.defineProperty(data, name, { value: typeof value === 'string' ? value : await value.text(), enumerable: true, writable: true });
    }
  } else throw new Error('Use JSON or a multipart form');
  return validateInput(data);
}

function validateInput(data, shell = false) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Expected an object');
  const allowed = new Set(['tailcat_address','tailcat_client_key','username','private_key','passphrase','host_key_sha256','port','timeout_seconds', ...(shell ? ['rows', 'cols', 'term'] : ['command'])]);
  if (Object.keys(data).some(k => !allowed.has(k))) throw new Error('Unknown request field');
  for (const field of ['tailcat_address','username','private_key','host_key_sha256', ...(shell ? [] : ['command'])]) {
    if (typeof data[field] !== 'string' || !data[field].trim()) throw new Error(`${field} is required`);
  }
  for (const field of ['passphrase','tailcat_client_key']) {
    if (data[field] !== undefined && typeof data[field] !== 'string') throw new Error(`Invalid ${field}`);
  }
  if (!/^tc[A-Za-z0-9_-]+$/.test(data.tailcat_address) || data.tailcat_address.length > 4096) throw new Error('Invalid Tailcat address');
  if (!/^SHA256:[A-Za-z0-9+/]{43}$/.test(data.host_key_sha256)) throw new Error('host_key_sha256 must be an OpenSSH SHA256 fingerprint');
  if (data.username.length > 128 || /[\x00-\x1f\x7f]/.test(data.username)) throw new Error('Invalid SSH username');
  if (!shell && (data.command.length > 16384 || data.command.includes('\0'))) throw new Error('Invalid command');
  data.port = Number(data.port ?? 22);
  data.timeout_seconds = Number(data.timeout_seconds ?? (shell ? 1800 : 30));
  if (!Number.isInteger(data.port) || data.port < 1 || data.port > 65535) throw new Error('Invalid port');
  const maxTimeout = shell ? 3600 : 120;
  if (!Number.isInteger(data.timeout_seconds) || data.timeout_seconds < 1 || data.timeout_seconds > maxTimeout) throw new Error(`Timeout must be 1–${maxTimeout} seconds`);
  if (shell) {
    data.rows = Number(data.rows ?? 24); data.cols = Number(data.cols ?? 80);
    if (![data.rows, data.cols].every(n => Number.isInteger(n) && n >= 1 && n <= 1000)) throw new Error('Invalid terminal size');
    data.term = data.term ?? 'xterm-256color';
    if (typeof data.term !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(data.term)) throw new Error('Invalid terminal type');
    data.shell = true;
  }
  return data;
}


async function handleRequest(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/api/health') return Response.json({ ok: true, transport: 'tailcat-wasm-derp', authentication: 'caller-provided-credentials', protocols: ['tcp-v1', 'ssh-exec', 'ssh-shell'] }, { headers });
    const transport = url.pathname === '/v1/transport';
    const interactive = url.pathname === '/api/shell';
    if (url.pathname !== '/api/exec' && !interactive && !transport) {
      if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/v1/')) return error(404, 'Not found');
      return env.ASSETS.fetch(request);
    }
    const upgrade = (interactive || transport) && request.method === 'GET' && request.headers.get('upgrade')?.toLowerCase() === 'websocket';
    if ((transport && !upgrade) || (request.method !== 'POST' && !upgrade)) return error(405, 'Use POST or a shell WebSocket upgrade');
    const origin = request.headers.get('origin');
    if (origin && origin !== url.origin) return error(403, 'Cross-origin requests are not accepted');
    if (env.EXEC_LIMIT && !(await env.EXEC_LIMIT.limit({ key: request.headers.get('CF-Connecting-IP') || 'local' })).success) {
      return new Response('Too many requests; retry in a minute', { status: 429, headers: { ...headers, 'Retry-After': '60' } });
    }
    if (transport) return transportWebSocket(request, env, ctx);
    if (upgrade) return shellWebSocket(request, env, ctx, handleRequest);
    let input, shell;
    try {
      if (interactive) { shell = await parseShell(request, validateInput); input = shell.input; shell.input = null; }
      else input = await parseRequest(request);
    }
    catch (e) { return error(400, e.message); }
    const release = acquireRuntime();
    if (!release) { await shell?.close(); return new Response('This isolate is busy; retry shortly', { status: 503, headers: { ...headers, 'Retry-After': '1' } }); }
    input.derp_map_url = env.DERP_MAP_URL || 'https://tailcat.dev/derpmap.json';
    // Deployment configuration only. Never controlled by a request.
    input.allow_embedded_relay = false;
    const plain = interactive ? request.headers.get('accept') !== 'application/x-ndjson' : request.headers.get('accept') === 'text/plain';
    let closed = false, terminal = false, runtime, resumeOutput, outputCancelled = false;
    const stream = new ReadableStream({
      start(controller) {
        const send = event => {
          if (closed) return;
          if (event.type === 'exit' || event.type === 'error') terminal = true;
          if (plain) {
            if (event.type === 'stdout' || event.type === 'stderr') {
              const raw = atob(event.data);
              controller.enqueue(Uint8Array.from(raw, c => c.charCodeAt(0)));
            } else if (event.type === 'error') controller.enqueue(encoder.encode(`\r\n[${event.code}] ${event.message}\r\n`));
            else if (event.type === 'exit' && (interactive || event.code !== 0)) controller.enqueue(encoder.encode(`\r\n[exit ${event.code}]\r\n`));
          } else controller.enqueue(encoder.encode(JSON.stringify(event) + '\n'));
        };
        const task = (async () => {
          let instance;
          try {
            runtime = runtimeScope(request, input, json => send(JSON.parse(json)));
            input = null;
            if (shell) {
              runtime.scope.tailcatRead = () => shell.next();
              runtime.scope.tailcatCloseInput = () => shell.close();
              runtime.scope.tailcatOutputReady = () => closed || outputCancelled || controller.desiredSize > 0 ? Promise.resolve() : new Promise(resolve => { resumeOutput = resolve; });
              runtime.scope.tailcatUnblockOutput = () => { outputCancelled = true; resumeOutput?.(); resumeOutput = null; };
            }
            const go = makeGo(runtime.scope);
            go.env = { GOMEMLIMIT: '80MiB', GOGC: '50' };
            // Only the local integration harness sets this deployment binding.
            if (env.TEST_DERP_HTTP === '1') go.env.TS_DEBUG_USE_DERP_HTTP = 'true';
            go.exit = code => { if (code !== 0) send({ type: 'error', code: 'wasm_exit', message: 'The Wasm runtime stopped unexpectedly' }); };
            instance = await WebAssembly.instantiate(wasm, go.importObject);
            await go.run(instance);
            if (!terminal) send({ type: 'error', code: 'incomplete', message: 'Execution ended without a result' });
            if (!plain) send({ type: 'runtime', wasm_memory_bytes: instance.exports.mem.buffer.byteLength });
          } catch {
            send({ type: 'error', code: 'runtime_failed', message: 'The Worker could not complete this request' });
          } finally {
            await shell?.close();
            runtime?.dispose();
            instance = null;
            release();
            if (!closed) { closed = true; controller.close(); }
          }
        })();
        ctx.waitUntil(task);
      },
      pull() { resumeOutput?.(); resumeOutput = null; },
      cancel() { closed = true; resumeOutput?.(); runtime?.cancel(); return shell?.close(); },
    }, interactive ? { highWaterMark: 65536, size: chunk => chunk.byteLength } : undefined);
    return new Response(stream, { headers: { ...headers, 'Content-Type': plain ? 'text/plain; charset=utf-8' : 'application/x-ndjson', 'X-Accel-Buffering': 'no' } });
}

export default { fetch: handleRequest };
