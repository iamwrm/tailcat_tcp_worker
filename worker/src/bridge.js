// TCP v1 byte accounting and bounded batching. The Go side has one reader and
// one writer; ready operations return synchronously, blocked operations wait.
export const WINDOW = 65536, FRAME = 16384;
const CREDIT_BATCH = WINDOW / 2, BATCH_DELAY = 1, STALL_TIMEOUT = 30000;

export function createBridge({ sendControl, sendData, onError,
  schedule = setTimeout, cancel = clearTimeout, now = Date.now }) {
  let stopped = false, inputFin = false;
  let uploadCredit = WINDOW, consumed = 0, outstanding = 0;
  let queued = [], head = 0, readWait, creditWait;
  const output = new Uint8Array(FRAME);
  let outputSize = 0, outputTimer, creditTimer, stallTimer, stallDeadline;

  function later(fn) {
    return schedule(() => { try { fn(); } catch { onError('tcp_io_failed', 'Transport write failed'); } }, BATCH_DELAY);
  }
  function flushCredit() {
    cancel(creditTimer); creditTimer = undefined;
    if (stopped || !consumed) return;
    const bytes = consumed; consumed = 0;
    uploadCredit += bytes;
    sendControl({ type: 'window_update', bytes });
  }
  function checkStall() {
    stallTimer = undefined;
    if (stopped || !outstanding) return;
    const remaining = stallDeadline - now();
    if (remaining > 0) stallTimer = schedule(checkStall, remaining);
    else onError('consumer_timeout', 'No output credit received for 30 seconds');
  }
  function sendOutput(bytes) {
    if (!outstanding) {
      stallDeadline = now() + STALL_TIMEOUT;
      stallTimer = schedule(checkStall, STALL_TIMEOUT);
    }
    outstanding += bytes.byteLength;
    // WebSocket.send snapshots the bytes synchronously, so the source buffer
    // may be reused once send returns.
    sendData(bytes);
  }
  function flushOutput() {
    cancel(outputTimer); outputTimer = undefined;
    if (stopped || !outputSize) return;
    sendOutput(output.subarray(0, outputSize));
    outputSize = 0;
  }
  function write(bytes, length = bytes.byteLength) {
    if (stopped) return Promise.reject(new Error('Transport stopped'));
    if (outstanding + outputSize + length > WINDOW) {
      flushOutput();
      return new Promise((resolve, reject) => { creditWait = { resolve, reject, needed: length }; })
        .then(() => write(bytes, length));
    }
    // Keystrokes, prompts and small replies do not need a batching delay.
    // Never bypass pending output: stream byte order remains unchanged.
    if (!outputSize && length <= 256) { sendOutput(bytes.subarray(0, length)); return; }
    let offset = 0;
    while (offset < length) {
      const n = Math.min(FRAME - outputSize, length - offset);
      output.set(bytes.subarray(offset, offset + n), outputSize);
      outputSize += n; offset += n;
      if (outputSize === FRAME) flushOutput();
    }
    if (outputSize && outputTimer === undefined) outputTimer = later(flushOutput);
    // No Promise, callback registration or Go scheduler round trip on this path.
  }
  return {
    read() {
      if (stopped) return Promise.reject(new Error('Transport stopped'));
      if (head < queued.length) {
        const bytes = queued[head]; queued[head++] = undefined;
        if (head === queued.length) { queued = []; head = 0; }
        else if (head >= 64) { queued = queued.slice(head); head = 0; }
        return bytes;
      }
      if (inputFin) return null;
      return new Promise((resolve, reject) => { readWait = { resolve, reject }; });
    },
    receive(bytes) {
      if (stopped || inputFin || !bytes.byteLength || bytes.byteLength > FRAME || bytes.byteLength > uploadCredit) {
        throw new Error('Input exceeds frame or flow-control limit');
      }
      uploadCredit -= bytes.byteLength;
      if (readWait) { const waiter = readWait; readWait = null; waiter.resolve(bytes); }
      else queued.push(bytes);
    },
    consumed(bytes) {
      if (stopped) return;
      consumed += bytes;
      if (consumed >= CREDIT_BATCH) flushCredit();
      else if (creditTimer === undefined) creditTimer = later(flushCredit);
    },
    endInput() {
      if (inputFin) throw new Error('Duplicate FIN');
      inputFin = true;
      if (readWait) { const waiter = readWait; readWait = null; waiter.resolve(null); }
    },
    write,
    acknowledge(bytes) {
      if (!Number.isInteger(bytes) || bytes <= 0 || bytes > outstanding) throw new Error('Invalid output credit');
      outstanding -= bytes;
      if (!outstanding) { cancel(stallTimer); stallTimer = undefined; }
      else stallDeadline = now() + STALL_TIMEOUT;
      // Acknowledgements update a deadline instead of allocating a new timer
      // per frame. Wake Go only when the blocked write can actually proceed.
      if (creditWait && WINDOW - outstanding - outputSize >= creditWait.needed) {
        const waiter = creditWait; creditWait = null; waiter.resolve();
      }
    },
    flush() { flushOutput(); flushCredit(); },
    stop() {
      if (stopped) return;
      stopped = true; queued = []; head = 0; outputSize = 0; consumed = 0;
      cancel(outputTimer); cancel(creditTimer); cancel(stallTimer);
      readWait?.reject(new Error('Transport stopped')); readWait = null;
      creditWait?.reject(new Error('Transport stopped')); creditWait = null;
    },
  };
}
