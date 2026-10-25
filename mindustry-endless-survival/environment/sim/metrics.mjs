import {createReadStream, existsSync, readFileSync, writeFileSync} from 'node:fs';
import {createInterface} from 'node:readline';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {gradeEndlessSurvival} from './survival-grade.mjs';
import {readGame} from './verify.mjs';

const ratio=(a,b)=>b>0?a/b:null;
const sum=m=>Object.values(m??{}).reduce((a,b)=>a+b,0);
function add(target,source){for(const [key,n] of Object.entries(source??{}))target[key]=(target[key]??0)+n;}
function minimum(target,source){for(const [key,n] of Object.entries(source??{}))target[key]=Math.min(target[key]??Infinity,n);}
function monotone(old,next,path=''){
  for(const [key,n] of Object.entries(next??{})){
    if(typeof n==='object'&&n!==null)monotone(old?.[key],n,path+'.'+key);
    else if(typeof n!=='number'||!Number.isFinite(n)||n<0||n<(old?.[key]??0)-1e-6)
      throw new Error(`Invalid cumulative counter ${path}.${key}`);
  }
  for(const key of Object.keys(old??{}))if(!(key in next))throw new Error(`Counter disappeared ${path}.${key}`);
}

export async function productionMetrics(lines,teamNames){
  const lifetimes=new Map();let last=null,frames=0;
  for await(const line of lines){
    if(typeof line==='string'&&!line.trim())continue;
    const frame=typeof line==='string'?JSON.parse(line):line;
    if(frame.coverage?.schema_version!==1||!Number.isFinite(frame.simulation_seconds)||frame.simulation_seconds<0||
       frame.simulation_seconds<(last?.simulation_seconds??0)||!Array.isArray(frame.buildings))throw new Error('Invalid production frame');
    const ids=new Set();
    for(const row of frame.buildings){
      if(!Number.isInteger(row.id)||ids.has(row.id)||typeof row.team!=='string'||row.supported!==true)throw new Error('Invalid production lifetime');
      ids.add(row.id);const previous=lifetimes.get(row.id);
      if(previous&&['team','type','kind','building_id','x','y','start_simulation_seconds'].some(k=>row[k]!==previous[k]))throw new Error('Lifetime identity changed');
      for(const key of ['output','potential_output','seconds'])monotone(previous?.[key],row[key],key);
      monotone({seconds:previous?.observed_simulation_seconds??0},{seconds:row.observed_simulation_seconds});
      if(row.belt)monotone(previous?.belt&&{
        transferred_items:previous.belt.transferred_items,nominal_capacity_items:previous.belt.nominal_capacity_items,
        classified_seconds:previous.belt.classified_seconds,near_capacity_seconds:previous.belt.near_capacity_seconds},
      {transferred_items:row.belt.transferred_items,nominal_capacity_items:row.belt.nominal_capacity_items,
        classified_seconds:row.belt.classified_seconds,near_capacity_seconds:row.belt.near_capacity_seconds});
      lifetimes.set(row.id,row);
    }
    if(frame.final===true&&[...lifetimes.values()].some(row=>row.active&&!ids.has(row.id)))throw new Error('Final frame omitted active lifetime');
    last=frame;frames++;
  }
  if(!last)return {status:'unavailable',reason:'No production frames',teams:null};
  const duration=last.simulation_seconds;
  const complete=last.final===true;
  const teams={};
  for(const team of new Set([...teamNames,...[...lifetimes.values()].map(r=>r.team)])){
    const rows=[...lifetimes.values()].filter(r=>r.team===team);
    const output={items:{},liquids:{},new_units:{},upgraded_units:{}};
    const first={items:{},liquids:{},new_units:{},upgraded_units:{}};
    const capacity={items:{},liquids:{},new_units:{}};
    const seconds={},belts={transfer_hops_by_item:{},nominal_capacity_items:0,observed_belt_seconds:0,near_capacity_seconds:0,classified_seconds:0,partial_window_seconds:0};
    for(const r of rows){
      add(output.items,r.output.items);add(output.liquids,r.output.liquids);
      minimum(first.items,r.first_output_simulation_seconds?.items);minimum(first.liquids,r.first_output_simulation_seconds?.liquids);
      const kind=r.kind??(r.type.endsWith('-reconstructor')?'reconstructor':r.belt?'belt':'unit_factory');
      const unitKey=kind==='reconstructor'?'upgraded_units':'new_units';
      add(output[unitKey],r.output.units);minimum(first[unitKey],r.first_output_simulation_seconds?.units);
      add(capacity.items,r.potential_output.items);add(capacity.liquids,r.potential_output.liquids);
      if(kind!=='reconstructor')add(capacity.new_units,r.potential_output.units);
      if(!r.belt)add(seconds,r.seconds);
      else{
        add(belts.transfer_hops_by_item,r.belt.transferred_items);
        belts.observed_belt_seconds+=r.observed_simulation_seconds;
        for(const key of ['nominal_capacity_items','near_capacity_seconds','classified_seconds','partial_window_seconds'])belts[key]+=r.belt[key];
      }
    }
    const perMinute=Object.fromEntries(Object.entries(output).map(([kind,values])=>[kind,Object.fromEntries(Object.entries(values).map(([k,v])=>[k,ratio(v*60,duration)]))]));
    const utilization=Object.fromEntries(Object.entries(capacity).map(([kind,values])=>[kind,Object.fromEntries(Object.entries(values).map(([k,v])=>[k,ratio(output[kind][k]??0,v)]))]));
    teams[team]={lifetimes:rows.length,output,output_per_simulation_minute:perMinute,first_output_simulation_seconds:first,
      nominal_capacity:capacity,output_utilization:utilization,overlapping_factory_condition_seconds:seconds,
      belts:{...belts,capacity_ratio:ratio(sum(belts.transfer_hops_by_item),belts.nominal_capacity_items),
        near_capacity_fraction:ratio(belts.near_capacity_seconds,belts.classified_seconds)}};
  }
  return {status:complete?'complete':'partial',frames,simulation_seconds:duration,final_wall_seconds:last.t,
    coverage:last.coverage,teams,
    limitations:['Only supported native building classes are measured here; drills, player mining, separators and other transport are in the evaluation section.',
      'Belt counts are transfer hops: an item crossing several belts is counted at each belt.',
      'Rates use whole-match simulation time. Utilization uses integrated nominal capacity, includes idle time and can exceed one.',
      'First output is progression evidence; research unlocks and strategic quality are separate.']};
}

