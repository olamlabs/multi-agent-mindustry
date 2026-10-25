import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Backend} from '../../environment/sim/backend.mjs';
import {NativeInputError,NativeTransportError} from '../../environment/sim/native-error.mjs';
import {DEFAULTS,validateSettings} from '../../environment/sim/settings.mjs';
import {toolsFor} from '../../environment/sim/tools.mjs';

const SEATS=Array.from({length:4},(_,i)=>`seat-${i+1}`);
const roster=Object.fromEntries(SEATS.map(s=>[s,s]));
const STATUS={t:3.5,team:'sharded',you:{unit_id:7,type:'gamma',health:220,x:80,y:30,stack:{item:'sand',amount:10},mining:null},core:{id:1,health:4000,max_health:4000,items:{copper:300,sand:40}},chat:{seq:2,t:3,from:'seat-2',to:[],text:'drills at 80,36',data:null},wake_head:2};
const {wake_head:_wake,...PLUGIN_SHOWN}=STATUS;

const SHOWN={game:{number:1,of:1},...PLUGIN_SHOWN};
const terminalOf=(game,extra={})=>({game,seat_teams:Object.fromEntries(SEATS.map(s=>[s,'sharded'])),reason:'time_limit',elapsed_seconds:600,...extra});

function fixture(respond=()=>({}),settings={games:1,chat_after_sec:0,video:{record:false}}){
  const calls=[];
  const logged=[];
  const engine={boot:async()=>{},close:async()=>{},call:async(path,args)=>{calls.push([path,args]);if(path==='/status')return STATUS;return respond(path,args);},

    async tool(path,args){try{return {result:await this.call(path,args),status:STATUS};}catch(error){if(error instanceof NativeInputError)error.seatStatus=STATUS;throw error;}}};
  const renderer={boot:async()=>({}),start:async()=>{},stop:async()=>({complete:true}),close:async()=>{}};
  const evidence=mkdtempSync(join(tmpdir(),'mindustry-series-test-'));
  const backend=new Backend({engine,renderer,evidence,roster,settings,log:entry=>logged.push(entry)});
  backend.releaseAgents();
  return {backend,calls,engine,evidence,logged};
}
async function running(f){
  await f.backend.boot();
  f.backend.start();await f.backend.beginPromise;
  return f.backend;
}

test('settings carry all_chat to native setup and default it off',async()=>{
  assert.equal(validateSettings({}).all_chat,false);
  assert.throws(()=>validateSettings({all_chat:'yes'}),/all_chat/);
  const f=fixture(()=>({}),{...DEFAULTS,game_mode:'pvp',all_chat:true,video:{record:false}});
  assert.equal(validateSettings({}).games,3,'a series is three games unless the launch says otherwise');
  for(const games of [0,-1,1.5,'2',null,101,1000])assert.throws(()=>validateSettings({games}),/games must be a whole number from 1 to 100/);
  for (const games of [1, 100]) assert.equal(validateSettings({games}).games, games);
  await f.backend.boot();
  assert.equal(f.calls[0][0],'/setup');assert.equal(f.calls[0][1].all_chat,true);assert.equal(f.calls[0][1].game_mode,'pvp');
  assert.equal('lobby_sec' in f.calls[0][1],false,'the app keeps its own lobby_sec from the engine');
  assert.equal(f.calls[0][1].save_interval_sec,60,'the engine saves the game every minute unless the launch says otherwise');
  assert.equal(validateSettings({save_interval_sec:0}).save_interval_sec,0,'0 saves only at the end');
  for(const save_interval_sec of [-1,1.5,'60',null])assert.throws(()=>validateSettings({save_interval_sec}),/save_interval_sec must be a whole number of seconds/);
  assert.equal('games' in f.calls[0][1],false,'and its own games');
  assert.equal('chat_after_sec' in f.calls[0][1],false,'and how long chat stays open after the last');
  assert.equal(validateSettings({}).chat_after_sec,300,'team chat stays open five minutes after the last game unless the launch says otherwise');
  assert.equal(validateSettings({chat_after_sec:0}).chat_after_sec,0);
  for(const chat_after_sec of [-1,1.5,'60',null,86401])assert.throws(()=>validateSettings({chat_after_sec}),/chat_after_sec must be 0\.\.86400/);
});

