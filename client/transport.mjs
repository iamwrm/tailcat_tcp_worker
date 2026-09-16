#!/usr/bin/env node
// Local TCP / stdio adapter. Network authentication belongs to your application.
import net from 'node:net';
import { once } from 'node:events';
import { openTcp } from './transport-client.mjs';

const help = `Usage:
  node transport.mjs stdio --port 22 [--url HTTPS_ORIGIN]
  node transport.mjs forward --listen 127.0.0.1:8080 --port 80

Environment: TAILCAT_ADDR (required), TAILCAT_CLIENT_KEY (optional).
Options: --timeout SECONDS (1–3600, default 1800), --allow-local (tests only).
Native SSH: ssh -o 'ProxyCommand=node /path/transport.mjs stdio --port 22' user@host
SSH credentials and known_hosts are handled by native ssh on your machine.
`;
const sessions = new Set();
let server;
async function main() {
  const args = process.argv.slice(2), mode = args.shift();
  if (mode === '--help' || mode === '-h') { process.stdout.write(help); return; }
  if (!['stdio','forward'].includes(mode)) throw new Error(help);
  const options = { address: process.env.TAILCAT_ADDR, port: undefined };
  let listen;
  while (args.length) {
    const arg = args.shift();
    if (arg === '--allow-local') { options.allowLocal = true; continue; }
    if (!['--port','--url','--timeout','--listen'].includes(arg) || !args.length) throw new Error('Unknown or missing option: ' + arg);
    const value = args.shift();
    if (arg === '--listen') listen = value;
    else options[arg.slice(2)] = ['--port','--timeout'].includes(arg) ? Number(value) : value;
  }
  if (!options.address || !Number.isInteger(options.port) || options.port < 1 || options.port > 65535) throw new Error('Set TAILCAT_ADDR and --port');
  options.clientKey = process.env.TAILCAT_CLIENT_KEY;
  async function bridge(input, output) {
    const aborter = new AbortController();
    sessions.add(aborter);
    const close = () => { if (!input.readableEnded) aborter.abort(); };
    const inputError = () => aborter.abort();
    input.on('error', inputError); output.on('error', inputError);
    // A socket may close while the Tailcat connection is still opening.
    input.on('close', close);
    let tcp;
    try {
      tcp = await openTcp({ ...options, signal: aborter.signal });
      await Promise.all([
        (async () => {
          for await (const chunk of input) await tcp.write(new Uint8Array(chunk));
          tcp.end();
        })(),
        (async () => {
          for await (const chunk of tcp) if (!output.write(chunk)) await once(output, 'drain');
          output.end();
        })(),
        tcp.closed,
      ]);
    } finally {
      input.off('close', close); input.off('error', inputError); output.off('error', inputError);
      sessions.delete(aborter); tcp?.close();
      if (mode === 'forward') input.destroy();
    }
  }
  if (mode === 'stdio') { await bridge(process.stdin, process.stdout); return; }
  const match = /^(127\.0\.0\.1|localhost):([0-9]+)$/.exec(listen || '');
  if (!match || Number(match[2]) > 65535) throw new Error('--listen must be 127.0.0.1:PORT (loopback only)');
  server = net.createServer({ allowHalfOpen: true }, socket => {
    socket.setNoDelay(true);
    bridge(socket, socket).catch(e => process.stderr.write(`Transport: ${e.message}\n`));
  });
  server.listen(Number(match[2]), '127.0.0.1');
  await once(server, 'listening');
  process.stderr.write(`Listening on 127.0.0.1:${server.address().port}; target port ${options.port}\n`);
  await once(server, 'close');
}
for (const signal of ['SIGINT','SIGTERM']) process.on(signal, () => {
  for (const session of sessions) session.abort();
  server?.close();
  if (!server) process.exitCode = signal === 'SIGINT' ? 130 : 143;
});
main().catch(e => { process.stderr.write(`Transport: ${e.message}\n`); process.exitCode = 1; process.stdin.destroy(); });
