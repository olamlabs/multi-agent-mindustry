package harbor;

import arc.Events;
import arc.math.Mathf;
import arc.util.Time;
import arc.util.serialization.JsonValue;
import mindustry.Vars;
import mindustry.content.*;
import mindustry.core.GameState.State;
import mindustry.entities.units.UnitController;
import mindustry.game.EventType.*;
import mindustry.game.Team;
import mindustry.gen.*;
import mindustry.type.UnitType;
import mindustry.world.Block;
import mindustry.world.Tile;
import mindustry.world.blocks.defense.turrets.ItemTurret;
import java.util.*;

public class SurvivalSmoke extends HarborBridge {

    static final class Scripted implements UnitController {
        Unit unit;
        Runnable next;
        public void unit(Unit unit){this.unit=unit;}
        public Unit unit(){return unit;}
        public void updateUnit(){Runnable run=next;next=null;if(run!=null)run.run();}
    }
    void check(boolean value,String message){if(!value)throw new AssertionError(message);}

    void update(float d){Time.delta=d;Vars.logic.update();}
    Building place(Block block,int x,int y,Team team){Vars.world.tile(x,y).setBlock(block,team,0);return Vars.world.build(x,y);}
    Unit unit(UnitType type,Team team,float x,float y){Unit u=type.create(team);u.set(x,y);u.controller(new Scripted());u.add();return u;}

    static void shoot(Entityc owner,Team team,float x,float y,float damage){((ItemTurret)Blocks.duo).ammoTypes.get(Items.copper).create(owner,team,x,y,0,damage,1f,1f,null);}
    static double row(Map<String,double[]> map,String key){double[] v=map.get(key);return v==null?0:v[0];}
    static String key(String... parts){return String.join(EvaluationTelemetry.SEP,parts);}
    void clear(int x0,int y0,int x1,int y1){
        for(int x=x0;x<=x1;x++)for(int y=y0;y<=y1;y++){Tile t=Vars.world.tile(x,y);if(t==null)continue;t.setBlock(Blocks.air);t.setFloor(Blocks.stone.asFloor());t.setOverlay(Blocks.air);}
    }

    @Override Object route(String path,JsonValue a) throws Exception {
        if(!path.equals("/survival_test"))return super.route(path,a);
        float frameDelta=Time.delta;
        try{

            if(a.has("start"))super.route("/start",a.get("start"));
            return switch(a.getString("case")){
                case "waves"->waves(a);
                case "budget"->budget(a);
                case "clearance"->clearance();
                case "economy_death"->economyDeath();
                case "updates"->{for(int i=0;i<a.getInt("updates");i++)update(1);yield obj("ok",true,"simulation_tick",endless==null?null:endless.ticks);}
                case "combat"->combat();
                default->throw new IllegalArgumentException("Unknown case");
            };
        }finally{
            Time.delta=frameDelta;
            if(!terminal)Vars.state.set(State.paused);
        }
    }

    Object budget(JsonValue a){
        int count=a.getInt("waves");
        int guard=0,previous=0;
        while(endless.wavesSpawned<count){
            check(++guard<300000,"bounded fixture updates");
            check(!terminal,"fixture core remains alive");
            update(4f);
            if(endless.wavesSpawned!=previous){
                previous=endless.wavesSpawned;
                for(Unit unit:Groups.unit.copy(new arc.struct.Seq<>()))if(unit.team==Vars.state.rules.waveTeam)unit.remove();
            }
        }
        return obj("ok",true,"ground_spawns",Vars.spawner.countGroundSpawns(),"groups_now",Vars.state.rules.spawns.size);
    }

    void traced(List<Object> trace,float d){
        var enemies=new ArrayList<Object>();
        for(Unit u:Groups.unit)if(u.team==Vars.state.rules.waveTeam&&u.isValid())
            enemies.add(List.of(u.id,(double)u.health,(double)u.shield,(double)u.armor,(double)Vars.state.rules.unitHealth(u.team)));
        trace.add(obj("delta",(double)d,"waves_spawned",endless.wavesSpawned,"enemies",enemies));
        update(d);
    }

