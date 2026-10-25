// SPDX-License-Identifier: GPL-3.0-only

package harbor;

import arc.Core;
import arc.Events;
import arc.math.Mathf;
import arc.util.Time;
import arc.util.serialization.JsonValue;
import mindustry.Vars;
import mindustry.ai.WaveSpawner;
import mindustry.game.EventType.*;
import mindustry.game.Rules;
import mindustry.game.SpawnGroup;
import mindustry.game.Team;
import mindustry.gen.Groups;
import mindustry.io.JsonIO;
import mindustry.world.Tile;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.security.MessageDigest;
import java.util.*;
import static harbor.HarborBridge.*;

final class EndlessSurvival {
    static final String SCHEMA="mindustry-endless-survival-native/1";
    static final List<String> KEYS=List.of("first_wave_ticks","wave_spacing_ticks","spawn_seed","enemy_unit_health_multiplier","enemy_unit_damage_multiplier");
    static final int TICKS_PER_SECOND=60, PREVIEW_WAVES=100;
    static final double MIN_TICKS=60, MAX_TICKS=60d*86400;
    final HarborBridge bridge;
    final double firstWave, spacing, healthMultiplier, damageMultiplier;
    final long spawnSeed;
    final LinkedHashMap<String,Object> profile;

    double ticks, cappedTicks;
    long updates, cappedUpdates, recordSequence, recordFailures;
    int wavesSpawned;
    String friendly, enemy;
    LinkedHashMap<String,Object> provenance, start, terminal;
    TreeMap<String,Integer> spawning;
    ArrayList<mindustry.gen.Unit> spawningUnits;
    final TreeMap<String,Long> cumulativeSpawned=new TreeMap<>();

    final ArrayList<mindustry.gen.Unit> scheduled=new ArrayList<>();

    ArrayList<mindustry.gen.Unit> arriving;
    double waveStrength,clearanceTicks,clearanceObservedTicks,firstWaveTick=-1;

    EndlessSurvival(HarborBridge bridge,JsonValue v){
        this.bridge=bridge;
        require(v.isObject(),"endless_survival must be an object");
        Records.only(v,KEYS.toArray(String[]::new));
        for(String key:KEYS)require(v.has(key)&&v.get(key).isNumber(),"endless_survival."+key+" must be a number");
        firstWave=ticks(v,"first_wave_ticks");spacing=ticks(v,"wave_spacing_ticks");
        double seed=v.getDouble("spawn_seed");
        require(seed==Math.rint(seed)&&seed>=0&&seed<=Integer.MAX_VALUE,"endless_survival.spawn_seed must be an integer 0..2147483647");
        spawnSeed=(long)seed;
        healthMultiplier=multiplier(v,"enemy_unit_health_multiplier");damageMultiplier=multiplier(v,"enemy_unit_damage_multiplier");
        profile=obj("first_wave_ticks",firstWave,"wave_spacing_ticks",spacing,"spawn_seed",spawnSeed,
            "enemy_unit_health_multiplier",healthMultiplier,"enemy_unit_damage_multiplier",damageMultiplier);
    }
    static double ticks(JsonValue v,String key){
        double x=v.getDouble(key);
        require(Double.isFinite(x)&&x>=MIN_TICKS&&x<=MAX_TICKS,"endless_survival."+key+" must be 60..5184000 ticks");
        return x;
    }
    static double multiplier(JsonValue v,String key){
        double x=v.getDouble(key);
        require(Double.isFinite(x)&&x>0&&x<=100,"endless_survival."+key+" must be above 0 and at most 100");
        return x;
    }

    void apply(Rules rules){
        rules.waves=true;rules.waveTimer=true;rules.waitEnemies=false;rules.waveSending=false;
        rules.winWave=0;rules.attackMode=false;rules.pvp=false;rules.canGameOver=true;
        rules.waveSpacing=(float)spacing;rules.initialWaveSpacing=(float)firstWave;

        rules.weather.clear();
        rules.spawns.clear();
        Rules.TeamRule team=rules.teams.get(rules.waveTeam);
        team.unitHealthMultiplier=(float)healthMultiplier;team.unitDamageMultiplier=(float)damageMultiplier;
    }

