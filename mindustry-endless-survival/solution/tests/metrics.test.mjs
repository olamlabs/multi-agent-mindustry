import test from 'node:test';
import assert from 'node:assert/strict';
import {productionMetrics,evaluationMetrics,stockpileMetrics,progressionMetrics} from '../../environment/sim/metrics.mjs';

function row(id,count,extra={}){return {id,building_id:id,type:'graphite-press',kind:'crafter',team:'sharded',x:id,y:1,
  start_simulation_seconds:0,supported:true,active:true,observed_simulation_seconds:20,
  output:{items:{graphite:count},liquids:{},units:{},completed_cycles:count},
  potential_output:{items:{graphite:10},liquids:{},units:{},cycles:10},
  first_output_simulation_seconds:{items:{graphite:3},liquids:{},units:{}},seconds:{disabled:2},belt:null,...extra};}
const frame=(t,buildings,final=false)=>({t,simulation_seconds:t,final,coverage:{schema_version:1,supported_blocks:['graphite-press']},buildings});

test('retired and rebuilt lifetimes counted once; whole-match rates and weighted capacity',async()=>{
  const result=await productionMetrics([frame(10,[row(1,2)]),frame(20,[row(1,4,{active:false}),row(2,2)]),frame(30,[row(2,6)],true)],['sharded','crux']);
  assert.equal(result.status,'complete');
  assert.equal(result.teams.sharded.output.items.graphite,10);
  assert.equal(result.teams.sharded.output_per_simulation_minute.items.graphite,20);
  assert.equal(result.teams.sharded.output_utilization.items.graphite,0.5);
  assert.equal(result.teams.sharded.first_output_simulation_seconds.items.graphite,3);
  assert.equal(result.teams.crux.lifetimes,0);
  assert.equal(result.teams.crux.belts.near_capacity_fraction,null);
});
test('unit upgrades are separate from first-tier creation, belt hops and partial windows explicit',async()=>{
  const belt={transferred_items:{copper:12},nominal_capacity_items:10,near_capacity_seconds:10,classified_seconds:10,partial_window_seconds:3};
  const result=await productionMetrics([frame(30,[row(1,0,{type:'ground-factory',kind:'unit_factory',output:{items:{},liquids:{},units:{dagger:3},completed_cycles:3}}),
    row(2,0,{type:'additive-reconstructor',kind:'reconstructor',output:{items:{},liquids:{},units:{mace:1},completed_cycles:1},first_output_simulation_seconds:{units:{mace:23}}}),row(3,0,{kind:'belt',belt})],true)],['sharded']);
  const team=result.teams.sharded;
  assert.deepEqual(team.output.new_units,{dagger:3});assert.deepEqual(team.output.upgraded_units,{mace:1});
  assert.equal(team.first_output_simulation_seconds.upgraded_units.mace,23);
  assert.equal(team.belts.capacity_ratio,1.2);assert.equal(team.belts.near_capacity_fraction,1);
  assert.equal(team.belts.partial_window_seconds,3);
});
test('missing/truncated telemetry is unavailable or partial, never a completed zero',async()=>{
  assert.equal((await productionMetrics([],['sharded'])).status,'unavailable');
  assert.equal((await productionMetrics([frame(10,[])],['sharded'])).status,'partial');
  await assert.rejects(productionMetrics(['{'],[]));
});
test('reset counters, reused identities and omitted active lifetimes invalidate telemetry',async()=>{
  await assert.rejects(productionMetrics([frame(10,[row(1,3)]),frame(20,[row(1,2)],true)],[]),/counter/);
  await assert.rejects(productionMetrics([frame(10,[row(1,3)]),frame(20,[row(1,3,{team:'crux'})],true)],[]),/identity/);
  await assert.rejects(productionMetrics([frame(10,[row(1,3)]),frame(20,[],true)],[]),/omitted/);
});

const evalRow=(id,extra={})=>({id,building_id:id,type:'mechanical-drill',kind:'drill',family:'extraction',team:'sharded',x:id,y:1,active:true,
  start_simulation_seconds:0,observed_simulation_seconds:30,seconds:{disabled:0,native_processing:30,power_limited:0,input_or_power_limited:0,output_blocked:5},
  output:{items:{copper:6},liquids:{}},first_output_simulation_seconds:{items:{copper:4},liquids:{}},potential_output:{items:{copper:12},liquids:{}},
  lost_output:{output_blocked:{items:{copper:2}}},...extra});
