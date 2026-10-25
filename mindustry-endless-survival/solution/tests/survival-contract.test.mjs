import test from 'node:test';
import assert from 'node:assert/strict';
import {buildSurvivalBenchmark,sha256,survivalSeats,sameSeats} from '../../environment/sim/survival-contract.mjs';
import {gradeEndlessSurvival} from '../../environment/sim/survival-grade.mjs';
import {nativeFixture,clone} from './fixtures/survival-fixtures.mjs';
const build=input=>buildSurvivalBenchmark({settings:input.setup.settings,seats:input.setup.seats,nativeSetup:input.nativeSetup});
test('app hashes recompute from retained full payloads and are absent from native records',()=>{
  const data=nativeFixture(),b=data.setup.benchmark;
  assert.equal(b.scenario_sha256,sha256(b.scenario));assert.equal(b.protocol_sha256,sha256(b.protocol));
  assert.deepEqual(b.scenario.settings,data.setup.settings);assert.deepEqual(b.scenario.native_setup,data.nativeSetup);
  for(const value of [data.nativeSetup,data.start,data.event,data.terminal]){
    assert.equal(value.scenario_sha256,undefined);assert.equal(value.protocol_sha256,undefined);
    assert.deepEqual(Object.keys(value.provenance).sort(),['map_sha256','profile_sha256','rules_sha256','wave_schedule_sha256']);
  }
});
test('builder snapshots payloads instead of retaining mutable settings or native references',()=>{
  const d=nativeFixture(),b=build(d);d.setup.settings.seed++;d.nativeSetup.provenance.map_sha256='a'.repeat(64);
  assert.notEqual(b.scenario.settings.seed,d.setup.settings.seed);
  assert.notEqual(b.scenario.native_setup.provenance.map_sha256,d.nativeSetup.provenance.map_sha256);
  assert.equal(b.scenario_sha256,sha256(b.scenario));
});
for(const field of ['lobby_sec','save_interval_sec','video'])test(`${field} changes both the scenario and real-time protocol identity`,()=>{
  const d=nativeFixture(),before=build(d);
  if(field==='video')d.setup.settings.video.fps++;else d.setup.settings[field]++;
  const after=build(d);assert.notEqual(before.scenario_sha256,after.scenario_sha256);assert.notEqual(before.protocol_sha256,after.protocol_sha256);
});
test('map/rules/waves provenance changes scenario identity without pretending to change timing protocol',()=>{
  const d=nativeFixture(),before=build(d);d.nativeSetup.provenance.rules_sha256='a'.repeat(64);
  const after=build(d);assert.notEqual(before.scenario_sha256,after.scenario_sha256);assert.equal(before.protocol_sha256,after.protocol_sha256);
});
const corruptions={
  'missing full scenario':d=>delete d.setup.benchmark.scenario,
  'missing full protocol':d=>delete d.setup.benchmark.protocol,
  'changed scenario payload with old hash':d=>d.setup.benchmark.scenario.settings.seed++,
  'changed protocol payload with old hash':d=>d.setup.benchmark.protocol.lobby_sec++,
  'self-consistent fake scenario payload':d=>{d.setup.benchmark.scenario.settings.seed++;d.setup.benchmark.scenario_sha256=sha256(d.setup.benchmark.scenario);},
  'self-consistent fake protocol payload':d=>{d.setup.benchmark.protocol.lobby_sec++;d.setup.benchmark.protocol_sha256=sha256(d.setup.benchmark.protocol);},
  'changed effective seed':d=>d.setup.settings.seed++,
  'changed effective wave profile':d=>d.setup.settings.endless_survival.wave_spacing_ticks++,
  'wrong native map':d=>d.nativeSetup.map='Veins',
  'wrong native profile':d=>d.nativeSetup.profile.spawn_seed++,
  'wrong native first wave':d=>d.nativeSetup.first_wave_simulation_tick++,
  'wrong native wave spacing':d=>d.nativeSetup.wave_spacing_ticks++,
  'wrong native roster':d=>d.nativeSetup.seats=d.nativeSetup.seats.slice(1),
  'wrong native team map':d=>d.nativeSetup.seat_teams={...d.nativeSetup.seat_teams,'seat-20':'crux'},
  'malformed native provenance':d=>d.nativeSetup.provenance.rules_sha256='fake',
  'invented native scenario hash':d=>d.start.scenario_sha256=d.setup.benchmark.scenario_sha256,
  'invented native protocol hash':d=>d.event.protocol_sha256=d.setup.benchmark.protocol_sha256,
  'native terminal receipt absent':d=>d.terminal=null,
  'native terminal differs from app':d=>d.terminal.winning_team='sharded',
  'nonzero scoring origin with matching readiness':d=>{d.start.simulation_tick=1;d.readiness.native_start.survival_start.simulation_tick=1;},
  'wrong clock policy':d=>{d.terminal.clock.policy='wall_time';d.result.terminal=clone(d.terminal);},
  'impossible update count':d=>{d.event.simulation_updates=1;d.terminal.simulation_updates=1;d.result.terminal=clone(d.terminal);},
  'wrong native winner':d=>{d.event.winner='sharded';d.terminal.winning_team='sharded';d.result.terminal=clone(d.terminal);},
};
for(const[name,corrupt]of Object.entries(corruptions))test(`contract invalidates ${name}`,()=>{
  const d=nativeFixture();corrupt(d);const result=gradeEndlessSurvival(d);
  assert.equal(result.status,'invalid',JSON.stringify(result));assert.equal(result.score_seconds,null);
});
test('consistent non-Fork settings and setup cannot opt another map into this profile',()=>{
  const d=nativeFixture();d.setup.settings.map=d.nativeSetup.map='Veins';assert.throws(()=>build(d));
});
test('builder requires effective defaults and resolved camera seats',()=>{
  const d=nativeFixture();delete d.setup.settings.lobby_sec;assert.throws(()=>build(d));
  const other=nativeFixture();other.setup.settings.video.seats='all';assert.throws(()=>build(other));
});

test('roster helpers require the configured size rather than an implicit twenty-seat roster',()=>{
  for(const n of [1,2,20]) {
    const seats=survivalSeats(n);assert.equal(seats.length,n);assert.equal(sameSeats(seats,n),true);
    assert.equal(sameSeats([...seats,'seat-extra'],n),false);
  }
  for(const n of [undefined,0,21,1.5]) assert.throws(()=>survivalSeats(n));
});
