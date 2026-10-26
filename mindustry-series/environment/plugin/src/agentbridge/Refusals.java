package agentbridge;

import arc.math.geom.Rect;
import arc.struct.Seq;
import arc.util.Tmp;
import mindustry.Vars;
import mindustry.ai.types.LogicAI;
import mindustry.content.Blocks;
import mindustry.content.Liquids;
import mindustry.entities.bullet.BulletType;
import mindustry.entities.units.UnitController;
import mindustry.game.Team;
import mindustry.gen.*;
import mindustry.type.Item;
import mindustry.world.*;
import mindustry.world.blocks.ConstructBlock;
import mindustry.world.blocks.defense.turrets.ItemTurret;
import mindustry.world.blocks.distribution.Conveyor;
import mindustry.world.blocks.distribution.Junction;
import mindustry.world.blocks.distribution.Router;
import mindustry.world.blocks.power.ThermalGenerator;
import mindustry.world.blocks.production.*;
import mindustry.world.blocks.units.UnitFactory;
import mindustry.world.meta.Attribute;
import mindustry.world.meta.BlockGroup;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.util.*;

final class Refusals {
    private Refusals(){}

    static String num(double value,RoundingMode rounding){return BigDecimal.valueOf(value).setScale(2,rounding).stripTrailingZeros().toPlainString();}
    static String num(double value){return num(value,RoundingMode.HALF_UP);}
    static String at(int x,int y){return "("+x+","+y+")";}
    static String world(){return "0 <= x < "+Vars.world.width()+" and 0 <= y < "+Vars.world.height();}

    static String outsideWorld(String field,float x,float y){return field+" ("+num(x)+","+num(y)+") is outside the world, which spans "+world();}

    static String occupant(Tile t){
        Building b=t.build;
        if(b instanceof ConstructBlock.ConstructBuild site)
            return "a "+b.team.name+" "+(site.wasConstructing?"construction site for ":"deconstruction site of ")+site.current.name+" (building "+b.id+") at "+at(b.tileX(),b.tileY());
        if(b!=null)return "the "+b.team.name+" "+b.block.name+" (building "+b.id+") at "+at(b.tileX(),b.tileY());
        return "the "+t.block().name+" at "+at(t.x,t.y);
    }

    static String transferRange(Player p,Building b){return "Building is "+num(p.dst(b)/8,RoundingMode.CEILING)+" tiles away; items transfer within "+num(Vars.itemTransferRange/8);}

    static String depositCooldown(Object remainingMs){
        return "Item transfer is on cooldown: "+remainingMs+" ms remaining; at most 2 deposits per "+(long)(Vars.state.rules.itemDepositCooldown*1000*2)+" ms";
    }

    static String unitRefuses(Unit u,Item item){
        if(u.stack.amount>0&&u.stack.item!=item)return "Unit carries "+u.stack.amount+" "+u.stack.item.name+" and holds one item type at a time";
        return "Unit stack is full: "+u.stack.amount+" of "+u.itemCapacity()+" "+item.name;
    }

    static String refusedStack(Building b,Item item){
        String block=b.block.name;
        if(!b.allowDeposit())return block+" takes no deposits: this game's rules allow deposits only into cores";
        if(b instanceof ItemTurret.ItemTurretBuild turret){
            ItemTurret type=(ItemTurret)b.block;BulletType ammo=type.ammoTypes.get(item);
            if(ammo==null)return block+" does not take "+item.name+": it is not one of its ammo types";
            return block+" has no room for "+item.name+" ammo: it holds "+turret.totalAmmo+" of "+type.maxAmmo+" ammo, and one "+item.name+" adds "+num(ammo.ammoMultiplier);
        }
        if(b instanceof Conveyor.ConveyorBuild)return block+" has no free space at its input end";
        if(b instanceof Router.RouterBuild||b instanceof Junction.JunctionBuild)return block+" takes no item stacks from units";
        UnitFactory.UnitPlan plan=null;
        if(b instanceof UnitFactory.UnitFactoryBuild factory){
            if(factory.currentPlan==-1)return block+" has no unit plan configured, and takes no items without one";
            plan=((UnitFactory)b.block).plans.get(factory.currentPlan);
        }
        int held=b.items.get(item),max=b.getMaximumAccepted(item);
        if(max>0&&held>=max)return block+" is full of "+item.name+": it holds "+held+" of "+max;
        if(b.block.group==BlockGroup.transportation)return block+" accepts none of the carried "+item.name+" now";
        return block+" does not take "+item.name+(plan==null?"":" for its "+plan.unit.name+" plan");
    }

