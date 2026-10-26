package agentbridge;

import arc.math.geom.Point2;
import arc.math.geom.Vec2;
import arc.struct.Seq;
import arc.util.Time;
import arc.util.serialization.JsonValue;
import mindustry.Vars;
import mindustry.ai.*;
import mindustry.ai.types.CommandAI;
import mindustry.ctype.*;
import mindustry.entities.units.BuildPlan;
import mindustry.game.Team;
import mindustry.gen.*;
import mindustry.input.InputHandler;
import mindustry.net.ValidateException;
import mindustry.type.*;
import mindustry.world.*;
import mindustry.world.blocks.ControlBlock;
import mindustry.world.blocks.logic.LogicBlock;
import mindustry.world.blocks.power.PowerNode;
import java.util.*;
import static agentbridge.AgentBridge.*;
import static agentbridge.Records.*;

final class Inputs {
    final AgentBridge bridge;
    record Field(String type,boolean required,String description){
        Map<String,Object> record(){
            var out=obj("type",type,"required",required,"description",description);
            switch(type){
                case "config"->{var variants=obj();CONFIGS.forEach((name,fields)->variants.put(name,describe(fields)));out.put("scalar_types",List.of("null","boolean","string","int"));out.put("variants",variants);}
                case "plan"->out.put("variants",obj("construction",describe(PLACEMENT),"deconstruction",describe(BREAKING)));
                case "rotation"->out.putAll(obj("type","int","minimum",0,"maximum",3,"default",0));
                case "angle"->out.putAll(obj("type","number","default",0));
                case "absolute_frame"->out.putAll(obj("type","string","enum",List.of("absolute")));
                case "relative_frame"->out.putAll(obj("type","string","enum",List.of("relative")));
                case "logic_links"->out.putAll(obj("type","array","items",describe(LOGIC_LINK)));
                case "tiles"->out.putAll(obj("type","array","items",describe(TILE)));
                default->{}
            }
            return out;
        }
    }
    static LinkedHashMap<String,Field> schema(String... fields){
        LinkedHashMap<String,Field> schema=new LinkedHashMap<>();
        for(int i=0;i<fields.length;i+=3){String type=fields[i+1];boolean optional=type.endsWith("?");schema.put(fields[i],new Field(optional?type.substring(0,type.length()-1):type,!optional,fields[i+2]));}
        return schema;
    }
    static Map<String,Object> describe(Map<String,Field> fields){
        var result=obj();fields.forEach((name,field)->result.put(name,field.record()));return result;
    }
    static final LinkedHashMap<String,Field> TILE=schema("x","int","Tile x coordinate.","y","int","Tile y coordinate.");
    static final LinkedHashMap<String,Field> LOGIC_LINK=schema("x","int","Absolute tile x.","y","int","Absolute tile y.","name","string","Native logic link name.");
    static final LinkedHashMap<String,Field> PLACEMENT=schema("x","int","Tile x.","y","int","Tile y.","block","string","Native block name.","rotation","rotation?","0 east, 1 north, 2 west, 3 south; default 0.","config","config?","Optional native configuration.");
    static final LinkedHashMap<String,Field> BREAKING=schema("x","int","Tile x.","y","int","Tile y.","breaking","boolean","Must be true for deconstruction.");
    static final LinkedHashMap<String,LinkedHashMap<String,Field>> CONFIGS=configSchemas();
    static LinkedHashMap<String,LinkedHashMap<String,Field>> configSchemas(){
        var variants=new LinkedHashMap<String,LinkedHashMap<String,Field>>();
        for(String type:List.of("item","liquid","block","unit","command","stance"))variants.put(type,schema("name","string","Native content name."));
        variants.put("int",schema("value","int","Signed 32-bit integer."));
        variants.put("float",schema("value","number","Finite native float."));
        variants.put("point",schema("frame","relative_frame","Relative tile offset from the configured building or plan anchor.","x","int","Relative tile x.","y","int","Relative tile y."));
        variants.put("points",schema("frame","absolute_frame","Absolute tile coordinates; converted to native relative offsets at the boundary.","values","tiles","Replacement links as absolute {x,y} tiles; empty clears links."));
        variants.put("ints",schema("values","ints","Array of signed 32-bit integers; native non-coordinate values."));
        variants.put("bytes",schema("base64","base64","Base64-encoded opaque native bytes; use logic for named absolute links."));
        variants.put("logic",schema("frame","absolute_frame","Logic links use absolute tile coordinates.","code","string","Native logic program.","links","logic_links","Array of {x,y,name} absolute tile links."));
        return variants;
    }
    record Operation(int id,String name,LinkedHashMap<String,Field> fields,String description){
        Map<String,Object> record(){return obj("name",name,"fields",describe(fields),"description",description);}
    }
    final LinkedHashMap<String,Operation> table=new LinkedHashMap<>();
    Inputs(AgentBridge bridge){
        this.bridge=bridge;
        define("input","Set held player controls; omitted fields are unchanged. Held controls persist after the caller exits. If this input is refused, none of its fields change; other operations in the batch are independent.",
            "move","point?","Held {x,y} dimensionless vector, magnitude at most one; zero releases.","move_to","point|null?","Held {x,y} destination in tiles; null releases; exclusive with move.",
            "aim","point?","{x,y} aim position in tiles.","shoot","boolean?","Held firing control.","boost","boolean?","Held boosting control.","mine","tile|null?","Integer {x,y} mining tile or null to release.","building","boolean?","Whether queued building is active.");
        define("plan_add","Queue a native build or deconstruction plan.","plan","plan","Construction {x,y,block,rotation?,config?} (rotation defaults to 0) or deconstruction {x,y,breaking:true}.");
        define("plan_remove","Remove a matching queued plan.","key","plan_key","{x,y,breaking} plan identity.");
        define("plan_prioritize","Move a matching queued plan to the front.","key","plan_key","{x,y,breaking} plan identity.");
        define("plan_clear","Clear the player's build queue.");
        define("rebuild_remove","Remove team rebuild plans at these tiles.","tiles","tiles","Array of integer {x,y} tiles.");
        define("configure","Apply a typed native configuration to an allied nonprivileged building.","building","int","Building id.","value","config","Scalar or typed configuration; variants below define every field. Power nodes require points with frame absolute, never packed integers.");
        define("rotate","Rotate an allied rotatable block.","building","int","Building id.","clockwise","boolean","Native rotation direction.");
        define("withdraw","Withdraw up to the requested amount through native capacity and range checks.","building","int","Building id.","item","string","Native item name.","amount","int","Positive requested amount.");
        define("deposit","Deposit the carried stack through native acceptance, range and cooldown checks.","building","int","Building id.");
        define("discard","Discard the carried item stack.","angle","angle?","Angle in degrees; default 0.");
        define("control","Select an allied unit or controllable building; null returns to the core unit.","target","ref|null","{kind:unit|building,id} or null.");
        define("command","Apply native unit commands and/or targets.","units","ints","Allied commandable unit ids.","command","string?","Native command name.","target","ref|point?","Entity {kind,id} reference or {x,y} tile position.","queue","boolean?","Append target to native queue; default false.");
        define("stance","Set a native unit stance.","units","ints","Allied commandable unit ids.","stance","string","Native stance name.","enabled","boolean","Toggle state; native non-toggle stances are actions.");
        define("rally","Set allied commandable building rally positions.","buildings","ints","Building ids.","target","point","{x,y} destination in tiles.");
        define("payload_pickup","Pick up an eligible allied unit or building through native checks.","target","ref","Entity reference.");
        define("payload_drop","Drop the last carried payload at a native-reachable position.","at","point","{x,y} position in tiles, within native four-tile margin.");
        define("ping","Send a native team location ping.","at","point","{x,y} position in tiles.","text","string?","Optional native ping text.");
    }
    void define(String name,String description,String... fields){
        table.put(name,new Operation(table.size(),name,schema(fields),description));
    }
    static boolean nativeNumber(JsonValue value){return number(value)&&Float.isFinite(value.asFloat());}
    static void objectFields(JsonValue value,String path,Collection<String> allowed){
        require(value!=null&&value.isObject(),path+": expected an object with fields "+list(allowed));
        HashSet<String> seen=new HashSet<>();
        for(JsonValue child:value){
            require(allowed.contains(child.name),path+"."+child.name+": not a field here; the fields are "+list(allowed));
            require(seen.add(child.name),path+"."+child.name+": expected exactly one value");
        }
    }

