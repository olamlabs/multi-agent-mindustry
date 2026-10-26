import { spawn, execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { bootRenderers, startVideo, stopVideo, stopRenderers } from '../../../environment/sim/renderer.mjs';
import { gridShape } from '../../../environment/dependencies/screen-recorder.mjs';

const evidence = process.env.SMOKE_EVIDENCE ?? '/task/runs/native-renderer-smoke';
const seatCount = Number(process.env.SMOKE_SEATS ?? 4);
assert.ok([4, 8].includes(seatCount), 'SMOKE_SEATS must be 4 or 8');
const seats = Array.from({ length: seatCount }, (_, i) => `seat-${i + 1}`);
const cwd = '/tmp/mindustry-renderer-smoke';
mkdirSync(evidence, { recursive: true });
mkdirSync(`${cwd}/config/mods`, { recursive: true });
execFileSync('sh', ['/task/environment/plugin/build.sh', '/opt/mindustry/server.jar', `${cwd}/config/mods/agent-bridge.jar`]);
const log = openSync(`${evidence}/server.log`, 'a');
const server = spawn('java', ['-Xmx512m', '-jar', '/opt/mindustry/server.jar'], { cwd, stdio: ['pipe', log, log] });
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function call(path, value = {}) {
  const response = await fetch(`http://127.0.0.1:8091${path}`, { method: 'POST', body: JSON.stringify(value), headers: {'content-type': 'application/json'}, signal: AbortSignal.timeout(30_000) });
  const result = await response.json();
  if (!response.ok || !result.ok) throw new Error(JSON.stringify(result));
  return result.result;
}
let handle;
try {
  const until = Date.now() + 60_000;
  for (;;) {
    try { await call('/health'); break; } catch (error) {
      if (server.exitCode !== null || Date.now() > until) throw error;
      await sleep(500);
    }
  }
  const setup = await call('/setup', { game_mode:'survival', map:'Fork', time_limit_sec:null, seed:7, seats, endless_survival:{first_wave_ticks:5184000,wave_spacing_ticks:7200,spawn_seed:1,enemy_unit_health_multiplier:1,enemy_unit_damage_multiplier:1} });
  writeFileSync(`${evidence}/setup.json`, JSON.stringify(setup, null, 2));
  handle = await bootRenderers({ evidence, video: { record: true, width: 640, height: 360, fps: 2 }, seats, onProgress: console.log });
  const ready = seats.map(seat => JSON.parse(readFileSync(`${evidence}/renderers/${seat}-ready.json`, 'utf8')));
  assert.deepEqual(ready.map(view => view.seat), seats);
  assert.equal(new Set(ready.map(view => view.player_id)).size, seatCount, 'each camera must follow a distinct agent');
  assert.ok(ready.every(view => view.native_client));
  assert.equal(new Set(ready.map(view => view.team)).size, 1, 'all cameras follow the cooperative team');
  await startVideo(handle, 30);
  await call('/start', {ready_seats:seats});
  await sleep(12_000);
  const state = await call('/state');
  writeFileSync(`${evidence}/state.json`, JSON.stringify(state, null, 2));
  await call('/stop', {});
  const video = await stopVideo(handle);
  assert.equal(video.complete, true, 'ffmpeg must finalize the native game recording');
  assert.equal(video.still, true, 'native final frame must be captured');
  assert.equal(video.native_clients, seatCount);
  const { columns, rows } = gridShape(seatCount);
  assert.equal(video.width, columns * 640);
  assert.equal(video.height, rows * 360);
  const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', `${evidence}/video/game.mp4`], { encoding: 'utf8' }));
  assert.equal(probe.streams[0].width, video.width);
  assert.equal(probe.streams[0].height, video.height);
  assert.ok(video.files.find(file => file.name === 'video/game.mp4')?.bytes > 1024, 'MP4 must contain frames, not only a header');
  console.log(JSON.stringify(video));
} finally {
  await stopRenderers(handle);
  server.kill('SIGTERM');
  await sleep(500);
  if (server.exitCode === null) server.kill('SIGKILL');
}
