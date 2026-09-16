import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBridge, FRAME, WINDOW } from '../src/bridge.js';

function fixture() {
  let clock = 0, id = 0, scheduled = 0;
  const timers = new Map(), data = [], control = [], errors = [];
  const bridge = createBridge({
    sendData: bytes => data.push(Uint8Array.from(bytes)),
    sendControl: event => control.push(event),
    onError: (...e) => { errors.push(e); bridge.stop(); },
    schedule(fn, ms) { timers.set(++id, { at: clock + ms, fn }); scheduled++; return id; },
    cancel(id) { timers.delete(id); }, now: () => clock,
  });
  return { bridge, data, control, errors, timers, get scheduled() { return scheduled; },
    advance(ms) {
      const end = clock + ms;
      while (true) {
        const next = [...timers].sort((a,b) => a[1].at-b[1].at)[0];
        if (!next || next[1].at > end) break;
        clock = next[1].at; timers.delete(next[0]); next[1].fn();
      }
      clock = end;
    },
  };
}

test('output batches small reads and snapshots a reused source buffer', () => {
  const f = fixture(), source = new Uint8Array(1024), expected = [];
  for (let i = 0; i < 20; i++) { source.fill(i); expected.push(...source); assert.equal(f.bridge.write(source), undefined); }
  source.fill(255);
  assert.equal(f.data.length, 1); assert.equal(f.data[0].length, FRAME);
  f.advance(1); assert.equal(f.data.length, 2);
  assert.deepEqual(Buffer.concat(f.data), Buffer.from(expected));
  f.bridge.stop(); assert.equal(f.timers.size, 0);
});

test('one-byte interactive output sends immediately without a batching timer', () => {
  const f = fixture(); f.bridge.write(Uint8Array.of(65));
  assert.deepEqual(f.data, [Uint8Array.of(65)]); assert.equal(f.timers.size, 1);
  f.bridge.stop();
});

test('FIN flushes pending bytes before its control message', () => {
  const sent = [];
  const bridge = createBridge({ sendData: b => sent.push([...b]), sendControl: e => sent.push(e), onError: assert.fail });
  const payload=new Uint8Array(300).fill(7);bridge.write(payload);assert.equal(sent.length,0);
  bridge.write(Uint8Array.of(1,2,3));assert.equal(sent.length,0);
  bridge.flush(); sent.push({type:'fin'});
  assert.deepEqual(sent, [[...payload,1,2,3], {type:'fin'}]); bridge.stop();
});

test('batched output remains inside credit and wakes only when enough is available', async () => {
  const f = fixture(), bytes = new Uint8Array(FRAME);
  for (let i = 0; i < 4; i++) f.bridge.write(bytes);
  const blocked = f.bridge.write(bytes); let resumed = false; blocked.then(() => resumed = true);
  assert.equal(f.data.reduce((n,b)=>n+b.length,0), WINDOW);
  f.bridge.acknowledge(FRAME-1); await Promise.resolve(); assert.equal(resumed, false);
  f.bridge.acknowledge(1); await blocked; assert.equal(resumed, true);
  assert.equal(f.data.reduce((n,b)=>n+b.length,0), WINDOW+FRAME);
  assert.throws(()=>f.bridge.acknowledge(WINDOW+1), /Invalid output credit/);
  f.bridge.stop();
});

test('pending output consumes credit and cannot be acknowledged before send', async () => {
  const f = fixture(); f.bridge.write(new Uint8Array(FRAME-1));
  assert.throws(()=>f.bridge.acknowledge(1), /Invalid output credit/);
  for(let i=0;i<3;i++)f.bridge.write(new Uint8Array(FRAME));
  const blocked=f.bridge.write(Uint8Array.of(7,8));
  assert.equal(f.data.reduce((n,b)=>n+b.length,0),WINDOW-1);
  f.bridge.acknowledge(1); await blocked; f.advance(1);
  assert.equal(f.data.reduce((n,b)=>n+b.length,0),WINDOW+1);
  f.bridge.stop();
});

test('input ACKs batch, flush small consumption, and preserve the advertised window', () => {
  const f=fixture(), b=new Uint8Array(FRAME);
  for(let i=0;i<4;i++)f.bridge.receive(b);
  assert.throws(()=>f.bridge.receive(Uint8Array.of(1)),/flow-control/);
  f.bridge.read();f.bridge.consumed(FRAME);
  assert.equal(f.control.length,0);
  assert.throws(()=>f.bridge.receive(Uint8Array.of(1)),/flow-control/);
  f.bridge.read();f.bridge.consumed(FRAME);
  assert.deepEqual(f.control,[{type:'window_update',bytes:32768}]);
  f.bridge.receive(b);f.bridge.read();f.bridge.consumed(3);f.advance(1);
  assert.equal(f.control[1].bytes,3);f.bridge.stop();
});

test('ready input and EOF are synchronous; waiting input and cancellation settle', async () => {
  const f=fixture(), bytes=Uint8Array.of(1);
  f.bridge.receive(bytes);assert.equal(f.bridge.read(),bytes);
  const waiting=f.bridge.read();assert.ok(waiting instanceof Promise);f.bridge.receive(bytes);assert.equal(await waiting,bytes);
  f.bridge.endInput();assert.equal(f.bridge.read(),null);
  assert.throws(()=>f.bridge.receive(bytes));assert.throws(()=>f.bridge.endInput());f.bridge.stop();
  const g=fixture();const read=g.bridge.read();for(let i=0;i<4;i++)g.bridge.write(new Uint8Array(FRAME));const write=g.bridge.write(bytes);
  g.bridge.stop();await assert.rejects(read,/stopped/);await assert.rejects(write,/stopped/);assert.equal(g.timers.size,0);
});

test('credit refreshes the stall deadline without replacing its timer each time', () => {
  const f=fixture();f.bridge.write(new Uint8Array(FRAME));const scheduled=f.scheduled;
  f.advance(29000);for(let i=0;i<100;i++)f.bridge.acknowledge(1);
  assert.equal(f.scheduled,scheduled);f.advance(1000);assert.equal(f.errors.length,0);
  f.advance(28999);assert.equal(f.errors.length,0);f.advance(1);assert.equal(f.errors[0][0],'consumer_timeout');
});