    static String shape(String type){
        if(type.endsWith("|null"))return shape(type.substring(0,type.length()-5))+" or null";
        return switch(type){
            case "point"->"{x, y}";case "tile"->"{x, y} in whole tiles";case "ref"->"{kind, id}";case "ref|point"->"{kind, id} or {x, y}";
            case "plan"->"{x, y, block, rotation?, config?} or {x, y, breaking: true}";case "plan_key"->"{x, y, breaking}";
            case "ints"->"array of int";case "tiles"->"array of {x, y}";case "logic_links"->"array of {x, y, name}";
            case "rotation"->"int 0..3";case "angle"->"number";case "absolute_frame"->"\"absolute\"";case "relative_frame"->"\"relative\"";
            case "config"->"a configuration: null, boolean, string, int or {type, ...} (query {of:\"ops\"} gives every form)";
            default->type;
        };
    }
    static void member(JsonValue value,String name,String type,boolean required,String path){
        JsonValue child=value.get(name);
        if(child==null){require(!required,path+"."+name+": required; expected "+shape(type));return;}
        validateType(child,type,path+"."+name);
    }
    static void validateFields(JsonValue value,Map<String,Field> schema,String path,boolean tagged){
        Set<String> allowed=new LinkedHashSet<>(schema.keySet());if(tagged)allowed.add("type");
        objectFields(value,path,allowed);
        for(var field:schema.entrySet())member(value,field.getKey(),field.getValue().type,field.getValue().required,path);
    }
    static void point(JsonValue value,boolean integer,String path){
        objectFields(value,path,List.of("x","y"));
        member(value,"x",integer?"int":"number",true,path);member(value,"y",integer?"int":"number",true,path);
    }
    static void reference(JsonValue value,String path){
        objectFields(value,path,List.of("kind","id"));member(value,"kind","string",true,path);member(value,"id","int",true,path);
        require(List.of("unit","building").contains(value.getString("kind")),path+".kind: "+show(value.get("kind"))+" is not one of unit, building");
    }
    static void validateType(JsonValue value,String type,String path){
        if(type.endsWith("|null")){if(value.isNull())return;validateType(value,type.substring(0,type.length()-5),path);return;}
        switch(type){
            case "point"->point(value,false,path);case "tile"->point(value,true,path);
            case "ref"->reference(value,path);case "ref|point"->{if(value.isObject()&&(value.has("kind")||value.has("id")))reference(value,path);else point(value,false,path);}
            case "ints","tiles","logic_links"->{
                require(value.isArray(),path+": expected array of "+(type.equals("ints")?"int":type.equals("tiles")?"{x,y} integer tiles":"{x,y,name} links"));
                int i=0;for(JsonValue child:value){
                    String childPath=path+"["+(i++)+"]";
                    if(type.equals("logic_links"))validateFields(child,LOGIC_LINK,childPath,false);
                    else validateType(child,type.equals("ints")?"int":"tile",childPath);
                }
            }
            case "plan_key"->{objectFields(value,path,List.of("x","y","breaking"));member(value,"x","int",true,path);member(value,"y","int",true,path);member(value,"breaking","boolean",true,path);}
            case "plan"->{
                require(value.isObject(),path+": expected construction {x,y,block,rotation?,config?} or deconstruction {x,y,breaking:true}");
                member(value,"breaking","boolean",false,path);
                validateFields(value,value.getBoolean("breaking",false)?BREAKING:PLACEMENT,path,false);
            }
            case "config"->validateConfig(value,path);
            case "rotation"->require(integer(value)&&value.asInt()>=0&&value.asInt()<=3,path+": expected int in 0..3");
            case "absolute_frame","relative_frame"->{String frame=type.equals("absolute_frame")?"absolute":"relative";require(value.isString()&&value.asString().equals(frame),path+": must be \""+frame+"\"");}
            case "base64"->{
                require(value.isString(),path+": expected base64 string");
                try{Base64.getDecoder().decode(value.asString());}catch(IllegalArgumentException e){throw new IllegalArgumentException(path+": expected valid base64 string");}
            }
            default->{
                boolean valid=switch(type){case "int"->integer(value);case "number","angle"->nativeNumber(value);case "string"->value.isString();case "boolean"->value.isBoolean();default->throw new IllegalStateException(type);};
                require(valid,path+": expected "+(type.equals("int")?"int in -2147483648..2147483647":type.equals("number")||type.equals("angle")?"finite native number":type));
            }
        }
    }
    static void validateConfig(JsonValue value,String path){
        if(value.isNull()||value.isBoolean()||value.isString())return;
        if(value.isNumber()){require(integer(value),path+": expected int in -2147483648..2147483647; fractional values require {type:float,value:number}");return;}
        require(value.isObject(),path+": expected null, boolean, string, int or an object {type, ...} with type one of "+list(CONFIGS.keySet()));
        JsonValue type=value.get("type");
        require(type!=null,path+".type: required; one of "+list(CONFIGS.keySet()));
        require(type.isString()&&CONFIGS.containsKey(type.asString()),path+".type: "+show(type)+" is not one of "+list(CONFIGS.keySet()));
        validateFields(value,CONFIGS.get(type.asString()),path,true);
    }
    void validate(JsonValue a,String path){
        require(a.isObject(),path+": expected an object {op, ...} with op one of "+list(table.keySet()));
        JsonValue name=a.get("op");
        require(name!=null,path+".op: required; one of "+list(table.keySet()));
        Operation op=name.isString()?table.get(name.asString()):null;
        require(op!=null,path+".op: "+show(name)+" is not one of "+list(table.keySet()));
        Set<String> allowed=new LinkedHashSet<>(op.fields.keySet());allowed.add("op");objectFields(a,path,allowed);
        for(var f:op.fields.entrySet()){
            member(a,f.getKey(),f.getValue().type,f.getValue().required,path);
            JsonValue value=a.get(f.getKey());
            if(!f.getKey().equals("move")&&List.of("point","point|null","ref|point").contains(f.getValue().type)
                &&value!=null&&value.isObject()&&value.has("x")){
                for(String axis:List.of("x","y"))require(Float.isFinite(value.getFloat(axis)*8),path+"."+f.getKey()+"."+axis+": tile coordinate exceeds the native position range");
            }
        }
        if(op.name.equals("input")){
            require(a.size>1,path+": expected at least one of "+list(op.fields.keySet()));
            require(!(a.has("move")&&a.has("move_to")),path+".move_to: allowed with move omitted; move and move_to are mutually exclusive");
        }
        if(op.name.equals("command"))require(a.has("command")||a.has("target"),path+".command: required unless "+path+".target is supplied");
    }
    static final class Failure extends RuntimeException {
        final String code;final Object facts;
        Failure(String code,String message,Object facts){super(message);this.code=code;this.facts=facts;}
        Map<String,Object> record(){var error=obj("code",code,"message",getMessage());if(facts!=null)error.put("facts",facts);return error;}
    }
    static void check(boolean condition,String code,String message){if(!condition)throw new Failure(code,message,null);}
    Object act(String seat,JsonValue a){
        only(a,"seat","ops");field(a,"ops","array",true);require(a.get("ops").size>0,"ops must not be empty");
        int validationIndex=0;for(JsonValue operation:a.get("ops"))validate(operation,"ops["+(validationIndex++)+"]");
        if(bridge.terminal)throw new Refused("This game has ended, so no input applies");
        if(!bridge.started)throw new Refused("The game has not started");
        ArrayList<Object> results=new ArrayList<>();int index=0;
        for(JsonValue operation:a.get("ops")){
            Object effect=null;Map<String,Object> error=null;
            try{effect=execute(bridge.seats.get(seat),operation);bridge.log.action(seat,operation.getString("op"),operation,effect);}
            catch(Failure failure){error=failure.record();}
            catch(ValidateException failure){error=obj("code","not_accepted","message",failure.getMessage());}
            if(error!=null&&(operation.getString("op").equals("withdraw")||operation.getString("op").equals("deposit")))
                error.putIfAbsent("facts",transferFacts(bridge.seats.get(seat).player,operation));
            results.add(obj("index",index++,"ok",error==null,"effect",effect,"error",error));
        }return obj("results",results);
    }
    static Building building(int id){

        for(Team team:Team.all)for(Building b:team.data().buildings)if(b.id==id)return b;
        throw new Failure("unknown_entity","Unknown building "+id,null);
    }
    static Unit unit(int id){Unit u=Groups.unit.getByID(id);check(u!=null,"unknown_entity","Unknown unit "+id);return u;}
    static void allied(Player p,Team team){check(p.team()==team,"not_allied","Entity is not on the player's team");}
    static Building alliedBuilding(Player p,int id){Building b=building(id);allied(p,b.team);check(!b.block.privileged,"unsupported","Privileged buildings are not player inputs");return b;}
    static Tile tile(String field,int x,int y){Tile t=Vars.world.tile(x,y);if(t==null)throw new Failure("out_of_range",Refusals.outsideWorld(field,x,y),null);return t;}
    static Vec2 position(JsonValue v){return new Vec2(v.getFloat("x")*8,v.getFloat("y")*8);}
    static void inWorld(String field,Vec2 v){if(!(Float.isFinite(v.x)&&Float.isFinite(v.y)&&v.x>=0&&v.y>=0&&v.x<Vars.world.unitWidth()&&v.y<Vars.world.unitHeight()))throw new Failure("out_of_range",Refusals.outsideWorld(field,v.x/8,v.y/8),null);}
    static Object content(ContentType type,String name){Object c=Vars.content.getByName(type,name);check(c!=null,"invalid_args","Unknown "+type+" "+name);return c;}
    static Object decode(JsonValue v,int x,int y){
        if(v==null||v.isNull())return null;if(v.isBoolean())return v.asBoolean();if(v.isString())return v.asString();if(v.isNumber())return v.asInt();
        return switch(v.getString("type")){
            case "item"->content(ContentType.item,v.getString("name"));case "liquid"->content(ContentType.liquid,v.getString("name"));case "block"->content(ContentType.block,v.getString("name"));case "unit"->content(ContentType.unit,v.getString("name"));case "command"->content(ContentType.unitCommand,v.getString("name"));case "stance"->content(ContentType.unitStance,v.getString("name"));
            case "int"->v.getInt("value");case "float"->v.getFloat("value");case "point"->new Point2(v.getInt("x"),v.getInt("y"));case "ints"->v.get("values").asIntArray();case "bytes"->Base64.getDecoder().decode(v.getString("base64"));
            case "points"->{
                Point2[] points=new Point2[v.get("values").size];int i=0;
                for(JsonValue p:v.get("values")){
                    int px=p.getInt("x"),py=p.getInt("y");
                    check(Vars.world.tile(px,py)!=null,"invalid_args","Absolute link tile is outside the world");
                    points[i++]=new Point2(px-x,py-y);
                }yield points;
            }
            case "logic"->{Seq<LogicBlock.LogicLink> links=new Seq<>();for(JsonValue l:v.get("links"))links.add(new LogicBlock.LogicLink(l.getInt("x")-x,l.getInt("y")-y,l.getString("name"),true));yield LogicBlock.compress(v.getString("code"),links);}
            default->throw new IllegalStateException("Unvalidated config");
        };
    }
    static void acceptsConfig(Block block,Object value){
        if(block instanceof PowerNode)check(value instanceof Point2[],"invalid_args","Power links require {type:points,frame:absolute,values:[{x,y},...]}");
        Class<?> type=value==null?void.class:value.getClass().isAnonymousClass()?value.getClass().getSuperclass():value.getClass();
        if(value instanceof Item)type=Item.class;if(value instanceof Liquid)type=Liquid.class;if(value instanceof Block)type=Block.class;if(value instanceof UnitType)type=UnitType.class;
        check(!block.privileged&&block.configurations.containsKey(type),"unsupported","Block does not accept configuration type "+type.getSimpleName());
    }
    static void validatePowerLinks(Building b,Object value){
        if(!(b.block instanceof PowerNode node))return;
        Point2[] points=(Point2[])value;
        check(points.length<=node.maxNodes,"invalid_args","Power links exceed maximum "+node.maxNodes);

        for(int i=0;i<points.length;i++){
            Point2 point=points[i];int x=b.tileX()+point.x,y=b.tileY()+point.y;Building target=Vars.world.build(x,y);
            check(target!=null&&target.tileX()==x&&target.tileY()==y&&node.linkValid(b,target),
                "invalid_args","Illegal absolute power link {x:"+x+",y:"+y+"}: requires a distinct allied power building anchor in native range, with capacity");
            for(int j=0;j<i;j++)check(!point.equals(points[j]),"invalid_args","Power links must contain unique absolute tiles");
        }
    }
    static int planIndex(Unit unit,JsonValue key){return unit.plans.indexOf(p->p.x==key.getInt("x")&&p.y==key.getInt("y")&&p.breaking==key.getBoolean("breaking"));}
    static List<Object> commandState(int[] ids){
        ArrayList<Object> result=new ArrayList<>();
        for(int id:ids){
            CommandAI ai=(CommandAI)unit(id).controller();
            ArrayList<String> stances=new ArrayList<>();
            for(var stance:Vars.content.unitStances())if(ai.hasStance(stance))stances.add(stance.name);
            result.add(obj("id",id,"command",ai.currentCommand().name,"stance",stances,"target",ref(ai.attackTarget!=null?ai.attackTarget:ai.targetPos)));
        }return result;
    }
    Object execute(AgentBridge.Seat seat,JsonValue a){
        Player p=seat.player;check(!p.dead(),"respawning","Player has no live unit");Unit u=p.unit();String op=a.getString("op");
        return switch(op){
            case "input"->{

                JsonValue move=a.get("move"),dest=a.get("move_to"),aimValue=a.get("aim"),mine=a.get("mine");
                float dx=move==null?0:move.getFloat("x"),dy=move==null?0:move.getFloat("y");
                if(move!=null)check(dx*dx+dy*dy<=1.0000001f,"invalid_args","Movement vector magnitude exceeds one");
                Vec2 destination=dest==null||dest.isNull()?null:position(dest);
                if(destination!=null)inWorld("move_to",destination);
                Vec2 aim=aimValue==null?null:position(aimValue);
                if(aim!=null)inWorld("aim",aim);
                Tile mining=mine==null||mine.isNull()?null:tile("mine",mine.getInt("x"),mine.getInt("y"));
                if(mining!=null){check(u.canMine(),"unsupported","Unit cannot mine");

                    if(!u.validMine(mining,false))throw new Failure("not_accepted",Refusals.unmineable(u,mining),mineFacts(u,mining));
                    if(!u.validMine(mining))throw new Failure("out_of_range","Mining tile is "+Refusals.num(u.dst(mining.worldx(),mining.worldy())/8,java.math.RoundingMode.CEILING)+" tiles away; this unit mines within "+Refusals.num(u.type.mineRange/8),mineFacts(u,mining));
                }
                if(move!=null){seat.moveX=seat.moveY=null;seat.moveDx=dx;seat.moveDy=dy;if(dx==0&&dy==0)u.vel.setZero();}
                if(dest!=null){seat.moveDx=seat.moveDy=0;seat.moveX=destination==null?null:destination.x;seat.moveY=destination==null?null:destination.y;if(destination==null)u.vel.setZero();}
                if(aim!=null){p.mouseX=aim.x;p.mouseY=aim.y;}
                if(a.has("shoot"))p.shooting=a.getBoolean("shoot");if(a.has("boost"))p.boosting=a.getBoolean("boost");
                if(a.has("building"))u.updateBuilding(a.getBoolean("building"));
                if(mine!=null)u.mineTile(mining);
                yield obj("move",obj("x",seat.moveDx,"y",seat.moveDy),"move_to",seat.moveX==null?null:obj("x",seat.moveX/8,"y",seat.moveY/8),"aim",obj("x",p.mouseX/8,"y",p.mouseY/8),"shoot",p.shooting,"boost",p.boosting,"building",u.updateBuilding,"mine",u.mineTile==null?null:obj("x",(int)u.mineTile.x,"y",(int)u.mineTile.y));
            }
            case "plan_add"->{
                check(u.canBuild(),"unsupported","Unit cannot build");JsonValue plan=a.get("plan");int x=plan.getInt("x"),y=plan.getInt("y");Tile t=tile("plan",x,y);BuildPlan nativePlan;
                if(plan.getBoolean("breaking",false)){check(Build.validBreak(p.team(),x,y),"invalid_placement","Tile cannot be deconstructed");nativePlan=new BuildPlan(x,y);}
                else{Block b=(Block)content(ContentType.block,plan.getString("block"));int rotation=plan.getInt("rotation",0);check(!b.privileged&&b.isPlaceable()&&b.environmentBuildable()&&b.unlockedNowHost(),"unsupported","Block is unavailable");
                    if(!Build.validPlace(b,p.team(),x,y,rotation))throw new Failure("invalid_placement",Refusals.placement(b,p.team(),x,y,rotation),placementDiagnostics(b,p.team(),t,rotation));
                    Object config=decode(plan.get("config"),x,y);if(config!=null)acceptsConfig(b,config);nativePlan=new BuildPlan(x,y,rotation,b,config);
                }
                u.addBuild(nativePlan);check(u.plans.contains(nativePlan),"not_accepted","Plan was not queued");yield obj("queued",1,"plan",Records.queuedPlan(nativePlan));
            }
            case "plan_remove","plan_prioritize"->{int index=planIndex(u,a.get("key"));check(index>=0,"not_accepted","Plan is not queued");BuildPlan plan=u.plans.removeIndex(index);if(op.equals("plan_prioritize"))u.plans.addFirst(plan);yield obj("plans",u.plans.size,"first",u.plans.isEmpty()?null:Records.plan(u.plans.first()));}
            case "plan_clear"->{int n=u.plans.size;u.clearBuilding();yield obj("removed",n,"plans",u.plans.size);}
            case "rebuild_remove"->{int[] positions=new int[a.get("tiles").size];int i=0;for(JsonValue t:a.get("tiles")){tile("tiles["+i+"]",t.getInt("x"),t.getInt("y"));positions[i++]=Point2.pack(t.getInt("x"),t.getInt("y"));}int before=p.team().data().plans.size;InputHandler.deletePlans(p,positions);yield obj("removed",before-p.team().data().plans.size);}
            case "configure"->{
                Building b=alliedBuilding(p,a.getInt("building"));Object value=decode(a.get("value"),b.tileX(),b.tileY());
                acceptsConfig(b.block,value);validatePowerLinks(b,value);
                Object before=Records.config(b.config(),b.tileX(),b.tileY());InputHandler.tileConfig(p,b,value);
                Object after=Records.config(b.config(),b.tileX(),b.tileY());yield obj("building",b.id,"config",after,"changed",!Records.equal(before,after));
            }
            case "rotate"->{Building b=alliedBuilding(p,a.getInt("building"));check(b.block.rotate,"unsupported","Block is not rotatable");InputHandler.rotateBlock(p,b,a.getBoolean("clockwise"));yield obj("rotation",b.rotation);}
            case "withdraw","deposit"->{
                Building b=alliedBuilding(p,a.getInt("building"));if(!p.within(b,Vars.itemTransferRange))throw new Failure("out_of_range",Refusals.transferRange(p,b),null);
                check(b.items!=null,"unsupported","Building has no item inventory");int before=u.stack.amount;
                if(op.equals("withdraw")){int amount=a.getInt("amount");check(amount>0,"invalid_args","amount must be positive");Item item=(Item)content(ContentType.item,a.getString("item"));check(b.items.get(item)>0,"insufficient_items","Building has none of the requested item");if(u.maxAccepted(item)<=0)throw new Failure("not_accepted",Refusals.unitRefuses(u,item),null);InputHandler.requestItem(p,b,item,amount);check(u.stack.amount>before,"not_accepted","No items were withdrawn");}
                else{check(before>0,"insufficient_items","Unit stack is empty");if(!(b.allowDeposit()&&b.acceptStack(u.item(),before,u)>0))throw new Failure("not_accepted",Refusals.refusedStack(b,u.item()),null);

                    try{InputHandler.transferInventory(p,b);}catch(ValidateException refused){if(p.isLocal()||p.itemDepositRate.occurences<=2)throw refused;var facts=transferFacts(p,a);throw new Failure("not_accepted",Refusals.depositCooldown(facts.get("cooldown_remaining_ms")),facts);}
                    check(u.stack.amount<before,"not_accepted","No items were deposited");}
                yield obj("stack",stack(u),"transferred",Math.abs(u.stack.amount-before));
            }
            case "discard"->{check(u.stack.amount>0,"insufficient_items","Unit stack is empty");InputHandler.dropItem(p,a.getFloat("angle",0));yield obj("stack",stack(u));}
            case "control"->{
                JsonValue target=a.get("target");Unit before=p.unit();
                if(target.isNull())InputHandler.unitClear(p);
                else if(target.getString("kind").equals("unit")){Unit other=unit(target.getInt("id"));allied(p,other.team);check(other.isAI()&&other.playerControllable(),"not_accepted","Unit is not available for player control");InputHandler.unitControl(p,other);check(p.unit()==other,"not_accepted","Unit control did not change");}
                else{
                    Building b=alliedBuilding(p,target.getInt("id"));
                    if(b instanceof ControlBlock control){
                        check(control.canControl(),"not_accepted","Building cannot be controlled");
                        Unit other=control.unit();
                        check(other.isAI()&&other.playerControllable(),"not_accepted","Building is not available for player control");
                        InputHandler.unitControl(p,other);check(p.unit()==other,"not_accepted","Building control did not change");
                    }else{
                        check(b.canControlSelect(u),"not_accepted","Building cannot be selected by this unit");
                        InputHandler.buildingControlSelect(p,b);check(p.unit()!=before||!before.isAdded(),"not_accepted","Building selection did not change control");
                    }
                }
                seat.release();yield obj("unit_id",p.dead()?null:p.unit().id);
            }
            case "command","stance"->{
                int[] ids=a.get("units").asIntArray();check(ids.length>0,"invalid_args","units must not be empty");
                for(int id:ids){Unit other=unit(id);allied(p,other.team);if(!(other.controller() instanceof CommandAI))throw new Failure("unsupported",Refusals.uncommandable(other),null);}
                if(op.equals("stance")){UnitStance stance=(UnitStance)content(ContentType.unitStance,a.getString("stance"));for(int id:ids)check(stance==UnitStance.stop||unit(id).type.allowStance(unit(id),stance),"unsupported","Unit does not support stance");InputHandler.setUnitStance(p,ids,stance,a.getBoolean("enabled"));}
                else{
                    UnitCommand command=a.has("command")?(UnitCommand)content(ContentType.unitCommand,a.getString("command")):null;
                    if(command!=null)for(int id:ids)check(unit(id).type.allowCommand(unit(id),command),"unsupported","Unit does not support command");
                    Building b=null;Unit other=null;Vec2 point=null;
                    if(a.has("target")){JsonValue target=a.get("target");
                        if(!target.has("kind")){point=position(target);inWorld("target",point);}else if(target.getString("kind").equals("unit")){other=unit(target.getInt("id"));point=new Vec2(other.x,other.y);}else{b=building(target.getInt("id"));point=new Vec2(b.x,b.y);}
                    }
                    if(command!=null)InputHandler.setUnitCommand(p,ids,command);
                    if(a.has("target")){
                        boolean queue=a.getBoolean("queue",false);int[] before=new int[ids.length];for(int i=0;i<ids.length;i++)before[i]=((CommandAI)unit(ids[i]).controller()).commandQueue.size;
                        InputHandler.commandUnits(p,ids,b,other,point,queue,true);
                        for(int i=0;i<ids.length;i++){CommandAI ai=(CommandAI)unit(ids[i]).controller();check(queue?ai.commandQueue.size>before[i]||before[i]==0&&(ai.targetPos!=null||ai.attackTarget!=null):ai.targetPos!=null||ai.attackTarget!=null,"not_accepted","Native command target was not retained");}
                    }
                }yield obj("units",commandState(ids));
            }
            case "rally"->{int[] ids=a.get("buildings").asIntArray(),positions=new int[ids.length];check(ids.length>0,"invalid_args","buildings must not be empty");Vec2 target=position(a.get("target"));inWorld("target",target);for(int i=0;i<ids.length;i++){Building b=alliedBuilding(p,ids[i]);check(b.isCommandable(),"unsupported","Building is not commandable");positions[i]=b.pos();}InputHandler.commandBuilding(p,positions,target);ArrayList<Object> rows=new ArrayList<>();for(int id:ids){Building b=building(id);check(b.getCommandPosition()!=null,"not_accepted","Rally position was not retained");rows.add(obj("id",id,"target",ref(b.getCommandPosition())));}yield obj("buildings",rows);}
            case "payload_pickup","payload_drop"->{
                check(u instanceof Payloadc,"unsupported","Unit cannot carry payloads");Payloadc pay=(Payloadc)u;int before=pay.payloads().size;
                if(op.equals("payload_drop")){check(before>0,"not_accepted","Unit has no payload");Vec2 at=position(a.get("at"));inWorld("at",at);check(u.within(at,4*8),"out_of_range","Payload drop is outside the native four-tile margin");InputHandler.requestDropPayload(p,at.x,at.y);check(pay.payloads().size<before,"not_accepted","Payload was not dropped");}
                else{JsonValue target=a.get("target");if(target.getString("kind").equals("unit")){Unit other=unit(target.getInt("id"));allied(p,other.team);check(other.within(u,u.type.hitSize*2+other.type.hitSize*2),"out_of_range","Unit is outside native payload pickup range");check(other.isAI()&&other.isGrounded()&&pay.canPickup(other),"not_accepted","Unit is not an eligible payload");InputHandler.requestUnitPayload(p,other);}else{Building b=alliedBuilding(p,target.getInt("id"));check(u.within(b,8*b.block.size*1.2f+8*5),"out_of_range","Building is outside native payload pickup range");InputHandler.requestBuildPayload(p,b);}check(pay.payloads().size>before,"not_accepted","Payload was not picked up");}
                yield obj("payload_count",pay.payloads().size);
            }
            case "ping"->{Vec2 at=position(a.get("at"));inWorld("at",at);String text=a.getString("text",null);check(text==null||text.length()<=Vars.maxPingTextLength,"invalid_args","Text exceeds native ping length");InputHandler.pingLocation(p,at.x,at.y,text);

                p.pingX=at.x;p.pingY=at.y;p.pingTime=1;p.pingText=text;Call.pingLocation(p,at.x,at.y,text);
                yield obj("at",obj("x",p.pingX/8,"y",p.pingY/8),"text",p.pingText);
            }
            default->throw new IllegalStateException("Unvalidated operation");
        };
    }
    static long depositCooldownRemaining(Player p){
        if(!Vars.net.server()||p.isLocal()||p.itemDepositRate.occurences<2)return 0;

        long window=(long)(Vars.state.rules.itemDepositCooldown*1000*2);
        return Math.max(0,window-Time.timeSinceMillis(p.itemDepositRate.lastTime)+1);
    }

