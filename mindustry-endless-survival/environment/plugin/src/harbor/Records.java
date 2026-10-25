// SPDX-License-Identifier: GPL-3.0-only

package harbor;

import arc.math.geom.Point2;
import arc.math.geom.Vec2;
import arc.util.serialization.JsonValue;
import mindustry.Vars;
import mindustry.ai.types.CommandAI;
import mindustry.ai.types.LogicAI;
import mindustry.ctype.*;
import mindustry.entities.units.BuildPlan;
import mindustry.world.Build;
import mindustry.content.Blocks;
import mindustry.world.blocks.ConstructBlock.ConstructBuild;
import mindustry.game.Team;
import mindustry.gen.*;
import mindustry.logic.*;
import mindustry.type.*;
import mindustry.world.*;
import mindustry.world.blocks.ControlBlock;
import mindustry.world.blocks.environment.Floor;
import mindustry.world.blocks.environment.OverlayFloor;
import java.util.*;
import static harbor.HarborBridge.*;

class Records {
    final HarborBridge bridge;
    static final Object MISSING=new Object();
    static final List<String> NAMES=List.of("collections","match","players","teams","units","buildings","production","tiles","bullets","blocks","unit_types","items","liquids","ops");
    static final Map<LAccess,String> SENSOR_NAMES=new EnumMap<>(LAccess.class);
    static {for(LAccess access:LAccess.senseable)if(access!=LAccess.color)SENSOR_NAMES.put(access,snake(access.name()));}
    Records(HarborBridge bridge){this.bridge=bridge;}
    static String snake(String name){return name.replaceAll("([a-z0-9])([A-Z])","$1_$2").toLowerCase(Locale.ROOT);}
    static void only(JsonValue a,String... names){
        require(a!=null&&a.isObject(),"Arguments must be an object");
        Set<String> allowed=new HashSet<>(Arrays.asList(names));
        Set<String> seen=new HashSet<>();
        for(JsonValue child:a){require(allowed.contains(child.name),"Unknown field "+child.name);require(seen.add(child.name),"Duplicate field "+child.name);}
    }

    static String show(JsonValue v){return json(plain(v));}
    static boolean integer(JsonValue v){return v!=null&&v.isNumber()&&Double.isFinite(v.asDouble())&&v.asDouble()==v.asLong()&&v.asDouble()>=Integer.MIN_VALUE&&v.asDouble()<=Integer.MAX_VALUE;}
    static boolean number(JsonValue v){return v!=null&&v.isNumber()&&Double.isFinite(v.asDouble());}
    static void field(JsonValue a,String name,String type,boolean required){
        JsonValue v=a.get(name);if(v==null){require(!required,"Missing "+name);return;}
        boolean valid=switch(type){case "string"->v.isString();case "boolean"->v.isBoolean();case "object"->v.isObject();case "array"->v.isArray();case "int"->integer(v);case "number"->number(v);case "json"->true;default->throw new IllegalStateException(type);};
        require(valid,name+" must be "+type);
    }
    static Object plain(JsonValue v){
        if(v==null||v.isNull())return null;
        if(v.isString())return v.asString();if(v.isBoolean())return v.asBoolean();
        if(v.isNumber()){require(number(v),"JSON numbers must be finite");return v.isLong()?(Object)v.asLong():v.asDouble();}
        if(v.isArray()){ArrayList<Object> out=new ArrayList<>();for(JsonValue child:v)out.add(plain(child));return out;}
        LinkedHashMap<String,Object> out=new LinkedHashMap<>();for(JsonValue child:v)out.put(child.name,plain(child));return out;
    }
    static List<String> fields(JsonValue value){
        if(value==null)return null;
        require(value.isArray(),"fields must be an array");ArrayList<String> out=new ArrayList<>();
        for(JsonValue v:value){require(v.isString()&&v.asString().matches("[^.]+(\\.[^.]+)*"),"fields must contain dotted paths");out.add(v.asString());}return out;
    }
    static boolean wholeNumber(JsonValue value){
        return value!=null&&value.isNumber()&&Double.isFinite(value.asDouble())&&value.asDouble()==Math.rint(value.asDouble());
    }
    static double limit(JsonValue a){
        if(!a.has("limit"))return 128;
        JsonValue value=a.get("limit");
        require(wholeNumber(value)&&value.asDouble()>=1,"limit must be a positive integer");
        return value.asDouble();
    }
    record Predicate(String[] path,String op,Object expected){}
    static final List<String> FILTER_OPS=List.of("eq","ne","in","not_in","lt","le","gt","ge","contains");