    Object clearance(){
        check(endless.firstWave==600 && endless.spacing==600,"clearance fixture schedule");
        var spawned=new TreeMap<Integer,List<Integer>>();
        Events.on(UnitSpawnEvent.class,e->spawned.computeIfAbsent(Vars.state.wave,k->new ArrayList<>()).add(e.unit.id));
        var trace=new ArrayList<Object>();
        int guard=0;
        while(endless.wavesSpawned<1){check(++guard<1000,"the first wave arrives");update(4f);}
        var first=new ArrayList<Unit>();
        for(Unit u:Groups.unit)if(u.team==Vars.state.rules.waveTeam)first.add(u);
        check(first.size()>=2,"the first wave has two enemies to kill and wound");
        for(int i=0;i<5;i++)traced(trace,2f);
        first.get(0).kill();
        first.get(1).damage(50f);
        for(int i=0;i<5;i++)traced(trace,2f);
        while(endless.wavesSpawned<2){check(++guard<2000,"the second wave arrives");traced(trace,4f);}
        for(int i=0;i<3;i++)traced(trace,1f);
        var second=spawned.getOrDefault(2,List.of());
        for(Unit u:Groups.unit.copy(new arc.struct.Seq<>()))if(second.contains(u.id))u.remove();
        for(int i=0;i<3;i++)traced(trace,3f);
        var core=Team.sharded.core();
        for(var c:Team.sharded.cores().copy())if(c!=core)c.damage(c.health+1);
        Unit owner=unit(UnitTypes.dagger,Vars.state.rules.waveTeam,core.x+400,core.y);
        traced(trace,1f);
        shoot(owner,Vars.state.rules.waveTeam,core.x,core.y,core.maxHealth*10+1000);
        traced(trace,1f);
        check(terminal,"the last core fell in a traced update");
        return obj("ok",true,"spawned",spawned,"trace",trace,"unscheduled",owner.id);
    }

    Object waves(JsonValue a){
        int count=a.getInt("waves");
        boolean irregular=a.getBoolean("irregular"),noise=a.getBoolean("noise"),dropZone=a.getBoolean("drop_zone");
        Random random=new Random(a.getLong("noise_seed",0));
        var rules=Vars.state.rules;
        check(rules.waves && rules.waveTimer && !rules.waitEnemies && !rules.waveSending && rules.winWave==0 && !rules.attackMode && !rules.pvp && rules.canGameOver,"profile forces the endless rules");
        check(rules.weather.isEmpty() && Groups.weather.isEmpty(),"no weather in the fixed scenario");
        check(Vars.spawner instanceof EndlessSurvival.Spawner,"seeded native spawner");
        var spawned=new TreeMap<Integer,List<Object>>();
        var deltas=new TreeMap<Integer,Double>();
        Events.on(UnitSpawnEvent.class,e->{
            spawned.computeIfAbsent(Vars.state.wave,k->new ArrayList<>()).add(List.of(e.unit.type.name,(double)e.unit.x,(double)e.unit.y));
            deltas.put(Vars.state.wave,(double)Time.delta);

            if(noise)for(int i=random.nextInt(3);i>=0;i--)Mathf.random();
        });

        if(noise)Events.on(BlockDestroyEvent.class,e->{for(int i=random.nextInt(5);i>=0;i--)Mathf.random();});
        var walls=new ArrayList<Building>();
        if(dropZone)for(Tile spawn:Vars.spawner.getSpawns())for(int dx=-6;dx<=6;dx+=3)for(int dy=-6;dy<=6;dy+=3){
            if(random.nextBoolean())continue;
            Tile t=Vars.world.tile(spawn.x+dx,spawn.y+dy);
            if(t!=null && t.block()==Blocks.air && !t.floor().isDeep()){t.setBlock(Blocks.copperWall,Team.sharded,0);walls.add(t.build);}
        }
        check(!dropZone || !walls.isEmpty(),"structures inside the drop zone");
        float step=a.getFloat("step",1f);
        check(Float.isFinite(step)&&step>0&&step<=4,"native step within cap");
        int guard=0;
        while(endless.wavesSpawned<count){
            check(++guard<200000,"waves keep coming");
            check(!terminal,"the core survives the test waves");
            update(irregular?0.25f+3.75f*random.nextFloat():step);
            if(noise)for(int i=random.nextInt(4);i>=0;i--)Mathf.random();
        }
        int standing=(int)walls.stream().filter(b->b.tile.build==b && !b.dead).count();
        int enemies=Groups.unit.count(u->u.team==Vars.state.rules.waveTeam);
        return obj("ok",true,"waves",spawned,"wave_deltas",deltas,"walls_placed",walls.size(),"walls_standing",standing,"enemies_alive",enemies,
            "spawns",Vars.spawner.getSpawns().size);
    }

