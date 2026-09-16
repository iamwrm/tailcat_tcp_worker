// Portable client SDK: no SSH implementation and no application credentials.
// Browser or Node.js 22.15+. Await each write; consume read chunks sequentially.
export async function openTcp({ url = 'https://tailcat-ssh-worker.iamwrm.workers.dev', address, port, clientKey, timeout = 1800, signal, allowLocal = false }) {
  const endpoint = new URL('/v1/transport', url);
  if (endpoint.protocol === 'https:') endpoint.protocol = 'wss:';
  if (endpoint.protocol === 'http:' && allowLocal && ['localhost','127.0.0.1','[::1]'].includes(endpoint.hostname)) endpoint.protocol = 'ws:';
  if (endpoint.protocol !== 'wss:' && !(allowLocal && endpoint.protocol === 'ws:' && ['localhost','127.0.0.1','[::1]'].includes(endpoint.hostname))) throw new Error('Use an HTTPS or WSS gateway');
  if (endpoint.username || endpoint.password) throw new Error('URL credentials are not supported');
  if (typeof address !== 'string' || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Supply a Tailcat address and TCP port');
  if (signal?.aborted) throw new Error('Transport aborted');
  const ws = new WebSocket(endpoint);
  ws.binaryType = 'arraybuffer';
  let opened = false, ended = false, failed, remoteFin = false, localFin = false, busy = false;
  let sendCredit = 0, outstanding = 0, received = 0, previous = 0;
  let queue = [], readWait, writeWait, resolveOpen, rejectOpen, resolveClosed, rejectClosed;
  const ready = new Promise((resolve, reject) => { resolveOpen = resolve; rejectOpen = reject; });
  const closed = new Promise((resolve, reject) => { resolveClosed = resolve; rejectClosed = reject; });
  // Users can observe closed without an unhandled rejection during setup.
  closed.catch(() => {});
  const control = value => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(value)); };
  const wake = () => { readWait?.(); readWait = null; writeWait?.(); writeWait = null; };
  function cleanup() { clearTimeout(openTimer); signal?.removeEventListener('abort', abort); }
  function fail(error) {
    if (ended) return;
    failed = error; ended = true; queue = []; cleanup();
    rejectOpen(error); rejectClosed(error); wake();
    try { ws.close(1000, 'Client stopped'); } catch {}
  }
  const abort = () => fail(new Error('Transport aborted'));
  signal?.addEventListener('abort', abort, { once: true });
  const openTimer = setTimeout(() => fail(new Error('Transport open timeout')), 30000);
  ws.addEventListener('open', () => control({ type: 'open', version: 1, target: { type: 'tailcat', address, port }, client_key: clientKey, timeout_seconds: timeout }));
  ws.addEventListener('message', event => {
    if (ended) return;
    try {
      if (typeof event.data !== 'string') {
        const chunk = new Uint8Array(event.data);
        if (!opened || remoteFin || !chunk.length || chunk.length > 16384 || received + chunk.length > 65536) throw new Error('Invalid binary frame');
        received += chunk.length; queue.push(chunk); wake(); return;
      }
      if (event.data.length > 8192) throw new Error('Control message too large');
      const m = JSON.parse(event.data);
      if (m.type === 'hello') { if (m.version !== 1) throw new Error('Unsupported transport version'); return; }
      if (m.type === 'error') { const e = new Error(`${m.code}: ${m.message}`); e.code = m.code; throw e; }
      if (m.type === 'opened' && !opened && m.version === 1 && m.window === 65536 && m.max_frame === 16384) {
        opened = true; sendCredit = m.window; clearTimeout(openTimer); resolveOpen(); return;
      }
      if (!opened) throw new Error('Expected opened');
      if (m.type === 'window_update') {
        if (!Number.isInteger(m.bytes) || m.bytes <= 0 || m.bytes > outstanding) throw new Error('Invalid input credit');
        outstanding -= m.bytes; sendCredit += m.bytes; wake();
      } else if (m.type === 'fin' && !remoteFin) { remoteFin = true; wake(); }
      else if (m.type === 'closed' && localFin && remoteFin) {
        ended = true; cleanup(); resolveClosed(); wake(); ws.close(1000, 'TCP closed');
      } else throw new Error('Unexpected transport message');
    } catch (e) { fail(e); }
  });
  ws.addEventListener('error', () => fail(new Error('WebSocket connection failed')));
  ws.addEventListener('close', () => { if (!ended) fail(new Error('Transport disconnected before TCP closed')); });
  await ready;
  return {
    closed,
    async write(data) {
      if (busy) throw new Error('Await the previous write before writing again');
      if (!(data instanceof Uint8Array)) throw new Error('write requires Uint8Array');
      if (localFin || ended) throw failed || new Error('Transport write side closed');
      busy = true;
      try {
        for (let offset = 0; offset < data.length;) {
          while (!ended && sendCredit === 0) await new Promise(resolve => { writeWait = resolve; });
          if (ended) throw failed || new Error('Transport closed');
          const n = Math.min(16384, sendCredit, data.length - offset);
          sendCredit -= n; outstanding += n;
          ws.send(data.subarray(offset, offset + n)); offset += n;
        }
      } finally { busy = false; }
    },
    end() {
      if (busy) throw new Error('Await the last write before ending');
      if (failed) throw failed;
      if (!localFin && !ended) { localFin = true; control({ type: 'fin' }); }
    },
    close() { control({ type: 'reset' }); fail(new Error('Transport closed by client')); },
    // Advancing the iterator acknowledges the prior chunk. Consumers must finish
    // using it before advancing, keeping the receive window genuinely bounded.
    async *[Symbol.asyncIterator]() {
      try {
        while (true) {
          if (previous) { received -= previous; control({ type: 'window_update', bytes: previous }); previous = 0; }
          while (!queue.length && !remoteFin && !ended) await new Promise(resolve => { readWait = resolve; });
          if (failed) throw failed;
          if (!queue.length) return;
          const chunk = queue.shift(); previous = chunk.length;
          yield chunk;
        }
      } finally { if (!remoteFin && !ended) { control({ type: 'reset' }); fail(new Error('Reader stopped')); } }
    },
  };
}
