import {execFileSync} from 'node:child_process';
import {cpSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {MAX_SEATS,seatsFromRoster} from '../../environment/sim/settings.mjs';
import {startApp} from './app-process.mjs';

const smokeSeats=Number(process.env.SMOKE_SEATS??4);
if(!Number.isInteger(smokeSeats)||smokeSeats<4||smokeSeats>MAX_SEATS||smokeSeats%2)throw new Error(`This cooperative API smoke check requires an even SMOKE_SEATS from 4 to ${MAX_SEATS}, with a teammate and an opponent.`);
const SEATS=seatsFromRoster(Object.fromEntries(Array.from({length:smokeSeats},(_,i)=>[`seat-${i+1}`,`seat-${i+1}`])));
const MODE='pvp';
const releaseSettings=JSON.parse(readFileSync(new URL('../../config.json',import.meta.url))).settings;
const evidence=process.env.SMOKE_EVIDENCE??'/tmp/mindustry-series-backend-smoke';
mkdirSync(evidence,{recursive:true});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const fail=(what,value)=>{throw new Error(what+': '+JSON.stringify(value).slice(0,2000));};
const app=await startApp({main:'/task/environment/sim/main.mjs',seats:SEATS,settings:{...releaseSettings,game_mode:MODE,time_limit_sec:30,seed:1,games:2,chat_after_sec:5,video:{record:false}}});

async function act(seat,name,args){
  const reply=await app.seat(seat).request('/'+name,{method:'POST',body:args});
  if(reply.status===200)return {ok:true,result:reply.body};
  if(reply.status===409||reply.status===400){if(reply.body.status?.phase==null)fail(`${seat} ${name} refusal carries no status`,reply.body);return {ok:false,error:reply.body.error};}
  fail(`${seat} ${name} answered HTTP ${reply.status}`,reply.body);
}
async function ok(seat,name,args){const reply=await act(seat,name,args);if(!reply.ok)fail(`${seat} ${name} rejected`,reply);if(reply.result.status?.phase==null)fail(`${seat} ${name} reply carries no status`,reply.result);return reply.result;}
const observe=seat=>app.seat(seat).get('/update');

try {
  while(!(await app.healthy())){if(app.child.exitCode!=null)fail('the app exited while loading',app.output());await sleep(250);}
  await Promise.all(SEATS.map(s=>app.seat(s).get('/brief')));
  const endpoints=(await app.seat(SEATS[0]).get('/')).endpoints.map(endpoint=>endpoint.path);
  if(endpoints.join()!=='/brief,/update,/wait,/query,/events,/act,/say,/wake')fail('endpoints',endpoints);

  let view;const deadline=Date.now()+600000;
  while(Date.now()<deadline){view=await observe(SEATS[0]);if(view.game_over)fail('ended before play',app.file('result.json'));if(view.status.phase==='running')break;await sleep(500);}
  if(view.status.phase!=='running')fail('never running',view);
  const setup=JSON.parse(app.file('setup.json'));
  if(setup.settings.map!==releaseSettings.map||setup.engine.map!==releaseSettings.map)fail('configured map',setup);

  const observed=await Promise.all(SEATS.map(observe));
  for(const [i,o] of observed.entries()) {
    const status=o.status;
    if(status.phase!=='running'||status.game?.number!==1||status.game.of!==2||typeof status.team!=='string'||!Number.isInteger(status.you?.unit_id)||typeof status.you.stack!=='object')fail('status '+SEATS[i],status);
    if(!(status.core?.health>0)||typeof status.core.items!=='object'||'wake_head' in status)fail('status core '+SEATS[i],status);
    if(JSON.stringify(status).length>900)fail('status too large',o);
    if(/time_limit|end_condition|survival_censored/.test(JSON.stringify(o)))fail('status leaks the horizon',o);
  }
  const team=seat=>observed[SEATS.indexOf(seat)].status.team;
  const friend=SEATS.find(s=>s!==SEATS[0]&&team(s)===team(SEATS[0])),enemy=SEATS.find(s=>team(s)!==team(SEATS[0]));
  if(!friend||!enemy)fail('cooperative API smoke needs a teammate and an opposing seat',observed);

  const collections=await ok(SEATS[0],'query',{of:'collections'});
  for(const name of ['match','players','teams','units','buildings','tiles','bullets','blocks','unit_types','items','liquids','ops'])
    if(!JSON.stringify(collections.rows).includes(`"${name}"`))fail('missing collection '+name,collections);
  const me=(await ok(SEATS[0],'query',{of:'units',filter:[['id','eq',observed[0].status.you.unit_id]]})).rows[0];
  if(!me||typeof me.x!=='number'||!('health' in me))fail('own unit',me);
  const cores=(await ok(SEATS[0],'query',{of:'buildings',filter:[['type','contains','core']],limit:100000})).rows;
  if(cores.length<2)fail('cores',cores);
  const tiles=await ok(SEATS[0],'query',{of:'tiles',area:{x:0,y:0,w:10,h:10},limit:100000});
  if(tiles.rows.length!==100)fail('tiles in area',tiles.rows.length);
  const paged=await ok(SEATS[0],'query',{of:'tiles',limit:5});
  const next=await ok(SEATS[0],'query',{of:'tiles',limit:5,after:paged.next});
  if(paged.rows.length!==5||next.rows.length!==5||JSON.stringify(paged.rows)===JSON.stringify(next.rows))fail('paging',{paged,next});

  const malformed=async(name,args,expected)=>{
    const reply=await app.seat(SEATS[0]).request('/'+name,{method:'POST',body:args});
    if(reply.status!==400||reply.body.error!==expected||reply.body.status?.phase!=='running')fail(`${name} ${JSON.stringify(args)} must answer 400 "${expected}"`,reply);
  };
  await malformed('query',{of:'tanks'},'of: "tanks" is not one of collections, match, players, teams, units, buildings, tiles, bullets, blocks, unit_types, items, liquids, ops');
  await malformed('act',{ops:[{op:'plan_clear'},{op:'plan_add',plan:{x:1,y:1,block:'ground-factory',config:{name:'flare'}}}]},'ops[1].plan.config.type: required; one of item, liquid, block, unit, command, stance, int, float, point, points, ints, bytes, logic');
  const sand=await app.seat(SEATS[0]).request('/query',{method:'POST',body:{of:'tiles',filter:[['floor','in',['sand','darksand']]]}});
  if(sand.status!==400||!sand.body.error.startsWith('filter[0]: no floor is named "sand"; the floor names containing it are ')||!sand.body.error.includes('sand-floor'))fail('a filter naming no floor',sand);
  const wrongMethod=await app.seat(SEATS[0]).request('/wait');
  if(wrongMethod.status!==405||wrongMethod.body.error!=='/wait is POST, not GET')fail('GET /wait',wrongMethod);
  if(me.controlled!=='player')fail('a seat\'s own unit is controlled by its player',me);

  const said=await ok(SEATS[0],'say',{text:'smoke: team hello',to:[friend],data:{probe:1}});
  if(said.message?.audience!=='team'||said.message.from!==SEATS[0])fail('say',said);
  const friendStatus=(await observe(friend)).status;
  if(friendStatus.chat?.text!=='smoke: team hello'||friendStatus.chat.from!==SEATS[0]||!friendStatus.chat.to.includes(friend))fail('friend status shows the newest message',friendStatus);
  const friendLog=await ok(friend,'events',{after:0,filter:[['kind','eq','say']]});
  if(!friendLog.events.some(e=>e.text==='smoke: team hello'&&e.data?.probe===1))fail('friend sees team message',friendLog);
  const named=await ok(friend,'events',{cursor:'smoke.chat',filter:[['kind','eq','say']]});
  if(!named.events.some(e=>e.text==='smoke: team hello'))fail('named cursor returns the message',named);
  if((await ok(friend,'events',{cursor:'smoke.chat'})).events.length)fail('named cursor returns each entry once',{});
  if(!(await ok(friend,'events',{latest:1,filter:[['kind','eq','say']]})).events.some(e=>e.text==='smoke: team hello'))fail('latest returns the newest message',{});
  if(enemy) {
    const enemyLog=await ok(enemy,'events',{after:0,filter:[['kind','eq','say']]});
    if(enemyLog.events.length)fail('team message leaked to enemy',enemyLog);
  }
  if((await act(SEATS[0],'say',{text:'x',audience:'all'})).ok!==false)fail('audience all must be refused without all_chat',{});
  await observe(SEATS[0]);
  const woken=app.seat(SEATS[0]).post('/wait');
  await ok(SEATS[0],'say',{text:'note to self',audience:'self'});
  const after=(await woken).status;
  if(after.chat?.text!=='note to self')fail('a self message wakes the seat and is its newest message',after);

  const defaults=(await ok(SEATS[0],'wake',{})).filters;
  if(JSON.stringify(defaults)!==JSON.stringify([[['kind','eq','say'],['from','ne',SEATS[0]]],[['kind','eq','say'],['audience','eq','self']]]))fail('the default wake filters',defaults);
  if((await act(SEATS[0],'wake',{after:0,filter:[]})).ok!==false)fail('the old wake arguments must be refused',{});
  const wakeOn=[[['kind','eq','never']],[['kind','eq','say'],['text','eq','smoke: wake me']]];
  if(JSON.stringify((await ok(SEATS[0],'wake',{filters:wakeOn})).filters)!==JSON.stringify(wakeOn))fail('wake replaces the list',{});
  await observe(SEATS[0]);
  const held=app.seat(SEATS[0]).post('/wait');
  await ok(friend,'say',{text:'smoke: not this one'});
  if(await Promise.race([held.then(()=>'woke'),sleep(1500).then(()=>'held')])!=='held')fail('a message outside the list must not wake the seat',await held);
  await ok(friend,'say',{text:'smoke: wake me'});
  const woke=(await held).status;
  if(woke.chat?.text!=='smoke: wake me')fail('a message the list names wakes the seat',woke);
  await ok(SEATS[0],'wake',{filters:defaults});

  if((await act(SEATS[0],'act',{ops:[{op:'plan_clear'},{op:'no_such_op'}]})).ok!==false)fail('an unknown op must reject the whole call',{});
  const results=(await ok(SEATS[0],'act',{ops:[{op:'input',move_to:{x:me.x+3,y:me.y}},{op:'rotate',building:2147483000,clockwise:true},{op:'plan_clear'}]})).results;
  if(results.length!==3||!results[0].ok||results[1].ok||results[1].error?.code!=='unknown_entity'||!results[2].ok)fail('per-op results',results);
  const teamLog=await ok(friend,'events',{after:0,filter:[['kind','eq','act']]});
  if(!teamLog.events.some(e=>e.seat===SEATS[0]&&e.op==='input'))fail('teammate input receipt',teamLog);
  if(enemy&&(await ok(enemy,'events',{after:0,filter:[['kind','eq','act']]})).events.some(e=>e.seat===SEATS[0]))fail('input receipt leaked to enemy',{});

  const teams=Object.fromEntries(observed.map((o,i)=>[SEATS[i],o.status.team]));
  const map=(await ok(SEATS[0],'query',{of:'match',fields:['game','map']})).rows[0];
  let between=(await observe(SEATS[0])).status;
  const wakes=[`${between.game.number} ${between.phase}`];
  if(between.game.number!==1)fail('game 1 ended before its checks were done',between);
  while(!(between.game.number===2&&between.phase==='running')){
    between=(await app.seat(SEATS[0]).post('/wait')).status;
    wakes.push(`${between.game.number} ${between.phase}`);
    if(!['running','restarting'].includes(between.phase)||Date.now()>deadline)fail('between games',{wakes,between});
  }
  const second=await Promise.all(SEATS.map(observe));
  for(const [i,o] of second.entries()){
    const status=o.status;
    if(status.game.number!==2||status.team!==teams[SEATS[i]]||!Number.isInteger(status.you?.unit_id)||status.chat!==null)fail('game 2 status '+SEATS[i],status);
    if(status.results?.length!==1||status.results[0].game!==1||status.results[0].reason!=='time_limit')fail('game 1 result '+SEATS[i],status);
    const entries=(await ok(SEATS[i],'events',{after:0,limit:100000})).events;
    if(entries.some(entry=>entry.game!==2))fail('game 2 log '+SEATS[i],entries.slice(0,5));
  }
  const map2=(await ok(SEATS[0],'query',{of:'match',fields:['game','map']})).rows[0];
  if(map2.game!==2||map2.map!==map.map)fail('the same map',{map,map2});
  if((await ok(friend,'events',{cursor:'smoke.chat'})).events.length)fail('a reader starts empty in game 2',{});
  const moved=(await ok(SEATS[0],'act',{ops:[{op:'input',move_to:{x:second[0].status.you.x+3,y:second[0].status.you.y}}]})).results;
  if(!moved[0].ok)fail('game 2 takes inputs',moved);
  const heard=await ok(SEATS[0],'say',{text:'smoke: game two'});
  if(heard.message.game!==2||(await observe(friend)).status.chat?.text!=='smoke: game two')fail('game 2 messages',heard);

  let last=(await observe(SEATS[0])).status;
  while(last.phase!=='chat'){
    if(!['running','ending'].includes(last.phase)||Date.now()>deadline)fail('the end of the last game',last);
    last=(await app.seat(SEATS[0]).post('/wait?timeout_sec=5')).status;
  }
  if(last.game.number!==2||last.results?.length!==2||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(last.chat_open_until))fail('the chat window status',last);
  const closed=await app.seat(SEATS[0]).request('/act',{method:'POST',body:{ops:[{op:'plan_clear'}]}});
  if(closed.status!==409||closed.body.error!==`The series is over, so act applies no inputs. Team chat (say) stays open until ${last.chat_open_until}; then every request answers game_over: true.`)fail('act while chat is open',closed);
  const parting=await ok(SEATS[0],'say',{text:'smoke: gg'});
  if(parting.status.phase!=='chat'||(await observe(friend)).status.chat?.text!=='smoke: gg')fail('a message after the last game',parting);

  let result=null;
  while(Date.now()<deadline&&!(result=app.file('result.json')))await sleep(500);
  if(!result)fail('no result',{});
  if(JSON.parse(result).failure)fail('failed',result);
  const late=await app.seat(SEATS[0]).request('/act',{method:'POST',body:{ops:[{op:'plan_clear'}]}});
  if(late.status!==410||late.body.game_over!==true)fail('input after the end must say the game is over',late);
  const log=app.log();
  const terminals=log.filter(entry=>entry.type==='game_ended').map(entry=>entry.terminal);
  if(terminals.map(terminal=>terminal.game).join()!=='1,2')fail('a native terminal per game in the game log',log.slice(-5));
  if(terminals.some(terminal=>JSON.stringify(terminal.seat_teams)!==JSON.stringify(teams)))fail('the same teams in both games',terminals);

  execFileSync(process.execPath,['/task/environment/sim/verify.mjs',app.logs,join(evidence,'reward.json')]);
  const graded=JSON.parse(readFileSync(join(evidence,'reward.json'),'utf8'));
  const series=JSON.parse(readFileSync(join(evidence,'series.json'),'utf8'));
  if(graded.completed!==1||graded.games!==2||series.games.length!==2||SEATS.some(seat=>typeof graded[seat]!=='number'))fail('rewards',{graded,series});
  if(MODE==='pvp'&&SEATS.some(seat=>graded[seat]!==0.5))fail('a series of drawn PvP games scores one half',graded);
  writeFileSync(evidence+'/smoke-result.json',JSON.stringify({terminals,graded,series,wakes,collections:collections.rows},null,2));
  console.log(JSON.stringify({terminals,graded,wakes}));
} finally {cpSync(app.logs,join(evidence,'sim'),{recursive:true});await app.stop();}
