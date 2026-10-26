package agentbridge;

import arc.util.Time;
import arc.util.serialization.JsonValue;
import mindustry.Vars;
import mindustry.content.*;
import mindustry.core.GameState.State;
import mindustry.entities.bullet.BulletType;
import mindustry.game.Team;
import mindustry.gen.*;
import mindustry.type.Item;
import mindustry.world.Block;
import mindustry.world.blocks.defense.turrets.ItemTurret;
import mindustry.world.blocks.distribution.*;
import mindustry.world.blocks.production.*;
import java.util.*;

public class EvaluationSmoke extends AgentBridge {

    static final class Inert implements mindustry.entities.units.UnitController {
        Unit unit;
        public void unit(Unit unit){this.unit=unit;}
        public Unit unit(){return unit;}
    }
    static Unit still(Unit u){u.controller(new Inert());return u;}
    void check(boolean value,String message){if(!value)throw new AssertionError(message);}
    Building place(Block block,int x,int y,Team team){Vars.world.tile(x,y).setBlock(block,team,0);return Vars.world.build(x,y);}
    Building place(Block block,int x,int y){return place(block,x,y,Team.sharded);}
    EvaluationTelemetry.Meter metric(Building b){return evaluation.live.get(b);}
    void step(int ticks,List<Building> buildings,List<Unit> units,Runnable supply){
        for(int i=0;i<ticks;i++){
            Time.delta=1;Vars.state.updateId++;
            supply.run();
            for(Building b:buildings)if(b.tile.build==b)b.update();
            for(Unit u:units)if(u.isValid())u.update();
            for(PowerGraphUpdaterc g:Groups.powerGraph)g.graph().update();
            production.afterUpdate();evaluation.afterUpdate();
        }
    }
    void step(int ticks,List<Building> buildings,Runnable supply){step(ticks,buildings,List.of(),supply);}
    static double sum(Map<String,Double> m){return m.values().stream().mapToDouble(Double::doubleValue).sum();}
    double lost(Map<String,Map<String,Map<String,Double>>> lost,String cause,String category,String key){
        return lost.getOrDefault(cause,Map.of()).getOrDefault(category,Map.of()).getOrDefault(key,0d);
    }
    double row(Map<String,double[]> map,String key){double[] v=map.get(key);return v==null?0:v[0];}

