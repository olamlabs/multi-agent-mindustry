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
    boolean configured, started, terminal, unlimited, allChat, arena;
    String mode = "pvp", reason = "not_started", winner = null;
    double elapsed, limit = 600, saveInterval, nextSave;
    long sequence, lastSnapshot, startNanos, seed;

    int game, wavesCompleted, teamCount, teamSize;

    mindustry.maps.Map chosen;
    Gamemode gm;
    int[] teamSizes;
    int teamIndex(int seatIndex){int end=0;for(int i=0;i<teamSizes.length;i++){end+=teamSizes[i];if(seatIndex<end)return i;}throw new IllegalArgumentException("Seat outside topology");}

    final LinkedHashMap<String, LinkedHashMap<Integer, Float>> coreMaximums = new LinkedHashMap<>();
    Object finalCoreHealth;
    Path evidence;
    HttpServer http;
    ReplayRecorder replay;
    static class BotConnection extends NetConnection {
        BotConnection(Player p,String id){super("127.0.0.1");player=p;uuid="agent-bridge-"+id;usid=uuid;hasConnected=true;hasBegunConnecting=true;}
        @Override public void send(Object object,boolean reliable){}
        @Override public void close(){hasDisconnected=true;}
        @Override public boolean isConnected(){return !hasDisconnected;}
    }
    static class Seat {
        final Player player;

        final Team team;
        Float moveX, moveY;
        float moveDx, moveDy;
        final Vec2 movement = new Vec2();
        Seat(Player p){player=p;team=p.team();}
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
            ServerControl.instance.gameOverListener = event2 -> finish(seats.values().stream().anyMatch(s -> s.player.team().cores().isEmpty()) ? "core_destroyed" : "game_over", event2.winner.name);
        });
        Events.on(PlayerConnect.class, event -> {
            if(event.player.name.startsWith("__view_")){
                Unit old=event.player.unit(); event.player.clearUnit();
                if(old!=null && old.spawnedByCore) old.remove();
                event.player.team(Team.derelict);
            }
        });
        log.listen();
        Events.run(Trigger.beforeGameUpdate, this::controls);
        Events.run(Trigger.afterGameUpdate, () -> {
            if(!started || terminal) return;
            trackCoreCapacities();
            elapsed=(System.nanoTime()-startNanos)/1_000_000_000d;
            if(!Vars.spawner.isSpawning() && Groups.unit.count(u->u.team==Vars.state.rules.waveTeam && u.isEnemy())==0) wavesCompleted=Math.max(wavesCompleted,Vars.state.wave-1);
            if(Vars.state.gameOver) finish("game_over", null);
            else if(!unlimited && elapsed>=limit) finish("time_limit", null);
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
            response=obj("ok",true,"result",task.get(java.util.Set.of("/setup","/reset","/finalize-replay").contains(path)?115:25,TimeUnit.SECONDS));
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
                Records.only(a);require(configured,"Session is not configured");require(!terminal,"Session is terminal");
                if(!started){started=true;startNanos=System.nanoTime();nextSave=saveInterval;reason="running";Vars.state.set(State.playing);event("start",obj());}
                yield state();
            }
            case "/stop" -> {Records.only(a);if(configured)finish("stopped",null);yield state();}
            case "/finalize-replay" -> {
                Records.only(a);require(terminal,"The game is not terminal");
                if(replay!=null){replay.close();if(!replay.closed||replay.failure!=null)throw new IllegalStateException("Replay incomplete: "+replay.failure);}
                yield obj("closed",true);
            }
            case "/reset" -> reset(a);
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

        Records.only(a,"seats","game_mode","team_count","team_size","team_sizes","time_limit_sec","seed","map","all_chat","video","save_interval_sec");
        require(!configured,"Session already configured");
        Records.field(a,"all_chat","boolean",false);
        Records.field(a,"video","object",false);
        Records.field(a,"save_interval_sec","int",false);
        saveInterval=a.getInt("save_interval_sec",0);
        require(saveInterval>=0,"save_interval_sec must be 0 or more");
        allChat=a.getBoolean("all_chat",false);
        JsonValue names=a.get("seats"); require(names!=null,"Explicit seats roster is required");
        require(names.isArray() && names.size>=2 && names.size<=200,"Two through 200 seats required");
        HashSet<String> requestedSeats=new HashSet<>();
        for(JsonValue name:names){
            require(name.isString(),"Seat names must be strings");
            require(requestedSeats.add(name.asString()),"Duplicate seat");
        }
        for(int i=1;i<=names.size;i++) require(requestedSeats.contains("seat-"+i),"Seats must be exactly seat-1 through seat-"+names.size);
        mode=a.getString("game_mode","pvp");
        require(mode.equals("pvp"),"Only PvP is supported");
        boolean explicitCount=a.has("team_count")&&!a.get("team_count").isNull(), explicitSize=a.has("team_size")&&!a.get("team_size").isNull();
        if(a.has("team_sizes")&&!a.get("team_sizes").isNull()){
            require(!explicitCount&&!explicitSize,"Use team_sizes or team_count/team_size, not both");
            JsonValue sizes=a.get("team_sizes");require(sizes.isArray()&&sizes.size>=1&&sizes.size<=6,"Invalid team_sizes");
            teamCount=sizes.size;teamSizes=new int[teamCount];int total=0,i=0;
            for(JsonValue size:sizes){require(size.isNumber()&&size.asDouble()==size.asInt()&&size.asInt()>=1&&size.asInt()<=100,"Invalid team size");teamSizes[i++]=size.asInt();total+=size.asInt();}
            require(total==names.size,"Roster must match sum of team_sizes");teamSize=0;
        }else{
        require(explicitCount==explicitSize,"team_count and team_size must both be present or both absent");
        if(explicitCount) require(a.get("team_count").isNumber()&&a.get("team_size").isNumber()&&a.getDouble("team_count")==a.getInt("team_count")&&a.getDouble("team_size")==a.getInt("team_size"),"Team count and size must be integers");
        teamCount=explicitCount?a.getInt("team_count"):2;
        teamSize=explicitSize?a.getInt("team_size"):names.size/teamCount;
        require(teamCount>=1&&teamCount<=6&&teamSize>=1&&teamSize<=100&&teamCount*teamSize==names.size,"Roster must match team_count × team_size (1..6 teams, 1..100 players each, at most 200 seats)");
            teamSizes=new int[teamCount];java.util.Arrays.fill(teamSizes,teamSize);
        }
        require(teamCount>=2,"PvP requires at least two player teams");
        gm=Gamemode.pvp;
        unlimited=a.has("time_limit_sec")&&a.get("time_limit_sec").isNull();
        if(!unlimited){limit=a.getDouble("time_limit_sec",600);require(Double.isFinite(limit)&&limit>=1&&limit<=86400,"time_limit_sec must be 1..86400 or null for PvP");}
        seed=a.getLong("seed",1);
        String requested=a.getString("map","");
        arena=requested.equalsIgnoreCase("Ring Arena")||(requested.isEmpty()&&teamCount>2);
        if(!arena){
            ArrayList<mindustry.maps.Map> candidates=new ArrayList<>();
            for(mindustry.maps.Map m:Vars.maps.all()) candidates.add(m);
            candidates.sort(Comparator.comparing(m -> m.plainName()));
            require(!candidates.isEmpty(),"No compatible native map");
            chosen=null;
            if(!requested.isEmpty()) for(var m:candidates) if(m.plainName().equalsIgnoreCase(requested)||m.file.nameWithoutExtension().equalsIgnoreCase(requested)) chosen=m;
            if(!requested.isEmpty()) require(chosen!=null,"Map does not exist or is incompatible with mode");
            if(chosen==null){
                String preferred="glacier";
                for(var m:candidates) if(m.file.nameWithoutExtension().equalsIgnoreCase(preferred)) chosen=m;
                if(chosen==null) chosen=candidates.get(0);
            }
        }
        ArrayList<Team> teams=loadWorld();
        for(int index=0;index<names.size;index++){
            String id="seat-"+(index+1);
            Player p=Player.create(); p.name=id; p.admin=false;p.con=new BotConnection(p,id);
            p.team(teams.get(teamIndex(index))); p.color.set(p.team().color); p.add(); p.checkSpawn();
            seats.put(id,new Seat(p));log.addSeat(id);
        }

        Config.uuidChangeLimit.set(Math.max(Config.uuidChangeLimit.num(), names.size));

        int playerLimit=Vars.netServer.admins.getPlayerLimit();
        if(playerLimit>0)Vars.netServer.admins.setPlayerLimit(Math.max(playerLimit, names.size*2));
        Vars.netServer.openServer(); Vars.state.set(State.paused); configured=true; game=1;
        trackCoreCapacities();
        event("setup",obj("mode",mode,"map",chosen.plainName(),"seed",seed,"team_count",teamCount,"team_size",teamSize==0?null:teamSize,"team_sizes",teamSizes==null?null:java.util.Arrays.stream(teamSizes).boxed().toList(),"limit",unlimited?null:limit)); snapshot();
        return state();
    }

    ArrayList<Team> loadWorld(){
        Mathf.rand.setSeed(seed);
        if(arena) chosen=loadArena(teamCount);
        else{
            Vars.logic.reset(); Vars.world.loadMap(chosen,chosen.applyRules(gm));
            Vars.state.rules=chosen.applyRules(gm);
        }
        Vars.state.rules.canGameOver=true;
        require(!Vars.state.rules.fog,"Observation API currently supports maps without fog of war only");
        Events.fire(new RulesLoadEvent(Vars.state.rules)); Vars.logic.play();

        ArrayList<Team> teams=new ArrayList<>();
        for(Team t:Team.all) if(t!=Team.derelict && t.cores().size>0) teams.add(t);
        require(Vars.state.rules.defaultTeam.core()!=null,"Native map has no player core");
        require(teams.size()>1,"PvP map needs enemy cores");
        require(teams.size()==teamCount,"Map core team count "+teams.size()+" differs from team_count "+teamCount);
        return teams;
    }

    Object reset(JsonValue a){
        Records.only(a);require(configured,"Session is not configured");require(terminal,"The game has not ended");
        ArrayList<Player> viewers=new ArrayList<>();
        for(Player p:Groups.player)if(!p.isLocal()&&p.con!=null&&!(p.con instanceof BotConnection)){viewers.add(p);p.clearUnit();}
        for(Seat s:seats.values()){s.release();s.player.clearUnit();}

        configured=false;
        Call.worldDataBegin();
        loadWorld();
        game++;started=false;terminal=false;reason="not_started";winner=null;elapsed=0;wavesCompleted=0;finalCoreHealth=null;
        coreMaximums.clear();
        log.reset();
        for(var entry:seats.entrySet()){
            Seat s=entry.getValue();Player p=s.player;
            require(s.team.core()!=null,entry.getKey()+"'s team "+s.team.name+" has no core on the reloaded map");
            p.reset();p.team(s.team);p.add();p.checkSpawn();
        }
        for(Player p:viewers){boolean admin=p.admin;p.reset();p.admin=admin;p.team(Team.derelict);Vars.netServer.sendWorldAndAssets(p);}
        Vars.state.set(State.paused);configured=true;
        trackCoreCapacities();
        event("reset",obj("game",game));snapshot();
        return state();
    }

    mindustry.maps.Map loadArena(int count){
        final int size=320, center=size/2, radius=110;
        mindustry.maps.Map map=new mindustry.maps.Map(StringMap.of("name","Ring Arena","author","Olam Labs","description","Equal-stock open PvP arena for 2–6 teams"));
        map.width=map.height=size;
        Vars.logic.reset();
        Vars.state.map=map;
        Vars.state.rules=Gamemode.pvp.apply(new Rules());
        Vars.world.loadGenerator(size,size,tiles->{
            tiles.fill();
            for(Tile tile:tiles){
                tile.setFloor(Blocks.stone.asFloor());
                if(tile.x<2||tile.y<2||tile.x>=size-2||tile.y>=size-2)tile.setBlock(Blocks.stoneWall);
            }
            for(int i=0;i<count;i++){
                double angle=2*Math.PI*i/count;
                int x=center+(int)Math.round(radius*Math.cos(angle)),y=center+(int)Math.round(radius*Math.sin(angle));

                Block[] ores={Blocks.oreCopper,Blocks.oreLead,Blocks.oreCoal,Blocks.oreTitanium,Blocks.oreThorium};
                for(int patch=0;patch<ores.length;patch++){
                    int px=x-20+patch*10,py=y+15;
                    for(int dx=-2;dx<=2;dx++)for(int dy=-2;dy<=2;dy++)tiles.getn(px+dx,py+dy).setOverlay(ores[patch]);
                }
                for(int dx=-4;dx<=4;dx++)for(int dy=-2;dy<=2;dy++){
                    tiles.getn(x+dx,y-15+dy).setFloor(Blocks.sand.asFloor());
                    tiles.getn(x+dx,y-23+dy).setFloor(Blocks.water.asFloor());
                }
                tiles.getn(x,y).setBlock(Blocks.coreNucleus,Team.get(i+1),0);
            }
        });
        return map;
    }
    void finish(String why,String won){
        if(terminal)return; elapsed=started?(System.nanoTime()-startNanos)/1_000_000_000d:0;terminal=true;reason=why;winner=won;
        finalCoreHealth=coreHealth();
        Vars.state.set(State.paused);ServerControl.instance.cancelPlayTask();event("terminal",obj("reason",reason,"winner",winner));snapshot();
        try{SaveIO.write(new Fi(evidence.resolve("final-game-"+game+".msav").toFile()));}catch(Throwable e){Log.err(e);}
    }
    void periodicSave(){
        nextSave=(Math.floor(elapsed/saveInterval)+1)*saveInterval;
        try{Path saves=Files.createDirectories(evidence.resolve("saves"));SaveIO.write(new Fi(saves.resolve("game-"+game+"-"+(long)elapsed+".msav").toFile()));}catch(Throwable e){Log.err(e);}
    }
    LinkedHashMap<String,Object> state(){
        ArrayList<Object> cores=new ArrayList<>();
        LinkedHashMap<String,Object> teams=new LinkedHashMap<>();
        for(var entry:seats.entrySet())teams.put(entry.getKey(),entry.getValue().player.team().name);
        if(configured)for(Team team:Team.all)for(var c:team.cores())
            cores.add(obj("id",c.id,"team",team.name,"x",c.tileX(),"y",c.tileY(),"health",c.health,"max_health",c.maxHealth));
        return obj("configured",configured,"game",game,"started",started,"completed",terminal,"terminal",terminal?terminalState():null,
            "reason",reason,"game_mode",mode,"win_wave",Vars.state.rules.winWave,"map",configured?Vars.state.map.plainName():null,"map_file",configured&&!arena?chosen.file.nameWithoutExtension():null,"seed",configured?seed:null,
            "width",Vars.world.width(),"height",Vars.world.height(),"team_count",teamCount,"team_size",teamSize==0?null:teamSize,"team_sizes",teamSizes==null?null:java.util.Arrays.stream(teamSizes).boxed().toList(),
            "elapsed_seconds",time(),"time_limit_sec",unlimited?null:limit,
            "end_condition",unlimited?"core_destroyed":"core_destroyed_or_time_limit",
            "survival_censored",terminal&&reason.equals("time_limit"),"wave",Vars.state.wave,
            "waves_completed",wavesCompleted,"winning_team",winner,"seat_teams",teams,"cores",cores);
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
    Object terminalState(){LinkedHashMap<String,Object> teams=new LinkedHashMap<>();for(var e:seats.entrySet())teams.put(e.getKey(),e.getValue().player.team().name);return obj("game",game,"reason",reason,"elapsed_seconds",elapsed,"waves_completed",wavesCompleted,"wave",Vars.state.wave,"winning_team",winner,"seat_teams",teams,"core_health_by_team",finalCoreHealth,"survival_censored",reason.equals("time_limit"));}
    void snapshot(){try{String snapshot=json(state());Files.writeString(evidence.resolve("state.json"),snapshot);Files.writeString(evidence.resolve("snapshots.jsonl"),snapshot+"\n",StandardOpenOption.CREATE,StandardOpenOption.APPEND);}catch(Exception e){Log.err(e);}}
    void event(String name,Object data){try{Files.writeString(evidence.resolve("events.jsonl"),json(obj("sequence",++sequence,"game",game,"event",name,"elapsed_sec",elapsed,"data",data))+"\n",StandardOpenOption.CREATE,StandardOpenOption.APPEND);}catch(Exception e){Log.err(e);}}

    static final class Refused extends RuntimeException{Refused(String message){super(message);}}
    static void require(boolean test,String error){if(!test)throw new IllegalArgumentException(error);}

    static String list(Collection<?> values){StringJoiner out=new StringJoiner(", ");for(Object value:values)out.add(String.valueOf(value));return out.toString();}
    static LinkedHashMap<String,Object> obj(Object... pairs){LinkedHashMap<String,Object> m=new LinkedHashMap<>();for(int i=0;i<pairs.length;i+=2)m.put((String)pairs[i],pairs[i+1]);return m;}
    static String json(Object v){if(v==null)return "null";if(v instanceof Number n)return Double.isFinite(n.doubleValue())?n.toString():"null";if(v instanceof Boolean)return v.toString();if(v instanceof Map<?,?> m){ArrayList<String> p=new ArrayList<>();for(var e:m.entrySet())p.add(json(e.getKey().toString())+":"+json(e.getValue()));return "{"+String.join(",",p)+"}";}if(v instanceof Iterable<?> a){ArrayList<String> p=new ArrayList<>();for(Object x:a)p.add(json(x));return "["+String.join(",",p)+"]";}String s=v.toString();StringBuilder b=new StringBuilder("\"");for(char c:s.toCharArray()){switch(c){case '"'->b.append("\\\"");case '\\'->b.append("\\\\");case '\n'->b.append("\\n");case '\r'->b.append("\\r");case '\t'->b.append("\\t");default->{if(c<32)b.append(String.format("\\u%04x",(int)c));else b.append(c);}}}return b.append('"').toString();}
}
