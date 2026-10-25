import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validateSettings,resolveTeams} from '../../environment/sim/settings.mjs';

const settings=()=>({game_mode:'survival',map:'Fork',team_sizes:[20],agent_ready_required:true,endless_survival:{first_wave_ticks:14400,wave_spacing_ticks:7200,spawn_seed:1,enemy_unit_health_multiplier:1,enemy_unit_damage_multiplier:1}});

test('endless survival is the default and finite or competitive modes are rejected',()=>{
  const configured=validateSettings(settings());
  assert.equal(configured.time_limit_sec,null);
  assert.deepEqual(resolveTeams(configured,Array.from({length:20},(_,i)=>`seat-${i+1}`)).team_sizes,[20]);
  assert.equal(validateSettings({}).time_limit_sec,null);
  assert.throws(()=>validateSettings({...settings(),time_limit_sec:600}),/requires null/);
  for(const game_mode of ['pvp','attack','sandbox'])assert.throws(()=>validateSettings({game_mode}));
});

test('one team of 1 to 20 seats is a benchmark condition',()=>{
  for(const n of [1,5,10,20]) assert.deepEqual(resolveTeams(validateSettings({...settings(),team_sizes:[n]}),Array.from({length:n},(_,i)=>`seat-${i+1}`)).team_sizes,[n]);
});

test('changed mode, map, roster, readiness and malformed wave parameters fail closed',()=>{
  for(const replacement of [{game_mode:'pvp'},{map:'Veins'},{team_sizes:[0]},{team_sizes:[21]},{team_sizes:[10,10]},{team_sizes:[1.5]},{agent_ready_required:false},{team_count:1,team_size:20},{endless_survival:null}]) assert.throws(()=>validateSettings({...settings(),...replacement}));
  for(const [key,value] of [['version',1],['version',2],['version',3],['first_wave_ticks',59],['wave_spacing_ticks',Infinity],['spawn_seed',-1],['spawn_seed',1.5],['enemy_unit_health_multiplier',0],['enemy_unit_damage_multiplier',101],['unknown',1]]) {
    const input=settings();input.endless_survival[key]=value;
    assert.throws(()=>validateSettings(input),key);
  }
  const input=settings();delete input.endless_survival.spawn_seed;
  assert.throws(()=>validateSettings(input));
});

test('without team_sizes the whole roster is the team; the wave-schedule briefing is optional', () => {
  const open = {...settings()}; delete open.team_sizes;
  for (const n of [1, 5, 20]) assert.deepEqual(resolveTeams(validateSettings(open), Array.from({length: n}, (_, i) => `seat-${i + 1}`)).team_sizes, [n]);
  assert.throws(() => resolveTeams(validateSettings(open), Array.from({length: 21}, (_, i) => `seat-${i + 1}`)), /1 to 20/);
  assert.equal(validateSettings({...open, wave_schedule_briefing: true}).wave_schedule_briefing, true);
  assert.equal(validateSettings({...open, wave_schedule_briefing: false}).wave_schedule_briefing, false);
  for (const bad of [{...open, wave_schedule_briefing: 'yes'}, {...open, wave_schedule_briefing: 1}]) assert.throws(() => validateSettings(bad));
  assert.throws(() => validateSettings({game_mode: 'survival', time_limit_sec: 600, wave_schedule_briefing: false}), /requires null time_limit_sec/);
});
