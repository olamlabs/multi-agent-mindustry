// SPDX-License-Identifier: GPL-3.0-only

package agentbridge;

import arc.Events;
import arc.struct.IntFloatMap;
import arc.util.Time;
import mindustry.Vars;
import mindustry.entities.EntityGroup;
import mindustry.entities.EntityIndexer;
import mindustry.entities.bullet.BulletType;
import mindustry.game.EventType.*;
import mindustry.game.Team;
import mindustry.gen.*;
import mindustry.type.*;
import mindustry.world.Block;
import mindustry.world.Tile;
import mindustry.world.blocks.ConstructBlock.ConstructBuild;
import mindustry.world.blocks.defense.turrets.*;
import mindustry.world.blocks.distribution.*;
import mindustry.world.blocks.power.PowerGraph;
import mindustry.world.blocks.production.*;
import mindustry.world.blocks.storage.CoreBlock;
import mindustry.world.blocks.units.*;
import mindustry.world.consumers.*;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.nio.file.*;
import java.util.*;
import static agentbridge.AgentBridge.*;

final class EvaluationTelemetry {
    static final double WINDOW_SECONDS=ProductionTelemetry.WINDOW_SECONDS,NEAR_CAPACITY=ProductionTelemetry.NEAR_CAPACITY;
    static final String SEP="\u0000";
    final AgentBridge bridge;
    final Set<Block> extraction=Collections.newSetFromMap(new IdentityHashMap<>()),transport=Collections.newSetFromMap(new IdentityHashMap<>());
    final IdentityHashMap<Building,Meter> live=new IdentityHashMap<>();
    final List<Meter> history=new ArrayList<>();
    final Map<String,Map<String,Double>> mined=new TreeMap<>(),unitDeposits=new TreeMap<>(),deliveries=new TreeMap<>();
    final Map<Integer,Lost> stalled=new TreeMap<>();
    final Map<String,double[]> damage=new TreeMap<>(),unattributed=new TreeMap<>(),kills=new TreeMap<>(),deaths=new TreeMap<>();
    final Map<String,Double> restored=new TreeMap<>();
    final Map<String,Firepower> firepower=new TreeMap<>();
    final Map<String,Power> power=new TreeMap<>();
    final IntFloatMap unitHealth=new IntFloatMap(),buildHealth=new IntFloatMap(),mineTimers=new IntFloatMap();

    final Map<Integer,String> dyingUnits=new LinkedHashMap<>(),dyingBuildings=new LinkedHashMap<>();
    boolean phased;
    Method wallEfficiency;
    double lastSaved;
    int nextId=1,sweeps;
    EvaluationTelemetry(AgentBridge bridge){this.bridge=bridge;}

