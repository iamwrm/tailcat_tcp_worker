const form = document.querySelector('form');
const output = document.querySelector('#output');
const status = document.querySelector('#status');
const run = document.querySelector('#run');
const stop = document.querySelector('#stop');
let controller;
document.querySelector('#curl-example').textContent = `curl -N '${location.origin}/api/exec' \\\n  -H 'Accept: text/plain' \\\n  --form-string "tailcat_address=$TAILCAT_ADDR" \\\n  --form-string 'username=deploy' \\\n  -F 'private_key=@/path/to/id_ed25519' \\\n  --form-string "host_key_sha256=$SSH_HOST_KEY" \\\n  --form-string 'command=uptime'`;
stop.addEventListener('click', () => controller?.abort());
form.addEventListener('submit', async e => {
  e.preventDefault();
  controller = new AbortController();
  run.disabled = true; stop.disabled = false;
  output.textContent = ''; status.textContent = 'Connecting';
  const decoders = { stdout: new TextDecoder(), stderr: new TextDecoder() };
  let terminal = false;
  try {
    const response = await fetch('/api/exec', { method: 'POST', body: new FormData(form), signal: controller.signal });
    if (!response.ok) throw new Error(await response.text());
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let pending = '';
    const consume = line => {
      if (!line.trim()) return;
      const event = JSON.parse(line);
      if (event.type === 'stdout' || event.type === 'stderr') {
        const bytes = Uint8Array.from(atob(event.data), c => c.charCodeAt(0));
        output.append(document.createTextNode(decoders[event.type].decode(bytes, { stream: true })));
        output.scrollTop = output.scrollHeight;
      } else if (event.type === 'status') status.textContent = event.stage === 'running' ? 'Running' : 'Connecting';
      else if (event.type === 'exit') { terminal = true; status.textContent = `Exited ${event.code}`; }
      else if (event.type === 'error') { terminal = true; status.textContent = 'Failed'; output.append(document.createTextNode(`\n${event.message}\n`)); }
      else if (event.type === 'runtime') document.querySelector('#metrics').textContent = `Wasm memory · ${(event.wasm_memory_bytes / 1048576).toFixed(1)} MiB`;
    };
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      pending += value;
      const lines = pending.split('\n'); pending = lines.pop();
      for (const line of lines) consume(line);
    }
    consume(pending);
    for (const d of Object.values(decoders)) output.append(document.createTextNode(d.decode()));
    if (!terminal) throw new Error('Connection ended without an exit status');
  } catch (e) {
    status.textContent = e.name === 'AbortError' ? 'Disconnected' : 'Failed';
    output.append(document.createTextNode(e.name === 'AbortError' ? '\nDisconnected. The remote command may continue running.\n' : `\n${e.message}\n`));
  } finally { run.disabled = false; stop.disabled = true; controller = null; }
});
