// SPDX-License-Identifier: GPL-3.0-only

package agentbridge;

import arc.Core;
import arc.Events;
import arc.func.Cons;
import arc.net.Server.ServerConnectFilter;
import arc.util.Log;
import arc.util.io.FastDeflaterOutputStream;
import arc.util.io.ReusableByteOutStream;
import arc.util.io.Writes;
import mindustry.Vars;
import mindustry.core.Version;
import mindustry.game.EventType.*;
import mindustry.game.Team;
import mindustry.gen.Player;
import mindustry.net.*;
import mindustry.net.Administration.Config;
import mindustry.net.Net.NetProvider;
import java.io.*;
import java.lang.management.ManagementFactory;
import java.lang.reflect.Field;
import java.nio.file.*;
import java.security.MessageDigest;
import java.util.*;
import java.util.concurrent.*;

final class ReplayRecorder{
    final AgentBridge bridge;
    final Path dir;
    final long segmentNanos,keyframeNanos;
    final long startNanos=System.nanoTime(),startUnixMs=System.currentTimeMillis();
    final LinkedBlockingQueue<byte[]> queue=new LinkedBlockingQueue<>();
    final ReusableByteOutStream packetBytes=new ReusableByteOutStream(4096);
    final Writes writes=new Writes(new DataOutputStream(packetBytes));
    final long[] packetCount=new long[256],packetTotal=new long[256];
    final String[] packetNames=new String[256];
    final ArrayList<Object> marks=new ArrayList<>();
    final Map<Path,String> digests=new HashMap<>();
    long keyframes,keyframeBytes,gameThreadNanos,lastKeyframe;
    int worlds;
    boolean running;
    volatile long records,writerCpuNanos;
    volatile int segment=-1;
    volatile long segmentStart;
    volatile boolean stopped,closed;
    volatile String failure;
    Thread writer;
    Spectator connection;
    Player spectator;

    ReplayRecorder(AgentBridge bridge,Path dir,double segmentSec,double keyframeSec){
        this.bridge=bridge;
        this.dir=dir;
        segmentNanos=(long)(segmentSec*1e9);
        keyframeNanos=(long)(keyframeSec*1e9);
    }

    static ReplayRecorder start(AgentBridge bridge){
        String dir=System.getenv("MINDUSTRY_REPLAY_DIR");
        if(dir==null||dir.isEmpty())return null;
        ReplayRecorder recorder=new ReplayRecorder(bridge,Paths.get(dir),seconds("MINDUSTRY_REPLAY_SEGMENT_SEC"),seconds("MINDUSTRY_REPLAY_KEYFRAME_SEC"));
        recorder.begin();
        return recorder;
    }

    static double seconds(String name){
        String text=System.getenv(name);
        if(text==null)throw new IllegalArgumentException(name+" is not set");
        double value=Double.parseDouble(text);
        if(!(value>0)||Double.isInfinite(value))throw new IllegalArgumentException(name+" must be a positive number of seconds");
        return value;
    }

    long now(){
        return System.nanoTime()-startNanos;
    }

    void begin(){
        try{
            Files.createDirectories(dir);
        }catch(IOException e){
            fail("cannot create "+dir,e);
            return;
        }
        Events.on(ServerLoadEvent.class,e->tap());
        Events.on(PlayEvent.class,e->Core.app.post(this::join));
        Events.run(Trigger.update,this::tick);
        writer=new Thread(this::writeLoop,"agent-bridge-replay-writer");
        writer.setDaemon(true);
        writer.start();
        Runtime.getRuntime().addShutdownHook(new Thread(this::close,"agent-bridge-replay-close"));
        Log.info("Replay recorder writing to @",dir);
    }

    final class Spectator extends NetConnection{
        Spectator(){
            super("replay-recorder");
            uuid=usid="agent-bridge-replay-recorder";
            hasBegunConnecting=hasConnected=true;
        }

        @Override
        public void send(Object object,boolean reliable){
            record(object);
        }

        @Override
        public void close(){}
    }

    final class Tap implements NetProvider{
        final NetProvider inner;

        Tap(NetProvider inner){
            this.inner=inner;
        }

        @Override
        public void sendAllServer(Object object,Iterable<NetConnection> connections,boolean reliable){
            for(NetConnection con:connections)if(con==connection){
                record(object);
                break;
            }
            inner.sendAllServer(object,connections,reliable);
        }

        @Override
        public void sendAllServer(Object object,boolean reliable){
            record(object);
            inner.sendAllServer(object,reliable);
        }

        @Override
        public void sendExceptServer(NetConnection except,Object object,boolean reliable){
            if(except!=connection)record(object);
            inner.sendExceptServer(except,object,reliable);
        }

