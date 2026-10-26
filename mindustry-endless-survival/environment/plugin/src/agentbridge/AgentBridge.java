// SPDX-License-Identifier: GPL-3.0-only

package agentbridge;

import arc.Core;
import arc.Events;
import arc.files.Fi;
import arc.math.Mathf;
import arc.math.geom.Vec2;
import arc.util.Log;
import arc.util.Time;
import arc.util.serialization.JsonReader;
import arc.util.serialization.JsonValue;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import mindustry.Vars;
import mindustry.core.GameState.State;
import mindustry.content.Blocks;
import mindustry.game.Rules;
import arc.struct.StringMap;
import mindustry.game.EventType.*;
import mindustry.game.Gamemode;
import mindustry.game.Team;
import mindustry.gen.*;
import mindustry.io.SaveIO;
import mindustry.mod.Plugin;
import mindustry.net.Administration.Config;
import mindustry.net.NetConnection;
import mindustry.server.ServerControl;
import mindustry.world.*;
import java.io.*;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.*;

public class AgentBridge extends Plugin {
    final LinkedHashMap<String, Seat> seats = new LinkedHashMap<>();
    final Records records = new Records(this);
    final MatchLog log = new MatchLog(this);
    final Inputs inputs = new Inputs(this);
    final ProductionTelemetry production = new ProductionTelemetry(this);
    final EvaluationTelemetry evaluation = new EvaluationTelemetry(this);
    EndlessSurvival endless;
    ReplayRecorder replay;
    boolean configured, started, terminal, allChat;
    String mode = "survival", reason = "not_started", winner = null;
    double elapsed, saveInterval, nextSave;
    long sequence, lastSnapshot, startNanos;
    int wavesCompleted, teamCount, teamSize;
    int[] teamSizes;