    void install(){
        try{wallEfficiency=WallCrafter.class.getDeclaredMethod("getEfficiency",int.class,int.class,int.class,arc.func.Cons.class,arc.func.Intc2.class);wallEfficiency.setAccessible(true);}
        catch(ReflectiveOperationException e){throw new IllegalStateException("Pinned WallCrafter changed",e);}
        for(Block block:Vars.content.blocks()){
            Class<?> type=block.buildType.get().getClass();

            if(block instanceof BurstDrill nativeBlock && type==BurstDrill.BurstDrillBuild.class){
                block.buildType=()->nativeBlock.new BurstDrillBuild(){
                    boolean producing;
                    @Override public void updateConsumption(){super.updateConsumption();sample(this);}
                    @Override public void updateTile(){producing=true;try{super.updateTile();}finally{producing=false;}}
                    @Override public void produced(Item item,int amount){super.produced(item,amount);if(producing)itemProduced(this,item,amount);}
                };
                extraction.add(block);
            }else if(block instanceof Drill nativeBlock && type==Drill.DrillBuild.class){
                block.buildType=()->nativeBlock.new DrillBuild(){
                    boolean producing;
                    @Override public void updateConsumption(){super.updateConsumption();sample(this);}
                    @Override public void updateTile(){producing=true;try{super.updateTile();}finally{producing=false;}}
                    @Override public void produced(Item item,int amount){super.produced(item,amount);if(producing)itemProduced(this,item,amount);}
                };
                extraction.add(block);
            }else if(block instanceof BeamDrill nativeBlock && type==BeamDrill.BeamDrillBuild.class){
                block.buildType=()->nativeBlock.new BeamDrillBuild(){
                    boolean producing;
                    @Override public void updateConsumption(){super.updateConsumption();sample(this);}
                    @Override public void updateTile(){producing=true;try{super.updateTile();}finally{producing=false;}}
                    @Override public void produced(Item item,int amount){super.produced(item,amount);if(producing)itemProduced(this,item,amount);}
                };
                extraction.add(block);
            }else if(block instanceof WallCrafter nativeBlock && type==WallCrafter.WallCrafterBuild.class){
                block.buildType=()->nativeBlock.new WallCrafterBuild(){
                    boolean producing;
                    @Override public void updateConsumption(){super.updateConsumption();sample(this);}
                    @Override public void updateTile(){producing=true;try{super.updateTile();}finally{producing=false;}}
                    @Override public void produced(Item item,int amount){super.produced(item,amount);if(producing)itemProduced(this,item,amount);}
                };
                extraction.add(block);
            }else if(block instanceof Separator nativeBlock && type==Separator.SeparatorBuild.class){
                block.buildType=()->nativeBlock.new SeparatorBuild(){
                    boolean producing;
                    @Override public void updateConsumption(){super.updateConsumption();sample(this);}
                    @Override public void updateTile(){producing=true;try{super.updateTile();}finally{producing=false;}}
                    @Override public void produced(Item item,int amount){super.produced(item,amount);if(producing)itemProduced(this,item,amount);}
                };
                extraction.add(block);
            }else if(block instanceof Fracker nativeBlock && type==Fracker.FrackerBuild.class){

                block.buildType=()->nativeBlock.new FrackerBuild(){
                    @Override public void updateConsumption(){super.updateConsumption();sample(this);}
                    @Override public void updateTile(){super.updateTile();if(lastPump>0)liquidProduced(this,nativeBlock.result,lastPump*Time.delta);}
                };
                extraction.add(block);
            }else if(block instanceof SolidPump nativeBlock && type==SolidPump.SolidPumpBuild.class){
                block.buildType=()->nativeBlock.new SolidPumpBuild(){
                    @Override public void updateConsumption(){super.updateConsumption();sample(this);}
                    @Override public void updateTile(){super.updateTile();if(lastPump>0)liquidProduced(this,nativeBlock.result,lastPump*Time.delta);}
                };
                extraction.add(block);
            }else if(block instanceof Pump nativeBlock && type==Pump.PumpBuild.class){
                block.buildType=()->nativeBlock.new PumpBuild(){
                    @Override public void updateConsumption(){super.updateConsumption();sample(this);}
                    @Override public void updateTile(){

                        Liquid drop=liquidDrop;
                        float pumped=efficiency>0 && drop!=null?Math.min(nativeBlock.liquidCapacity-liquids.get(drop),amount*nativeBlock.pumpAmount*edelta()):0;
                        super.updateTile();
                        if(pumped>0)liquidProduced(this,drop,pumped);
                    }
                };
                extraction.add(block);
            }

            else if(block instanceof Duct nativeBlock && type==Duct.DuctBuild.class){
                block.buildType=()->nativeBlock.new DuctBuild(){
                    @Override public void updateConsumption(){super.updateConsumption();sample(this);}
                    @Override public void handleItem(Building source,Item item){super.handleItem(source,item);transferred(this,item);}
                };
                transport.add(block);
            }else if(block instanceof DuctBridge nativeBlock && type==DuctBridge.DuctBridgeBuild.class){
                block.buildType=()->nativeBlock.new DuctBridgeBuild(){
                    @Override public void updateConsumption(){super.updateConsumption();sample(this);}
                    @Override public void handleItem(Building source,Item item){super.handleItem(source,item);transferred(this,item);}
                };
                transport.add(block);
            }else if(block instanceof BufferedItemBridge nativeBlock && type==BufferedItemBridge.BufferedItemBridgeBuild.class){
                block.buildType=()->nativeBlock.new BufferedItemBridgeBuild(){
                    @Override public void updateConsumption(){super.updateConsumption();sample(this);}
                    @Override public void handleItem(Building source,Item item){super.handleItem(source,item);transferred(this,item);}
                };
                transport.add(block);
            }else if(block instanceof ItemBridge nativeBlock && type==ItemBridge.ItemBridgeBuild.class){
                block.buildType=()->nativeBlock.new ItemBridgeBuild(){
                    @Override public void updateConsumption(){super.updateConsumption();sample(this);}
                    @Override public void handleItem(Building source,Item item){super.handleItem(source,item);transferred(this,item);}
                };
                transport.add(block);
            }else if(block instanceof Junction nativeBlock && type==Junction.JunctionBuild.class){
                block.buildType=()->nativeBlock.new JunctionBuild(){
                    @Override public void updateConsumption(){super.updateConsumption();sample(this);}
                    @Override public void handleItem(Building source,Item item){super.handleItem(source,item);transferred(this,item);}
                };
                transport.add(block);
            }else if(block instanceof Router nativeBlock && type==Router.RouterBuild.class){
                block.buildType=()->nativeBlock.new RouterBuild(){
                    @Override public void updateConsumption(){super.updateConsumption();sample(this);}
                    @Override public void handleItem(Building source,Item item){super.handleItem(source,item);transferred(this,item);}
                };
                transport.add(block);
            }else if(block instanceof Sorter nativeBlock && type==Sorter.SorterBuild.class){
                block.buildType=()->nativeBlock.new SorterBuild(){
                    @Override public void updateConsumption(){super.updateConsumption();sample(this);}
                    @Override public void handleItem(Building source,Item item){super.handleItem(source,item);transferred(this,item);}
                };
                transport.add(block);
            }else if(block instanceof OverflowGate nativeBlock && type==OverflowGate.OverflowGateBuild.class){
                block.buildType=()->nativeBlock.new OverflowGateBuild(){
                    @Override public void updateConsumption(){super.updateConsumption();sample(this);}
                    @Override public void handleItem(Building source,Item item){super.handleItem(source,item);transferred(this,item);}
                };
                transport.add(block);
            }else if(block instanceof DuctRouter nativeBlock && type==DuctRouter.DuctRouterBuild.class){
                block.buildType=()->nativeBlock.new DuctRouterBuild(){
                    @Override public void updateConsumption(){super.updateConsumption();sample(this);}
                    @Override public void handleItem(Building source,Item item){super.handleItem(source,item);transferred(this,item);}
                };
                transport.add(block);
            }else if(block instanceof DuctJunction nativeBlock && type==DuctJunction.DuctJunctionBuild.class){
                block.buildType=()->nativeBlock.new DuctJunctionBuild(){
                    @Override public void updateConsumption(){super.updateConsumption();sample(this);}
                    @Override public void handleItem(Building source,Item item){super.handleItem(source,item);transferred(this,item);}
                };
                transport.add(block);
            }else if(block instanceof OverflowDuct nativeBlock && type==OverflowDuct.OverflowDuctBuild.class){
                block.buildType=()->nativeBlock.new OverflowDuctBuild(){
                    @Override public void updateConsumption(){super.updateConsumption();sample(this);}
                    @Override public void handleItem(Building source,Item item){super.handleItem(source,item);transferred(this,item);}
                };
                transport.add(block);
            }

            else if(block instanceof CoreBlock nativeBlock && type==CoreBlock.CoreBuild.class){
                block.buildType=()->nativeBlock.new CoreBuild(){
                    @Override public void handleItem(Building source,Item item){
                        int before=items.get(item);super.handleItem(source,item);received(this,source,item,items.get(item)-before);
                    }
                    @Override public void handleStack(Item item,int amount,Teamc source){
                        int before=items.get(item);super.handleStack(item,amount,source);
                        int stored=items.get(item)-before;
                        if(source instanceof Unit unit)unitDeposited(unit,item,stored);
                        else if(source instanceof Building building)received(this,building,item,stored);
                    }
                };
            }else if(block instanceof ItemTurret nativeBlock && type==ItemTurret.ItemTurretBuild.class){
                block.buildType=()->nativeBlock.new ItemTurretBuild(){
                    @Override public void handleItem(Building source,Item item){super.handleItem(source,item);received(this,source,item,1);}
                };
            }
        }

        Events.on(BlockDestroyEvent.class,event->{
            Building b=event.tile.build;
            if(b!=null && running()){death(target(b));dyingBuildings.put(b.id,target(b));}
            else if(b!=null)buildHealth.remove(b.id,0);
            if(b!=null)retire(b);
        });
        Events.on(BuildTeamChangeEvent.class,event->retire(event.build));
        Events.on(PickupEvent.class,event->{if(event.build!=null)retire(event.build);});
        Events.on(UnitDamageEvent.class,event->{if(running())attributeDamage(event.bullet,target(event.unit),unitHealth,event.unit.id,effective(event.unit),true);});
        Events.on(BuildDamageEvent.class,event->{if(running())attributeDamage(event.source,target(event.build),buildHealth,event.build.id,Math.max(0,event.build.health),!(event.build instanceof ConstructBuild));});
        Events.on(UnitBulletDestroyEvent.class,event->{if(running())count(kills,source(event.bullet)+SEP+target(event.unit));});
        Events.on(BuildingBulletDestroyEvent.class,event->{if(running())count(kills,source(event.bullet)+SEP+target(event.build));});
        Events.on(UnitDestroyEvent.class,event->{
            if(running()){death(target(event.unit));dyingUnits.put(event.unit.id,target(event.unit));}
            else unitHealth.remove(event.unit.id,0);
            mineTimers.remove(event.unit.id,0);
        });

        if(Groups.unit.isEmpty() && Groups.build.isEmpty() && Groups.bullet.isEmpty()){
            Groups.unit=new Phased<>(Unit.class,Groups.unit,this::observe,null);
            Groups.build=new Phased<>(Building.class,Groups.build,this::observe,null);
            Groups.bullet=new Phased<>(Bullet.class,Groups.bullet,this::observe,this::observeUnits);
            phased=true;
        }
    }