    static List<Predicate> filter(JsonValue value,String where){
        if(value==null)return List.of();require(value.isArray(),where+": expected an array of [path, op, value]");
        ArrayList<Predicate> out=new ArrayList<>();int index=0;
        for(JsonValue predicate:value){
            String at=where+"["+(index++)+"]";
            require(predicate.isArray()&&predicate.size==3,at+": expected [path, op, value]");
            JsonValue path=predicate.get(0),op=predicate.get(1),v=predicate.get(2);
            require(path.isString()&&path.asString().matches("[^.]+(\\.[^.]+)*"),at+": the path must be field names joined by dots");
            require(op.isString()&&FILTER_OPS.contains(op.asString()),at+": op "+show(op)+" is not one of "+list(FILTER_OPS));
            if(op.asString().equals("in")||op.asString().equals("not_in"))require(v.isArray(),at+": "+op.asString()+" needs an array value");
            if(List.of("lt","le","gt","ge").contains(op.asString()))require(number(v),at+": "+op.asString()+" needs a finite number");
            out.add(new Predicate(path.asString().split("\\."),op.asString(),plain(v)));
        }return out;
    }

    static final Map<String,Map<String,String>> NAMED=Map.of(
        "units",Map.of("type","unit type","team","team","stack.item","item"),
        "buildings",Map.of("type","block","team","team"),
        "bullets",Map.of("team","team"),
        "tiles",Map.of("floor","floor","ore","ore","block","block","team","team"),
        "blocks",Map.of("name","block"),
        "unit_types",Map.of("name","unit type"),
        "items",Map.of("name","item"),
        "liquids",Map.of("name","liquid"));
    static final Map<String,Set<String>> KNOWN=new HashMap<>();
    static Set<String> known(String kind){
        return KNOWN.computeIfAbsent(kind,k->{
            LinkedHashSet<String> names=new LinkedHashSet<>();
            switch(k){
                case "team"->{for(Team t:Team.all)names.add(t.name);}
                case "unit type"->{for(UnitType u:Vars.content.units())names.add(u.name);}
                case "item"->{for(Item i:Vars.content.items())names.add(i.name);}
                case "liquid"->{for(Liquid l:Vars.content.liquids())names.add(l.name);}
                case "floor"->{for(Block b:Vars.content.blocks())if(b instanceof Floor&&!(b instanceof OverlayFloor))names.add(b.name);}
                case "ore"->{for(Block b:Vars.content.blocks())if(b instanceof OverlayFloor)names.add(b.name);}
                default->{for(Block b:Vars.content.blocks())names.add(b.name);}
            }
            return names;
        });
    }
    static void knownNames(String of,List<Predicate> predicates){
        Map<String,String> named=NAMED.getOrDefault(of,Map.of());
        for(int i=0;i<predicates.size();i++){
            Predicate p=predicates.get(i);String kind=named.get(String.join(".",p.path()));
            if(kind==null||!List.of("eq","ne","in","not_in").contains(p.op()))continue;
            for(Object value:p.expected() instanceof List<?> values?values:Collections.singletonList(p.expected())){
                if(!(value instanceof String name)||known(kind).contains(name))continue;
                List<String> near=known(kind).stream().filter(other->other.contains(name)).toList();
                require(false,"filter["+i+"]: no "+kind+" is named \""+name+"\""+(near.isEmpty()?"":"; the "+kind+" names containing it are "+list(near)));
            }
        }
    }
    static Object path(Object object,String[] path){
        for(String part:path){if(!(object instanceof Map<?,?> map)||!map.containsKey(part))return MISSING;object=map.get(part);}return object;
    }
    static boolean equal(Object a,Object b){
        if(a instanceof Number x&&b instanceof Number y)return x.doubleValue()==y.doubleValue();
        if(a instanceof List<?> x&&b instanceof List<?> y){if(x.size()!=y.size())return false;for(int i=0;i<x.size();i++)if(!equal(x.get(i),y.get(i)))return false;return true;}
        if(a instanceof Map<?,?> x&&b instanceof Map<?,?> y){if(!x.keySet().equals(y.keySet()))return false;for(Object k:x.keySet())if(!equal(x.get(k),y.get(k)))return false;return true;}
        return Objects.equals(a,b);
    }
    static boolean matches(Map<String,Object> row,List<Predicate> predicates){
        for(Predicate p:predicates){Object v=path(row,p.path);if(v==MISSING)return false;
            boolean match=switch(p.op){
                case "eq"->equal(v,p.expected);
                case "ne"->!equal(v,p.expected);
                case "in"->((List<?>)p.expected).stream().anyMatch(e->equal(v,e));
                case "not_in"->((List<?>)p.expected).stream().noneMatch(e->equal(v,e));
                case "contains"->v instanceof List<?> list?list.stream().anyMatch(e->equal(e,p.expected)):v instanceof String s&&p.expected instanceof String t&&s.contains(t);
                default->{if(!(v instanceof Number n))yield false;double x=n.doubleValue(),y=((Number)p.expected).doubleValue();yield switch(p.op){case "lt"->x<y;case "le"->x<=y;case "gt"->x>y;case "ge"->x>=y;default->false;};}
            };if(!match)return false;
        }return true;
    }
    static Map<String,Object> project(Map<String,Object> row,List<String> fields){
        if(fields==null)return row;
        LinkedHashMap<String,Object> out=new LinkedHashMap<>();
        for(String field:fields){String[] parts=field.split("\\.");Object value=path(row,parts);if(value==MISSING)continue;
            Map<String,Object> target=out;
            for(int i=0;i<parts.length-1;i++){
                Object child=target.get(parts[i]);
                if(!(child instanceof Map<?,?>)){child=new LinkedHashMap<String,Object>();target.put(parts[i],child);}

                @SuppressWarnings("unchecked") Map<String,Object> copy=new LinkedHashMap<>((Map<String,Object>)child);
                target.put(parts[i],copy);target=copy;
            }target.put(parts[parts.length-1],value);
        }return out;
    }
    static boolean matchesId(int id,List<Predicate> predicates){
        for(Predicate p:predicates){
            if(p.path.length!=1||!p.path[0].equals("id"))continue;
            if(p.op.equals("eq")){
                if(!(p.expected instanceof Number n)||n.doubleValue()!=id)return false;
            }else if(p.op.equals("in")){
                boolean found=false;
                for(Object value:(List<?>)p.expected)if(value instanceof Number n&&n.doubleValue()==id){found=true;break;}
                if(!found)return false;
            }
        }return true;
    }
    static boolean inArea(double px,double py,double x,double y,double w,double h){
        return px>=x&&px<x+w&&py>=y&&py<y+h;
    }
    Object query(String seat,JsonValue a){
        only(a,"seat","of","filter","area","fields","limit","after");field(a,"of","string",true);
        String of=a.getString("of");require(NAMES.contains(of),"of: \""+of+"\" is not one of "+list(NAMES));
        List<Predicate> filter=filter(a.get("filter"),"filter");knownNames(of,filter);List<String> fields=fields(a.get("fields"));double limit=limit(a);
        if(a.has("after"))require(wholeNumber(a.get("after")),"after must be an integer");
        double after=a.has("after")?a.getDouble("after"):-Double.MAX_VALUE;
        JsonValue area=a.get("area");double x=0,y=0,w=0,h=0;
        if(area!=null){only(area,"x","y","w","h");for(String k:List.of("x","y","w","h"))field(area,k,"number",true);x=area.getDouble("x");y=area.getDouble("y");w=area.getDouble("w");h=area.getDouble("h");require(w>=0&&h>=0,"Area dimensions must be nonnegative");}
        Team team=bridge.seats.get(seat).player.team();
        ArrayList<Object> candidates=new ArrayList<>();
        switch(of){
            case "collections"->candidates.addAll(NAMES);
            case "match"->candidates.add("match");
            case "players"->candidates.addAll(bridge.seats.keySet());
            case "teams"->{for(Team t:Team.all)if(t.active())candidates.add(t);}

            case "units"->{for(Unit u:Groups.unit)if(u.isValid()&&u.id>after&&matchesId(u.id,filter)&&(area==null||inArea(u.x/8,u.y/8,x,y,w,h)))candidates.add(u);}
            case "production"->candidates.addAll(bridge.production.records(team));
            case "buildings"->{for(Team t:Team.all)for(Building b:t.data().buildings)if(b.id>after&&matchesId(b.id,filter)&&(area==null||inArea(b.tileX(),b.tileY(),x,y,w,h)))candidates.add(b);}
            case "bullets"->{for(Bullet b:Groups.bullet)if(b.id>after&&matchesId(b.id,filter)&&(area==null||inArea(b.x/8,b.y/8,x,y,w,h)))candidates.add(b);}
            case "blocks"->{for(Block b:Vars.content.blocks())if(b.isVisible())candidates.add(b);}
            case "unit_types"->{for(UnitType u:Vars.content.units())candidates.add(u);}
            case "items"->{for(Item i:Vars.content.items())candidates.add(i);}
            case "liquids"->{for(Liquid l:Vars.content.liquids())candidates.add(l);}
            case "ops"->candidates.addAll(bridge.inputs.table.keySet());
        }
        boolean tiles=of.equals("tiles");
        if(!tiles)candidates.sort(Comparator.comparingInt(candidate->candidateKey(of,candidate)));
        ArrayList<Object> rows=new ArrayList<>();Integer last=null,next=null;
        int width=Vars.world.width(),height=Vars.world.height();
        int x0=0,y0=0,x1=width,y1=height,begin=0,count=candidates.size();
        if(tiles){
            if(area!=null){
                x0=(int)Math.max(0,Math.min(width,Math.ceil(x)));x1=(int)Math.max(0,Math.min(width,Math.ceil(x+w)));
                y0=(int)Math.max(0,Math.min(height,Math.ceil(y)));y1=(int)Math.max(0,Math.min(height,Math.ceil(y+h)));
            }
            count=(x1-x0)*(y1-y0);
            int firstKey=(int)Math.max(0,Math.min(width*height,after+1));
            int firstRow=Math.max(y0,Math.min(y1,firstKey/width));
            begin=(firstRow-y0)*(x1-x0);
            if(firstRow==firstKey/width)begin+=Math.max(0,Math.min(x1-x0,firstKey%width-x0));
        }
        for(int i=begin;i<count;i++){
            int candidateKey=tiles?(y0+i/(x1-x0))*width+x0+i%(x1-x0):candidateKey(of,candidates.get(i));
            if(candidateKey<=after||!matchesId(candidateKey,filter))continue;
            Object candidate=tiles?Vars.world.tile(candidateKey%width,candidateKey/width):candidates.get(i);
            Map<String,Object> row=row(of,candidate,team);
            row.put("id",candidateKey);
            if(of.equals("players")&&seat.equals(candidate))row.put("deposit_cooldown_remaining_ms",Inputs.depositCooldownRemaining(bridge.seats.get(seat).player));
            if(area!=null){if(!(row.get("x") instanceof Number rx)||!(row.get("y") instanceof Number ry)||rx.doubleValue()<x||rx.doubleValue()>=x+w||ry.doubleValue()<y||ry.doubleValue()>=y+h)continue;}
            if(!matches(row,filter))continue;
            if(rows.size()==limit){next=last;break;}
            rows.add(project(row,fields));last=candidateKey;
        }
        return obj("rows",rows,"next",next,"tick",Vars.state.updateId,"at",bridge.log.head(seat));
    }
    int candidateKey(String of,Object candidate){
        if(candidate instanceof ProductionTelemetry.Meter meter)return meter.id;
        if(candidate instanceof Entityc entity)return entity.id();
        if(candidate instanceof Content content)return content.id;
        if(candidate instanceof Team team)return team.id;
        return switch(of){
            case "collections"->NAMES.indexOf(candidate);
            case "match"->0;
            case "players"->bridge.seats.get(candidate).player.id;
            case "ops"->bridge.inputs.table.get(candidate).id();
            default->throw new IllegalStateException("No key for "+of);
        };
    }
    Map<String,Object> row(String of,Object candidate,Team team){
        return switch(of){
            case "collections"->collection((String)candidate);
            case "match"->{
                ArrayList<Object> weather=new ArrayList<>();
                for(WeatherState s:Groups.weather)weather.add(obj("type",s.weather.name,"intensity",s.intensity,"life",s.life));
                yield obj("name","match","t",bridge.time(),"tick",Vars.state.updateId,"game_mode",bridge.mode,
                    "map",Vars.state.map.plainName(),"width",Vars.world.width(),"height",Vars.world.height(),
                    "wave",Vars.state.wave,"waves_completed",bridge.wavesCompleted,"wave_time",Vars.state.wavetime/60,
                    "rules",obj("pvp",Vars.state.rules.pvp,"waves",Vars.state.rules.waves,
                        "infinite_resources",Vars.state.rules.infiniteResources,"build_cost_multiplier",Vars.state.rules.buildCostMultiplier,
                        "polygon_core_protection",Vars.state.rules.polygonCoreProtection,"enemy_core_build_radius",Vars.state.rules.enemyCoreBuildRadius/8),
                    "weather",weather,"production_telemetry",bridge.production.coverage());
            }
            case "players"->{Player p=bridge.seats.get(candidate).player;yield obj("seat",candidate,"team",p.team().name,"unit_id",p.dead()?null:p.unit().id,"dead",p.dead());}
            case "teams"->{
                Team t=(Team)candidate;ArrayList<Object> cores=new ArrayList<>();for(var core:t.cores())cores.add(core.id);
                var out=obj("name",t.name,"id",t.id,"cores",cores);
                if(t==team){
                    ArrayList<Object> plans=new ArrayList<>();
                    for(var plan:t.data().plans)if(!plan.block.privileged)
                        plans.add(obj("x",plan.x,"y",plan.y,"block",plan.block.name,"rotation",plan.rotation,"config",config(plan.config,plan.x,plan.y)));
                    out.put("plans",plans);
                }
                yield out;
            }
            case "units"->unit((Unit)candidate,team);
            case "production"->((ProductionTelemetry.Meter)candidate).row();
            case "buildings"->{
                Building b=(Building)candidate;var record=building(b,team);
                if(b.team==team)record.put("production",bridge.production.building(b));
                yield record;
            }
            case "bullets"->{Bullet b=(Bullet)candidate;var out=sensors(b);out.putAll(obj("id",b.id,"kind","bullet","type",b.type.id,"team",b.team.name,"x",b.x/8,"y",b.y/8));yield out;}
            case "tiles"->{Tile t=(Tile)candidate;yield obj("id",t.y*Vars.world.width()+t.x,"x",t.x,"y",t.y,"floor",t.floor().name,"ore",t.overlay()==mindustry.content.Blocks.air?null:t.overlay().name,"block",t.block().name,"team",t.team().name,"building",t.build==null?null:t.build.id);}
            case "blocks"->block((Block)candidate);
            case "unit_types"->unitType((UnitType)candidate);
            case "items"->{Item i=(Item)candidate;yield obj("name",i.name,"description",CatalogText.description(i),"hardness",i.hardness,"cost",i.cost,"flammability",i.flammability,"explosiveness",i.explosiveness,"radioactivity",i.radioactivity,"charge",i.charge);}
            case "liquids"->{Liquid l=(Liquid)candidate;yield obj("name",l.name,"description",CatalogText.description(l),"temperature",l.temperature,"heat_capacity",l.heatCapacity,"viscosity",l.viscosity,"flammability",l.flammability,"explosiveness",l.explosiveness);}
            case "ops"->bridge.inputs.table.get(candidate).record();
            default->throw new IllegalArgumentException("Unknown collection "+of);
        };
    }
    Map<String,Object> collection(String name){
        LinkedHashSet<String> fields=new LinkedHashSet<>(switch(name){
            case "collections"->List.of("name","key","fields");case "match"->List.of("name","t","tick","game_mode","map","width","height","wave","waves_completed","wave_time","rules","weather","production_telemetry");
            case "production"->List.of("id","building_id","type","kind","team","x","y","supported","active","start_simulation_seconds","start_game_seconds","end_simulation_seconds","observed_simulation_seconds","recipe","native_efficiency","output","first_output_simulation_seconds","output_per_simulation_second","potential_output","cycle_utilization","output_utilization","seconds","belt");
            case "players"->List.of("seat","team","unit_id","dead","deposit_cooldown_remaining_ms");case "teams"->List.of("name","id","cores","plans");case "tiles"->List.of("id","x","y","floor","ore","block","team","building");
            case "ops"->List.of("name","fields","description");case "blocks"->List.of("name","localized_name","description","size","footprint_offset","health","category","cost","build_time","placeable","environment_buildable","config_types","mechanics");
            case "unit_types"->List.of("name","description","speed","health","armor","flying","build_speed","build_range_tiles","mine_tier","mine_range_tiles","mine_floor","mine_walls","item_capacity","weapons","commands");
            case "items"->List.of("name","description","hardness","cost","flammability","explosiveness","radioactivity","charge");case "liquids"->List.of("name","description","temperature","heat_capacity","viscosity","flammability","explosiveness");
            default->List.of("id","kind","type","team","x","y");
        });
        fields.add("id");
        if(List.of("units","buildings","bullets").contains(name))fields.addAll(SENSOR_NAMES.values());
        if(name.equals("units"))fields.addAll(List.of("stack","plans","command","stance","target"));
        if(name.equals("buildings"))fields.addAll(List.of("footprint","items","liquids","power_links","power_links_frame","production"));
        return obj("name",name,"key","id","fields",fields);
    }
    static LinkedHashMap<String,Object> sensors(Senseable entity){
        LinkedHashMap<String,Object> out=new LinkedHashMap<>();
        for(var sensor:SENSOR_NAMES.entrySet()){

            if(sensor.getKey()==LAccess.config&&entity instanceof Building)continue;
            Object value=entity.senseObject(sensor.getKey());
            if(value==Senseable.noSensed)value=entity.sense(sensor.getKey());
            value=sensorValue(value);
            if(value!=null)out.put(sensor.getValue(),value);
        }return out;
    }
    static Object sensorValue(Object value){
        if(value==null||value instanceof Boolean||value instanceof String)return value;
        if(value instanceof Number n)return Double.isFinite(n.doubleValue())?value:null;
        if(value instanceof MappableContent c)return c.name;if(value instanceof Content c)return c.id;
        if(value instanceof Entityc entity)return entity.id();if(value instanceof Team t)return t.name;
        return null;
    }
    static Object ref(Object value){
        if(value==null)return null;
        if(value instanceof Building b)return obj("id",b.id,"type",b.block.name,"team",b.team.name,"x",b.tileX(),"y",b.tileY());
        if(value instanceof Unit u)return obj("id",u.id,"type",u.type.name,"team",u.team.name,"x",u.x/8,"y",u.y/8);
        if(value instanceof Tile t)return obj("id",t.y*Vars.world.width()+t.x,"type",t.block().name,"team",t.team().name,"x",t.x,"y",t.y);
        if(value instanceof Player p)return obj("id",p.id,"name",p.name,"team",p.team().name);
        if(value instanceof Vec2 p)return obj("x",p.x/8,"y",p.y/8);
        throw new IllegalArgumentException("Unsupported reference "+value.getClass().getSimpleName());
    }

