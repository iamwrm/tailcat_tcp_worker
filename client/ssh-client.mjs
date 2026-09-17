import { Duplex } from 'node:stream';
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { constants } from 'node:os';
import ssh2 from 'ssh2';
import { openTcp } from '../wasm_client/transport-client.mjs';

// Adapt the bounded transport to the socket interface used by ssh2. A single
// reader and the Writable queue serialize reads/writes and preserve backpressure.
export class TransportSocket extends Duplex {
  constructor(tcp) {
    super({ highWaterMark: 16384, allowHalfOpen: true, autoDestroy: false });
    this.tcp = tcp;
    this.iterator = tcp[Symbol.asyncIterator]();
    this.reading = false;
    tcp.closed.catch(error => { if (!this.destroyed) this.destroy(error); });
  }
  _read() {
    if (this.reading || this.destroyed) return;
    this.reading = true;
    (async () => {
      try {
        while (!this.destroyed) {
          const { value, done } = await this.iterator.next();
          if (done) { this.push(null); break; }
          if (!this.push(Buffer.from(value))) break;
        }
      } catch (error) { this.destroy(error); }
      finally { this.reading = false; }
    })();
  }
  _write(chunk, encoding, callback) { this.tcp.write(chunk).then(() => callback(), callback); }
  _final(callback) { try { this.tcp.end(); callback(); } catch (error) { callback(error); } }
  _destroy(error, callback) { this.tcp.close(); callback(error); }
}

export function fingerprint(key) {
  return 'SHA256:' + createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
}

export async function connectSSH(options, { openTcp: connect = openTcp } = {}) {
  const { username, hostKey, keyFile, privateKey, passphrase, signal } = options;
  if (!username || typeof username !== 'string' || /[\x00-\x1f\x7f]/.test(username)) throw new Error('Supply an SSH username');
  if (!/^SHA256:[A-Za-z0-9+/]{43}$/.test(hostKey || '')) throw new Error('Supply a trusted SHA256 SSH host fingerprint');
  if (!keyFile && !privateKey) throw new Error('Supply an SSH private-key file');
  const key = privateKey || await readFile(keyFile);
  if (key.length > 262144) throw new Error('SSH private key exceeds 256 KiB');
  // Parse before opening the local transport, including encrypted-key validation.
  const parsed = ssh2.utils.parseKey(key, passphrase);
  if (parsed instanceof Error) throw new Error('Cannot read SSH private key; encrypted keys require a passphrase');
  const tcp = await connect({ ...options, port: options.port ?? 22 });
  const socket = new TransportSocket(tcp), client = new ssh2.Client();
  let mismatch = false, lastError, closing = false;
  const closed = new Promise(resolve => client.once('close', resolve));
  client.on('error', error => { lastError = error; });
  const close = () => {
    if (closing) return;
    closing = true;
    client.destroy(); socket.destroy();
  };
  // ssh2 attaches its socket listeners during connect, before any asynchronous I/O.
  try {
    await new Promise((resolve, reject) => {
      const fail = error => { cleanup(); reject(mismatch ? new Error('SSH host key mismatch') : error); };
      const gone = () => fail(lastError || new Error('SSH disconnected before authentication'));
      const ready = () => { cleanup(); resolve(); };
      const cleanup = () => { client.off('ready', ready); client.off('error', fail); client.off('close', gone); };
      client.once('ready', ready); client.once('error', fail); client.once('close', gone);
      client.connect({ sock: socket, username, privateKey: key, passphrase,
        readyTimeout: 20000, keepaliveInterval: 10000, keepaliveCountMax: 3,
        hostVerifier(raw) {
          const actual = Buffer.from(fingerprint(raw)), expected = Buffer.from(hostKey);
          mismatch = actual.length !== expected.length || !timingSafeEqual(actual, expected);
          return !mismatch;
        },
      });
    });
  } catch (error) { close(); throw error; }
  if (signal?.aborted) { close(); throw new Error('SSH aborted'); }
  return { client, close, closed, get error() { return lastError; } };
}

// Channel output is piped with Node backpressure, and only a real SSH exit status
// counts as completion. stdout remains byte-clean for rsync and other protocols.
export async function runCommand(session, command, { input = process.stdin, output = process.stdout, errorOutput = process.stderr, shell, onChannel } = {}) {
  return new Promise((resolve, reject) => {
    // Attach listeners inside ssh2's callback: a single TCP chunk can contain
    // channel success, output and exit status. Awaiting the channel first loses
    // events emitted while ssh2 parses the rest of that same chunk.
    const callback = (error, stream) => {
      if (error) { reject(error); return; }
      let exitCode, finished = false, releaseChannel;
      const cleanup = () => {
        input?.unpipe(stream); input?.pause();
        stream.unpipe(output); stream.stderr.unpipe(errorOutput);
        session.client.off('close', disconnected);
        input?.off('error', fail); output.off('error', fail); errorOutput.off('error', fail);
        releaseChannel?.();
      };
      const finish = (error, code) => {
        if (finished) return;
        finished = true; cleanup();
        if (error) reject(error); else resolve(code);
      };
      const fail = error => finish(error);
      const disconnected = () => finish(session.error || new Error('SSH disconnected without a command result'));
      stream.on('exit', (code, signal) => {
        if (Number.isInteger(code)) exitCode = code;
        else if (signal) exitCode = 128 + (constants.signals['SIG' + signal] || 0);
      });
      stream.on('error', fail); stream.stderr.on('error', fail);
      stream.on('close', () => {
        if (exitCode === undefined) finish(new Error('SSH command ended without an exit status'));
        else finish(null, exitCode);
      });
      session.client.once('close', disconnected);
      input?.on('error', fail); output.on('error', fail); errorOutput.on('error', fail);
      stream.pipe(output, { end: false }); stream.stderr.pipe(errorOutput, { end: false });
      try { releaseChannel = onChannel?.(stream); }
      catch (error) { fail(error); return; }
      if (input) input.pipe(stream); else if (!shell) stream.end();
    };
    if (shell) session.client.shell(shell, callback);
    else session.client.exec(command, callback);
  });
}