    static final class Phased<T extends Entityc> extends EntityGroup<T>{
        final Runnable beforeUpdate,beforeCollide;
        Phased(Class<T> type,EntityGroup<T> group,Runnable beforeUpdate,Runnable beforeCollide){
            super(type,group.useTree(),group.mappingEnabled(),indexer(group));
            this.beforeUpdate=beforeUpdate;this.beforeCollide=beforeCollide;
        }
        static EntityIndexer indexer(EntityGroup<?> group){
            try{Field f=EntityGroup.class.getDeclaredField("indexer");f.setAccessible(true);return (EntityIndexer)f.get(group);}
            catch(ReflectiveOperationException e){throw new IllegalStateException("Pinned EntityGroup changed",e);}
        }
        @Override public void update(){beforeUpdate.run();super.update();}
        @Override public void collide(){if(beforeCollide!=null)beforeCollide.run();super.collide();}
    }

    boolean running(){return bridge.started && !bridge.terminal;}
    double now(){return bridge.production.simulationSeconds;}
    boolean placed(Building b){return b.tile!=null && b.tile.build==b && !b.dead;}
    static boolean isTransport(Block b){
        return b instanceof Conveyor || b instanceof StackConveyor || b instanceof Duct || b instanceof ItemBridge || b instanceof DirectionBridge
            || b instanceof Junction || b instanceof Router || b instanceof Sorter || b instanceof OverflowGate || b instanceof DuctRouter
            || b instanceof DuctJunction || b instanceof OverflowDuct || b instanceof MassDriver;
    }
    static void add(Map<String,Double> map,String key,double n){map.merge(key,n,Double::sum);}
    static void count(Map<String,double[]> map,String key){map.computeIfAbsent(key,k->new double[1])[0]++;}
    static Map<String,Double> nested(Map<String,Map<String,Double>> map,String key){return map.computeIfAbsent(key,k->new TreeMap<>());}

