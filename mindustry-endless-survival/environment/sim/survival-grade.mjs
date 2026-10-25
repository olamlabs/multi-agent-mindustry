import {SURVIVAL_SCHEMA, NATIVE_HASH_FIELDS, record, canonical, sha256, same, survivalTeamSize, buildSurvivalBenchmark} from './survival-contract.mjs';
export {SURVIVAL_SCHEMA, canonical, sha256} from './survival-contract.mjs';
export const SURVIVAL_GRADER_VERSION = '3.0.0';
export const CLEARANCE_POLICY = 'realized_clearance/1';
export const REWARD_FORMULA = 'native minutes survived, from the simulation start to core loss';
export const CLEARANCE_FORMULA = 'integral of realized clearance over native minutes from the first wave to core loss';

const FIRST_WAVE_TOLERANCE = 4 + 1e-9;
const HASH = /^[a-f0-9]{64}$/;
const HASH_FIELDS = ['scenario_sha256', 'protocol_sha256', 'map_sha256', 'wave_schedule_sha256'];
const positive = value => Number.isFinite(value) && value > 0;
const tick = value => Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
const close = (a, b) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= Math.max(1e-9, Math.abs(b) * Number.EPSILON * 8);

export function gradeEndlessSurvival(input, {seats: expectedSeats} = {}) {
  const issues = [];
  const fail = (code, message) => issues.push({code, message});
  const {setup, result, start, event, readiness, nativeSetup, terminal: nativeTerminal} = record(input) ? input : {};
  const benchmark = setup?.benchmark;
  const out = status => ({
    schema_version: SURVIVAL_SCHEMA, grader_version: SURVIVAL_GRADER_VERSION,
    status, validity_scope: 'native_outcome_only', score_seconds: null, score_minutes: null,
    reward_minutes: null, clearance_minutes: null, clearance_mean: null, reward_formula: REWARD_FORMULA,
    clearance_formula: CLEARANCE_FORMULA, issues,
    scenario_sha256: benchmark?.scenario_sha256 ?? null,
    protocol_sha256: benchmark?.protocol_sha256 ?? null,
    evidence_sha256: sha256(input ?? null),
  });
  if (record(input) && Object.hasOwn(input, 'evidence_read_errors') && (!Array.isArray(input.evidence_read_errors) || input.evidence_read_errors.length > 0)) fail('evidence_read', 'Required native/app evidence could not be read safely; see evidence_read_errors.');
  const n = expectedSeats ?? setup?.settings?.team_sizes?.[0];
  if (!survivalTeamSize(n)) fail('team_size', 'The team size must be a whole number of seats from 1 to 20.');
  const seats = Array.from({length: survivalTeamSize(n) ? n : 0}, (_, i) => `seat-${i + 1}`);
  if (!record(benchmark) || benchmark.schema_version !== SURVIVAL_SCHEMA || benchmark.team_size !== n) fail('benchmark_contract', `A versioned ${n}-seat endless-survival benchmark contract is required.`);
  for (const field of HASH_FIELDS) if (!HASH.test(benchmark?.[field] ?? '')) fail('benchmark_hash', `Missing or invalid ${field}.`);
  if (!Array.isArray(setup?.seats) || !same(setup.seats.slice().sort(), seats.slice().sort())) fail('roster', `Exactly seat-1 through seat-${n} must be present once each.`);
  if (setup?.settings?.game_mode !== 'survival' || setup?.settings?.time_limit_sec !== null || !same(setup?.settings?.team_sizes, [n])) fail('scenario', `Expected one ${n}-seat survival team with no game deadline.`);
  if (setup?.settings?.team_count != null || setup?.settings?.team_size != null) fail('topology', `Use team_sizes:[${n}] without conflicting legacy topology fields.`);
  if (setup?.settings?.agent_ready_required !== true) fail('readiness_setting', 'This benchmark requires the all-agent readiness barrier to be enabled.');
  try {
    const expected = buildSurvivalBenchmark({settings:setup?.settings,seats:setup?.seats,nativeSetup});
    if (!same(benchmark,expected)) fail('benchmark_binding','Benchmark payloads and hashes must recompute from exact effective settings and native setup.');
  } catch (error) {fail('native_setup',error.message);}
  if (result?.failure != null) fail('gameplay_failure', 'A critical pre-terminal app/gameplay failure cannot be scored as a native loss.');
  const team = start?.friendly_team;
  if (start?.event !== 'survival_start' || typeof team !== 'string' || team.length === 0 || start?.simulation_tick !== 0 || start?.simulation_updates !== 0 || start?.ticks_per_second !== 60) fail('start_clock', 'Require an authoritative native start event on the native simulation clock with sixty ticks per simulation second.');
  if (!Array.isArray(start?.ready_seats) || !same(start.ready_seats.slice().sort(), seats.slice().sort())) fail('start_barrier', `All ${n} seats must be ready at the scoring start barrier.`);
  const when = value => typeof value === 'string' ? Date.parse(value) : NaN;
  if (readiness?.schema_version !== '1.0' || readiness?.required !== true || readiness?.state !== 'started' || readiness?.failure !== null || !Array.isArray(readiness?.expected_seats) || !same(readiness.expected_seats.slice().sort(), seats.slice().sort()) || !Array.isArray(readiness?.ready_seats) || !same(readiness.ready_seats.slice().sort(), seats.slice().sort()) || !same(readiness?.pending_seats, []) || !record(readiness?.acknowledgments) || !same(Object.keys(readiness.acknowledgments).sort(), seats.slice().sort())) fail('readiness', `Require the started all-agent readiness artifact for exactly ${n} seats.`);
  else {
    const {event:_event,...rawStart}=record(start)?start:{};
    if (!record(readiness.native_start?.survival_start) || !same(readiness.native_start.survival_start, rawStart)) fail('readiness_start_binding', 'The persisted native start response must contain exactly the same authoritative survival start object.');
    if (new Set(seats.map(seat => readiness.acknowledgments[seat]?.journal_sequence)).size !== seats.length) fail('readiness_receipts', 'Each ready acknowledgment must refer to its own distinct journal entry.');
    const allReady = when(readiness.all_agents_ready_at);
    const camerasReady = when(readiness.cameras_ready_at);
    const requested = when(readiness.native_start_requested_at);
    const started = when(readiness.native_started_at);
    if (![allReady, camerasReady, requested, started].every(Number.isFinite) || allReady > requested || camerasReady > requested || requested > started || seats.some(seat => !Number.isSafeInteger(readiness.acknowledgments[seat]?.journal_sequence) || readiness.acknowledgments[seat].journal_sequence < 1 || !Number.isFinite(when(readiness.acknowledgments[seat]?.received_at)) || when(readiness.acknowledgments[seat].received_at) > allReady)) fail('readiness_order', 'Every agent and camera must be ready before the native start request.');
  }
  const checkTeams = (value, label) => {
    if (!record(value) || !same(Object.keys(value).sort(), seats.slice().sort()) || seats.some(seat => value[seat] !== team)) fail('seat_teams', `${label} must bind all ${n} seats to the same friendly native team.`);
  };
  checkTeams(start?.seat_teams, 'Start');
  const firstCore = start?.core_health_by_team?.[team];
  if (!record(firstCore) || !Number.isSafeInteger(firstCore.count) || firstCore.count < 1 || !positive(firstCore.health) || !positive(firstCore.max_health) || firstCore.health > firstCore.max_health) fail('initial_core', 'A living friendly core is required at the start.');
  if (start?.friendly_team!==nativeSetup?.friendly_team || start?.wave_team!==nativeSetup?.wave_team || start?.wave!==1 || start?.next_wave_simulation_tick!==nativeSetup?.first_wave_simulation_tick) fail('start_setup','Native start must match the setup team and first-wave schedule.');
  const checkProvenance=(value,label)=>{
    if (!same(value?.provenance,nativeSetup?.provenance) || NATIVE_HASH_FIELDS.some(field=>!HASH.test(value?.provenance?.[field]??''))) fail('native_provenance',`${label} provenance differs from the native setup.`);
    if (record(value) && (Object.hasOwn(value,'scenario_sha256') || Object.hasOwn(value,'protocol_sha256'))) fail('native_app_hash','Native records cannot attest app-level benchmark hashes.');
  };
  checkProvenance(start,'Start');
  if (result?.started !== true) fail('not_started', 'A match that did not start has no survival score.');
  if (issues.length) return out('invalid');

  const terminal = result?.terminal;
  if (result?.completed !== true && terminal == null && nativeTerminal == null && event == null) return out('incomplete');
  if (!record(nativeTerminal) || !same(terminal,nativeTerminal)) fail('native_terminal_binding','App terminal must exactly match the authoritative native terminal receipt.');
  if (terminal?.record_failures!==0) fail('native_record_failures','Native terminal must attest zero failed authoritative survival-record writes.');

  if (terminal?.reason === 'stopped') {
    if (terminal.survival_censored !== true || event != null || terminal.winning_team !== null || terminal.friendly_team !== team || terminal.end_condition !== 'core_destroyed') fail('censor_terminal','A native stopped receipt must have no death event or winner and retain the configured friendly team.');
    checkTeams(terminal.seat_teams,'Stopped terminal');checkProvenance(terminal,'Stopped terminal');
    const core=terminal.core_health_by_team?.[team];
    if (!record(core) || !Number.isSafeInteger(core.count) || core.count<1 || !positive(core.health) || !positive(core.max_health) || core.health>core.max_health || core.max_health<firstCore.max_health) fail('censor_core','A native stopped receipt must prove a living friendly core with retained capacity.');
    const durationTicks=terminal.simulation_tick-start.simulation_tick;
    if (terminal.ticks_per_second!==60 || !tick(terminal.simulation_tick) || !tick(durationTicks) || !close(terminal.elapsed_simulation_seconds,durationTicks/60)) fail('censor_clock','Stopped duration must agree with the native start and sixty-tick simulation clock.');
    if (!Number.isSafeInteger(terminal.simulation_updates) || terminal.simulation_updates<0 || terminal.simulation_tick>terminal.simulation_updates*4+1e-9) fail('native_updates','Native stopped update count must support its capped simulation clock.');
    if (!Number.isSafeInteger(terminal.waves_spawned) || terminal.waves_spawned<0 || terminal.wave!==terminal.waves_spawned+1) fail('native_waves','Native stopped receipt must identify waves spawned and the next wave.');
    const clock=terminal.clock;
    if (clock?.policy!=='accumulated_native_time_delta' || clock?.ticks_per_second!==60 || clock?.server_delta_cap_ticks!==4 || !Number.isSafeInteger(clock?.capped_updates) || clock.capped_updates<0 || clock.capped_updates>terminal.simulation_updates || !tick(clock?.capped_ticks_dropped)) fail('native_clock_policy','Require the versioned native accumulated-time clock and lag counters.');
    if (issues.length) return out('invalid');
    return {...out('censored'),censor_reason:'native_stopped',observed_seconds:durationTicks/60,ticks_per_second:60,friendly_team:team};
  }
  if (terminal?.reason !== 'core_destroyed' || terminal?.survival_censored !== false || result?.completed === false) fail('terminal_reason', 'Only a completed native core-destruction terminal is scored.');
  if (event?.event !== 'last_friendly_core_destroyed' || event?.friendly_team !== team || event?.ticks_per_second !== 60 || !tick(event?.simulation_tick) || event.simulation_tick < start.simulation_tick) fail('death_event', 'Require the authoritative last-friendly-core-destruction event after the start.');
  if (terminal?.ticks_per_second !== 60 || terminal?.simulation_tick !== event?.simulation_tick) fail('terminal_clock', 'Terminal and core-destruction event must agree on the native simulation tick.');
  const durationTicks = event?.simulation_tick - start.simulation_tick;
  if (!tick(durationTicks) || !close(terminal?.elapsed_simulation_seconds, durationTicks / 60)) fail('duration', 'Terminal simulation duration must equal (death tick minus start tick) / 60.');
  for (const [label, evidence] of [['Death event', event], ['Terminal', terminal]]) {
    checkTeams(evidence?.seat_teams, label);
    const core = evidence?.core_health_by_team?.[team];
    if (!record(core) || core.count !== 0 || core.health !== 0 || !positive(core.max_health) || core.max_health < firstCore.max_health) fail('last_core', `${label} must show zero remaining friendly cores and health, retaining initial capacity.`);
  }
  if (!same(event?.core_health_by_team?.[team], terminal?.core_health_by_team?.[team])) fail('core_conflict', 'Terminal and destruction event disagree about final friendly cores.');
  checkProvenance(event,'Death');checkProvenance(terminal,'Terminal');
  if (event?.winner!==nativeSetup?.wave_team || terminal?.winning_team!==nativeSetup?.wave_team || terminal?.friendly_team!==team || terminal?.end_condition!=='core_destroyed') fail('native_winner','Native last-core death must be won by the configured wave team.');
  if (!Number.isSafeInteger(event?.simulation_updates) || event.simulation_updates<0 || terminal?.simulation_updates!==event.simulation_updates || event?.simulation_tick>event.simulation_updates*4+1e-9) fail('native_updates','Native update count must support its capped simulation clock.');
  if (!Number.isSafeInteger(event?.waves_spawned) || event.waves_spawned<0 || terminal?.waves_spawned!==event.waves_spawned || event?.wave!==event.waves_spawned+1 || terminal?.wave!==event.wave) fail('native_waves','Native death and terminal must agree on waves spawned and next wave.');
  const clock=terminal?.clock;
  if (clock?.policy!=='accumulated_native_time_delta' || clock?.ticks_per_second!==60 || clock?.server_delta_cap_ticks!==4 || !Number.isSafeInteger(clock?.capped_updates) || clock.capped_updates<0 || clock.capped_updates>terminal?.simulation_updates || !tick(clock?.capped_ticks_dropped)) fail('native_clock_policy','Require the versioned native accumulated-time clock and lag counters.');
  const clearance = clearanceLedger(terminal, nativeSetup, fail);
  if (issues.length) return out('invalid');
  return {...out('valid'), score_seconds: durationTicks / 60, score_minutes: durationTicks / 3600, duration_ticks: durationTicks, ticks_per_second: 60, friendly_team: team,

    reward_minutes: durationTicks / 3600, clearance_minutes: clearance.integral_ticks / 3600, clearance_mean: clearance.mean};
}

