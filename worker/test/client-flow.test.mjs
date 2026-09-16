import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Duplex, PassThrough, Writable } from 'node:stream';
import { openTcp } from '../../client/transport-client.mjs';
import { runCommand } from '../../client/ssh-client.mjs';

async function fakeConnection(t) {
  const original=globalThis.WebSocket;let socket;
  class Socket extends EventTarget {
    static OPEN=1;readyState=1;sent=[];
    constructor(){super();socket=this;queueMicrotask(()=>this.dispatchEvent(new Event('open')));}
    send(data){const m=JSON.parse(data);this.sent.push(m);if(m.type==='open')queueMicrotask(()=>this.message({type:'opened',version:1,window:65536,max_frame:16384}));}
    message(data){this.dispatchEvent(new MessageEvent('message',{data:typeof data==='object'&&!(data instanceof ArrayBuffer)?JSON.stringify(data):data}));}
    close(){this.readyState=3;this.dispatchEvent(new Event('close'));}
  }
  globalThis.WebSocket=Socket;t.after(()=>globalThis.WebSocket=original);
  t.mock.timers.enable({apis:['setTimeout']});
  const tcp=await openTcp({url:'https://fixture.invalid',address:'tcAAA',port:80});
  t.after(()=>tcp.close());
  return {tcp,socket,acks:()=>socket.sent.filter(m=>m.type==='window_update')};
}

test('SDK never credits held chunks; partial consumed credit flushes within one tick',async t=>{
  const {tcp,socket,acks}=await fakeConnection(t),iterator=tcp[Symbol.asyncIterator]();
  socket.message(new Uint8Array(16384).buffer);socket.message(new Uint8Array(16384).buffer);
  assert.equal((await iterator.next()).value.length,16384);t.mock.timers.tick(10);assert.equal(acks().length,0);
  assert.equal((await iterator.next()).value.length,16384);assert.equal(acks().length,0);
  t.mock.timers.tick(1);assert.deepEqual(acks(),[{type:'window_update',bytes:16384}]);
  t.mock.timers.tick(100);assert.equal(acks().length,1);
});

test('SDK batches credit at half a window and cancels its timer on close',async t=>{
  const {tcp,socket,acks}=await fakeConnection(t),iterator=tcp[Symbol.asyncIterator]();
  for(let i=0;i<4;i++)socket.message(new Uint8Array(16384).buffer);
  await iterator.next();await iterator.next();assert.equal(acks().length,0);
  await iterator.next();assert.deepEqual(acks(),[{type:'window_update',bytes:32768}]);
  await iterator.next();tcp.close();t.mock.timers.tick(100);assert.equal(acks().length,1);
});

test('SDK flushes consumed final bytes on FIN and does not deadlock a short response',async t=>{
  const {tcp,socket,acks}=await fakeConnection(t),iterator=tcp[Symbol.asyncIterator]();
  socket.message(Uint8Array.of(9).buffer);await iterator.next();socket.message({type:'fin'});
  assert.equal((await iterator.next()).done,true);assert.deepEqual(acks(),[{type:'window_update',bytes:1}]);
  tcp.end();socket.message({type:'closed'});await tcp.closed;
});

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