    Meter meter(Building b){
        if(!running() || !placed(b) || !(extraction.contains(b.block) || transport.contains(b.block)))return null;
        Meter m=live.get(b);
        if(m!=null && !m.team.equals(b.team.name)){retire(m);m=null;}
        if(m==null){m=new Meter(nextId++,b,now(),extraction.contains(b.block));live.put(b,m);history.add(m);}
        return m;
    }
    void retire(Building b){Meter m=live.get(b);if(m!=null)retire(m);}
    void retire(Meter m){m.active=false;m.ended=Math.max(now(),m.began+m.observed);live.remove(m.building);m.building=null;}

    void itemProduced(Building b,Item item,int amount){Meter m=meter(b);if(m!=null && amount>0){add(m.items,item.name,amount);m.firstItems.putIfAbsent(item.name,now());}}
    void liquidProduced(Building b,Liquid liquid,float amount){Meter m=meter(b);if(m!=null && liquid!=null && amount>0){add(m.liquids,liquid.name,amount);m.firstLiquids.putIfAbsent(liquid.name,now());}}
    void transferred(Building b,Item item){Meter m=meter(b);if(m!=null){add(m.transferred,item.name,1);m.windowItems++;}}

    void received(Building sink,Building source,Item item,int amount){
        if(!running() || source==null || amount<=0 || !isTransport(source.block))return;
        String kind=sink instanceof CoreBlock.CoreBuild?"core":sink instanceof ItemTurret.ItemTurretBuild?"turret":sink.block instanceof UnitFactory?"unit_factory":"crafter";
        add(nested(deliveries,sink.team.name+SEP+kind),item.name,amount);
    }
    String controller(Unit u){
        Player p=u.getPlayer();
        if(p!=null)for(var seat:bridge.seats.entrySet())if(seat.getValue().player==p)return seat.getKey();
        return p!=null?"player":"ai";
    }
    void unitDeposited(Unit u,Item item,int amount){
        if(running() && amount>0)add(nested(unitDeposits,u.team.name+SEP+u.type.name+SEP+controller(u)),item.name,amount);
    }

    void potential(Building b,Meter m,Map<String,Double> items,Map<String,Double> liquids){
        double d=b.delta();
        if(b instanceof Drill.DrillBuild drill){
            if(drill.dominantItem!=null && drill.dominantItems>0)add(items,drill.dominantItem.name,d*drill.dominantItems/((Drill)b.block).getDrillTime(drill.dominantItem));
        }else if(b instanceof BeamDrill.BeamDrillBuild beam){
            if(beam.lastItem!=null && beam.facingAmount>0)add(items,beam.lastItem.name,d*beam.facingAmount/((BeamDrill)b.block).getDrillTime(beam.lastItem));
        }else if(b instanceof WallCrafter.WallCrafterBuild wall){
            WallCrafter block=(WallCrafter)b.block;
            try{float eff=(float)wallEfficiency.invoke(block,(int)b.tile.x,(int)b.tile.y,b.rotation,null,null);if(eff>0)add(items,block.output.name,d*eff/block.drillTime);}
            catch(ReflectiveOperationException e){throw new IllegalStateException(e);}
        }else if(b instanceof Separator.SeparatorBuild){
            Separator block=(Separator)b.block;int sum=0;for(ItemStack s:block.results)sum+=s.amount;
            for(ItemStack s:block.results)add(items,s.item.name,d/block.craftTime*s.amount/sum);
        }else if(b instanceof SolidPump.SolidPumpBuild pump){
            SolidPump block=(SolidPump)b.block;
            double fraction=Math.max(pump.validTiles+pump.boost+(block.attribute==null?0:block.attribute.env()),0);
            if(fraction>0)add(liquids,block.result.name,block.pumpAmount*d*fraction);
        }else if(b instanceof Pump.PumpBuild pump){
            if(pump.liquidDrop!=null && pump.amount>0)add(liquids,pump.liquidDrop.name,pump.amount*((Pump)b.block).pumpAmount*d);
        }
    }
    static Double nominalRate(Block b){
        if(b instanceof Duct duct)return 60d/duct.speed;
        if(b instanceof DuctBridge bridge)return 60d/bridge.speed;
        if(b instanceof BufferedItemBridge bridge)return (double)bridge.displayedSpeed;
        if(b instanceof ItemBridge bridge)return bridge.transportTime>0?60d/bridge.transportTime:null;
        if(b instanceof Junction junction)return (double)junction.displayedSpeed;
        return null;
    }

    static String cause(Building b,boolean blocked){
        if(!b.enabled)return "disabled";
        if(blocked)return "output_blocked";
        if(b.power!=null && b.power.status<0.999999f){
            float other=1f;
            for(Consume c:b.block.nonOptionalConsumers)if(!(c instanceof ConsumePower))other=Math.min(other,c.efficiency(b));
            if(b.power.status<=other)return "power_limited";
        }
        return "input_limited";
    }
    static double shortfall(Building b){return Math.max(0,Math.min(1,1-b.efficiency));}