    Map<String,Object> transferFacts(Player p,JsonValue a){
        Unit u=p.unit();Building b=null;
        try{b=building(a.getInt("building"));}catch(Failure ignored){                                                   }
        boolean withdraw=a.getString("op").equals("withdraw");
        String name=withdraw?a.getString("item"):u==null||u.item()==null?null:u.item().name;
        Item item=name==null?null:(Item)Vars.content.getByName(ContentType.item,name);
        int amount=withdraw?a.getInt("amount"):u==null?0:u.stack.amount;
        var facts=obj("stack",u==null?null:stack(u),"item",name,"requested_amount",amount,
            "building_exists",b!=null,"range_tiles",Vars.itemTransferRange/8);
        if(u!=null&&item!=null)facts.put("unit_accepts_amount",u.maxAccepted(item));
        if(b!=null){
            facts.putAll(obj("distance_tiles",p.dst(b)/8,"has_inventory",b.items!=null,"allow_deposit",b.allowDeposit()));
            if(item!=null){
                facts.put("building_items",b.items==null?0:b.items.get(item));
                facts.put("building_accepts_item",b.items!=null&&b.acceptItem(b,item));
                if(u!=null){
                    facts.put("building_accepts_amount",b.items==null?0:b.acceptStack(item,amount,u));
                }
            }
        }
        if(!withdraw&&Vars.net.server()&&!p.isLocal())facts.put("cooldown_remaining_ms",depositCooldownRemaining(p));
        return facts;
    }