const add2=(target,key,n)=>{target[key]=(target[key]??0)+n;};
function addNested(target,source){for(const [k,v] of Object.entries(source??{})){if(typeof v==='object'&&v!==null){target[k]??={};addNested(target[k],v);}else add2(target,k,v);}}
async function* jsonLines(lines){
  for await(const line of lines){if(typeof line==='string'&&!line.trim())continue;yield typeof line==='string'?JSON.parse(line):line;}
}

const isObject=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
function objectAt(value,path){if(!isObject(value))throw new Error(`Missing or invalid ${path}`);return value;}
function nonnegative(value,path,{nullable=false,integer=false}={}){
  if(nullable&&value===null)return;
  if(typeof value!=='number'||!Number.isFinite(value)||value<0||(integer&&!Number.isInteger(value)))throw new Error(`Invalid counter ${path}`);
}
function numericTree(value,path){
  objectAt(value,path);
  for(const [key,n] of Object.entries(value)){
    if(isObject(n))numericTree(n,`${path}.${key}`);else nonnegative(n,`${path}.${key}`);
  }
  return value;
}
function counters(old,next,path){numericTree(next,path);monotone(old,next,path);}
function numberMap(value,path){objectAt(value,path);for(const [key,n] of Object.entries(value))nonnegative(n,`${path}.${key}`);return value;}
function fields(row,names,path){
  objectAt(row,path);
  const out={};for(const name of names){nonnegative(row[name],`${path}.${name}`);out[name]=row[name];}return out;
}

