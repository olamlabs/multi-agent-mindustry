import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdtempSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {gzipSync} from 'node:zlib';
import {grade} from '../../environment/sim/grade.mjs';
import {validateReplay} from '../../environment/sim/replay-integrity.mjs';
import {serveApi} from '../../environment/sim/http.mjs';
import {startApp} from './app-process.mjs';
const evidence=JSON.parse(readFileSync(new URL('./fixtures/series-evidence.json',import.meta.url)));
const copy=()=>structuredClone(evidence);
test('PvP evidence fixture passes, contradictory and missing evidence fails closed',()=>{
 assert.equal(grade(copy()).reward.completed,1);
 const mutations=[
  e=>e.result={},e=>e.result.started=false,e=>e.result.results[0].reason='stopped',
  e=>e.result.results[0].elapsed_seconds=-10,e=>e.result.results[0].elapsed_seconds=1,
  e=>e.result.results[0].elapsed_seconds=1000,e=>e.result.results[0].winning_team='invented',
  e=>Object.assign(e.result.results[0],{reason:'game_over',winning_team:'sharded',survival_censored:false}),
  e=>e.setup.engine.cores.pop(),
  e=>e.setup.engine.cores[0].health=-1,
  e=>delete e.result.results[0].core_health_by_team.crux,
  e=>e.result.results[0].core_health_by_team.green={health:100,max_health:100},
  e=>delete e.result.results[0].reason,e=>delete e.result.results[0].core_health_by_team,
  e=>e.result.results[0].core_health_by_team.sharded.health=999999,
  e=>Object.assign(e.result.results[0],{reason:'core_destroyed',winning_team:'crux',survival_censored:false}),
  e=>e.result.results[0].seat_teams['seat-2']='sharded',e=>e.setup.engine.game_mode='survival',
  e=>e.expected={seats:['seat-1'],settings:e.setup.settings},
  e=>e.expected={seats:e.setup.seats,settings:{...e.setup.settings,games:3}},
  e=>e.setup.engine.seed=2,e=>delete e.setup.engine.seed,
 ];
 for(const mutate of mutations){const e=copy();mutate(e);assert.throws(()=>grade(e),undefined,mutate.toString());}
 const victory=copy();Object.assign(victory.result.results[0],{reason:'core_destroyed',winning_team:'crux',survival_censored:false});victory.result.results[0].core_health_by_team.sharded.health=0;
 assert.equal(grade(victory).reward['seat-1'],0,'legitimate opponent victory remains valid');
 for(const seed of [0,1,2147483647]){
  const e=copy();e.setup.settings.seed=seed;e.setup.engine.seed=seed;
  assert.equal(grade(e).reward.completed,1);
 }
});
test('failed standalone regrade removes prior reward and summary',t=>{
 const dir=mkdtempSync(join(tmpdir(),'series-regrade-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const run=()=>spawnSync(process.execPath,[fileURLToPath(new URL('../../environment/sim/verify.mjs',import.meta.url)),dir,join(dir,'reward.json')]);
 for(const [name,data] of Object.entries(copy()))writeFileSync(join(dir,name+'.json'),JSON.stringify(data));
 assert.equal(run().status,0);
 writeFileSync(join(dir,'result.json'),'{malformed');assert.notEqual(run().status,0);
 for(const name of ['reward.json','series.json'])assert.equal(existsSync(join(dir,name)),false);
});
test('the verifier binds configured and native maps while retaining case-insensitive name and file aliases',t=>{
 assert.equal(grade(copy()).reward.completed,1);
 for(const requested of ['Display Name','display name','map-file','MAP-FILE']){
  const e=copy();e.setup.settings.map=requested;e.setup.engine.map='Display Name';e.setup.engine.map_file='map-file';
  e.expected={seats:e.setup.seats,settings:{...e.setup.settings}};
  assert.equal(grade(e).reward.completed,1,requested);
 }
 for(const mutate of [
  e=>{e.setup.engine.map='Harbor Ring';e.setup.engine.map_file=null;},
  e=>delete e.setup.engine.map,
  e=>{e.setup.settings.map='Harbor Ring';},
  e=>{e.expected={seats:e.setup.seats,settings:{...e.setup.settings,map:'Harbor Ring'}};},
 ]){const e=copy();mutate(e);assert.throws(()=>grade(e),/map/,mutate.toString());}
 const dir=mkdtempSync(join(tmpdir(),'series-map-contract-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const e=copy();e.setup.settings.map='Glacier';
 for(const [name,data] of Object.entries(e))writeFileSync(join(dir,name+'.json'),JSON.stringify(data));
 writeFileSync(join(dir,'reward.json'),'{}');writeFileSync(join(dir,'series.json'),'{}');
 const result=spawnSync(process.execPath,[fileURLToPath(new URL('../../environment/sim/verify.mjs',import.meta.url)),dir,join(dir,'reward.json')],{
  env:{...process.env,HARBOR_SEATS:JSON.stringify(e.setup.seats),HARBOR_SIM_SETTINGS:JSON.stringify({...e.setup.settings,map:'Harbor Ring'})},encoding:'utf8'});
 assert.notEqual(result.status,0);assert.match(result.stderr,/map differs from task contract/);
 for(const name of ['reward.json','series.json'])assert.equal(existsSync(join(dir,name)),false);
});
test('replay integrity receipt requires a finalized, untruncated stream',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'series-replay-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const header=Buffer.from(JSON.stringify({segment:0})),length=Buffer.alloc(4);length.writeUInt32BE(header.length);
 const bytes=Buffer.concat([Buffer.from('MREPLAY1'),length,header,gzipSync(Buffer.from([2,0,0,0,0,0,0,0,0,0,0,0,1,42]))]);
 writeFileSync(join(dir,'segment-000.mreplay'),bytes);writeFileSync(join(dir,'stats.json'),JSON.stringify({closed:true,complete:true,segments:1}));
 assert.equal((await validateReplay(dir)).segments[0].sha256.length,64);
 for(const payload of [Buffer.from('records'),Buffer.from([2,0]),Buffer.from([2,0,0,0,0,0,0,0,0,0,0,0,3,42])]){
  writeFileSync(join(dir,'segment-000.mreplay'),Buffer.concat([bytes.subarray(0,12+header.length),gzipSync(payload)]));
  await assert.rejects(validateReplay(dir),/record/);
  assert.equal(existsSync(join(dir,'manifest.json')),false,'failed validation removes stale receipt');
 }
 writeFileSync(join(dir,'segment-000.mreplay'),bytes.subarray(0,-4));await assert.rejects(validateReplay(dir));
 writeFileSync(join(dir,'stats.json'),JSON.stringify({closed:false,complete:true,segments:1}));await assert.rejects(validateReplay(dir),/did not close/);
});
test('all agents must arrive before game one starts; one seat cannot impersonate the others',async t=>{
 const app=await startApp({main:fileURLToPath(new URL('./fixtures/fake-match.mjs',import.meta.url)),seats:['seat-1','seat-2'],settings:{games:1,chat_after_sec:0,video:{record:false},replay:{record:false}}});t.after(()=>app.stop());
 await app.until(()=>app.healthy());
 for(let i=0;i<3;i++)assert.equal((await app.seat('seat-1').get('/update')).status.phase,'waiting');
 await new Promise(r=>setTimeout(r,1000));assert.equal((await app.seat('seat-1').get('/update')).status.t,0);
 await app.seat('seat-2').get('/brief');await app.until(async()=>(await app.seat('seat-1').get('/update')).status.phase==='running');
 assert.equal(app.log().filter(e=>e.type==='agent_ready').length,2);
});
test('HTTP accepts large bodies and concurrent requests without added capacity gates',async t=>{
 const held=[];
 const server=await serveApi({port:0,tokens:{one:'secret'},routes:{'POST /probe':({body})=>({length:body.text.length}),'GET /held':()=>new Promise(r=>held.push(r))}});
 t.after(()=>{held.forEach(r=>r({}));server.closeAllConnections();server.close();});
 const url=`http://127.0.0.1:${server.address().port}`,headers={authorization:'Bearer secret'};
 const text='x'.repeat(1024*1024+1);
 const reply=await fetch(url+'/probe',{method:'POST',headers,body:JSON.stringify({text})});
 assert.equal(reply.status,200);assert.equal((await reply.json()).length,text.length);
 const pending=Array.from({length:8},()=>fetch(url+'/held',{headers}));
 const deadline=Date.now()+4000;
 while(held.length<8&&Date.now()<deadline)await new Promise(r=>setTimeout(r,10));
 assert.equal(held.length,8);
 held.forEach(r=>r({}));assert.ok((await Promise.all(pending)).every(r=>r.status===200));
 assert.equal(server.requestTimeout,0);assert.equal(server.headersTimeout,0);assert.equal(server.maxConnections,undefined);
});
test('the full configured roster can each wait without exhausting global admission',async t=>{
 const tokens=Object.fromEntries(Array.from({length:200},(_,i)=>['seat-'+(i+1),'token-'+i]));
 const held=[];
 const server=await serveApi({port:0,tokens,routes:{'GET /held':()=>new Promise(r=>held.push(r))}});
 t.after(()=>{held.forEach(r=>r({}));server.closeAllConnections();server.close();});
 const url=`http://127.0.0.1:${server.address().port}/held`;
 const requests=[];
 for(const token of Object.values(tokens)){
  const request=fetch(url,{headers:{authorization:'Bearer '+token}});request.catch(()=>{});requests.push(request);
  await new Promise(r=>setImmediate(r));
 }
 const deadline=Date.now()+4000;
 while(held.length<200&&Date.now()<deadline)await new Promise(r=>setTimeout(r,10));
 assert.equal(held.length,200);
 held.forEach(r=>r({}));assert.ok((await Promise.all(requests)).every(r=>r.status===200));
});
