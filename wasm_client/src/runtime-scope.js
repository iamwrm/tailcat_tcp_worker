// A private Go global scope per local Node thread. Network lifecycle belongs to
// createNetwork; this scope owns Go's timers and cancellation callback.
export function runtimeScope({ signal }, input, emit) {
  const scope = Object.create(globalThis), timers = new Set();
  let disposed = false;
  scope.console = { log() {}, warn() {}, error() {} };
  scope.setTimeout = (fn, ms, ...args) => {
    if (disposed) return 0;
    const id = setTimeout(() => { timers.delete(id); if (!disposed) fn(...args); }, ms);
    timers.add(id);
    return id;
  };
  scope.clearTimeout = id => { timers.delete(id); clearTimeout(id); };
  scope.tailcatRequest = JSON.stringify(input);
  scope.tailcatEmit = emit;
  scope.tailcatCancelled = signal.aborted;
  const cancel = () => { scope.tailcatCancelled = true; if (!disposed) scope.cancelTailcat?.(); };
  signal.addEventListener('abort', cancel, { once: true });
  return {
    scope,
    dispose() {
      disposed = true;
      signal.removeEventListener('abort', cancel);
      for (const id of timers) clearTimeout(id);
      timers.clear();
      scope.tailcatRequest = '';
      scope.tailcatEmit = () => {};
      scope.cancelTailcat = undefined;
    },
  };
}