    final class Spawner extends WaveSpawner {
        long gameSeed0,gameSeed1,waveSeed0,waveSeed1;
        @Override public void spawnEnemies(){

            if(bridge.endless!=EndlessSurvival.this){super.spawnEnemies();return;}
            int wave=Vars.state.wave;
            int before=Groups.unit.count(u->u.team==Vars.state.rules.waveTeam&&u.isEnemy());
            gameSeed0=Mathf.rand.seed0;gameSeed1=Mathf.rand.seed1;
            Mathf.rand.setSeed(waveSeed(spawnSeed,wave));
            spawning=new TreeMap<>();
            spawningUnits=new ArrayList<>();
            Vars.state.rules.spawns=ProgressiveWaves.groups(wave,getSpawns());
            try{super.spawnEnemies();}
            finally{Mathf.rand.seed0=gameSeed0;Mathf.rand.seed1=gameSeed1;}
            TreeMap<String,Integer> spawned=spawning;spawning=null;
            var units=spawningUnits;spawningUnits=null;
            wave(wave,before,spawned,units);
        }
        void onGameStream(Runnable run){
            waveSeed0=Mathf.rand.seed0;waveSeed1=Mathf.rand.seed1;
            Mathf.rand.seed0=gameSeed0;Mathf.rand.seed1=gameSeed1;
            try{run.run();}
            finally{gameSeed0=Mathf.rand.seed0;gameSeed1=Mathf.rand.seed1;Mathf.rand.seed0=waveSeed0;Mathf.rand.seed1=waveSeed1;}
        }
        @Override public void doShockwave(float x,float y){onGameStream(()->super.doShockwave(x,y));}
        @Override public void spawnUnit(SpawnGroup group,float x,float y){onGameStream(()->super.spawnUnit(group,x,y));}
    }
    static long waveSeed(long seed,int wave){
        long z=seed*0x9E3779B97F4A7C15L+wave+0x632BE59BD9B4E019L;
        z=(z^(z>>>30))*0xBF58476D1CE4E5B9L;z=(z^(z>>>27))*0x94D049BB133111EBL;
        return z^(z>>>31);
    }

    void install(){
        Vars.spawner=new Spawner();
        Vars.spawner.reset();
        for(var weather:Groups.weather.copy(new arc.struct.Seq<>()))weather.remove();
        Events.on(UnitSpawnEvent.class,e->{if(spawning!=null){spawning.merge(e.unit.type.name,1,Integer::sum);spawningUnits.add(e.unit);}});

        Events.on(WaveEvent.class,e->{if(bridge.endless==this&&bridge.started)Vars.state.wavetime=(float)Math.max(0,scheduled(Vars.state.wave)-now());});
    }
    double scheduled(int wave){return firstWave+(wave-1)*spacing;}

    double now(){return inUpdate?ticks+Time.delta:ticks;}
    boolean inUpdate;
    void beforeUpdate(){
        inUpdate=bridge.started&&!bridge.terminal;

        if(inUpdate)arrived();
        if(inUpdate&&firstWaveTick>=0){clearanceTicks+=clearance()*Time.delta;clearanceObservedTicks+=Time.delta;}

        if(inUpdate)Vars.state.wavetime=(float)Math.max(0,scheduled(Vars.state.wave)-ticks);
    }
    void afterUpdate(){
        if(!inUpdate)return;
        inUpdate=false;
        float raw=Core.graphics.getDeltaTime()*60f;
        ticks+=Time.delta;updates++;
        if(Float.isFinite(raw)&&raw>Time.delta+1e-4f){cappedUpdates++;cappedTicks+=raw-Time.delta;}
    }

    LinkedHashMap<String,Object> live(){
        LinkedHashMap<String,Object> data=clock();
        data.putAll(obj("profile",profile,"wave",Vars.state.wave,"next_wave_simulation_tick",scheduled(Vars.state.wave),"waves_spawned",wavesSpawned,"provenance",provenance));
        return data;
    }