    @Override Object route(String path,JsonValue args) throws Exception {
        if(!path.equals("/evaluation_test"))return super.route(path,args);
        Vars.state.set(State.paused);started=true;startNanos=System.nanoTime();
        for(int x=60;x<140;x++)for(int y=60;y<140;y++){Vars.world.tile(x,y).setBlock(Blocks.air);Vars.world.tile(x,y).setFloor(Blocks.stone.asFloor());Vars.world.tile(x,y).setOverlay(Blocks.air);}
        var result=new LinkedHashMap<String,Object>();

        for(int x=70;x<72;x++)for(int y=70;y<72;y++)Vars.world.tile(x,y).setOverlay(Blocks.oreCopper);
        var drill=(Drill.DrillBuild)place(Blocks.mechanicalDrill,70,70);
        drill.onProximityUpdate();
        step(3600,List.of(drill),()->{});
        var dm=metric(drill);
        check(dm!=null && dm.kind.equals("drill"),"mechanical drill is measured as extraction");
        double drilled=dm.items.getOrDefault("copper",0d);
        check(drilled>0 && drilled==drill.items.get(Items.copper),"drill output equals native items produced");
        check(dm.potentialItems.getOrDefault("copper",0d)>=drilled,"nominal drill potential bounds output without boost");
        check(dm.firstItems.containsKey("copper"),"first drill output timestamp");
        check(drill.items.total()>=drill.block.itemCapacity && dm.blocked>0 && lost(dm.lost,"output_blocked","items","copper")>0,"full drill loses output to blockage");
        result.put("drill_copper",drilled);

        Vars.world.tile(80,70).setFloor(Blocks.water.asFloor());
        var pump=(Pump.PumpBuild)place(Blocks.mechanicalPump,80,70);
        pump.onProximityUpdate();
        step(120,List.of(pump),()->{});
        var pm=metric(pump);
        check(pm!=null && Math.abs(pm.liquids.getOrDefault("water",0d)-pump.liquids.get(Liquids.water))<1e-3,"pump output equals native liquid pumped");
        result.put("pump_water",pm.liquids.get("water"));

        Vars.world.tile(90,90).setOverlay(Blocks.oreLead);
        Unit miner=still(UnitTypes.alpha.create(Team.sharded));miner.set(90*8,92*8);miner.add();
        miner.mineTile=Vars.world.tile(90,90);
        float threshold=50f+(miner.type.mineHardnessScaling?Items.lead.hardness*15f:15f);
        float rate=miner.type.mineSpeed*Vars.state.rules.unitMineSpeed(Team.sharded);
        int ticks=1200;
        step(ticks,List.of(),List.of(miner),()->{miner.mineTile=Vars.world.tile(90,90);});
        int perCycle=(int)Math.ceil(threshold/rate);
        Map<String,Double> mined=evaluation.mined.getOrDefault("sharded"+EvaluationTelemetry.SEP+"alpha"+EvaluationTelemetry.SEP+"ai",Map.of());
        check(mined.getOrDefault("lead",0d)==ticks/perCycle,"one mined item per native mining cycle: "+mined+" expected "+ticks/perCycle);
        result.put("mined_lead",mined.get("lead"));

        var core=Team.sharded.core();
        int before=core.items.get(Items.lead);
        miner.clearItem();miner.addItem(Items.lead,5);
        core.handleStack(Items.lead,5,miner);
        double deposited=evaluation.unitDeposits.getOrDefault("sharded"+EvaluationTelemetry.SEP+"alpha"+EvaluationTelemetry.SEP+"ai",Map.of()).getOrDefault("lead",0d);
        check(deposited==core.items.get(Items.lead)-before && deposited==5,"core unit deposit equals native stored amount");

        Building source=place(Blocks.container,99,100);
        var belt=(Conveyor.ConveyorBuild)place(Blocks.conveyor,100,100);
        var turret=(ItemTurret.ItemTurretBuild)place(Blocks.duo,101,100);
        step(600,List.of(belt,turret),()->{if(belt.acceptItem(source,Items.copper))belt.handleItem(source,Items.copper);});
        double passed=production.live.get(belt).transferred.getOrDefault("copper",0d);
        double delivered=evaluation.deliveries.getOrDefault("sharded"+EvaluationTelemetry.SEP+"turret",Map.of()).getOrDefault("copper",0d);
        check(passed>0 && delivered==passed,"turret deliveries equal native belt handoffs: "+delivered+" vs "+passed);
        var duct=(Duct.DuctBuild)place(Blocks.duct,100,105);
        Building ductSink=place(Blocks.container,101,105);
        int fed=0;
        for(int i=0;i<600;i++){if(duct.acceptItem(source,Items.lead)){duct.handleItem(source,Items.lead);fed++;}step(1,List.of(duct),()->{});}
        var um=metric(duct);
        check(um!=null && um.kind.equals("duct") && um.transferred.getOrDefault("lead",0d)==fed,"duct throughput counts every accepted item");
        check(ductSink.items.get(Items.lead)>0 && um.hasCapacity && um.capacity>0,"duct moves items into its sink against nominal capacity");
        var router=place(Blocks.router,100,110);
        router.handleItem(source,Items.sand);
        check(metric(router)!=null && metric(router).transferred.get("sand")==1 && !metric(router).hasCapacity,"router throughput without a nominal rate");
        result.put("belt_turret_deliveries",delivered);result.put("duct_items",fed);

        var press=(GenericCrafter.GenericCrafterBuild)place(Blocks.graphitePress,110,70);
        step(600,List.of(press),()->{});
        var pmeter=production.live.get(press);
        var stall=evaluation.stalled.get(pmeter.id);
        double starved=stall.causes.get("input_limited").get("items").get("graphite");
        check(Math.abs(starved-pmeter.potentialItems.get("graphite"))<1e-6,"a starved press loses its whole potential to input");
        press.items.set(Items.graphite,press.block.itemCapacity);
        step(600,List.of(press),()->press.items.set(Items.coal,10));
        check(stall.causes.containsKey("output_blocked"),"a full press loses output to blockage");
        press.enabled=false;
        step(60,List.of(press),()->{});
        check(stall.causes.containsKey("disabled"),"a disabled press loses output to being disabled");

        Unit shooter=still(UnitTypes.dagger.create(Team.sharded));shooter.set(120*8,120*8);shooter.add();
        Unit victim=still(UnitTypes.dagger.create(Team.crux));victim.set(121*8,120*8);victim.add();
        step(1,List.of(),List.of(shooter,victim),()->{});
        BulletType type=UnitTypes.dagger.weapons.first().bullet;
        Bullet shot=type.create(shooter,Team.sharded,victim.x,victim.y,0);
        float health=EvaluationTelemetry.effective(victim);
        type.hitEntity(shot,victim,victim.health);
        float dealt=health-EvaluationTelemetry.effective(victim);
        String pair="sharded"+EvaluationTelemetry.SEP+"unit"+EvaluationTelemetry.SEP+"dagger"+EvaluationTelemetry.SEP+"crux"+EvaluationTelemetry.SEP+"unit"+EvaluationTelemetry.SEP+"dagger";
        check(dealt>0 && Math.abs(row(evaluation.damage,pair)-dealt)<1e-3,"attributed damage equals native health lost");
        step(1,List.of(),List.of(shooter,victim),()->{});
        check(Math.abs(row(evaluation.damage,pair)-dealt)<1e-3,"an attributed hit is not counted again as unattributed");
        String target="crux"+EvaluationTelemetry.SEP+"unit"+EvaluationTelemetry.SEP+"dagger";
        health=EvaluationTelemetry.effective(victim);
        victim.damage(20);
        float silent=health-EvaluationTelemetry.effective(victim);
        step(1,List.of(),List.of(shooter,victim),()->{});
        check(silent>0 && Math.abs(row(evaluation.unattributed,target)-silent)<1e-3,"eventless damage is unattributed, not dropped");
        Building wall=place(Blocks.copperWall,122,122,Team.crux);
        step(1,List.of(wall),()->{});
        float wallHealth=wall.health;
        wall.collision(type.create(shooter,Team.sharded,wall.x,wall.y,0));
        String wallPair="sharded"+EvaluationTelemetry.SEP+"unit"+EvaluationTelemetry.SEP+"dagger"+EvaluationTelemetry.SEP+"crux"+EvaluationTelemetry.SEP+"building"+EvaluationTelemetry.SEP+"copper-wall";
        check(Math.abs(row(evaluation.damage,wallPair)-(wallHealth-wall.health))<1e-3 && wallHealth>wall.health,"building hit attributed to its bullet's owner");
        for(int guard=0;!victim.dead() && guard<1000;guard++){Bullet b=type.create(shooter,Team.sharded,victim.x,victim.y,0);type.hitEntity(b,victim,victim.health);}
        check(victim.dead(),"repeated hits kill the target");
        check(row(evaluation.kills,pair)==1 && row(evaluation.deaths,target)==1,"one kill attributed and one death counted");
        result.put("attributed_damage",row(evaluation.damage,pair));result.put("unattributed_damage",row(evaluation.unattributed,target));

        turret.handleItem(source,Items.copper);
        step(1,List.of(turret),List.of(shooter),()->{});
        double turretDps=0,unitDps=0;
        for(Building b:Team.sharded.data().buildings)if(b.enabled && b instanceof mindustry.world.blocks.defense.turrets.BaseTurret.BaseTurretBuild t)turretDps+=t.estimateDps();
        for(Unit u:Groups.unit)if(u.isValid() && u.team==Team.sharded && !u.isPlayer())unitDps+=u.type.estimateDps();
        var fp=evaluation.firepower.get("sharded");
        check(turretDps>0 && Math.abs(fp.current[0]-turretDps)<1e-6 && Math.abs(fp.current[1]-unitDps)<1e-6,"firepower equals native DPS estimates");
        result.put("firepower_turrets",fp.current[0]);result.put("firepower_units",fp.current[1]);

        var smelter=place(Blocks.siliconSmelter,130,70);
        evaluation.power.clear();
        step(60,List.of(smelter),()->{smelter.items.set(Items.sand,10);smelter.items.set(Items.coal,10);});
        var alone=evaluation.power.get("sharded");
        check(alone!=null && alone.blackoutSeconds>0 && alone.fullSeconds==0,"unpowered consumer time is blackout");
        var supply=place(Blocks.powerSource,130,75);
        supply.power.graph.addGraph(smelter.power.graph);
        evaluation.power.clear();
        step(60,List.of(smelter,supply),()->{smelter.items.set(Items.sand,10);smelter.items.set(Items.coal,10);});
        var joined=evaluation.power.get("sharded");
        check(joined.fullSeconds>0 && joined.blackoutSeconds==0 && Math.abs(joined.supplied-joined.needed)<1e-3,"supplied consumer time is full power");
        result.put("power_full_fraction",ProductionTelemetry.ratio(joined.fullSeconds,joined.consumerSeconds));

        check(production.records(Team.sharded).stream().noneMatch(m->m.type.equals("mechanical-drill")),"drills stay out of agent-visible production records");
        evaluation.save(true);evaluation.saveStockpiles(true);evaluation.writeCatalog();
        result.put("extraction_lifetimes",evaluation.history.stream().filter(m->m.extraction).count());
        result.put("transport_lifetimes",evaluation.history.stream().filter(m->!m.extraction).count());
        result.put("ok",true);
        return result;
    }
}
