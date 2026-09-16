import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdirSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { openTcp } from '../../client/transport-client.mjs';
import { createHash, randomBytes } from 'node:crypto';
import { writeFileSync, rmSync } from 'node:fs';

const root = fileURLToPath(new URL('../',import.meta.url));
let mf, fixture, credentials, config;
before(async()=>{
 mkdirSync(root+'test/.tmp',{recursive:true});
 execFileSync('go',['build','-o','test/.tmp/fixture','./test/fixture'],{cwd:root,env:{...process.env,GOTOOLCHAIN:'go1.27.1'},stdio:'pipe'});
 fixture=spawn(root+'test/.tmp/fixture',[],{cwd:root,env:{...process.env,TS_DEBUG_USE_DERP_HTTP:'true'},stdio:['ignore','pipe','pipe']});
 fixture.stderr.on('data',()=>{});
 const lines=createInterface({input:fixture.stdout});
 credentials=await Promise.race([
  new Promise((resolve,reject)=>{lines.once('line',line=>resolve(JSON.parse(line)));fixture.once('exit',code=>reject(new Error('Fixture exited: '+code)))}),
  new Promise((_,reject)=>{const t=setTimeout(()=>reject(new Error('Fixture startup timeout')),60000);t.unref()}),
 ]);
 const dir=root+'.wrangler/build/';
 config={modules:[{type:'ESModule',path:dir+'index.js'},...readdirSync(dir).filter(f=>f.endsWith('.wasm')).map(f=>({type:'CompiledWasm',path:dir+f}))],modulesRoot:dir,compatibilityDate:'2026-09-16',bindings:{DERP_MAP_URL:credentials.map_url,TEST_DERP_HTTP:'1'}};
 mf=new Miniflare(convertV4MiniflareOptions(config));
 await mf.ready;
}, {timeout:180000});
after(async()=>{await mf?.dispose();fixture?.kill('SIGTERM')});

async function tcp(port, extra={}) {
 return openTcp({url:String(await mf.ready),address:credentials.tailcat_address,port,allowLocal:true,timeout:20,...extra});
}
async function collect(t) { const chunks=[];for await(const b of t)chunks.push(b);return Buffer.concat(chunks); }
async function eventually(predicate) { const deadline=Date.now()+10000;while(!await predicate()){if(Date.now()>deadline)throw new Error('Condition timed out');await new Promise(r=>setTimeout(r,20))} }
async function settled() { await new Promise(r=>setTimeout(r,100)); }
async function childResult(child, input) {
 let out='',err='';child.stdout.on('data',x=>out+=x);child.stderr.on('data',x=>err+=x);child.stdin?.on('error',()=>{});
 if(input!==undefined)child.stdin.end(input);
 const code=await new Promise(resolve=>child.on('close',resolve));return {code,out,err};
}

function body(overrides={}){
 const {host_key_public,wrong_private_key,map_url,stats_url,...req}=credentials;
 return {...req,...overrides};
}
async function exec(overrides={},extraHeaders={}){
 const response=await mf.dispatchFetch('http://localhost/api/exec',{method:'POST',headers:{'Content-Type':'application/json',...extraHeaders},body:JSON.stringify(body(overrides))});
 const text=await response.text();
 if(response.status!==200) return {status:response.status,text,events:[]};
 return {status:response.status,text,events:text.trim().split('\n').filter(Boolean).map(x=>JSON.parse(x))};
}
function data(events,kind){return Buffer.concat(events.filter(e=>e.type===kind).map(e=>Buffer.from(e.data,'base64'))).toString()}

test('health and HTTP validation before connecting',async()=>{
 assert.equal((await mf.dispatchFetch('http://localhost/api/health')).status,200);
 assert.equal((await mf.dispatchFetch('http://localhost/api/exec')).status,405);
 assert.equal((await exec({private_key:''})).status,400);
 assert.equal((await exec({port:70000})).status,400);
 assert.equal((await exec({derp_map_url:'http://127.0.0.1/'})).status,400);
 assert.equal((await exec({}, {Origin:'https://untrusted.example'})).status,403);
 assert.equal((await exec({command:'x'.repeat(300000)})).status,400);
});

test('real Tailcat tunnel, SSH key authentication, streamed output, exit status',async()=>{
 const result=await exec();
 assert.equal(result.status,200);
 assert.equal(data(result.events,'stdout'),'hello from SSH through Tailcat\n',result.text);
 assert.equal(data(result.events,'stderr'),'stderr is separate\n');
 assert.equal(result.events.find(e=>e.type==='exit')?.code,7,result.text);
 const memory=result.events.find(e=>e.type==='runtime')?.wasm_memory_bytes;
 assert.ok(memory>0&&memory<128*1048576,`Wasm memory: ${memory}`);
 console.log(`Wasm linear memory after full command: ${(memory/1048576).toFixed(1)} MiB`);
}, {timeout:60000});