const duct=(id,extra={})=>({id,building_id:id,type:'duct',kind:'duct',family:'transport',team:'sharded',x:id,y:2,active:true,start_simulation_seconds:0,
  observed_simulation_seconds:30,seconds:{disabled:0,native_processing:0,power_limited:0,input_or_power_limited:0,output_blocked:0},
  transport:{accepted_items:{lead:15},nominal_capacity_items:30,capacity_ratio:0.5,near_capacity_seconds:10,classified_seconds:20,partial_window_seconds:0},...extra});
const evalFrame=(t,buildings,final=false,extra={})=>({t,simulation_seconds:t,final,coverage:{schema_version:1},buildings,
  mining:{mined:[{team:'sharded',unit_type:'alpha',controller:'seat-1',items:{copper:9}}],unit_deposits:[{team:'sharded',unit_type:'alpha',controller:'seat-1',items:{copper:7}}]},
  deliveries:[{team:'sharded',sink:'core',items:{copper:11}}],
  stalled:[{production_id:3,building_id:30,type:'graphite-press',kind:'crafter',team:'sharded',lost_output:{input_limited:{items:{graphite:4}}}}],
  combat:{damage:[{source_team:'sharded',source_kind:'turret',source_type:'duo',target_team:'crux',target_kind:'unit',target_type:'flare',damage:50,events:5},
                  {source_team:'crux',source_kind:'unit',source_type:'flare',target_team:'sharded',target_kind:'building',target_type:'conveyor',damage:8,events:2}],
    unattributed_damage:[{target_team:'sharded',target_kind:'building',target_type:'conveyor',damage:3}],
    kills:[{source_team:'sharded',source_kind:'turret',source_type:'duo',target_team:'crux',target_kind:'unit',target_type:'flare',count:1}],
    deaths:[{target_team:'crux',target_kind:'unit',target_type:'flare',count:1}],restored_health:{sharded:2},
    firepower:{sharded:{peak_dps:27,mean_dps:20,observed_simulation_seconds:10,current_dps:{turrets:10,units:10,player_units:0,total:20},dps_seconds:{turrets:100,units:100,player_units:0}}}},
  power:{sharded:{observed_simulation_seconds:10,graphs:1,consumers:1,energy:{needed:10,supplied:8,produced_including_batteries:8},consumer_seconds:{total:10,full_power:6,brownout:3,blackout:1},satisfaction:0.8,full_power_fraction:0.6,deficit_seconds:4,battery:{stored:0,capacity:0}}},...extra});