        @Override public void connectClient(String ip,int port,Runnable success) throws IOException{inner.connectClient(ip,port,success);}
        @Override public void sendClient(Object object,boolean reliable){inner.sendClient(object,reliable);}
        @Override public void disconnectClient(){inner.disconnectClient();}
        @Override public void discoverServers(Cons<Host> callback,Runnable done){inner.discoverServers(callback,done);}
        @Override public void pingHost(String address,int port,Cons<Host> valid,Cons<Exception> failed){inner.pingHost(address,port,valid,failed);}
        @Override public void hostServer(int port) throws IOException{inner.hostServer(port);}
        @Override public Iterable<? extends NetConnection> getConnections(){return inner.getConnections();}
        @Override public void closeServer(){inner.closeServer();}
        @Override public void dispose(){inner.dispose();}
        @Override public void setConnectFilter(ServerConnectFilter filter){inner.setConnectFilter(filter);}
        @Override public ServerConnectFilter getConnectFilter(){return inner.getConnectFilter();}
    }

    void tap(){
        if(stopped)return;
        try{
            Field field=Net.class.getDeclaredField("provider");
            field.setAccessible(true);
            NetProvider inner=(NetProvider)field.get(Vars.net);
            if(!(inner instanceof Tap))field.set(Vars.net,new Tap(inner));
        }catch(Throwable e){
            fail("cannot tap the server's packet stream",e);
        }
    }

    void join(){
        if(stopped||!Vars.net.server()||!Vars.state.isGame())return;
        try{
            if(spectator==null){
                connection=new Spectator();
                spectator=Player.create();
                spectator.name="__replay_recorder";
                spectator.con=connection;
                connection.player=spectator;
            }
            spectator.reset();
            spectator.team(Team.derelict);
            worlds++;
            mark(AgentBridge.obj("event","world","world",worlds,"map",Vars.state.map.plainName()));
            Vars.netServer.sendWorldData(spectator);
            keyframe();
        }catch(Throwable e){
            fail("cannot send the world to the recorder",e);
        }
    }

    void tick(){
        if(stopped||spectator==null)return;
        boolean nowRunning=bridge.started&&!bridge.terminal;
        if(nowRunning!=running){
            running=nowRunning;
            mark(running?AgentBridge.obj("event","start"):AgentBridge.obj("event","end","reason",bridge.reason,"winner",bridge.winner));
        }
        if(Vars.state.isGame()&&now()-lastKeyframe>=keyframeNanos)keyframe();
    }

    void keyframe(){
        long began=System.nanoTime();
        try{
            ByteArrayOutputStream world=new ByteArrayOutputStream();
            NetworkIO.writeWorld(spectator,new FastDeflaterOutputStream(world));
            lastKeyframe=now();
            synchronized(this){
                keyframes++;
                keyframeBytes+=world.size();
            }
            enqueue(ReplayFormat.KEYFRAME,lastKeyframe,(byte)0,world.toByteArray());
        }catch(Throwable e){
            fail("cannot write a keyframe",e);
        }
        synchronized(this){
            gameThreadNanos+=System.nanoTime()-began;
        }
    }

    void mark(LinkedHashMap<String,Object> event){
        if(stopped)return;
        long t=now();
        LinkedHashMap<String,Object> note=AgentBridge.obj("t",t/1e9);
        note.putAll(event);
        synchronized(this){
            marks.add(note);
        }
        enqueue(ReplayFormat.MARK,t,(byte)0,AgentBridge.json(note).getBytes(java.nio.charset.StandardCharsets.UTF_8));
    }

    synchronized void record(Object object){
        if(stopped||!(object instanceof Packet packet))return;
        long began=System.nanoTime();
        try{
            byte id=Net.getPacketId(packet);
            packetBytes.reset();
            packet.write(writes);
            byte[] data=packetBytes.toByteArray();
            int index=id&0xff;
            packetCount[index]++;
            packetTotal[index]+=data.length;
            if(packetNames[index]==null)packetNames[index]=packet.getClass().getSimpleName();
            enqueue(ReplayFormat.PACKET,now(),id,data);
        }catch(Throwable e){
            fail("cannot record "+object.getClass().getSimpleName(),e);
        }
        gameThreadNanos+=System.nanoTime()-began;
    }

    void enqueue(byte kind,long t,byte id,byte[] data){
        if(stopped)return;
        queue.add(ReplayFormat.encode(kind,t,id,data));
    }

    void fail(String what,Throwable cause){
        synchronized(this){
            if(failure!=null)return;
            failure=what+(cause==null?"":": "+cause);
            stopped=true;
        }
        queue.clear();
        Log.warn("Replay recorder stopped at @ s, and the recording is incomplete: @. The game goes on.",now()/1e9,failure);
    }

