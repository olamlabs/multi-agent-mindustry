import {execFileSync} from 'node:child_process';
import {appendFileSync,cpSync,existsSync,mkdirSync,readFileSync,readdirSync,statSync,writeFileSync} from 'node:fs';
import {join,relative} from 'node:path';
import {createHash} from 'node:crypto';
import {startApp} from '../fixtures/app-process.mjs';

const seats=Array.from({length:20},(_,i)=>`seat-${i+1}`);
const output=process.env.SMOKE_EVIDENCE??'/tmp/mindustry-survival-construction-smoke';
const task=process.env.SMOKE_TASK??'/task';
const settings={game_mode:'survival',map:'Fork',team_sizes:[20],seed:1,time_limit_sec:null,endless_survival:{first_wave_ticks:5184000,wave_spacing_ticks:7200,spawn_seed:1,enemy_unit_health_multiplier:1,enemy_unit_damage_multiplier:1},agent_ready_required:true,save_interval_sec:60,video:{record:false}};
mkdirSync(output,{recursive:true});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const report={schema_version:'1.0',status:'running',classification:'model_free_finite_construction_diagnostic',endless_score_evidence:false,paid_models:false,settings,started_at:new Date().toISOString(),runtime_image:process.env.SMOKE_RUNTIME_DIGEST??null,checks:[],claims_excluded:['LLM building competence','twenty-agent cooperation','endless survival scoring','wave calibration','combat effectiveness']};
const hash=file=>createHash('sha256').update(readFileSync(file)).digest('hex');
function sourceFiles(dir,base=task){return readdirSync(dir).sort().flatMap(name=>{const file=join(dir,name);return statSync(file).isDirectory()?sourceFiles(file,base):[{path:relative(base,file),sha256:hash(file)}];});}
report.source_files=sourceFiles(task);
if(existsSync('/opt/mindustry/server.jar'))report.server_jar_sha256=hash('/opt/mindustry/server.jar');
writeFileSync(join(output,'source-manifest.json'),JSON.stringify({runtime_image:report.runtime_image,server_jar_sha256:report.server_jar_sha256,files:report.source_files},null,2)+'\n');
const fail=(message,evidence)=>{throw new Error(`${message}: ${JSON.stringify(evidence).slice(0,3000)}`);};
let app;
async function call(seat,endpoint,body){
  const result=await app.seat(seat).request(endpoint,{method:body===undefined?'GET':'POST',body,signal:AbortSignal.timeout(30000)});
  appendFileSync(join(output,'agent-api.jsonl'),JSON.stringify({at:new Date().toISOString(),seat,endpoint,args:body??null,...result})+'\n');
  if(result.status!==200)fail(`Agent endpoint ${endpoint} refused`,result);
  return result.body;
}
async function act(ops){const result=await call('seat-1','/act',{ops});if(result.results?.some(r=>!r.ok))fail('Native operation refused',result);return result;}
const query=async body=>(await call('seat-1','/query',body)).rows;
const rows=file=>(app.file(file)??'').split('\n').filter(Boolean).flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}});
function inspect(plan,team){
  const events=rows('engine/events.jsonl');
  const completed=events.filter(e=>e.event==='log'&&e.data?.entry?.kind==='block_build_end'&&!e.data.entry.breaking).map(e=>({sequence:e.sequence,...e.data.entry}));
  const selected=plan.map(p=>completed.find(e=>e.tile?.x===p.x&&e.tile?.y===p.y&&e.tile?.type===p.block&&e.team===team));
  const evaluation=rows('engine/evaluation.jsonl');
  const last=evaluation.at(-1);
  const drill=last?.buildings?.find(b=>b.x===plan[0].x&&b.y===plan[0].y&&b.type==='mechanical-drill'&&b.team===team);
  const delivered=last?.deliveries?.find(d=>d.team===team&&d.sink==='turret');
  return {complete_build_count:selected.filter(Boolean).length,expected_build_count:plan.length,build_events:selected.filter(Boolean),extracted_copper:drill?.output?.items?.copper??0,turret_delivered_copper:delivered?.items?.copper??0,evaluation_frame_count:evaluation.length,evaluation_frame_time:last?.t??null,drill_meter:drill??null,delivery_row:delivered??null};
}
try {
  app=await startApp({main:join(task,'environment/sim/main.mjs'),seats,settings});
  await app.until(()=>app.healthy(),{timeoutMs:120000,what:'native engine startup'});
  const before=await call('seat-1','/update');
  if(before.status?.phase!=='waiting')fail('Game started before all twenty acknowledgments',before);
  for(const seat of seats)await call(seat,'/ready',{});
  const running=await app.until(async()=>{const view=await call('seat-1','/update');if(view.status?.phase==='failed')fail('Startup failed',view);return view.status?.phase==='running'?view:null;},{timeoutMs:30000,what:'all-agent barrier and native play'});
  const readiness=JSON.parse(app.file('agent-readiness.json'));
  if(readiness.state!=='started'||readiness.ready_seats.length!==20||Object.keys(readiness.acknowledgments).length!==20)fail('Readiness evidence incomplete',readiness);
  report.checks.push({check:'twenty_agent_readiness_barrier',status:'PASS',ready_seats:readiness.ready_seats});
  const observed=await Promise.all(seats.map(seat=>call(seat,'/update')));
  const team=running.status.team;
  if(observed.some(v=>v.status?.team!==team||!Number.isInteger(v.status?.you?.unit_id)))fail('Twenty native player units missing or split across teams',observed.map(v=>v.status));
  const buildings=await query({of:'buildings',filter:[['team','eq',team]],limit:100000});
  const core=buildings.find(b=>b.type.startsWith('core-'));
  if(!core)fail('No native friendly core',buildings);
  if(buildings.some(b=>b.type==='duo'))fail('Fixture requires no pre-existing duo so turret deliveries are attributable',buildings);
  report.initial_core=core;
  const area={x:Math.max(0,core.x-45),y:Math.max(0,core.y-45),w:90,h:90};
  const tiles=await query({of:'tiles',area,limit:100000});
  writeFileSync(join(output,'initial-tiles.json'),JSON.stringify(tiles)+'\n');
  const tileMap=new Map(tiles.map(t=>[`${t.x},${t.y}`,t]));
  const at=(x,y)=>tileMap.get(`${x},${y}`);
  const clear=(x,y)=>{const t=at(x,y);return t?.block==='air'&&!/water|slag|oil|arkycite|neoplasm/.test(t.floor);};
  const candidates=[];
  for(const tile of tiles){
    const {x,y}=tile;
    const footprint=[[x,y],[x+1,y],[x,y+1],[x+1,y+1]];
    if(!footprint.every(([a,b])=>clear(a,b)))continue;
    const ore=footprint.map(([a,b])=>at(a,b).ore).filter(Boolean);
    if(!ore.includes('ore-copper')||ore.some(o=>o!=='ore-copper'))continue;
    for(const [dx,dy,rotation,first] of [[1,0,0,{x:x+2,y}],[-1,0,2,{x:x-1,y}],[0,1,1,{x,y:y+2}],[0,-1,3,{x,y:y-1}]]){
      const line=Array.from({length:4},(_,i)=>({x:first.x+dx*i,y:first.y+dy*i,block:i===3?'duo':'conveyor',rotation}));
      if(line.every(p=>clear(p.x,p.y)))candidates.push({distance:Math.hypot(x-core.x,y-core.y),copper_tiles:ore.length,plan:[{x,y,block:'mechanical-drill',rotation:0},...line]});
    }
  }
  candidates.sort((a,b)=>a.distance-b.distance||b.copper_tiles-a.copper_tiles);
  report.candidate_count=candidates.length;
  if(!candidates.length)fail('No legal-looking nearby copper drill and conveyor/turret layout found',area);

  let chosen;
  for(const candidate of candidates.slice(0,20)){
    const attempt=await call('seat-1','/act',{ops:[{op:'plan_add',plan:candidate.plan[0]}]});
    if(attempt.results?.[0]?.ok){chosen=candidate;break;}
  }
  if(!chosen)fail('Native game refused every drill placement candidate',candidates.slice(0,20));
  report.selected=chosen;
  await act([...chosen.plan.slice(1).map(plan=>({op:'plan_add',plan})),{op:'input',building:true,move_to:{x:chosen.plan[0].x+0.5,y:chosen.plan[0].y+0.5}}]);
  const waitUntil=Date.now()+120000;
  let proof;
  while(Date.now()<waitUntil){
    proof=inspect(chosen.plan,team);
    if(proof.complete_build_count===chosen.plan.length&&proof.extracted_copper>0&&proof.turret_delivered_copper>0)break;
    const view=await call('seat-1','/update');
    if(view.game_over)fail('Game ended before construction and flow proof',{view,proof});
    if(Date.now()%10000<1200)report.last_observation=view;
    await sleep(1000);
  }
  const finalBuildings=await query({of:'buildings',filter:[['team','eq',team]],limit:100000});
  report.final_buildings=finalBuildings;
  report.final_builder=(await query({of:'units',filter:[['id','eq',observed[0].status.you.unit_id]],limit:10}))[0];
  if(proof.complete_build_count!==chosen.plan.length||proof.extracted_copper<=0||proof.turret_delivered_copper<=0)fail('Accepted build plans did not establish the required native supply chain',{proof,builder:report.final_builder,buildings:finalBuildings});
  for(const expected of chosen.plan){const actual=finalBuildings.find(b=>b.x===expected.x&&b.y===expected.y&&b.type===expected.block);if(!actual||(expected.block==='conveyor'&&actual.rotation!==expected.rotation))fail('Final building/rotation differs from submitted plan',{expected,actual});}
  report.proof=proof;
  report.checks.push({check:'native_completed_drill_conveyors_turret',status:'PASS',count:proof.complete_build_count});
  report.checks.push({check:'actual_copper_extraction',status:'PASS',items:proof.extracted_copper});
  report.checks.push({check:'actual_transport_to_turret_sink',status:'PASS',items:proof.turret_delivered_copper});
  execFileSync(process.execPath,[join(task,'environment/sim/metrics.mjs'),app.logs,join(output,'metrics.json')]);
  report.status='passed';
  report.stop_reason='Scripted diagnostic observation stopped after native construction and delivery proof; no endless score is assigned.';
  console.log(JSON.stringify({status:report.status,selected:report.selected,proof:report.proof}));
} catch(error){
  report.status='failed';report.error=String(error.stack??error);
  console.error(report.error);process.exitCode=1;
} finally {
  report.finished_at=new Date().toISOString();
  if(app){
    writeFileSync(join(output,'app-console.log'),app.output());
    if(app.child.exitCode===null){app.child.kill('SIGTERM');await Promise.race([new Promise(r=>app.child.once('exit',r)),sleep(5000)]);if(app.child.exitCode===null){app.child.kill('SIGKILL');await sleep(250);}}
    cpSync(app.logs,join(output,'sim'),{recursive:true});
    report.raw_artifacts=sourceFiles(join(output,'sim'),output);
    await app.stop();
  }
  writeFileSync(join(output,'smoke-result.json'),JSON.stringify(report,null,2)+'\n');
}
