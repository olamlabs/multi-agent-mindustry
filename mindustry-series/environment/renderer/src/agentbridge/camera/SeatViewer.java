package agentbridge.camera;

import arc.Core;
import arc.Events;
import arc.util.Log;
import arc.scene.ui.Dialog;
import mindustry.Vars;
import mindustry.game.EventType.ClientLoadEvent;
import mindustry.game.EventType.Trigger;
import mindustry.game.EventType.WorldLoadEvent;
import mindustry.gen.Groups;
import mindustry.gen.Player;
import mindustry.mod.Mod;
import mindustry.ui.Styles;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;

public final class SeatViewer extends Mod {
    private final String seat = System.getenv().getOrDefault("MINDUSTRY_VIEW_SEAT", "seat-1");
    private final String host = System.getenv().getOrDefault("MINDUSTRY_VIEW_HOST", "127.0.0.1");
    private final String ready = System.getenv().getOrDefault("MINDUSTRY_VIEW_READY", "/tmp/view-ready");
    private boolean announced, loaded, connected;
    private long connectAt, attemptedAt;
    private int worlds;

    private void atomicWrite(String file, String value) throws Exception {
        Path destination = Path.of(file), temporary = Path.of(file + ".tmp");
        Files.writeString(temporary, value);
        Files.move(temporary, destination, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
    }

    private void fail(String why) {
        Log.err("Seat camera @: @", seat, why);
        System.exit(1);
    }

    private void checkConnection() {
        if (!loaded) return;
        long now = System.currentTimeMillis();
        if (attemptedAt == 0) {
            if (now < connectAt) return;
            for (var actor : Core.scene.getElements().copy()) if (actor instanceof Dialog dialog) dialog.hide();
            Vars.player.name = "__view_" + seat;
            attemptedAt = now;
            Log.info("Seat camera @: connecting to @:6567", seat, host);
            Vars.ui.join.connect(host, 6567);
            return;
        }
        if (Vars.net.client()) connected = true;
        else if (connected) fail("lost its connection to " + host + ":6567");
        else if (!Vars.netClient.isConnecting() && now - attemptedAt >= 5000) fail("could not connect to " + host + ":6567");
    }

    public SeatViewer() {
        Events.on(ClientLoadEvent.class, event -> {
            String name = "__view_" + seat;
            Core.settings.put("name", name);
            Core.settings.put("fpscap", Integer.parseInt(System.getenv().getOrDefault("MINDUSTRY_VIEW_FPS", "10")));
            Core.settings.put("vsync", false);
            Core.settings.put("bloom", false);
            Core.settings.put("musicvol", 0);
            Core.settings.put("sfxvol", 0);
            Core.settings.put("smoothcamera", false);
            Core.settings.put("drawWeather", false);
            Core.settings.put("lasersopacity", 50);
            Vars.player.name = name;
            Vars.ui.hudfrag.shown = false;
            Core.scene.table(table -> {
                table.bottom().left().margin(8f);
                table.label(this::statusText).style(Styles.outlineLabel).fontScale(0.75f);
            });
            loaded = true;
            connectAt = System.currentTimeMillis() + 1000;
        });
        Events.on(WorldLoadEvent.class, event -> {
            worlds++;
            announced = false;
        });
        Events.run(Trigger.update, this::checkConnection);
        Events.run(Trigger.preDraw, () -> {
            if (!Vars.net.client() || Vars.netClient.isConnecting() || !Vars.state.isGame()) return;
            Player target = Groups.player.find(p -> seat.equals(p.name));
            if (target == null) return;
            Vars.ui.hudfrag.shown = false;
            if (target.dead()) Core.camera.position.set(target.x, target.y);
            else Core.camera.position.set(target.unit().x, target.unit().y);

            if (!announced) {
                try {
                    atomicWrite(ready, "{\"seat\":\"" + seat + "\",\"player_id\":" + target.id + ",\"team\":\"" + target.team().name + "\",\"native_client\":true,\"worlds\":" + worlds + "}\n");
                    announced = true;
                    Log.info("Seat camera ready for @ (player @, world @)", seat, target.id, worlds);
                } catch (Exception error) {
                    throw new RuntimeException("Cannot write viewer readiness", error);
                }
            }
        });
    }

    private String statusText() {
        Player target = Groups.player.find(p -> seat.equals(p.name));
        if (target == null || !Vars.state.isGame()) return "";
        String unit = target.dead() ? "respawning" : target.unit().type.name + " "
            + Math.round(target.unit().health) + "/" + Math.round(target.unit().maxHealth);
        return target.team().name + " | Wave " + Vars.state.wave + " | " + unit;
    }
}