    static String unmineable(Unit u,Tile t){
        String unit=u.type.name,tile="Tile "+at(t.x,t.y);Item drop;
        if(!u.type.mineFloor&&!u.type.mineWalls)return unit+" mines neither floors nor walls";
        if(u.type.mineFloor&&t.block()==Blocks.air){
            drop=t.drop();
            if(drop==null)return tile+" drops nothing to mine (floor "+t.floor().name+", "+(t.overlay()==Blocks.air?"no ore":"overlay "+t.overlay().name)+")";
        }else if(u.type.mineWalls){
            drop=t.wallDrop();
            if(drop==null)return t.block()==Blocks.air?tile+" has no wall to mine":tile+" holds "+occupant(t)+", which drops nothing to mine";
        }else return tile+" is covered by "+occupant(t)+"; "+unit+" mines only floor tiles with no block on them";
        return drop.name+" at "+at(t.x,t.y)+" has hardness "+drop.hardness+"; "+unit+" mines up to hardness "+u.type.mineTier;
    }

    static String uncommandable(Unit u){
        String unit=u.type.name+" "+u.id;UnitController controller=u.controller();
        if(controller instanceof LogicAI logic)return logic.controller==null?unit+" is controlled by a logic processor":unit+" is controlled by a logic processor: "+occupant(logic.controller.tile);
        if(controller instanceof Player player)return unit+" is controlled by player "+player.name;
        Class<?> type=controller.getClass();while(type.isAnonymousClass())type=type.getSuperclass();
        return unit+" is run by the native "+type.getSimpleName()+", which takes no commands";
    }

    static String placement(Block b,Team team,int x,int y,int rotation){
        var rules=Vars.state.rules;String here=b.name+" at "+at(x,y);
        String core=coreProtection(b,team,x,y);if(core!=null)return core;
        Tile tile=Vars.world.tile(x,y);
        if(!b.canPlaceOn(tile,team,rotation))return ground(b,tile,here);
        if(!b.ignoreBuildDarkness&&Vars.world.getDarkness(x,y)>=3)return here+" lies in the dark border of the map";
        if(!b.requiresWater&&!Build.contactsShallows(x,y,b)&&!b.placeableLiquid)return here+" would stand in deep water with no shallow tile under or beside it";
        if(b.isOverPlacementLimit(team))return "Team "+team.name+" already has its limit of "+rules.blockLimits.get(b,0)+" "+b.name;
        var blockers=footprint(b,team,tile,rotation);
        if(!blockers.isEmpty())return here+" is blocked by "+String.join("; ",blockers);
        if(rules.placeRangeCheck){Building enemy=Build.getEnemyOverlap(b,team,x,y);if(enemy!=null)return here+" is within range of "+occupant(enemy.tile);}
        if(!Build.checkNoUnitOverlap(b,x,y))return "Ground units stand in the "+b.name+" footprint at "+at(x,y)+": "+String.join(", ",groundUnits(b,x,y));
        return "Native placement rejected";
    }

    static String coreProtection(Block b,Team team,int x,int y){
        float wx=x*8+b.offset,wy=y*8+b.offset;
        if(Vars.state.rules.polygonCoreProtection){
            Building nearest=null;float best=Float.MAX_VALUE;
            for(var data:Vars.state.teams.active)if(data.team.rules().protectCores)for(var core:data.cores){float d=core.dst2(wx,wy);if(d<best){best=d;nearest=core;}}
            return nearest==null||nearest.team==team?null:"The core nearest this block is the "+nearest.team.name+" core at "+at(nearest.tileX(),nearest.tileY())+"; under polygon core protection only its team builds there";
        }
        for(var data:Vars.state.teams.active)if(data.team!=team&&data.team.rules().protectCores)for(var core:data.cores){
            float radius=Vars.state.rules.buildRadius(core.team);
            if(core.within(wx,wy,radius+8))return "Within "+num((radius+8)/8)+" tiles of the "+core.team.name+" core at ("+core.tileX()+","+core.tileY()+"), where other teams cannot build: "
                +"this block's center is "+num(core.dst(wx,wy)/8,RoundingMode.FLOOR)+" tiles from it (build radius "+num(radius/8)+" plus one tile)";
        }
        return null;
    }

