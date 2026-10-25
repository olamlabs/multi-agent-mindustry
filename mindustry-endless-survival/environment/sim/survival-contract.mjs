import {createHash} from 'node:crypto';
import {validateSettings} from './settings.mjs';

export const SURVIVAL_SCHEMA = 'mindustry-endless-survival/v1';
export const NATIVE_SURVIVAL_SCHEMA = 'mindustry-endless-survival-native/1';
export const MAX_SURVIVAL_SEATS = 20;

export const survivalTeamSize = value => Number.isInteger(value) && value >= 1 && value <= MAX_SURVIVAL_SEATS;
export const NATIVE_HASH_FIELDS = Object.freeze(['map_sha256','rules_sha256','wave_schedule_sha256','profile_sha256']);
export const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const canonical = value => JSON.stringify(canonicalValue(value));
function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (record(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalValue(value[key])]));
  return value;
}
export const same = (a,b) => canonical(a) === canonical(b);
export const sha256 = value => createHash('sha256').update(canonical(value)).digest('hex');
export function survivalSeats(n) {
  if (!survivalTeamSize(n)) throw new Error('Supply an explicit survival team size from 1 to 20.');
  return Array.from({length:n},(_,i)=>`seat-${i+1}`);
}
export const sameSeats = (value,n) => Array.isArray(value) && same(value.slice().sort(),survivalSeats(n).sort());
export const validNativeProvenance = value => record(value)
  && same(Object.keys(value).sort(),[...NATIVE_HASH_FIELDS].sort())
  && NATIVE_HASH_FIELDS.every(key=>typeof value[key]==='string' && /^[a-f0-9]{64}$/.test(value[key]));

export function buildSurvivalBenchmark({settings,seats,nativeSetup}) {
  const effective = validateSettings(settings);
  const n = effective.team_sizes?.[0];
  if (!same(effective,settings) || effective.game_mode!=='survival' || effective.map!=='Fork'
      || effective.time_limit_sec!==null || !survivalTeamSize(n) || !same(effective.team_sizes,[n])
      || effective.agent_ready_required!==true || !effective.endless_survival
      || effective.team_count!=null || effective.team_size!=null || !sameSeats(seats,n)
      || !Array.isArray(effective.video.seats)) throw new Error('Benchmark requires exact effective Fork endless-survival settings for one team of 1 to 20 seats.');
  if (!record(nativeSetup) || nativeSetup.map!=='Fork' || !same(nativeSetup.profile,effective.endless_survival)
      || !sameSeats(nativeSetup.seats,n) || typeof nativeSetup.friendly_team!=='string' || !nativeSetup.friendly_team
      || typeof nativeSetup.wave_team!=='string' || !nativeSetup.wave_team || nativeSetup.friendly_team===nativeSetup.wave_team
      || !record(nativeSetup.seat_teams) || !sameSeats(Object.keys(nativeSetup.seat_teams),n)
      || seats.some(seat=>nativeSetup.seat_teams[seat]!==nativeSetup.friendly_team)
      || nativeSetup.first_wave_simulation_tick!==effective.endless_survival.first_wave_ticks
      || nativeSetup.wave_spacing_ticks!==effective.endless_survival.wave_spacing_ticks
      || !validNativeProvenance(nativeSetup.provenance)
      || Object.hasOwn(nativeSetup,'scenario_sha256') || Object.hasOwn(nativeSetup,'protocol_sha256')) {
    throw new Error('Native survival setup does not match the effective map, profile, roster or provenance contract.');
  }
  const scenario = structuredClone({schema_version:'mindustry-survival-scenario/v1',settings,seats,native_setup:nativeSetup});
  const protocol = structuredClone({
    schema_version:'mindustry-survival-realtime-protocol/v2',
    interaction:'real_time_continuous',
    readiness:{all_agents:true,cameras:true,meaning:'harness_has_tool_access',native_request:'exact_ready_seat_set'},
    clock:{policy:'accumulated_native_time_delta',ticks_per_second:60,server_delta_cap_ticks:4},
    lobby_sec:settings.lobby_sec,save_interval_sec:settings.save_interval_sec,video:settings.video,
  });
  return {
    schema_version:SURVIVAL_SCHEMA,team_size:n,
    scenario_sha256:sha256(scenario),protocol_sha256:sha256(protocol),
    map_sha256:nativeSetup.provenance.map_sha256,
    wave_schedule_sha256:nativeSetup.provenance.wave_schedule_sha256,
    scenario,protocol,
  };
}
