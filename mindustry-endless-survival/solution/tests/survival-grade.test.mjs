import test from 'node:test';
import assert from 'node:assert/strict';
import {gradeEndlessSurvival, sha256} from '../../environment/sim/survival-grade.mjs';
import {nativeFixture, stoppedFixture, clone} from './fixtures/survival-fixtures.mjs';

test('35-minute survival beats 30 minutes regardless of economic or military signals', () => {
  const lean = nativeFixture(35*60), rich = nativeFixture(30*60);
  lean.metrics = {production:0, firepower:0, damage:0};
  rich.metrics = {production:1e30, firepower:1e30, damage:1e30};
  assert.equal(gradeEndlessSurvival(lean).score_seconds, 2100);
  assert.equal(gradeEndlessSurvival(rich).score_seconds, 1800);
});
test('the reward is native survival minutes; the clearance integral is reported beside it', () => {

  const out = gradeEndlessSurvival(nativeFixture(35*60, 0.6));
  assert.equal(out.status, 'valid');
  assert.equal(out.reward_minutes, 35);
  assert.equal(out.score_minutes, 35);
  assert.equal(out.clearance_mean, 0.6);
  assert.ok(Math.abs(out.clearance_minutes - 0.6 * 31) < 1e-12);
  assert.equal(out.reward_formula, 'native minutes survived, from the simulation start to core loss');

  assert.ok(gradeEndlessSurvival(nativeFixture(40*60, 0)).reward_minutes > out.reward_minutes);
  assert.equal(gradeEndlessSurvival(nativeFixture(35*60, 1)).reward_minutes, out.reward_minutes);
  assert.ok(gradeEndlessSurvival(nativeFixture(30*60, 1)).reward_minutes < out.reward_minutes);
});
test('a core lost before the first wave has no clearance; its reward is its survival time', () => {
  const out = gradeEndlessSurvival(nativeFixture(120));
  assert.equal(out.status, 'valid');
  assert.equal(out.clearance_mean, 0);
  assert.equal(out.clearance_minutes, 0);
  assert.equal(out.reward_minutes, 2);
  assert.equal(out.score_seconds, 120);
});
test('a missing, inconsistent or off-schedule clearance ledger is unscored', () => {
  const cases = {
    missing: c => undefined,
    policy: c => ({...c, policy: 'realized_clearance/0'}),
    observed: c => ({...c, observed_ticks: c.observed_ticks - 60}),
    integral: c => ({...c, integral_ticks: c.observed_ticks + 60, mean: (c.observed_ticks + 60) / c.observed_ticks}),
    mean: c => ({...c, mean: c.mean + 0.01}),
    late: c => ({...c, first_wave_simulation_tick: c.first_wave_simulation_tick + 5, observed_ticks: c.observed_ticks - 5, integral_ticks: c.mean * (c.observed_ticks - 5)}),
    strength: c => ({...c, wave_strength: null}),
    negative: c => ({...c, integral_ticks: -1}),
  };
  for (const [name, change] of Object.entries(cases)) {
    const data = nativeFixture(2100, 0.75);
    const clearance = change(clone(data.terminal.clearance));
    if (clearance === undefined) delete data.terminal.clearance; else data.terminal.clearance = clearance;
    data.result.terminal = clone(data.terminal);
    const out = gradeEndlessSurvival(data);
    assert.equal(out.status, 'invalid', name);
    assert.ok(out.issues.some(issue => issue.code === 'native_clearance'), name);
    assert.equal(out.reward_minutes, null, name);
  }
  const before = nativeFixture(120);
  before.terminal.clearance = {...before.terminal.clearance, integral_ticks: 1, observed_ticks: 1, mean: 1};
  before.result.terminal = clone(before.terminal);
  assert.equal(gradeEndlessSurvival(before).status, 'invalid');
});
test('current app result with started plus native terminal needs no redundant completed field', () => {
  const data = nativeFixture(); delete data.result.completed;
  assert.equal(gradeEndlessSurvival(data).status, 'valid');
});
test('duration uses native simulation ticks, never wall-time elapsed', () => {
  const data = nativeFixture(2100);
  data.result.terminal.elapsed_seconds = data.terminal.elapsed_seconds = 123456789;
  assert.equal(gradeEndlessSurvival(data).score_seconds, 2100);
  assert.equal(gradeEndlessSurvival(data).score_minutes, 35);
});
test('fractional native ticks preserve duration without rounding to a frame', () => {
  const data = nativeFixture(10.125);
  assert.equal(data.start.simulation_tick,0);
  assert.equal(data.event.simulation_tick,607.5);
  assert.equal(gradeEndlessSurvival(data).score_seconds, 10.125);
});
test('zero duration is a valid native outcome only with a positive initial core and observed death', () => {
  assert.equal(gradeEndlessSurvival(nativeFixture(0)).score_seconds, 0);
  const data = nativeFixture(0); data.start.core_health_by_team.sharded.health = 0;
  assert.equal(gradeEndlessSurvival(data).score_seconds, null);
});
test('ordinary gameplay errors and ancillary artifact errors are not a native zero', () => {
  const data = nativeFixture(2100);
  data.ancillary_errors = ['recorder finalization failed after authoritative native death'];
  data.errors = ['agent tried an unsupported building'];
  assert.equal(gradeEndlessSurvival(data).score_seconds, 2100);
  assert.equal(gradeEndlessSurvival(data).validity_scope, 'native_outcome_only');
});
test('started live game is incomplete, not a loss or an invented censoring time', () => {
  const data = nativeFixture(); data.result.completed = false; data.result.terminal = null; data.terminal = null; data.event = null;
  const score = gradeEndlessSurvival(data);
  assert.equal(score.status, 'incomplete'); assert.equal(score.score_seconds, null);
});
test('authoritative stopped living-core receipt is censored with no numeric score', () => {
  const grade=gradeEndlessSurvival(stoppedFixture(10.125));
  assert.equal(grade.status,'censored');assert.equal(grade.score_seconds,null);assert.equal(grade.score_minutes,null);
  assert.equal(grade.observed_seconds,10.125);assert.equal(grade.censor_reason,'native_stopped');assert.deepEqual(grade.issues,[]);
});
const stoppedCorruptions={
  'dead friendly core':d=>Object.assign(d.terminal.core_health_by_team.sharded,{count:0,health:0}),
  'a death event':d=>d.event=nativeFixture().event,
  'missing native receipt':d=>d.terminal=null,
  'false censor flag':d=>d.terminal.survival_censored=false,
  'a winner':d=>d.terminal.winning_team='crux',
  'unexpected game-over':d=>d.terminal.reason='unexpected_game_over',
  'invalid clock':d=>d.terminal.clock.policy='wall_time',
  'impossible update count':d=>d.terminal.simulation_updates=1,
  'changed native provenance':d=>d.terminal.provenance.rules_sha256='a'.repeat(64),
  'changed seat team':d=>d.terminal.seat_teams={...d.terminal.seat_teams,'seat-20':'crux'},
  'incorrect elapsed duration':d=>d.terminal.elapsed_simulation_seconds++,
  'invalid next wave':d=>d.terminal.wave++,
  'failed native record write':d=>d.terminal.record_failures=1,
  'missing write failure counter':d=>delete d.terminal.record_failures,
  'critical app failure':d=>d.result.failure='provider failed before stop',
  'unreadable evidence':d=>d.evidence_read_errors=[{code:'native_partial_line'}],
  'unbound readiness':d=>delete d.readiness.native_start,
};
for(const [name,corrupt] of Object.entries(stoppedCorruptions)) test(`stopped evidence remains invalid: ${name}`,()=>{
  const data=stoppedFixture();corrupt(data);data.result.terminal=clone(data.terminal);
  const grade=gradeEndlessSurvival(data);assert.equal(grade.status,'invalid');assert.equal(grade.score_seconds,null);assert.equal(grade.observed_seconds,undefined);
});
const corruptions = {
  'deadline enabled': d => d.setup.settings.time_limit_sec = 2100,
  'wrong mode': d => d.setup.settings.game_mode = 'attack',
  'wrong topology': d => d.setup.settings.team_sizes = [10, 10],
  'conflicting legacy topology': d => d.setup.settings.team_count = 1,
  'nineteen agents': d => d.setup.seats = d.setup.seats.slice(0,19),
  'duplicated seat': d => d.setup.seats = [...d.setup.seats.slice(0,19), 'seat-1'],
  'string roster': d => d.setup.seats = 'seat-1',
  'invalid hash': d => d.setup.benchmark.scenario_sha256 = 'fake',
  'native start hash changed': d => d.start.provenance.rules_sha256 = 'a'.repeat(64),
  'native terminal hash changed': d => d.result.terminal.provenance.map_sha256 = 'a'.repeat(64),
  'native death hash changed': d => d.event.provenance.wave_schedule_sha256 = 'a'.repeat(64),
  'start absent': d => d.start = null,
  'not started': d => d.result.started = false,
  'last core survives': d => d.event.core_health_by_team.sharded.count = 1,
  'positive final health': d => d.result.terminal.core_health_by_team.sharded.health = 1,
  'initial core absent': d => d.start.core_health_by_team.sharded.count = 0,
  'lost tracked core capacity': d => d.result.terminal.core_health_by_team.sharded.max_health = 0,
  'other team death': d => d.event.friendly_team = 'crux',
  'other team seat': d => d.event.seat_teams = {...d.event.seat_teams, 'seat-20':'crux'},
  'no all-seat barrier': d => d.start.ready_seats = d.start.ready_seats.slice(1),
  'disabled readiness setting': d => d.setup.settings.agent_ready_required = false,
  'missing readiness setting': d => delete d.setup.settings.agent_ready_required,
  'critical gameplay failure': d => d.result.failure = 'provider start failed before native terminal',
  'no readiness record': d => d.readiness = null,
  'ready after start requested': d => d.readiness.all_agents_ready_at = '2026-10-18T00:00:05Z',
  'camera ready after start requested': d => d.readiness.cameras_ready_at = '2026-10-18T00:00:05Z',
  'one missing acknowledgment': d => delete d.readiness.acknowledgments['seat-20'],
  'one late acknowledgment': d => d.readiness.acknowledgments['seat-20'].received_at = '2026-10-18T00:00:05Z',
  'missing native start response': d => delete d.readiness.native_start,
  'contradictory native start response': d => d.readiness.native_start = {survival_start:{...d.start, simulation_tick:60120}},
  'contradictory native start team': d => d.readiness.native_start = {survival_start:{...d.start, friendly_team:'crux'}},
  'same journal receipt reused': d => d.readiness.acknowledgments['seat-20'].journal_sequence = 1,
  'failed readiness': d => d.readiness.failure = 'native start failed',
  'time-limit terminal': d => d.result.terminal.reason = 'time_limit',
  'censored native flag': d => d.result.terminal.survival_censored = true,
  'no death event': d => d.event = null,
  'wall clock only': d => {delete d.result.terminal.elapsed_simulation_seconds; d.result.terminal.elapsed_seconds = 2100;},
  'wrong native duration': d => d.result.terminal.elapsed_simulation_seconds = 2101,
  'native write failure': d => {d.result.terminal.record_failures=d.terminal.record_failures=1;},
  'missing native write counter': d => {delete d.result.terminal.record_failures;delete d.terminal.record_failures;},
  'death before start': d => d.event.simulation_tick = -1,
  'terminal disagrees with death': d => d.result.terminal.simulation_tick += 1,
  'invalid tick': d => d.event.simulation_tick = Infinity,
  'wrong clock frequency': d => d.start.ticks_per_second = 1,
};
for (const [name, corrupt] of Object.entries(corruptions)) test(`unscored: ${name}`, () => {
  const data = clone(nativeFixture()); corrupt(data);
  const grade = gradeEndlessSurvival(data);
  assert.equal(grade.status, 'invalid'); assert.equal(grade.score_seconds, null); assert.equal(grade.score_minutes, null); assert.ok(grade.issues.length);
});
test('changing only the chosen score start cannot disagree with persisted native start', () => {
  const d = nativeFixture(); d.start = {...d.start, simulation_tick:d.event.simulation_tick}; d.result.terminal.elapsed_simulation_seconds = 0;
  const grade = gradeEndlessSurvival(d); assert.equal(grade.status,'invalid'); assert.equal(grade.score_seconds,null);
  assert.ok(grade.issues.some(issue => issue.code === 'readiness_start_binding'));
});
test('malformed JSON inputs produce structured invalid results', () => {
  for (const input of [null, {}, [], 1, 'bad']) assert.equal(gradeEndlessSurvival(input).status, 'invalid');
});
test('canonical evidence hashing ignores object key order but binds changed evidence', () => {
  assert.equal(sha256({b:2,a:1}), sha256({a:1,b:2}));
  assert.notEqual(sha256({a:1}), sha256({a:2}));
});

test('a smaller team is graded on its own roster, and only on the one its verifier expects', () => {
  const five = nativeFixture(35*60, 0.6, 5);
  assert.equal(gradeEndlessSurvival(five, {seats: 5}).status, 'valid');
  assert.equal(gradeEndlessSurvival(five, {seats: 5}).reward_minutes, 35);

  assert.equal(gradeEndlessSurvival(five).status, 'valid');
  const refused = gradeEndlessSurvival(five, {seats: 20});
  assert.notEqual(refused.status, 'valid');
  assert.equal(refused.reward_minutes, null);
  assert.ok(refused.issues.some(issue => issue.code === 'roster'));
  for (const seats of [0, 21, 2.5]) assert.ok(gradeEndlessSurvival(five, {seats}).issues.some(issue => issue.code === 'team_size'));
});
