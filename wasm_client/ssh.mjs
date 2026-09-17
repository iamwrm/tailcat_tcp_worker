#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { main as sshMain, help as sshHelp } from '../client/ssh.mjs';
import { fingerprint } from '../client/ssh-client.mjs';
import { openTcp } from './transport-client.mjs';

export async function credentials(argv, baseEnv = process.env) {
  const args = [], files = {}, env = { ...baseEnv }, transportOptions = {};
  const flags = { '--credentials-dir': 'directory', '--address-file': 'address', '--host-key-file': 'host', '--client-key-file': 'client', '--derp-map-file': 'map' };
  let positional = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') positional = true;
    if (!positional && arg === '--live-relay-map') {
      transportOptions.liveRelayMap = true;
    } else if (!positional && arg in flags) {
      if (!argv[i + 1]) throw new Error(`Missing value for ${arg}`);
      files[flags[arg]] = resolve(argv[++i]);
    } else if (!positional && ['--url', '--allow-local'].includes(arg)) {
      throw new Error('The WASM client connects directly to DERP; gateway options are not supported');
    } else args.push(arg);
  }
  if (files.directory) {
    files.address ??= join(files.directory, 'tailcat-address.txt');
    files.host ??= join(files.directory, 'ssh-host-key.pub');
    env.SSH_KEY = join(files.directory, 'id_ed25519');
  }
  const read = async (path, label) => {
    let data;
    try { data = await readFile(path, 'utf8'); } catch { throw new Error(`Cannot read ${label} file`); }
    if (!data.trim() || data.length > 16384) throw new Error(`Invalid ${label} file`);
    return data.trim();
  };
  if (files.address) env.TAILCAT_ADDR = await read(files.address, 'Tailcat address');
  if (files.client) env.TAILCAT_CLIENT_KEY = await read(files.client, 'Tailcat client identity');
  if (files.host) {
    const text = await read(files.host, 'SSH host public key');
    const [type, encoded] = text.split(/\s+/);
    if (!type?.startsWith('ssh-') && !type?.startsWith('ecdsa-')) throw new Error('Supply an OpenSSH host public key, not a known_hosts file');
    if (!encoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new Error('Invalid SSH host public key');
    const raw = Buffer.from(encoded, 'base64');
    if (raw.length < 8 || raw.readUInt32BE(0) !== Buffer.byteLength(type) || raw.subarray(4, 4 + Buffer.byteLength(type)).toString() !== type) throw new Error('Invalid SSH host public key');
    env.SSH_HOST_KEY = fingerprint(raw);
  }
  delete env.TAILCAT_URL;
  if (files.map) transportOptions.derpMapFile = files.map;
  if (files.map && transportOptions.liveRelayMap) throw new Error('Choose either --derp-map-file or --live-relay-map');
  return { args, env, transportOptions };
}

export async function main(argv = process.argv.slice(2)) {
  if (!argv.length || ['--help', '-h'].includes(argv[0])) {
    process.stdout.write('Local Tailcat WASM + Node SSH. No Cloudflare Worker, native Tailcat, or ssh executable.\n\n' +
      '  node wasm_client/ssh.mjs exec --credentials-dir /private/credentials --user wr --timeout 30 -- \'hostname; id; uname -a\'\n\n' +
      'File options: --credentials-dir DIR, --address-file FILE, --host-key-file FILE, --client-key-file FILE.\n' +
      'The directory contains id_ed25519, tailcat-address.txt, and ssh-host-key.pub.\n\n' +
      'Relay map: bundled by default; --live-relay-map fetches it, --derp-map-file FILE supplies another.\n' +
      'HTTPS_PROXY/HTTP_PROXY/NO_PROXY (also lowercase) apply to HTTPS and relay WebSockets.\n\n' +
      sshHelp.replaceAll('client/ssh.mjs', 'wasm_client/ssh.mjs').split('\n').filter(line => !line.includes('--url ') && !line.includes('--allow-local ')).join('\n'));
    return 0;
  }
  const { args, env, transportOptions } = await credentials(argv);
  return sshMain(args, { openTcp: options => openTcp({ ...options, ...transportOptions }), env });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(code => { process.exitCode = code; process.stdin.pause(); }, error => {
    process.stderr.write(`WASM SSH: ${error.message}\n`); process.exitCode = 255; process.stdin.destroy();
  });
}