test('evaluation: extraction, mining, transport, deliveries, stalled output, combat and power per team',async()=>{
  const result=await evaluationMetrics([evalFrame(10,[evalRow(1,{output:{items:{copper:2},liquids:{}}}),duct(2)]),evalFrame(30,[evalRow(1),duct(2)],true)],['sharded','crux']);
  assert.equal(result.status,'complete');
  const team=result.teams.sharded;
  assert.equal(team.extraction.output.items.copper,6);
  assert.equal(team.extraction.output_per_simulation_minute.items.copper,12);
  assert.equal(team.extraction.output_utilization.items.copper,0.5);
  assert.equal(team.extraction.lost_output.output_blocked.items.copper,2);
  assert.deepEqual(team.mining.mined_items,{copper:9});assert.equal(team.mining.mined_per_simulation_minute.copper,18);
  assert.deepEqual(team.mining.unit_deposits,{copper:7});
  assert.equal(team.transport.duct.capacity_ratio,0.5);assert.equal(team.transport.duct.near_capacity_fraction,0.5);
  assert.deepEqual(team.deliveries,{core:{copper:11}});
  assert.equal(team.stalled_output.input_limited.items.graphite,4);
  assert.deepEqual(team.combat.damage_dealt_by_target,{'crux/unit':50});
  assert.deepEqual(team.combat.damage_received,{attributed:8,unattributed:3});
  assert.deepEqual(team.combat.kills_by_target_kind,{unit:1});
  assert.deepEqual(result.teams.crux.combat.losses_by_kind,{unit:1});
  assert.equal(team.power.brownout_fraction,0.3);assert.equal(team.power.blackout_fraction,0.1);
});
test('evaluation: missing, partial and inconsistent telemetry is never a completed zero',async()=>{
  assert.equal((await evaluationMetrics([],['sharded'])).status,'unavailable');
  assert.equal((await evaluationMetrics([evalFrame(10,[])],['sharded'])).status,'partial');
  await assert.rejects(evaluationMetrics([evalFrame(10,[evalRow(1)]),evalFrame(20,[evalRow(1,{output:{items:{copper:1},liquids:{}}})],true)],[]),/counter/);
  await assert.rejects(evaluationMetrics([evalFrame(10,[evalRow(1)]),evalFrame(20,[],true)],[]),/omitted/);
  await assert.rejects(evaluationMetrics([evalFrame(10,[evalRow(1,{family:'belt'})])],[]),/lifetime/);
});
test('mixed transport capacity uses matching measured items/time and preserves unknown coverage',async()=>{
  const measured=duct(1,{type:'junction',kind:'junction',transport:{accepted_items:{lead:10},nominal_capacity_items:10,near_capacity_seconds:10,classified_seconds:10,partial_window_seconds:0}});
  const unknown=duct(2,{type:'duct-junction',kind:'junction',transport:{accepted_items:{lead:100},nominal_capacity_items:null,near_capacity_seconds:null,classified_seconds:20,partial_window_seconds:0}});
  const aggregate=async rows=>(await evaluationMetrics([evalFrame(30,rows,true)],['sharded'])).teams.sharded.transport.junction;
  const single=await aggregate([measured]),mixed=await aggregate([measured,unknown]);
  assert.equal(single.capacity_coverage.status,'complete');
  assert.equal(mixed.capacity_ratio,single.capacity_ratio);assert.equal(mixed.capacity_ratio,1);
  assert.equal(mixed.near_capacity_fraction,single.near_capacity_fraction);assert.equal(mixed.near_capacity_fraction,1);
  assert.equal(mixed.capacity_coverage.status,'partial');assert.deepEqual(mixed.accepted_items,{lead:110});
  assert.deepEqual(mixed.capacity_coverage.measured_accepted_items,{lead:10});assert.deepEqual(mixed.capacity_coverage.unmeasured_accepted_items,{lead:100});
  assert.equal(mixed.capacity_coverage.measured_classified_seconds,10);assert.equal(mixed.capacity_coverage.unmeasured_classified_seconds,20);
  assert.equal(mixed.capacity_coverage.measured_observed_seconds,30);assert.equal(mixed.capacity_coverage.unmeasured_observed_seconds,30);
  const unsupported=await aggregate([unknown]);assert.equal(unsupported.capacity_coverage.status,'unavailable');
  assert.equal(unsupported.capacity_ratio,null);assert.equal(unsupported.near_capacity_fraction,null);assert.deepEqual(unsupported.accepted_items,{lead:100});
});
test('evaluation rejects reset, negative, missing and duplicate cumulative match aggregates',async()=>{
  const initial=evalFrame(10,[]);
  const cases=[
    ['mining reset',f=>f.mining.mined[0].items.copper=1],
    ['negative mining',f=>f.mining.mined[0].items.copper=-1],
    ['nonnumeric mining',f=>f.mining.mined[0].items.copper={value:9}],
    ['deposit reset',f=>f.mining.unit_deposits[0].items.copper=1],
    ['delivery reset',f=>f.deliveries[0].items.copper=1],
    ['damage reset',f=>f.combat.damage[0].damage=1],
    ['damage event reset',f=>f.combat.damage[0].events=1],
    ['damage row removed',f=>f.combat.damage=[]],
    ['death removed',f=>f.combat.deaths=[]],
    ['duplicate tally',f=>f.mining.mined.push(structuredClone(f.mining.mined[0]))],
    ['missing mining',f=>delete f.mining],
    ['missing combat',f=>delete f.combat],
    ['missing power',f=>delete f.power],
    ['missing deliveries',f=>delete f.deliveries],
    ['lost output reset',f=>f.stalled[0].lost_output.input_limited.items.graphite=1],
    ['lifetime identity changed',f=>f.stalled[0].building_id=99],
    ['firepower integral reset',f=>f.combat.firepower.sharded.dps_seconds.units=1],
    ['firepower team disappears',f=>f.combat.firepower={}],
    ['power counter reset',f=>f.power.sharded.energy.supplied=1],
    ['power negative snapshot',f=>f.power.sharded.battery.stored=-1],
    ['nonfinite damage',f=>f.combat.damage[0].damage=NaN],
  ];
  for(const [name,mutate] of cases){
    const final=evalFrame(20,[],true);mutate(final);
    await assert.rejects(evaluationMetrics([initial,final],['sharded']),undefined,name);
  }
  const zero=evalFrame(0,[],true,{mining:{mined:[],unit_deposits:[]},deliveries:[],stalled:[],combat:{damage:[],unattributed_damage:[],kills:[],deaths:[],restored_health:{},firepower:{}},power:{}});
  assert.equal((await evaluationMetrics([zero],['sharded'])).status,'complete','explicit empty counters remain valid zero evidence');
});
test('evaluation validates lifetime observation, lost output and transport capacity counters',async()=>{
  const initial=evalFrame(10,[evalRow(1),duct(2)]);
  for(const mutate of [
    f=>f.buildings[0].observed_simulation_seconds=1,
    f=>f.buildings[0].lost_output.output_blocked.items.copper=1,
    f=>f.buildings[1].transport.nominal_capacity_items=1,
    f=>f.buildings[1].transport.nominal_capacity_items=null,
    f=>f.buildings[1].transport.near_capacity_seconds=1,
    f=>f.buildings[1].transport.classified_seconds=1,
  ]){
    const final=evalFrame(20,[evalRow(1),duct(2)],true);mutate(final);
    await assert.rejects(evaluationMetrics([initial,final],[]),/counter/);
  }
});
test('stockpiles: first, final, range, time at capacity and a coarse series',async()=>{
  const sample=(t,copper,final=false)=>({t,simulation_seconds:t,final,teams:{sharded:{cores:1,storage_capacity:100,items:{copper}}}});
  const result=await stockpileMetrics([sample(0,10),sample(1,100),sample(31,40),sample(32,60,true)]);
  const team=result.teams.sharded;
  assert.equal(result.status,'complete');
  assert.deepEqual([team.first.copper,team.final.copper,team.min.copper,team.max.copper],[10,60,10,100]);
  assert.equal(team.at_capacity_samples.copper,1);
  assert.deepEqual(team.series.map(s=>s.simulation_seconds),[0,31,32]);
  assert.equal((await stockpileMetrics([])).status,'unavailable');
});
test('stockpiles distinguish sparse zero items from a team missing after core destruction',async()=>{
  const frame=(t,teams,final=false)=>({simulation_seconds:t,teams,final});
  const present=items=>({sharded:{cores:1,storage_capacity:100,items}});
  const missing=await stockpileMetrics([frame(0,present({copper:50})),frame(10,{},true)]);
  assert.equal(missing.status,'complete','the recorded stream is complete, but this team has no final observation');
  assert.equal(missing.teams.sharded.final,null);assert.equal(missing.teams.sharded.storage_capacity,null);
  assert.equal(missing.teams.sharded.final_status,'team_absent_from_sample');
  assert.deepEqual(missing.teams.sharded.series.at(-1),{simulation_seconds:10,items:null});
  const depleted=await stockpileMetrics([frame(0,present({copper:50})),frame(10,present({lead:3}),true)]);
  assert.deepEqual(depleted.teams.sharded.final,{copper:0,lead:3});
  assert.deepEqual(depleted.teams.sharded.min,{copper:0,lead:0});
  assert.equal(depleted.teams.sharded.final_status,'observed');
  await assert.rejects(stockpileMetrics([frame(0,present({copper:-1}),true)]),/counter/);
  await assert.rejects(stockpileMetrics([frame(0,present({copper:NaN}),true)]),/counter/);
});
test('progression: first completion per block and category, unit tier timeline, deconstruction ignored',async()=>{
  const ev=(t,entry)=>({event:'log',data:{entry:{t,...entry}}});
  const catalog={blocks:{'graphite-press':{category:'crafting'},'mechanical-drill':{category:'production'},'core-foundation':{category:'effect'}},
    units:{dagger:{tier:1},mace:{tier:2},alpha:{tier:null}}};
  const result=await progressionMetrics([
    ev(5,{kind:'block_build_end',breaking:true,team:'sharded',tile:{type:'graphite-press'}}),
    ev(10,{kind:'block_build_end',breaking:false,team:'sharded',tile:{type:'mechanical-drill'}}),
    ev(20,{kind:'block_build_end',breaking:false,team:'sharded',tile:{type:'graphite-press'}}),
    ev(25,{kind:'block_build_end',breaking:false,team:'sharded',tile:{type:'graphite-press'}}),
    ev(30,{kind:'unit_create',unit:{type:'dagger',team:'sharded'},spawner:{type:'ground-factory'}}),
    ev(40,{kind:'unit_create',unit:{type:'mace',team:'sharded'},spawner:{type:'additive-reconstructor'}}),
    ev(50,{kind:'block_build_end',breaking:false,team:'sharded',tile:{type:'core-foundation'}})],catalog,['sharded','crux']);
  const team=result.teams.sharded;
  assert.deepEqual(team.first_blocks['graphite-press'],{t:20,category:'crafting'});
  assert.deepEqual(team.first_by_category,{production:{t:10,block:'mechanical-drill'},crafting:{t:20,block:'graphite-press'},effect:{t:50,block:'core-foundation'}});
  assert.deepEqual(team.unit_tier_timeline,[{t:30,tier:1,unit:'dagger'},{t:40,tier:2,unit:'mace'}]);
  assert.deepEqual(team.cores,[{t:50,block:'core-foundation'}]);
  assert.deepEqual(result.teams.crux.first_blocks,{});
  assert.equal((await progressionMetrics([],null,['sharded'])).status,'partial');
});