    static LinkedHashMap<String,Object> items(Building b){
        LinkedHashMap<String,Object> items=new LinkedHashMap<>();
        if(b.items!=null)for(Item item:Vars.content.items()){double n=b.sense(item);if(n!=0&&Double.isFinite(n))items.put(item.name,n);}
        return items;
    }
    static Object stack(Unit u){return obj("item",u.stack.item==null?null:u.stack.item.name,"amount",u.stack.amount);}
    static Map<String,Object> queuedPlan(BuildPlan plan){
        var out=obj("x",plan.x,"y",plan.y,"breaking",plan.breaking,"block",plan.block==null?null:plan.block.name,"rotation",plan.rotation);
        if(plan.config!=null)out.put("config",config(plan.config,plan.x,plan.y));
        return out;
    }

    static final java.lang.reflect.Field CONSTRUCTION_ITEMS_LEFT=constructionItemsLeftField();
    static java.lang.reflect.Field constructionItemsLeftField(){
        try{var field=ConstructBuild.class.getDeclaredField("itemsLeft");field.setAccessible(true);return field;}
        catch(ReflectiveOperationException e){throw new IllegalStateException("Native construction resource layout changed",e);}
    }
    static int[] constructionItemsLeft(ConstructBuild build){
        try{return (int[])CONSTRUCTION_ITEMS_LEFT.get(build);}
        catch(IllegalAccessException e){throw new IllegalStateException("Cannot inspect native construction resources",e);}
    }
    static Map<String,Object> plan(Unit unit,BuildPlan plan){
        var out=queuedPlan(plan);if(plan.config==null)out.put("config",null);
        Tile tile=plan.tile();
        ConstructBuild build=tile!=null&&tile.build instanceof ConstructBuild cb?cb:null;
        boolean matching=build!=null&&(tile.team()==unit.team||tile.team()==Team.derelict)
            &&(plan.breaking||(build.current==plan.block&&build.tile==tile));
        boolean complete=tile!=null&&(plan.breaking?tile.block()==Blocks.air:
            tile.team()!=Team.derelict&&((tile.block()==plan.block&&(!plan.block.rotate||tile.build!=null&&tile.build.rotation==plan.rotation))
            ||plan.block.isOverlay()&&tile.overlay()==plan.block||plan.block.isFloor()&&tile.floor()==plan.block));
        Float progress=null;
        if(matching)progress=Math.max(0f,Math.min(1f,build.progress));
        else if(complete)progress=plan.breaking?0f:1f;
        else if(!plan.initialized)progress=plan.breaking?1f:0f;
        var reasons=new ArrayList<String>();
        var core=unit.core();
        boolean infinite=Vars.state.rules.infiniteResources||unit.team.rules().infiniteResources;
        if(!complete){
            if(!unit.updateBuilding)reasons.add("building_disabled");
            if(!unit.canBuild()||Vars.state.rules.buildSpeed(unit.team)<=0)reasons.add("build_speed_zero");
            if(tile==null)reasons.add("invalid_target");
            else if(!Vars.state.rules.infiniteResources&&!unit.within(tile,unit.type.buildRange))reasons.add("out_of_range");
            if(core==null&&!infinite)reasons.add("no_core");
            boolean allowed=plan.block!=null&&(Vars.state.isEditor()||(Vars.state.rules.waves&&unit.team==Vars.state.rules.waveTeam&&plan.block.isVisible())
                ||plan.block.unlockedNowHost()&&plan.block.environmentBuildable()&&plan.block.isPlaceable());
            if(!plan.breaking&&!allowed)reasons.add("block_unavailable");
            if(build!=null&&!matching)reasons.add("invalid_target");
            if(tile!=null&&build==null){
                if(plan.initialized)reasons.add("invalid_target");
                else if(plan.breaking){if(!Build.validBreak(unit.team,plan.x,plan.y))reasons.add("invalid_target");}
                else{
                    if(!Build.validPlaceIgnoreUnits(plan.block,unit.team,plan.x,plan.y,plan.rotation,true,true))reasons.add("invalid_placement");
                    if(!Build.checkNoUnitOverlap(plan.block,plan.x,plan.y))reasons.add("unit_obstruction");
                }
            }
            if(!plan.breaking&&matching&&build.progress>=1f&&plan.block.isOverPlacementLimit(unit.team))reasons.add("placement_limit");
            if(!plan.breaking&&!infinite&&core!=null&&plan.block!=null){
                boolean missing=false;
                if(matching){
                    int[] left=constructionItemsLeft(build);
                    if(left==null)reasons.add("construction_uninitialized");
                    else{
                        if(left.length!=build.current.requirements.length)throw new IllegalStateException("Native construction resource count changed");
                        for(int i=0;i<left.length;i++){
                            var req=build.current.requirements[i];
                            if(left[i]>0&&(build.progress>=1f?core.items.get(req.item)<left[i]:Math.round(Vars.state.rules.buildCostMultiplier*req.amount)>0&&core.items.get(req.item)==0))missing=true;
                        }
                    }
                }else if(build==null&&!plan.isRotation(unit.team)&&!(plan.isDerelictRepair()&&plan.block.allowDerelictRepair)){
                    for(var req:plan.block.requirements)if(!core.items.has(req.item,Math.min(Math.round(req.amount*Vars.state.rules.buildCostMultiplier),1)))missing=true;
                }
                if(missing)reasons.add("missing_resources");
            }
        }
        out.put("progress",progress);out.put("progress_source",matching||complete?"world":!plan.initialized?"initial":"unavailable");
        out.put("target_complete",complete);out.put("stuck",plan.stuck);
        out.put("state",!reasons.isEmpty()?"blocked":!complete&&unit.buildPlan()==plan&&matching?"building":"queued");
        out.put("blocked_reasons",reasons);
        return out;
    }
    static Map<String,Object> unit(Unit u,Team viewer){
        var out=sensors(u);out.putAll(obj("id",u.id,"kind","unit","type",u.type.name,"team",u.team.name,"x",u.x/8,"y",u.y/8,"stack",stack(u),"controlled",controlledBy(u)));
        if(u.team==viewer){
            ArrayList<Object> plans=new ArrayList<>(),stances=new ArrayList<>();for(BuildPlan plan:u.plans)plans.add(plan(u,plan));
            CommandAI ai=u.controller() instanceof CommandAI c?c:null;
            if(ai!=null)for(var stance:Vars.content.unitStances())if(ai.hasStance(stance))stances.add(stance.name);
            out.putAll(obj("plans",plans,"command",ai==null?null:ai.currentCommand().name,"stance",stances,"target",ai==null?null:ref(ai.attackTarget!=null?ai.attackTarget:ai.targetPos)));
        }else{
            out.remove("ping_x");out.remove("ping_y");out.remove("ping_text");
        }return out;
    }