    Object economyDeath(){
        var core=Team.sharded.core();
        int cx=core.tileX(),cy=core.tileY(),edge=cx+core.block.size/2;
        clear(edge+1,cy-1,edge+6,cy+2);
        for(int x=edge+3;x<=edge+4;x++)for(int y=cy;y<=cy+1;y++)Vars.world.tile(x,y).setOverlay(Blocks.oreCopper);
        Building belt1=place(Blocks.conveyor,edge+1,cy,Team.sharded),belt2=place(Blocks.conveyor,edge+2,cy,Team.sharded);
        belt1.rotation=belt2.rotation=2;
        Building drill=place(Blocks.mechanicalDrill,edge+3,cy,Team.sharded);
        for(Building b:List.of(belt1,belt2,drill))b.onProximityUpdate();
        int copper=core.items.get(Items.copper);
        for(int i=0;i<3600;i++)update(1);
        check(core.items.get(Items.copper)>copper,"the chain delivers copper to the core");
        var result=obj("core_copper_gain",core.items.get(Items.copper)-copper,
            "drill_copper",evaluation.live.get(drill).items.getOrDefault("copper",0d),
            "belt_copper",production.live.get(belt1).transferred.getOrDefault("copper",0d),
            "core_deliveries",evaluation.deliveries.getOrDefault(key("sharded","core"),Map.of()).getOrDefault("copper",0d));

        for(var c:Team.sharded.cores().copy())if(c!=core)c.damage(c.health+1);
        update(1);
        check(Team.sharded.cores().size==1 && !terminal,"one friendly core left");
        Unit owner=unit(UnitTypes.dagger,Team.crux,core.x+400,core.y);
        update(1);
        float remaining=core.health;
        shoot(owner,Team.crux,core.x,core.y,core.maxHealth*10+1000);
        double before=endless.ticks;
        update(1);
        check(terminal,"the native update that destroys the last core ends the match");
        String pair=key("crux","unit","dagger","sharded","core",core.block.name);
        result.putAll(obj("ok",true,"core_remaining_health",remaining,"lethal_core_damage",row(evaluation.damage,pair),
            "ticks_before_lethal_update",before,"ticks_after",endless.ticks,"health_observation",evaluation.phased));
        return result;
    }

