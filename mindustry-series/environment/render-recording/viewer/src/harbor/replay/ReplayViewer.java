package harbor.replay;

import arc.Core;
import arc.Events;
import arc.util.Log;
import arc.util.io.Reads;
import arc.util.serialization.JsonReader;
import arc.util.serialization.JsonValue;
import harbor.ReplayFormat;
import mindustry.Vars;
import mindustry.core.Version;
import mindustry.game.EventType.ClientLoadEvent;
import mindustry.game.EventType.Trigger;
import mindustry.game.EventType.WorldLoadEvent;
import mindustry.gen.Groups;
import mindustry.gen.Player;
import mindustry.mod.Mod;
import mindustry.net.Net;
import mindustry.net.Packet;
import mindustry.net.Packets.WorldStream;
import mindustry.ui.Styles;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;

public final class ReplayViewer extends Mod{
    final String recording=System.getenv("HARBOR_REPLAY_DIR");
    final double from=number("HARBOR_REPLAY_FROM",0),to=number("HARBOR_REPLAY_TO",Double.POSITIVE_INFINITY);
    final String seat=env("HARBOR_VIEW_SEAT","seat-1");
    final String at=env("HARBOR_VIEW_AT","0,0");
    final int fps=(int)number("HARBOR_VIEW_FPS",30);
    final Path ready=Path.of(env("HARBOR_REPLAY_READY","replay-ready.json"));
    final Path go=Path.of(env("HARBOR_REPLAY_GO","replay-go"));
    final Path done=Path.of(env("HARBOR_REPLAY_DONE","replay-done.json"));

    record Entry(long t,Packet packet,byte[] world){}

    volatile boolean begun,prepared,finished;
    volatile long startNs=-1,startWallNanos,startWallMs=-1,lastFedNs=-1;
    volatile String cutShort,error;
    long dispatched;
    boolean announced;
    final ArrayList<Boolean> seen=new ArrayList<>();

    static String env(String key,String fallback){
        String value=System.getenv(key);
        return value==null||value.isEmpty()?fallback:value;
    }

    static double number(String key,double fallback){
        String value=System.getenv(key);
        return value==null||value.isEmpty()?fallback:Double.parseDouble(value);
    }

    public ReplayViewer(){
        Events.on(ClientLoadEvent.class,event->{
            if(recording==null)return;
            Core.settings.put("name","__replay_"+seat);
            Core.settings.put("fpscap",fps);
            Core.settings.put("vsync",false);
            Core.settings.put("bloom",false);
            Core.settings.put("musicvol",0);
            Core.settings.put("sfxvol",0);
            Core.settings.put("smoothcamera",false);
            Core.settings.put("drawWeather",false);
            Core.settings.put("lasersopacity",50);
            Vars.ui.hudfrag.shown=false;
            Core.scene.table(table->{
                table.bottom().left().margin(8f);
                table.label(this::statusText).style(Styles.outlineLabel).fontScale(0.75f);
            });
            String refusal;
            try{
                List<Path> segments=ReplayFormat.segments(Path.of(recording));
                if(segments.isEmpty())throw new IOException("no "+ReplayFormat.SUFFIX+" segments in "+recording);
                try(var reader=new ReplayFormat.Reader(segments.get(0))){
                    refusal=refusal(reader.header);
                }
            }catch(IOException e){
                refusal="Cannot read the recording: "+e.getMessage();
            }
            if(refusal!=null){
                write(done,HarborJson.object("seat",seat,"refused",refusal));
                Log.err("Harbor replay: @",refusal);
                Core.app.exit();
                return;
            }
            Thread feeder=new Thread(this::feed,"harbor-replay-feed");
            feeder.setDaemon(true);
            feeder.start();
            Core.app.post(this::begin);
        });
        Events.on(WorldLoadEvent.class,event->{
            if(begun)seen.add(false);
        });
        Events.run(Trigger.preDraw,this::follow);
    }