    static double strength(mindustry.gen.Unit u){
        return (Math.max(0d,u.health)+Math.max(0d,u.shield))*Vars.state.rules.unitHealth(u.team)*ProgressiveWaves.armorFactor(u.armor);
    }
    double aliveStrength(){
        scheduled.removeIf(u->!u.isValid());
        double alive=0;for(var u:scheduled)alive+=strength(u);
        return alive;
    }

    double clearance(){
        double alive=aliveStrength();
        return waveStrength>0?Math.max(0,1-alive/waveStrength):alive>0?0:1;
    }
    void arrived(){
        if(arriving==null)return;
        waveStrength=0;for(var u:arriving)if(u.isValid())waveStrength+=strength(u);
        arriving=null;
    }

    LinkedHashMap<String,Object> clearanceRecord(){
        return obj("policy","realized_clearance/1","first_wave_simulation_tick",firstWaveTick<0?null:firstWaveTick,
            "wave_strength",firstWaveTick<0?null:waveStrength,"integral_ticks",clearanceTicks,"observed_ticks",clearanceObservedTicks,
            "mean",clearanceObservedTicks>0?clearanceTicks/clearanceObservedTicks:null);
    }

    LinkedHashMap<String,Object> terminalClearance(){arrived();return clearanceRecord();}
    LinkedHashMap<String,Object> clock(){
        return obj("simulation_tick",now(),"ticks_per_second",TICKS_PER_SECOND,"simulation_updates",inUpdate?updates+1:updates,"wall_elapsed_seconds",bridge.time());
    }

    void setup(mindustry.maps.Map map) throws Exception{
        friendly=Vars.state.rules.defaultTeam.name;enemy=Vars.state.rules.waveTeam.name;
        byte[] mapBytes=map.file.readBytes();
        byte[] rules=JsonIO.write(Vars.state.rules).getBytes(StandardCharsets.UTF_8);
        byte[] schedule=json(schedule(map)).getBytes(StandardCharsets.UTF_8);
        Files.write(bridge.evidence.resolve("rules.json"),rules);
        Files.write(bridge.evidence.resolve("wave-schedule.json"),schedule);
        provenance=obj("map_sha256",sha256(mapBytes),"rules_sha256",sha256(rules),"wave_schedule_sha256",sha256(schedule),
            "profile_sha256",sha256(json(profile).getBytes(StandardCharsets.UTF_8)));
        record("survival_setup",obj("profile",profile,"map",map.plainName(),"friendly_team",friendly,"wave_team",enemy,
            "seats",new ArrayList<>(bridge.seats.keySet()),"seat_teams",seatTeams(),"first_wave_simulation_tick",scheduled(1),
            "wave_spacing_ticks",spacing,"provenance",provenance));
    }
    LinkedHashMap<String,Object> schedule(mindustry.maps.Map map){
        Rules rules=Vars.state.rules;
        var groups=new ArrayList<Object>();
        for(SpawnGroup g:rules.spawns)groups.add(obj("type",g.type==null?null:g.type.name,"begin",g.begin,"end",g.end,"spacing",g.spacing,
            "max",g.max,"unit_scaling",(double)g.unitScaling,"unit_amount",g.unitAmount,"shields",(double)g.shields,"shield_scaling",(double)g.shieldScaling,
            "spawn",g.spawn,"effect",g.effect==null?null:g.effect.name,"items",g.items==null?null:obj("item",g.items.item.name,"amount",g.items.amount),
            "payloads",g.payloads==null?List.of():g.payloads.map(p->p.name).list(),"team",g.team==null?null:g.team.name));
        var spawns=new ArrayList<Object>();
        for(Tile t:Vars.spawner.getSpawns())spawns.add(List.of((int)t.x,(int)t.y));
        var preview=new ArrayList<Object>();
        for(int wave=1;wave<=PREVIEW_WAVES;wave++){
            var c=ProgressiveWaves.composition(wave);
            preview.add(obj("wave",wave,"scheduled_simulation_tick",scheduled(wave),"budget",c.budget(),"units",ProgressiveWaves.counts(c),
                "shield",c.shield(),"strength",c.strength(ProgressiveWaves.kinds())));
        }
        Rules.TeamRule team=rules.teams.get(rules.waveTeam);
        var result=obj("schema","mindustry-endless-survival-wave-schedule/1","profile",profile,"map",map.plainName(),
            "friendly_team",friendly,"wave_team",enemy,"drop_zone_radius",(double)rules.dropZoneRadius,"waves_spawn_at_cores",rules.wavesSpawnAtCores,
            "ground_spawns",spawns,"flyer_spawns",Vars.spawner.countFlyerSpawns(),
            "enemy_team_rule",obj("unit_health_multiplier",(double)team.unitHealthMultiplier,"unit_damage_multiplier",(double)team.unitDamageMultiplier,
                "cheat",team.cheat,"infinite_resources",team.infiniteResources),
            "spawn_groups",groups,"preview_waves",preview);
        result.put("progression",ProgressiveWaves.budgetSpecification());
        return result;
    }