test('wrong host fingerprint prevents command execution',async()=>{
 const before=await(await fetch(credentials.stats_url)).json();
 const result=await exec({host_key_sha256:'SHA256:'+'A'.repeat(43)});
 assert.equal(result.events.find(e=>e.type==='error')?.code,'host_key_mismatch',result.text);
 const after=await(await fetch(credentials.stats_url)).json();
 assert.equal(before.executions,after.executions);
});

test('wrong SSH key is rejected; credentials do not leak into errors',async()=>{
 const result=await exec({private_key:credentials.wrong_private_key});
 assert.equal(result.events.find(e=>e.type==='error')?.code,'ssh_handshake_failed',result.text);
 assert.ok(!result.text.includes(credentials.tailcat_address));
 assert.ok(!result.text.includes('PRIVATE KEY'));
});

test('repeated requests use independent runtimes and preserve UTF-8 bytes',async()=>{
 for(let i=0;i<3;i++){
  const result=await exec({command:'unicode'});
  assert.equal(data(result.events,'stdout'),'🐈\n',result.text);
  assert.equal(result.events.find(e=>e.type==='exit')?.code,0);
 }
});

test('multipart curl-compatible request and plain output',async()=>{
 const form=new FormData();
 for(const [k,v] of Object.entries(body()))form.set(k,k==='private_key'?new File([v],'id_ed25519'):String(v));
 const encoded=new Request('http://localhost/api/exec',{method:'POST',body:form});
 const response=await mf.dispatchFetch('http://localhost/api/exec',{method:'POST',headers:{Accept:'text/plain','Content-Type':encoded.headers.get('content-type')},body:await encoded.arrayBuffer()});
 const text=await response.text();
 assert.equal(response.status,200,text);
 assert.ok(text.includes('hello from SSH through Tailcat\n'),text);
 assert.ok(text.includes('[exit 7]'));
});

test('command deadline closes the session and allows the next request',async()=>{
 const result=await exec({command:'slow',timeout_seconds:2});
 assert.equal(result.events.find(e=>e.type==='error')?.code,'timeout',result.text);
 const next=await exec();assert.equal(next.events.find(e=>e.type==='exit')?.code,7,next.text);
});

test('output limit bounds buffering',async()=>{
 const result=await exec({command:'flood'});
 assert.equal(result.events.find(e=>e.type==='error')?.code,'output_limit',result.text.slice(-1000));
});