    void sample(Building b){
        Meter m=meter(b);if(m==null || m.sampleTick==Vars.state.updateId)return;
        m.sampleTick=Vars.state.updateId;
        double seconds=Time.delta/60d;
        m.observed+=seconds;
        if(!b.enabled)m.disabled+=seconds;
        if(b.power!=null && b.power.status<0.999999f)m.powerLimited+=seconds;
        if(b.potentialEfficiency<0.999999f && b.enabled)m.inputLimited+=seconds;
        if(b.efficiency>0)m.working+=seconds;
        if(!m.extraction){
            Double rate=nominalRate(b.block);
            if(rate!=null){double capacity=rate*b.delta()/60d;m.capacity+=capacity;m.windowCapacity+=capacity;m.hasCapacity=true;}
            m.windowSeconds+=seconds;
            return;
        }
        boolean blocked=b.enabled && !b.shouldConsume();
        if(blocked)m.blocked+=seconds;
        var items=new TreeMap<String,Double>();var liquids=new TreeMap<String,Double>();
        potential(b,m,items,liquids);
        items.forEach((k,v)->add(m.potentialItems,k,v));liquids.forEach((k,v)->add(m.potentialLiquids,k,v));
        double lost=shortfall(b);
        if(lost>0){
            String why=cause(b,blocked);Map<String,Map<String,Double>> into=m.lost.computeIfAbsent(why,k->new TreeMap<>());
            items.forEach((k,v)->add(into.computeIfAbsent("items",x->new TreeMap<>()),k,v*lost));
            liquids.forEach((k,v)->add(into.computeIfAbsent("liquids",x->new TreeMap<>()),k,v*lost));
        }
    }

    void lose(ProductionTelemetry.Meter meter,Building b,boolean blocked,String category,String content,double potential){
        if(!running() || potential<=0)return;
        double lost=shortfall(b);if(lost<=0)return;
        Lost l=stalled.computeIfAbsent(meter.id,k->new Lost(meter));
        add(l.of(cause(b,blocked),category),content,potential*lost);
    }

    static float effective(Unit u){return Math.max(0,u.health)+Math.max(0,u.shield);}
    String source(Bullet bullet){
        Entityc owner=bullet==null?null:bullet.owner;
        String team=bullet==null?"unknown":bullet.team.name;
        if(owner instanceof Unit u)return team+SEP+(u.isPlayer()?"player_unit":"unit")+SEP+u.type.name;
        if(owner instanceof Building b)return team+SEP+(b instanceof BaseTurret.BaseTurretBuild?"turret":"building")+SEP+b.block.name;
        return team+SEP+"other"+SEP+"unknown";
    }
    static String target(Unit u){return u.team.name+SEP+(u.isPlayer()?"player_unit":"unit")+SEP+u.type.name;}
    static String target(Building b){return b.team.name+SEP+(b instanceof CoreBlock.CoreBuild?"core":b instanceof BaseTurret.BaseTurretBuild?"turret":"building")+SEP+b.block.name;}

    void attributeDamage(Bullet bullet,String target,IntFloatMap seen,int id,float health,boolean healing){
        float previous=seen.get(id,health);
        double dealt=Math.max(0,previous-health);
        if(healing && health>previous)add(restored,target.substring(0,target.indexOf(SEP)),health-previous);
        seen.put(id,health);
        double[] row=damage.computeIfAbsent(source(bullet)+SEP+target,k->new double[2]);
        row[0]+=dealt;row[1]++;
    }
    void death(String target){count(deaths,target);}

    float residual(IntFloatMap seen,int id,float health){float previous=seen.get(id,health);seen.put(id,health);return previous-health;}
    void unexplained(String target,String team,float change,boolean healing){
        if(change>0)unattributed.computeIfAbsent(target,k->new double[1])[0]+=change;
        else if(healing && change<0)add(restored,team,-change);
    }

    void settle(Map<Integer,String> dying,IntFloatMap seen){
        for(var entry:dying.entrySet()){
            float remaining=seen.get(entry.getKey(),0);seen.remove(entry.getKey(),0);
            if(remaining>0)unexplained(entry.getValue(),null,remaining,false);
        }
        dying.clear();
    }
    void observe(Building b){

        float change=residual(buildHealth,b.id,Math.max(0,b.health));
        if(change!=0)unexplained(target(b),b.team.name,change,!(b instanceof ConstructBuild));
    }
    void observe(Unit u){
        float change=residual(unitHealth,u.id,effective(u));
        if(change!=0)unexplained(target(u),u.team.name,change,true);
    }
    void observe(){
        if(!running())return;
        settle(dyingBuildings,buildHealth);
        for(Team team:Team.all)for(Building b:team.data().buildings)observe(b);
        observeUnits();
    }
    void observeUnits(){
        if(!running())return;
        settle(dyingUnits,unitHealth);
        for(int i=0;i<Groups.unit.size();i++){Unit u=Groups.unit.index(i);if(u.isValid())observe(u);}
    }

