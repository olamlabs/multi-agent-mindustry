import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {readEndlessEvidence,readNativeSurvival,SURVIVAL_EVIDENCE_FILES,MAX_SURVIVAL_EVIDENCE_BYTES,MAX_SURVIVAL_LINE_BYTES} from '../../environment/sim/survival-evidence.mjs';
import {gradeEndlessSurvival} from '../../environment/sim/survival-grade.mjs';
import {nativeFixture,stoppedFixture,nativeRecords,writeNativeEvidence,clone} from './fixtures/survival-fixtures.mjs';

function withEvidence(fn,seconds=2100) {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'survival-evidence-'));
  const native=nativeFixture(seconds);writeNativeEvidence(directory,native);
  try{return fn(directory,native);}finally{fs.rmSync(directory,{recursive:true,force:true});}
}
const saveRows=(dir,rows)=>fs.writeFileSync(path.join(dir,SURVIVAL_EVIDENCE_FILES.native),rows.map(row=>JSON.stringify(row)+'\n').join(''));
const resequence=rows=>rows.map((row,i)=>({...row,sequence:i+1}));
test('native evidence rejects a wave-version selector before grading',()=>withEvidence((dir,native)=>{
  for(const version of [1,2,3]) {
    const rows=clone(nativeRecords(native));rows[0].data.profile.version=version;
    saveRows(dir,rows);
    assert.equal(readNativeSurvival(dir).evidence_read_errors[0]?.code,'native_profile');
    assert.equal(gradeEndlessSurvival(readEndlessEvidence(dir)).status,'invalid');
  }
}));
test('Spawn receipt consistency is checked without reinterpreting raw health as effective durability',()=>withEvidence((dir,native)=>{
  const rows=nativeRecords(native);rows[0].data.profile.enemy_unit_health_multiplier=3.1;
  for(const row of rows)if(row.event==='survival_wave')row.data.enemy_team_rule.unit_health_multiplier=Math.fround(3.1);
  saveRows(dir,rows);assert.deepEqual(readNativeSurvival(dir).evidence_read_errors,[]);
}));
for(const [name,change]of Object.entries({
  'missing observations':row=>delete row.spawned_units,
  'missing actual counts':row=>delete row.spawned,
  'missing per-type observation':row=>delete row.spawned_units.dagger,
  'fractional count':row=>row.spawned.dagger=4.5,
  'count disagreement':row=>row.spawned_units.dagger.count=3,
  'negative shields':row=>row.spawned_units.dagger.shield_min=-1,
  'nonfinite health':row=>row.spawned_units.dagger.raw_health_total=null,
  'zero living-unit health':row=>{row.spawned_units.dagger.raw_health_total=0;row.spawned_units.dagger.raw_max_health_total=0;},
  'health exceeds raw max':row=>row.spawned_units.dagger.raw_health_total=700,
  'shield summary disagreement':row=>row.spawned_units.dagger.shield_total=1,
  'wrong team damage multiplier':row=>row.enemy_team_rule.unit_damage_multiplier=2,
  'wrong sample phase':row=>row.spawn_observation='before_group_shields',
  'missing cumulative counts':row=>delete row.cumulative_spawned,
  'cumulative reset':row=>row.cumulative_spawned.dagger=4,
  'extra cumulative type':row=>row.cumulative_spawned.flare=1,
}))test(`Spawn receipts reject ${name}`,()=>withEvidence((dir,native)=>{
  const rows=nativeRecords(native);change(rows[3].data);saveRows(dir,rows);
  assert.equal(readNativeSurvival(dir).evidence_read_errors[0]?.code,'native_spawn_observation');
}));
test('Wave evidence accepts spawned units equal to the plan at the native budget strength',()=>withEvidence((dir,native)=>{
  saveRows(dir,nativeRecords(native));assert.deepEqual(readNativeSurvival(dir).evidence_read_errors,[]);
}));
for(const [name,change]of Object.entries({
  'a budget off the native schedule':row=>row.budget*=1.01,
  'spawns that differ from the plan':row=>row.planned_units={dagger:5},
  'a missing plan':row=>delete row.planned_units,
  'realized strength below the budget':row=>row.realized_strength=row.budget*0.99,
  'a negative planned shield':row=>row.planned_shield=-1,
}))test(`Wave evidence rejects ${name}`,()=>withEvidence((dir,native)=>{
  const rows=nativeRecords(native);change(rows[3].data);saveRows(dir,rows);
  assert.equal(readNativeSurvival(dir).evidence_read_errors[0]?.code,'native_budget_observation');
}));
test('reader streams native envelopes, retains four receipts and binds the file bytes',()=>withEvidence(dir=>{
  fs.writeFileSync(path.join(dir,'engine/events.jsonl'),'not JSON\n'.repeat(50000));
  fs.writeFileSync(path.join(dir,'journal.jsonl'),'not JSON');
  const loaded=readEndlessEvidence(dir);
  assert.deepEqual(loaded.evidence_read_errors,[]);
  assert.equal(loaded.evidence_files.length,4);
  assert.equal(gradeEndlessSurvival(loaded).score_seconds,2100);
  assert.equal(loaded.start.event,'survival_start');
  assert.equal(loaded.readiness.native_start.survival_start.event,undefined);
  for(const receipt of loaded.evidence_files){
    assert.ok(Object.values(SURVIVAL_EVIDENCE_FILES).includes(receipt.path));
    const bytes=fs.readFileSync(path.join(dir,receipt.path));
    assert.equal(receipt.bytes,bytes.length);
    assert.equal(receipt.sha256,createHash('sha256').update(bytes).digest('hex'));
  }
}));
test('native setup alone can be consumed during backend boot',()=>withEvidence((dir,native)=>{
  saveRows(dir,nativeRecords(native).slice(0,1));
  const loaded=readNativeSurvival(dir);
  assert.deepEqual(loaded.evidence_read_errors,[]);assert.deepEqual(loaded.nativeSetup,native.nativeSetup);
  assert.equal(loaded.start,null);assert.equal(loaded.terminal,null);
}));
test('callback supplies setup/result before files exist',()=>withEvidence((dir,native)=>{
  fs.unlinkSync(path.join(dir,'setup.json'));fs.unlinkSync(path.join(dir,'result.json'));
  const loaded=readEndlessEvidence(dir,{setup:native.setup,result:native.result});
  assert.deepEqual(loaded.evidence_read_errors,[]);assert.equal(gradeEndlessSurvival(loaded).status,'valid');
  assert.equal(loaded.evidence_files.filter(r=>r.source==='provided').length,2);
}));
test('no native death and terminal is incomplete only while the app also has no terminal',()=>withEvidence((dir,native)=>{
  saveRows(dir,nativeRecords(native).filter(row=>!['last_friendly_core_destroyed','survival_terminal'].includes(row.event)));
  const live=readEndlessEvidence(dir,{result:{started:true,terminal:null}});
  assert.deepEqual(live.evidence_read_errors,[]);assert.equal(gradeEndlessSurvival(live).status,'incomplete');
  assert.equal(gradeEndlessSurvival(readEndlessEvidence(dir,{result:native.result})).status,'invalid');
}));
for(const key of ['setup','result','native','readiness'])test(`missing required ${key} is a structured invalid outcome`,()=>withEvidence(dir=>{
  fs.unlinkSync(path.join(dir,SURVIVAL_EVIDENCE_FILES[key]));
  const loaded=readEndlessEvidence(dir);
  assert.ok(loaded.evidence_read_errors.some(e=>e.field===key&&e.code==='ENOENT'));
  assert.equal(gradeEndlessSurvival(loaded).status,'invalid');
}));
test('malformed native record never masquerades as missing live-game evidence',()=>withEvidence(dir=>{
  fs.appendFileSync(path.join(dir,SURVIVAL_EVIDENCE_FILES.native),'{malformed\n');
  const loaded=readEndlessEvidence(dir,{result:{started:true,terminal:null}});
  assert.ok(loaded.evidence_read_errors.some(e=>e.code==='invalid_json'));
  assert.equal(gradeEndlessSurvival(loaded).status,'invalid');
}));
test('oversized small evidence is rejected before parsing',()=>withEvidence(dir=>{
  fs.truncateSync(path.join(dir,'agent-readiness.json'),MAX_SURVIVAL_EVIDENCE_BYTES+1);
  const loaded=readEndlessEvidence(dir);
  assert.ok(loaded.evidence_read_errors.some(e=>e.field==='readiness'&&e.code==='oversized'));
  assert.equal(gradeEndlessSurvival(loaded).score_seconds,null);
}));
test('native log can exceed the small-file limit while retained data stay bounded',()=>withEvidence(dir=>{
  assert.ok(fs.statSync(path.join(dir,SURVIVAL_EVIDENCE_FILES.native)).size>MAX_SURVIVAL_EVIDENCE_BYTES);
  const loaded=readEndlessEvidence(dir);
  assert.deepEqual(loaded.evidence_read_errors,[]);assert.equal(loaded.waves,undefined);
  assert.ok(JSON.stringify(loaded).length<40000);
  assert.equal(gradeEndlessSurvival(loaded).status,'valid');
},(14400+2000*7200)/60));
test('a single oversized native line is rejected without loading the rest',()=>withEvidence(dir=>{
  fs.writeFileSync(path.join(dir,SURVIVAL_EVIDENCE_FILES.native),' '.repeat(MAX_SURVIVAL_LINE_BYTES+1)+'\n');
  const loaded=readNativeSurvival(dir);
  assert.equal(loaded.evidence_read_errors[0].code,'oversized_line');
}));
test('symlinked native evidence is rejected',()=>withEvidence(dir=>{
  const file=path.join(dir,SURVIVAL_EVIDENCE_FILES.native);fs.unlinkSync(file);fs.symlinkSync('../result.json',file);
  const loaded=readEndlessEvidence(dir);
  assert.ok(loaded.evidence_read_errors.some(e=>e.field==='native'&&e.code==='not_regular_file'));
  assert.equal(gradeEndlessSurvival(loaded).score_seconds,null);
}));
test('directory instead of a receipt is rejected',()=>withEvidence(dir=>{
  const file=path.join(dir,'result.json');fs.unlinkSync(file);fs.mkdirSync(file);
  assert.ok(readEndlessEvidence(dir).evidence_read_errors.some(e=>e.field==='result'&&e.code==='not_regular_file'));
}));
const corruptions={
  'wrong schema':rows=>{rows[0].schema='wrong';},
  'sequence starts at zero':rows=>{rows[0].sequence=0;},
  'duplicate sequence':rows=>{rows[1].sequence=1;},
  'missing sequence':rows=>{rows[1].sequence=3;},
  'duplicated setup':rows=>rows.splice(1,0,clone(rows[0])),
  'duplicated start':rows=>rows.splice(2,0,clone(rows[1])),
  'duplicated death':rows=>rows.splice(rows.length-1,0,clone(rows.at(-2))),
  'duplicated terminal':rows=>rows.push(clone(rows.at(-1))),
  'missing start':rows=>rows.splice(1,1),
  'death after terminal':rows=>{[rows[rows.length-2],rows[rows.length-1]]=[rows.at(-1),rows.at(-2)];},
  'wave after death':rows=>rows.splice(rows.length-1,0,clone(rows[2])),
  'nonzero start clock':rows=>{rows[1].data.simulation_tick=1;},
  'nonfinite clock':rows=>{rows[2].data.simulation_tick=null;},
  'contradictory wave clock frequency':rows=>{rows[2].data.ticks_per_second=1;},
  'regressing clock':rows=>{rows[3].data.simulation_tick=1;},
  'regressing updates':rows=>{rows[3].data.simulation_updates=0;},
  'impossible first wave updates':rows=>{for(const row of rows)if(row.event==='survival_wave')row.data.simulation_updates=1;},
  'impossible interval updates despite feasible total':rows=>{rows[3].data.simulation_updates=rows[2].data.simulation_updates+1;},
  'wave gap':rows=>{rows[2].data.wave=2;},
  'wrong schedule':rows=>{rows[2].data.scheduled_simulation_tick++;},
  'wave more than one update early':rows=>{rows[2].data.simulation_tick-=5;},
  'wave more than one update late':rows=>{rows[2].data.simulation_tick+=5;},
  'unobserved final wave':rows=>{rows.at(-1).data.waves_spawned++;},
  'wrong terminal next wave':rows=>{rows.at(-1).data.wave++;},
  'unknown event':rows=>{rows[2].event='invented';},
  'event masquerades as data':rows=>{rows[1].data.event='survival_start';},
};
for(const [name,corrupt]of Object.entries(corruptions))test(`native stream rejects ${name}`,()=>withEvidence((dir,native)=>{
  let rows=nativeRecords(native);corrupt(rows);
  if(!name.includes('sequence')) rows=resequence(rows);
  saveRows(dir,rows);
  const loaded=readEndlessEvidence(dir);
  assert.ok(loaded.evidence_read_errors.length>0,name);assert.equal(gradeEndlessSurvival(loaded).status,'invalid');
}));
test('partial final line is rejected even after a complete terminal',()=>withEvidence(dir=>{
  fs.appendFileSync(path.join(dir,SURVIVAL_EVIDENCE_FILES.native),'{');
  assert.equal(readNativeSurvival(dir).evidence_read_errors[0].code,'native_partial_line');
}));
test('a valid stopped log is readable but has no loss score',()=>withEvidence((dir,native)=>{
  native.event=null;native.terminal.reason='stopped';native.terminal.survival_censored=true;
  native.result.terminal=clone(native.terminal);writeNativeEvidence(dir,native);
  const loaded=readEndlessEvidence(dir);assert.deepEqual(loaded.evidence_read_errors,[]);
  assert.equal(gradeEndlessSurvival(loaded).status,'invalid');
}));
test('a living-core stopped log is natively censored and unscored',()=>withEvidence(dir=>{
  writeNativeEvidence(dir,stoppedFixture());const loaded=readEndlessEvidence(dir);
  assert.deepEqual(loaded.evidence_read_errors,[]);assert.equal(gradeEndlessSurvival(loaded).status,'censored');assert.equal(gradeEndlessSurvival(loaded).score_seconds,null);
}));
for(const omit of ['all','last'])test(`missing ${omit} scheduled waves cannot gain survival credit`,()=>withEvidence((dir,native)=>{
  const remaining=omit==='all'?0:native.terminal.waves_spawned-1;
  for(const value of [native.event,native.terminal]){value.waves_spawned=remaining;value.wave=remaining+1;}
  native.result.terminal=clone(native.terminal);writeNativeEvidence(dir,native);
  const loaded=readEndlessEvidence(dir);assert.ok(loaded.evidence_read_errors.some(e=>e.code==='native_wave_missing'));
  assert.equal(gradeEndlessSurvival(loaded).score_seconds,null);
}));
for(const [offset,accepted] of [[-0.5,true],[0,true],[3.999,true],[4,true],[4.001,false]])test(`missing wave at terminal schedule offset ${offset} respects one-update boundary`,()=>withEvidence((dir,native)=>{
  native=stoppedFixture((14400+offset)/60);native.terminal.waves_spawned=0;native.terminal.wave=1;native.result.terminal=clone(native.terminal);writeNativeEvidence(dir,native);
  const loaded=readEndlessEvidence(dir);
  assert.equal(loaded.evidence_read_errors.length===0,accepted);
  assert.equal(gradeEndlessSurvival(loaded).status,accepted?'censored':'invalid');
}));
test('pure grader propagates read errors instead of trusting supplied objects',()=>{
  const native=nativeFixture();native.evidence_read_errors=[{field:'native',code:'invalid_json'}];
  assert.equal(gradeEndlessSurvival(native).status,'invalid');
  native.evidence_read_errors='malformed';assert.equal(gradeEndlessSurvival(native).status,'invalid');
});

test('wave timestamps within one native update of the absolute schedule are accepted',()=>withEvidence((dir,native)=>{
  const rows=nativeRecords(native);rows[2].data.simulation_tick-=1;saveRows(dir,rows);
  assert.deepEqual(readNativeSurvival(dir).evidence_read_errors,[]);
}));
for(const [name,replace] of [
  ['envelope sequence',text=>text.replace('"sequence":1','"sequence":999,"sequence":1')],
  ['nested provenance',text=>text.replace('"map_sha256":','"map_sha256":"fake","map_sha256":')],
  ['escaped equivalent key',text=>text.replace('"sequence":1','"seque\\u006ece":999,"sequence":1')],
])test(`duplicate JSON ${name} is rejected`,()=>withEvidence(dir=>{
  const file=path.join(dir,SURVIVAL_EVIDENCE_FILES.native);
  fs.writeFileSync(file,replace(fs.readFileSync(file,'utf8')));
  assert.equal(readNativeSurvival(dir).evidence_read_errors[0].code,'duplicate_json_key');
}));
