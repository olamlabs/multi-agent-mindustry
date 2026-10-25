import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Backend} from '../../environment/sim/backend.mjs';
import {NativeInputError,NativeTransportError} from '../../environment/sim/native-error.mjs';
import {DEFAULTS,validateSettings} from '../../environment/sim/settings.mjs';
import {toolsFor} from '../../environment/sim/tools.mjs';

import {scriptedEvidence} from './fixtures/survival-fixtures.mjs';
const SEATS=Array.from({length:4},(_,i)=>`seat-${i+1}`);
const roster=Object.fromEntries(SEATS.map(s=>[s,s]));
const STATUS={t:3.5,team:'sharded',you:{unit_id:7,type:'gamma',health:220,x:80,y:30,stack:{item:'sand',amount:10},mining:null},core:{id:1,health:4000,max_health:4000,items:{copper:300,sand:40}},chat:{seq:2,t:3,from:'seat-2',to:[],text:'drills at 80,36',data:null},wake_head:2};
const {wake_head:_wake,...baseShown}=STATUS;
const readiness={required:true,registered:true,ready_count:4,expected_count:4};
const SHOWN={...baseShown,readiness};

function fixture(respond=()=>({}),settings={video:{record:false}}){
  const calls=[];
  const logged=[];
  const engine={boot:async()=>{},close:async()=>{},call:async(path,args)=>{calls.push([path,args]);if(path==='/status')return STATUS;return respond(path,args);},

    async tool(path,args){try{return {result:await this.call(path,args),status:STATUS};}catch(error){if(error instanceof NativeInputError)error.seatStatus=STATUS;throw error;}}};
  const renderer={boot:async()=>({}),start:async()=>{},stop:async()=>({complete:true}),close:async()=>{}};
  const evidence=mkdtempSync(join(tmpdir(),'mindustry-os-test-'));
  const backend=new Backend({engine,renderer,evidence,roster,settings,log:entry=>logged.push(entry)});
  const boot=backend.boot.bind(backend);backend.boot=async()=>{scriptedEvidence(evidence,backend.settings,backend.seats);await boot();for(const seat of backend.seats)backend.registerReady(seat);};
  return {backend,calls,engine,evidence,logged};
}
async function running(f){
  await f.backend.boot();
  f.backend.start();await f.backend.beginPromise;
  return f.backend;
}

test('the legacy lobby cannot abandon a match once native start is in flight',async()=>{
  let enteredStart,finishStart;
  const entered=new Promise(resolve=>{enteredStart=resolve;});
  const released=new Promise(resolve=>{finishStart=resolve;});
  const f=fixture(async path=>{
    if(path==='/start') { enteredStart();await released;return {clock:'running'}; }
    return {};
  });
  await f.backend.boot();
  const starting=f.backend.start();
  await entered;
  try {
    assert.equal(f.backend.started,false,'the native start response is still pending');
    assert.equal(f.backend.abandon('legacy lobby expired'),false);
    assert.equal(f.backend.abandoned,undefined);
    assert.notEqual(f.backend.status(),'not_started','the app must not settle an unplayed result');
  } finally { finishStart();await starting; }
  assert.equal(f.backend.started,true);
  assert.equal(f.backend.status(),'running');
  assert.equal(f.calls.filter(([path])=>path==='/start').length,1);
});

test('settings carry all_chat to native setup and default it off',async()=>{
  assert.equal(validateSettings({}).all_chat,false);
  assert.throws(()=>validateSettings({all_chat:'yes'}),/all_chat/);
  const f=fixture(()=>({}),{...DEFAULTS,game_mode:'survival',all_chat:true,video:{record:false}});
  await f.backend.boot();
  assert.equal(f.calls[0][0],'/setup');assert.equal(f.calls[0][1].all_chat,true);assert.equal(f.calls[0][1].game_mode,'survival');
  assert.equal('lobby_sec' in f.calls[0][1],false,'the app keeps its own lobby_sec from the engine');
  assert.equal(f.calls[0][1].save_interval_sec,60,'the engine saves the game every minute unless the launch says otherwise');
  assert.equal(validateSettings({save_interval_sec:0}).save_interval_sec,0,'0 saves only at the end');
  for(const save_interval_sec of [-1,1.5,'60',null])assert.throws(()=>validateSettings({save_interval_sec}),/save_interval_sec must be a whole number of seconds/);
});

