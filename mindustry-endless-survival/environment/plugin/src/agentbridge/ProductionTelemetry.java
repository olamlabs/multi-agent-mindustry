// SPDX-License-Identifier: GPL-3.0-only

package agentbridge;

import arc.Events;
import arc.util.Time;
import mindustry.Vars;
import mindustry.game.EventType.*;
import mindustry.game.Team;
import mindustry.gen.Building;
import mindustry.type.*;
import mindustry.world.Block;
import mindustry.world.blocks.distribution.*;
import mindustry.world.blocks.production.*;
import mindustry.world.blocks.units.*;
import java.nio.file.*;
import java.util.*;
import static agentbridge.AgentBridge.*;

final class ProductionTelemetry {
    static final double WINDOW_SECONDS=10, NEAR_CAPACITY=0.95;
    final AgentBridge bridge;
    final Set<Block> supported=Collections.newSetFromMap(new IdentityHashMap<>());
    final IdentityHashMap<Building, Meter> live=new IdentityHashMap<>();
    final List<Meter> history=new ArrayList<>();
    double simulationSeconds, lastSaved;
    int nextId=1;
    ProductionTelemetry(AgentBridge bridge){this.bridge=bridge;}

    void install(){
        for(Block block:Vars.content.blocks()){
            Class<?> type=block.buildType.get().getClass();
            if(block instanceof ArmoredConveyor nativeBlock && type==ArmoredConveyor.ArmoredConveyorBuild.class){
                block.buildType=()->nativeBlock.new ArmoredConveyorBuild(){
                    @Override public void updateConsumption(){super.updateConsumption(); sample(this);}
                    @Override public boolean pass(Item item){
                        boolean passed=super.pass(item);
                        if(passed) transferred(this,item);
                        return passed;
                    }
                };
                supported.add(block);
            }
            else if(block instanceof Conveyor nativeBlock && type==Conveyor.ConveyorBuild.class){
                block.buildType=()->nativeBlock.new ConveyorBuild(){
                    @Override public void updateConsumption(){super.updateConsumption(); sample(this);}
                    @Override public boolean pass(Item item){
                        boolean passed=super.pass(item);
                        if(passed) transferred(this,item);
                        return passed;
                    }
                };
                supported.add(block);
            }
            else if(block instanceof StackConveyor nativeBlock && type==StackConveyor.StackConveyorBuild.class){
                block.buildType=()->nativeBlock.new StackConveyorBuild(){
                    @Override public void updateConsumption(){super.updateConsumption();sample(this);}
                    @Override public void updateTile(){
                        Item item=items.first();int before=items.total();
                        super.updateTile();

                        int sent=before-items.total();
                        if(item!=null && sent>0)transferred(this,item,sent);
                    }
                };
                supported.add(block);
            }
            else if(block instanceof AttributeCrafter nativeBlock && type==AttributeCrafter.AttributeCrafterBuild.class){
                block.buildType=()->nativeBlock.new AttributeCrafterBuild(){
                    @Override public void updateConsumption(){super.updateConsumption(); sample(this);}
                    @Override public void handleItem(mindustry.gen.Building source,Item item){super.handleItem(source,item);bridge.evaluation.received(this,source,item,1);}
                    boolean producing;
                    @Override public void updateTile(){
                        producing=true;
                        try{super.updateTile();}finally{producing=false;}
                    }
                    @Override public void craft(){super.craft(); completed(this);}
                    @Override public void offload(Item item){
                        super.offload(item);
                        if(producing) itemProduced(this,item);
                    }
                    @Override public void handleLiquid(Building source,Liquid liquid,float amount){
                        super.handleLiquid(source,liquid,amount);
                        if(producing && source==this) liquidProduced(this,liquid,amount);
                    }
                };
                supported.add(block);
            }
            else if(block instanceof HeatCrafter nativeBlock && type==HeatCrafter.HeatCrafterBuild.class){
                block.buildType=()->nativeBlock.new HeatCrafterBuild(){
                    @Override public void updateConsumption(){super.updateConsumption(); sample(this);}
                    @Override public void handleItem(mindustry.gen.Building source,Item item){super.handleItem(source,item);bridge.evaluation.received(this,source,item,1);}
                    boolean producing;
                    @Override public void updateTile(){
                        producing=true;
                        try{super.updateTile();}finally{producing=false;}
                    }
                    @Override public void craft(){super.craft(); completed(this);}
                    @Override public void offload(Item item){
                        super.offload(item);
                        if(producing) itemProduced(this,item);
                    }
                    @Override public void handleLiquid(Building source,Liquid liquid,float amount){
                        super.handleLiquid(source,liquid,amount);
                        if(producing && source==this) liquidProduced(this,liquid,amount);
                    }
                };
                supported.add(block);
            }
            else if(block instanceof GenericCrafter nativeBlock && type==GenericCrafter.GenericCrafterBuild.class){
                block.buildType=()->nativeBlock.new GenericCrafterBuild(){
                    @Override public void updateConsumption(){super.updateConsumption(); sample(this);}
                    @Override public void handleItem(mindustry.gen.Building source,Item item){super.handleItem(source,item);bridge.evaluation.received(this,source,item,1);}
                    boolean producing;
                    @Override public void updateTile(){
                        producing=true;
                        try{super.updateTile();}finally{producing=false;}
                    }
                    @Override public void craft(){super.craft(); completed(this);}
                    @Override public void offload(Item item){
                        super.offload(item);
                        if(producing) itemProduced(this,item);
                    }
                    @Override public void handleLiquid(Building source,Liquid liquid,float amount){
                        super.handleLiquid(source,liquid,amount);
                        if(producing && source==this) liquidProduced(this,liquid,amount);
                    }
                };
                supported.add(block);
            }
            else if(block instanceof UnitFactory nativeBlock && type==UnitFactory.UnitFactoryBuild.class){
                block.buildType=()->nativeBlock.new UnitFactoryBuild(){
                    @Override public void updateConsumption(){super.updateConsumption(); sample(this);}
                    @Override public void handleItem(mindustry.gen.Building source,Item item){super.handleItem(source,item);bridge.evaluation.received(this,source,item,1);}
                };
                supported.add(block);
            }
            else if(block instanceof Reconstructor nativeBlock && type==Reconstructor.ReconstructorBuild.class){
                block.buildType=()->nativeBlock.new ReconstructorBuild(){
                    @Override public void updateConsumption(){super.updateConsumption(); sample(this);}
                };
                supported.add(block);
            }
        }
        Events.on(BlockDestroyEvent.class,event->retire(event.tile.build));
        Events.on(BuildTeamChangeEvent.class,event->retire(event.build));
        Events.on(PickupEvent.class,event->retire(event.build));
        Events.on(UnitCreateEvent.class,event->{
            Building b=event.spawner;
            if(b!=null && (b.block instanceof UnitFactory || b.block instanceof Reconstructor)){
                Meter meter=meter(b);
                if(meter!=null){meter.cycles++;add(meter.units,event.unit.type.name,1);meter.firstUnits.putIfAbsent(event.unit.type.name,simulationSeconds);}
            }
        });
    }
    boolean running(){return bridge.started && !bridge.terminal;}
    boolean placed(Building b){return b.tile!=null && b.tile.build==b && !b.dead;}
    Meter meter(Building b){
        if(!running() || !supported.contains(b.block) || !placed(b))return null;
        Meter meter=live.get(b);
        if(meter!=null && !meter.team.equals(b.team.name)){retire(meter);meter=null;}
        if(meter==null){meter=new Meter(nextId++,b,simulationSeconds,bridge.time());live.put(b,meter);history.add(meter);}
        return meter;
    }
    void transferred(Building b,Item item){transferred(b,item,1);}
    void transferred(Building b,Item item,int amount){Meter m=meter(b);if(m!=null){add(m.transferred,item.name,amount);m.windowItems+=amount;}}
    void itemProduced(Building b,Item item){Meter m=meter(b);if(m!=null){add(m.items,item.name,1);m.firstItems.putIfAbsent(item.name,simulationSeconds);}}
    void liquidProduced(Building b,Liquid liquid,float amount){Meter m=meter(b);if(m!=null && amount>0){add(m.liquids,liquid.name,amount);m.firstLiquids.putIfAbsent(liquid.name,simulationSeconds);}}
    void completed(Building b){Meter m=meter(b);if(m!=null)m.cycles++;}
    static void add(Map<String,Double> map,String key,double n){map.merge(key,n,Double::sum);}
    static boolean isBelt(Building b){return b.block instanceof Conveyor || b.block instanceof StackConveyor;}
    static Double ratio(double output,double potential){return potential>0?output/potential:null;}
    static Map<String,Object> ratios(Map<String,Double> actual,Map<String,Double> potential){
        var result=new LinkedHashMap<String,Object>();
        potential.forEach((key,value)->result.put(key,ratio(actual.getOrDefault(key,0d),value)));return result;
    }
    static Map<String,Object> rates(Map<String,Double> output,double seconds){
        var result=new LinkedHashMap<String,Object>();output.forEach((key,value)->result.put(key,ratio(value,seconds)));return result;
    }
    static double total(Map<String,Double> map){return map.values().stream().mapToDouble(Double::doubleValue).sum();}

