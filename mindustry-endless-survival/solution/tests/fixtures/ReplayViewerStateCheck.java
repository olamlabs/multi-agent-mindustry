package agentbridge.replay;

import arc.Events;
import mindustry.game.EventType.WorldLoadEvent;
import java.util.List;

public final class ReplayViewerStateCheck{
    public static void main(String[] args){
        ReplayViewer viewer=new ReplayViewer();
        viewer.begun=true;
        for(List<Boolean> preroll:List.of(List.of(false,false),List.of(false,true),List.of(true,false),List.of(true))){
            viewer.prepared=false;
            viewer.seen.clear();
            viewer.seen.addAll(preroll);
            viewer.finishPreparation();
            if(!viewer.prepared||!viewer.seen.equals(List.of(preroll.get(preroll.size()-1))))
                throw new AssertionError("seek must retain exactly the current world's visibility: "+preroll+" -> "+viewer.seen);
        }
        Events.fire(new WorldLoadEvent());
        if(!viewer.seen.equals(List.of(true,false)))
            throw new AssertionError("a later rendered world must retain its own missing-seat evidence: "+viewer.seen);
        viewer.seen.clear();
        viewer.prepared=false;
        viewer.finishPreparation();
        if(!viewer.prepared||!viewer.seen.isEmpty())
            throw new AssertionError("preparation must not invent a world when none loaded");
        System.out.println("{\"ok\":true,\"preroll_cases\":4,\"later_world_kept\":true,\"empty_worlds_kept\":true}");
    }
}