    void afterUpdate(){
        if(!running())return;
        double seconds=Time.delta/60d;
        var fire=new HashMap<String,double[]>();
        settle(dyingBuildings,buildHealth);settle(dyingUnits,unitHealth);
        for(Team team:Team.all){
            for(Building b:team.data().buildings){
                if(extraction.contains(b.block) || transport.contains(b.block))sample(b);
                observe(b);
                if(b.enabled && b instanceof BaseTurret.BaseTurretBuild turret)fire.computeIfAbsent(team.name,k->new double[3])[0]+=turret.estimateDps();
            }
        }
        for(Unit u:Groups.unit){
            if(!u.isValid())continue;
            observe(u);
            fire.computeIfAbsent(u.team.name,k->new double[3])[u.isPlayer()?2:1]+=u.type.estimateDps();

            if(mineTimers.containsKey(u.id) && u.mineTile!=null && u.mineTimer<mineTimers.get(u.id,0)){
                Item item=u.getMineResult(u.mineTile);
                if(item!=null)add(nested(mined,u.team.name+SEP+u.type.name+SEP+controller(u)),item.name,1);
            }
            if(u.mineTile!=null || mineTimers.containsKey(u.id))mineTimers.put(u.id,u.mineTimer);
        }
        for(var entry:fire.entrySet())firepower.computeIfAbsent(entry.getKey(),k->new Firepower()).sample(entry.getValue(),seconds);
        for(var f:firepower.entrySet())if(!fire.containsKey(f.getKey()))f.getValue().sample(new double[3],seconds);
        var seenTeams=new HashSet<String>();
        for(PowerGraphUpdaterc updater:Groups.powerGraph){
            PowerGraph g=updater.graph();
            if(g==null || g.all.isEmpty())continue;
            String team=g.all.first().team.name;seenTeams.add(team);
            power.computeIfAbsent(team,k->new Power()).graph(g,seconds);
        }
        for(var p:power.entrySet())p.getValue().close(seconds,seenTeams.contains(p.getKey()));
        for(Iterator<Meter> it=live.values().iterator();it.hasNext();){
            Meter m=it.next();
            if(!placed(m.building) || !m.team.equals(m.building.team.name)){m.active=false;m.ended=Math.max(now(),m.began+m.observed);m.building=null;it.remove();continue;}
            if(!m.extraction && m.windowSeconds>=WINDOW_SECONDS){
                m.classifiedSeconds+=m.windowSeconds;
                if(m.hasCapacity && m.windowCapacity>0 && m.windowItems/m.windowCapacity>=NEAR_CAPACITY)m.nearCapacitySeconds+=m.windowSeconds;
                m.windowSeconds=m.windowItems=m.windowCapacity=0;
            }
        }

        if(++sweeps%600==0){prune(unitHealth,unitIds());prune(mineTimers,unitIds());prune(buildHealth,buildingIds());}
    }
    static Set<Integer> unitIds(){var ids=new HashSet<Integer>();for(Unit u:Groups.unit)ids.add(u.id);return ids;}
    static Set<Integer> buildingIds(){var ids=new HashSet<Integer>();for(Team t:Team.all)for(Building b:t.data().buildings)ids.add(b.id);return ids;}
    static void prune(IntFloatMap map,Set<Integer> keep){
        var drop=new ArrayList<Integer>();var keys=map.keys();
        while(keys.hasNext){int id=keys.next();if(!keep.contains(id))drop.add(id);}
        for(int id:drop)map.remove(id,0);
    }

    Object catalog(){
        var tiers=new HashMap<UnitType,Integer>();var made=new TreeMap<String,List<String>>();
        for(Block b:Vars.content.blocks())if(b instanceof UnitFactory f)for(var plan:f.plans){tiers.put(plan.unit,1);made.computeIfAbsent(plan.unit.name,k->new ArrayList<>()).add(b.name);}
        for(boolean changed=true;changed;){
            changed=false;
            for(Block b:Vars.content.blocks())if(b instanceof Reconstructor r)for(UnitType[] up:r.upgrades){
                Integer from=tiers.get(up[0]);
                if(from!=null && tiers.getOrDefault(up[1],0)<from+1){tiers.put(up[1],from+1);changed=true;}
                if(!made.computeIfAbsent(up[1].name,k->new ArrayList<>()).contains(b.name))made.get(up[1].name).add(b.name);
            }
        }
        var blocks=new TreeMap<String,Object>();
        for(Block b:Vars.content.blocks()){
            if(!b.isVisible())continue;
            var cost=new ArrayList<Object>();for(ItemStack s:b.requirements)cost.add(obj("item",s.item.name,"amount",s.amount));
            blocks.put(b.name,obj("category",b.category.name(),"group",b.group.name(),"size",b.size,"requirements",cost));
        }
        var units=new TreeMap<String,Object>();
        for(UnitType u:Vars.content.units())units.put(u.name,obj("tier",tiers.get(u),"made_by",made.getOrDefault(u.name,List.of()),"flying",u.flying,"estimated_dps",u.estimateDps()));
        return obj("schema_version",1,"blocks",blocks,"units",units,
            "tier_basis","1 for unit-factory plans, +1 per native reconstructor upgrade; null when no factory chain produces the unit");
    }
    void writeCatalog() throws java.io.IOException {Files.writeString(bridge.evidence.resolve("content.json"),json(catalog())+"\n");}

