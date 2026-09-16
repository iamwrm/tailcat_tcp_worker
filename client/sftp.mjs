import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream, constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';

const call = (sftp, method, ...args) => new Promise((resolve, reject) => {
  try { sftp[method](...args, (error, value) => error ? reject(error) : resolve(value)); }
  catch (error) { reject(error); }
});
const safeName = name => typeof name === 'string' && name !== '.' && name !== '..' && name.length && !/[\\/\0]/.test(name);
const noLink = stat => { if (stat?.isSymbolicLink()) throw new Error('Symbolic links are not followed during file copies'); };
async function localStat(p) { try { return await fs.lstat(p); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } }
async function remoteStat(s, p) { try { return await call(s, 'lstat', p); } catch (e) { if (e.code === 2) return null; throw e; } }

// Exact destination paths, including for recursive copies. Temporary files are
// renamed only after the stream finishes; failures remove only our own temp file.
export async function copyFiles(session, direction, source, destination, { recursive = false } = {}) {
  if (!['upload','download'].includes(direction)) throw new Error('Invalid copy direction');
  if (![source, destination].every(p => typeof p === 'string' && p.length && !p.includes('\0'))) throw new Error('Supply source and destination paths');
  const sftp = await new Promise((resolve, reject) => session.client.sftp((e, s) => e ? reject(e) : resolve(s)));
  const totals = { files: 0, bytes: 0 };
  const counter = () => new Transform({ transform(chunk, encoding, callback) { totals.bytes += chunk.length; callback(null, chunk); } });
  async function copy(src, dst, depth) {
    if (depth > 64) throw new Error('Directory nesting exceeds 64 levels');
    const up = direction === 'upload';
    const stat = up ? await fs.lstat(src) : await call(sftp, 'lstat', src);
    noLink(stat);
    const existing = up ? await remoteStat(sftp, dst) : await localStat(dst);
    noLink(existing);
    if (stat.isDirectory()) {
      if (!recursive) throw new Error('Source is a directory; use --recursive');
      if (existing && !existing.isDirectory()) throw new Error('Directory destination is not a directory');
      if (!existing) {
        if (up) await call(sftp, 'mkdir', dst, { mode: stat.mode & 0o777 });
        else await fs.mkdir(dst, { mode: stat.mode & 0o777 });
      }
      const entries = up ? (await fs.readdir(src)).map(filename => ({ filename })) : await call(sftp, 'readdir', src);
      for (const entry of entries) {
        if (entry.filename === '.' || entry.filename === '..') continue;
        if (!safeName(entry.filename)) throw new Error('Invalid directory entry');
        await copy(up ? path.join(src, entry.filename) : path.posix.join(src, entry.filename), up ? path.posix.join(dst, entry.filename) : path.join(dst, entry.filename), depth + 1);
      }
      return;
    }
    if (!stat.isFile()) throw new Error('Only regular files and directories can be copied');
    if (existing && !existing.isFile()) throw new Error('File destination is not a regular file');
    const tmp = dst + '.tailcat-' + randomBytes(12).toString('hex') + '.part';
    let created = false;
    try {
      if (up) {
        // OPEN with exclusive creation reserves our random temporary path.
        const handle = await call(sftp, 'open', tmp, 'wx', { mode: 0o600 }); created = true;
        await pipeline(createReadStream(src, { flags: constants.O_RDONLY | (constants.O_NOFOLLOW || 0), highWaterMark: 16384 }), counter(), sftp.createWriteStream(tmp, { handle, autoClose: true, highWaterMark: 16384 }));
        await call(sftp, 'chmod', tmp, stat.mode & 0o777);
        try { await call(sftp, 'ext_openssh_rename', tmp, dst); }
        catch (e) {
          // Only fall back for unsupported extensions. Never delete an existing
          // target to emulate overwrite on servers without POSIX rename.
          if (e.code !== 8 && !/does not support|not supported/i.test(e.message)) throw e;
          await call(sftp, 'rename', tmp, dst);
        }
      } else {
        const handle = await fs.open(tmp, 'wx', 0o600); created = true;
        await pipeline(sftp.createReadStream(src, { highWaterMark: 16384 }), counter(), handle.createWriteStream({ autoClose: true }));
        await fs.chmod(tmp, stat.mode & 0o777);
        await fs.rename(tmp, dst);
      }
      created = false; totals.files++;
    } finally {
      if (created) {
        if (up) await call(sftp, 'unlink', tmp).catch(() => {});
        else await fs.unlink(tmp).catch(() => {});
      }
    }
  }
  try { await copy(source, destination, 0); return totals; }
  finally { sftp.end(); }
}
