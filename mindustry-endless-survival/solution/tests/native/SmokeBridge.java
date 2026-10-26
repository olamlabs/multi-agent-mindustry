package agentbridge;

import arc.Events;
import arc.util.serialization.JsonValue;
import mindustry.Vars;
import mindustry.ai.types.LogicAI;
import mindustry.ai.types.CommandAI;
import mindustry.content.Blocks;
import mindustry.content.Items;
import mindustry.content.UnitTypes;
import mindustry.ctype.ContentType;
import mindustry.game.EventType.UnitCreateEvent;
import mindustry.game.Team;
import mindustry.gen.*;
import mindustry.type.Item;
import mindustry.world.Block;
import mindustry.world.blocks.defense.turrets.ItemTurret;

public class SmokeBridge extends AgentBridge {
    Building place(Block block, Team team, int x, int y){
        Vars.world.tile(x,y).setBlock(block,team,0);
        return Vars.world.build(x,y);
    }
    Unit spawn(mindustry.type.UnitType type, Team team, int x, int y){
        Unit unit=type.create(team); unit.set(x*8,y*8); unit.add(); return unit;
    }
    @Override Object route(String path, JsonValue args) throws Exception {
        if(path.equals("/fixture_query")){
            int[] rowsBuilt={0};
            Records measured=new Records(this){
                @Override java.util.Map<String,Object> row(String of,Object candidate,Team team){
                    rowsBuilt[0]++;
                    return super.row(of,candidate,team);
                }
            };
            Object result=measured.query(seat(args),args);
            return obj("result",result,"rows_built",rowsBuilt[0]);
        }
        if(path.equals("/fixture_blocks")){
            var visible=new java.util.ArrayList<Integer>();
            for(Block block:Vars.content.blocks())if(block.isVisible())visible.add((int)block.id);
            return obj("visible_ids",visible);
        }
        if(path.equals("/fixture_command_unit")){
            if(args.has("remove")){Inputs.unit(args.getInt("remove")).remove();return obj();}
            Player p=seats.get("seat-1").player;
            Unit unit=UnitTypes.mega.create(p.team());unit.set(p.unit().x,p.unit().y);unit.add();
            unit.controller(new CommandAI());
            return obj("unit",unit.id);
        }
        if(path.equals("/fixture_construction")){
            var p=seats.get("seat-1").player;
            int x=Math.max(20,Math.min(Vars.world.width()-25,p.core().tileX()+12))+2,y=Math.max(20,Math.min(Vars.world.height()-25,p.core().tileY()))-2;
            var tile=Vars.world.tile(x,y);
            Unit builder=UnitTypes.alpha.create(p.team());builder.set((x+3)*8,y*8);builder.buildSpeedMultiplier=0.01f;
            var plan=new mindustry.entities.units.BuildPlan(x,y,0,Blocks.copperWall);
            int copper=p.core().items.get(Items.copper);
            try{
                builder.addBuild(plan);builder.updateBuilding=false;
                var disabled=Records.plan(builder,plan);
                builder.updateBuilding=true;
                var queued=Records.plan(builder,plan);
                for(int i=0;i<10;i++)builder.updateBuildLogic();
                var started=Records.plan(builder,plan);
                builder.set(0,0);
                for(int i=0;i<10;i++)builder.updateBuildLogic();
                var away=Records.plan(builder,plan);
                Unit helper=UnitTypes.alpha.create(p.team());helper.set((x+3)*8,y*8);helper.buildSpeedMultiplier=0.01f;
                var helping=new mindustry.entities.units.BuildPlan(x,y,0,Blocks.copperWall);helper.addBuild(helping);
                for(int i=0;i<10;i++)helper.updateBuildLogic();
                var helped=Records.plan(builder,plan);
                var reread=Records.plan(builder,plan);
                builder.set((x+3)*8,y*8);
                for(int i=0;i<10;i++)builder.updateBuildLogic();
                var resumed=Records.plan(builder,plan);
                p.core().items.set(Items.copper,0);
                var missing=Records.plan(builder,plan);
                for(int i=0;i<10;i++)builder.updateBuildLogic();
                var starved=Records.plan(builder,plan);

                var construct=(mindustry.world.blocks.ConstructBlock.ConstructBuild)tile.build;
                int[] debt=Records.constructionItemsLeft(construct),savedDebt=debt.clone();
                java.util.Arrays.fill(debt,0);
                var paid=Records.plan(builder,plan);
                System.arraycopy(savedDebt,0,debt,0,debt.length);
                p.core().items.set(Items.copper,copper);
                builder.updateBuilding=false;
                builder.clearBuilding();
                var breaking=new mindustry.entities.units.BuildPlan(x,y);builder.addBuild(breaking);
                var deconstruction=Records.plan(builder,breaking);
                builder.updateBuilding=true;
                for(int i=0;i<2;i++)builder.updateBuildLogic();
                var deconstructed=Records.plan(builder,breaking);
                tile.setBlock(Blocks.air);
                var completed=Records.plan(builder,breaking);
                var vanished=Records.plan(builder,plan);
                return obj("disabled",disabled,"queued",queued,"started",started,"away",away,"helped",helped,"reread",reread,
                    "resumed",resumed,"missing",missing,"starved",starved,"paid",paid,"deconstruction",deconstruction,"deconstructed",deconstructed,"completed",completed,"vanished",vanished,
                    "cached_progress",plan.progress);
            }finally{tile.setBlock(Blocks.air);p.core().items.set(Items.copper,copper);}
        }
        if(path.equals("/fixture_transfer")){
            Player p=seats.get("seat-1").player;
            p.unit().clearItem();
            p.itemDepositRate.reset();
            return obj();
        }
        if(path.equals("/fixture")){
            var seat=seats.get("seat-1"); var p=seat.player; Team own=p.team();
            Team foreign=own==Team.crux?Team.sharded:Team.crux;
            int x=p.core().tileX(),y=p.core().tileY();

            int cx=Math.max(20,Math.min(Vars.world.width()-25,x+12));
            int cy=Math.max(20,Math.min(Vars.world.height()-25,y));
            for(int dx=-7;dx<=9;dx++)for(int dy=-8;dy<=8;dy++){
                var tile=Vars.world.tile(cx+dx,cy+dy);
                if(tile.build!=null && tile.build.block instanceof mindustry.world.blocks.storage.CoreBlock)continue;
                tile.setBlock(Blocks.air);tile.setFloor(Blocks.stone.asFloor());tile.setOverlay(Blocks.air);
            }
            p.unit().set(cx*8,cy*8);p.unit().vel.setZero();p.unit().snapInterpolation();
            Building storage=place(Blocks.container,own,cx-3,cy);
            storage.items.set(Items.copper,100);
            storage.items.set(Items.lead,20);
            Building powerNode=place(Blocks.powerNode,own,cx-6,cy-5);
            place(Blocks.powerNode,own,cx-3,cy-5);
            Building foreignPower=place(Blocks.powerNode,foreign,cx-3,cy-7);
            foreignPower.health=foreignPower.maxHealth=1_000_000f;
            Building farPower=place(Blocks.powerNode,own,cx+8,cy-5);
            Building ownConfig=place(Blocks.microProcessor,own,cx-4,cy+4);
            Building foreignConfig=place(Blocks.microProcessor,foreign,cx+8,cy+7);

            foreignConfig.health=foreignConfig.maxHealth=1_000_000f;
            Building publicConfig=place(Blocks.sorter,foreign,cx+7,cy-7);
            publicConfig.health=publicConfig.maxHealth=1_000_000f;
            publicConfig.configured(null,Items.lead);
            Vars.world.tile(cx+2,cy+1).setOverlay(Blocks.oreCopper);
            Vars.world.tile(cx+9,cy-8).setOverlay(Blocks.oreCopper);

            Vars.world.tile(cx+3,cy-1).setOverlay(Blocks.oreTitanium);
            Building payloadBuild=place(Blocks.conveyor,own,cx+2,cy+5);
            Building far=place(Blocks.container,own,3,3);
            Building factory=place(Blocks.groundFactory,own,cx+5,cy-5);
            Unit command=spawn(UnitTypes.dagger,own,cx+4,cy+2);
            command.controller(new CommandAI());
            Unit carrier=spawn(UnitTypes.mega,own,cx,cy+5);
            Unit payload=spawn(UnitTypes.dagger,own,cx,cy+5);
            return obj("own_config",ownConfig.id,"foreign_config",foreignConfig.id,"public_config",publicConfig.id,"storage",storage.id,
                "far_storage",far.id,"factory",factory.id,"power_node",powerNode.id,"command_unit",command.id,"carrier",carrier.id,
                "foreign_power",foreignPower.id,"far_power",farPower.id,
                "payload_unit",payload.id,"payload_at",obj("x",cx,"y",cy+5),
                "payload_building",payloadBuild.id,"payload_build_at",obj("x",cx+3,"y",cy+5),
                "mine_tile",obj("x",cx+2,"y",cy+1),"far_mine_tile",obj("x",cx+9,"y",cy-8),"hard_mine_tile",obj("x",cx+3,"y",cy-1),"bare_tile",obj("x",cx+1,"y",cy+1),
                "plan_tile",java.util.List.of(cx+2,cy-2),"core_tile",java.util.List.of(x,y));
        }
        if(path.equals("/fixture_items")){

            Building b=Inputs.building(args.getInt("building"));Item item=Vars.content.getByName(ContentType.item,args.getString("item"));
            int before=b.items.get(item);b.items.set(item,args.has("amount")?args.getInt("amount"):b.getMaximumAccepted(item));
            return obj("before",before,"amount",b.items.get(item));
        }
        if(path.equals("/fixture_logic")){

            Building processor=Inputs.building(args.getInt("processor"));
            Unit bound=spawn(UnitTypes.dagger,processor.team,processor.tileX()+2,processor.tileY()+2);
            LogicAI ai=new LogicAI();ai.controller=processor;ai.controlTimer=60f*60f*10f;bound.controller(ai);
            return obj("unit",bound.id);
        }
        if(path.equals("/fixture_kill")){
            Inputs.building(args.getInt("building")).kill();
            return obj();
        }
        if(path.equals("/fixture_steering")){
            Player p=seats.get("seat-1").player;
            int x=Math.max(20,Math.min(Vars.world.width()-25,p.core().tileX()+12));
            int y=Math.max(20,Math.min(Vars.world.height()-25,p.core().tileY()));
            Unit flare=spawn(UnitTypes.flare,p.team(),x,y);
            flare.controller(new CommandAI());
            flare.rotation=0;
            return obj("unit",flare.id);
        }
        if(path.equals("/fixture_turret")){
            Player p=seats.get("seat-1").player;
            int x=Math.max(20,Math.min(Vars.world.width()-25,p.core().tileX()+12))-4;
            int y=Math.max(20,Math.min(Vars.world.height()-25,p.core().tileY()))-4;
            var turret=(ItemTurret.ItemTurretBuild)place(Blocks.duo,p.team(),x,y);
            turret.handleStack(Items.copper,15,null);
            return obj("building",turret.id,"unit",turret.unit().id,"aim",obj("x",x+10,"y",y),
                "bullet_type",((ItemTurret)Blocks.duo).ammoTypes.get(Items.copper).id);
        }
        if(path.equals("/fixture_entry")){
            Player p=seats.get("seat-1").player;
            int x=p.core().tileX()+6,y=p.core().tileY()-6;
            Building conveyor=place(Blocks.payloadConveyor,p.team(),x,y);
            conveyor.enabled=false;
            Unit entry=spawn(UnitTypes.dagger,p.team(),x,y);
            return obj("unit",entry.id,"building",conveyor.id);
        }
        if(path.equals("/fixture_unit_create")){

            Player p=seats.get("seat-1").player;
            Events.fire(new UnitCreateEvent(p.unit(),p.core()));
            return obj("unit",p.unit().id);
        }
        if(path.equals("/fixture_death")){
            seats.get("seat-1").player.unit().kill();
            return obj();
        }
        return super.route(path,args);
    }
}