    Object stockpiles(){
        var teams=new TreeMap<String,Object>();
        for(Team team:Team.all){
            CoreBlock.CoreBuild core=team.core();
            if(core==null)continue;
            var items=new TreeMap<String,Object>();
            team.items().each((item,amount)->items.put(item.name,amount));
            teams.put(team.name,obj("cores",team.cores().size,"storage_capacity",core.storageCapacity,"items",items));
        }
        return teams;
    }
    void saveStockpiles(boolean force) throws java.io.IOException {
        if(!bridge.started || (bridge.terminal && !force))return;
        Files.writeString(bridge.evidence.resolve("stockpiles.jsonl"),json(obj("t",bridge.time(),"tick",Vars.state.updateId,
            "simulation_seconds",now(),"final",force,"teams",stockpiles()))+"\n",StandardOpenOption.CREATE,StandardOpenOption.APPEND);
    }
    static List<Object> rows(Map<String,double[]> map,String label,String... names){
        var out=new ArrayList<Object>();
        for(var e:map.entrySet()){
            String[] key=e.getKey().split(SEP,-1);var row=new LinkedHashMap<String,Object>();
            for(int i=0;i<names.length;i++)row.put(names[i],key[i]);
            row.put(label,e.getValue()[0]);
            if(e.getValue().length>1)row.put("events",e.getValue()[1]);
            out.add(row);
        }
        return out;
    }
    static List<Object> tallies(Map<String,Map<String,Double>> map,String... names){
        var out=new ArrayList<Object>();
        for(var e:map.entrySet()){
            String[] key=e.getKey().split(SEP,-1);var row=new LinkedHashMap<String,Object>();
            for(int i=0;i<names.length;i++)row.put(names[i],key[i]);
            row.put("items",new TreeMap<>(e.getValue()));out.add(row);
        }
        return out;
    }
    static final String[] PAIR={"source_team","source_kind","source_type","target_team","target_kind","target_type"},TARGET={"target_team","target_kind","target_type"};
    Object coverage(){
        return obj("schema_version",1,"extraction_blocks",extraction.stream().map(b->b.name).sorted().toList(),
            "transport_blocks",transport.stream().map(b->b.name).sorted().toList(),
            "delivery_sinks",List.of("core","crafter","unit_factory","turret"),
            "stalled_causes",List.of("disabled","output_blocked","power_limited","input_limited"),
            "unmeasured",List.of("unit_cap","mass_driver_throughput","stack_router_throughput","core_overflow_and_incineration"),
            "health_observation",phased?"before_unit_building_bullet_phases_and_end_of_update":"end_of_update",

            "damage_attribution","approximate_within_phase",
            "window_simulation_seconds",WINDOW_SECONDS,"near_capacity_threshold",NEAR_CAPACITY,"evidence","evaluation.jsonl");
    }
    void save(boolean force) throws java.io.IOException {
        if(!bridge.started || (!force && now()-lastSaved<WINDOW_SECONDS))return;
        var meters=new ArrayList<Object>();
        for(Meter m:history)if(m.active || !m.savedRetired)meters.add(m.row());
        var lost=new ArrayList<Object>();for(Lost l:stalled.values())lost.add(l.row());
        var fp=new TreeMap<String,Object>();firepower.forEach((k,v)->fp.put(k,v.row()));
        var pw=new TreeMap<String,Object>();power.forEach((k,v)->pw.put(k,v.row()));
        Files.writeString(bridge.evidence.resolve("evaluation.jsonl"),json(obj("t",bridge.time(),"tick",Vars.state.updateId,
            "simulation_seconds",now(),"final",force,"coverage",coverage(),"buildings",meters,
            "mining",obj("mined",tallies(mined,"team","unit_type","controller"),"unit_deposits",tallies(unitDeposits,"team","unit_type","controller")),
            "deliveries",tallies(deliveries,"team","sink"),"stalled",lost,
            "combat",obj("damage",rows(damage,"damage",PAIR),"unattributed_damage",rows(unattributed,"damage",TARGET),"kills",rows(kills,"count",PAIR),
                "deaths",rows(deaths,"count",TARGET),"restored_health",new TreeMap<>(restored),"firepower",fp),
            "power",pw))+"\n",StandardOpenOption.CREATE,StandardOpenOption.APPEND);
        lastSaved=now();
        for(Meter m:history)if(!m.active)m.savedRetired=true;
    }