async function interactive(overrides={}, framed=false) {
 const {command,...creds}=body(overrides);
 const url=new URL('/api/shell',await mf.ready).href;
 const child=spawn('curl',['--disable','--silent','--show-error','--no-buffer','--request','POST','--header','Expect:','--header','Content-Type: application/x-tailcat-shell'+(framed?'+json':''),'--upload-file','.',url],{stdio:['pipe','pipe','pipe']});
 let text='',errors='';child.stdout.on('data',b=>text+=b.toString());child.stderr.on('data',b=>errors+=b.toString());child.stdin.on('error',()=>{});
 const finished=new Promise(resolve=>child.on('close',code=>{resolve(code)}));
 child.stdin.write(JSON.stringify(creds)+'\n');
 return {response:{status:200},reader:{async cancel(){child.kill('SIGTERM');await finished}},
  send(s){child.stdin.write(s)},frame(obj){child.stdin.write(JSON.stringify(obj)+'\n')},
  async until(pattern){
   const until=Date.now()+10000;
   while(!text.includes(pattern)){
    if(Date.now()>until||child.exitCode!==null) {child.kill();throw new Error('Missing '+pattern+'; got '+text+'; curl: '+errors)}
    await new Promise(r=>setTimeout(r,10));
   }
  },
  async end(){const until=Date.now()+20000;while(!/\[(exit |timeout|host_key_mismatch|ssh_execution_failed)/.test(text)&&Date.now()<until&&child.exitCode===null)await new Promise(r=>setTimeout(r,20));child.stdin.end();await finished;return text}
 };
}

test('interactive raw curl protocol receives a prompt before upload ends; forwards keys and Ctrl+C',async()=>{
 const s=await interactive({rows:32,cols:100,timeout_seconds:15});
 assert.equal(s.response.status,200);
 await s.until('PTY ready:32x100');
 s.send('typed live\n');await s.until('echo:typed live');
 s.send('\x03');await s.until('interrupted');
 s.send('exit\n');assert.match(await s.end(),/\[exit 0\]/);
});

test('interactive framed input preserves bytes and changes PTY dimensions',async()=>{
 const s=await interactive({timeout_seconds:15},true);
 await s.until('PTY ready:24x80');
 s.frame({type:'resize',rows:40,cols:120});await s.until('resize:40x120');
 s.frame({type:'input',data:Buffer.from('🐈\x1b[A\n').toString('base64')});await s.until('echo:🐈\x1b[A');
 s.frame({type:'input',data:Buffer.from('exit\n').toString('base64')});assert.match(await s.end(),/\[exit 0\]/);
});

test('interactive validates credentials and terminal dimensions',async()=>{
 for(const overrides of [{rows:0},{cols:1001},{timeout_seconds:3601},{shell:true},{term:'bad\nterm'}]){
  const {command,...req}=body(overrides);
  const r=await mf.dispatchFetch('http://localhost/api/shell',{method:'POST',headers:{'Content-Type':'application/x-tailcat-shell'},body:JSON.stringify(req)+'\n'});
  assert.equal(r.status,400);
 }
 const s=await interactive({host_key_sha256:'SHA256:'+'A'.repeat(43)});
 assert.match(await s.end(),/host_key_mismatch/);
});

test('interactive rejects malformed frames and releases the isolate',async()=>{
 const s=await interactive({timeout_seconds:10},true);await s.until('PTY ready');
 s.frame({type:'resize',rows:-1,cols:80});assert.match(await s.end(),/ssh_execution_failed/);
 assert.equal((await exec()).events.find(e=>e.type==='exit')?.code,7);
});

test('interactive deadline and disconnect both release the isolate',async()=>{
 const s=await interactive({timeout_seconds:2});await s.until('PTY ready');assert.match(await s.end(),/timeout/);
 const s2=await interactive({timeout_seconds:15});await s2.until('PTY ready');await s2.reader.cancel();
 let next;
 for(let i=0;i<20;i++){next=await exec();if(next.status!==503)break;await new Promise(r=>setTimeout(r,50))}
 assert.equal(next.events.find(e=>e.type==='exit')?.code,7);
});

async function wsShell(overrides={}, autoAck=true) {
 const response=await mf.dispatchFetch('http://localhost/api/shell',{headers:{Upgrade:'websocket'}});
 assert.equal(response.status,101);
 const ws=response.webSocket;ws.accept();
 const events=[];let output='';let closed=false, unacked=0;
 ws.addEventListener('message',e=>{
  for(const line of e.data.trim().split('\n')) {
   const event=JSON.parse(line);events.push(event);
   if(['stdout','stderr'].includes(event.type))output+=Buffer.from(event.data,'base64').toString();
  }
  unacked+=Buffer.byteLength(e.data);
  if(autoAck){try {ws.send(JSON.stringify({type:'ack',bytes:unacked}));unacked=0}catch{}}
 });
 ws.addEventListener('close',()=>closed=true);
 const {command,...req}=body(overrides);ws.send(JSON.stringify(req));
 return {ws,events,ack(){autoAck=true;if(unacked){ws.send(JSON.stringify({type:'ack',bytes:unacked}));unacked=0}},get output(){return output},send(s){ws.send(JSON.stringify({type:'input',data:Buffer.from(s).toString('base64')}))},
 async until(predicate){const deadline=Date.now()+10000;while(!predicate()){if(closed||Date.now()>deadline)throw new Error('WebSocket ended/timed out: '+JSON.stringify(events));await new Promise(r=>setTimeout(r,10))}},
 async close(){ws.close();await new Promise(r=>setTimeout(r,50))}
 };
}

test('WebSocket PTY streams output, accepts keystrokes and resizes',async()=>{
 const s=await wsShell({rows:35,cols:110,timeout_seconds:15});
 await s.until(()=>s.output.includes('PTY ready:35x110'));
 s.send('hello socket\n');await s.until(()=>s.output.includes('echo:hello socket'));
 s.ws.send(JSON.stringify({type:'resize',rows:45,cols:120}));await s.until(()=>s.output.includes('resize:45x120'));
 s.send('\x03');await s.until(()=>s.output.includes('interrupted'));
 s.send('exit\n');await s.until(()=>s.events.some(e=>e.type==='exit'));
 assert.equal(s.events.find(e=>e.type==='exit').code,0);
});

test('WebSocket rejects cross-origin requests and wrong SSH credentials',async()=>{
 assert.equal((await mf.dispatchFetch('http://localhost/api/shell',{headers:{Upgrade:'websocket',Origin:'https://untrusted.example'}})).status,403);
 const s=await wsShell({private_key:credentials.wrong_private_key});await s.until(()=>s.events.some(e=>e.type==='error'));
 assert.equal(s.events.find(e=>e.type==='error').code,'ssh_handshake_failed');
});

test('WebSocket disconnect cancels SSH and frees the isolate',async()=>{
 const s=await wsShell();await s.until(()=>s.output.includes('PTY ready'));await s.close();
 const next=await exec();assert.equal(next.events.find(e=>e.type==='exit')?.code,7,next.text);
});


test('WebSocket output pauses at its credit window and resumes after acknowledgement',async()=>{
 const s=await wsShell({timeout_seconds:15},false);
 await s.until(()=>s.output.includes('PTY ready'));
 s.send('flood\n');await s.until(()=>s.output.length>32768);
 await new Promise(r=>setTimeout(r,100));
 assert.ok(s.output.length<262144,'Output must be bounded until acknowledged');
 assert.ok(!s.output.includes('FLOW_DONE'));
 s.ack();await s.until(()=>s.output.includes('FLOW_DONE'));
 s.send('exit\n');await s.until(()=>s.events.some(e=>e.type==='exit'));
 assert.equal(s.events.find(e=>e.type==='exit').code,0);
});

test('invalid WebSocket acknowledgement closes the connection and cancels SSH',async()=>{
 const s=await wsShell({timeout_seconds:15});await s.until(()=>s.output.includes('PTY ready'));
 s.ws.send(JSON.stringify({type:'ack',bytes:999999}));
 await new Promise(r=>setTimeout(r,100));
 assert.equal((await exec()).events.find(e=>e.type==='exit')?.code,7);
});

test('generic TCP: HTTP response and request half-close',async()=>{
 const t=await tcp(80);const result=collect(t);
 await t.write(Buffer.from('GET /hello HTTP/1.1\r\nHost: fixture\r\nConnection: close\r\n\r\n'));t.end();
 assert.match((await result).toString(),/HTTP through generic TCP/);await t.closed;await settled();
});

test('generic TCP: arbitrary binary data over 16 MiB with bounded flow control',async()=>{
 const t=await tcp(7001,{timeout:60});const expected=createHash('sha256'),actual=createHash('sha256');
 let received=0;const read=(async()=>{for await(const b of t){actual.update(b);received+=b.length}})();
 const chunk=randomBytes(65536);const count=273;
 for(let i=0;i<count;i++){expected.update(chunk);await t.write(chunk)}t.end();
 await read;await t.closed;
 assert.equal(received,count*chunk.length);assert.equal(actual.digest('hex'),expected.digest('hex'));await settled();
});

test('generic TCP: remote responds only after client FIN',async()=>{
 const t=await tcp(7002);const payload=randomBytes(170003),result=collect(t);
 await t.write(payload);t.end();assert.equal((await result).toString(),createHash('sha256').update(payload).digest('hex'));await t.closed;await settled();
});

test('generic TCP: remote FIN still allows client writes',async()=>{
 const t=await tcp(7003);
 assert.equal((await collect(t)).toString(),'server-fin\n');
 const payload=randomBytes(50003);await t.write(payload);t.end();await t.closed;
 await eventually(async()=> (await(await fetch(credentials.stats_url)).json()).half_close_bytes===payload.length);await settled();
});

test('generic TCP: validates version, port, fields, origin and deadline',async()=>{
 assert.equal((await mf.dispatchFetch('http://localhost/v1/transport')).status,405);
 assert.equal((await mf.dispatchFetch('http://localhost/v1/transport',{headers:{Upgrade:'websocket',Origin:'https://wrong.example'}})).status,403);
 for(const patch of [{version:2},{target:{type:'tailcat',address:credentials.tailcat_address,port:65536}},{private_key:'SHOULD_NOT_BE_ACCEPTED'},{timeout_seconds:3601}]){
  const r=await mf.dispatchFetch('http://localhost/v1/transport',{headers:{Upgrade:'websocket'}});const ws=r.webSocket;ws.accept();const events=[];
  ws.addEventListener('message',e=>events.push(JSON.parse(e.data)));
  ws.send(JSON.stringify({type:'open',version:1,target:{type:'tailcat',address:credentials.tailcat_address,port:80},...patch}));
  await eventually(()=>events.some(x=>x.type==='error'));assert.equal(events.find(x=>x.type==='error').code,'protocol_error');ws.close();
 }
 const t=await tcp(7005,{timeout:2});await assert.rejects(t.closed,/timeout/);await settled();
 const next=await tcp(80);next.close();await settled();
});

test('generic TCP: busy connection is rejected and reset releases runtime',async()=>{
 const first=await tcp(7005);
 await assert.rejects(tcp(7005),e=>e.code==='busy');first.close();await settled();
 const next=await tcp(7005);next.close();await settled();
});

test('generic TCP: no output beyond receive window until credit; forged credit rejected',async()=>{
 const r=await mf.dispatchFetch('http://localhost/v1/transport',{headers:{Upgrade:'websocket'}});const ws=r.webSocket;ws.binaryType='arraybuffer';ws.accept();let count=0;const events=[];
 ws.addEventListener('message',e=>{if(typeof e.data==='string')events.push(JSON.parse(e.data));else count+=e.data.byteLength});
 ws.send(JSON.stringify({type:'open',version:1,target:{type:'tailcat',address:credentials.tailcat_address,port:7004},timeout_seconds:15}));
 await eventually(()=>count===65536);await new Promise(r=>setTimeout(r,250));assert.equal(count,65536);
 ws.send(JSON.stringify({type:'window_update',bytes:16384}));await eventually(()=>count>65536);await new Promise(r=>setTimeout(r,100));assert.ok(count<=81920);
 ws.send(JSON.stringify({type:'window_update',bytes:65537}));await eventually(()=>events.some(x=>x.type==='error'));
 assert.equal(events.find(x=>x.type==='error').code,'protocol_error');ws.close();await settled();
 const t=await tcp(80);t.close();await settled();
});

test('generic adapter: native OpenSSH authenticates locally and retains host verification',async()=>{
 const dir=root+'test/.tmp/';const key=dir+'transport-key',known=dir+'transport-known-hosts';
 writeFileSync(key,credentials.private_key,{mode:0o600});writeFileSync(known,'tailcat-fixture '+credentials.host_key_public,{mode:0o600});
 const proxy=`node ${root}../client/transport.mjs stdio --port 22 --allow-local --url ${await mf.ready}`;
 const args=['-F','/dev/null','-o','BatchMode=yes','-o','ConnectTimeout=15','-o','IdentitiesOnly=yes','-o','StrictHostKeyChecking=yes','-o','UserKnownHostsFile='+known,'-o','HostKeyAlias=tailcat-fixture','-o','ProxyCommand='+proxy,'-i',key,'test-user@tailcat-fixture','probe'];
 try{
  const result=await childResult(spawn('ssh',args,{env:{...process.env,TAILCAT_ADDR:credentials.tailcat_address},stdio:['ignore','pipe','pipe']}));
  assert.equal(result.code,7,result.err);assert.equal(result.out,'hello from SSH through Tailcat\n');assert.match(result.err,/stderr is separate/);await settled();
  const bad=args.map(x=>x==='HostKeyAlias=tailcat-fixture'?'HostKeyAlias=wrong-host':x);
  const rejected=await childResult(spawn('ssh',bad,{env:{...process.env,TAILCAT_ADDR:credentials.tailcat_address},stdio:['ignore','pipe','pipe']}));
  assert.equal(rejected.code,255);assert.match(rejected.err,/Host key verification failed/);await settled();
 }finally{rmSync(key,{force:true});rmSync(known,{force:true})}
});

test('generic adapter: local TCP port serves a normal HTTP client',async()=>{
 const forward=spawn(process.execPath,[root+'../client/transport.mjs','forward','--listen','127.0.0.1:0','--port','80','--allow-local','--url',String(await mf.ready)],{env:{...process.env,TAILCAT_ADDR:credentials.tailcat_address},stdio:['ignore','pipe','pipe']});
 let log='';forward.stderr.on('data',b=>log+=b);
 try{
  await eventually(()=>log.includes('Listening on'));
  const port=/Listening on 127\.0\.0\.1:(\d+)/.exec(log)[1];
  const r=await childResult(spawn('curl',['--silent','--show-error','--max-time','15',`http://127.0.0.1:${port}/hello`],{stdio:['ignore','pipe','pipe']}));
  assert.equal(r.code,0,r.err+' '+log);assert.equal(r.out,'HTTP through generic TCP\n');
 }finally{forward.kill();await settled()}
});

test('runtime admission stays reserved during an idle connection beyond the lease interval',async()=>{
 const first=await tcp(7005,{timeout:25});
 try{
  await new Promise(r=>setTimeout(r,16000));
  await assert.rejects(tcp(7005),e=>e.code==='busy');
 }finally{first.close();await settled()}
 const next=await tcp(7005);next.close();await settled();
}, {timeout:30000});
