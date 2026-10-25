import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {startApp} from './fixtures/app-process.mjs';
import {scriptedEvidence} from './fixtures/survival-fixtures.mjs';
import {Backend} from '../../environment/sim/backend.mjs';

const main=fileURLToPath(new URL('./fixtures/fake-match.mjs',import.meta.url));
const seats=Array.from({length:20},(_,i)=>`seat-${i+1}`);
const settings={game_mode:'survival',time_limit_sec:null,agent_ready_required:true,lobby_sec:30,video:{record:false,seats:0}};
const receipt=app=>JSON.parse(app.file('agent-readiness.json'));
async function open(t,{overrides={},env={}}={}) {
  const app=await startApp({main,seats,settings:{...settings,...overrides},env});
  t.after(()=>app.stop());
  await app.until(()=>app.healthy(),{what:'health'});
  return app;
}
const phase=async app=>(await app.seat('seat-1').get('/update')).status.phase;

test('all 20 authenticated agents register, including seats without cameras; reads do not register',async t=>{
  const app=await open(t);
  assert.equal(await phase(app),'waiting');
  const index=await app.seat('seat-1').get('/');
  assert.ok(index.endpoints.some(endpoint=>endpoint.path==='/ready'));
  const initial=await app.seat('seat-1').post('/query',{of:'units'});
  assert.equal(initial.status.t,0,'reading the initial world does not advance the game');
  assert.equal(receipt(app).ready_seats.length,0,'health, discovery and queries are not agent acknowledgments');
  const spoofed=await app.seat('seat-1').request('/ready',{method:'POST',body:{seat:'seat-20'}});
  assert.equal(spoofed.status,400,'the authenticated seat cannot acknowledge another agent');
  assert.equal((await app.request('/ready',{method:'POST',body:{}})).status,401);
  assert.equal(receipt(app).ready_seats.length,0);
  for(const seat of seats.slice(0,-1)) {
    const answer=await app.seat(seat).post('/ready');
    assert.equal(answer.registered,true);
    assert.equal(answer.expected_count,20);
    assert.equal(answer.status.phase,'waiting');
  }
  assert.deepEqual(receipt(app).pending_seats,['seat-20']);
  assert.equal((await app.seat('seat-1').request('/act',{method:'POST',body:{ops:[{op:'plan_clear'}]}})).status,409);
  const firstAck=receipt(app).acknowledgments['seat-1'];
  await app.seat('seat-1').post('/ready');
  assert.deepEqual(receipt(app).acknowledgments['seat-1'],firstAck,'an idempotent acknowledgment preserves the original receipt');
  assert.equal(app.log().filter(entry=>entry.type==='agent_ready').length,19);

  await app.seat('seat-20').get('/update');
  const waiting=app.seat('seat-20').post('/wait?timeout_sec=3');
  const last=await app.seat('seat-20').post('/ready');
  assert.equal(last.ready_count,20);
  assert.equal((await waiting).status.phase,'running');
  const evidence=receipt(app);
  assert.equal(evidence.state,'started');
  assert.deepEqual(evidence.expected_seats,seats);
  assert.deepEqual(evidence.ready_seats,seats);
  assert.deepEqual(evidence.pending_seats,[]);
  assert.equal(evidence.failure,null);
  for(const key of ['all_agents_ready_at','cameras_ready_at','native_start_requested_at','native_started_at']) assert.ok(Number.isFinite(Date.parse(evidence[key])),key);
  assert.equal(evidence.native_start.clock,'running');
  assert.ok(evidence.native_start.survival_start);
  const journal=app.file('journal.jsonl').trim().split('\n').map(JSON.parse);
  const started=journal.find(entry=>entry.value.type==='started');
  assert.ok(Object.values(evidence.acknowledgments).every(ack=>ack.journal_sequence<started.sequence));
  assert.equal((await app.seat('seat-20').post('/ready')).registered,true,'retry after start remains idempotent');
  assert.equal(app.log().filter(entry=>entry.type==='agent_ready').length,20);
});

