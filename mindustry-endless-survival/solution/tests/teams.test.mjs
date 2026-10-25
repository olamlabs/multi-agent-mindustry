import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {seatsFromRoster,validateSettings,resolveTeams,resolveCameras} from '../../environment/sim/settings.mjs';
const seats=n=>Array.from({length:n},(_,i)=>`seat-${i+1}`);
test('one survival team supports exactly 1 through 20 canonical seats',()=>{
  for(let n=1;n<=20;n++){
    const roster=seatsFromRoster(Object.fromEntries(seats(n).map(s=>[s,{}])));
    assert.deepEqual(resolveTeams(validateSettings({}),roster).team_sizes,[n]);
  }
  for(const n of [0,21,100,200])assert.throws(()=>seatsFromRoster(Object.fromEntries(seats(n).map(s=>[s,{}]))));
  for(const change of [{game_mode:'pvp'},{game_mode:'attack'},{game_mode:'sandbox'},{time_limit_sec:60},{team_count:2,team_size:1},{team_sizes:[1,1]}])assert.throws(()=>validateSettings(change));
  assert.throws(()=>resolveTeams(validateSettings({team_sizes:[2]}),seats(3)));
});
test('configured roster and Compose agree on the single endless-survival team',()=>{
  const config=JSON.parse(readFileSync(new URL('../../config.json',import.meta.url)));
  const compose=JSON.parse(readFileSync(new URL('../../environment/docker-compose.yaml',import.meta.url)));
  const roster=JSON.parse(compose.services.main.environment.HARBOR_SEATS);
  const settings=JSON.parse(compose.services.main.environment.HARBOR_SIM_SETTINGS);
  assert.equal(roster.length,config.seats);
  assert.equal(settings.time_limit_sec,null);
  assert.deepEqual(resolveTeams(validateSettings(settings),roster).team_sizes,[roster.length]);
});
test('camera selection preserves roster order and rejects absent seats',()=>{
  const cameras=(chosen,n)=>resolveCameras(resolveTeams(validateSettings({video:{seats:chosen}}),seats(n)),seats(n)).video.seats;
  assert.deepEqual(cameras('all',20),seats(20));
  assert.deepEqual(cameras(3,20),seats(3));
  assert.deepEqual(cameras(0,2),[]);
  assert.deepEqual(cameras(['seat-7','seat-2'],8),['seat-2','seat-7']);
  assert.throws(()=>cameras(['seat-9'],8));assert.throws(()=>cameras(9,8));
  for(const bad of [-1,21,1.5,'some',null,['seat-1','seat-1'],['bob'],[7]])assert.throws(()=>validateSettings({video:{seats:bad}}));
});

test('release configuration records every seat as the roster changes',()=>{
  const config=JSON.parse(readFileSync(new URL('../../config.json',import.meta.url)));
  assert.equal(config.settings.video.record,true);
  assert.equal(config.settings.video.seats,'all');
  for(const n of [1, 2, 5, 20]){
    const roster=seats(n);
    const settings=resolveCameras(resolveTeams(validateSettings(config.settings),roster),roster);
    assert.deepEqual(settings.video.seats,roster);
  }
});
