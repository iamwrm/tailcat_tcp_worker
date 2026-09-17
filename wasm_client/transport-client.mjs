import { Worker } from 'node:worker_threads';

// Same application-facing contract as client/transport-client.mjs, with a
// local WASM instance instead of a remote Cloudflare gateway. One reader/writer.
export async function openTcp({ address, port, clientKey, timeout = 1800, signal,
  derpMapURL = 'https://tailcat.dev/derpmap.json', derpMapFile, liveRelayMap = false, allowLocalRelayForTests = false, onDiagnostic }) {
  if (typeof address !== 'string' || address.length > 4096 || !/^tc[A-Za-z0-9_-]+$/.test(address)) throw new Error('Supply a valid Tailcat address');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Supply a TCP port from 1 to 65535');
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 3600) throw new Error('Timeout must be 1–3600 seconds');
  if (clientKey !== undefined && (typeof clientKey !== 'string' || clientKey.length > 256)) throw new Error('Invalid Tailcat client identity');
  const map = new URL(derpMapURL);
  if (map.username || map.password || (map.protocol !== 'https:' && !(allowLocalRelayForTests && map.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(map.hostname)))) throw new Error('Relay map must use HTTPS');
  if (signal?.aborted) throw new Error('Transport aborted');
  const worker = new Worker(new URL('./runtime.mjs', import.meta.url), {
    workerData: { input: { tailcat_address: address, tailcat_client_key: clientKey,
      port, timeout_seconds: timeout, derp_map_url: map.href, allow_embedded_relay: false },
      derpMapFile, liveRelayMap, allowLocalRelayForTests, diagnostics: typeof onDiagnostic === 'function' },
    // Do not inherit CLI-only --input-type or expose raw runtime diagnostics.
    execArgv: [], stdout: true, stderr: true,
  });
  worker.stdout.resume(); worker.stderr.resume();
  let opened = false, ended = false, localFin = false, remoteFin = false, failed, busy = false, reader = false;
  let credit = 65536, outstanding = 0, received = 0, queue = [], head = 0, readWait, writeWait;
  let resolveOpen, rejectOpen, resolveClosed, rejectClosed;
  const ready = new Promise((resolve, reject) => { resolveOpen = resolve; rejectOpen = reject; });
  const closed = new Promise((resolve, reject) => { resolveClosed = resolve; rejectClosed = reject; });
  closed.catch(() => {});
  const wake = () => { readWait?.(); readWait = null; writeWait?.(); writeWait = null; };
  const cleanup = () => { clearTimeout(deadline); clearTimeout(openTimer); signal?.removeEventListener('abort', abort); };
  const terminate = () => { worker.terminate().catch(() => {}); };
  const fail = error => {
    if (ended) return;
    failed = error; ended = true; queue = []; cleanup();
    rejectOpen(error); rejectClosed(error); wake(); terminate();
  };
  const abort = () => fail(new Error('Transport aborted'));
  const deadline = setTimeout(() => fail(new Error('Transport session timed out')), timeout * 1000);
  const openTimer = setTimeout(() => fail(new Error('Tailcat open timed out; check DERP access and target availability')), 30000);
  signal?.addEventListener('abort', abort, { once: true });
  worker.on('error', () => fail(new Error('Local WASM worker failed')));
  worker.on('exit', () => { if (!ended) fail(new Error('Local WASM runtime stopped before TCP closed')); });
  worker.on('message', m => {
    if (ended) return;
    try {
      if (m.type === 'diagnostic') { onDiagnostic?.(m.event); return; }
      if (m.type === 'error') { const e = new Error(`${m.code}: ${m.message}`); e.code = m.code; throw e; }
      if (m.type === 'opened' && !opened && m.window === 65536 && m.max_frame === 16384) {
        opened = true; clearTimeout(openTimer); resolveOpen(); return;
      }
      if (!opened) throw new Error('Expected transport open');
      if (m.type === 'data') {
        if (!(m.bytes instanceof Uint8Array) || remoteFin || !m.bytes.length || m.bytes.length > 16384 || received + m.bytes.length > 65536) throw new Error('Invalid data frame');
        received += m.bytes.length; queue.push(m.bytes); wake();
      } else if (m.type === 'window_update') {
        if (!Number.isInteger(m.bytes) || m.bytes <= 0 || m.bytes > outstanding) throw new Error('Invalid upload credit');
        outstanding -= m.bytes; credit += m.bytes; wake();
      } else if (m.type === 'fin' && !remoteFin) { remoteFin = true; wake(); }
      else if (m.type === 'closed' && localFin && remoteFin) {
        ended = true; cleanup(); resolveClosed(); wake(); terminate();
      } else throw new Error('Unexpected transport message');
    } catch (error) { fail(error); }
  });
  await ready;
  return {
    closed,
    async write(bytes) {
      if (busy) throw new Error('Await the previous write before writing again');
      if (!(bytes instanceof Uint8Array)) throw new Error('write requires Uint8Array');
      if (localFin || ended) throw failed || new Error('Transport write side closed');
      busy = true;
      try {
        for (let offset = 0; offset < bytes.length;) {
          while (!ended && credit === 0) await new Promise(resolve => { writeWait = resolve; });
          if (ended) throw failed || new Error('Transport closed');
          const n = Math.min(16384, credit, bytes.length - offset);
          credit -= n; outstanding += n;
          worker.postMessage({ type: 'data', bytes: bytes.subarray(offset, offset + n) }); offset += n;
        }
      } finally { busy = false; }
    },
    end() {
      if (busy) throw new Error('Await the last write before ending');
      if (failed) throw failed;
      if (!ended && !localFin) { localFin = true; worker.postMessage({ type: 'fin' }); }
    },
    close() { fail(new Error('Transport closed by client')); },
    async *[Symbol.asyncIterator]() {
      if (reader) throw new Error('Only one transport reader is allowed');
      reader = true;
      try {
        while (true) {
          while (head === queue.length && !remoteFin && !ended) await new Promise(resolve => { readWait = resolve; });
          if (failed) throw failed;
          if (head === queue.length) return;
          const bytes = queue[head]; queue[head++] = undefined;
          if (head === queue.length) { queue = []; head = 0; }
          yield bytes;
          received -= bytes.length;
          if (!ended) worker.postMessage({ type: 'ack', bytes: bytes.length });
        }
      } finally { if (!ended && !remoteFin) fail(new Error('Reader stopped')); }
    },
  };
}