test('a missing agent waits beyond the legacy lobby cutoff, then starts after its acknowledgment',async t=>{
  const app=await open(t,{overrides:{lobby_sec:1}});
  await Promise.all(seats.slice(0,-1).map(seat=>app.seat(seat).post('/ready')));
  await new Promise(resolve=>setTimeout(resolve,1200));
  assert.equal(app.file('result.json'),null,'no extra app deadline ends preparation');
  assert.equal(await phase(app),'waiting');
  assert.equal(receipt(app).state,'waiting');
  assert.deepEqual(receipt(app).pending_seats,['seat-20']);
  assert.equal(receipt(app).native_started_at,null);
  assert.equal(app.log().some(entry=>entry.type==='started'),false);
  await app.seat('seat-20').post('/ready');
  await app.until(async()=>(await phase(app))==='running',{what:'last agent starts play'});
  assert.equal(receipt(app).state,'started');
});

test('all agent acknowledgments keep waiting for cameras beyond the legacy lobby cutoff',async t=>{
  const app=await open(t,{overrides:{lobby_sec:1},env:{FAKE_NO_CLIENTS:'1'}});
  await Promise.all(seats.map(seat=>app.seat(seat).post('/ready')));
  assert.equal(await phase(app),'waiting');
  assert.equal(receipt(app).state,'ready');
  await new Promise(resolve=>setTimeout(resolve,1200));
  assert.equal(app.file('result.json'),null);
  assert.equal(await phase(app),'waiting');
  assert.deepEqual(receipt(app).pending_seats,[]);
  assert.equal(receipt(app).native_start_requested_at,null);
  assert.equal(app.log().some(entry=>entry.type==='started'),false);
});

test('readiness cannot be disabled for endless survival',async()=>{
  await assert.rejects(startApp({main,seats,settings:{...settings,agent_ready_required:false}}),/agent_ready_required/);
});

test('the complete barrier receipt is saved before native start, and a camera-start failure cannot later start play',async t=>{
  const make=async()=>{
    const evidence=mkdtempSync(join(tmpdir(),'mindustry-readiness-'));t.after(()=>rmSync(evidence,{recursive:true,force:true}));
    const calls=[];
    const engine={boot:async()=>{},close:async()=>{},call:async(path,args)=>{
      calls.push(path);
      if(path==='/setup') assert.equal('agent_ready_required' in args,false,'app-only field is stripped before native setup');
      if(path==='/start') {
        const saved=JSON.parse(readFileSync(join(evidence,'agent-readiness.json'),'utf8'));
        assert.equal(saved.state,'ready');assert.deepEqual(saved.pending_seats,[]);
        assert.ok(saved.cameras_ready_at);assert.ok(saved.native_start_requested_at);assert.equal(saved.native_started_at,null);
      }
      return {};
    }};
    const renderer={alwaysBoot:true,boot:async()=>({}),start:async()=>{},stop:async()=>({}),close:async()=>{}};
    const backend=new Backend({engine,renderer,evidence,roster:Object.fromEntries(seats.map(seat=>[seat,{}])),settings});
    scriptedEvidence(evidence,backend.settings,seats);
    await backend.boot();
    return {backend,calls,renderer,evidence};
  };
  const good=await make();
  const starting=good.backend.start();
  for(const seat of seats) await good.backend.call(seat,'ready',{});
  await starting;
  assert.equal(good.backend.started,true);
  assert.equal(good.calls.filter(path=>path==='/start').length,1);
  assert.equal(good.calls.includes('/ready'),false,'readiness never invokes a native endpoint');
  const successfulReceipt=readFileSync(join(good.evidence,'agent-readiness.json'),'utf8');
  good.backend.fail('recorder finalization failed after native core loss');
  assert.equal(readFileSync(join(good.evidence,'agent-readiness.json'),'utf8'),successfulReceipt,'a later artifact failure cannot rewrite successful startup evidence');
  assert.match(readFileSync(join(good.evidence,'failure.json'),'utf8'),/recorder finalization failed/);

  const failedBefore=await make();
  const preparing=failedBefore.backend.start();
  failedBefore.backend.fail('provider startup failed');
  await preparing;
  assert.equal(failedBefore.calls.includes('/start'),false,'startup failure releases the readiness wait without starting play');

  const late=await make();
  let finishCamera,enteredCamera;
  const cameraEntered=new Promise(resolve=>{enteredCamera=resolve;});
  late.renderer.start=async()=>{enteredCamera();await new Promise(resolve=>{finishCamera=resolve;});};
  for(const seat of seats) await late.backend.call(seat,'ready',{});
  const blocked=late.backend.start();
  await cameraEntered;
  late.backend.fail('camera preparation failed');
  finishCamera();
  await blocked;
  assert.equal(late.backend.started,false);
  assert.equal(late.calls.includes('/start'),false);
  assert.match(late.backend.failure,/camera preparation failed/);
});