    final LinkedHashMap<String, LinkedHashMap<Integer, Float>> coreMaximums = new LinkedHashMap<>();
    Path evidence;
    HttpServer http;
    static class BotConnection extends NetConnection {
        BotConnection(Player p,String id){super("127.0.0.1");player=p;uuid="agent-bridge-"+id;usid=uuid;hasConnected=true;hasBegunConnecting=true;}
        @Override public void send(Object object,boolean reliable){}
        @Override public void close(){hasDisconnected=true;}
        @Override public boolean isConnected(){return !hasDisconnected;}
    }
    static class Seat {
        final Player player;
        Float moveX, moveY;
        float moveDx, moveDy;
        final Vec2 movement = new Vec2();
        Seat(Player p){player=p;}
        void release(){
            moveX=moveY=null; moveDx=moveDy=0;
            player.shooting=player.boosting=false;
            if(!player.dead()){player.unit().mineTile(null);player.unit().vel.setZero();}
        }
    }
    @Override public void init(){
        replay=ReplayRecorder.start(this);
        try {
            evidence = Paths.get(System.getenv().getOrDefault("MINDUSTRY_EVIDENCE_DIR", "/tmp/mindustry-evidence"));
            Files.createDirectories(evidence);
            http = HttpServer.create(new InetSocketAddress("127.0.0.1", 8091), 32);
            http.createContext("/", this::request);
            http.setExecutor(Executors.newFixedThreadPool(8)); http.start();
        } catch(Exception e){throw new RuntimeException(e);}
        Events.on(ServerLoadEvent.class, event -> {
            Config.autoPause.set(false); Config.autosave.set(false);
            Config.antiSpam.set(false);
            ServerControl.instance.gameOverListener = event2 -> {

                boolean lost=Vars.state.rules.defaultTeam.cores().isEmpty();
                if(lost && started && !terminal) endless.death(event2.winner.name);
                finish(lost ? "core_destroyed" : "unexpected_game_over", event2.winner.name);
            };
        });
        Events.on(PlayerConnect.class, event -> {
            if(event.player.name.startsWith("__view_")){
                Unit old=event.player.unit(); event.player.clearUnit();
                if(old!=null && old.spawnedByCore) old.remove();
                event.player.team(Team.derelict);
            }
        });
        log.listen();
        production.install();
        evaluation.install();
        Events.run(Trigger.beforeGameUpdate, () -> {if(endless!=null) endless.beforeUpdate();});
        Events.run(Trigger.beforeGameUpdate, this::controls);
        Events.run(Trigger.afterGameUpdate, () -> {
            if(endless!=null) endless.afterUpdate();
            if(!started || terminal) return;
            production.afterUpdate();
            evaluation.afterUpdate();
            trackCoreCapacities();
            elapsed=(System.nanoTime()-startNanos)/1_000_000_000d;
            if(!Vars.spawner.isSpawning() && Groups.unit.count(u->u.team==Vars.state.rules.waveTeam && u.isEnemy())==0) wavesCompleted=Math.max(wavesCompleted,Vars.state.wave-1);
            if(Vars.state.gameOver) finish("game_over", null);
            if(!terminal && saveInterval>0 && elapsed>=nextSave) periodicSave();
            if(System.currentTimeMillis()-lastSnapshot>1000){lastSnapshot=System.currentTimeMillis(); snapshot();}
        });
        Log.info("Agent bridge for Mindustry @ listening on loopback :8091", mindustry.core.Version.buildString());
    }
    void controls(){
        if(!started || terminal) return;
        for(Seat s:seats.values()){
            Player p=s.player;

            if(p.pingTime>0f)p.pingTime-=Time.delta/Player.pingDuration;
            if(p.dead()){s.release();continue;}
            Unit u=p.unit();
            if(s.moveX!=null){
                Vec2 delta=s.movement.set(s.moveX-u.x,s.moveY-u.y);
                if(delta.len()<2f){s.moveX=s.moveY=null;u.vel.setZero();}
                else u.movePref(delta.limit(Math.min(u.speed(),delta.len()/Math.max(Time.delta,0.01f))));
            }else{
                u.movePref(s.movement.set(s.moveDx,s.moveDy).scl(u.speed()));
            }

            u.move(u.vel.x*Time.delta,u.vel.y*Time.delta);

            boolean boosted=u instanceof Mechc && u.isFlying();
            boolean aimCursor=u.type.omniMovement && p.shooting && u.type.hasWeapons() && u.type.faceTarget && !boosted;
            u.lookAt(aimCursor?u.angleTo(p.mouseX,p.mouseY):u.prefRotation());
            u.snapInterpolation();
            u.aim(p.mouseX,p.mouseY,true); u.controlWeapons(true,p.shooting&&!boosted);
        }
    }
    void request(HttpExchange ex) throws IOException {
        LinkedHashMap<String,Object> response; int status=200;
        Object[] seatStatus={null};
        try {
            require(ex.getRequestMethod().equals("POST"),"POST required");
            byte[] body=ex.getRequestBody().readAllBytes();
            require(body.length>0,"JSON body required");
            JsonValue data;
            try{data=new JsonReader().parse(new String(body,StandardCharsets.UTF_8));}
            catch(RuntimeException error){throw new IllegalArgumentException("Malformed JSON body",error);}
            String path=ex.getRequestURI().getPath();
            CompletableFuture<Object> task=new CompletableFuture<>();
            Core.app.post(() -> {
                Object result=null;Throwable error=null;
                try{result=route(path,data);}catch(Throwable e){error=e;}

                try{String seat=statusSeat(path,data);if(seat!=null)seatStatus[0]=log.status(seat);}catch(Throwable e){if(error==null)error=e;}
                if(error!=null)task.completeExceptionally(error);else task.complete(result);
            });
            response=obj("ok",true,"result",task.get(path.equals("/finalize-replay")?115:25,TimeUnit.SECONDS));
        } catch(Exception e){
            Throwable cause=e instanceof ExecutionException?e.getCause():e;

            if(cause instanceof IllegalArgumentException||cause instanceof Refused||cause instanceof mindustry.net.ValidateException)
                response=obj("ok",false,"error",cause.getMessage(),"invalid",cause instanceof IllegalArgumentException);
            else{status=500;Log.err(cause);response=obj("ok",false,"error",cause.getClass().getSimpleName()+": "+cause.getMessage());}
        }
        if(seatStatus[0]!=null)response.put("status",seatStatus[0]);
        byte[] output=json(response).getBytes(StandardCharsets.UTF_8);
        ex.getResponseHeaders().set("Content-Type","application/json");
        ex.sendResponseHeaders(status,output.length); ex.getResponseBody().write(output); ex.close();
    }
    Object route(String path,JsonValue a) throws Exception {
        require(a!=null && a.isObject(),"Request must be an object");
        return switch(path){
            case "/health" -> {Records.only(a);yield obj("ready",true,"configured",configured,"version",mindustry.core.Version.buildString());}
            case "/setup" -> setup(a);
            case "/start" -> {
                if(endless!=null)Records.only(a,"ready_seats");else Records.only(a);
                require(configured,"Session is not configured");require(!terminal,"Session is terminal");
                if(endless!=null)endless.requireReady(a);
                if(!started){started=true;startNanos=System.nanoTime();nextSave=saveInterval;reason="running";Vars.state.set(State.playing);event("start",obj());if(endless!=null)endless.start();}
                LinkedHashMap<String,Object> result=state();
                if(endless!=null)result.put("survival_start",endless.start);
                yield result;
            }
            case "/stop" -> {Records.only(a);if(configured)finish("stopped",null);yield state();}
            case "/finalize-replay" -> {
                Records.only(a);require(terminal,"The game is not terminal");
                if(replay!=null){replay.close();if(!replay.closed||replay.failure!=null)throw new IllegalStateException("Replay incomplete: "+replay.failure);}
                yield obj("closed",true);
            }
            case "/state" -> {Records.only(a);yield state();}
            case "/status" -> {Records.only(a,"seat");yield log.status(seat(a));}
            case "/query" -> records.query(seat(a),a);
            case "/events" -> log.events(seat(a),a);
            case "/act" -> inputs.act(seat(a),a);
            case "/say" -> log.say(seat(a),a);
            case "/wake" -> log.wake(seat(a),a);
            default -> throw new IllegalArgumentException("Unknown endpoint "+path);
        };
    }