    Object mineFacts(Unit u,Tile t){
        Item floorDrop=t.drop(),wallDrop=t.wallDrop(),result=u.getMineResult(t);
        return obj("tile",obj("x",(int)t.x,"y",(int)t.y),"block",t.block().name,"floor",t.floor().name,"overlay",t.overlay().name,
            "floor_drop",floorDrop==null?null:obj("item",floorDrop.name,"hardness",floorDrop.hardness),
            "wall_drop",wallDrop==null?null:obj("item",wallDrop.name,"hardness",wallDrop.hardness),
            "mine_result",result==null?null:result.name,
            "unit",obj("type",u.type.name,"mine_tier",u.type.mineTier,"mine_floor",u.type.mineFloor,"mine_walls",u.type.mineWalls,
                "mine_range_tiles",u.type.mineRange/8,"stack",stack(u),"accepts_result",result!=null&&u.acceptsItem(result)),
            "distance_tiles",u.dst(t.worldx(),t.worldy())/8);
    }
    Object placementDiagnostics(Block b,Team team,Tile t,int rotation){
        ArrayList<Object> footprint=new ArrayList<>();
        for(int dx=0;dx<b.size;dx++)for(int dy=0;dy<b.size;dy++){
            int x=t.x+b.sizeOffset+dx,y=t.y+b.sizeOffset+dy;Tile cell=Vars.world.tile(x,y);
            footprint.add(cell==null?obj("x",x,"y",y,"outside_map",true):obj("x",x,"y",y,"floor",cell.floor().name,"floor_placeable",cell.floor().placeableOn,"overlay",cell.overlay().name,"block",cell.block().name,"team",cell.team().name));
        }
        boolean ignoringUnits=Build.validPlaceIgnoreUnits(b,team,t.x,t.y,rotation,true,true);
        boolean ignoringProtection=Build.validPlaceIgnoreUnits(b,team,t.x,t.y,rotation,true,false);
        return obj("block",b.name,"size",b.size,"footprint_offset",b.sizeOffset,"footprint",footprint,
            "block_can_place_on",b.canPlaceOn(t,team,rotation),"no_unit_overlap",Build.checkNoUnitOverlap(b,t.x,t.y),
            "valid_ignoring_units",ignoringUnits,"valid_ignoring_units_and_core_protection",ignoringProtection,
            "core_protection_blocks",!ignoringUnits&&ignoringProtection,"polygon_core_protection",Vars.state.rules.polygonCoreProtection,
            "enemy_core_build_radius_tiles",Vars.state.rules.enemyCoreBuildRadius/8);
    }
}
