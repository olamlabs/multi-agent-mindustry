// SPDX-License-Identifier: GPL-3.0-only

package harbor.mindustry;

import arc.Core;
import arc.Events;
import arc.util.Log;
import arc.scene.ui.Dialog;
import mindustry.Vars;
import mindustry.game.EventType.ClientLoadEvent;
import mindustry.game.EventType.Trigger;
import mindustry.gen.Groups;
import mindustry.gen.Player;
import mindustry.mod.Mod;
import mindustry.ui.Styles;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;

public final class SeatViewer extends Mod {
    private final String seat = System.getenv().getOrDefault("HARBOR_VIEW_SEAT", "seat-1");
    private final String ready = System.getenv().getOrDefault("HARBOR_VIEW_READY", "/tmp/view-ready");
    private final String health = System.getenv().getOrDefault("HARBOR_VIEW_HEALTH", ready + ".health.json");
    private boolean announced, loaded, connected;
    private long lastFrame, lastCheck, lastHeartbeat, nextConnect, attemptStarted, disconnectedSince;
    private int connections, attempts;

    private void atomicWrite(String file, String value) throws Exception {
        Path destination = Path.of(file), temporary = Path.of(file + ".tmp");
        Files.writeString(temporary, value);
        Files.move(temporary, destination, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
    }

    private void connectionEvent(String event, long now) throws Exception {
        Files.writeString(Path.of(health + ".events.jsonl"), "{\"timestamp_ms\":" + now
            + ",\"seat\":\"" + seat + "\",\"event\":\"" + event + "\",\"connections\":" + connections + "}\n",
            StandardOpenOption.CREATE, StandardOpenOption.APPEND);
        Log.info("Harbor viewer @: @ at @", seat, event, now);
    }

    private void checkConnection() {
        long now = System.currentTimeMillis();
        if (!loaded || now - lastCheck < 250) return;
        lastCheck = now;
        boolean live = Vars.net.client() && !Vars.netClient.isConnecting() && Vars.state.isGame()
            && lastFrame > 0 && now - lastFrame < 5000;
        try {
            if (live != connected) {
                connected = live;
                if (live) {
                    connections++;
                    disconnectedSince = 0;
                    attemptStarted = 0;
                    connectionEvent("connected", now);
                } else {
                    disconnectedSince = now;
                    nextConnect = now + 1000;
                    connectionEvent("disconnected", now);
                }
            }
            if (!live && now >= nextConnect) {

                if ((Vars.net.client() || Vars.netClient.isConnecting()) && attemptStarted == 0) attemptStarted = now;
                if (attemptStarted > 0 && now - attemptStarted >= 30000) {
                    Vars.netClient.disconnectQuietly();
                    attemptStarted = 0;
                }
                if (!Vars.net.client() && !Vars.netClient.isConnecting()) {
                    for (var actor : Core.scene.getElements().copy()) if (actor instanceof Dialog dialog) dialog.hide();
                    Vars.player.name = "__view_" + seat;
                    attemptStarted = now;
                    nextConnect = now + 5000;
                    attempts++;
                    connectionEvent("connect_attempt", now);
                    Vars.ui.join.connect("127.0.0.1", 6567);
                }
            }
            if (now - lastHeartbeat >= 1000) {
                atomicWrite(health, "{\"seat\":\"" + seat + "\",\"timestamp_ms\":" + now
                    + ",\"connected\":" + live + ",\"connections\":" + connections + ",\"attempts\":" + attempts
                    + ",\"disconnected_since_ms\":" + disconnectedSince + "}\n");
                lastHeartbeat = now;
            }
        } catch (Exception error) {
            throw new RuntimeException("Cannot maintain viewer connection evidence", error);
        }
    }

    public SeatViewer() {
        Events.on(ClientLoadEvent.class, event -> {
            String name = "__view_" + seat;
            Core.settings.put("name", name);
            Core.settings.put("fpscap", Integer.parseInt(System.getenv().getOrDefault("HARBOR_VIEW_FPS", "10")));
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
            nextConnect = System.currentTimeMillis() + 1000;
            disconnectedSince = System.currentTimeMillis();
        });
        Events.run(Trigger.update, this::checkConnection);
        Events.run(Trigger.preDraw, () -> {
            if (!Vars.net.client() || Vars.netClient.isConnecting() || !Vars.state.isGame()) return;
            Player target = Groups.player.find(p -> seat.equals(p.name));
            if (target == null) return;
            lastFrame = System.currentTimeMillis();
            Vars.ui.hudfrag.shown = false;
            if (target.dead()) Core.camera.position.set(target.x, target.y);
            else Core.camera.position.set(target.unit().x, target.unit().y);

            if (!announced) {
                try {
                    atomicWrite(ready, "{\"seat\":\"" + seat + "\",\"player_id\":" + target.id + ",\"team\":\"" + target.team().name + "\",\"native_client\":true}\n");
                    announced = true;
                    Log.info("Harbor native viewer ready for @ (player @)", seat, target.id);
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
