// Local workerd comparison; process CPU is not Cloudflare's billed CPU time.
// Build first. An optional saved bundle/client lets the same workload test a baseline.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdirSync, readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
const root=fileURLToPath(new URL('../worker/',import.meta.url));
const dir=resolve(process.argv[2] || root+'.wrangler/build')+'/';
const client=resolve(process.argv[3] || root+'../client/transport-client.mjs');
const count=Number(process.env.BENCH_ROUNDS || 12);
const {openTcp}=await import(pathToFileURL(client));
const NativeWebSocket=globalThis.WebSocket;let recording;
globalThis.WebSocket=class extends NativeWebSocket {
 constructor(...args){super(...args);this.stats=recording;this.addEventListener('message',e=>{
  if(!this.stats)return;
  if(typeof e.data==='string'){if(JSON.parse(e.data).type==='window_update')this.stats.upload_acks++;}
  else this.stats.output_frames++;
 });}
 send(data){if(this.stats&&typeof data==='string'&&JSON.parse(data).type==='window_update')this.stats.download_acks++;super.send(data);}
};
mkdirSync(root+'test/.tmp',{recursive:true});
execFileSync('go',['build','-o','test/.tmp/fixture','./test/fixture'],{cwd:root,env:{...process.env,GOTOOLCHAIN:'go1.27.1'},stdio:'pipe'});
const fixture=spawn(root+'test/.tmp/fixture',[],{env:{...process.env,TS_DEBUG_USE_DERP_HTTP:'true'},stdio:['ignore','pipe','ignore']});
const lines=createInterface({input:fixture.stdout});let mf;
const pause=()=>new Promise(r=>setTimeout(r,30));
const median=a=>[...a].sort((x,y)=>x-y)[Math.floor(a.length/2)];
function cpu(pid){const t=execFileSync('ps',['-p',String(pid),'-o','time='],{encoding:'utf8'}).trim();return t.split(':').reverse().reduce((n,v,i)=>n+Number(v)*60**i,0)*1000;}
try {
 const credentials=await new Promise((resolve,reject)=>{lines.once('line',s=>resolve(JSON.parse(s)));fixture.once('exit',()=>reject(Error('Fixture exited')))});
 mf=new Miniflare(convertV4MiniflareOptions({modules:[{type:'ESModule',path:dir+'index.js'},...readdirSync(dir).filter(f=>f.endsWith('.wasm')).map(f=>({type:'CompiledWasm',path:dir+f}))],modulesRoot:dir,compatibilityDate:'2026-09-16',bindings:{DERP_MAP_URL:credentials.map_url,TEST_DERP_HTTP:'1'}}));
 const url=String(await mf.ready);
 const processes=execFileSync('ps',['-axo','pid=,ppid=,comm='],{encoding:'utf8'}).trim().split('\n').map(l=>l.trim().split(/\s+/));
 const worker=processes.find(([pid,ppid,...name])=>Number(ppid)===process.pid&&name.join(' ').includes('workerd'));
 assert.ok(worker,'workerd child PID not found');const pid=Number(worker[0]);
 async function transfer(mode){
  recording={output_frames:0,upload_acks:0,download_acks:0};const stats=recording;
  const started=performance.now(),t=await openTcp({url,address:credentials.tailcat_address,port:mode==='http'?80:7001,timeout:30,allowLocal:true});
  const payload=mode==='http'?Buffer.from('GET /hello HTTP/1.1\r\nHost: fixture\r\nConnection: close\r\n\r\n'):randomBytes(262144);
  const read=(async()=>{const chunks=[];for await(const b of t)chunks.push(b);return Buffer.concat(chunks)})();
  await t.write(payload);t.end();const data=await read;await t.closed;
  if(mode==='http')assert.match(data.toString(),/HTTP through generic TCP/);else assert.deepEqual(data,payload);
  stats.wall_ms=performance.now()-started;recording=null;await pause();return stats;
 }
 for(let i=0;i<3;i++)await transfer('http');for(let i=0;i<3;i++)await transfer('echo');
 const report={rounds:count,cpu_measurement:'local workerd process CPU, including all runtime threads; not production CPU',results:{}};
 for(const mode of ['http','echo']){
  const rows=[],startCPU=cpu(pid);
  for(let i=0;i<count;i++)rows.push(await transfer(mode));
  const total=cpu(pid)-startCPU;
  report.results[mode]={cpu_total_ms:Math.round(total),cpu_mean_ms:total/count,median_wall_ms:median(rows.map(r=>r.wall_ms)),median_output_frames:median(rows.map(r=>r.output_frames)),median_upload_acks:median(rows.map(r=>r.upload_acks)),median_download_acks:median(rows.map(r=>r.download_acks))};
 }
 recording=null;
 const t=await openTcp({url,address:credentials.tailcat_address,port:7001,timeout:30,allowLocal:true});
 const iterator=t[Symbol.asyncIterator](),rtts=[];
 for(let i=0;i<100;i++){const start=performance.now();await t.write(Uint8Array.of(i));const {value}=await iterator.next();assert.deepEqual([...value],[i]);rtts.push(performance.now()-start);}
 t.end();assert.equal((await iterator.next()).done,true);await t.closed;
 report.results.one_byte_roundtrip={count:100,median_ms:median(rtts),p95_ms:[...rtts].sort((a,b)=>a-b)[94]};
 console.log(JSON.stringify(report,null,2));
}finally {globalThis.WebSocket=NativeWebSocket;await mf?.dispose();fixture.kill();lines.close();}