function cumulativeRows(old,rows,identity,values,path){
  if(!Array.isArray(rows))throw new Error(`Missing or invalid ${path}`);
  const key=row=>JSON.stringify(identity.map(name=>row[name]));
  const previous=new Map((old??[]).map(row=>[key(row),row]));
  const seen=new Set();
  for(const row of rows){
    objectAt(row,path);
    for(const name of identity){
      if(name==='production_id')nonnegative(row[name],`${path}.${name}`,{integer:true});
      else if(typeof row[name]!=='string'||!row[name])throw new Error(`Invalid identity ${path}.${name}`);
    }
    const id=key(row);if(seen.has(id))throw new Error(`Duplicate identity ${path}`);seen.add(id);
    counters(previous.has(id)?values(previous.get(id)):undefined,values(row),path);
  }
  for(const id of previous.keys())if(!seen.has(id))throw new Error(`Cumulative row disappeared ${path}`);
}
function evaluationAggregates(frame,previous){
  const mining=objectAt(frame.mining,'mining'),combat=objectAt(frame.combat,'combat');
  for(const name of ['mined','unit_deposits'])cumulativeRows(previous?.mining[name],mining[name],['team','unit_type','controller'],r=>numberMap(r.items,`mining.${name}.items`),`mining.${name}`);
  cumulativeRows(previous?.deliveries,frame.deliveries,['team','sink'],r=>numberMap(r.items,'deliveries.items'),'deliveries');
  cumulativeRows(previous?.stalled,frame.stalled,['production_id','team','type','kind'],r=>objectAt(r.lost_output,'stalled.lost_output'),'stalled');

  const oldStalled=new Map((previous?.stalled??[]).map(r=>[r.production_id,r]));
  const stalledIds=new Set();
  for(const r of frame.stalled){
    if(stalledIds.has(r.production_id))throw new Error('Duplicate stalled production_id');stalledIds.add(r.production_id);
    nonnegative(r.building_id,'stalled.building_id',{integer:true});
    const old=oldStalled.get(r.production_id);
    if(old&&['team','building_id','type','kind'].some(k=>r[k]!==old[k]))throw new Error('Stalled lifetime identity changed');
  }
  const target=['target_team','target_kind','target_type'],pair=['source_team','source_kind','source_type',...target];
  for(const [name,identity,names] of [['damage',pair,['damage','events']],['unattributed_damage',target,['damage']],['kills',pair,['count']],['deaths',target,['count']]]){
    cumulativeRows(previous?.combat[name],combat[name],identity,r=>fields(r,names,`combat.${name}`),`combat.${name}`);
    for(const row of combat[name])for(const name of ['count','events'])if(name in row)nonnegative(row[name],`combat.${name}`,{integer:true});
  }
  counters(previous?.combat.restored_health,numberMap(combat.restored_health,'combat.restored_health'),'combat.restored_health');
  for(const [name,current,old] of [['firepower',objectAt(combat.firepower,'combat.firepower'),previous?.combat.firepower],['power',objectAt(frame.power,'power'),previous?.power]]){
    for(const team of Object.keys(old??{}))if(!Object.hasOwn(current,team))throw new Error(`Cumulative team disappeared ${name}.${team}`);
    for(const [team,row] of Object.entries(current)){
      const before=old?.[team],path=`${name}.${team}`;objectAt(row,path);
      if(name==='firepower'){
        counters(before&&fields(before,['observed_simulation_seconds','peak_dps'],path),fields(row,['observed_simulation_seconds','peak_dps'],path),path);
        counters(before?.dps_seconds,fields(row.dps_seconds,['turrets','units','player_units'],path+'.dps_seconds'),path+'.dps_seconds');
        fields(row.current_dps,['turrets','units','player_units','total'],path+'.current_dps');
        nonnegative(row.mean_dps,path+'.mean_dps',{nullable:true});
      }else{
        counters(before&&fields(before,['observed_simulation_seconds','deficit_seconds'],path),fields(row,['observed_simulation_seconds','deficit_seconds'],path),path);
        counters(before?.energy,fields(row.energy,['needed','supplied','produced_including_batteries'],path+'.energy'),path+'.energy');
        counters(before?.consumer_seconds,fields(row.consumer_seconds,['total','full_power','brownout','blackout'],path+'.consumer_seconds'),path+'.consumer_seconds');
        for(const field of ['graphs','consumers'])nonnegative(row[field],path+'.'+field,{integer:true});
        fields(row.battery,['stored','capacity'],path+'.battery');
        for(const field of ['satisfaction','full_power_fraction'])nonnegative(row[field],path+'.'+field,{nullable:true});
      }
    }
  }
}