    void writeLoop(){
        ReplayFormat.Writer out=null;
        long lastFlush=System.nanoTime(),lastStats=0;
        try{
            while(failure==null){
                byte[] record=queue.poll(250,TimeUnit.MILLISECONDS);
                if(failure!=null)break;
                if(record==null){
                    if(stopped)break;
                }else{
                    long t=ReplayFormat.time(record);
                    if(out==null||(ReplayFormat.kind(record)==ReplayFormat.KEYFRAME&&t-segmentStart>=segmentNanos)){
                        ReplayFormat.Writer previous=out;
                        out=null;
                        if(previous!=null)previous.close();
                        out=new ReplayFormat.Writer(dir.resolve(ReplayFormat.segmentName(segment+1)),header(segment+1,t));
                        segmentStart=t;
                        segment++;
                    }
                    out.write(record);
                    records++;
                }
                if(out!=null&&System.nanoTime()-lastFlush>=1_000_000_000L){
                    out.flush();
                    lastFlush=System.nanoTime();
                }
                writerCpuNanos=ManagementFactory.getThreadMXBean().getCurrentThreadCpuTime();
                if(System.nanoTime()-lastStats>=10_000_000_000L){
                    writeStats();
                    lastStats=System.nanoTime();
                }
            }
        }catch(Throwable e){
            fail("cannot write the recording",e);
        }
        if(out!=null){
            try{
                out.close();
                closed=failure==null;
            }catch(IOException e){
                if(failure==null)fail("cannot close the last segment",e);
                else Log.warn("Replay recorder could not close its last segment either: @",e.toString());
            }
        }
        writeStats();
    }

    String header(int number,long start){
        ArrayList<Object> mods=new ArrayList<>();
        for(var mod:Vars.mods.list())mods.add(AgentBridge.obj("name",mod.name,"version",mod.meta.version,"hidden",mod.meta.hidden,"sha256",sha256(mod.file.file().toPath())));
        return AgentBridge.json(AgentBridge.obj("format","mindustry-replay/1",
            "mindustry",AgentBridge.obj("number",Version.number,"build",Version.build,"revision",Version.revision,"type",Version.type,"modifier",Version.modifier,"commit",Version.commitHash,"build_date",Version.buildDate,"server_jar_sha256",sha256(serverJar())),
            "mods",mods,"started_unix_ms",startUnixMs,"segment",number,"segment_start_ns",start,
            "snapshot_interval_ms",Config.snapshotInterval.num(),"segment_sec",segmentNanos/1e9,"keyframe_sec",keyframeNanos/1e9));
    }

    static Path serverJar(){
        try{
            return Paths.get(Vars.class.getProtectionDomain().getCodeSource().getLocation().toURI());
        }catch(Exception e){
            throw new IllegalStateException("cannot locate the server jar",e);
        }
    }

    String sha256(Path path){
        return digests.computeIfAbsent(path,p->{
            try(InputStream in=Files.newInputStream(p)){
                MessageDigest digest=MessageDigest.getInstance("SHA-256");
                byte[] chunk=new byte[1<<16];
                for(int n;(n=in.read(chunk))>0;)digest.update(chunk,0,n);
                return HexFormat.of().formatHex(digest.digest());
            }catch(Exception e){
                throw new IllegalStateException("cannot hash "+p,e);
            }
        });
    }

    void writeStats(){
        LinkedHashMap<String,Object> packets=new LinkedHashMap<>();
        ArrayList<Object> notes;
        long gameThread,frames,frameBytes;
        int loads;
        synchronized(this){
            for(int i=0;i<256;i++)if(packetCount[i]>0)packets.put(packetNames[i],AgentBridge.obj("count",packetCount[i],"bytes",packetTotal[i]));
            notes=new ArrayList<>(marks);
            gameThread=gameThreadNanos;
            frames=keyframes;
            frameBytes=keyframeBytes;
            loads=worlds;
        }
        long onDisk=0;
        for(int i=0;i<=segment;i++){
            try{
                onDisk+=Files.size(dir.resolve(ReplayFormat.segmentName(i)));
            }catch(IOException missing){
                onDisk=-1;
                break;
            }
        }
        String json=AgentBridge.json(AgentBridge.obj("complete",failure==null,"failure",failure,"closed",closed,
            "started_unix_ms",startUnixMs,"elapsed_sec",now()/1e9,"segment_sec",segmentNanos/1e9,"keyframe_sec",keyframeNanos/1e9,
            "segments",segment+1,"bytes",onDisk,"records",records,"worlds",loads,"keyframes",frames,"keyframe_bytes",frameBytes,
            "game_thread_ms",gameThread/1e6,"writer_cpu_ms",writerCpuNanos/1e6,"marks",notes,"packets",packets))+"\n";
        try{
            Path temporary=dir.resolve("stats.json.tmp");
            Files.writeString(temporary,json);
            Files.move(temporary,dir.resolve("stats.json"),StandardCopyOption.ATOMIC_MOVE,StandardCopyOption.REPLACE_EXISTING);
        }catch(IOException e){
            Log.warn("Replay recorder could not write stats.json: @",e.toString());
        }
    }

    void close(){
        stopped=true;
        if(writer==null)return;
        try{
            writer.join();
        }catch(InterruptedException e){
            Thread.currentThread().interrupt();
        }
    }
}
