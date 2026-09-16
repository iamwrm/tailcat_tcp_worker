// Uses generated test keys and fixed commands. Never uses the operator's SSH keys.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const url = process.argv[2];
if (!url?.startsWith('https://')) throw new Error('Usage: node scripts/live-smoke.mjs https://your-worker.workers.dev');
const root=fileURLToPath(new URL('../worker/',import.meta.url));
mkdirSync(root+'test/.tmp',{recursive:true});
execFileSync('go',['build','-o','test/.tmp/fixture','./test/fixture'],{cwd:root,env:{...process.env,GOTOOLCHAIN:'go1.27.1'},stdio:'pipe'});
const child=spawn(root+'test/.tmp/fixture',[],{cwd:root,env:{...process.env,PUBLIC_DERP:'1',TS_DEBUG_USE_DERP_HTTP:'false'},stdio:['ignore','pipe','pipe']});
child.stderr.on('data',()=>{});
const lines=createInterface({input:child.stdout});
try {
 const credential=await Promise.race([
  new Promise((resolve,reject)=>{lines.once('line',line=>resolve(JSON.parse(line)));child.once('exit',code=>reject(new Error('Fixture exited '+code)))}),
  new Promise((_,reject)=>{const t=setTimeout(()=>reject(new Error('Public relay setup timed out')),45000);t.unref()}),
 ]);
 const {host_key_public,wrong_private_key,map_url,stats_url,...request}=credential;
 const started=Date.now();
 // Real curl. Credentials go through stdin, never through argv or a file.
 const response=execFileSync('curl',['--silent','--show-error','--no-buffer','--max-time','45','-H','Content-Type: application/json','--data-binary','@-',url.replace(/\/$/,'')+'/api/exec'],{input:JSON.stringify(request),encoding:'utf8',maxBuffer:2*1024*1024});
 const events=response.trim().split('\n').map(x=>JSON.parse(x));
 const stdout=Buffer.concat(events.filter(e=>e.type==='stdout').map(e=>Buffer.from(e.data,'base64'))).toString();
 const stderr=Buffer.concat(events.filter(e=>e.type==='stderr').map(e=>Buffer.from(e.data,'base64'))).toString();
 assert.equal(stdout,'hello from SSH through Tailcat\n',response);
 assert.equal(stderr,'stderr is separate\n',response);
 assert.equal(events.find(e=>e.type==='exit')?.code,7,response);
 const rejected=await fetch(url.replace(/\/$/,'')+'/api/exec',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...request,private_key:wrong_private_key})});
 const rejection=await rejected.text();
 assert.ok(rejection.includes('ssh_handshake_failed'),rejection);
 console.log(JSON.stringify({url,verified_at:new Date().toISOString(),elapsed_ms:Date.now()-started,stdout,stderr,exit_code:7,wrong_key_rejected:true,wasm_memory_bytes:events.find(e=>e.type==='runtime')?.wasm_memory_bytes},null,2));
} finally {child.kill('SIGTERM');lines.close()}
