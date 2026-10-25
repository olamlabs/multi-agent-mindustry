import {validateSettings,resolveTeams,seatsFromRoster} from './settings.mjs';
const NATIVE_TEAMS=new Set(['sharded','crux','green','purple','blue','malis']);
const requireEvidence=(ok,message)=>{if(!ok)throw new Error(`Invalid series evidence: ${message}`);};
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const same=(a,b)=>JSON.stringify(Object.entries(a??{}).sort())===JSON.stringify(Object.entries(b??{}).sort());
const finite=n=>typeof n==='number'&&Number.isFinite(n)&&n>=0;

export function grade({setup,result,expected=null}) {
  if(result?.failure!=null)throw new Error(`The match failed: ${result.failure}`);
  if(!Array.isArray(setup?.seats)||!setup.seats.length)throw new Error('The game wrote no setup.json naming its seats');
  const seats=seatsFromRoster(Object.fromEntries(setup.seats.map(s=>[s,{}])));
  requireEvidence(seats.length===setup.seats.length,'duplicate seats');
  const settings=resolveTeams(validateSettings(setup.settings),seats);
  const native=setup.engine;
  requireEvidence(object(native)&&native.configured===true,'missing configured native setup');
  requireEvidence(native.game_mode===settings.game_mode&&native.time_limit_sec===settings.time_limit_sec,'native mode or deadline differs from setup');
  requireEvidence(native.seed===settings.seed,'native seed differs from setup');
  const map=settings.map??((settings.team_sizes?.length??settings.team_count)>2?'Harbor Ring':'Glacier');
  requireEvidence(typeof native.map==='string'&&native.map.length>0&&[native.map,native.map_file].some(name=>typeof name==='string'&&name.toLowerCase()===map.toLowerCase()),'native map differs from setup');
  if(expected){
    requireEvidence(same(Object.fromEntries(expected.seats.map(s=>[s,true])),Object.fromEntries(seats.map(s=>[s,true]))),'roster differs from task contract');
    const configured=resolveTeams(validateSettings(expected.settings),seats);
    for(const key of ['game_mode','games','time_limit_sec','seed','map','team_count','team_size','team_sizes'])
      requireEvidence(JSON.stringify(configured[key])===JSON.stringify(settings[key]),`${key} differs from task contract`);
  }
  requireEvidence(result?.started===true,'series never started or has no result; infrastructure-invalid and unscored');
  const count=settings.games, results=result.results;
  if(!Array.isArray(results)||results.length!==count)throw new Error(`The series has ${count} games, but its result has ${Array.isArray(results)?results.length:'none'}`);
  const teams=native.seat_teams;
  requireEvidence(object(teams)&&Object.keys(teams).length===seats.length,'native roster mismatch');
  for(const seat of seats)requireEvidence(NATIVE_TEAMS.has(teams[seat]),`native setup gives ${seat} no team`);
  const sizes=settings.team_sizes??Array(settings.team_count).fill(settings.team_size);
  let offset=0;const groups=[];
  for(const size of sizes){const group=seats.slice(offset,offset+=size);groups.push(teams[group[0]]);requireEvidence(group.every(s=>teams[s]===teams[group[0]]),'native team assignment differs from configured groups');}
  requireEvidence(new Set(groups).size===sizes.length,'native teams merge configured groups');
  requireEvidence(Array.isArray(native.cores)&&native.cores.length>0,'missing initial cores');
  const initial=new Set(native.cores.map(c=>c.team));
  const legal=new Set(groups);
  requireEvidence(initial.size===legal.size&&[...legal].every(team=>initial.has(team)), 'initial core teams differ from player teams');
  for(const core of native.cores)requireEvidence(object(core)&&finite(core.health)&&finite(core.max_health)&&core.max_health>0&&core.health>0&&core.health<=core.max_health,'invalid initial core health');
  const games=results.map((terminal,i)=>{
    requireEvidence(object(terminal),'terminal must be an object');
    if(terminal.game!==i+1)throw new Error(`Game ${i+1}'s result carries game ${terminal.game}`);
    if(!same(terminal.seat_teams,teams))throw new Error(`The seats' teams in game ${i+1} differ from game 1's native setup`);
    const {reason,winning_team:winner,elapsed_seconds:elapsed,core_health_by_team:cores}=terminal;
    requireEvidence(['time_limit','core_destroyed','game_over'].includes(reason),'unsupported terminal reason');
    requireEvidence(finite(elapsed),'invalid elapsed time');
    requireEvidence(winner===null||(NATIVE_TEAMS.has(winner)&&legal.has(winner)),'unknown or missing winning team');
    requireEvidence(Number.isInteger(terminal.wave)&&terminal.wave>=1&&Number.isInteger(terminal.waves_completed)&&terminal.waves_completed>=0,'invalid wave evidence');
    requireEvidence(terminal.survival_censored===(reason==='time_limit'),'censor flag disagrees with reason');
    const limit=settings.time_limit_sec;
    if(limit!==null)requireEvidence(elapsed<=limit+Math.max(5,limit*0.01),'elapsed exceeds deadline tolerance');
    if(reason==='time_limit')requireEvidence(limit!==null&&elapsed>=limit&&winner===null,'time limit must be reached with no winner');
    else requireEvidence(winner!==null,'native victory has no winner');
    requireEvidence(object(cores)&&Object.keys(cores).length>0,'missing core evidence');
    requireEvidence(Object.keys(cores).length===initial.size,'terminal core teams differ from initial teams');
    for(const team of initial)requireEvidence(Object.hasOwn(cores,team),'missing initial core team');
    for(const [team,core] of Object.entries(cores))requireEvidence(NATIVE_TEAMS.has(team)&&object(core)&&finite(core.health)&&finite(core.max_health)&&core.max_health>0&&core.health<=core.max_health,'invalid core health');
    if(winner!==null){
      requireEvidence(cores[winner].health>0,'winning team has no surviving core');
      requireEvidence(Object.entries(cores).some(([team,core])=>team!==winner&&core.health===0),'core victory has no destroyed opponent core');
      requireEvidence(Object.entries(cores).every(([team,core])=>team===winner||core.health===0),'victory leaves opposing cores alive');
    }
    return {game:i+1,reason,winning_team:winner,elapsed_seconds:elapsed};
  });
  const wins = Object.fromEntries(Object.values(teams).map(team => [team, 0]));
  for (const {winning_team: winner} of games) if (winner !== null) wins[winner] = (wins[winner] ?? 0) + 1;
  const draws = games.filter(g => g.winning_team === null).length;
  const most = Math.max(...Object.values(wins));
  const leaders = Object.values(wins).filter(n => n === most).length;
  const rewards = Object.fromEntries(seats.map(seat => [seat, wins[teams[seat]] < most ? 0 : leaders === 1 ? 1 : 0.5]));
  const reward = {
    completed: 1,
    lobby_expired: 0,
    games: count,
    ...rewards,
    ...Object.fromEntries(Object.entries(wins).map(([team, n]) => [`wins_${team}`, n])),
    draws,
  };
  return {reward, series: {completed: true, games, tally: {wins, draws}, rewards}};
}
