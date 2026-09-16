// Public-relay tests using fresh fixture credentials, never the operator's keys.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { openTcp } from '../client/transport-client.mjs';
const url=process.argv[2]||'https://tailcat-ssh-worker.iamwrm.workers.dev';
const root=fileURLToPath(new URL('../worker/',import.meta.url));
mkdirSync(root+'test/.tmp',{recursive:true});
execFileSync('go',['build','-o','test/.tmp/fixture','./test/fixture'],{cwd:root,env:{...process.env,GOTOOLCHAIN:'go1.27.1'},stdio:'pipe'});
const fixture=spawn(root+'test/.tmp/fixture',[],{env:{...process.env,PUBLIC_DERP:'1',TS_DEBUG_USE_DERP_HTTP:'false'},stdio:['ignore','pipe','ignore']});
const lines=createInterface({input:fixture.stdout});
const report={url,verified_at:new Date().toISOString(),checks:{}};
const sessions=[];
const pause=()=>new Promise(r=>setTimeout(r,250));
const key=root+'test/.tmp/live-transport-key',known=root+'test/.tmp/live-transport-known';
function collect(t){const result=(async()=>{const chunks=[];for await(const b of t)chunks.push(b);return Buffer.concat(chunks)})();result.catch(()=>{});return result}
try {
 const credentials=await Promise.race([
  new Promise((resolve,reject)=>{lines.once('line',line=>resolve(JSON.parse(line)));fixture.once('exit',()=>reject(new Error('Fixture exited')))}),
  new Promise((_,reject)=>{const timer=setTimeout(()=>reject(new Error('Relay setup timeout')),45000);timer.unref()}),
 ]);
 const open=async port=>{const t=await openTcp({url,address:credentials.tailcat_address,port,timeout:120});sessions.push(t);return t};
 {
  console.error('Testing deployed HTTP');const t=await open(80),response=collect(t);
  await t.write(Buffer.from('GET /hello HTTP/1.1\r\nHost: fixture\r\nConnection: close\r\n\r\n'));t.end();
  assert.match((await response).toString(),/HTTP through generic TCP/);await t.closed;report.checks.http=true;await pause();
 }
 {
  console.error('Testing deployed client FIN');const t=await open(7002),response=collect(t),payload=randomBytes(200003);
  await t.write(payload);t.end();assert.equal((await response).toString(),createHash('sha256').update(payload).digest('hex'));await t.closed;
  report.checks.client_half_close=true;await pause();
 }
 {
  console.error('Testing deployed server FIN');const t=await open(7003);assert.equal((await collect(t)).toString(),'server-fin\n');
  await t.write(randomBytes(50003));t.end();await t.closed;
  const stats=await(await fetch(credentials.stats_url)).json();assert.equal(stats.half_close_bytes,50003);
  report.checks.server_half_close=true;await pause();
 }
 {
  console.error('Testing deployed native SSH');writeFileSync(key,credentials.private_key,{mode:0o600});writeFileSync(known,'tailcat-fixture '+credentials.host_key_public,{mode:0o600});
  const proxy=`node ${root}../client/transport.mjs stdio --port 22 --url ${url}`;
  const child=spawn('ssh',['-F','/dev/null','-o','BatchMode=yes','-o','ConnectTimeout=20','-o','IdentitiesOnly=yes','-o','StrictHostKeyChecking=yes','-o','UserKnownHostsFile='+known,'-o','HostKeyAlias=tailcat-fixture','-o','ProxyCommand='+proxy,'-i',key,'test-user@tailcat-fixture','probe'],{env:{...process.env,TAILCAT_ADDR:credentials.tailcat_address},stdio:['ignore','pipe','pipe']});
  let out='',err='';child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);
  const code=await new Promise(resolve=>child.on('close',resolve));assert.equal(code,7,err);assert.equal(out,'hello from SSH through Tailcat\n');assert.match(err,/stderr is separate/);
  report.checks.native_ssh={exit_code:code,host_key_verified:true,ssh_private_key_local:true};await pause();
 }
 {
  console.error('Testing deployed binary echo');const started=Date.now(),t=await open(7001),expected=createHash('sha256'),actual=createHash('sha256');let bytes=0;
  const read=(async()=>{for await(const b of t){actual.update(b);bytes+=b.length}})();
  read.catch(()=>{});
  const chunk=randomBytes(65536),count=Number(process.env.BINARY_CHUNKS||4);
  for(let i=0;i<count;i++){expected.update(chunk);await t.write(chunk)}t.end();await read;await t.closed;
  assert.equal(bytes,chunk.length*count);assert.equal(actual.digest('hex'),expected.digest('hex'));
  report.checks.binary_echo={bytes,sha256_matches:true,elapsed_ms:Date.now()-started};await pause();
 }
 report.complete=true;console.log(JSON.stringify(report,null,2));
} catch(e) {report.complete=false;report.error=e.message;console.log(JSON.stringify(report,null,2));throw e;} finally {
 for(const t of sessions)t.close();fixture.kill();lines.close();rmSync(key,{force:true});rmSync(known,{force:true});
}