    void requireReady(JsonValue a){
        Records.field(a,"ready_seats","array",true);
        var ready=new LinkedHashSet<String>();
        for(JsonValue seat:a.get("ready_seats")){require(seat.isString(),"ready_seats must be seat IDs");require(ready.add(seat.asString()),"Duplicate ready seat");}
        require(ready.equals(bridge.seats.keySet()),"ready_seats must be exactly the configured seats");
    }

    void start(){
        ticks=cappedTicks=0;updates=cappedUpdates=0;
        scheduled.clear();arriving=null;waveStrength=clearanceTicks=clearanceObservedTicks=0;firstWaveTick=-1;
        LinkedHashMap<String,Object> data=clock();
        data.putAll(obj("friendly_team",friendly,"wave_team",enemy,"ready_seats",new ArrayList<>(bridge.seats.keySet()),"seat_teams",seatTeams(),
            "core_health_by_team",cores(),"wave",Vars.state.wave,"next_wave_simulation_tick",scheduled(Vars.state.wave),"provenance",provenance));
        start=data;
        record("survival_start",data);
    }
    void wave(int wave,int before,TreeMap<String,Integer> spawned,List<mindustry.gen.Unit> units){
        if(!bridge.started||bridge.terminal)return;
        wavesSpawned++;
        LinkedHashMap<String,Object> data=obj("wave",wave);

        var clearance=clearanceRecord();
        scheduled.addAll(units);arriving=new ArrayList<>(units);
        if(firstWaveTick<0)firstWaveTick=now();
        data.putAll(clock());
        data.putAll(obj("scheduled_simulation_tick",scheduled(wave),"spawn_rng_seed",Long.toString(waveSeed(spawnSeed,wave)),
            "spawned",spawned,"enemies_alive_before",before,"core_health_by_team",cores(),"clearance",clearance));
        {
            spawned.forEach((type,count)->cumulativeSpawned.merge(type,count.longValue(),Long::sum));
            var observed=new TreeMap<String,Object>();

            for(var entry:spawned.entrySet()){
                var selected=units.stream().filter(u->u.type.name.equals(entry.getKey())).toList();
                observed.put(entry.getKey(),obj("count",selected.size(),
                    "shield_min",selected.stream().mapToDouble(u->u.shield).min().orElse(0),
                    "shield_max",selected.stream().mapToDouble(u->u.shield).max().orElse(0),
                    "shield_total",selected.stream().mapToDouble(u->u.shield).sum(),
                    "raw_health_total",selected.stream().mapToDouble(u->u.health).sum(),
                    "raw_max_health_total",selected.stream().mapToDouble(u->u.maxHealth).sum()));
            }
            Rules.TeamRule rule=Vars.state.rules.teams.get(Vars.state.rules.waveTeam);
            data.putAll(obj("spawned_units",observed,"cumulative_spawned",new TreeMap<>(cumulativeSpawned),
                "enemy_team_rule",obj("unit_health_multiplier",(double)rule.unitHealthMultiplier,
                    "unit_damage_multiplier",(double)rule.unitDamageMultiplier),
                "spawn_observation","after_native_group_shields_before_combat"));
        }
        {
            var plan=ProgressiveWaves.composition(wave);

            double realized=units.stream().mapToDouble(u->(u.health+u.shield)*ProgressiveWaves.armorFactor(u.armor)).sum();
            data.putAll(obj("budget",plan.budget(),"planned_units",ProgressiveWaves.counts(plan),"planned_shield",plan.shield(),
                "realized_strength",realized));
        }
        record("survival_wave",data);
    }