    static String refusal(String json){
        JsonValue header=new JsonReader().parse(json);
        if(!"mindustry-replay/1".equals(header.getString("format",null)))return "The recording's format is "+header.getString("format",null)+", not mindustry-replay/1.";
        JsonValue made=header.get("mindustry");
        boolean same=made.getInt("number",-1)==Version.number&&made.getInt("build",-1)==Version.build
            &&made.getInt("revision",-1)==Version.revision&&Objects.equals(made.getString("type",null),Version.type);
        if(same)return null;
        return "This recording was made by Mindustry "+made.getInt("build",-1)+"."+made.getInt("revision",-1)+" ("+made.getString("type",null)+", major "+made.getInt("number",-1)
            +"); this client is Mindustry "+Version.build+"."+Version.revision+" ("+Version.type+", major "+Version.number+"). Render it with the game image of the build that recorded it.";
    }

    void begin(){
        Vars.logic.reset();
        Vars.net.reset();
        Vars.netClient.beginConnecting();
        Vars.net.setClientConnected();
        begun=true;
        Log.info("Harbor replay: playing @ from @ s for @",recording,from,seat);
    }

    void feed(){
        long fromNs=(long)(from*1e9),toNs=Double.isInfinite(to)?Long.MAX_VALUE:(long)(to*1e9);
        ReplayFormat.Record base=null;
        ArrayList<ReplayFormat.Record> since=new ArrayList<>();
        boolean playing=false;
        try{
            while(!begun)Thread.sleep(10);
            read:
            for(Path segment:ReplayFormat.segments(Path.of(recording))){
                try(var reader=new ReplayFormat.Reader(segment)){
                    String refusal=refusal(reader.header);
                    if(refusal!=null)throw new IOException(segment.getFileName()+": "+refusal);
                    for(ReplayFormat.Record r;(r=reader.next())!=null;){
                        if(r.t()>toNs)break read;
                        if(!playing){
                            if(r.kind()==ReplayFormat.KEYFRAME&&(base==null||r.t()<=fromNs)){
                                base=r;
                                since.clear();
                                continue;
                            }
                            if(base==null||r.t()<=fromNs){
                                if(base!=null&&r.kind()==ReplayFormat.PACKET)since.add(r);
                                continue;
                            }
                            prepare(base,since,Math.max(fromNs,base.t()));
                            playing=true;
                        }
                        if(r.kind()==ReplayFormat.PACKET)deliver(entry(r));
                    }
                    if(reader.cutShort!=null){
                        cutShort=segment.getFileName()+": "+reader.cutShort;
                        Log.warn("Harbor replay: @ ends early (@); playing what it holds",segment,reader.cutShort);
                        break;
                    }
                }
            }
            if(!playing){
                if(base==null)throw new IOException("the recording holds no keyframe up to "+to+" s");
                prepare(base,since,Math.max(fromNs,base.t()));
            }
        }catch(Throwable e){
            error=String.valueOf(e);
            Log.err("Harbor replay: cannot play "+recording,e);
        }
        Core.app.post(this::finish);
    }

    void prepare(ReplayFormat.Record base,List<ReplayFormat.Record> since,long start) throws Exception{
        Entry world=new Entry(base.t(),null,base.data());
        Core.app.post(()->dispatch(world));
        for(var record:since){
            Entry entry=entry(record);
            Core.app.post(()->dispatch(entry));
        }
        lastFedNs=since.isEmpty()?base.t():since.get(since.size()-1).t();
        Core.app.post(this::finishPreparation);
        while(!Files.exists(go))Thread.sleep(10);
        startNs=start;
        startWallNanos=System.nanoTime();
        startWallMs=System.currentTimeMillis();
    }

    void finishPreparation(){
        if(seen.size()>1)seen.subList(0,seen.size()-1).clear();
        prepared=true;
    }