test('replay settings default to recording, are checked, and reach the engine at boot rather than the native setup',async()=>{
  assert.deepEqual(validateSettings({}).replay,{record:true,segment_sec:600,keyframe_sec:60});
  assert.deepEqual(validateSettings({replay:{record:false}}).replay,{record:false,segment_sec:600,keyframe_sec:60});
  for(const replay of [null,[],'on'])assert.throws(()=>validateSettings({replay}),/Invalid replay/);
  assert.throws(()=>validateSettings({replay:{fps:5}}),/Unknown replay setting: fps/);
  assert.throws(()=>validateSettings({replay:{record:'yes'}}),/replay.record must be boolean/);
  for(const key of ['segment_sec','keyframe_sec'])for(const value of [0,1.5,'60',null,86401])
    assert.throws(()=>validateSettings({replay:{[key]:value}}),new RegExp(`replay\\.${key} must be a whole number of seconds, 1\\.\\.86400`));
  const f=fixture(()=>({}),{games:1,chat_after_sec:0,video:{record:false},replay:{segment_sec:300,keyframe_sec:30}});
  let booted;f.engine.boot=async settings=>{booted=settings;};
  await f.backend.boot();
  assert.deepEqual(booted.replay,{record:true,segment_sec:300,keyframe_sec:30});
  assert.equal('replay' in f.calls[0][1],false,'the plugin refuses fields it does not know');
});

test('tools are the five verbs; say offers "all" only when enabled',async()=>{
  assert.deepEqual(toolsFor({}).map(t=>t.name),['query','events','act','say','wake']);
  const audience=settings=>toolsFor(settings).find(t=>t.name==='say').inputSchema.properties.audience.enum;
  assert.deepEqual(audience({all_chat:false}),['team','self']);
  assert.deepEqual(audience({all_chat:true}),['team','self','all']);
  assert.equal(toolsFor({}).find(t=>t.name==='act').inputSchema.properties.ops.items.properties.op.enum.includes('tap'),false);
  const f=fixture();await running(f);
  assert.deepEqual(f.backend.tools('seat-1').map(t=>t.name),['query','events','act','say','wake']);
});

test('each tool reaches its plugin endpoint with the caller as seat',async()=>{
  const f=fixture((path,args)=>({path,echo:args}));await running(f);
  for(const name of ['query','events','act','say','wake']) {
    const reply=await f.backend.call('seat-2',name,{after:0});
    assert.equal(reply.ok,true);assert.equal(reply.result.path,'/'+name);assert.equal(reply.result.echo.seat,'seat-2');
    assert.deepEqual(reply.status,{phase:'running',...SHOWN},'every reply carries the status read with it, without the wake mark');
  }

  const spoofed=await f.backend.call('seat-2','say',{seat:'seat-1',text:'hi'});
  assert.equal(spoofed.result.echo.seat,'seat-2');
});

test('the status is the plugin status plus phase, from the lobby on, and wakes on the seat wake mark',async()=>{
  const f=fixture();
  const unbooted=await f.backend.observe('seat-1');
  assert.deepEqual(unbooted.status,{phase:'waiting',game:{number:1,of:1},t:null,team:null,you:null,core:null,chat:null});
  await f.backend.boot();
  const lobby=await f.backend.observe('seat-1');
  assert.deepEqual(lobby.status,{phase:'waiting',...SHOWN},'seats see their team and core while they wait');
  f.backend.start();await f.backend.beginPromise;
  assert.equal(f.backend.started,true);
  const during=await f.backend.observe('seat-1');
  assert.deepEqual(during.status,{phase:'running',...SHOWN});
  assert.deepEqual(during.wake_key,{game:1,phase:'running',wake_head:2});
  assert.ok(JSON.stringify(during.status).length<500,'a status stays a line or two');
});

test('rejections: unknown tool, inputs before start, plugin input error; an infrastructure error fails the match',async()=>{
  const f=fixture((path,args)=>{if(path==='/query'&&args.of==='tanks')throw new NativeInputError('Unknown collection "tanks"');if(path==='/events')throw new Error('Native engine HTTP 500');return {};});
  await f.backend.boot();
  for(const name of ['act','say','wake']) assert.deepEqual(await f.backend.call('seat-1',name,{}),{ok:false,error:'The match has not started.'});
  f.backend.start();await f.backend.beginPromise;
  assert.equal((await f.backend.call('seat-1','look',{})).error,'Unknown tool');
  const refused=await f.backend.call('seat-1','query',{of:'tanks'});
  assert.deepEqual([refused.error,refused.status],['Unknown collection "tanks"',{phase:'running',...SHOWN}],'a refusal carries the status too');
  await assert.rejects(f.backend.call('seat-1','events',{after:0}),/HTTP 500/);
  assert.match(f.backend.failure,/HTTP 500/);
  assert.equal((await f.backend.call('seat-1','query',{of:'units'})).error,'The match failed');
});

