import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Duplex, PassThrough, Writable } from 'node:stream';
import { runCommand } from '../ssh-client.mjs';
import { parseArguments } from '../ssh-cli.mjs';

test('SSH captures exit status delivered in the same parser turn as channel creation',async()=>{
  const client=new EventEmitter(), out=[],err=[];
  client.exec=(command,callback)=>{
    const stream=new Duplex({read(){},write(b,e,cb){cb();}});stream.stderr=new PassThrough();
    callback(null,stream);
    // ssh2 may emit these before returning from its channel-open callback.
    stream.emit('exit',7);stream.stderr.end('err');stream.push('out');stream.push(null);
  };
  const sink=chunks=>new Writable({write(b,e,cb){chunks.push(Buffer.from(b));cb();}});
  assert.equal(await runCommand({client},'probe',{input:null,output:sink(out),errorOutput:sink(err)}),7);
  assert.equal(Buffer.concat(out).toString(),'out');assert.equal(Buffer.concat(err).toString(),'err');
});

test('local SSH CLI parses commands and rsync arguments and rejects removed gateway flags', () => {
  const env = { TAILCAT_ADDR: 'tcTest', SSH_USER: 'wr', SSH_KEY: '/private/key', SSH_HOST_KEY: 'SHA256:trusted' };
  const command = parseArguments(['exec', '--timeout', '60', '--', 'hostname; id'], env);
  assert.equal(command.options.address, env.TAILCAT_ADDR);
  assert.equal(command.options.timeout, 60);
  assert.deepEqual(command.args, ['hostname; id']);
  const rsync = parseArguments(['rsh', '-l', 'alice', 'target', 'rsync', '--server', '.'], env);
  assert.equal(rsync.options.username, 'alice');
  assert.deepEqual(rsync.args, ['rsync', '--server', '.']);
  for (const flag of ['--url', '--allow-local']) {
    assert.throws(() => parseArguments(['exec', flag, 'https://removed.invalid', '--', 'id'], env), /Unknown/);
  }
});