    static Entry entry(ReplayFormat.Record record) throws IOException{
        Packet packet=Net.newPacket(record.packetId());
        packet.read(new Reads(new DataInputStream(new ByteArrayInputStream(record.data()))),record.data().length);
        return new Entry(record.t(),packet,null);
    }

    void deliver(Entry entry) throws InterruptedException{
        if(entry.t()>startNs){
            long wait=startWallNanos+(entry.t()-startNs)-System.nanoTime();
            if(wait>0)Thread.sleep(wait/1_000_000,(int)(wait%1_000_000));
        }
        lastFedNs=entry.t();
        Core.app.post(()->dispatch(entry));
    }

    void dispatch(Entry entry){
        dispatched++;
        try{
            if(entry.world()!=null){
                WorldStream stream=new WorldStream();
                stream.stream=new ByteArrayInputStream(entry.world());
                Vars.netClient.beginConnecting();
                Vars.net.handleClientReceived(stream);
            }else{
                Vars.net.handleClientReceived(entry.packet());
            }
        }catch(Throwable e){
            if(error==null)error=(entry.packet()==null?"world":entry.packet().getClass().getSimpleName())+" at "+entry.t()/1e9+" s: "+e;
            Log.err("Harbor replay: "+(entry.packet()==null?"world":entry.packet().getClass().getSimpleName())+" at "+entry.t()/1e9+" s failed",e);
        }
    }

    void follow(){
        if(begun&&!finished&&!Vars.net.client()){
            if(error==null)error="the client left the replay at "+lastFedNs/1e9+" s; see its log";
            finish();
            return;
        }
        if(!begun||Vars.netClient.isConnecting()||!Vars.state.isGame())return;
        Vars.ui.hudfrag.shown=false;
        boolean visible;
        if(seat.equals("none")){
            String[] tile=at.split(",");
            Core.camera.position.set(Float.parseFloat(tile[0])*8f,Float.parseFloat(tile[1])*8f);
            visible=true;
        }else{
            Player target=Groups.player.find(p->seat.equals(p.name));
            visible=target!=null;
            if(target!=null){
                if(target.dead())Core.camera.position.set(target.x,target.y);
                else Core.camera.position.set(target.unit().x,target.unit().y);
                if(!seen.isEmpty())seen.set(seen.size()-1,true);
            }
        }
        if(prepared&&!announced){
            announced=true;
            write(ready,HarborJson.object("seat",seat,"seat_visible",visible,"rec_sec",lastFedNs/1e9));
            Log.info("Harbor replay viewer ready for @",seat);
        }
    }

    void finish(){
        if(finished)return;
        finished=true;
        write(done,HarborJson.object("seat",seat,"from_sec",from,"to_sec",Double.isInfinite(to)?null:to,
            "start_rec_sec",startNs<0?null:startNs/1e9,"started_wall_ms",startWallMs<0?null:startWallMs,"last_rec_sec",lastFedNs<0?null:lastFedNs/1e9,
            "dispatched",dispatched,"worlds",seen.size(),"seat_seen",seat.equals("none")?null:seen,"cut_short",cutShort,"error",error,"wall_ms",System.currentTimeMillis()));
        Log.info("Harbor replay: finished after @ packets",dispatched);
    }

    String statusText(){
        if(seat.equals("none"))return "";
        Player target=Groups.player.find(p->seat.equals(p.name));
        if(target==null||!Vars.state.isGame())return "";
        String unit=target.dead()?"respawning":target.unit().type.name+" "
            +Math.round(target.unit().health)+"/"+Math.round(target.unit().maxHealth);
        return target.team().name+" | Wave "+Vars.state.wave+" | "+unit;
    }

    static void write(Path path,String text){
        try{
            Path temporary=Path.of(path+".tmp");
            Files.writeString(temporary,text+"\n",StandardCharsets.UTF_8);
            Files.move(temporary,path,StandardCopyOption.ATOMIC_MOVE,StandardCopyOption.REPLACE_EXISTING);
        }catch(IOException e){
            throw new UncheckedIOException(e);
        }
    }
}