    Object combat() throws java.io.IOException {
        check(evaluation.phased,"health observed at the native phase boundaries");
        int x0=Vars.world.width()/2-12,y0=Vars.world.height()/2-12;
        clear(x0,y0,x0+24,y0+24);
        Building duo=place(Blocks.duo,x0+2,y0+2,Team.sharded);
        Unit actor=unit(UnitTypes.dagger,Team.crux,(x0+20)*8,(y0+20)*8);
        Scripted script=(Scripted)actor.controller();
        var result=new LinkedHashMap<String,Object>();
        update(1);

        Building w1=place(Blocks.titaniumWall,x0+6,y0+2,Team.crux);
        Unit d1=unit(UnitTypes.dagger,Team.crux,(x0+6)*8,(y0+8)*8);
        update(1);
        float wallLeft=w1.health,unitLeft=EvaluationTelemetry.effective(d1);
        shoot(duo,Team.sharded,w1.x,w1.y,wallLeft*10+1000);
        shoot(duo,Team.sharded,d1.x,d1.y,unitLeft*10+1000);
        update(1);
        check(w1.dead && d1.dead(),"both targets die to one bullet each");
        double wallHit=row(evaluation.damage,key("sharded","turret","duo","crux","building","titanium-wall"));
        double unitHit=row(evaluation.damage,key("sharded","turret","duo","crux","unit","dagger"));
        check(Math.abs(wallHit-wallLeft)<1e-3,"lethal building hit equals remaining health: "+wallHit+" vs "+wallLeft);
        check(Math.abs(unitHit-unitLeft)<1e-3,"lethal unit hit equals remaining health: "+unitHit+" vs "+unitLeft);
        result.putAll(obj("lethal_wall_remaining",wallLeft,"lethal_wall_damage",wallHit,"lethal_unit_remaining",unitLeft,"lethal_unit_damage",unitHit));

        Building w2=place(Blocks.copperWall,x0+10,y0+2,Team.crux);
        update(1);
        float silentLeft=w2.health;
        w2.damage(silentLeft+50);
        update(1);
        double silentLethal=row(evaluation.unattributed,key("crux","building","copper-wall"));
        check(w2.dead && Math.abs(silentLethal-silentLeft)<1e-3,"eventless lethal damage is unattributed: "+silentLethal+" vs "+silentLeft);
        result.putAll(obj("silent_lethal_remaining",silentLeft,"silent_lethal_unattributed",silentLethal));

        Building w3=place(Blocks.thoriumWall,x0+14,y0+2,Team.crux);
        update(1);
        float[] afterSilent={0};
        float start=w3.health;
        script.next=()->{w3.damage(20f);afterSilent[0]=w3.health;};
        shoot(duo,Team.sharded,w3.x,w3.y,10f);
        update(1);
        double hit3=row(evaluation.damage,key("sharded","turret","duo","crux","building","thorium-wall"));
        double silent3=row(evaluation.unattributed,key("crux","building","thorium-wall"));
        check(afterSilent[0]<start && w3.health<afterSilent[0],"the silent loss and the hit both happened in one update");
        check(Math.abs(hit3-(afterSilent[0]-w3.health))<1e-3,"the bullet is credited only its own loss: "+hit3+" vs "+(afterSilent[0]-w3.health));
        check(Math.abs(silent3-(start-afterSilent[0]))<1e-3,"the silent loss stays unattributed: "+silent3);
        result.putAll(obj("silent_then_bullet_hit",hit3,"silent_then_bullet_unattributed",silent3));

        Building w4=place(Blocks.copperWallLarge,x0+18,y0+2,Team.crux);
        w4.health=w4.maxHealth/2;
        update(1);
        double restoredBefore=evaluation.restored.getOrDefault("crux",0d);
        float[] afterHeal={0};
        float low=w4.health;
        script.next=()->{w4.heal(20f);afterHeal[0]=w4.health;};
        shoot(duo,Team.sharded,w4.x,w4.y,5f);
        update(1);
        double hit4=row(evaluation.damage,key("sharded","turret","duo","crux","building","copper-wall-large"));
        double healed=evaluation.restored.getOrDefault("crux",0d)-restoredBefore;
        check(afterHeal[0]>low && w4.health<afterHeal[0],"the heal and the hit both happened in one update");
        check(Math.abs(healed-(afterHeal[0]-low))<1e-3,"the heal is restored health: "+healed);
        check(hit4>0 && Math.abs(hit4-(afterHeal[0]-w4.health))<1e-3,"the bullet's actual loss is recorded: "+hit4+" vs "+(afterHeal[0]-w4.health));
        result.putAll(obj("heal_then_bullet_hit",hit4,"heal_then_bullet_restored",healed,"ok",true));
        evaluation.save(true);
        return result;
    }
}