    static String controlledBy(Unit u){
        var controller=u.controller();
        return controller instanceof Player?"player":controller instanceof LogicAI?"processor":controller instanceof CommandAI?"command":"ai";
    }
    static boolean configVisible(Building b,Team viewer){return !b.block.privileged&&(b.team==viewer||b.block.configSenseable());}
    static Map<String,Object> building(Building b,Team viewer){
        var out=sensors(b);LinkedHashMap<String,Object> items=items(b),liquids=new LinkedHashMap<>();
        if(b.liquids!=null)for(Liquid liquid:Vars.content.liquids()){double n=b.sense(liquid);if(n!=0&&Double.isFinite(n))liquids.put(liquid.name,n);}
        ArrayList<Object> links=new ArrayList<>();if(b.power!=null)for(int i=0;i<b.power.links.size;i++){int p=b.power.links.get(i);links.add(obj("x",Point2.x(p),"y",Point2.y(p)));}
        int x=b.tileX()+b.block.sizeOffset,y=b.tileY()+b.block.sizeOffset;

        out.put("controlled",b instanceof ControlBlock control&&control.isControlled()?"player":"none");
        out.putAll(obj("id",b.id,"kind","building","type",b.block.name,"team",b.team.name,"x",b.tileX(),"y",b.tileY(),"size",b.block.size,"rotation",b.rotation,"footprint",obj("x0",x,"y0",y,"x1",x+b.block.size,"y1",y+b.block.size),"items",items,"liquids",liquids,"power_links",links,"power_links_frame","absolute"));
        if(configVisible(b,viewer))out.put("config",config(b.config(),b.tileX(),b.tileY()));return out;
    }
    static Object config(Object value,int x,int y){
        if(value==null||value instanceof String||value instanceof Boolean)return value;
        if(value instanceof Float||value instanceof Double)return obj("type","float","value",sensorValue(value));
        if(value instanceof Number)return value;
        if(value instanceof MappableContent c)return obj("type",switch(c.getContentType()){case unit->"unit";case unitCommand->"command";case unitStance->"stance";default->c.getContentType().name();},"name",c.name);
        if(value instanceof Point2 p)return obj("type","point","frame","relative","x",p.x,"y",p.y);
        if(value instanceof byte[] bytes)return obj("type","bytes","base64",Base64.getEncoder().encodeToString(bytes));
        if(value instanceof int[] ints){ArrayList<Integer> out=new ArrayList<>(ints.length);for(int n:ints)out.add(n);return obj("type","ints","values",out);}
        if(value instanceof Point2[] points){ArrayList<Object> out=new ArrayList<>(points.length);for(Point2 p:points)out.add(obj("x",p.x+x,"y",p.y+y));return obj("type","points","frame","absolute","values",out);}
        throw new IllegalArgumentException("Unsupported native configuration "+value.getClass().getSimpleName());
    }
    Map<String,Object> block(Block b){
        ArrayList<Object> costs=new ArrayList<>(),configs=new ArrayList<>();for(ItemStack s:b.requirements)costs.add(obj("item",s.item.name,"amount",s.amount));for(Class<?> c:b.configurations.keys())configs.add(c.getSimpleName());
        return obj("name",b.name,"localized_name",b.localizedName,"description",CatalogText.description(b),"size",b.size,"footprint_offset",b.sizeOffset,"health",b.health,"category",b.category.name(),"cost",costs,"build_time",b.buildTime,"placeable",b.isPlaceable(),"environment_buildable",b.environmentBuildable(),"config_types",configs,"mechanics",mechanics(b));
    }
    Map<String,Object> unitType(UnitType u){
        ArrayList<Object> weapons=new ArrayList<>();
        for(var weapon:u.weapons) weapons.add(obj("name",weapon.name,"range_tiles",weapon.range()/8,"direct_damage",weapon.bullet.damage,"can_hit_air",weapon.bullet.collidesAir,"can_hit_ground",weapon.bullet.collidesGround,"player_controllable",weapon.controllable));
        ArrayList<String> commands=new ArrayList<>();
        for(var command:u.commands) commands.add(command.name);
        return obj("name",u.name,"description",CatalogText.description(u),"speed",u.speed,"health",u.health,"armor",u.armor,"flying",u.flying,"build_speed",u.buildSpeed,"build_range_tiles",u.buildRange/8,"mine_tier",u.mineTier,"mine_range_tiles",u.mineRange/8,"mine_floor",u.mineFloor,"mine_walls",u.mineWalls,"item_capacity",u.itemCapacity,"weapons",weapons,"commands",commands);
    }
    Object mechanics(Block b){
        LinkedHashMap<String,Object> result=obj("item_capacity",b.itemCapacity,"liquid_capacity",b.liquidCapacity);
        ArrayList<Object> consumes=new ArrayList<>();
        for(var c:b.consumers){Object detail=null;
            if(c instanceof mindustry.world.consumers.ConsumeItems ci){ArrayList<Object> is=new ArrayList<>();for(ItemStack st:ci.items)is.add(obj("item",st.item.name,"amount",st.amount));detail=obj("items",is);}
            else if(c instanceof mindustry.world.consumers.ConsumeItemFilter cf){ArrayList<Object> accepted=new ArrayList<>();for(Item i:Vars.content.items())if(cf.filter.get(i))accepted.add(obj("item",i.name,"efficiency_multiplier",cf.itemEfficiencyMultiplier(i)));detail=obj("accepted_items",accepted);}
            else if(c instanceof mindustry.world.consumers.ConsumeLiquid cl)detail=obj("liquid",cl.liquid.name,"per_second",cl.amount*60);
            else if(c instanceof mindustry.world.consumers.ConsumePower cp)detail=obj("power_per_second",cp.usage*60,"buffer_capacity",cp.capacity);
            consumes.add(obj("type",c.getClass().getSimpleName(),"optional",c.optional,"details",detail,"details_available",detail!=null));
        }
        result.put("consumes",consumes);
        if(b instanceof mindustry.world.blocks.power.PowerGenerator g)result.put("base_power_production_per_second",g.powerProduction*60);
        if(b instanceof mindustry.world.blocks.power.ConsumeGenerator g){result.put("item_duration_seconds",g.itemDuration/60);ArrayList<Object> durations=new ArrayList<>();for(var entry:g.itemDurationMultipliers)durations.add(obj("item",entry.key.name,"duration_multiplier",entry.value));result.put("item_duration_multipliers",durations);}
        if(b instanceof mindustry.world.blocks.production.GenericCrafter g){result.put("craft_seconds",g.craftTime/60);ArrayList<Object> outputs=new ArrayList<>();if(g.outputItems!=null)for(ItemStack st:g.outputItems)outputs.add(obj("item",st.item.name,"amount",st.amount));if(g.outputLiquids!=null)for(LiquidStack st:g.outputLiquids)outputs.add(obj("liquid",st.liquid.name,"per_second",st.amount*60));result.put("outputs",outputs);}
        if(b instanceof mindustry.world.blocks.production.Drill d){result.put("mine_tier",d.tier);result.put("drill_seconds",d.drillTime/60);}
        if(b instanceof mindustry.world.blocks.defense.turrets.BaseTurret t)result.put("range_tiles",t.range/8);
        if(b instanceof mindustry.world.blocks.defense.turrets.Turret t){result.put("target_air",t.targetAir);result.put("target_ground",t.targetGround);}
        if(b instanceof mindustry.world.blocks.defense.turrets.ItemTurret t){ArrayList<Object> ammo=new ArrayList<>();for(var e:t.ammoTypes)ammo.add(obj("item",e.key.name,"damage",e.value.damage,"ammo_multiplier",e.value.ammoMultiplier));result.put("ammo",ammo);}
        if(b instanceof mindustry.world.blocks.defense.turrets.LiquidTurret t){ArrayList<Object> ammo=new ArrayList<>();for(var e:t.ammoTypes)ammo.add(obj("liquid",e.key.name,"damage",e.value.damage));result.put("ammo",ammo);}
        if(b instanceof mindustry.world.blocks.units.UnitFactory f){ArrayList<Object> plans=new ArrayList<>();int index=0;for(var plan:f.plans){ArrayList<Object> costs=new ArrayList<>();for(ItemStack st:plan.requirements)costs.add(obj("item",st.item.name,"amount",st.amount));plans.add(obj("config_index",index++,"unit",plan.unit.name,"seconds",plan.time/60,"cost",costs));}result.put("unit_plans",plans);}
        return result;
    }
}