test('tools are the five verbs; say offers "all" only when enabled',async()=>{
  assert.deepEqual(toolsFor({}).map(t=>t.name),['query','events','act','say','wake']);
  const audience=settings=>toolsFor(settings).find(t=>t.name==='say').inputSchema.properties.audience.enum;
  assert.deepEqual(audience({all_chat:false}),['team','self']);
  assert.deepEqual(audience({all_chat:true}),['team','self','all']);
  assert.equal(toolsFor({}).find(t=>t.name==='act').inputSchema.properties.ops.items.properties.op.enum.includes('tap'),false);
  const f=fixture();await running(f);
  assert.deepEqual(f.backend.tools('seat-1').map(t=>t.name),['ready','query','events','act','say','wake']);
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
  assert.deepEqual(unbooted.status,{phase:'waiting',t:null,team:null,you:null,core:null,chat:null,readiness:{...readiness,registered:false,ready_count:0}});
  await f.backend.boot();
  const lobby=await f.backend.observe('seat-1');
  assert.deepEqual(lobby.status,{phase:'waiting',...SHOWN},'seats see their team and core while they wait');
  f.backend.start();await f.backend.beginPromise;
  assert.equal(f.backend.started,true);
  const during=await f.backend.observe('seat-1');
  assert.deepEqual(during.status,{phase:'running',...SHOWN});
  assert.deepEqual(during.wake_key,{phase:'running',wake_head:2});
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
  assert.deepEqual(journal.filter(e=>e.value.type!=='agent_ready').map(e=>e.value.type),['setup','started','say','act']);
  assert.deepEqual(f.logged.filter(e=>e.type!=='agent_ready').map(e=>e.type),['setup','started','say','act']);
  assert.equal(f.logged.find(e=>e.type==='say').seat,'seat-1');assert.equal(f.logged.find(e=>e.type==='say').summary,'seat-1 says: hi');
});

test('the native terminal finishes the match once recordings are final; a failed camera is kept in the video entry and fails nothing',async()=>{
  const f=fixture(()=>({}),{time_limit_sec:null,video:{record:false}});await running(f);
  const perSeat={'seat-1':{status:'failed',error:'seat-1 control: transport failure'},'seat-2':{status:'stopped'},'seat-3':{status:'stopped'},'seat-4':{status:'stopped'}};
  f.backend.renderer.stop=async()=>({type:'video',complete:false,per_seat:perSeat,error:'seat-1 native recorder failed: seat-1 control: transport failure'});
  f.backend.renderHandle={};
  f.engine.call=async(path)=>path==='/state'?{terminal:{seat_teams:Object.fromEntries(SEATS.map(s=>[s,'sharded'])),reason:'core_destroyed',elapsed_seconds:18000}}:{};
  await f.backend.tick();
  assert.equal(f.backend.failure,null);
  assert.deepEqual([f.backend.status(),f.backend.phase(),f.backend.terminal.reason],['completed','over','core_destroyed']);
  assert.deepEqual(f.logged.filter(e=>e.type!=='agent_ready').map(e=>e.type).slice(-2),['video','game_ended'],'the video entry, then the end');
  const video=f.logged.at(-2);
  assert.deepEqual([video.complete,video.per_seat,video.summary],[false,perSeat,'Seat video incomplete']);
  assert.equal((await f.backend.call('seat-1','act',{ops:[{op:'plan_clear'}]})).ok,false);
});

test('a terminal waits for running calls, then completes and stays complete',async()=>{
  const f=fixture(()=>({}),{time_limit_sec:null,video:{record:false}});await running(f);

  const FINAL={...STATUS,t:600,you:null,core:null,chat:{...STATUS.chat,seq:3,text:'core is down'},wake_head:3};
  f.engine.call=async(path)=>path==='/state'?{terminal:{reason:'core_destroyed',elapsed_seconds:600}}:path==='/status'?FINAL:{};
  f.backend.inflight=1;
  assert.equal(await f.backend.tick(),true);
  assert.equal(f.backend.status(),'running','a call still running holds the finish');

  assert.equal(f.backend.phase(),'ending');
  const engineCalls=[];f.engine.tool=async(path)=>{engineCalls.push(path);return {result:{},status:FINAL};};
  for(const name of ['act','say','query'])assert.deepEqual(await f.backend.call('seat-1',name,{}),{ok:false,error:'The match has ended and is recording its result; POST /wait returns once the game is over.'});
  assert.deepEqual(engineCalls,[]);
  f.backend.inflight=0;
  await f.backend.tick();
  assert.equal(f.backend.status(),'completed');
  assert.equal(f.backend.phase(),'over');
  const over=(await f.backend.observe('seat-1')).status;
  assert.deepEqual([over.phase,over.result],['over',{reason:'core_destroyed',elapsed_seconds:600}],'the status says how it ended');
  const {wake_head:_final,...finalShown}=FINAL;
  assert.deepEqual(over,{phase:'over',...finalShown,readiness:{required:true,registered:true,ready_count:4,expected_count:4},result:over.result},'and reads the final native state, not a cached one');
  assert.equal(await f.backend.tick(),false);
  assert.deepEqual(f.logged.filter(e=>e.type!=='agent_ready').map(e=>e.type).slice(-1),['game_ended']);
});

