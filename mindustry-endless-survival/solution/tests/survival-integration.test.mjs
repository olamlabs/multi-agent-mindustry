import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {grade} from '../../environment/sim/grade.mjs';
import {completion} from './fixtures/completion.mjs';
import {metrics} from '../../environment/sim/metrics.mjs';
import {readGame} from '../../environment/sim/verify.mjs';
import {gradeEndlessSurvival} from '../../environment/sim/survival-grade.mjs';
import {nativeFixture,writeNativeEvidence} from './fixtures/survival-fixtures.mjs';

test('endless native survival gives the identical per-seat reward, independent of wall time', () => {
  const input = nativeFixture(2100, 0.75);
  input.result.terminal.elapsed_seconds = input.terminal.elapsed_seconds = 99_999;
  const reward = grade(input);

  assert.equal(reward.reward, 35);
  for (const seat of input.setup.seats) assert.equal(reward[seat], 35);
  assert.equal(reward.clearance_minutes, 23.25);
  assert.equal(reward.completed, 1);
  assert.equal(reward.survival_seconds, 2100);
  assert.equal(reward.survival_minutes, 35);
  assert.equal(reward.clearance, 0.75);
  assert.deepEqual(completion(input), {complete: true});
});

test('a living match stays pending even if no agent process remains; no premature reward', () => {
  const input = nativeFixture();
  input.result = null;
  input.event = null;
  input.terminal = null;
  assert.deepEqual(completion(input), {complete: false});
  assert.throws(() => grade(input), /unscored/);
});

test('censored or contradictory result fails the probe and verifier instead of scoring zero', () => {
  for (const change of [input => {input.result.terminal.reason = 'time_limit';}, input => {input.result.failure = 'engine crashed';}, input => {input.event.simulation_tick++;}, input => {input.readiness = null;}]) {
    const input = nativeFixture();
    change(input);
    assert.throws(() => completion(input));
    assert.throws(() => grade(input));
  }
});

test('legacy finite survival is rejected', () => {
  const input = {setup:{seats:['seat-1'],settings:{game_mode:'survival',time_limit_sec:600}}, result:{started:true,terminal:{elapsed_seconds:300,reason:'core_destroyed',waves_completed:2}}};
  assert.throws(()=>grade(input),/Only endless survival/);
  assert.throws(() => completion(input), /requires its configured scenario/);
});

test('the real verifier and completion CLIs consume native receipts and fail a censored terminal', async () => {
  for (const censored of [false,true]) {
    const dir = mkdtempSync(join(tmpdir(),'survival-cli-'));
    mkdirSync(join(dir,'engine'));
    const input = nativeFixture(2100.125);
    if (censored) input.result.terminal.survival_censored = true;
    writeNativeEvidence(dir,input);
    const rewardPath=join(dir,'verifier/reward.json');
    const invoke=(name,args)=>spawnSync(process.execPath,[fileURLToPath(new URL(name==='completion'?'./fixtures/completion.mjs':`../../environment/sim/${name}.mjs`,import.meta.url)),...args],{encoding:'utf8',timeout:5000});
    const probe=invoke('completion',[dir]);
    const verified=invoke('verify',[dir,rewardPath]);
    const diagnostic=await metrics(dir);
    assert.equal(diagnostic.native_outcome.completed,!censored);
    assert.equal(diagnostic.native_outcome.survival_score.score_seconds,censored?null:2100.125);
    assert.equal(diagnostic.production.status,'unavailable');
    if (censored) {
      assert.notEqual(probe.status,0);
      assert.notEqual(verified.status,0);
      assert.equal(existsSync(rewardPath),false);
      assert.equal(JSON.parse(readFileSync(join(dir,'survival-outcome.json'))).status,'invalid');
    } else {
      assert.equal(probe.status,0,probe.stderr);
      assert.deepEqual(JSON.parse(probe.stdout),{complete:true});
      assert.equal(verified.status,0,verified.stderr);
      const written=JSON.parse(readFileSync(rewardPath));
      assert.deepEqual(Object.keys(written).sort(),["reward",...input.setup.seats].sort());
      const outcome=JSON.parse(readFileSync(join(dir,"survival-outcome.json")));
      assert.equal(outcome.score_seconds,2100.125);
      assert.equal(written['seat-20'],written.reward);
      assert.equal(written.reward,2100.125/60);
      assert.equal(outcome.clearance_minutes,0.75*(2100.125*60-14400)/3600);
    }
  }
});

test('entry reader cannot bypass duplicate-key or bounded-size receipt validation',()=>{
  const dir=mkdtempSync(join(tmpdir(),'survival-strict-entry-'));
  try {
    const input=nativeFixture();writeNativeEvidence(dir,input);
    const result=join(dir,'result.json');
    writeFileSync(result,readFileSync(result,'utf8').replace('"started":true','"started":false,"started":true'));
    const invalid=readGame(dir);
    assert.ok(invalid.evidence_read_errors.some(error=>error.code==='duplicate_json_key'));
    assert.equal(gradeEndlessSurvival(invalid).status,'invalid');
    writeNativeEvidence(dir,input);
    writeFileSync(join(dir,'setup.json'),JSON.stringify({...input.setup,extra:'x'.repeat(1024*1024)}));
    assert.throws(()=>readGame(dir),/setup.json: oversized/);
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('failed verifier rerun removes stale rewards before input parsing or grading',()=>{
  const dir=mkdtempSync(join(tmpdir(),'survival-rerun-'));
  const input=nativeFixture(),reward=join(dir,'verifier/reward.json'),outcome=join(dir,'survival-outcome.json');
  const run=()=>spawnSync(process.execPath,[fileURLToPath(new URL('../../environment/sim/verify.mjs',import.meta.url)),dir,reward],{encoding:'utf8',timeout:5000});
  try {
    for(const malformed of [false,true]) {
      writeNativeEvidence(dir,input);
      const good=run();assert.equal(good.status,0,good.stderr);assert.deepEqual(JSON.parse(readFileSync(reward)),{reward:35,...Object.fromEntries(input.setup.seats.map(seat=>[seat,35]))});
      if(malformed) writeFileSync(join(dir,'setup.json'),'{malformed');
      else writeFileSync(join(dir,'result.json'),JSON.stringify({...input.result,failure:'critical preterminal failure'}));
      const failed=run();assert.notEqual(failed.status,0);assert.equal(existsSync(reward),false);
      if(malformed) assert.equal(existsSync(outcome),false);
      else assert.equal(JSON.parse(readFileSync(outcome)).status,'invalid');
    }
  } finally {rmSync(dir,{recursive:true,force:true});}
});
