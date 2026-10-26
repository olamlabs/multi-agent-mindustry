package agentbridge;

import arc.Events;
import arc.util.serialization.JsonValue;
import mindustry.Vars;
import mindustry.game.EventType.*;
import mindustry.game.Team;
import mindustry.gen.*;
import java.util.*;
import static agentbridge.AgentBridge.*;
import static agentbridge.Records.*;

final class MatchLog {
    final AgentBridge bridge;
    final LinkedHashMap<String,View> views=new LinkedHashMap<>();
    long messageId;
    record Entry(Map<String,Object> data,String privateField,Object privateValue,Team owner,boolean publicValue){}
    static final class Cursor {
        final List<Predicate> filter;
        final Object selection;
        int position;
        Cursor(List<Predicate> filter,Object selection){this.filter=filter;this.selection=selection;}
    }
    static final class View {
        final ArrayList<Entry> entries=new ArrayList<>();
        final Map<String,Cursor> cursors=new HashMap<>();

        List<List<Predicate>> wake;
        int chatHead,wakeHead;
    }
    MatchLog(AgentBridge bridge){this.bridge=bridge;}

    void addSeat(String seat){
        View view=new View();Predicate say=new Predicate(new String[]{"kind"},"eq","say");
        view.wake=List.of(List.of(say,new Predicate(new String[]{"from"},"ne",seat)),List.of(say,new Predicate(new String[]{"audience"},"eq","self")));
        views.put(seat,view);
    }

    void reset(){for(var view:views.entrySet()){View fresh=new View();fresh.wake=view.getValue().wake;view.setValue(fresh);}}
    int head(String seat){return views.get(seat).entries.size();}