    String statusSeat(String path,JsonValue a){
        if(!configured||path.equals("/status")||a==null||!a.isObject()||!a.has("seat")||!a.get("seat").isString())return null;
        String seat=a.getString("seat");return seats.containsKey(seat)?seat:null;
    }
    String seat(JsonValue a){
        Records.field(a,"seat","string",true);
        String id=a.getString("seat");require(seats.containsKey(id),"Unknown seat "+id);return id;
    }
    double time(){return started&&!terminal?(System.nanoTime()-startNanos)/1_000_000_000d:elapsed;}
    Object setup(JsonValue a){

        Records.only(a,"seats","game_mode","team_sizes","time_limit_sec","seed","map","all_chat","video","save_interval_sec","endless_survival");
        require(!configured,"Session already configured");
        endless=null;
        require(a.has("endless_survival"),"endless_survival profile is required");
        EndlessSurvival profile=new EndlessSurvival(this,a.get("endless_survival"));
        Records.field(a,"all_chat","boolean",false);
        Records.field(a,"video","object",false);
        Records.field(a,"save_interval_sec","int",false);
        saveInterval=a.getInt("save_interval_sec",0);
        require(saveInterval>=0,"save_interval_sec must be 0 or more");
        allChat=a.getBoolean("all_chat",false);
        JsonValue names=a.get("seats"); require(names!=null,"Explicit seats roster is required");
        require(names.isArray() && names.size>=1 && names.size<=20,"One through 20 seats required");
        HashSet<String> requestedSeats=new HashSet<>();
        for(JsonValue name:names){
            require(name.isString(),"Seat names must be strings");
            require(requestedSeats.add(name.asString()),"Duplicate seat");
        }
        for(int i=1;i<=names.size;i++) require(requestedSeats.contains("seat-"+i),"Seats must be exactly seat-1 through seat-"+names.size);
        mode=a.getString("game_mode","survival");
        require(mode.equals("survival"),"endless_survival requires game_mode survival");
        require(a.has("time_limit_sec") && a.get("time_limit_sec").isNull(),"endless_survival requires time_limit_sec null");
        teamCount=1; teamSize=0; teamSizes=new int[]{names.size};
        if(a.has("team_sizes")){
            JsonValue sizes=a.get("team_sizes");
            require(sizes.isArray() && sizes.size==1 && sizes.get(0).isNumber() && sizes.get(0).asDouble()==names.size,"Roster must match one survival team");
        }
        long seed=a.getLong("seed",1); Mathf.rand.setSeed(seed);
        String requested=a.getString("map","Fork");
        require(requested.equalsIgnoreCase("Fork"),"Endless survival requires Fork");
        mindustry.maps.Map chosen=null;
        for(var map:Vars.maps.all()) if(map.file.nameWithoutExtension().equalsIgnoreCase("fork")) chosen=map;
        require(chosen!=null,"Fork map is missing");
        Vars.logic.reset(); Vars.world.loadMap(chosen,chosen.applyRules(Gamemode.survival));
        Vars.state.rules=chosen.applyRules(Gamemode.survival);
        Vars.state.rules.canGameOver=true;
        if(profile!=null){endless=profile;endless.apply(Vars.state.rules);endless.install();}
        require(!Vars.state.rules.fog,"Observation API currently supports maps without fog of war only");
        Events.fire(new RulesLoadEvent(Vars.state.rules)); Vars.logic.play();

        ArrayList<Team> teams=new ArrayList<>();
        for(Team t:Team.all) if(t!=Team.derelict && t.cores().size>0) teams.add(t);
        Team coop=Vars.state.rules.defaultTeam;
        require(coop.core()!=null,"Native map has no player core");
        require(!mode.equals("survival") || Vars.spawner.getSpawns().size>0,"Survival map needs wave spawns");
        for(int index=0;index<names.size;index++){
            String id="seat-"+(index+1);
            Player p=Player.create(); p.name=id; p.admin=false;p.con=new BotConnection(p,id);
            p.team(coop); p.color.set(p.team().color); p.add(); p.checkSpawn();
            seats.put(id,new Seat(p));log.addSeat(id);
        }

        Config.uuidChangeLimit.set(Math.max(Config.uuidChangeLimit.num(), names.size));

        int playerLimit=Vars.netServer.admins.getPlayerLimit();
        if(playerLimit>0)Vars.netServer.admins.setPlayerLimit(Math.max(playerLimit, names.size*2));
        if(endless!=null){try{endless.setup(chosen);}catch(Exception e){throw new IllegalStateException("Cannot record the endless survival scenario",e);}}
        Vars.netServer.openServer(); Vars.state.set(State.paused); configured=true;
        trackCoreCapacities();
        event("setup",obj("mode",mode,"map",chosen.plainName(),"seed",seed,"team_count",teamCount,"team_size",teamSize==0?null:teamSize,"team_sizes",teamSizes==null?null:java.util.Arrays.stream(teamSizes).boxed().toList(),"limit",null));
        try{evaluation.writeCatalog();}catch(Exception e){Log.err(e);}
        snapshot();
        return state();
    }
    void finish(String why,String won){
        if(terminal)return; elapsed=started?(System.nanoTime()-startNanos)/1_000_000_000d:0;terminal=true;reason=why;winner=won;
        if(endless!=null)endless.finish(reason,winner);
        Vars.state.set(State.paused);ServerControl.instance.cancelPlayTask();event("terminal",obj("reason",reason,"winner",winner));snapshot();
        try{SaveIO.write(new Fi(evidence.resolve("final.msav").toFile()));}catch(Throwable e){Log.err(e);}
    }
    void periodicSave(){
        nextSave=(Math.floor(elapsed/saveInterval)+1)*saveInterval;
        try{Path saves=Files.createDirectories(evidence.resolve("saves"));SaveIO.write(new Fi(saves.resolve((long)elapsed+".msav").toFile()));}catch(Throwable e){Log.err(e);}
    }
    LinkedHashMap<String,Object> state(){
        ArrayList<Object> cores=new ArrayList<>();
        LinkedHashMap<String,Object> teams=new LinkedHashMap<>();
        for(var entry:seats.entrySet())teams.put(entry.getKey(),entry.getValue().player.team().name);
        if(configured)for(Team team:Team.all)for(var c:team.cores())
            cores.add(obj("id",c.id,"team",team.name,"x",c.tileX(),"y",c.tileY(),"health",c.health,"max_health",c.maxHealth));
        LinkedHashMap<String,Object> state=obj("configured",configured,"started",started,"completed",terminal,"terminal",terminal?terminalState():null,
            "reason",reason,"game_mode",mode,"map",configured?Vars.state.map.plainName():null,
            "width",Vars.world.width(),"height",Vars.world.height(),"team_count",teamCount,"team_size",teamSize==0?null:teamSize,"team_sizes",teamSizes==null?null:java.util.Arrays.stream(teamSizes).boxed().toList(),
            "elapsed_seconds",time(),"time_limit_sec",null,
            "end_condition","core_destroyed",
            "survival_censored",terminal&&!reason.equals("core_destroyed"),"wave",Vars.state.wave,
            "waves_completed",wavesCompleted,"winning_team",winner,"seat_teams",teams,"cores",cores,"production_telemetry",production.coverage());
        if(endless!=null)state.put("survival",endless.live());
        return state;
    }
    void trackCoreCapacities(){
        for(Team team:Team.all) for(var core:team.cores()){
            coreMaximums.computeIfAbsent(team.name,k->new LinkedHashMap<>()).merge(core.pos(),core.maxHealth,Math::max);
        }
    }
    Object coreHealth(){
        trackCoreCapacities();
        LinkedHashMap<String,Double> remaining=new LinkedHashMap<>();
        for(Team team:Team.all) for(var core:team.cores()){
            remaining.merge(team.name,(double)Math.max(0,Math.min(core.health,core.maxHealth)),Double::sum);
        }
        LinkedHashMap<String,Object> totals=new LinkedHashMap<>();
        for(var entry:coreMaximums.entrySet()){
            double capacity=entry.getValue().values().stream().mapToDouble(Float::doubleValue).sum();
            totals.put(entry.getKey(),obj("health",remaining.getOrDefault(entry.getKey(),0d),"max_health",capacity));
        }
        return totals;
    }
    Object terminalState(){return endless==null?null:endless.terminal;}
    void snapshot(){
        try{production.save(terminal);}catch(Exception e){Log.err(e);}
        try{evaluation.save(terminal);evaluation.saveStockpiles(terminal);}catch(Exception e){Log.err(e);}
        try{String snapshot=json(state());Files.writeString(evidence.resolve("state.json"),snapshot);Files.writeString(evidence.resolve("snapshots.jsonl"),snapshot+"\n",StandardOpenOption.CREATE,StandardOpenOption.APPEND);}catch(Exception e){Log.err(e);}}
    void event(String name,Object data){try{Files.writeString(evidence.resolve("events.jsonl"),json(obj("sequence",++sequence,"event",name,"elapsed_sec",elapsed,"data",data))+"\n",StandardOpenOption.CREATE,StandardOpenOption.APPEND);}catch(Exception e){Log.err(e);}}

