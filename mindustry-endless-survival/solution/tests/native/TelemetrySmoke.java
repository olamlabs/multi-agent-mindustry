package agentbridge;

import arc.util.Time;
import arc.util.serialization.JsonValue;
import mindustry.Vars;
import mindustry.content.*;
import mindustry.core.GameState.State;
import mindustry.game.Team;
import mindustry.gen.Building;
import mindustry.world.Block;
import mindustry.world.blocks.distribution.Conveyor;
import mindustry.world.blocks.production.GenericCrafter;
import mindustry.world.blocks.units.*;
import mindustry.world.blocks.payloads.UnitPayload;
import java.util.*;

public class TelemetrySmoke extends AgentBridge {
    void check(boolean value,String message){if(!value)throw new AssertionError(message);}
    Building place(Block block,int x,int y){Vars.world.tile(x,y).setBlock(block,Team.sharded,0);return Vars.world.build(x,y);}
    boolean supportedType(Block b){return production.supported.contains(b);}
    ProductionTelemetry.Meter metric(Building b){return production.live.get(b);}
    void step(int ticks,List<Building> buildings,Runnable supply){
        for(int i=0;i<ticks;i++){
            Time.delta=1;Vars.state.updateId++;
            supply.run();
            for(Building b:buildings)if(b.tile.build==b)b.update();
            production.afterUpdate();
        }
    }
    @Override Object route(String path,JsonValue args) throws Exception {
        if(!path.equals("/telemetry_test"))return super.route(path,args);
        Vars.state.set(State.paused);started=true;startNanos=System.nanoTime();

        for(int x=80;x<120;x++)for(int y=80;y<120;y++){
            Vars.world.tile(x,y).setBlock(Blocks.air);Vars.world.tile(x,y).setFloor(Blocks.stone.asFloor());
        }
        Building source=place(Blocks.container,89,90);
        var belt=(Conveyor.ConveyorBuild)place(Blocks.conveyor,91,90);
        Building sink=place(Blocks.container,92,90);
        Runnable feed=()->{if(belt.acceptItem(source,Items.copper))belt.handleItem(source,Items.copper);};
        step(1200,List.of(belt),feed);
        var m=metric(belt);
        double delivered=m.transferred.getOrDefault("copper",0d);
        check(delivered>60,"belt delivered items");
        check(delivered==sink.items.get(Items.copper),"counter equals native sink, not occupancy");
        check(Math.abs(m.capacity-((Conveyor)belt.block).displayedSpeed*20)<0.001,"integrated nominal belt capacity");
        check(m.classifiedSeconds>=19.9,"full windows classified");
        double observed=m.observed,capacity=m.capacity;
        belt.enabled=false;
        step(600,List.of(belt),()->{});
        check(m.transferred.get("copper")==delivered,"disabled belt produces no transfers");
        check(m.observed>observed+9.99 && m.capacity>capacity,"disabled time remains in denominator");
        check(m.disabled>=9.99,"disabled seconds");
        belt.enabled=true;
        sink.items.set(Items.copper,sink.getMaximumAccepted(Items.copper));
        step(600,List.of(belt),feed);
        check(m.transferred.get("copper")==delivered,"blocked belt is not production");

        belt.removeStack(Items.copper,100);sink.items.clear();
        observed=m.observed;
        step(600,List.of(),()->{});
        check(m.observed>observed+9.99,"sleeping belt counted");
        production.save(false);
        int oldId=m.id;belt.tile.remove();
        var replacement=(Conveyor.ConveyorBuild)place(Blocks.conveyor,91,90);
        step(1,List.of(replacement),()->{});
        check(!m.active && metric(replacement).id!=oldId,"rebuild has distinct lifetime");
        check(m.transferred.get("copper")==delivered,"retired lifetime preserved");
        var stack=(mindustry.world.blocks.distribution.StackConveyor.StackConveyorBuild)place(Blocks.plastaniumConveyor,91,100);
        var stackNext=(mindustry.world.blocks.distribution.StackConveyor.StackConveyorBuild)place(Blocks.plastaniumConveyor,92,100);
        stack.handleStack(Items.copper,stack.block.itemCapacity,null);
        step(600,List.of(stack,stackNext),()->{});
        check(metric(stack).transferred.getOrDefault("copper",0d)==stackNext.items.get(Items.copper),"batch transfer equals destination");
        check(metric(stack).transferred.getOrDefault("copper",0d)>0,"plastanium transfers measured");
        var press=(GenericCrafter.GenericCrafterBuild)place(Blocks.graphitePress,100,90);
        press.items.set(Items.graphite,3);
        step(1,List.of(press),()->{});
        var pm=metric(press);
        check(pm.items.isEmpty(),"deposits not production");
        var frozen=pm.row();
        step(1200,List.of(press),()->press.items.set(Items.coal,10));
        check(((Map<?,?>)((Map<?,?>)frozen.get("output")).get("items")).isEmpty(),"in-flight HTTP observation stays immutable across native updates");
        check(pm.cycles>5,"native crafts occurred");
        check(pm.items.get("graphite")==press.items.get(Items.graphite)-3,"exact native craft output");
        check(pm.firstItems.get("graphite")>=pm.began && pm.firstItems.get("graphite")<production.simulationSeconds,"first craft has native simulation timestamp");
        check(pm.potentialCycles>0,"factory potential measured even while blocked");
        double output=pm.cycles;press.items.set(Items.graphite,press.block.itemCapacity);
        step(600,List.of(press),()->press.items.set(Items.coal,10));
        check(pm.cycles==output && pm.blocked>9.99,"output blockage accumulates downtime");
        press.items.clear();
        step(600,List.of(press),()->{});
        check(pm.inputLimited>9.99 && pm.cycles==output,"input starvation");
        var factory=(UnitFactory.UnitFactoryBuild)place(Blocks.groundFactory,110,90);
        factory.currentPlan=0;
        Vars.state.rules.unitBuildSpeedMultiplier=2;
        double expected=1200d*2/((UnitFactory)factory.block).plans.get(0).time;
        step(1200,List.of(factory),()->{
            factory.power.status=1;factory.items.set(Items.silicon,100);factory.items.set(Items.lead,100);
            factory.payload=null;
        });
        var fm=metric(factory);
        check(fm.units.getOrDefault("dagger",0d)>=2,"native unit events counted");
        check(Math.abs(fm.potentialCycles-expected)<0.001,"team unit speed multiplier integrated");
        double potential=fm.potentialCycles;
        factory.currentPlan=1;
        step(60,List.of(factory),()->{factory.power.status=0;factory.payload=null;});
        check(fm.potentialCycles>potential && fm.potentialUnits.size()==2,"recipe changes retained");
        check(fm.powerLimited>.99,"power starvation measured");
        factory.currentPlan=-1;
        step(60,List.of(factory),()->{});
        check(fm.unconfigured>.99,"unconfigured time exposed");

        press.enabled=false;potential=pm.potentialCycles;
        press.applyBoost(2,1000);
        step(60,List.of(press),()->{});
        double expectedBoost=120d/((GenericCrafter)press.block).craftTime;
        check(Math.abs(pm.potentialCycles-potential-expectedBoost)<0.001,"overdrive integrated while disabled");
        var recon=(Reconstructor.ReconstructorBuild)place(Blocks.additiveReconstructor,110,100);
        recon.payload=new UnitPayload(UnitTypes.dagger.create(Team.sharded));recon.payVector.setZero();
        step(1800,List.of(recon),()->{
            recon.power.status=1;recon.items.set(Items.silicon,100);recon.items.set(Items.graphite,100);
        });
        var rm=metric(recon);
        check(rm.units.getOrDefault("mace",0d)==1,"one native upgrade, not a new tier-one unit");
        check(rm.cycles==1,"upgrade cycle counted exactly once");
        check(rm.kind.equals("reconstructor") && rm.firstUnits.containsKey("mace"),"upgrade provenance and first-output timestamp");
        var mixer=(GenericCrafter.GenericCrafterBuild)place(Blocks.cryofluidMixer,100,110);
        mixer.liquids.set(Liquids.cryofluid,2);
        step(60,List.of(mixer),()->{
            mixer.power.status=1;mixer.items.set(Items.titanium,10);mixer.liquids.set(Liquids.water,40);
        });
        var lm=metric(mixer);
        check(lm.liquids.getOrDefault("cryofluid",0d)>0,"native liquid output measured");
        check(Math.abs(lm.liquids.get("cryofluid")-(mixer.liquids.get(Liquids.cryofluid)-2))<0.001,"liquid counter excludes deposit");
        check(lm.potentialLiquids.get("cryofluid")>0,"liquid capacity integrated");
        var terrain=(mindustry.world.blocks.production.AttributeCrafter.AttributeCrafterBuild)place(Blocks.siliconCrucible,90,110);
        step(60,List.of(terrain),()->{});
        var tm=metric(terrain);
        check(tm.potentialItems.getOrDefault("silicon",0d)>0 && tm.items.isEmpty(),"terrain recipe has potential while starved");
        check(!supportedType(Blocks.separator),"specialized factory explicitly unsupported");
        check(production.records(Team.crux).isEmpty(),"own-team telemetry privacy");
        press.changeTeam(Team.crux);
        check(!pm.active && metric(press)==null,"ownership event immediately retires lifetime");
        check(((java.util.Map<?,?>)production.building(press)).get("observed_simulation_seconds").equals(0),"new owner cannot read old counters");
        press.changeTeam(Team.sharded);
        step(1,List.of(press),()->{});
        check(metric(press).id!=pm.id && metric(press).items.isEmpty(),"recapture starts a new lifetime");
        Vars.state.rules.unitCapVariable=false;Vars.state.rules.unitCap=0;
        check(!mindustry.entities.Units.canCreate(Team.sharded,UnitTypes.dagger),"native unit cap exhausted");
        check(Team.sharded.activateUnitFactories(),"unit cap does not imply activation delay");
        double delayed=fm.activationDelay;
        step(1,List.of(factory),()->{});
        check(fm.activationDelay==delayed,"exhausted cap is not mislabeled activation delay");
        Vars.state.rules.unitFactoryActivationDelay=(float)Vars.state.tick+600;
        step(1,List.of(factory),()->{});
        check(fm.activationDelay>delayed,"native activation delay is measured separately");
        check(!((Map<?,?>)fm.row().get("seconds")).containsKey("unit_cap"),"unmeasured unit-cap downtime is not a fake zero");
        production.save(true);
        return obj("ok",true,"belt_delivered",delivered,"crafts",pm.cycles,"new_units",fm.units,"upgrades",rm.units,
            "coverage",production.coverage(),"lifetime_count",production.history.size());
    }
}