export async function evaluationMetrics(lines,teamNames){
  const lifetimes=new Map();let last=null,frames=0;
  for await(const frame of jsonLines(lines)){
    if(frame.coverage?.schema_version!==1||!Number.isFinite(frame.simulation_seconds)||frame.simulation_seconds<(last?.simulation_seconds??0)||!Array.isArray(frame.buildings))
      throw new Error('Invalid evaluation frame');
    evaluationAggregates(frame,last);
    const ids=new Set();
    for(const row of frame.buildings){
      if(!Number.isInteger(row.id)||ids.has(row.id)||typeof row.team!=='string'||!['extraction','transport'].includes(row.family))throw new Error('Invalid evaluation lifetime');
      ids.add(row.id);const previous=lifetimes.get(row.id);
      if(previous&&['team','type','kind','family','building_id','x','y','start_simulation_seconds'].some(k=>row[k]!==previous[k]))throw new Error('Lifetime identity changed');
      counters(previous?.seconds,numberMap(row.seconds,'seconds'),'seconds');
      counters(previous&&{observed:previous.observed_simulation_seconds},{observed:row.observed_simulation_seconds},'observed_simulation_seconds');
      if(row.family==='extraction')for(const key of ['output','potential_output','lost_output'])counters(previous?.[key],row[key],key);
      else {
        counters(previous?.transport?.accepted_items,numberMap(row.transport?.accepted_items,'transport.accepted_items'),'transport.accepted_items');
        for(const key of ['nominal_capacity_items','near_capacity_seconds']){
          nonnegative(row.transport[key],`transport.${key}`,{nullable:true});
          if(previous?.transport[key]!=null&&(row.transport[key]===null||row.transport[key]<previous.transport[key]-1e-6))throw new Error(`Invalid cumulative counter transport.${key}`);
        }
        counters(previous&&fields(previous.transport,['classified_seconds'],'transport'),fields(row.transport,['classified_seconds'],'transport'),'transport');
        nonnegative(row.transport.partial_window_seconds,'transport.partial_window_seconds');
      }
      lifetimes.set(row.id,row);
    }
    if(frame.final===true&&[...lifetimes.values()].some(row=>row.active&&!ids.has(row.id)))throw new Error('Final frame omitted active lifetime');
    last=frame;frames++;
  }
  if(!last)return {status:'unavailable',reason:'No evaluation frames',teams:null};
  const duration=last.simulation_seconds,perMinute=v=>ratio(v*60,duration);
  const rows=[...lifetimes.values()];
  const teams={};
  const names=new Set([...teamNames,...rows.map(r=>r.team),...Object.keys(last.combat?.firepower??{}),...Object.keys(last.power??{})]);
  for(const team of names){
    const mine=rows.filter(r=>r.team===team);
    const extraction={output:{items:{},liquids:{}},nominal_capacity:{items:{},liquids:{}},first_output_simulation_seconds:{items:{},liquids:{}},lost_output:{},lifetimes_by_kind:{}};
    const transport={};
    for(const r of mine){
      if(r.family==='extraction'){
        add(extraction.output.items,r.output.items);add(extraction.output.liquids,r.output.liquids);
        add(extraction.nominal_capacity.items,r.potential_output.items);add(extraction.nominal_capacity.liquids,r.potential_output.liquids);
        minimum(extraction.first_output_simulation_seconds.items,r.first_output_simulation_seconds.items);
        minimum(extraction.first_output_simulation_seconds.liquids,r.first_output_simulation_seconds.liquids);
        addNested(extraction.lost_output,r.lost_output);add2(extraction.lifetimes_by_kind,r.kind,1);
      }else{
        const t=transport[r.kind]??={lifetimes:0,accepted_items:{},nominal_capacity_items:null,near_capacity_seconds:null,classified_seconds:0,observed_seconds:0,
          capacity_coverage:{status:null,ratio_scope:'known_capacity_lifetimes_only',measured_lifetimes:0,unmeasured_lifetimes:0,measured_accepted_items:{},unmeasured_accepted_items:{},measured_classified_seconds:0,unmeasured_classified_seconds:0,measured_observed_seconds:0,unmeasured_observed_seconds:0}};
        t.lifetimes++;add(t.accepted_items,r.transport.accepted_items);t.observed_seconds+=r.observed_simulation_seconds;t.classified_seconds+=r.transport.classified_seconds;
        const coverage=t.capacity_coverage,scope=r.transport.nominal_capacity_items===null?'unmeasured':'measured';
        coverage[scope+'_lifetimes']++;add(coverage[scope+'_accepted_items'],r.transport.accepted_items);
        coverage[scope+'_classified_seconds']+=r.transport.classified_seconds;coverage[scope+'_observed_seconds']+=r.observed_simulation_seconds;
        if(scope==='measured'){t.nominal_capacity_items=(t.nominal_capacity_items??0)+r.transport.nominal_capacity_items;t.near_capacity_seconds=(t.near_capacity_seconds??0)+r.transport.near_capacity_seconds;}
      }
    }
    for(const t of Object.values(transport)){
      const coverage=t.capacity_coverage;
      coverage.status=coverage.measured_lifetimes===0?'unavailable':coverage.unmeasured_lifetimes>0?'partial':'complete';
      t.capacity_ratio=t.nominal_capacity_items===null?null:ratio(sum(coverage.measured_accepted_items),t.nominal_capacity_items);
      t.near_capacity_fraction=t.near_capacity_seconds===null?null:ratio(t.near_capacity_seconds,coverage.measured_classified_seconds);
    }
    extraction.output_per_simulation_minute={items:Object.fromEntries(Object.entries(extraction.output.items).map(([k,v])=>[k,perMinute(v)])),
      liquids:Object.fromEntries(Object.entries(extraction.output.liquids).map(([k,v])=>[k,perMinute(v)]))};
    extraction.output_utilization={items:Object.fromEntries(Object.entries(extraction.nominal_capacity.items).map(([k,v])=>[k,ratio(extraction.output.items[k]??0,v)])),
      liquids:Object.fromEntries(Object.entries(extraction.nominal_capacity.liquids).map(([k,v])=>[k,ratio(extraction.output.liquids[k]??0,v)]))};
    const byTeam=list=>(list??[]).filter(r=>r.team===team);
    const mining={mined_items:{},unit_deposits:{},by_unit:byTeam(last.mining?.mined).map(r=>({unit_type:r.unit_type,controller:r.controller,items:r.items}))};
    for(const r of byTeam(last.mining?.mined))add(mining.mined_items,r.items);
    for(const r of byTeam(last.mining?.unit_deposits))add(mining.unit_deposits,r.items);
    mining.mined_per_simulation_minute=Object.fromEntries(Object.entries(mining.mined_items).map(([k,v])=>[k,perMinute(v)]));
    const deliveries={};for(const r of byTeam(last.deliveries))deliveries[r.sink]=r.items;
    const stalled={};for(const r of byTeam(last.stalled))addNested(stalled,r.lost_output);
    const combat=last.combat??{};
    const dealt={},received={attributed:0,unattributed:0},kills={},losses={};
    for(const r of combat.damage??[]){
      if(r.source_team===team&&r.target_team!==team)add2(dealt,r.target_team+'/'+r.target_kind,r.damage);
      if(r.target_team===team)received.attributed+=r.damage;
    }
    for(const r of combat.unattributed_damage??[])if(r.target_team===team)received.unattributed+=r.damage;
    for(const r of combat.kills??[])if(r.source_team===team&&r.target_team!==team)add2(kills,r.target_kind,r.count);
    for(const r of combat.deaths??[])if(r.target_team===team)add2(losses,r.target_kind,r.count);
    const power=last.power?.[team]??null;
    teams[team]={extraction,mining,transport,deliveries,stalled_output:stalled,
      combat:{damage_dealt_by_target:dealt,damage_received:received,kills_by_target_kind:kills,losses_by_kind:losses,
        restored_health:combat.restored_health?.[team]??0,firepower:combat.firepower?.[team]??null},
      power:power&&{...power,brownout_fraction:ratio(power.consumer_seconds.brownout,power.consumer_seconds.total),
        blackout_fraction:ratio(power.consumer_seconds.blackout,power.consumer_seconds.total)}};
  }
  return {status:last.final===true?'complete':'partial',frames,simulation_seconds:duration,coverage:last.coverage,teams,
    limitations:['Evaluation-only: never shown to agents and never part of the native reward.',
      'Extraction capacity is the native nominal rate without liquid boost; boosted drills can exceed one.',
      'Transport counts items accepted by each block (hops); deliveries count items a core, crafter, unit factory or item turret received from transport, once.',
      'Transport capacity ratios use only lifetimes with a known nominal capacity. capacity_coverage preserves measured and unmeasured items/time separately; partial capacity coverage is not complete saturation evidence.',
      'Damage is health lost: native hits are attributed to the bullet owner, the rest (fire, eventless splash) is unattributed. Overkill is excluded.',
      'Damage attribution may be approximate within an update phase: silent loss or healing can merge into a later hit. Inspect coverage.damage_attribution; this is not exhaustive causal source attribution.',
      'Firepower is the native DPS estimate of enabled turrets and living units, not damage dealt.',
      'Stalled output assigns each update one cause in order: disabled, output blocked, power limited, input limited. Unit-cap stalls are inside output blocked.']};
}

