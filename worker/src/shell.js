// One streaming request: a bounded JSON credential line, then terminal input.
// Framed input additionally supports terminal resize events. Nothing is stored.
export async function parseShell(request, validate) {
  const type = (request.headers.get('content-type') || '').split(';')[0];
  if (!['application/x-tailcat-shell', 'application/x-tailcat-shell+json'].includes(type)) {
    throw new Error('Use application/x-tailcat-shell or application/x-tailcat-shell+json');
  }
  const reader = request.body?.getReader();
  if (!reader) throw new Error('Request body is required');
  let pending = new Uint8Array(), ended = false, closed = false, total = 0;
  const close = async () => { closed = true; pending = new Uint8Array(); try { reader.cancel().catch(() => {}); } catch {} };
  const read = async () => {
    if (closed || ended) return false;
    const { value, done } = await reader.read();
    if (done) { ended = true; return false; }
    if (closed) return false;
    const next = new Uint8Array(pending.length + value.length);
    next.set(pending); next.set(value, pending.length); pending = next;
    return true;
  };
  const line = async limit => {
    while (!closed) {
      const at = pending.indexOf(10);
      if (at >= 0) {
        if (at > limit) throw new Error('Input line is too large');
        const value = pending.slice(0, at); pending = pending.slice(at + 1);
        return value;
      }
      if (pending.length > limit) throw new Error('Input line is too large');
      if (!await read()) {
        if (pending.length) throw new Error('Incomplete input line');
        return null;
      }
    }
    return null;
  };
  const timer = setTimeout(close, 10000);
  let input;
  try {
    const first = await line(256 * 1024);
    if (!first) throw new Error('Send a JSON credential line within 10 seconds');
    try { input = JSON.parse(new TextDecoder().decode(first)); }
    catch { throw new Error('Invalid credential JSON'); }
    input = validate(input, true);
  } catch (e) { await close(); throw e; }
  finally { clearTimeout(timer); }
  return {
    input, close,
    async next() {
      if (closed) return { type: 'eof' };
      let message;
      if (type.endsWith('+json')) {
        const bytes = await line(32768);
        if (!bytes) return { type: 'eof' };
        try { message = JSON.parse(new TextDecoder().decode(bytes)); }
        catch { throw new Error('Invalid terminal frame'); }
        if (message?.type === 'resize') {
          if (Object.keys(message).some(k => !['type', 'rows', 'cols'].includes(k)) ||
              !Number.isInteger(message.rows) || message.rows < 1 || message.rows > 1000 ||
              !Number.isInteger(message.cols) || message.cols < 1 || message.cols > 1000) throw new Error('Invalid terminal size');
          return message;
        }
        if (message?.type !== 'input' || Object.keys(message).some(k => !['type', 'data'].includes(k)) ||
            typeof message.data !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(message.data)) throw new Error('Invalid terminal frame');
        const raw = atob(message.data);
        message = { type: 'input', data: Uint8Array.from(raw, c => c.charCodeAt(0)) };
        if (message.data.length > 16384) throw new Error('Terminal input frame exceeds 16 KiB');
      } else {
        while (!pending.length) if (!await read()) return { type: 'eof' };
        message = { type: 'input', data: pending.slice(0, 16384) };
        pending = pending.slice(message.data.length);
      }
      total += message.data.length;
      if (total > 4 * 1024 * 1024) throw new Error('Terminal input exceeds 4 MiB');
      return message;
    },
  };
}