test('endless post-terminal cleanup errors preserve native completion as ancillary evidence',async()=>{
  const f=fixture();let nativeExited;
  f.engine.exit=new Promise(resolve=>{nativeExited=resolve;});
  await running(f);

  f.backend.settings.endless_survival={};
  f.backend.renderHandle={};
  f.backend.renderer.stop=async()=>{throw new Error('thumbnail finalization failed');};
  const terminal={reason:'core_destroyed',elapsed_simulation_seconds:2400};
  f.engine.call=async(path)=>{if(path==='/state')return {terminal};if(path==='/stop'){nativeExited('engine already exited after native terminal');await Promise.resolve();throw new Error('engine already exited after native terminal');}return {};};
  await f.backend.tick();
  assert.equal(f.backend.failure,null);
  assert.equal(f.backend.status(),'completed');
  assert.deepEqual(f.backend.terminal,terminal);
  const ancillary=JSON.parse(readFileSync(join(f.evidence,'ancillary-errors.json')));
  assert.deepEqual(ancillary.errors.map(e=>e.stage),['engine_stop','recording_finalization']);
  assert.ok(ancillary.errors.every(e=>e.after_native_terminal));
});

test('optional final-summary failure is ancillary only after an endless native terminal',async()=>{
  const f=fixture();await running(f);
  f.backend.settings.endless_survival={};
  const save=f.backend.save.bind(f.backend);
  f.backend.save=(name,value)=>{if(name==='final-summary.json')throw new Error('optional summary is not writable');save(name,value);};
  const terminal={reason:'core_destroyed',elapsed_simulation_seconds:2400};
  await f.backend.finish(terminal);
  assert.deepEqual(f.backend.terminal,terminal);
  assert.equal(f.backend.failure,null);
  assert.equal(f.backend.status(),'completed');
  const ancillary=JSON.parse(readFileSync(join(f.evidence,'ancillary-errors.json')));
  assert.deepEqual(ancillary.errors.map(e=>e.stage),['final_summary']);
  assert.equal(ancillary.errors[0].after_native_terminal,true);
});

test('video.seats resolves to the camera seats; only per-seat game clients can leave seats without one',async()=>{
  const subset=fixture(()=>({}),{video:{record:false,seats:1}});
  assert.deepEqual(subset.backend.settings.video.seats,['seat-1']);
  await assert.rejects(subset.backend.boot(),/video.seats needs the per-seat game clients/);
  assert.deepEqual(fixture().backend.settings.video.seats,SEATS);
});

test('a malformed call the plugin rejects is marked invalid; one it refuses as the game stands is not',async()=>{
  const f=fixture((path,args)=>{if(args.of==='tanks')throw new NativeInputError('of: "tanks" is not one of collections',null,true);if(path==='/events')throw new NativeInputError('The reader "chat" already has another filter; use a different cursor name');return {};});
  await running(f);
  assert.deepEqual(await f.backend.call('seat-1','query',{of:'tanks'}),{ok:false,error:'of: "tanks" is not one of collections',invalid:true,status:{phase:'running',...SHOWN}});
  assert.equal((await f.backend.call('seat-1','events',{cursor:'chat'})).invalid,false);
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
  const f=fixture();await running(f);
  await f.backend.observe('seat-1');
  await f.backend.finish({reason:'core_destroyed',elapsed_seconds:600});
  f.engine.call=async()=>{throw new NativeTransportError(new TypeError('fetch failed'));};
  const final=(await f.backend.observe('seat-1')).status;
  assert.deepEqual([final.phase,final.you,final.result.reason],['over',STATUS.you,'core_destroyed']);
  assert.equal(f.backend.failure,null);
  f.engine.call=async()=>{f.backend.nativeExited=true;throw new Error('Native process exited during the status request');};
  assert.deepEqual((await f.backend.observe('seat-1')).status,final);
  assert.equal(f.backend.failure,null);
});