export async function stockpileMetrics(lines){
  const teams={};let samples=0,last=null;
  for await(const frame of jsonLines(lines)){
    if(!Number.isFinite(frame.simulation_seconds)||!isObject(frame.teams)||frame.simulation_seconds<(last?.simulation_seconds??0))throw new Error('Invalid stockpile sample');
    samples++;last=frame;
    for(const [team,data] of Object.entries(frame.teams)){
      objectAt(data,`stockpiles.${team}`);objectAt(data.items,`stockpiles.${team}.items`);
      nonnegative(data.cores,`stockpiles.${team}.cores`,{integer:true});nonnegative(data.storage_capacity,`stockpiles.${team}.storage_capacity`);
      for(const [item,n] of Object.entries(data.items))nonnegative(n,`stockpiles.${team}.items.${item}`,{integer:true});
      const t=teams[team]??={first:null,final:null,final_status:null,min:{},max:{},storage_capacity:null,at_capacity_samples:{},samples:0,series:[]};

      const items=Object.fromEntries([...new Set([...Object.keys(t.min),...Object.keys(data.items)])].map(item=>[item,data.items[item]??0]));
      for(const item of Object.keys(data.items))if(!(item in t.min)&&t.samples>0)t.min[item]=0;
      t.samples++;t.first??={...items};t.final=items;t.final_status='observed';t.storage_capacity=data.storage_capacity;
      for(const [item,n] of Object.entries(items)){
        t.min[item]=Math.min(t.min[item]??Infinity,n);t.max[item]=Math.max(t.max[item]??-Infinity,n);
        if(data.storage_capacity>0&&n>=data.storage_capacity)add2(t.at_capacity_samples,item,1);
      }
      const previous=t.series.at(-1);
      if(!previous||frame.simulation_seconds-previous.simulation_seconds>=30||frame.final)t.series.push({simulation_seconds:frame.simulation_seconds,items});
    }
    for(const [team,t] of Object.entries(teams))if(!Object.hasOwn(frame.teams,team)){
      t.final=null;t.final_status='team_absent_from_sample';t.storage_capacity=null;
      const previous=t.series.at(-1);
      if(frame.final||previous?.items!==null)t.series.push({simulation_seconds:frame.simulation_seconds,items:null});
    }
  }
  if(!last)return {status:'unavailable',reason:'No stockpile samples',teams:null};
  return {status:last.final===true?'complete':'partial',samples,simulation_seconds:last.simulation_seconds,teams,
    limitations:['Samples are about one per wall second; series keeps one sample per 30 simulation seconds plus the final one.',
      'A present team uses native sparse item maps: absent item entries are zero. An absent team is unavailable, not a zero stockpile or evidence of core destruction; final and storage_capacity are null.']};
}

