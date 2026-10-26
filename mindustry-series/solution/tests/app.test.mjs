import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import {execFileSync} from 'node:child_process';
import {existsSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {startApp} from './app-process.mjs';
import {objectiveFromInstruction} from '../../environment/sim/app.mjs';

const main=fileURLToPath(new URL('./fixtures/fake-match.mjs',import.meta.url));
const verify=fileURLToPath(new URL('../../environment/sim/verify.mjs',import.meta.url));
const seats=['seat-1','seat-2','seat-3','seat-4'];
const settings={game_mode:'pvp',time_limit_sec:600,seed:1,games:1,chat_after_sec:0,all_chat:false,video:{record:false,fps:5,width:960,height:540}};
const OVER={game_over:true,error:'Every game of the series is over. The results are at GET /update.'};

async function open(t,{overrides={},env={}}={}) {
  const app=await startApp({main,seats,settings:{...settings,...overrides},env});
  t.after(()=>app.stop());
  await app.until(()=>app.healthy(),{what:'health'});
  await Promise.all(seats.map(s=>app.seat(s).get('/brief')));
  return app;
}
const phase=async app=>(await app.seat('seat-1').get('/update')).status.phase;
const playing=async app=>app.until(async()=>(await phase(app))==='running',{what:'the match clock'});
const grade=app=>{const out=join(mkdtempSync(join(tmpdir(),'reward-')),'reward.json');execFileSync(process.execPath,[verify,app.logs,out]);return JSON.parse(readFileSync(out,'utf8'));};
const series=app=>{const out=join(mkdtempSync(join(tmpdir(),'reward-')),'reward.json');execFileSync(process.execPath,[verify,app.logs,out]);return JSON.parse(readFileSync(join(out,'..','series.json'),'utf8'));};

test('seats play a one-game series through the API, wake on a teammate message, and it is graded once recorded',async t=>{
  const app=await open(t);
  await playing(app);
  const index=await app.seat('seat-1').get('/');
  assert.deepEqual(index.endpoints.map(endpoint=>endpoint.path),['/brief','/update','/wait','/query','/events','/act','/say','/wake']);
  const brief=await app.seat('seat-1').get('/brief');
  assert.ok(brief.brief.startsWith(objectiveFromInstruction(readFileSync(new URL('../../instruction.md',import.meta.url),'utf8'))+'\n\n'));
  assert.equal(brief.game_mode,'pvp');assert.match(brief.brief,/^Mode: PvP\./);assert.match(brief.brief,/This series is a single game\.\n$/);
  const view=await app.seat('seat-2').get('/update');
  assert.equal(view.game_over,false);
  assert.deepEqual(Object.keys(view.status),['phase','game','t','team','you','core','chat']);
  assert.deepEqual(view.status.game,{number:1,of:1});

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
  assert.equal((await app.seat('seat-3').get('/brief')).status.phase,'running');
  assert.deepEqual((await app.seat('seat-4').post('/act',{ops:[{op:'plan_clear'}]})).results,[{ok:true,effect:'plan_clear'}]);

  const ending=(async()=>{for(;;){const reply=await app.seat('seat-3').request('/wait',{method:'POST',body:{}});if(reply.status===410||reply.body.game_over)return reply.body;assert.ok(['running','ending'].includes(reply.body.status.phase));}})();
  await app.seat('seat-1').post('/say',{text:'end the game'});
  const result=JSON.parse(await app.until(()=>app.file('result.json'),{what:'result.json'}));
  assert.deepEqual([result.started,result.results.map(r=>[r.game,r.reason])],[true,[[1,'time_limit']]]);
  assert.equal((await ending).game_over,true,'a waiting seat learns the game is over');
  const late=await app.seat('seat-1').request('/act',{method:'POST',body:{ops:[{op:'plan_clear'}]}});
  const {status:final,...over}=late.body;
  assert.deepEqual([late.status,over],[410,OVER]);
  assert.deepEqual([final.phase,final.results.length,final.results[0].reason,'seat_teams' in final.results[0]],['over',1,'time_limit',false],'game over says how it ended');
  assert.equal(await phase(app),'over');
  const log=app.log();
  assert.deepEqual(log[0],{sequence:1,time:log[0].time,type:'roster',seats});
  for(const type of ['setup','started','say','act','video','game_ended']) assert.ok(log.some(entry=>entry.type===type&&typeof entry.summary==='string'),type);
  const reward=grade(app);
  assert.deepEqual([reward.completed,reward.games,reward.wins_sharded,reward.draws],[1,1,0,1]);
  assert.deepEqual(seats.map(seat=>reward[seat]),[.5,.5,.5,.5]);
});

test('a three-game series starts each next game on its own, wakes waiting seats, and grades every game',async t=>{
  const app=await open(t,{overrides:{games:3},env:{FAKE_RESET_MS:'1500'}});
  await playing(app);
  assert.match((await app.seat('seat-1').get('/brief')).brief,/This series is 3 games, played one after another on the same map\. When a game ends, the next one starts on its own, against the same opponents and with the same teammates\.\n$/);
  const first=await app.seat('seat-2').get('/update');
  assert.deepEqual([first.status.game,'results' in first.status],[{number:1,of:3},false]);

  const waiting=app.seat('seat-2').post('/wait');
  await app.seat('seat-1').post('/say',{text:'end the game',audience:'self'});
  const between=(await waiting).status;
  assert.equal((await app.request('/health')).body.game_over,false,'reset does not stop seat agents');
  assert.deepEqual([between.phase,between.game,between.results.map(r=>r.game)],['restarting',{number:2,of:3},[1]]);
  const refused=await app.seat('seat-3').request('/act',{method:'POST',body:{ops:[{op:'plan_clear'}]}});
  assert.deepEqual([refused.status,refused.body.error,refused.body.status.phase],[409,'Game 1 of 3 has ended. Game 2 is starting on the same map, with the same teammates and opponents; POST /wait returns once it is running.','restarting']);
  const second=(await app.seat('seat-2').post('/wait')).status;
  assert.deepEqual([second.phase,second.game],['running',{number:2,of:3}]);
  assert.deepEqual((await app.seat('seat-3').post('/act',{ops:[{op:'plan_clear'}]})).status.game,{number:2,of:3},'game 2 takes inputs');

  const seen=(await app.seat('seat-4').get('/update')).status;
  assert.deepEqual([seen.phase,seen.chat],['running',null]);
  await app.seat('seat-1').post('/say',{text:'end the game',audience:'self'});
  await app.until(async()=>{const status=(await app.seat('seat-1').get('/update')).status;return status.phase==='running'&&status.game.number===3;},{what:'game 3'});
  const began=Date.now();
  const third=(await app.seat('seat-4').post('/wait?timeout_sec=30')).status;
  assert.deepEqual([third.game,third.phase,third.chat],[{number:3,of:3},'running',null]);
  assert.ok(Date.now()-began<5000,'a new game wakes the seat at once');

  await app.seat('seat-1').post('/say',{text:'end the game',audience:'self'});
  const result=JSON.parse(await app.until(()=>app.file('result.json'),{what:'result.json'}));
  assert.deepEqual(result.results.map(r=>r.game),[1,2,3]);
  const over=await app.seat('seat-2').get('/update');
  assert.deepEqual([over.game_over,over.status.phase,over.status.game,over.status.results.map(r=>r.game)],[true,'over',{number:3,of:3},[1,2,3]]);
  const log=app.log();
  assert.deepEqual(log.filter(e=>['started','game_ended'].includes(e.type)).map(e=>`${e.type} ${e.game}`),['started 1','game_ended 1','started 2','game_ended 2','started 3','game_ended 3']);
  assert.ok(log.filter(e=>e.type==='game_ended').every(e=>e.app_memory.rss>0),'each game end records the app\'s memory');
  assert.equal(log.filter(e=>e.type==='video').length,1,'the cameras are finalized once, after the last game');
  const reward=grade(app);
  assert.deepEqual([reward.completed,reward.games,reward.wins_sharded,reward.draws],[1,3,0,3]);
  assert.deepEqual(seats.map(seat=>reward[seat]),[.5,.5,.5,.5]);
  const {games,tally}=series(app);
  assert.deepEqual(games.map(g=>[g.game,g.reason,g.winning_team]),[[1,'time_limit',null],[2,'time_limit',null],[3,'time_limit',null]]);
  assert.deepEqual(tally,{wins:{sharded:0,crux:0},draws:3});
});

test('after the last game team chat stays open for chat_after_sec, then every request says the series is over',async t=>{
  const app=await open(t,{overrides:{games:2,chat_after_sec:3}});
  await playing(app);
  assert.match((await app.seat('seat-1').get('/brief')).brief,/with the same teammates\. After the last game, team chat stays open for 3 seconds; then every request answers `game_over: true`\.\n$/);
  await app.seat('seat-1').post('/say',{text:'end the game',audience:'self'});
  await app.until(async()=>{const status=(await app.seat('seat-1').get('/update')).status;return status.phase==='running'&&status.game.number===2;},{what:'game 2'});
  await app.seat('seat-1').post('/say',{text:'end the game',audience:'self'});
  const chat=await app.until(async()=>{const view=await app.seat('seat-2').get('/update');return view.status.phase==='chat'&&view;},{what:'the chat window'});
  assert.deepEqual([chat.game_over,chat.status.game,chat.status.results.map(r=>r.game)],[false,{number:2,of:2},[1,2]]);
  assert.match(chat.status.chat_open_until,/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  const act=await app.seat('seat-2').request('/act',{method:'POST',body:{ops:[{op:'plan_clear'}]}});
  assert.deepEqual([act.status,act.body.error,act.body.status.phase],[409,`The series is over, so act applies no inputs. Team chat (say) stays open until ${chat.status.chat_open_until}; then every request answers game_over: true.`,'chat']);
  const waiting=app.seat('seat-2').post('/wait');
  const said=await app.seat('seat-1').post('/say',{text:'gg, well played'});
  assert.equal(said.status.phase,'chat');
  assert.deepEqual([(await waiting).game_over,(await waiting).status.phase],[false,'chat'],'a teammate message still wakes a waiting seat');
  assert.equal(app.file('result.json'),null,'the series is not over while chat is open');
  assert.equal((await app.request('/health')).body.game_over,false,'final chat keeps agents alive');
  await app.seat('seat-3').get('/update');
  const over=await app.seat('seat-3').post('/wait');
  assert.deepEqual([over.game_over,over.status.phase],[true,'over'],'a waiting seat is woken when chat closes');
  assert.equal((await app.request('/health')).body.game_over,true,'seat watchers stop only after the final chat');
  const result=JSON.parse(app.file('result.json'));
  assert.deepEqual(result.results.map(r=>r.game),[1,2]);
  assert.equal((await app.seat('seat-1').request('/say',{method:'POST',body:{text:'late'}})).status,410);
  const log=app.log();
  assert.deepEqual(log.slice(-2).map(e=>[e.type,e.arguments?.text??null]),[['game_ended',null],['say','gg, well played']]);
  const reward=grade(app);
  assert.deepEqual([reward.completed,reward.games],[1,2],'messages after the last game are graded with the series');

  const stopped=await open(t,{overrides:{chat_after_sec:600}});
  await playing(stopped);
  await stopped.seat('seat-1').post('/say',{text:'end the game',audience:'self'});
  await stopped.until(async()=>(await phase(stopped))==='chat',{what:'the chat window'});
  stopped.child.kill('SIGTERM');
  await stopped.until(()=>stopped.child.exitCode!=null,{what:'exit'});
  assert.deepEqual(JSON.parse(stopped.file('result.json')).results.map(r=>r.game),[1]);
  assert.equal(grade(stopped).completed,1);
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
  assert.throws(()=>grade(stopped),/infrastructure-invalid/);
});

test('a series stopped between games scores nothing, like one stopped during a game',async t=>{
  const app=await open(t,{overrides:{games:2},env:{FAKE_RESET_MS:'2000'}});
  await playing(app);
  await app.seat('seat-1').post('/say',{text:'end the game',audience:'self'});
  await app.until(async()=>(await phase(app))==='restarting',{what:'the restart'});
  app.child.kill('SIGTERM');
  await app.until(()=>app.child.exitCode!=null,{what:'exit'});
  const types=app.log().map(entry=>`${entry.type}${entry.game?' '+entry.game:''}`);
  assert.deepEqual(types.slice(-3),['started 2','video','stopped'],'the stop waits for game 2 to start, then finalizes the recordings');
  assert.throws(()=>grade(app),/infrastructure-invalid/);
});

test('removed modes and invalid settings never start; the PvP brief is available',async()=>{
  for(const overrides of [{game_mode:'tag'},{game_mode:'survival'},{game_mode:'attack'},{game_mode:'sandbox'},{lobby_sec:0},{all_chat:'yes'},{team_count:3,team_size:1},{team_sizes:[4]},{games:0},{games:2.5},{games:'3'}])await assert.rejects(startApp({main,seats,settings:{...settings,...overrides}}).then(app=>app.stop()),/exited \(1\)/);
  const source=readFileSync(new URL('../../instruction.md',import.meta.url),'utf8');
  assert.ok(objectiveFromInstruction(source).startsWith('Mode: PvP.'));
  for(const bad of ['## Other\nMissing','## Objective\n\n## Other\nEmpty','## Objective\nOne\n## Objective\nTwo'])
    assert.throws(()=>objectiveFromInstruction(bad),/exactly one nonempty/);
});

test('a match without a game clock says so in its brief; a timed one does not',async t=>{
  const untimed=await open(t,{overrides:{game_mode:'pvp',time_limit_sec:null}});
  const {brief}=await untimed.seat('seat-1').get('/brief');
  assert.match(brief,/^Mode: PvP\./);
  assert.match(brief,/No game has a time limit\. The only thing that ends a game in your favor is your team winning against the others\.\n$/);
  const timed=await open(t);
  assert.doesNotMatch((await timed.seat('seat-1').get('/brief')).brief,/time limit/);
});

test("a match whose seats' game clients have not all joined by lobby_sec ends unplayed, and it is unscored",async t=>{
  const app=await open(t,{overrides:{lobby_sec:1},env:{FAKE_NO_CLIENTS:'1'}});
  const result=JSON.parse(await app.until(()=>app.file('result.json'),{what:'result.json'}));
  assert.deepEqual(result,{started:false,reason:"Not every agent and required camera became ready within 1 s; infrastructure preparation failed before play"});
  const wait=await app.seat('seat-1').request('/wait',{method:'POST',body:{}});
  const {status:unplayed,...gone}=wait.body;
  assert.deepEqual([wait.status,gone,unplayed.phase],[410,OVER,'not_started']);
  assert.equal(await phase(app),'not_started');

  assert.throws(()=>grade(app),/infrastructure-invalid/);
});

async function withSeatPorts(t,overrides={}) {
  const free=async()=>{const server=net.createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const {port}=server.address();await new Promise(resolve=>server.close(resolve));return port;};
  const control=await free();
  const app=await startApp({main,seats,settings:{...settings,...overrides},env:{FAKE_SEAT_PORTS:'1',FAKE_CONTROL_PORT:String(control)}});
  t.after(()=>app.stop());
  const url=seat=>`http://127.0.0.1:${control}/seats/${seat}`;
  const read=async seat=>{try{const reply=await fetch(url(seat));return reply.ok?await reply.json():null;}catch{return null;}};
  const report=async(seat,body)=>assert.equal((await fetch(url(seat),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})).status,200);
  return {app,read,report};
}

test('health waits for the camera control port, and the match waits for every seat\'s video client',async t=>{
  const {app,read,report}=await withSeatPorts(t);
  await app.until(()=>app.healthy(),{what:'health'});
  await Promise.all(seats.map(s=>app.seat(s).get('/brief')));

  for(const seat of seats)assert.equal((await read(seat))?.phase,'connect',`${seat}'s first control request once healthy`);
  for(const seat of seats){
    assert.equal(await phase(app),'waiting','the match waits for every client');
    await report(seat,{status:'ready',metadata:{}});
  }
  for(const seat of seats){
    await app.until(async()=>(await read(seat))?.phase==='record',{what:`${seat} recording`});
    await report(seat,{status:'recording',metadata:{record:false}});
  }
  await playing(app);
});

test('a camera that fails mid-series fails nothing: the games go on, the other cameras finalize once, the series is graded',async t=>{
  const {app,read,report}=await withSeatPorts(t,{games:2});
  await app.until(()=>app.healthy(),{what:'health'});
  await Promise.all(seats.map(s=>app.seat(s).get('/brief')));
  for(const seat of seats)await report(seat,{status:'ready',metadata:{}});
  for(const seat of seats){
    await app.until(async()=>(await read(seat))?.phase==='record',{what:`${seat} recording`});
    await report(seat,{status:'recording',metadata:{record:false}});
  }
  await playing(app);
  await report('seat-2',{status:'failed',error:'seat-2 control: transport failure'});
  await app.seat('seat-1').post('/say',{text:'end the game',audience:'self'});
  await app.until(async()=>{const status=(await app.seat('seat-1').get('/update')).status;return status.phase==='running'&&status.game.number===2;},{what:'game 2'});
  for(const seat of seats)assert.equal((await read(seat)).phase,'record',`${seat}'s camera keeps recording into game 2`);
  await app.seat('seat-1').post('/say',{text:'end the game',audience:'self'});

  await app.until(async()=>(await read('seat-1'))?.phase==='stop',{what:'the stop phase'});
  assert.equal(app.file('result.json'),null,'the end waits for the healthy cameras');
  for(const seat of ['seat-1','seat-3','seat-4'])await report(seat,{status:'stopped',metadata:{record:false,complete:true,frames:0,files:[]}});
  const result=JSON.parse(await app.until(()=>app.file('result.json'),{what:'result.json'}));
  assert.deepEqual([result.started,result.failure,result.results.map(r=>[r.game,r.reason])],[true,undefined,[[1,'time_limit'],[2,'time_limit']]]);
  const log=app.log(),video=log.find(entry=>entry.type==='video');
  assert.equal(log.filter(entry=>entry.type==='video').length,1,'one video entry, at the end of the series');
  assert.deepEqual([video.complete,video.error],[false,'seat-2 native recorder failed: seat-2 control: transport failure']);
  assert.deepEqual(Object.fromEntries(Object.entries(video.per_seat).map(([seat,camera])=>[seat,camera.status])),{'seat-1':'stopped','seat-2':'failed','seat-3':'stopped','seat-4':'stopped'});
  assert.ok(log.indexOf(video)>log.findIndex(entry=>entry.type==='game_ended'&&entry.game===1)&&log.indexOf(video)<log.findIndex(entry=>entry.type==='game_ended'&&entry.game===2),'the video entry comes after game 1 and before the last end');
  const reward=grade(app);
  assert.deepEqual([reward.completed,reward.games,reward.draws],[1,2,2]);
  assert.deepEqual(seats.map(seat=>reward[seat]),[.5,.5,.5,.5]);
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
  assert.doesNotMatch(app.output(),/TimeoutOverflowWarning/);
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

for(const mode of ['exit7','SIGKILL'])test(`native ${mode} after the series preserves final status and reward`,async t=>{
  const app=await open(t,{env:{FAKE_NATIVE_EXIT:mode}});
  await playing(app);
  await app.seat('seat-1').post('/say',{text:'end the game'});
  const result=await app.until(()=>app.file('result.json'),{what:'completed series result'});
  const before=await app.seat('seat-2').get('/update');
  const reward=grade(app);
  writeFileSync(join(app.logs,'native-exit'),'');
  await app.until(()=>app.file('native-exited')!==null,{what:'native process exit'});
  const after=await app.seat('seat-2').get('/update');
  assert.deepEqual(after,before);
  assert.deepEqual([after.game_over,after.status.phase,after.status.results[0].reason],[true,'over','time_limit']);
  assert.equal((await app.seat('seat-2').request('/wait',{method:'POST',body:{}})).body.game_over,true);
  assert.deepEqual((await app.request('/health')).body,{ready:true,game_over:true});
  assert.equal(app.file('result.json'),result);
  assert.equal(app.file('failure.json'),null);
  assert.deepEqual(grade(app),reward);
});

for(const mode of ['exit7','SIGKILL'])test(`native ${mode} during final chat fails the unfinished series`,async t=>{
  const app=await open(t,{overrides:{chat_after_sec:600},env:{FAKE_NATIVE_EXIT:mode}});
  await playing(app);
  await app.seat('seat-1').post('/say',{text:'end the game'});
  await app.until(async()=>(await phase(app))==='chat',{what:'final chat'});
  assert.equal(app.file('result.json'),null);
  writeFileSync(join(app.logs,'native-exit'),'');
  const result=JSON.parse(await app.until(()=>app.file('result.json'),{what:'native exit failure'}));
  assert.match(result.failure,mode==='SIGKILL'?/killed by SIGKILL/:/exited with code 7/);
  assert.equal(JSON.parse(app.file('failure.json')).error,result.failure);
  assert.equal((await app.request('/health')).status,503);
  const update=await app.seat('seat-2').get('/update');
  assert.deepEqual([update.game_over,update.status.phase],[true,'failed']);
  const say=await app.seat('seat-2').request('/say',{method:'POST',body:{text:'late'}});
  assert.deepEqual([say.status,say.body.game_over],[410,true]);
  const reward=join(app.logs,'reward.json');writeFileSync(reward,'{}');
  assert.throws(()=>execFileSync(process.execPath,[verify,app.logs,reward],{stdio:'pipe'}));
  assert.equal(existsSync(reward),false);
});