    static String ground(Block b,Tile tile,String here){
        Seq<Tile> tiles=tile.getLinkedTilesAs(b,new Seq<>());
        LinkedHashSet<String> floors=new LinkedHashSet<>();for(Tile t:tiles)floors.add(t.floor().name);
        String floorNames=String.join(", ",floors);
        if(b instanceof Drill drill){
            LinkedHashSet<String> drops=new LinkedHashSet<>();
            for(Tile t:tiles)if(!t.block().isStatic()&&t.drop()!=null)drops.add(t.drop().name+" (hardness "+t.drop().hardness+")");
            return "No tile under "+here+" has an item it can mine at tier "+drill.tier+": "+(drops.isEmpty()?"the tiles drop nothing":"they drop "+String.join(", ",drops));
        }
        Attribute attribute=b instanceof SolidPump pump?pump.attribute:b instanceof AttributeCrafter crafter?crafter.attribute:b instanceof ThermalGenerator generator?generator.attribute:null;
        if(attribute!=null){
            float sum=0;for(Tile t:tiles)sum+=t.floor().attributes.get(attribute);
            return here+" draws on its floor's "+attribute.name+", and the floors under it ("+floorNames+") hold "+num(sum)+" "+attribute.name;
        }
        if(b instanceof Pump){
            LinkedHashSet<String> liquids=new LinkedHashSet<>();for(Tile t:tiles)if(t.floor().liquidDrop!=null)liquids.add(t.floor().liquidDrop.name);
            return liquids.isEmpty()?here+" has no liquid floor under it ("+floorNames+")":here+" stands on floors with different liquids: "+String.join(", ",liquids);
        }
        return here+" fails its own placement rule for this ground (native canPlaceOn; floors "+floorNames+")";
    }

    static List<String> footprint(Block type,Team team,Tile tile,int rotation){
        var rules=Vars.state.rules;LinkedHashSet<String> out=new LinkedHashSet<>();int offset=-(type.size-1)/2;
        for(int dx=0;dx<type.size;dx++)for(int dy=0;dy<type.size;dy++){
            int wx=dx+offset+tile.x,wy=dy+offset+tile.y;Tile check=Vars.world.tile(wx,wy);String cell="tile "+at(wx,wy);
            if(check==null){out.add(cell+", which is outside the world");continue;}
            if(type.size==2&&Vars.world.getDarkness(wx,wy)>=3){out.add(cell+", in the dark border of the map");continue;}
            if(rules.staticFog&&rules.fog&&!Vars.fogControl.isDiscovered(team,wx,wy)){out.add(cell+", which team "+team.name+" has not discovered");continue;}
            if(check.floor().isDeep()&&!type.floating&&!type.requiresWater&&!type.placeableLiquid){out.add(cell+", which is deep water ("+check.floor().name+")");continue;}
            boolean derelictSame=type==check.block()&&team!=Team.derelict&&check.team()==Team.derelict;
            if(!rules.derelictRepair&&check.team()==Team.derelict&&check.build!=null){out.add(occupant(check));continue;}
            if(type==check.block()&&check.build!=null&&rotation==check.build.rotation&&type.rotate&&!derelictSame){out.add(occupant(check)+", the same block with the same rotation");continue;}
            if(!check.interactable(team)){out.add(occupant(check));continue;}
            if(!check.floor().placeableOn&&!type.ignoreBuildDarkness){out.add(cell+", whose floor "+check.floor().name+" holds no buildings");continue;}
            boolean replaces=type.canReplace(check.block())||check.build!=null&&check.build.canBeReplaced(type)||derelictSame
                ||check.build instanceof ConstructBlock.ConstructBuild site&&site.current==type&&check.centerX()==tile.x&&check.centerY()==tile.y;
            if(!(replaces&&type.bounds(tile.x,tile.y,Tmp.r1).grow(0.01f).contains(check.block().bounds(check.centerX(),check.centerY(),Tmp.r2)))){out.add(occupant(check));continue;}
            if(type.requiresWater&&check.floor().liquidDrop!=Liquids.water)out.add(cell+", which has no water");
        }
        return new ArrayList<>(out);
    }

    static List<String> groundUnits(Block b,int x,int y){
        float size=b.size*8f,left=x*8+b.offset-size/2f,bottom=y*8+b.offset-size/2f;Rect hitbox=new Rect();ArrayList<String> out=new ArrayList<>();
        Groups.unit.each(u->{if(u.isGrounded()&&!u.type.allowLegStep){u.hitboxTile(hitbox);if(hitbox.overlaps(left,bottom,size,size))out.add(u.type.name+" "+u.id+" ("+u.team.name+")");}});
        return out;
    }
}
