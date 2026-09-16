#!/usr/bin/env node
import { Transform, Writable } from 'node:stream';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { connectSSH, runCommand } from './ssh-client.mjs';
import { copyFiles } from './sftp.mjs';

export const help = `Node SSH over Tailcat TCP — no local ssh/scp executable required.

  node client/ssh.mjs exec [options] -- 'uname -a'
  node client/ssh.mjs shell [options]
  node client/ssh.mjs upload [options] LOCAL REMOTE
  node client/ssh.mjs download [options] REMOTE LOCAL
  rsync -av -e 'node client/ssh.mjs rsh' ./source/ user@target:/destination/

Options:
  --user USER, -l USER     SSH user (or SSH_USER)
  --key FILE, -i FILE      Local SSH key (or SSH_KEY)
  --host-key SHA256:...    Trusted SSH host fingerprint (or SSH_HOST_KEY)
  --ask-passphrase         Prompt on a local terminal for an encrypted key
  --url HTTPS_ORIGIN       Gateway origin (or TAILCAT_URL)
  --port PORT             Tailcat target port (default 22)
  --timeout SECONDS        Session limit, 1–3600 (default 1800)
  --recursive, -r          Copy directories; destination is the exact target path
  --allow-local            Allow loopback HTTP gateway (tests only)

TAILCAT_ADDR is required. TAILCAT_CLIENT_KEY is optional. SSH_KEY_PASSPHRASE
may supply an encrypted key's passphrase when prompting is unavailable.
The rsh host argument is a label: TAILCAT_ADDR selects the target; SSH_HOST_KEY
verifies its identity. rsync must still be installed locally and remotely.
Interactive shell: Ctrl+C goes to the remote PTY; Ctrl+] disconnects locally.
`;

export function parseArguments(argv, env = process.env) {
  const args = [...argv], mode = args.shift();
  if (['--help','-h',undefined].includes(mode)) return { mode: 'help' };
  if (!['exec','shell','upload','download','rsh'].includes(mode)) throw new Error('Unknown operation; use --help');
  const options = { address: env.TAILCAT_ADDR, clientKey: env.TAILCAT_CLIENT_KEY,
    username: env.SSH_USER, keyFile: env.SSH_KEY, hostKey: env.SSH_HOST_KEY,
    passphrase: env.SSH_KEY_PASSPHRASE, url: env.TAILCAT_URL, port: 22, timeout: 1800 };
  const values = { '--user':'username', '-l':'username', '--key':'keyFile', '-i':'keyFile', '--host-key':'hostKey', '--url':'url', '--port':'port', '--timeout':'timeout' };
  let recursive = false, askPassphrase = false;
  while (args.length && args[0].startsWith('-')) {
    const arg = args.shift();
    if (arg === '--') break;
    if (arg === '--recursive' || arg === '-r') { recursive = true; continue; }
    if (arg === '--ask-passphrase') { askPassphrase = true; continue; }
    if (arg === '--allow-local') { options.allowLocal = true; continue; }
    if (!(arg in values) || !args.length) throw new Error('Unknown or missing option: ' + arg);
    const value = args.shift();
    options[values[arg]] = ['port','timeout'].includes(values[arg]) ? Number(value) : value;
  }
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) throw new Error('Port must be 1–65535');
  if (!Number.isInteger(options.timeout) || options.timeout < 1 || options.timeout > 3600) throw new Error('Timeout must be 1–3600 seconds');
  if (mode === 'rsh') {
    const host = args.shift();
    if (!host) throw new Error('Missing remote host label');
    if (host.includes('@')) {
      const split = host.lastIndexOf('@');
      if (!options.username) options.username = host.slice(0, split);
    }
  }
  if (['exec','rsh'].includes(mode) && !args.length) throw new Error('Supply a remote command');
  if (mode === 'shell' && args.length) throw new Error('Shell takes no positional arguments');
  if (['upload','download'].includes(mode) && args.length !== 2) throw new Error('Supply source and exact destination paths');
  return { mode, options, args, recursive, askPassphrase };
}

async function promptPassphrase() {
  if (!process.stdin.isTTY) throw new Error('Passphrase prompt needs a terminal; use SSH_KEY_PASSPHRASE for noninteractive input');
  const muted = new Writable({ write(chunk, encoding, callback) { callback(); } });
  const reader = createInterface({ input: process.stdin, output: muted, terminal: true });
  process.stderr.write('SSH key passphrase: ');
  let terminate;
  try {
    return await new Promise((resolve, reject) => {
      terminate = () => reject(new Error('Passphrase prompt terminated'));
      process.once('SIGTERM', terminate);
      reader.once('SIGINT', () => reject(new Error('Passphrase prompt cancelled')));
      reader.once('close', () => reject(new Error('Passphrase prompt closed')));
      reader.question('', resolve);
    });
  } finally { process.off('SIGTERM', terminate); reader.close(); process.stdin.pause(); process.stderr.write('\n'); }
}

export async function main(argv = process.argv.slice(2)) {
  const { mode, options, args, recursive, askPassphrase } = parseArguments(argv);
  if (mode === 'help') { process.stdout.write(help); return 0; }
  if (!options.address) throw new Error('Set TAILCAT_ADDR');
  if (askPassphrase) options.passphrase = await promptPassphrase();
  const aborter = new AbortController();
  let session, signalCode;
  const interrupt = () => { signalCode = 130; aborter.abort(); };
  const terminate = () => { signalCode = 143; aborter.abort(); };
  process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
  try {
    session = await connectSSH({ ...options, signal: aborter.signal });
    if (['exec','rsh'].includes(mode)) {
      // Match OpenSSH's remote-shell convention: rsync already quotes its remote
      // command arguments. Quoting each argument again would corrupt filenames.
      return await runCommand(session, args.join(' '));
    }
    if (mode === 'upload' || mode === 'download') {
      const result = await copyFiles(session, mode, ...args, { recursive });
      process.stderr.write(`${mode}: ${result.files} file(s), ${result.bytes} bytes\n`);
      return 0;
    }
    if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Interactive shell requires a terminal; use exec for pipes');
    const previousRaw = !!process.stdin.isRaw;
    let disconnect = false, channel;
    const input = new Transform({ transform(chunk, encoding, callback) {
      const index = chunk.indexOf(0x1d);
      if (index !== -1) {
        if (index) this.push(chunk.subarray(0, index));
        disconnect = true; aborter.abort(); callback();
      } else callback(null, chunk);
    } });
    const resize = () => {
      if (channel && !channel.destroyed) channel.setWindow(process.stdout.rows || 24, process.stdout.columns || 80, 0, 0);
    };
    try {
      process.stdin.setRawMode(true); process.stdin.pipe(input);
      process.on('SIGWINCH', resize); process.stdout.on('resize', resize);
      return await runCommand(session, '', {
        input,
        shell: { term: process.env.TERM || 'xterm-256color', rows: process.stdout.rows || 24, cols: process.stdout.columns || 80 },
        onChannel(stream) { channel = stream; },
      });
    } catch (error) { if (disconnect) return 0; throw error; }
    finally {
      process.off('SIGWINCH', resize); process.stdout.off('resize', resize);
      process.stdin.unpipe(input); input.destroy(); process.stdin.setRawMode(previousRaw); process.stdin.pause();
    }
  } catch (error) { if (signalCode) return signalCode; throw error; }
  finally {
    session?.close(); process.off('SIGINT', interrupt); process.off('SIGTERM', terminate);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(code => { process.exitCode = code; process.stdin.pause(); }, error => {
    process.stderr.write(`SSH: ${error.message}\n`); process.exitCode = 255; process.stdin.destroy();
  });
}
