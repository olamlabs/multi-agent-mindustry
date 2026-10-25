import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {validateEndlessProfile} from './settings.mjs';
import {NATIVE_SURVIVAL_SCHEMA, record, same} from './survival-contract.mjs';

export const MAX_SURVIVAL_EVIDENCE_BYTES = 1024 * 1024;
export const MAX_SURVIVAL_LINE_BYTES = MAX_SURVIVAL_EVIDENCE_BYTES;

const NATIVE_UPDATE_TICKS = 4;
const WAVE_BOUNDARY_TOLERANCE = NATIVE_UPDATE_TICKS + 1e-9;
export const SURVIVAL_EVIDENCE_FILES = Object.freeze({
  setup:'setup.json',result:'result.json',readiness:'agent-readiness.json',native:'engine/survival.jsonl',
});
const problem = (code,message) => Object.assign(new Error(message),{code});
function openRegular(file,limit=Infinity) {
  const before=fs.lstatSync(file);
  if (!before.isFile()) throw problem('not_regular_file','Evidence must be a regular file.');
  if (before.size>limit) throw problem('oversized','Evidence exceeds its byte limit.');
  const fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0)|(fs.constants.O_NONBLOCK??0));
  try {
    const opened=fs.fstatSync(fd);
    if (!opened.isFile() || opened.ino!==before.ino || opened.dev!==before.dev) throw problem('not_regular_file','Evidence file changed while opening.');
    if (opened.size>limit) throw problem('oversized','Evidence exceeds its byte limit.');
    return {fd,size:opened.size};
  } catch(error) {fs.closeSync(fd);throw error;}
}
function parse(bytes) {
  let text,value;
  try {text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);value=JSON.parse(text);}
  catch {throw problem('invalid_json','Evidence is not valid UTF-8 JSON.');}

  const objects=[];
  for(let i=0;i<text.length;i++) {
    if(text[i]==='{' || text[i]==='[') objects.push(text[i]==='{'?new Set():null);
    else if(text[i]==='}' || text[i]===']') objects.pop();
    else if(text[i]==='"') {
      const begin=i;
      while(++i<text.length) {if(text[i]==='\\')i++;else if(text[i]==='"')break;}
      let next=i+1;while(/\s/.test(text[next]??'') && next<text.length)next++;
      if(text[next]===':' && objects.at(-1)) {
        const key=JSON.parse(text.slice(begin,i+1)),keys=objects.at(-1);
        if(keys.has(key))throw problem('duplicate_json_key','Evidence contains a duplicate JSON property.');
        keys.add(key);
      }
    }
  }
  return value;
}
function smallFile(file) {
  const {fd}=openRegular(file,MAX_SURVIVAL_EVIDENCE_BYTES);
  try {
    const buffer=Buffer.alloc(MAX_SURVIVAL_EVIDENCE_BYTES+1);
    let length=0;
    while(length<buffer.length) {
      const count=fs.readSync(fd,buffer,length,buffer.length-length,null);
      if(!count) break;
      length+=count;
    }
    if(length>MAX_SURVIVAL_EVIDENCE_BYTES) throw problem('oversized','Evidence grew beyond its byte limit.');
    const bytes=buffer.subarray(0,length);
    return {value:parse(bytes),bytes:length,sha256:createHash('sha256').update(bytes).digest('hex')};
  } finally {fs.closeSync(fd);}
}

function checkProgressiveWave(data,profile,cumulative) {
  const bad=()=>{throw problem('native_spawn_observation','Native spawn observations are missing or contradictory.');};
  const nonnegative=value=>Number.isFinite(value)&&value>=0;
  if(!record(data.spawned)||!Object.keys(data.spawned).length||!record(data.spawned_units)
      ||!same(Object.keys(data.spawned).sort(),Object.keys(data.spawned_units).sort())
      ||data.spawn_observation!=='after_native_group_shields_before_combat'
      ||!same(data.enemy_team_rule,{
        unit_health_multiplier:Math.fround(profile.enemy_unit_health_multiplier),
        unit_damage_multiplier:Math.fround(profile.enemy_unit_damage_multiplier),
      })) bad();
  for(const [type,count] of Object.entries(data.spawned)) {
    const seen=data.spawned_units[type];
    if(!Number.isSafeInteger(count)||count<=0||!record(seen)||seen.count!==count
        ||!['shield_min','shield_max','shield_total','raw_health_total','raw_max_health_total'].every(key=>nonnegative(seen[key]))) bad();
    const tolerance=Math.max(1e-9,seen.shield_total*Number.EPSILON*8);
    if(seen.shield_min>seen.shield_max||seen.shield_total+tolerance<seen.shield_min*count
        ||seen.shield_total-tolerance>seen.shield_max*count||seen.raw_health_total<=0
        ||seen.raw_max_health_total<=0||seen.raw_health_total>seen.raw_max_health_total) bad();
    const total=(cumulative.get(type)??0)+count;
    if(!Number.isSafeInteger(total))bad();
    cumulative.set(type,total);
  }
  if(!record(data.cumulative_spawned)||!same(data.cumulative_spawned,Object.fromEntries(cumulative)))bad();
}

