import test from 'node:test';
import assert from 'node:assert/strict';
import {seatsFromRoster, validateSettings, resolveTeams, resolveCameras} from '../../environment/sim/settings.mjs';
import {grade} from '../../environment/sim/grade.mjs';
import {execFileSync} from 'node:child_process';
import {mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
const rewardsOf = reward => Object.keys(reward).filter(key => /^seat-\d+$/.test(key)).sort((a, b) => Number(a.slice(5)) - Number(b.slice(5))).map(key => reward[key]);

const taskToml = url => JSON.parse(execFileSync('python3', ['-c', 'import json, sys, tomllib; print(json.dumps(tomllib.load(open(sys.argv[1], "rb"))))', fileURLToPath(url)], {encoding: 'utf8'}));

const seats = n => Array.from({length:n},(_,i)=>`seat-${i+1}`);
const roster = n => Object.fromEntries(seats(n).map(s=>[s,s]));

test('omitted topology preserves historical four/eight-seat layouts', () => {
  for (const n of [4,8]) for (const mode of ['pvp']) {
    const settings=resolveTeams(validateSettings({game_mode:mode}),seats(n));
    assert.equal(settings.team_count,2);
    assert.equal(settings.team_size,n/settings.team_count);
  }
});

test('all configured equal-sized layouts resolve within the 200-seat cap', () => {
  for (let teams=2;teams<=6;teams++) for (let size=1;size<=100;size++) {
    const n=teams*size;
    if(n>200){ assert.throws(()=>seatsFromRoster(roster(n)),/canonical roster/);continue; }
    const resolved=resolveTeams(validateSettings({game_mode:'pvp',team_count:teams,team_size:size}),seatsFromRoster(roster(n)));
    assert.equal(resolved.team_count*resolved.team_size,n);
  }
  for(const settings of [{team_count:2},{team_size:4},{team_count:2.5,team_size:2},{team_count:0,team_size:4},{team_count:7,team_size:1},{team_count:2,team_size:101}]) assert.throws(()=>validateSettings(settings));
  for(const [settings,n] of [[{game_mode:'pvp',team_count:1,team_size:4},4],[{game_mode:'pvp',team_count:3,team_size:2},8]]) assert.throws(()=>resolveTeams(validateSettings(settings),seats(n)));
});

test('Harbor Multiagent task declares the configured roster and settings', () => {
  const task=taskToml(new URL('../../task.toml',import.meta.url));
  const config=JSON.parse(readFileSync(new URL('../../config.json',import.meta.url),'utf8'));
  assert.equal(task.schema_version, '1.4');
  for (const old of ['shared','seats','simulation']) assert.equal(Object.hasOwn(task,old),false);
  assert.deepEqual(Object.keys(task.agents),seats(config.seats));
  const settings=config.settings;
  assert.deepEqual([settings.game_mode,settings.map,settings.time_limit_sec,settings.games],['pvp','Harbor Ring',600,3]);
  assert.equal(resolveTeams(validateSettings(settings),seats(config.seats)).team_size,config.seats/2);
});

test('unequal topology validates the roster',()=>{
 assert.deepEqual(resolveTeams(validateSettings({game_mode:'pvp',team_sizes:[10,1],time_limit_sec:10,games:1}),seats(11)).team_sizes,[10,1]);
 for(const team_sizes of [[10,0],[10,1.5],[101,1],[25,25,1],[],[10]])assert.throws(()=>resolveTeams(validateSettings({game_mode:'pvp',team_sizes}),seats(11)));
 assert.throws(()=>validateSettings({team_sizes:[10,1],team_count:2,team_size:10}));
});

test('video.seats picks the cameras: all seats, a number spread over the teams in turn, or a list', () => {
  const cameras = (chosen, n, extra = {}) => resolveCameras(resolveTeams(validateSettings({game_mode: 'pvp', ...extra, video: {seats: chosen}}), seats(n)), seats(n)).video.seats;
  assert.deepEqual(cameras('all', 4), seats(4));
  assert.deepEqual(resolveCameras(resolveTeams(validateSettings({}), seats(4)), seats(4)).video.seats, seats(4));
  assert.deepEqual(cameras(4, 200), ['seat-1', 'seat-2', 'seat-101', 'seat-102']);
  assert.deepEqual(cameras(3, 200), ['seat-1', 'seat-2', 'seat-101']);
  assert.deepEqual(cameras(3, 4, {team_sizes: [1, 3]}), ['seat-1', 'seat-2', 'seat-3']);
  assert.deepEqual(cameras(3, 6, {team_count: 3, team_size: 2}), ['seat-1', 'seat-3', 'seat-5']);
  assert.deepEqual(cameras(0, 8), []);
  assert.deepEqual(cameras(['seat-7', 'seat-2'], 8), ['seat-2', 'seat-7']);
  assert.throws(() => cameras(['seat-9'], 8), /seat-9, which is not in the roster/);
  assert.throws(() => cameras(9, 8), /9 cameras, more than the 8 seats/);
  for (const bad of [-1, 201, 1.5, 'some', null, ['seat-1', 'seat-1'], ['bob'], [7]]) assert.throws(() => validateSettings({video: {seats: bad}}), /video.seats must be/);
});

const teamsOf = (n, names = ['sharded', 'crux']) => Object.fromEntries(seats(n).map((s, i) => [s, names[Math.floor(i * names.length / n)]]));
const setupOf = (n, settings = {}) => {
  const config={game_mode:'pvp',time_limit_sec:10,games:3,...settings};
  const names=config.team_count===3?['sharded','crux','green']:['sharded','crux'];
  const teams=teamsOf(n,names);
  return {settings:config,seats:seats(n),engine:{configured:true,seed:config.seed??1,map:config.map??(names.length>2?'Harbor Ring':'Glacier'),game_mode:config.game_mode,time_limit_sec:config.time_limit_sec,seat_teams:teams,cores:names.map(team=>({team,health:4000,max_health:4000}))}};
};
const played = (teams, winners) => ({started:true,results:winners.map((winner,i)=>({game:i+1,reason:winner?'core_destroyed':'time_limit',elapsed_seconds:10,waves_completed:0,wave:1,survival_censored:!winner,winning_team:winner,seat_teams:teams,core_health_by_team:Object.fromEntries([...new Set(Object.values(teams))].map(team=>[team,{health:!winner||winner===team?4000:0,max_health:4000}]))}))});

test('a series scores each seat by whether its team won more games: 1 more, 0.5 tied, 0 fewer', () => {
  const {reward, series} = grade({setup: setupOf(4), result: played(teamsOf(4), ['sharded', null, 'crux'])});
  assert.deepEqual(reward, {completed: 1, lobby_expired: 0, games: 3, 'seat-1': .5, 'seat-2': .5, 'seat-3': .5, 'seat-4': .5, wins_sharded: 1, wins_crux: 1, draws: 1});
  assert.deepEqual(series.games, [{game: 1, reason: 'core_destroyed', winning_team: 'sharded', elapsed_seconds: 10}, {game: 2, reason: 'time_limit', winning_team: null, elapsed_seconds: 10}, {game: 3, reason: 'core_destroyed', winning_team: 'crux', elapsed_seconds: 10}]);
  assert.deepEqual(series.tally, {wins: {sharded: 1, crux: 1}, draws: 1});

  const {reward: series25} = grade({setup: setupOf(50, {games: 5}), result: played(teamsOf(50), ['crux', 'crux', 'sharded', 'crux', 'crux'])});
  assert.deepEqual(rewardsOf(series25), [...Array(25).fill(0), ...Array(25).fill(1)]);
  assert.deepEqual([series25.wins_sharded, series25.wins_crux, series25.draws], [1, 4, 0]);
  assert.deepEqual(rewardsOf(grade({setup: setupOf(4), result: played(teamsOf(4), [null, 'sharded', null])}).reward), [1, 1, 0, 0]);
});

test('with more than two teams the team with the most wins scores 1, teams sharing the most 0.5, the rest 0', () => {
  const teams = teamsOf(6, ['sharded', 'crux', 'green']);
  assert.deepEqual(rewardsOf(grade({setup: setupOf(6,{team_count:3,team_size:2}), result: played(teams, ['green', 'crux', 'green'])}).reward), [0, 0, 0, 0, 1, 1]);
  assert.deepEqual(rewardsOf(grade({setup: setupOf(6,{team_count:3,team_size:2}), result: played(teams, ['green', 'crux', null])}).reward), [0, 0, .5, .5, .5, .5]);
  assert.deepEqual(rewardsOf(grade({setup: setupOf(6,{team_count:3,team_size:2}), result: played(teams, [null, null, null])}).reward), [.5, .5, .5, .5, .5, .5]);
});

test('removed modes fail settings and verifier entrypoints', () => {
  for (const game_mode of ['survival', 'attack', 'sandbox']) {
    assert.throws(() => validateSettings({game_mode}), /Only PvP/);
    assert.throws(() => grade({setup: setupOf(4, {game_mode}), result: played(teamsOf(4), [null,null,null])}), /Only PvP/);
  }
});

test('a series not over or never started is unscored; a failed or malformed one fails loudly', () => {

  assert.throws(()=>grade({setup:setupOf(4),result:null}),/infrastructure-invalid/);
  assert.throws(()=>grade({setup:setupOf(4),result:{started: false, reason: 'lobby'}}),/infrastructure-invalid/);
  assert.throws(() => grade({setup: setupOf(4), result: {failure: 'HTTP 500'}}), /The match failed: HTTP 500/);
  assert.throws(() => grade({setup: null, result: null}), /no setup.json/);
  const teams = teamsOf(4);
  assert.throws(() => grade({setup: setupOf(4, {games: 4}), result: played(teams, ['sharded', null, 'crux'])}), /The series has 4 games, but its result has 3/);
  const renumbered = played(teams, ['sharded', null, 'crux']);
  renumbered.results[1].game = 3;
  assert.throws(() => grade({setup: setupOf(4), result: renumbered}), /Game 2's result carries game 3/);
  const swapped = played(teams, ['sharded', null, 'crux']);
  swapped.results[1].seat_teams = {...teams, 'seat-1': 'crux', 'seat-3': 'sharded'};
  assert.throws(() => grade({setup: setupOf(4), result: swapped}), /teams in game 2 differ from game 1's/);
  assert.throws(() => grade({setup: setupOf(5), result: played(teams, ['sharded', null, 'crux'])}), /Roster must match/);
});

test("the verifier grades from setup.json and result.json alone and never opens the game's logs", () => {
  const dir = mkdtempSync(join(tmpdir(), 'series-'));
  writeFileSync(join(dir, 'setup.json'), JSON.stringify(setupOf(4, {games: 2})));
  writeFileSync(join(dir, 'result.json'), JSON.stringify(played(teamsOf(4), ['crux', 'crux'])));
  const verify = fileURLToPath(new URL('../../environment/sim/verify.mjs', import.meta.url));
  const run = () => {
    const out = join(mkdtempSync(join(tmpdir(), 'reward-')), 'reward.json');
    const printed = JSON.parse(execFileSync(process.execPath, [verify, dir, out], {encoding: 'utf8'}));
    return {reward: JSON.parse(readFileSync(out, 'utf8')), series: JSON.parse(readFileSync(join(out, '..', 'series.json'), 'utf8')), printed};
  };

  const {reward, series, printed} = run();
  assert.deepEqual(rewardsOf(reward), [0, 0, 1, 1]);
  assert.deepEqual(printed, series, 'the verifier prints series.json');
  assert.deepEqual([series.games.map(g => g.winning_team), series.tally], [['crux', 'crux'], {wins: {sharded: 0, crux: 2}, draws: 0}]);

  mkdirSync(join(dir, 'engine'));
  for (const name of ['log.jsonl', 'journal.jsonl', 'engine/events.jsonl']) writeFileSync(join(dir, name), 'not JSON\n');
  assert.deepEqual(run().reward, reward);
});

test('reward.json maps N=1, mixed wins, tied leaders and unequal teams to their seats', t => {
  const dir=mkdtempSync(join(tmpdir(),'series-serialized-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const cases=[
    [4,{},['sharded'],[1,1,0,0]],
    [4,{},[null],[.5,.5,.5,.5]],
    [4,{},['sharded','crux','sharded'],[1,1,0,0]],
    [6,{team_count:3,team_size:2},['sharded','crux',null],[.5,.5,.5,.5,0,0]],
    [4,{team_sizes:[1,3]},['crux'],[0,1,1,1]],
  ];
  for(const [n,settings,winners,expected] of cases){
    const setup=setupOf(n,{...settings,games:winners.length});
    if(settings.team_sizes)setup.engine.seat_teams={'seat-1':'sharded','seat-2':'crux','seat-3':'crux','seat-4':'crux'};
    writeFileSync(join(dir,'setup.json'),JSON.stringify(setup));
    writeFileSync(join(dir,'result.json'),JSON.stringify(played(setup.engine.seat_teams,winners)));
    const out=join(dir,'reward.json');
    execFileSync(process.execPath,[fileURLToPath(new URL('../../environment/sim/verify.mjs',import.meta.url)),dir,out]);
    const reward=JSON.parse(readFileSync(out,'utf8'));
    const series=JSON.parse(readFileSync(join(dir,'series.json'),'utf8'));
    assert.deepEqual(rewardsOf(reward),expected);
    assert.equal(reward.games,winners.length);
    assert.equal(series.games.length,winners.length);
    assert.deepEqual(series.games.map(g=>g.winning_team),winners);
    assert.ok(Object.values(reward).every(value=>typeof value==='number'&&Number.isFinite(value)));
  }
});

test('release configuration records every seat as the roster changes',()=>{
  const config=JSON.parse(readFileSync(new URL('../../config.json',import.meta.url)));
  assert.equal(config.settings.video.record,true);
  assert.equal(config.settings.video.seats,'all');
  for(const n of [4, 10, 20]){
    const roster=seats(n);
    const settings=resolveCameras(resolveTeams(validateSettings(config.settings),roster),roster);
    assert.deepEqual(settings.video.seats,roster);
  }
});