    Map<String,Object> status(String seat){
        View view=views.get(seat);Player p=bridge.seats.get(seat).player;Team team=p.team();
        Unit u=p.dead()?null:p.unit();Building core=team.core();
        Map<String,Object> chat=null;
        if(view.chatHead>0){Map<String,Object> m=row(seat,view.entries.get(view.chatHead-1),view.chatHead);chat=obj("seq",view.chatHead,"t",m.get("t"),"from",m.get("from"),"to",m.get("to"),"text",m.get("text"),"data",m.get("data"));}
        var out=obj("t",bridge.time(),"team",team.name,
            "you",u==null?null:obj("unit_id",u.id,"type",u.type.name,"health",u.health,"x",u.x/8,"y",u.y/8,"stack",stack(u),
                "mining",u.mineTile==null?null:obj("x",(int)u.mineTile.x,"y",(int)u.mineTile.y)),
            "core",core==null?null:obj("id",core.id,"health",core.health,"max_health",core.maxHealth,"items",items(core)),
            "chat",chat);
        out.put("wake_head",view.wakeHead);
        return out;
    }
    Set<String> audience(Team team){
        LinkedHashSet<String> result=new LinkedHashSet<>();
        for(var seat:bridge.seats.entrySet())if(team==null||seat.getValue().player.team()==team)result.add(seat.getKey());
        return result;
    }
    Map<String,Object> row(String seat,Entry entry,int seq){
        LinkedHashMap<String,Object> result=new LinkedHashMap<>(entry.data);result.put("seq",seq);
        if(entry.privateField!=null&&(entry.publicValue||bridge.seats.get(seat).player.team()==entry.owner))result.put(entry.privateField,entry.privateValue);
        return result;
    }
    boolean incoming(String seat,Map<String,Object> entry){return "say".equals(entry.get("kind"))&&(!seat.equals(entry.get("from"))||"self".equals(entry.get("audience")));}
    Entry append(String kind,Map<String,Object> fields,Set<String> audience,String privateField,Object privateValue,Team owner,boolean publicValue){
        LinkedHashMap<String,Object> data=obj("t",bridge.time(),"tick",Vars.state.updateId,"game",bridge.game,"kind",kind);data.putAll(fields);
        Entry entry=new Entry(data,privateField,privateValue,owner,publicValue);
        for(String seat:audience){
            View view=views.get(seat);view.entries.add(entry);int seq=view.entries.size();
            if(incoming(seat,data))view.chatHead=seq;
            Map<String,Object> row=row(seat,entry,seq);
            if(view.wake.stream().anyMatch(filter->matches(row,filter)))view.wakeHead=seq;
        }

        bridge.event("log",obj("entry",data,"audience",audience,"private_field",privateField,"private_value",privateValue));
        return entry;
    }
    Entry append(String kind,Map<String,Object> fields,Set<String> audience){return append(kind,fields,audience,null,null,null,false);}
    void nativeEvent(String kind,Map<String,Object> fields){if(bridge.configured)append(kind,fields,audience(null));}
    void configuredEvent(String kind,Map<String,Object> fields,Building building,int x,int y,String field,Object value,Team team){
        if(!bridge.configured)return;
        boolean privileged=building!=null&&building.block.privileged;

        if(building!=null&&building.block instanceof mindustry.world.blocks.power.PowerNode)value=building.config();
        append(kind,fields,audience(null),privileged?null:field,privileged?null:config(value,x,y),team,
            building!=null&&!privileged&&building.block.configSenseable());
    }
    void listen(){
        Events.on(BlockBuildBeginEvent.class,e->nativeEvent("block_build_begin",obj("tile",ref(e.tile),"team",e.team.name,"unit",ref(e.unit),"breaking",e.breaking)));
        Events.on(BlockBuildEndEvent.class,e->configuredEvent("block_build_end",obj("tile",ref(e.tile),"team",e.team.name,"unit",ref(e.unit),"breaking",e.breaking),e.tile.build,e.tile.x,e.tile.y,"config",e.config,e.team));
        Events.on(BlockDestroyEvent.class,e->nativeEvent("block_destroy",obj("tile",ref(e.tile),"building",ref(e.tile.build))));
        Events.on(ConfigEvent.class,e->configuredEvent("config",obj("building",ref(e.tile),"player",ref(e.player)),e.tile,e.tile.tileX(),e.tile.tileY(),"value",e.value,e.tile.team));
        Events.on(BuildTeamChangeEvent.class,e->nativeEvent("building_team_change",obj("previous",e.previous.name,"building",ref(e.build))));
        Events.on(UnitCreateEvent.class,e->nativeEvent("unit_create",obj("unit",ref(e.unit),"spawner",ref(e.spawner),"spawner_unit",ref(e.spawnerUnit))));
        Events.on(UnitDestroyEvent.class,e->{
            for(var seat:bridge.seats.values())if(seat.player.unit()==e.unit)seat.release();
            nativeEvent("unit_destroy",obj("unit",ref(e.unit)));
        });
        Events.on(UnitDrownEvent.class,e->nativeEvent("unit_drown",obj("unit",ref(e.unit))));
        Events.on(UnitControlEvent.class,e->nativeEvent("unit_control",obj("player",ref(e.player),"unit",ref(e.unit))));
        Events.on(UnitChangeEvent.class,e->nativeEvent("unit_change",obj("player",ref(e.player),"unit",ref(e.unit))));
        Events.on(CoreChangeEvent.class,e->nativeEvent("core_change",obj("core",ref(e.core))));
        Events.on(GameOverEvent.class,e->nativeEvent("game_over",obj("winner",e.winner==null?null:e.winner.name)));
        Events.on(PickupEvent.class,e->nativeEvent("pickup",obj("carrier",ref(e.carrier),"unit",ref(e.unit),"building",ref(e.build))));
        Events.on(PayloadDropEvent.class,e->nativeEvent("payload_drop",obj("carrier",ref(e.carrier),"unit",ref(e.unit),"building",ref(e.build))));
    }
    Object events(String seat,JsonValue a){
        only(a,"seat","cursor","after","latest","filter","fields","limit");
        require((a.has("cursor")?1:0)+(a.has("after")?1:0)+(a.has("latest")?1:0)==1,"Exactly one of cursor, after, latest is required");
        List<String> fields=fields(a.get("fields"));
        View view=views.get(seat);
        if(a.has("latest")){
            require(!a.has("limit"),"latest excludes limit");
            require(wholeNumber(a.get("latest"))&&a.getDouble("latest")>0,"latest must be a positive integer");
            double count=a.getDouble("latest");List<Predicate> filter=filter(a.get("filter"),"filter");
            ArrayList<Object> results=new ArrayList<>();
            for(int i=view.entries.size()-1;i>=0&&results.size()<count;i--){
                Map<String,Object> row=row(seat,view.entries.get(i),i+1);
                if(matches(row,filter))results.add(project(row,fields));
            }
            Collections.reverse(results);return obj("events",results);
        }
        double limit=limit(a),after;String name=null;Cursor cursor=null;List<Predicate> filter;
        if(a.has("cursor")){
            field(a,"cursor","string",true);name=a.getString("cursor");
            require(!name.isEmpty(),"cursor must be a nonempty string");
            cursor=view.cursors.get(name);
            if(cursor==null){
                filter=filter(a.get("filter"),"filter");
                cursor=new Cursor(filter,a.has("filter")?plain(a.get("filter")):List.of());
            }else if(a.has("filter")){
                filter(a.get("filter"),"filter");

                if(!equal(cursor.selection,plain(a.get("filter"))))throw new Refused("The reader \""+name+"\" already has another filter; use a different cursor name");
            }
            filter=cursor.filter;after=cursor.position;
        }else{
            require(wholeNumber(a.get("after"))&&a.getDouble("after")>=0,"after must be a nonnegative integer");
            after=a.getDouble("after");filter=filter(a.get("filter"),"filter");
        }
        ArrayList<Object> results=new ArrayList<>();Object next=cursor==null?plain(a.get("after")):cursor.position;boolean more=false;
        for(int i=(int)Math.min(after,view.entries.size());i<view.entries.size();i++){
            Map<String,Object> row=row(seat,view.entries.get(i),i+1);
            if(matches(row,filter)){
                if(results.size()==limit){more=true;break;}
                results.add(project(row,fields));
            }next=i+1;
        }
        if(cursor==null)return obj("events",results,"next",next,"more",more);
        cursor.position=((Number)next).intValue();view.cursors.put(name,cursor);
        return obj("cursor",name,"events",results,"more",more);
    }
    Object say(String seat,JsonValue a){
        only(a,"seat","audience","to","reply_to","text","data");
        if(!bridge.started)throw new Refused("The game has not started");
        for(String name:List.of("audience","reply_to","text"))field(a,name,"string",false);
        field(a,"to","array",false);require(a.has("text")||a.has("data"),"Message requires text or data");
        String audience=a.getString("audience","team");Team team=bridge.seats.get(seat).player.team();
        require(List.of("team","self","all").contains(audience),"Unknown audience");require(!audience.equals("all")||bridge.allChat,"All-chat is disabled");
        Set<String> recipients=audience.equals("self")?Set.of(seat):audience(audience.equals("team")?team:null);
        ArrayList<String> to=new ArrayList<>();if(a.has("to"))for(JsonValue target:a.get("to")){require(target.isString()&&recipients.contains(target.asString()),"Addressed seat is outside audience");to.add(target.asString());}
        String reply=a.getString("reply_to",null);
        if(reply!=null)require(views.get(seat).entries.stream().anyMatch(e->reply.equals(e.data.get("id"))&&"say".equals(e.data.get("kind"))),"Reply message is not visible");
        Entry entry=append("say",obj("id","message-"+(++messageId),"from",seat,"team",team.name,"audience",audience,"to",to,"reply_to",reply,"text",a.getString("text",null),"data",plain(a.get("data"))),recipients);
        return obj("message",entry.data);
    }

    Object wake(String seat,JsonValue a){
        if(!bridge.started)throw new Refused("The game has not started");
        only(a,"seat","filters");field(a,"filters","array",false);
        View view=views.get(seat);
        if(a.has("filters")){ArrayList<List<Predicate>> filters=new ArrayList<>();for(JsonValue item:a.get("filters"))filters.add(filter(item,"filters["+filters.size()+"]"));view.wake=filters;}
        ArrayList<Object> shown=new ArrayList<>();
        for(List<Predicate> filter:view.wake){ArrayList<Object> predicates=new ArrayList<>();for(Predicate p:filter)predicates.add(Arrays.asList(String.join(".",p.path()),p.op(),p.expected()));shown.add(predicates);}
        return obj("filters",shown);
    }
    void action(String seat,String op,JsonValue args,Object effect){
        append("act",obj("seat",seat,"op",op,"args",plain(args),"effect",effect),audience(bridge.seats.get(seat).player.team()));
    }
}