    static final class Refused extends RuntimeException{Refused(String message){super(message);}}
    static void require(boolean test,String error){if(!test)throw new IllegalArgumentException(error);}

    static String list(Collection<?> values){StringJoiner out=new StringJoiner(", ");for(Object value:values)out.add(String.valueOf(value));return out.toString();}
    static LinkedHashMap<String,Object> obj(Object... pairs){LinkedHashMap<String,Object> m=new LinkedHashMap<>();for(int i=0;i<pairs.length;i+=2)m.put((String)pairs[i],pairs[i+1]);return m;}
    static String json(Object v){if(v==null)return "null";if(v instanceof Number n)return Double.isFinite(n.doubleValue())?n.toString():"null";if(v instanceof Boolean)return v.toString();if(v instanceof Map<?,?> m){ArrayList<String> p=new ArrayList<>();for(var e:m.entrySet())p.add(json(e.getKey().toString())+":"+json(e.getValue()));return "{"+String.join(",",p)+"}";}if(v instanceof Iterable<?> a){ArrayList<String> p=new ArrayList<>();for(Object x:a)p.add(json(x));return "["+String.join(",",p)+"]";}String s=v.toString();StringBuilder b=new StringBuilder("\"");for(char c:s.toCharArray()){switch(c){case '"'->b.append("\\\"");case '\\'->b.append("\\\\");case '\n'->b.append("\\n");case '\r'->b.append("\\r");case '\t'->b.append("\\t");default->{if(c<32)b.append(String.format("\\u%04x",(int)c));else b.append(c);}}}return b.append('"').toString();}
}