const BUDGET_FIRST=600, BUDGET_GROWTH=1.22;
function checkBudgetWave(data,wave) {
  const bad=()=>{throw problem('native_budget_observation','Planned and spawned units or strength disagree.');};
  let budget=BUDGET_FIRST;for(let i=1;i<wave;i++)budget*=BUDGET_GROWTH;
  if(data.budget!==budget||!record(data.planned_units)||!same(data.planned_units,data.spawned)
     ||!Number.isFinite(data.planned_shield)||data.planned_shield<0
     ||!Number.isFinite(data.realized_strength)||Math.abs(data.realized_strength-budget)>1e-4*budget) bad();
}

export function readNativeSurvival(directory) {
  const relative=SURVIVAL_EVIDENCE_FILES.native;
  const out={nativeSetup:null,start:null,event:null,terminal:null,evidence_read_errors:[],evidence_files:[]};
  let fd,bytesRead=0,size=0,sequence=0,waves=0,lastTick=0,lastUpdates=0,phase='empty';
  const hash=createHash('sha256');
  const cumulative=new Map();
  const accept = bytes => {
    const row=parse(bytes);
    if(!record(row) || !same(Object.keys(row).sort(),['data','event','schema','sequence'])
       || row.schema!==NATIVE_SURVIVAL_SCHEMA || !Number.isSafeInteger(row.sequence)
       || row.sequence!==sequence+1 || !record(row.data) || Object.hasOwn(row.data,'event')) {
      throw problem('native_envelope','Native schema, contiguous sequence or envelope is invalid.');
    }
    const d=row.data;
    if(row.event!=='survival_setup') {
      if(d.ticks_per_second!==60 || !Number.isFinite(d.simulation_tick) || d.simulation_tick<lastTick || d.simulation_tick>Number.MAX_SAFE_INTEGER
        || !Number.isSafeInteger(d.simulation_updates) || d.simulation_updates<lastUpdates) throw problem('native_clock_order','Native clock regressed or is invalid.');
      const tolerance=Math.max(1e-9,Math.abs(d.simulation_tick)*Number.EPSILON*8);
      if(d.simulation_tick-lastTick>(d.simulation_updates-lastUpdates)*NATIVE_UPDATE_TICKS+tolerance) throw problem('native_clock_capacity','Elapsed ticks exceed the capped updates between native records.');
      lastTick=d.simulation_tick;lastUpdates=d.simulation_updates;
    }
    switch(row.event) {
      case 'survival_setup':
        if(phase!=='empty') throw problem('native_order','Setup must be the first and only setup record.');
        try {validateEndlessProfile(d.profile);} catch {throw problem('native_profile','Native wave settings are missing or invalid.');}
        out.nativeSetup=d;phase='setup';break;
      case 'survival_start':
        if(phase!=='setup' || d.simulation_tick!==0 || d.simulation_updates!==0) throw problem('native_order','Exactly one zero-clock start must follow setup.');
        out.start={event:row.event,...d};phase='started';break;
      case 'survival_wave':
        if(phase!=='started' || d.wave!==waves+1) throw problem('native_order','Wave records must be contiguous after start and before death.');
        if(!Number.isFinite(d.scheduled_simulation_tick) || d.scheduled_simulation_tick!==out.nativeSetup.first_wave_simulation_tick+waves*out.nativeSetup.wave_spacing_ticks
          || Math.abs(d.simulation_tick-d.scheduled_simulation_tick)>WAVE_BOUNDARY_TOLERANCE) throw problem('native_wave_schedule','Wave timing disagrees with the native schedule.');
        checkProgressiveWave(d,out.nativeSetup.profile,cumulative);
        checkBudgetWave(d,waves+1);
        waves++;break;
      case 'last_friendly_core_destroyed':
        if(phase!=='started' || d.waves_spawned!==waves) throw problem('native_order','Death must occur once after start with the observed wave count.');
        out.event={event:row.event,...d};phase='death';break;
      case 'survival_terminal':
        if(!['started','death'].includes(phase) || d.waves_spawned!==waves
          || (d.reason==='core_destroyed')!==(phase==='death')) throw problem('native_order','Terminal must follow the matching native death or a censored running match.');
        if(d.wave!==waves+1) throw problem('native_wave_count','Terminal next wave must follow every recorded wave.');
        if(d.simulation_tick-(out.nativeSetup.first_wave_simulation_tick+waves*out.nativeSetup.wave_spacing_ticks)>WAVE_BOUNDARY_TOLERANCE) throw problem('native_wave_missing','Terminal clock passed a scheduled wave without its native wave record.');
        out.terminal=d;phase='terminal';break;
      default:throw problem('native_event','Unknown native survival event.');
    }
    sequence=row.sequence;
  };
  try {
    ({fd,size}=openRegular(path.resolve(directory,relative)));
    const chunk=Buffer.alloc(64*1024);
    let pending=Buffer.alloc(0);
    while(bytesRead<size) {
      const count=fs.readSync(fd,chunk,0,Math.min(chunk.length,size-bytesRead),null);
      if(!count) throw problem('native_truncated','Native log shrank during the snapshot read.');
      const bytes=chunk.subarray(0,count);hash.update(bytes);bytesRead+=count;
      let offset=0;
      for(let end=bytes.indexOf(10);end!==-1;end=bytes.indexOf(10,offset)) {
        if(pending.length+end-offset>MAX_SURVIVAL_LINE_BYTES) throw problem('oversized_line','Native evidence line exceeds its byte limit.');
        accept(pending.length?Buffer.concat([pending,bytes.subarray(offset,end)]):bytes.subarray(offset,end));
        pending=Buffer.alloc(0);offset=end+1;
      }
      if(offset<bytes.length) {
        if(pending.length+bytes.length-offset>MAX_SURVIVAL_LINE_BYTES) throw problem('oversized_line','Native evidence line exceeds its byte limit.');
        pending=Buffer.concat([pending,bytes.subarray(offset)]);
      }
    }
    if(pending.length) throw problem('native_partial_line','Native snapshot ends in an unfinished record.');
    if(!sequence) throw problem('native_empty','Native log has no setup record.');
    out.evidence_files.push({field:'native',path:relative,bytes:bytesRead,sha256:hash.digest('hex'),records:sequence,waves,complete:true});
  } catch(error) {
    out.evidence_read_errors.push({field:'native',path:relative,code:error.code??'read_error'});
    out.evidence_files.push({field:'native',path:relative,error:error.code??'read_error',bytes_read:bytesRead,snapshot_bytes:size,complete:false});
  } finally {if(fd!==undefined)fs.closeSync(fd);}
  return out;
}