export async function progressionMetrics(eventLines,catalog,teamNames){
  const teams={};const team=name=>teams[name]??={first_blocks:{},first_by_category:{},first_units:{},unit_tier_timeline:[],cores:[]};
  for(const name of teamNames)team(name);
  for await(const record of jsonLines(eventLines)){
    const entry=record.data?.entry;if(!entry||!Number.isFinite(entry.t))continue;
    if(entry.kind==='block_build_end'&&entry.breaking===false&&entry.tile?.type&&entry.team){
      const t=team(entry.team),type=entry.tile.type;
      if(!(type in t.first_blocks)){
        const category=catalog?.blocks?.[type]?.category??null;
        t.first_blocks[type]={t:entry.t,category};
        if(category&&!(category in t.first_by_category))t.first_by_category[category]={t:entry.t,block:type};
        if(type.startsWith('core-'))t.cores.push({t:entry.t,block:type});
      }
    }else if(entry.kind==='unit_create'&&entry.unit?.type&&entry.unit?.team){
      const t=team(entry.unit.team),type=entry.unit.type;
      if(!(type in t.first_units)){
        const tier=catalog?.units?.[type]?.tier??null;
        t.first_units[type]={t:entry.t,tier,spawner:entry.spawner?.type??null};
        const best=t.unit_tier_timeline.at(-1)?.tier??0;
        if(tier!==null&&tier>best)t.unit_tier_timeline.push({t:entry.t,tier,unit:type});
      }
    }
  }
  return {status:catalog?'complete':'partial',teams,
    limitations:['Times are the match clock of native events (t), not simulation seconds.',
      'Tier is 1 for unit-factory plans plus one per native reconstructor upgrade; null when no factory chain produces the unit.',
      catalog?'Block categories come from engine/content.json.':'engine/content.json is missing: categories and tiers are null.']};
}