    static final class Meter {
        final int id,buildingId,x,y;
        final String type,team,kind;
        final boolean extraction;
        final double began;
        Building building;
        boolean active=true,savedRetired,hasCapacity;
        Double ended;
        long sampleTick=-1;
        double observed,disabled,powerLimited,inputLimited,working,blocked,capacity,windowItems,windowCapacity,windowSeconds,classifiedSeconds,nearCapacitySeconds;
        final Map<String,Double> items=new TreeMap<>(),liquids=new TreeMap<>(),firstItems=new TreeMap<>(),firstLiquids=new TreeMap<>();
        final Map<String,Double> potentialItems=new TreeMap<>(),potentialLiquids=new TreeMap<>(),transferred=new TreeMap<>();
        final Map<String,Map<String,Map<String,Double>>> lost=new TreeMap<>();
        Meter(int id,Building b,double began,boolean extraction){
            this.id=id;this.extraction=extraction;building=b;buildingId=b.id;x=b.tileX();y=b.tileY();type=b.block.name;team=b.team.name;this.began=began;
            Block block=b.block;
            kind=!extraction?(block instanceof Duct?"duct":block instanceof ItemBridge || block instanceof DirectionBridge?"bridge":block instanceof Junction || block instanceof DuctJunction?"junction"
                    :block instanceof Sorter?"sorter":block instanceof OverflowGate || block instanceof OverflowDuct?"overflow_gate":"router")
                :block instanceof Separator?"separator":block instanceof Pump?"pump":block instanceof WallCrafter?"wall_crafter":block instanceof BeamDrill?"beam_drill":"drill";
        }
        static Map<String,Object> copy(Map<String,Map<String,Map<String,Double>>> lost){
            var out=new TreeMap<String,Object>();
            lost.forEach((cause,kinds)->{var k=new TreeMap<String,Object>();kinds.forEach((n,v)->k.put(n,new TreeMap<>(v)));out.put(cause,k);});
            return out;
        }
        Map<String,Object> row(){
            var row=obj("id",id,"building_id",buildingId,"type",type,"kind",kind,"family",extraction?"extraction":"transport","team",team,"x",x,"y",y,
                "active",active,"start_simulation_seconds",began,"end_simulation_seconds",ended,"observed_simulation_seconds",observed,
                "seconds",obj("disabled",disabled,"native_processing",working,"power_limited",powerLimited,"input_or_power_limited",inputLimited,"output_blocked",blocked));
            if(extraction){
                row.put("output",obj("items",new TreeMap<>(items),"liquids",new TreeMap<>(liquids)));
                row.put("first_output_simulation_seconds",obj("items",new TreeMap<>(firstItems),"liquids",new TreeMap<>(firstLiquids)));
                row.put("potential_output",obj("items",new TreeMap<>(potentialItems),"liquids",new TreeMap<>(potentialLiquids)));
                row.put("lost_output",copy(lost));
            }else{
                double moved=ProductionTelemetry.total(transferred);
                row.put("transport",obj("accepted_items",new TreeMap<>(transferred),"nominal_capacity_items",hasCapacity?capacity:null,
                    "capacity_ratio",hasCapacity?ProductionTelemetry.ratio(moved,capacity):null,"near_capacity_seconds",hasCapacity?nearCapacitySeconds:null,
                    "classified_seconds",classifiedSeconds,"partial_window_seconds",windowSeconds));
            }
            return row;
        }
    }
    static final class Lost {
        final int productionId,buildingId;final String type,team,kind;
        final Map<String,Map<String,Map<String,Double>>> causes=new TreeMap<>();
        Lost(ProductionTelemetry.Meter m){productionId=m.id;buildingId=m.buildingId;type=m.type;team=m.team;kind=m.kind;}
        Map<String,Double> of(String cause,String category){return causes.computeIfAbsent(cause,k->new TreeMap<>()).computeIfAbsent(category,k->new TreeMap<>());}
        Object row(){return obj("production_id",productionId,"building_id",buildingId,"type",type,"kind",kind,"team",team,"lost_output",Meter.copy(causes));}
    }
    static final class Firepower {
        double observed,peak;final double[] current=new double[3],dpsSeconds=new double[3];
        void sample(double[] dps,double seconds){
            observed+=seconds;double total=0;
            for(int i=0;i<3;i++){current[i]=dps[i];dpsSeconds[i]+=dps[i]*seconds;total+=dps[i];}
            peak=Math.max(peak,total);
        }
        Object row(){
            return obj("current_dps",obj("turrets",current[0],"units",current[1],"player_units",current[2],"total",current[0]+current[1]+current[2]),
                "dps_seconds",obj("turrets",dpsSeconds[0],"units",dpsSeconds[1],"player_units",dpsSeconds[2]),
                "mean_dps",ProductionTelemetry.ratio(dpsSeconds[0]+dpsSeconds[1]+dpsSeconds[2],observed),"peak_dps",peak,"observed_simulation_seconds",observed);
        }
    }

    static final class Power {
        double observed,needed,supplied,produced,consumerSeconds,fullSeconds,brownoutSeconds,blackoutSeconds,deficitSeconds,stored,capacity;
        int graphs,consumers;boolean deficit;
        void graph(PowerGraph g,double seconds){
            graphs++;consumers+=g.consumers.size;
            stored+=g.getLastPowerStored();capacity+=g.getLastCapacity();
            double need=g.getLastPowerNeeded(),made=g.getLastPowerProduced();
            produced+=made;
            if(g.consumers.size==0)return;
            needed+=need;supplied+=Math.min(need,made);
            double satisfaction=need<=0?1:g.getSatisfaction(),share=g.consumers.size*seconds;
            consumerSeconds+=share;
            if(satisfaction>=0.999)fullSeconds+=share;else if(satisfaction>0)brownoutSeconds+=share;else blackoutSeconds+=share;
            if(satisfaction<0.999)deficit=true;
        }
        int lastGraphs,lastConsumers;double lastStored,lastCapacity;
        void close(double seconds,boolean seen){
            observed+=seconds;if(deficit)deficitSeconds+=seconds;
            lastGraphs=graphs;lastConsumers=consumers;lastStored=stored;lastCapacity=capacity;
            graphs=consumers=0;stored=capacity=0;deficit=false;
        }
        Object row(){
            return obj("observed_simulation_seconds",observed,"graphs",lastGraphs,"consumers",lastConsumers,
                "energy",obj("needed",needed,"supplied",supplied,"produced_including_batteries",produced),
                "satisfaction",ProductionTelemetry.ratio(supplied,needed),
                "consumer_seconds",obj("total",consumerSeconds,"full_power",fullSeconds,"brownout",brownoutSeconds,"blackout",blackoutSeconds),
                "full_power_fraction",ProductionTelemetry.ratio(fullSeconds,consumerSeconds),"deficit_seconds",deficitSeconds,
                "battery",obj("stored",lastStored,"capacity",lastCapacity));
        }
    }
}