export function readAppSurvivalEvidence(directory,fields=['setup','result','readiness'],overrides={}) {
  const output={evidence_read_errors:[],evidence_files:[]};
  for(const key of fields) {
    if(!['setup','result','readiness'].includes(key)) throw new Error('Unknown app evidence field.');
    const relative=SURVIVAL_EVIDENCE_FILES[key];
    if((key==='setup'||key==='result')&&Object.hasOwn(overrides,key)) {
      output[key]=overrides[key];output.evidence_files.push({field:key,source:'provided'});continue;
    }
    try {
      const {value,...receipt}=smallFile(path.resolve(directory,relative));
      output[key]=value;output.evidence_files.push({field:key,path:relative,...receipt});
    } catch(error) {
      output[key]=null;
      output.evidence_read_errors.push({field:key,path:relative,code:error.code??'read_error'});
      output.evidence_files.push({field:key,path:relative,error:error.code??'read_error'});
    }
  }
  return output;
}

export function readEndlessEvidence(directory,overrides={}) {
  const native=readNativeSurvival(directory),app=readAppSurvivalEvidence(directory,undefined,overrides);
  return {...native,...app,evidence_read_errors:[...native.evidence_read_errors,...app.evidence_read_errors],evidence_files:[...native.evidence_files,...app.evidence_files]};
}
