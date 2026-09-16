import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdirSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { connectSSH, runCommand } from '../../client/ssh-client.mjs';
import { copyFiles } from '../../client/sftp.mjs';
import { startSSHFixture } from '../../client/test/ssh-fixture.mjs';
import { PassThrough, Readable, Writable } from 'node:stream';
import * as fs from 'node:fs/promises';
import { openTcp } from '../../client/transport-client.mjs';
import { createHash, randomBytes } from 'node:crypto';
import { writeFileSync, rmSync } from 'node:fs';

const root = fileURLToPath(new URL('../',import.meta.url));
let mf, fixture, credentials, config, nodeFixture;
before(async()=>{
 mkdirSync(root+'test/.tmp',{recursive:true});
 nodeFixture=await startSSHFixture(root+'test/.tmp/');
 execFileSync('go',['build','-o','test/.tmp/fixture','./test/fixture'],{cwd:root,env:{...process.env,GOTOOLCHAIN:'go1.27.1'},stdio:'pipe'});
 fixture=spawn(root+'test/.tmp/fixture',[],{cwd:root,env:{...process.env,TS_DEBUG_USE_DERP_HTTP:'true',TEST_SFTP_PORT:String(nodeFixture.port)},stdio:['ignore','pipe','pipe']});
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
after(async()=>{await mf?.dispose();fixture?.kill('SIGTERM');await nodeFixture?.close()});

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

test('health advertises only the generic TCP protocol', async () => {
 const r = await mf.dispatchFetch('http://localhost/api/health');
 assert.equal(r.status, 200);
 assert.deepEqual((await r.json()).protocols, ['tcp-v1']);
});

test('removed managed SSH endpoints reject HTTP and WebSocket requests', async () => {
 for (const path of ['/api/exec', '/api/shell']) {
  for (const init of [{}, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({private_key:'not-accepted'})}, {headers:{Upgrade:'websocket'}}]) {
   const r = await mf.dispatchFetch('http://localhost'+path, init);
   assert.equal(r.status, 404, path);
   assert.deepEqual(await r.json(), {error:'Not found'});
  }
 }
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

async function nodeSSH(extra={}) {
 return connectSSH({url:String(await mf.ready),address:credentials.tailcat_address,port:22,allowLocal:true,timeout:30,username:credentials.username,privateKey:credentials.private_key,hostKey:credentials.host_key_sha256,...extra});
}
function sink(slow=false) { const chunks=[];return {chunks,stream:new Writable({highWaterMark:1024,write(b,e,cb){chunks.push(Buffer.from(b));if(slow)setTimeout(cb,2);else cb()}})} }

test('Node SSH executes without OpenSSH and returns separate streams and exit status',async()=>{
 const s=await nodeSSH();const out=sink(),err=sink();
 try { assert.equal(await runCommand(s,'probe',{input:null,output:out.stream,errorOutput:err.stream}),7);assert.equal(Buffer.concat(out.chunks).toString(),'hello from SSH through Tailcat\n');assert.equal(Buffer.concat(err.chunks).toString(),'stderr is separate\n'); }
 finally{s.close();await settled()}
});

test('Node SSH rejects wrong host fingerprints and authentication keys',async()=>{
 const before=await(await fetch(credentials.stats_url)).json();
 await assert.rejects(nodeSSH({hostKey:'SHA256:'+'A'.repeat(43)}),/host key mismatch/);await settled();
 await assert.rejects(nodeSSH({privateKey:credentials.wrong_private_key}),/authentication/i);await settled();
 assert.equal((await(await fetch(credentials.stats_url)).json()).executions,before.executions);
});

test('Node SSH preserves binary stdin/stdout under backpressure',async()=>{
 const s=await nodeSSH(),payload=randomBytes(300003),out=sink(true),err=sink();
 try{assert.equal(await runCommand(s,'cat',{input:Readable.from([payload]),output:out.stream,errorOutput:err.stream}),0);
  await new Promise(resolve=>out.stream.end(resolve));assert.deepEqual(Buffer.concat(out.chunks),payload);
 }finally{s.close();await settled()}
});

test('Node SSH library opens a PTY and resizes it',async()=>{
 const s=await nodeSSH(),input=new PassThrough(),out=sink(),err=sink();let channel;
 try{
  const running=runCommand(s,'',{input,output:out.stream,errorOutput:err.stream,shell:{term:'xterm-256color',rows:31,cols:91},onChannel:c=>{channel=c}});
  running.catch(()=>{});
  await eventually(()=>Buffer.concat(out.chunks).toString().includes('PTY ready:31x91'));
  channel.setWindow(42,112,0,0);await eventually(()=>Buffer.concat(out.chunks).toString().includes('resize:42x112'));
  input.write('\x03');await eventually(()=>Buffer.concat(out.chunks).toString().includes('interrupted'));
  input.end('exit\n');assert.equal(await running,0);
 }finally{s.close();await settled()}
});

test('Node host verification rejects the server before user authentication',async()=>{
 const before=nodeFixture.stats.authentications;
 await assert.rejects(nodeSSH({...nodeFixture,port:7006,hostKey:'SHA256:'+'A'.repeat(43)}),/host key mismatch/);
 assert.equal(nodeFixture.stats.authentications,before);await settled();
});

test('Node SFTP copies binary files and recursive trees using an encrypted key',async()=>{
 const s=await nodeSSH({...nodeFixture,port:7006});
 const dir=await fs.mkdtemp(root+'test/.tmp/copy-');
 try {
  const payload=randomBytes(200003);await fs.writeFile(dir+'/input file.bin',payload);
  assert.deepEqual(await copyFiles(s,'upload',dir+'/input file.bin','/remote file.bin'),{files:1,bytes:payload.length});
  assert.deepEqual(await fs.readFile(nodeFixture.directory+'/remote file.bin'),payload);
  assert.deepEqual(await copyFiles(s,'download','/remote file.bin',dir+'/out file.bin'),{files:1,bytes:payload.length});
  assert.deepEqual(await fs.readFile(dir+'/out file.bin'),payload);
  await fs.mkdir(dir+'/tree');await fs.mkdir(dir+'/tree/sub');await fs.writeFile(dir+'/tree/sub/🐈 file.txt','unicode content');
  await copyFiles(s,'upload',dir+'/tree','/tree',{recursive:true});await copyFiles(s,'download','/tree',dir+'/result',{recursive:true});
  assert.equal(await fs.readFile(dir+'/result/sub/🐈 file.txt','utf8'),'unicode content');
  await assert.rejects(copyFiles(s,'upload',dir+'/tree','/needs-recursive'),/recursive/);
  await fs.symlink('/outside-fixture',nodeFixture.directory+'/link');
  await assert.rejects(copyFiles(s,'download','/link',dir+'/link'),/Symbolic links/);
  await assert.rejects(copyFiles(s,'upload',dir+'/input file.bin','/remote file.bin'));
  assert.deepEqual(await fs.readFile(nodeFixture.directory+'/remote file.bin'),payload);
  assert.ok(!(await fs.readdir(nodeFixture.directory)).some(n=>n.endsWith('.part')));
 }finally{s.close();await fs.rm(dir,{recursive:true,force:true});await settled()}
});

test('Node exec and rsync remote-shell CLI run with no ssh executable on PATH',async()=>{
 const key=root+'test/.tmp/node-cli-key';writeFileSync(key,credentials.private_key,{mode:0o600});
 const env={...process.env,PATH:root+'test/.tmp/no-binaries',TAILCAT_ADDR:credentials.tailcat_address,SSH_USER:credentials.username,SSH_KEY:key,SSH_HOST_KEY:credentials.host_key_sha256};
 try{
  for(const mode of ['exec','rsh']){
   const args=[root+'../client/ssh.mjs',mode,'--url',String(await mf.ready),'--allow-local',...(mode==='rsh'?['-l',credentials.username,'fixture']:['--']),'probe'];
   const r=await childResult(spawn(process.execPath,args,{env,stdio:['pipe','pipe','pipe']}),'');
   assert.equal(r.code,7,r.err);assert.equal(r.out,'hello from SSH through Tailcat\n');assert.equal(r.err,'stderr is separate\n');await settled();
  }
 }finally{rmSync(key,{force:true})}
});