const lineReader=file=>createInterface({input:createReadStream(file),crlfDelay:Infinity});
async function optional(file,reduce,missing){
  if(!existsSync(file))return {status:'unavailable',reason:missing,teams:null};
  try{return await reduce(lineReader(file));}catch(error){return {status:'invalid',reason:error.message,teams:null};}
}

export async function metrics(dir){
  const game=readGame(dir);
  const {setup,result}=game;
  const survivalScore=gradeEndlessSurvival(game);
  const terminal=result?.terminal??null;
  const teams=[...new Set(Object.values(terminal?.seat_teams??game.start?.seat_teams??{}))];
  const file=join(dir,'engine/production.jsonl');
  let production;
  try{production=existsSync(file)?await productionMetrics(createInterface({input:createReadStream(file),crlfDelay:Infinity}),teams):{status:'unavailable',reason:'Missing engine/production.jsonl',teams:null};}
  catch(error){production={status:'invalid',reason:error.message,teams:null};}
  const catalogFile=join(dir,'engine/content.json');
  const catalog=existsSync(catalogFile)?JSON.parse(readFileSync(catalogFile,'utf8')):null;
  const evaluation=await optional(join(dir,'engine/evaluation.jsonl'),lines=>evaluationMetrics(lines,teams),'Missing engine/evaluation.jsonl');
  const stockpiles=await optional(join(dir,'engine/stockpiles.jsonl'),stockpileMetrics,'Missing engine/stockpiles.jsonl');
  const progression=await optional(join(dir,'engine/events.jsonl'),lines=>progressionMetrics(lines,catalog,teams),'Missing engine/events.jsonl');
  return {schema:'mindustry-deterministic/1',mode:setup.settings.game_mode,
    native_outcome:{completed:survivalScore.status==='valid',terminal,survival_score:survivalScore},
    production,evaluation,stockpiles,progression};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const dir=process.argv[2]??'/logs/sim';
  writeFileSync(process.argv[3]??join(dir,'metrics.json'),JSON.stringify(await metrics(dir),null,2)+'\n');
}