function clearanceLedger(terminal, nativeSetup, fail) {
  const c = terminal?.clearance;
  const waves = terminal?.waves_spawned;
  if (!record(c) || c.policy !== CLEARANCE_POLICY || !tick(c.integral_ticks) || !tick(c.observed_ticks)) {
    fail('native_clearance', 'Require the versioned native realized-clearance ledger.');
    return null;
  }
  if (waves === 0) {
    if (c.first_wave_simulation_tick !== null || c.wave_strength !== null || c.integral_ticks !== 0 || c.observed_ticks !== 0 || c.mean !== null) fail('native_clearance', 'Before any wave there is no clearance to integrate.');
    return {integral_ticks: 0, mean: 0};
  }
  if (!Number.isFinite(c.wave_strength) || c.wave_strength < 0) fail('native_clearance', 'The ledger must hold the last wave\'s native strength.');
  const first = c.first_wave_simulation_tick;
  const tolerance = Math.max(1e-6, terminal.simulation_tick * 1e-12);
  if (!tick(first) || first < nativeSetup?.first_wave_simulation_tick || first - nativeSetup.first_wave_simulation_tick > FIRST_WAVE_TOLERANCE || first > terminal.simulation_tick)
    fail('native_clearance', 'The clearance ledger must begin at the native first wave.');
  else if (Math.abs(c.observed_ticks - (terminal.simulation_tick - first)) > tolerance || c.integral_ticks > c.observed_ticks + tolerance)
    fail('native_clearance', 'The clearance ledger must cover exactly the native clock from the first wave to the terminal.');
  else if (c.observed_ticks > 0 ? !close(c.mean, c.integral_ticks / c.observed_ticks) : c.mean !== null)
    fail('native_clearance', 'The clearance mean must be its integral over the observed ticks.');
  return {integral_ticks: Math.min(c.integral_ticks, c.observed_ticks), mean: c.observed_ticks > 0 ? Math.min(1, c.integral_ticks / c.observed_ticks) : 0};
}
