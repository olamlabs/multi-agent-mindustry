import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import {execFileSync} from 'node:child_process';
import {existsSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {startApp} from './fixtures/app-process.mjs';

const main=fileURLToPath(new URL('./fixtures/fake-match.mjs',import.meta.url));
const verify=fileURLToPath(new URL('../../environment/sim/verify.mjs',import.meta.url));
const seats=['seat-1','seat-2','seat-3','seat-4'];
const settings={game_mode:'survival',time_limit_sec:null,seed:1,all_chat:false,video:{record:false,fps:5,width:960,height:540}};
const OVER={game_over:true,error:'The game is over. Its final result is at GET /update.'};

async function open(t,{overrides={},env={}}={}) {
  const app=await startApp({main,seats,settings:{...settings,...overrides},env});
  t.after(()=>app.stop());
  await app.until(()=>app.healthy(),{what:'health'});
  return app;
}
const phase=async app=>(await app.seat('seat-1').get('/update')).status.phase;
const playing=async app=>{for(const seat of seats)await app.seat(seat).post('/ready');return app.until(async()=>(await phase(app))==='running',{what:'the match clock'});};
const grade=app=>{const out=join(mkdtempSync(join(tmpdir(),'reward-')),'reward.json');execFileSync(process.execPath,[verify,app.logs,out]);return JSON.parse(readFileSync(out,'utf8'));};

test('seats play through the API, wake on a teammate message, and the match is graded once recorded',async t=>{
  const app=await open(t);
  const unauthorized=await app.request('/');
  assert.deepEqual([unauthorized.status,unauthorized.body.error],[401,'Send Authorization: Bearer <token from /run/mindustry/token>']);
  await playing(app);
  const index=await app.seat('seat-1').get('/');
  assert.deepEqual(index.endpoints.map(endpoint=>endpoint.path),['/update','/wait','/ready','/query','/events','/act','/say','/wake']);
  assert.equal((await app.seat('seat-1').request('/brief')).status,404);
  const view=await app.seat('seat-2').get('/update');
  assert.equal(view.game_over,false);
  assert.deepEqual(Object.keys(view.status),['phase','t','team','you','core','chat','readiness']);
  assert.deepEqual((await app.request('/health')).body,{ready:true,game_over:false},'health needs no token');

  const waking=app.seat('seat-2').post('/wait');
  const said=await app.seat('seat-1').post('/say',{text:'team hello'});
  assert.equal(said.message.from,'seat-1','the plugin hears the caller, not a claimed seat');
  assert.deepEqual((await waking).status.chat,{seq:1,t:(await waking).status.chat.t,from:'seat-1',to:[],text:'fixture',data:null});
  assert.equal(said.status.phase,'running','a tool reply carries the caller status');

  const read=await app.seat('seat-3').post('/query',{of:'units'});
  assert.deepEqual([read.rows[0].seat,read.status.you.unit_id],['seat-3',3]);
  const spoofed=await app.seat('seat-3').request('/query',{method:'POST',body:{of:'units',seat:'seat-1'}});
  assert.deepEqual([spoofed.status,spoofed.body.status.you.unit_id],[400,3],'a schema refusal carries the caller status');

  const malformed=await app.seat('seat-3').request('/query',{method:'POST',body:{of:'tanks'}});
  assert.deepEqual([malformed.status,malformed.body.error,malformed.body.status.phase],[400,'of: "tanks" is not one of collections, match, units','running']);
  const refused=await app.seat('seat-3').request('/events',{method:'POST',body:{cursor:'taken'}});
  assert.deepEqual([refused.status,refused.body.error,refused.body.status.phase],[409,'The reader "taken" already has another filter; use a different cursor name','running']);
  const unknown=await app.seat('seat-3').request('/look',{method:'POST',body:{}});
  assert.deepEqual([unknown.status,unknown.body.status.phase],[404,'running']);
  const method=await app.seat('seat-3').request('/wait');
  assert.deepEqual([method.status,method.body.error],[405,'/wait is POST, not GET']);
  assert.equal((await app.seat('seat-3').request('/act',{method:'POST',body:{ops:[]}})).status,400);

  assert.equal((await app.seat('seat-3').post('/wake',{})).path,'/wake');
  assert.equal((await app.seat('seat-3').post('/wake',{filters:[[['kind','eq','say']],[['kind','eq','unit_create'],['unit.team','eq','sharded']]]})).path,'/wake');
  for(const body of [{after:0,filter:[]},{filters:[[['kind','eq']]]},{filters:[['kind','eq','say']]},{filters:{}}])
    assert.equal((await app.seat('seat-3').request('/wake',{method:'POST',body})).status,400,JSON.stringify(body));
  assert.equal((await app.seat('seat-3').get('/update')).status.phase,'running');
  assert.deepEqual((await app.seat('seat-4').post('/act',{ops:[{op:'plan_clear'}]})).results,[{ok:true,effect:'plan_clear'}]);

  const ending=(async()=>{for(;;){const reply=await app.seat('seat-3').request('/wait',{method:'POST',body:{}});if(reply.status===410||reply.body.game_over)return reply.body;assert.ok(['running','ending'].includes(reply.body.status.phase));}})();
  await app.seat('seat-1').post('/say',{text:'end the match'});
  const result=JSON.parse(await app.until(()=>app.file('result.json'),{what:'result.json'}));
  assert.deepEqual([result.started,result.terminal.reason],[true,'core_destroyed']);
  assert.equal((await ending).game_over,true,'a waiting seat learns the game is over');
  const health=await app.request('/health');
  assert.deepEqual([health.status,health.body.game_over],[200,true],'health says the game is over, without a token');
  const late=await app.seat('seat-1').request('/act',{method:'POST',body:{ops:[{op:'plan_clear'}]}});
  const {status:final,...over}=late.body;
  assert.deepEqual([late.status,over],[410,OVER]);
  const retired=await app.seat('seat-1').request('/mcp',{method:'POST',body:{}});
  assert.deepEqual([retired.status,retired.body.game_over,retired.body.error],[410,true,OVER.error]);
  assert.deepEqual([final.phase,final.result.reason,'seat_teams' in final.result],['over','core_destroyed',false],'game over says how it ended');
  assert.equal(await phase(app),'over');
  const log=app.log();
  assert.deepEqual(log[0],{sequence:1,time:log[0].time,type:'roster',seats});
  for(const type of ['setup','started','say','act','video','game_ended']) assert.ok(log.some(entry=>entry.type===type&&typeof entry.summary==='string'),type);
  const reward=grade(app);
  assert.deepEqual(reward,{reward:1,...Object.fromEntries(seats.map(seat=>[seat,1]))});
});

test('wait rejects ignored arguments and its documented URL timeout actually expires',async t=>{
  const app=await open(t);
  await playing(app);
  for(const body of [{timeout_sec:0.05},{typo:true},[],null]) {
    const reply=await app.seat('seat-1').request('/wait',{method:'POST',body});
    assert.equal(reply.status,400,JSON.stringify(body));
    assert.match(reply.body.error,/empty JSON object.*URL/);
    assert.equal(reply.body.status.phase,'running');
  }
  for(const path of ['/wait?timeout=1','/wait?timeout_sec=','/wait?timeout_sec=NaN',
    '/wait?timeout_sec=Infinity','/wait?timeout_sec=1e308','/wait?timeout_sec=-1','/wait?timeout_sec=1&timeout_sec=2']) {
    const reply=await app.seat('seat-1').request(path,{method:'POST',body:{}});
    assert.equal(reply.status,400,path);
    assert.match(reply.body.error,/timeout_sec/);
  }
  const began=Date.now();
  const reply=await app.seat('seat-1').request('/wait?timeout_sec=0.05',{
    method:'POST',body:{},signal:AbortSignal.timeout(2000),
  });
  assert.equal(reply.status,200);
  assert.equal(reply.body.status.phase,'running');
  assert.ok(Date.now()-began>=35,'the deadline is not an immediate no-op');
  let completed=false;
  const long=app.seat('seat-1').request('/wait?timeout_sec=2147484',{
    method:'POST',body:{},signal:AbortSignal.timeout(2000),
  }).then(value=>{completed=true;return value;});
  await new Promise(resolve=>setTimeout(resolve,30));
  assert.equal(completed,false,'a long deadline does not overflow to an immediate timeout');
  await app.seat('seat-2').post('/say',{text:'wake the long wait'});
  assert.equal((await long).status,200);
});

test('an infrastructure error fails the match loudly; a stopped app finalizes its recordings and scores nothing',async t=>{
  const broken=await open(t);
  await playing(broken);
  const reply=await broken.seat('seat-1').request('/query',{method:'POST',body:{of:'broken'}});
  assert.deepEqual([reply.status,reply.body.status?.phase],[500,'failed'],'an infrastructure failure still carries the caller status');
  const result=JSON.parse(await broken.until(()=>broken.file('result.json'),{what:'result.json'}));
  assert.match(result.failure,/HTTP 500/);
  assert.throws(()=>grade(broken),/The match failed/);

  const stopped=await open(t);
  await playing(stopped);
  stopped.child.kill('SIGTERM');
  await stopped.until(()=>stopped.child.exitCode!=null,{what:'exit'});
  const types=stopped.log().map(entry=>entry.type);
  assert.ok(types.includes('video')&&types.indexOf('video')<types.indexOf('stopped'),'the recordings are finalized before the app exits');
  assert.throws(()=>grade(stopped),/unscored/);
});

test('settings the app cannot use never start',async()=>{
  for(const overrides of [{game_mode:'tag'},{lobby_sec:0},{all_chat:'yes'},{team_count:3,team_size:1},{team_sizes:[1,3]}])await assert.rejects(startApp({main,seats,settings:{...settings,...overrides}}).then(app=>app.stop()),/exited \(1\)/);
});

async function withSeatPorts(t) {
  const free=async()=>{const server=net.createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const {port}=server.address();await new Promise(resolve=>server.close(resolve));return port;};
  const control=await free(),tunnel=await free();
  const dir=mkdtempSync(join(tmpdir(),'mindustry-seat-ports-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const key='k'.repeat(64),keyFile=join(dir,'tunnel-key');writeFileSync(keyFile,key);
  const app=await startApp({main,seats,settings,env:{FAKE_SEAT_PORTS:'1',FAKE_CONTROL_PORT:String(control),FAKE_TUNNEL_PORT:String(tunnel),FAKE_TUNNEL_SECRET_FILE:keyFile}});
  t.after(()=>app.stop());
  const url=seat=>`http://127.0.0.1:${control}/seats/${seat}`,headers={'x-mindustry-key':key};
  const read=async seat=>{try{const reply=await fetch(url(seat),{headers});return reply.ok?await reply.json():null;}catch{return null;}};
  const report=async(seat,body)=>assert.equal((await fetch(url(seat),{method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify(body)})).status,200);
  const listen=async()=>{const listener=net.createServer(socket=>socket.destroy());await new Promise(resolve=>listener.listen(tunnel,'127.0.0.1',resolve));t.after(()=>listener.close());};
  return {app,read,report,listen};
}

test('health waits for both seat ports to listen, and the match waits for every seat\'s video client',async t=>{
  const {app,read,report,listen}=await withSeatPorts(t);

  await new Promise(resolve=>setTimeout(resolve,300));
  assert.equal(await app.healthy(),false,'not healthy while the game tunnel refuses connections');
  await listen();
  await app.until(()=>app.healthy(),{what:'health'});

  for(const seat of seats)assert.equal((await read(seat))?.phase,'connect',`${seat}'s first control request once healthy`);
  for(const seat of seats){
    assert.equal(await phase(app),'waiting','the match waits for every client');
    await report(seat,{status:'ready',metadata:{}});
  }
  for(const seat of seats)await app.seat(seat).post('/ready');
  for(const seat of seats){
    await app.until(async()=>(await read(seat))?.phase==='record',{what:`${seat} recording`});
    await report(seat,{status:'recording',metadata:{record:false}});
  }
  await playing(app);
});

test('a camera that fails mid-game fails nothing: the other cameras finalize, the match ends and is graded',async t=>{
  const {app,read,report,listen}=await withSeatPorts(t);
  await listen();
  await app.until(()=>app.healthy(),{what:'health'});
  for(const seat of seats)await report(seat,{status:'ready',metadata:{}});
  for(const seat of seats)await app.seat(seat).post('/ready');
  for(const seat of seats){
    await app.until(async()=>(await read(seat))?.phase==='record',{what:`${seat} recording`});
    await report(seat,{status:'recording',metadata:{record:false}});
  }
  await playing(app);
  await report('seat-2',{status:'failed',error:'seat-2 control: transport failure'});
  await app.seat('seat-1').post('/say',{text:'end the match'});

  await app.until(async()=>(await read('seat-1'))?.phase==='stop',{what:'the stop phase'});
  assert.equal(app.file('result.json'),null,'the end waits for the healthy cameras');
  for(const seat of ['seat-1','seat-3','seat-4'])await report(seat,{status:'stopped',metadata:{record:false,complete:true,frames:0,files:[]}});
  const result=JSON.parse(await app.until(()=>app.file('result.json'),{what:'result.json'}));
  assert.deepEqual([result.started,result.failure,result.terminal.reason],[true,undefined,'core_destroyed']);
  const log=app.log(),video=log.find(entry=>entry.type==='video');
  assert.deepEqual([video.complete,video.error],[false,'seat-2 native recorder failed: seat-2 control: transport failure']);
  assert.deepEqual(Object.fromEntries(Object.entries(video.per_seat).map(([seat,camera])=>[seat,camera.status])),{'seat-1':'stopped','seat-2':'failed','seat-3':'stopped','seat-4':'stopped'});
  assert.ok(log.indexOf(video)<log.findIndex(entry=>entry.type==='game_ended'),'the video entry comes before the end');
  const reward=grade(app);
  assert.equal(reward.reward,1);
  assert.deepEqual(seats.map(seat=>reward[seat]),[1,1,1,1]);
});

for(const mode of ['exit7','SIGKILL'])for(const barrier of ['agents','camera_boot']){
  test(`native ${mode} during ${barrier} preparation fails unscored`,async t=>{
    const app=await startApp({main,seats,settings,env:{FAKE_NATIVE_EXIT:mode,FAKE_BOOT_BARRIER:barrier==='camera_boot'?'1':'0'}});
    t.after(()=>app.stop());
    if(barrier==='agents'){
      await app.until(()=>app.healthy(),{what:'healthy preparation'});
      assert.equal(await phase(app),'waiting');
    }else await app.until(()=>existsSync(join(app.logs,'camera-boot-waiting')),{what:'camera boot barrier'});
    writeFileSync(join(app.logs,'native-exit'),'');
    const result=JSON.parse(await app.until(()=>app.file('result.json'),{what:'native exit failure'}));
    const reason=mode==='SIGKILL'?/killed by SIGKILL/:/exited with code 7/;
    assert.match(result.failure,reason);
    assert.match(JSON.parse(app.file('failure.json')).error,reason);
    if(barrier==='agents')assert.equal((await app.request('/health')).status,503);
    else await app.until(()=>app.child.exitCode!==null,{what:'aborted camera boot exits'});
    const reward=join(app.logs,'reward.json');writeFileSync(reward,'{}');
    assert.throws(()=>execFileSync(process.execPath,[verify,app.logs,reward],{stdio:'pipe'}));
    assert.equal(existsSync(reward),false);
  });
}

for(const mode of ['exit7','SIGKILL'])test(`native ${mode} after core loss preserves final status and reward`,async t=>{
  const app=await open(t,{env:{FAKE_NATIVE_EXIT:mode}});
  await playing(app);
  await app.seat('seat-1').post('/say',{text:'end the match'});
  const result=await app.until(()=>app.file('result.json'),{what:'completed survival result'});
  const before=await app.seat('seat-2').get('/update');
  const reward=grade(app);
  writeFileSync(join(app.logs,'native-exit'),'');
  await app.until(()=>app.file('native-exited')!==null,{what:'native process exit'});
  const after=await app.seat('seat-2').get('/update');
  assert.deepEqual(after,before);
  assert.deepEqual([after.game_over,after.status.phase,after.status.result.reason],[true,'over','core_destroyed']);
  assert.equal((await app.seat('seat-2').request('/wait',{method:'POST',body:{}})).body.game_over,true);
  assert.deepEqual((await app.request('/health')).body,{ready:true,game_over:true});
  assert.equal(app.file('result.json'),result);
  assert.equal(app.file('failure.json'),null);
  assert.deepEqual(grade(app),reward);
});
