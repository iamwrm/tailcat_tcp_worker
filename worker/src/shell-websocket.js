// Curl can carry an HTTP/1.1 Upgrade as a raw duplex stream. The local wrapper
// supplies RFC 6455 framing; this adapter feeds the same bounded shell protocol.
export function shellWebSocket(request, env, ctx, handler) {
  const [client, server] = Object.values(new WebSocketPair());
  server.accept();
  const abort = new AbortController();
  let closed = false, upload, download, credit, creditTimer, outstanding = 0;
  const lifetime = setTimeout(() => finish(1000), 3615000);
  const body = new ReadableStream({ start(c) { upload = c; } }, { highWaterMark: 262145, size: v => v.byteLength });
  const encoder = new TextEncoder();
  const finish = (code = 1000) => {
    if (closed) return;
    closed = true;
    clearTimeout(lifetime); clearTimeout(creditTimer);
    abort.abort(); credit?.();
    try { upload.close(); } catch {}
    download?.cancel().catch(() => {});
    try { server.close(code, 'Session closed'); } catch {}
  };
  const send = value => {
    if (closed) return;
    outstanding += encoder.encode(value).byteLength;
    server.send(value);
  };
  server.addEventListener('message', event => {
    if (closed) return;
    if (typeof event.data !== 'string' || event.data.length > 262145) { finish(1009); return; }
    try {
      const frame = JSON.parse(event.data);
      if (frame?.type === 'ack') {
        if (Object.keys(frame).some(k => !['type', 'bytes'].includes(k)) || !Number.isInteger(frame.bytes) || frame.bytes < 1 || frame.bytes > outstanding) { finish(1008); return; }
        outstanding -= frame.bytes;
        if (outstanding < 65536) { clearTimeout(creditTimer); credit?.(); credit = null; }
        return;
      }
    } catch { finish(1008); return; }
    const bytes = encoder.encode(event.data.endsWith('\n') ? event.data : event.data + '\n');
    if (bytes.byteLength > upload.desiredSize) { finish(1009); return; }
    upload.enqueue(bytes);
  });
  server.addEventListener('close', () => finish());
  server.addEventListener('error', () => finish(1011));
  // Also flushes curl's buffered HTTP Upgrade headers before credentials upload.
  send(JSON.stringify({ type: 'status', stage: 'awaiting_credentials' }) + '\n');
  const internal = new Request(request.url, {
    method: 'POST', body, signal: abort.signal,
    headers: { 'Content-Type': 'application/x-tailcat-shell+json', Accept: 'application/x-ndjson' },
  });
  ctx.waitUntil((async () => {
    try {
      const response = await handler(internal, { ...env, EXEC_LIMIT: null }, ctx);
      if (!response.ok) {
        send(JSON.stringify({ type: 'error', code: 'request_failed', message: response.status === 503 ? 'Worker busy; retry shortly' : 'Invalid shell request' }) + '\n');
        return;
      }
      download = response.body.getReader();
      const decoder = new TextDecoder();
      while (!closed) {
        if (outstanding >= 65536) await new Promise(resolve => { credit = resolve; creditTimer = setTimeout(() => finish(1008), 30000); });
        if (closed) break;
        const { value, done } = await download.read();
        if (done) break;
        send(decoder.decode(value, { stream: true }));
      }
    } catch {
      if (!closed) send(JSON.stringify({ type: 'error', code: 'connection_failed', message: 'Terminal connection ended unexpectedly' }) + '\n');
    } finally { finish(); }
  })());
  return new Response(null, { status: 101, webSocket: client });
}