test('act and say are journaled and logged; reads are not',async()=>{
  const f=fixture(()=>({ok:true}));await running(f);
  await f.backend.call('seat-1','say',{text:'hi'});
  await f.backend.call('seat-1','act',{ops:[{op:'plan_clear'}]});
  await f.backend.call('seat-1','query',{of:'units'});
  const journal=readFileSync(join(f.evidence,'journal.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(journal.map(e=>e.value.type),['setup','started','say','act']);
  assert.deepEqual(f.logged.map(e=>e.type),['setup','started','say','act']);
  assert.equal(f.logged[2].seat,'seat-1');assert.equal(f.logged[2].summary,'seat-1 says: hi');
});

test('the native terminal finishes the match once recordings are final; a failed camera is kept in the video entry and fails nothing',async()=>{
  const f=fixture(()=>({}),{time_limit_sec:18000,games:1,chat_after_sec:0,video:{record:false}});await running(f);
  const perSeat={'seat-1':{status:'failed',error:'seat-1 control: transport failure'},'seat-2':{status:'stopped'},'seat-3':{status:'stopped'},'seat-4':{status:'stopped'}};
  f.backend.renderer.stop=async()=>({type:'video',complete:false,per_seat:perSeat,error:'seat-1 native recorder failed: seat-1 control: transport failure'});
  f.backend.renderHandle={};
  f.engine.call=async(path)=>path==='/state'?{terminal:terminalOf(1,{elapsed_seconds:18000})}:{};
  await f.backend.tick();
  assert.equal(f.backend.failure,null);
  assert.deepEqual([f.backend.status(),f.backend.phase(),f.backend.terminal.reason],['completed','over','time_limit']);
  assert.deepEqual(f.logged.map(e=>e.type).slice(-2),['video','game_ended'],'the video entry, then the end');
  const video=f.logged.at(-2);
  assert.deepEqual([video.complete,video.per_seat,video.summary],[false,perSeat,'Seat video incomplete']);
  assert.equal((await f.backend.call('seat-1','act',{ops:[{op:'plan_clear'}]})).ok,false);
});

test('a terminal waits for running calls, then completes and stays complete',async()=>{
  const f=fixture(()=>({}),{time_limit_sec:600,games:1,chat_after_sec:0,video:{record:false}});await running(f);

  const FINAL={...STATUS,t:600,you:null,core:null,chat:{...STATUS.chat,seq:3,text:'core is down'},wake_head:3};
  f.engine.call=async(path)=>path==='/state'?{terminal:{game:1,reason:'time_limit',elapsed_seconds:600}}:path==='/status'?FINAL:{};
  f.backend.inflight=1;
  assert.equal(await f.backend.tick(),true);
  assert.equal(f.backend.status(),'running','a call still running holds the finish');
  f.backend.inflight=0;
  await f.backend.tick();
  assert.equal(f.backend.status(),'completed');
  assert.equal(f.backend.phase(),'over');
  const over=(await f.backend.observe('seat-1')).status;
  assert.deepEqual([over.phase,over.results],['over',[{game:1,reason:'time_limit',elapsed_seconds:600}]],'the status says how it ended');
  const {wake_head:_final,...finalShown}=FINAL;
  assert.deepEqual(over,{phase:'over',game:{number:1,of:1},...finalShown,results:over.results},'and reads the final native state, not a cached one');
  assert.equal(await f.backend.tick(),false);
  assert.deepEqual(f.logged.map(e=>e.type).slice(-1),['game_ended']);
});

test('video.seats resolves to the camera seats; only per-seat game clients can leave seats without one',async()=>{
  const subset=fixture(()=>({}),{video:{record:false,seats:1}});
  assert.deepEqual(subset.backend.settings.video.seats,['seat-1']);
  await assert.rejects(subset.backend.boot(),/video.seats needs the per-seat game clients/);
  assert.deepEqual(fixture().backend.settings.video.seats,SEATS);
});

test('a game before the last ends: it is recorded, the engine resets to the next game and starts it; the last ends the series',async()=>{
  const f=fixture(()=>({}),{time_limit_sec:600,games:2,chat_after_sec:0,video:{record:false}});await running(f);
  let terminal=terminalOf(1),game=1;
  const changes=[];f.backend.onChange=()=>changes.push(f.backend.phase());
  f.engine.call=async(path,args)=>{
    f.calls.push([path,args]);
    if(path==='/state')return {game,terminal};
    if(path==='/status')return STATUS;

    if(path==='/reset'){
      const during=await f.backend.call('seat-1','act',{ops:[{op:'plan_clear'}]});
      assert.deepEqual([during.ok,during.error,during.status],[false,'Game 1 of 2 has ended. Game 2 is starting on the same map, with the same teammates and opponents; POST /wait returns once it is running.',undefined],'calls between games are refused with that fact');
      assert.deepEqual((await f.backend.observe('seat-1')).status.phase,'restarting');
      game=2;terminal=null;return {game:2,started:false};
    }
    return {};
  };
  f.backend.renderHandle={};
  const cameras=[];
  f.backend.renderer={start:async()=>cameras.push('start'),stop:async()=>{cameras.push('stop');return {type:'video',complete:true};},close:async()=>{}};
  assert.equal(await f.backend.tick(),true);
  assert.deepEqual(f.calls.map(([path])=>path).filter(path=>path!=='/status').slice(-3),['/state','/reset','/start']);
  assert.deepEqual(cameras,[],'the cameras keep recording between games');
  assert.deepEqual(changes,['restarting'],'seats waiting are woken when the game ends');
  const second=await f.backend.observe('seat-1');
  assert.deepEqual([second.status.phase,second.status.game,second.status.results],['running',{number:2,of:2},[{game:1,reason:'time_limit',elapsed_seconds:600}]]);
  assert.deepEqual(second.wake_key,{game:2,phase:'running',wake_head:2},'the wake key names the game, so a new game wakes a seat whose mark is unchanged');
  assert.equal((await f.backend.call('seat-1','act',{ops:[{op:'plan_clear'}]})).ok,true,'game 2 takes inputs');
  terminal=terminalOf(2);
  await f.backend.tick();
  assert.deepEqual([f.backend.status(),f.backend.phase(),f.backend.results.map(t=>t.game)],['completed','over',[1,2]]);
  assert.equal(f.calls.filter(([path])=>path==='/reset').length,1,'the last game ends the series instead of resetting');
  assert.deepEqual(cameras,['stop'],'and stops the cameras, once');
  assert.deepEqual(f.logged.filter(e=>['started','game_ended'].includes(e.type)).map(e=>[e.type,e.game]),[['started',1],['game_ended',1],['started',2],['game_ended',2]]);
  const journal=readFileSync(join(f.evidence,'journal.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(journal.map(e=>e.sequence),journal.map((_,i)=>i+1),'the journal on disk numbers every entry');
});

test('an engine that resets to the wrong game, or ends another game than the one played, fails the series loudly',async()=>{
  const wrong=fixture(()=>({}),{time_limit_sec:600,games:3,video:{record:false}});await running(wrong);
  wrong.engine.call=async(path)=>path==='/state'?{terminal:terminalOf(1)}:path==='/reset'?{game:3}:{};
  await wrong.backend.tick();
  assert.deepEqual([wrong.backend.phase(),wrong.backend.failure],['failed','The engine reset to game 3, not game 2']);
  const other=fixture(()=>({}),{time_limit_sec:600,games:3,video:{record:false}});await running(other);
  other.engine.call=async(path)=>path==='/state'?{terminal:terminalOf(2)}:{};
  await other.backend.tick();
  assert.equal(other.backend.failure,'The engine ended game 2 while the series is on game 1');
});

test('the backend holds no record of play in memory: its journal is on disk, and a long series keeps only counters and results',async()=>{
  const f=fixture(()=>({ok:true}),{time_limit_sec:600,games:100,video:{record:false}});await running(f);
  let game=1;
  f.engine.call=async(path,args)=>path==='/state'?{game,terminal:f.ended?terminalOf(game):null}:path==='/reset'?(f.ended=false,{game:++game}):path==='/status'?STATUS:{ok:true,echo:args};
  const held=()=>JSON.stringify(f.backend,(key,value)=>['engine','renderer','preparation','log','onChange','lastStatus','state','results'].includes(key)?undefined:value).length;
  const before=held();
  for(let n=0;n<20;n++){
    for(let i=0;i<50;i++)await f.backend.call('seat-1',i%2?'act':'say',i%2?{ops:[{op:'plan_clear'}]}:{text:'x'.repeat(1000)});
    f.ended=true;await f.backend.tick();
  }
  assert.equal(f.backend.game,21);
  assert.ok(held()-before<20,`the backend grew by ${held()-before} bytes over 1,000 calls and 20 games`);
  assert.equal(f.backend.results.length,20,'one terminal per finished game');
  assert.equal(readFileSync(join(f.evidence,'journal.jsonl'),'utf8').trim().split('\n').length,1+1+20*(50+2));
});

test('from a game\'s native end the phase says so and new calls are refused at once, while running calls finish',async()=>{
  const f=fixture(()=>({}),{time_limit_sec:600,games:2,chat_after_sec:0,video:{record:false}});await running(f);
  let terminal=terminalOf(1);
  f.engine.call=async(path,args)=>{f.calls.push([path,args]);if(path==='/state')return {game:1,terminal};if(path==='/status')return STATUS;if(path==='/reset'){terminal=null;return {game:2};}return {};};
  f.backend.inflight=1;
  assert.equal(await f.backend.tick(),true,'the end wakes waiting seats');
  const ended=(await f.backend.observe('seat-1'));
  assert.deepEqual([ended.status.phase,ended.status.game,ended.status.results.map(r=>r.game)],['restarting',{number:2,of:2},[1]],'the game shown is the next one, as while it is set up');
  const engineCalls=f.calls.length;
  const refused=await f.backend.call('seat-1','act',{ops:[{op:'plan_clear'}]});
  assert.deepEqual([refused.ok,refused.error],[false,'Game 1 of 2 has ended. Game 2 is starting on the same map, with the same teammates and opponents; POST /wait returns once it is running.']);
  assert.equal(f.calls.slice(engineCalls).filter(([path])=>path!=='/status').length,0,'a refused call never reaches the engine');
  f.backend.inflight=0;
  await f.backend.tick();
  const next=await f.backend.observe('seat-1');
  assert.deepEqual([next.status.phase,next.status.game,next.status.results.map(r=>r.game)],['running',{number:2,of:2},[1]]);
  assert.deepEqual(ended.wake_key.game,next.wake_key.game,'the game in the wake key does not move twice for one end');

  terminal=terminalOf(2);f.engine.call=async(path)=>path==='/state'?{game:2,terminal}:path==='/status'?STATUS:{};
  f.backend.inflight=1;
  await f.backend.tick();
  assert.deepEqual([f.backend.phase(),(await f.backend.observe('seat-1')).status.game],['ending',{number:2,of:2}]);
  assert.equal((await f.backend.call('seat-1','say',{text:'gg'})).error,'Game 2 of 2, the last, has ended and its result is being recorded; POST /wait returns once that is done.');
  f.backend.inflight=0;
  await f.backend.tick();
  assert.deepEqual([f.backend.status(),f.backend.phase(),f.backend.results.map(r=>r.game)],['completed','over',[1,2]]);
});

test('a malformed call the plugin rejects is marked invalid; one it refuses as the game stands is not',async()=>{
  const f=fixture((path,args)=>{if(args.of==='tanks')throw new NativeInputError('of: "tanks" is not one of collections',null,true);if(path==='/events')throw new NativeInputError('The reader "chat" already has another filter; use a different cursor name');return {};});
  await running(f);
  assert.deepEqual(await f.backend.call('seat-1','query',{of:'tanks'}),{ok:false,error:'of: "tanks" is not one of collections',invalid:true,status:{phase:'running',...SHOWN}});
  assert.equal((await f.backend.call('seat-1','events',{cursor:'chat'})).invalid,false);
});

test('after the last game team chat stays open until chat_after_sec has passed, then the series is over',async()=>{
  const f=fixture(()=>({ok:true}),{time_limit_sec:600,games:1,chat_after_sec:300,video:{record:false}});await running(f);
  const changes=[];f.backend.onChange=()=>changes.push(f.backend.phase());
  f.engine.call=async(path,args)=>path==='/state'?{game:1,terminal:terminalOf(1)}:path==='/status'?STATUS:{ok:true,path,args};
  const before=Date.now();
  await f.backend.tick();
  assert.deepEqual([f.backend.phase(),f.backend.status()],['chat','running'],'the game is recorded and chat is open; the series is not over yet');
  assert.deepEqual(changes,['chat'],'seats waiting are woken when chat opens');
  const status=(await f.backend.observe('seat-1')).status;
  assert.deepEqual([status.phase,status.results.map(r=>r.game)],['chat',[1]]);
  const until=Date.parse(status.chat_open_until);
  assert.ok(until>=before+299_000&&until<=Date.now()+300_000,status.chat_open_until);
  assert.match(status.chat_open_until,/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  const act=await f.backend.call('seat-1','act',{ops:[{op:'plan_clear'}]});
  assert.deepEqual([act.ok,act.error],[false,`The series is over, so act applies no inputs. Team chat (say) stays open until ${status.chat_open_until}; then every request answers game_over: true.`]);
  const said=await f.backend.call('seat-1','say',{text:'gg'});
  assert.deepEqual([said.ok,said.result.path,said.status.phase],[true,'/say','chat']);
  for(const name of ['query','events','wake'])assert.equal((await f.backend.call('seat-1',name,{})).ok,true,name);
  assert.deepEqual(f.logged.map(e=>e.type).slice(-2),['game_ended','say'],'a message after the end is journaled');
  assert.equal(await f.backend.tick(),false);
  assert.equal(f.backend.phase(),'chat','chat stays open until its time');
  f.backend.chatUntil=Date.now()-1;
  await f.backend.tick();
  assert.deepEqual([f.backend.phase(),f.backend.status(),changes.at(-1)],['over','completed','over']);
  assert.equal((await f.backend.call('seat-1','say',{text:'late'})).ok,false);

  const g=fixture(()=>({}),{time_limit_sec:600,games:1,chat_after_sec:300,video:{record:false}});await running(g);
  g.engine.call=async(path)=>path==='/state'?{game:1,terminal:terminalOf(1)}:path==='/status'?STATUS:{};
  await g.backend.tick();
  await g.backend.stop({reason:'SIGTERM'});
  assert.deepEqual([g.backend.status(),g.logged.some(e=>e.type==='stopped')],['completed',false]);
});

test('a 100-game series resets exactly 99 times and completes after game 100',async()=>{
  const f=fixture(()=>({}),{games:100,chat_after_sec:0,video:{record:false}});
  await running(f);
  let game=1,resets=0;
  f.engine.call=async path=>{
    if(path==='/state')return {game,terminal:terminalOf(game)};
    if(path==='/reset'){resets++;return {game:++game};}
    if(path==='/status')return STATUS;
    return {};
  };
  for(let n=1;n<=100;n++) {
    await f.backend.tick();
    assert.equal(f.backend.results.length,n);
    assert.equal(f.backend.phase(),n===100?'over':'running');
  }
  assert.equal(resets,99);
  assert.equal(f.backend.status(),'completed');
  assert.deepEqual(f.backend.results.map(r=>r.game),Array.from({length:100},(_,i)=>i+1));
});

test('native exit diagnostics supersede only native transport failures',async()=>{
  for(const first of [new NativeTransportError(new TypeError('fetch failed')),new Error('evidence disk full')]){
    const f=fixture();let exited;
    f.engine.exit=new Promise(resolve=>{exited=resolve;});
    await f.backend.boot();
    f.backend.fail(first);
    exited('Mindustry server exited with code 7');
    await Promise.resolve();
    const expected=first instanceof NativeTransportError?'Mindustry server exited with code 7':'evidence disk full';
    assert.equal(f.backend.failure,expected);
    assert.equal(JSON.parse(readFileSync(join(f.evidence,'failure.json'))).error,expected);
  }
});

test('a final status transport failure before the exit event uses cached seat status',async()=>{
  const f=fixture(()=>({}),{games:1,chat_after_sec:0});await running(f);
  await f.backend.observe('seat-1');
  f.engine.call=async path=>path==='/state'?{game:1,terminal:terminalOf(1)}:{};
  await f.backend.tick();
  f.engine.call=async()=>{throw new NativeTransportError(new TypeError('fetch failed'));};
  const final=(await f.backend.observe('seat-1')).status;
  assert.deepEqual([final.phase,final.you,final.results[0].game],['over',STATUS.you,1]);
  assert.equal(f.backend.failure,null);
  f.engine.call=async()=>{f.backend.nativeExited=true;throw new Error('Native process exited during the status request');};
  assert.deepEqual((await f.backend.observe('seat-1')).status,final);
  assert.equal(f.backend.failure,null);
});
