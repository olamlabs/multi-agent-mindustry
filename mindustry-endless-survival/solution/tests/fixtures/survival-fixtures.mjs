import fs from 'node:fs';
import path from 'node:path';
import {buildSurvivalBenchmark,NATIVE_SURVIVAL_SCHEMA} from '../../../environment/sim/survival-contract.mjs';
import {validateSettings,resolveCameras} from '../../../environment/sim/settings.mjs';
import {SURVIVAL_EVIDENCE_FILES} from '../../../environment/sim/survival-evidence.mjs';
export const clone = value => structuredClone(value);
export function nativeFixture(seconds = 2100, clearance = 0.75, seats = 20) {
  const roster = Array.from({length: seats}, (_, i) => `seat-${i + 1}`);
  const settings = resolveCameras(validateSettings({game_mode:'survival',map:'Fork',team_sizes:[seats],agent_ready_required:true,endless_survival:{first_wave_ticks:14400,wave_spacing_ticks:7200,spawn_seed:1,enemy_unit_health_multiplier:1,enemy_unit_damage_multiplier:1}}),roster);
  const provenance = {map_sha256:'c'.repeat(64),rules_sha256:'f'.repeat(64),wave_schedule_sha256:'d'.repeat(64),profile_sha256:'e'.repeat(64)};
  const teams = Object.fromEntries(roster.map(seat => [seat, 'sharded']));
  const nativeSetup = {profile:clone(settings.endless_survival),map:'Fork',friendly_team:'sharded',wave_team:'crux',seats:roster,seat_teams:teams,provenance,first_wave_simulation_tick:14400,wave_spacing_ticks:7200};
  const start = {event:'survival_start',simulation_tick:0,ticks_per_second:60,simulation_updates:0,wall_elapsed_seconds:0,friendly_team:'sharded',wave_team:'crux',ready_seats:roster,seat_teams:teams,core_health_by_team:{sharded:{count:1,health:4500,max_health:4500}},wave:1,next_wave_simulation_tick:14400,provenance:clone(provenance)};
  const waves = seconds*60<14400?0:Math.floor((seconds*60-14400)/7200)+1;
  const event = {event:'last_friendly_core_destroyed',simulation_tick:seconds*60,ticks_per_second:60,simulation_updates:Math.ceil(seconds*60),wall_elapsed_seconds:seconds,friendly_team:'sharded',winner:'crux',seat_teams:teams,core_health_by_team:{sharded:{count:0,health:0,max_health:4500}},wave:waves+1,waves_spawned:waves,provenance:clone(provenance)};
  const terminal = {reason:'core_destroyed',survival_censored:false,simulation_tick:event.simulation_tick,ticks_per_second:60,elapsed_simulation_seconds:seconds,simulation_updates:event.simulation_updates,wall_elapsed_seconds:seconds,winning_team:'crux',friendly_team:'sharded',seat_teams:teams,core_health_by_team:clone(event.core_health_by_team),wave:waves+1,waves_spawned:waves,provenance:clone(provenance),clock:{policy:'accumulated_native_time_delta',ticks_per_second:60,server_delta_cap_ticks:4,capped_updates:0,capped_ticks_dropped:0},end_condition:'core_destroyed',record_failures:0,clearance:clearanceFixture(seconds*60,waves,clearance)};
  const {event:_kind,...rawStart}=start;
  return {
    setup:{seats:roster,settings,benchmark:buildSurvivalBenchmark({settings,seats:roster,nativeSetup})},
    nativeSetup,start,event,terminal,
    result:{started:true,completed:true,terminal:clone(terminal)},
    readiness:{schema_version:'1.0',required:true,state:'started',failure:null,expected_seats:roster,ready_seats:roster,pending_seats:[],acknowledgments:Object.fromEntries(roster.map((seat,i)=>[seat,{received_at:'2026-10-18T00:00:01Z',journal_sequence:i+1}])),all_agents_ready_at:'2026-10-18T00:00:01Z',cameras_ready_at:'2026-10-18T00:00:02Z',native_start_requested_at:'2026-10-18T00:00:03Z',native_started_at:'2026-10-18T00:00:04Z',native_start:{survival_start:clone(rawStart)}},
  };
}
export function clearanceFixture(ticks, waves, mean) {
  if (!waves) return {policy:'realized_clearance/1',first_wave_simulation_tick:null,wave_strength:null,integral_ticks:0,observed_ticks:0,mean:null};
  const observed = ticks - 14400;
  return {policy:'realized_clearance/1',first_wave_simulation_tick:14400,wave_strength:600*1.22**Math.min(waves-1,100),integral_ticks:mean*observed,observed_ticks:observed,mean:observed>0?mean:null};
}
export function nativeRecords(input) {
  const records=[];
  const append=(event,data)=>records.push({schema:NATIVE_SURVIVAL_SCHEMA,sequence:records.length+1,event,data});
  const raw=value=>{const {event:_event,...data}=value;return data;};
  append('survival_setup',input.nativeSetup);
  if(input.start) append('survival_start',raw(input.start));
  const waves=input.event?.waves_spawned??input.terminal?.waves_spawned??0;
  let budget=600;
  for(let wave=1;wave<=waves;wave++) {
    const tick=input.nativeSetup.first_wave_simulation_tick+(wave-1)*input.nativeSetup.wave_spacing_ticks;
    append('survival_wave',{wave,simulation_tick:tick,scheduled_simulation_tick:tick,simulation_updates:Math.ceil(tick),ticks_per_second:60,wall_elapsed_seconds:tick/60,spawn_rng_seed:String(wave),spawned:{dagger:4},enemies_alive_before:0,core_health_by_team:input.start.core_health_by_team,
      spawned_units:{dagger:{count:4,shield_min:0,shield_max:0,shield_total:0,raw_health_total:600,raw_max_health_total:600}},
      cumulative_spawned:{dagger:4*wave},enemy_team_rule:{unit_health_multiplier:Math.fround(input.nativeSetup.profile.enemy_unit_health_multiplier),unit_damage_multiplier:Math.fround(input.nativeSetup.profile.enemy_unit_damage_multiplier)},
      spawn_observation:'after_native_group_shields_before_combat',budget,planned_units:{dagger:4},planned_shield:0,realized_strength:budget});
    budget*=1.22;
  }
  if(input.event) append('last_friendly_core_destroyed',raw(input.event));
  if(input.terminal) append('survival_terminal',input.terminal);
  return records;
}
export function stoppedFixture(seconds=2100) {
  const input=nativeFixture(seconds);
  input.event=null;
  Object.assign(input.terminal,{reason:'stopped',survival_censored:true,winning_team:null,core_health_by_team:{sharded:{count:1,health:2000,max_health:4500}}});
  input.result.terminal=clone(input.terminal);
  return input;
}
export function writeNativeEvidence(directory,input) {
  fs.mkdirSync(path.join(directory,'engine'),{recursive:true});
  for(const key of ['setup','result','readiness']) fs.writeFileSync(path.join(directory,SURVIVAL_EVIDENCE_FILES[key]),JSON.stringify(input[key]));
  fs.writeFileSync(path.join(directory,SURVIVAL_EVIDENCE_FILES.native),nativeRecords(input).map(row=>JSON.stringify(row)+'\n').join(''));
}

export function scriptedEvidence(directory, settings, seats, seconds=60) {
  const input=nativeFixture(seconds,0.75,seats.length);
  input.setup.settings=resolveCameras(validateSettings({...settings,team_sizes:[seats.length]}),seats);
  input.nativeSetup.profile=clone(input.setup.settings.endless_survival);
  input.nativeSetup.first_wave_simulation_tick=input.nativeSetup.profile.first_wave_ticks;
  input.nativeSetup.wave_spacing_ticks=input.nativeSetup.profile.wave_spacing_ticks;
  input.setup.benchmark=buildSurvivalBenchmark({settings:input.setup.settings,seats,nativeSetup:input.nativeSetup});
  fs.mkdirSync(path.join(directory,'engine'),{recursive:true});
  const save=finished=>fs.writeFileSync(path.join(directory,'engine/survival.jsonl'),nativeRecords(input).filter(row=>finished||['survival_setup','survival_start'].includes(row.event)).map(row=>JSON.stringify(row)).join('\n')+'\n');
  save(false);
  return {input,save};
}
