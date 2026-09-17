// Test-only SSH/SFTP server. Files are confined to a disposable directory;
// exec accepts fixed synthetic commands and never starts an OS shell.
import ssh2 from 'ssh2';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { once } from 'node:events';
import { fingerprint } from '../ssh-client.mjs';

export async function startSSHFixture(parent) {
  const directory = await fs.mkdtemp(path.join(parent, 'sftp-'));
  const host = ssh2.utils.generateKeyPairSync('ed25519');
  const user = ssh2.utils.generateKeyPairSync('ed25519', { passphrase: 'test passphrase', cipher: 'aes256-cbc' });
  const publicKey = ssh2.utils.parseKey(user.public), clients = new Set();
  const stats = { authentications: 0 };
  const resolvePath = name => {
    const p = path.resolve(directory, '.' + (name.startsWith('/') ? name : '/' + name));
    if (p !== directory && !p.startsWith(directory + path.sep)) throw new Error('Outside fixture directory');
    return p;
  };
  const server = new ssh2.Server({ hostKeys: [host.private] }, client => {
    clients.add(client); client.on('close', () => clients.delete(client)); client.on('error', () => {});
    client.on('authentication', ctx => {
      stats.authentications++;
      if (ctx.username !== 'node-test' || ctx.method !== 'publickey' || !ctx.key.data.equals(publicKey.getPublicSSH()) || (ctx.signature && !publicKey.verify(ctx.blob, ctx.signature, ctx.hashAlgo))) return ctx.reject();
      ctx.accept();
    });
    client.on('ready', () => client.on('session', accept => {
      const session = accept();
      session.on('exec', (accept, reject, info) => {
        const channel = accept();
        if (info.command === 'cat') { channel.on('data', b => channel.write(b)); channel.on('end', () => { channel.exit(0); channel.end(); }); }
        else if (info.command === 'probe') { channel.stderr.write('node stderr\n'); channel.write('node stdout\n'); channel.exit(7); channel.end(); }
        else { channel.exit(127); channel.end(); }
      });
      session.on('sftp', accept => {
        const s = accept(), handles = new Map(); let next = 0;
        const handle = value => { const b = Buffer.alloc(4); b.writeUInt32BE(++next); handles.set(b.toString('hex'), value); return b; };
        const get = b => { const v = handles.get(b.toString('hex')); if (!v) throw new Error('Unknown handle'); return v; };
        const attrs = st => ({ mode: st.mode, size: st.size, uid: st.uid, gid: st.gid, atime: Math.floor(st.atimeMs / 1000), mtime: Math.floor(st.mtimeMs / 1000) });
        const on = (name, fn) => s.on(name, (id, ...args) => {
          Promise.resolve().then(() => fn(id, ...args)).catch(e => { if (!s.destroyed) s.status(id, e.code === 'ENOENT' ? 2 : e.code === 'EACCES' ? 3 : 4); });
        });
        on('OPEN', async (id, name, flags, a) => { const file = await fs.open(resolvePath(name), ssh2.utils.sftp.flagsToString(flags), a.mode ?? 0o600); s.handle(id, handle({ file })); });
        on('CLOSE', async (id, h) => { const value = get(h); await value.file?.close(); handles.delete(h.toString('hex')); s.status(id, 0); });
        on('READ', async (id, h, offset, length) => { const b = Buffer.alloc(Math.min(length, 32768)); const { bytesRead } = await get(h).file.read(b, 0, b.length, offset); if (bytesRead) s.data(id, b.subarray(0, bytesRead)); else s.status(id, 1); });
        on('WRITE', async (id, h, offset, data) => { let n = 0; while (n < data.length) { const result = await get(h).file.write(data, n, data.length - n, offset + n); n += result.bytesWritten; } s.status(id, 0); });
        for (const method of ['STAT','LSTAT']) on(method, async (id, name) => s.attrs(id, attrs(await fs.lstat(resolvePath(name)))));
        on('FSTAT', async (id, h) => s.attrs(id, attrs(await get(h).file.stat())));
        on('SETSTAT', async (id, name, a) => { if (a.mode !== undefined) await fs.chmod(resolvePath(name), a.mode); s.status(id, 0); });
        on('MKDIR', async (id, name, a) => { await fs.mkdir(resolvePath(name), { mode: a.mode ?? 0o755 }); s.status(id, 0); });
        on('REMOVE', async (id, name) => { await fs.unlink(resolvePath(name)); s.status(id, 0); });
        on('RENAME', async (id, from, to) => {
          try { await fs.lstat(resolvePath(to)); throw new Error('Destination exists'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
          await fs.rename(resolvePath(from), resolvePath(to)); s.status(id, 0);
        });
        on('OPENDIR', async (id, name) => {
          const entries = await fs.readdir(resolvePath(name));
          const listing = await Promise.all(entries.map(async filename => ({ filename, longname: filename, attrs: attrs(await fs.lstat(path.join(resolvePath(name), filename))) })));
          s.handle(id, handle({ listing }));
        });
        on('READDIR', (id, h) => { const v = get(h); if (v.listing.length) { s.name(id, v.listing); v.listing = []; } else s.status(id, 1); });
        s.on('close', () => { for (const v of handles.values()) v.file?.close().catch(() => {}); handles.clear(); });
      });
    }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return { directory, stats, port: server.address().port, privateKey: user.private, passphrase: 'test passphrase', username: 'node-test', hostKey: fingerprint(ssh2.utils.parseKey(host.private).getPublicSSH()),
    // ssh2 server-side Client has end(), not destroy(). Close its test socket
    // as well so unfinished handshakes cannot hold fixture cleanup open.
    async close() { for (const c of clients) { c.end(); c._sock.destroy(); } await new Promise(resolve => server.close(resolve)); await fs.rm(directory, { recursive: true, force: true }); } };
}
