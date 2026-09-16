export function runtimeScope(request, input, emit) {
  const scope = Object.create(globalThis);
  const timers = new Set();
  const sockets = new Set();
  const fetches = new Set();
  let disposed = false;
  // Never write Go runtime diagnostics to provider logs.
  scope.console = { log() {}, warn() {}, error() {} };
  scope.setTimeout = (fn, ms, ...args) => {
    if (disposed) return 0;
    const id = setTimeout(() => { timers.delete(id); if (!disposed) fn(...args); }, ms);
    timers.add(id);
    return id;
  };
  scope.clearTimeout = id => { timers.delete(id); clearTimeout(id); };
  scope.WebSocket = class {
    constructor(url, protocols) {
      const ws = new WebSocket(url, protocols);
      sockets.add(ws);
      ws.addEventListener('close', () => sockets.delete(ws));
      return ws;
    }
  };
  scope.fetch = async (url, options = {}) => {
    const controller = new AbortController();
    fetches.add(controller);
    const abort = () => controller.abort();
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) controller.abort();
    try {
      const response = await fetch(url, { ...options, signal: controller.signal, redirect: 'manual' });
      if ([301,302,303,307,308].includes(response.status)) { await response.body?.cancel(); throw new Error('Relay map redirects are not allowed'); }
      return response;
    }
    finally { fetches.delete(controller); options.signal?.removeEventListener('abort', abort); }
  };
  scope.tailcatRequest = JSON.stringify(input);
  scope.tailcatEmit = emit;
  scope.tailcatCancelled = request.signal.aborted;
  const cancel = () => { scope.tailcatCancelled = true; if (!disposed) scope.cancelTailcat?.(); };
  request.signal.addEventListener('abort', cancel, { once: true });
  return {
    scope, cancel,
    dispose() {
      disposed = true;
      request.signal.removeEventListener('abort', cancel);
      for (const id of timers) clearTimeout(id);
      for (const ws of sockets) { try { ws.close(1000, 'Request finished'); } catch {} }
      for (const c of fetches) c.abort();
      scope.tailcatRequest = '';
      scope.tailcatEmit = () => {};
      scope.cancelTailcat = undefined;
      timers.clear(); sockets.clear(); fetches.clear();
    },
  };
}

// Keep the existing conservative memory limit: one netstack per isolate.
let active = null;
export function acquireRuntime() {
  // A platform CPU termination can cancel the request without running finally.
  // Keep the admission reservation alive from its owning request only. If that
  // request is killed, its timers stop and a later request can reclaim the slot.
  if (active && active.expires > Date.now()) return null;
  const lease = { expires: Date.now() + 15000 };
  active = lease;
  let timer;
  const renew = () => {
    if (active !== lease) return;
    lease.expires = Date.now() + 15000;
    timer = setTimeout(renew, 5000);
  };
  timer = setTimeout(renew, 5000);
  return () => { clearTimeout(timer); if (active === lease) active = null; };
}