    void death(String winner){
        LinkedHashMap<String,Object> data=clock();
        data.putAll(obj("friendly_team",friendly,"winner",winner,"seat_teams",seatTeams(),"core_health_by_team",cores(),
            "wave",Vars.state.wave,"waves_spawned",wavesSpawned,"provenance",provenance));
        record("last_friendly_core_destroyed",data);
    }
    LinkedHashMap<String,Object> finish(String reason,String winner){
        LinkedHashMap<String,Object> data=obj("reason",reason,"survival_censored",!reason.equals("core_destroyed"));
        data.putAll(clock());
        data.put("elapsed_simulation_seconds",now()/TICKS_PER_SECOND);
        data.putAll(obj("winning_team",reason.equals("core_destroyed")?winner:null,"friendly_team",friendly,"seat_teams",seatTeams(),
            "core_health_by_team",cores(),"wave",Vars.state.wave,"waves_spawned",wavesSpawned,"provenance",provenance,
            "clock",obj("policy","accumulated_native_time_delta","ticks_per_second",TICKS_PER_SECOND,"server_delta_cap_ticks",(double)Vars.maxDeltaServer,
                "capped_updates",cappedUpdates,"capped_ticks_dropped",cappedTicks),
            "end_condition","core_destroyed","record_failures",recordFailures,"clearance",terminalClearance(),

            "elapsed_seconds",bridge.time(),"waves_completed",bridge.wavesCompleted));
        terminal=data;
        record("survival_terminal",data);
        return data;
    }

    LinkedHashMap<String,Object> seatTeams(){
        LinkedHashMap<String,Object> teams=new LinkedHashMap<>();
        for(var e:bridge.seats.entrySet())teams.put(e.getKey(),e.getValue().player.team().name);
        return teams;
    }

    LinkedHashMap<String,Object> cores(){
        bridge.trackCoreCapacities();
        LinkedHashMap<String,Object> out=new LinkedHashMap<>();
        for(var entry:bridge.coreMaximums.entrySet()){
            Team team=null;for(Team t:Team.all)if(t.name.equals(entry.getKey()))team=t;
            int count=0;double health=0;
            if(team!=null)for(var core:team.cores()){count++;health+=Math.max(0,Math.min(core.health,core.maxHealth));}
            out.put(entry.getKey(),obj("count",count,"health",health,"max_health",entry.getValue().values().stream().mapToDouble(Float::doubleValue).sum()));
        }
        return out;
    }
    void record(String name,Object data){
        try{Files.writeString(bridge.evidence.resolve("survival.jsonl"),json(obj("schema",SCHEMA,"sequence",++recordSequence,"event",name,"data",data))+"\n",
            StandardOpenOption.CREATE,StandardOpenOption.APPEND);}
        catch(Exception e){recordFailures++;arc.util.Log.err("Cannot record "+name,e);}
        bridge.event(name,data);
    }
    static String sha256(byte[] bytes){
        try{StringBuilder out=new StringBuilder();for(byte b:MessageDigest.getInstance("SHA-256").digest(bytes))out.append(String.format("%02x",b));return out.toString();}
        catch(Exception e){throw new IllegalStateException(e);}
    }
}