    void sample(Building b){
        Meter m=meter(b);if(m==null || m.sampleTick==Vars.state.updateId)return;
        m.sampleTick=Vars.state.updateId;
        double seconds=Time.delta/60d, scaled=b.delta();
        m.observed+=seconds;
        m.efficiency=b.efficiency;
        if(!b.enabled)m.disabled+=seconds;
        if(b.power!=null && b.power.status<0.999999f)m.powerLimited+=seconds;

        if(b.potentialEfficiency<0.999999f && b.enabled)m.inputLimited+=seconds;
        if(b.efficiency>0)m.working+=seconds;
        if(isBelt(b)){
            double rate=b.block instanceof Conveyor conveyor?conveyor.displayedSpeed:((StackConveyor)b.block).itemCapacity*((StackConveyor)b.block).speed*60;
            double capacity=rate*scaled/60d;
            m.capacity+=capacity;m.windowCapacity+=capacity;m.windowSeconds+=seconds;
            return;
        }
        double cycles=0;
        if(b instanceof GenericCrafter.GenericCrafterBuild crafter){
            GenericCrafter block=(GenericCrafter)b.block;

            double multiplier=b instanceof AttributeCrafter.AttributeCrafterBuild attr?attr.efficiencyMultiplier():1;
            if(b instanceof AttributeCrafter.AttributeCrafterBuild attr && ((AttributeCrafter)b.block).scaleLiquidConsumption)multiplier*=attr.efficiencyScale();
            cycles=scaled*multiplier/block.craftTime;
            boolean blocked=b.enabled && !crafter.shouldConsume();
            if(block.outputItems!=null)for(ItemStack output:block.outputItems){
                double potential=cycles*crafter.scaleOutput(output.amount);
                add(m.potentialItems,output.item.name,potential);bridge.evaluation.lose(m,b,blocked,"items",output.item.name,potential);
            }
            if(block.outputLiquids!=null)for(LiquidStack output:block.outputLiquids){
                double potential=scaled*multiplier*output.amount;
                add(m.potentialLiquids,output.liquid.name,potential);bridge.evaluation.lose(m,b,blocked,"liquids",output.liquid.name,potential);
            }
            if(blocked)m.blocked+=seconds;
            m.recipe=block.name;
        }else if(b instanceof UnitFactory.UnitFactoryBuild factory){
            UnitFactory block=(UnitFactory)b.block;
            int plan=block.configurable?factory.currentPlan:0;
            if(plan>=0 && plan<block.plans.size){
                var selected=block.plans.get(plan);
                cycles=scaled*Vars.state.rules.unitBuildSpeed(b.team)/selected.time;
                add(m.potentialUnits,selected.unit.name,cycles);m.recipe=selected.unit.name;
                bridge.evaluation.lose(m,b,factory.payload!=null,"units",selected.unit.name,cycles);
            }else{m.unconfigured+=seconds;m.recipe=null;}
            if(factory.payload!=null)m.blocked+=seconds;
            if(!b.team.activateUnitFactories())m.activationDelay+=seconds;
        }else if(b instanceof Reconstructor.ReconstructorBuild factory){
            cycles=scaled*Vars.state.rules.unitBuildSpeed(b.team)/((Reconstructor)b.block).constructTime;
            m.recipe=factory.unit()==null?null:factory.unit().name;
            boolean blocked=factory.payload!=null && !factory.hasUpgrade(factory.payload.unit.type);
            if(factory.payload==null)m.noPayload+=seconds;
            else if(blocked)m.blocked+=seconds;
            bridge.evaluation.lose(m,b,blocked,"cycles","cycles",cycles);
            if(!b.team.activateUnitFactories())m.activationDelay+=seconds;
        }
        m.potentialCycles+=cycles;
    }
    void afterUpdate(){
        if(!running())return;

        for(Team team:Team.all)for(Building b:team.data().buildings)if(supported.contains(b.block))sample(b);
        simulationSeconds+=Time.delta/60d;
        for(Iterator<Meter> it=live.values().iterator();it.hasNext();){
            Meter m=it.next();
            if(!placed(m.building) || !m.team.equals(m.building.team.name)){
                m.active=false;m.ended=Math.max(simulationSeconds,m.began+m.observed);m.building=null;it.remove();continue;
            }
            if(m.windowSeconds>=WINDOW_SECONDS){
                m.lastWindow=obj("simulation_seconds",m.windowSeconds,"items",m.windowItems,"nominal_capacity_items",m.windowCapacity,
                    "items_per_second",m.windowItems/m.windowSeconds,"capacity_ratio",ratio(m.windowItems,m.windowCapacity));
                m.classifiedSeconds+=m.windowSeconds;
                if(m.windowCapacity>0 && m.windowItems/m.windowCapacity>=NEAR_CAPACITY)m.nearCapacitySeconds+=m.windowSeconds;
                m.windowSeconds=m.windowItems=m.windowCapacity=0;
            }
        }
    }
    void retire(Building b){Meter m=live.get(b);if(m!=null)retire(m);}
    void retire(Meter m){m.active=false;m.ended=Math.max(simulationSeconds,m.began+m.observed);live.remove(m.building);m.building=null;}
    Object building(Building b){
        Meter m=live.get(b);
        return m==null || !m.team.equals(b.team.name)?obj("supported",supported.contains(b.block),"observed_simulation_seconds",0):m.row();
    }
    List<Meter> records(Team viewer){return history.stream().filter(m->m.team.equals(viewer.name)).toList();}
    Object coverage(){
        List<String> names=supported.stream().map(b->b.name).sorted().toList();
        return obj("schema_version",1,"supported_blocks",names,"simulation_seconds",simulationSeconds,
            "unmeasured_conditions",List.of("unit_cap"),"near_capacity_threshold",NEAR_CAPACITY,"belt_window_simulation_seconds",WINDOW_SECONDS,
            "capacity_basis","native nominal rate; includes disabled/starved/blocked time; may exceed 1 under boosts or finite-window boundary effects",
            "evidence","production.jsonl");
    }
    void save(boolean force) throws java.io.IOException {
        if(!bridge.started || (!force && simulationSeconds-lastSaved<WINDOW_SECONDS))return;

        ArrayList<Object> rows=new ArrayList<>();
        for(Meter m:history)if(m.active || !m.savedRetired){rows.add(m.row());}
        Files.writeString(bridge.evidence.resolve("production.jsonl"),json(obj("t",bridge.time(),"tick",Vars.state.updateId,
            "simulation_seconds",simulationSeconds,"final",force,"coverage",coverage(),"buildings",rows))+"\n",
            StandardOpenOption.CREATE,StandardOpenOption.APPEND);
        lastSaved=simulationSeconds;
        for(Meter m:history)if(!m.active)m.savedRetired=true;
    }
    static final class Meter {
        final int id,buildingId,x,y;
        final String type,team,kind;
        final boolean belt;
        final double began,gameBegan;
        Building building;
        boolean active=true,savedRetired;
        Double ended;
        long sampleTick=-1;
        double observed,disabled,powerLimited,inputLimited,working,blocked,activationDelay,noPayload,unconfigured;
        double cycles,potentialCycles,capacity,windowItems,windowCapacity,windowSeconds,classifiedSeconds,nearCapacitySeconds,efficiency;
        String recipe;
        Object lastWindow;
        final Map<String,Double> items=new TreeMap<>(),liquids=new TreeMap<>(),units=new TreeMap<>(),transferred=new TreeMap<>();
        final Map<String,Double> potentialItems=new TreeMap<>(),potentialLiquids=new TreeMap<>(),potentialUnits=new TreeMap<>();
        final Map<String,Double> firstItems=new TreeMap<>(),firstLiquids=new TreeMap<>(),firstUnits=new TreeMap<>();
        Meter(int id,Building b,double began,double gameBegan){
            this.id=id;belt=isBelt(b);building=b;buildingId=b.id;x=b.tileX();y=b.tileY();type=b.block.name;team=b.team.name;this.began=began;this.gameBegan=gameBegan;
            kind=belt?"belt":b.block instanceof Reconstructor?"reconstructor":b.block instanceof UnitFactory?"unit_factory":"crafter";
        }
        Map<String,Object> row(){
            return obj("id",id,"building_id",buildingId,"type",type,"kind",kind,"team",team,"x",x,"y",y,"supported",true,
                "active",active,"start_simulation_seconds",began,"start_game_seconds",gameBegan,"end_simulation_seconds",ended,
                "observed_simulation_seconds",observed,"recipe",recipe,"native_efficiency",efficiency,

                "output",obj("items",new TreeMap<>(items),"liquids",new TreeMap<>(liquids),"units",new TreeMap<>(units),"completed_cycles",cycles),
                "first_output_simulation_seconds",obj("items",new TreeMap<>(firstItems),"liquids",new TreeMap<>(firstLiquids),"units",new TreeMap<>(firstUnits)),
                "output_per_simulation_second",obj("items",rates(items,observed),"liquids",rates(liquids,observed),"units",rates(units,observed)),
                "potential_output",obj("items",new TreeMap<>(potentialItems),"liquids",new TreeMap<>(potentialLiquids),"units",new TreeMap<>(potentialUnits),"cycles",potentialCycles),
                "cycle_utilization",belt?null:ratio(cycles,potentialCycles),
                "output_utilization",obj("items",ratios(items,potentialItems),"liquids",ratios(liquids,potentialLiquids),"units",ratios(units,potentialUnits)),
                "seconds",obj("disabled",disabled,"native_processing",working,"power_limited",powerLimited,"input_or_power_limited",inputLimited,
                    "output_or_payload_present",blocked,"unit_activation_delay",activationDelay,"no_input_payload",noPayload,"unconfigured",unconfigured),
                "belt",belt?obj("transferred_items",new TreeMap<>(transferred),"nominal_capacity_items",capacity,"items_per_second",ratio(total(transferred),observed),
                    "capacity_ratio",ratio(total(transferred),capacity),"last_complete_window",lastWindow,
                    "near_capacity_seconds",nearCapacitySeconds,"classified_seconds",classifiedSeconds,
                    "near_capacity_fraction",ratio(nearCapacitySeconds,classifiedSeconds),"partial_window_seconds",windowSeconds):null);
        }
    }
}
