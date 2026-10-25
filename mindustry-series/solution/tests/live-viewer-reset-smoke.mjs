import { spawn, execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { bootRenderers, startVideo, stopVideo, stopRenderers } from '../../environment/sim/renderer.mjs';

const evidence = process.env.SMOKE_EVIDENCE ?? '/tmp/mindustry-series-viewer-smoke';
const seats = ['seat-1', 'seat-2', 'seat-3', 'seat-4'];
const cwd = '/tmp/mindustry-viewer-reset-smoke';
mkdirSync(evidence, { recursive: true });
mkdirSync(`${cwd}/config/mods`, { recursive: true });
execFileSync('sh', ['/task/environment/plugin/build.sh', '/opt/mindustry/server.jar', `${cwd}/config/mods/harbor-bridge.jar`]);
const log = openSync(`${evidence}/server.log`, 'a');
const server = spawn('java', ['-Xmx512m', '-jar', '/opt/mindustry/server.jar'], { cwd, stdio: ['pipe', log, log], env: { ...process.env, MINDUSTRY_EVIDENCE_DIR: `${evidence}/engine` } });
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function call(path, value = {}) {
  const response = await fetch(`http://127.0.0.1:8091${path}`, { method: 'POST', body: JSON.stringify(value), headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(30_000) });
  const result = await response.json();
  if (!response.ok || !result.ok) throw new Error(`${path}: ${JSON.stringify(result)}`);
  return result.result;
}
const health = seat => JSON.parse(readFileSync(`${evidence}/renderers/${seat}-connection.json`, 'utf8'));

async function drawing(seat, since, what) {
  const until = Date.now() + 180_000;
  for (;;) {
    const beat = health(seat);
    if (beat.connected && beat.timestamp_ms > since + 6000) return beat;
    assert.ok(Date.now() < until, `${seat}'s viewer is not drawing its seat ${what}: ${JSON.stringify(beat)}`);
    await sleep(500);
  }
}

async function onlySeatUnits(teams) {
  const units = (await call('/query', { seat: 'seat-1', of: 'units', fields: ['id', 'team'], limit: 100000 })).rows;
  assert.equal(units.length, seats.length, JSON.stringify(units));
  for (const team of new Set(Object.values(teams))) assert.equal(units.filter(unit => unit.team === team).length, Object.values(teams).filter(t => t === team).length, JSON.stringify(units));
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
  const setup = await call('/setup', { game_mode: 'pvp', map: 'Harbor Ring', team_count: 2, team_size: 2, time_limit_sec: 600, seed: 7, seats });
  handle = await bootRenderers({ evidence, video: { record: true, width: 640, height: 360, fps: 2 }, seats, onProgress: console.log });
  await startVideo(handle, 600);
  const begun = Date.now();
  await call('/start');
  for (const seat of seats) await drawing(seat, begun, 'in game 1');
  await onlySeatUnits(setup.seat_teams);
  const first = Object.fromEntries(await Promise.all(seats.map(async seat => [seat, (await call('/status', { seat })).you.unit_id])));

  const ended = await call('/stop');
  assert.equal(ended.terminal.game, 1);
  const resetAt = Date.now();
  const reset = await call('/reset');
  const resetMs = Date.now() - resetAt;
  assert.deepEqual([reset.game, reset.started, reset.seat_teams], [2, false, setup.seat_teams]);
  await call('/start');
  const after = {};
  for (const seat of seats) after[seat] = await drawing(seat, resetAt, 'in game 2');
  await onlySeatUnits(setup.seat_teams);
  for (const seat of seats) {
    const you = (await call('/status', { seat })).you;
    assert.ok(you && you.unit_id !== first[seat], `${seat} has a new unit in game 2: ${JSON.stringify(you)}`);
  }
  const events = Object.fromEntries(seats.map(seat => [seat, readFileSync(`${evidence}/renderers/${seat}-connection.json.events.jsonl`, 'utf8').trim().split('\n').map(line => JSON.parse(line))]));

  for (const seat of seats) assert.equal(events[seat].filter(event => event.event === 'connect_attempt').length, 1, `${seat}: ${JSON.stringify(events[seat])}`);

  await sleep(6000);
  await call('/stop');
  const video = await stopVideo(handle);
  assert.equal(video.complete, true, 'ffmpeg must finalize the recording of both games');
  assert.equal(video.still,true,'final PNG captured');
  assert.equal(video.native_clients,seats.length);
  assert.ok(video.files.find(file=>file.name==='video/game.mp4')?.bytes>1024);
  const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', `${evidence}/video/game.mp4`], { encoding: 'utf8' }));
  const recorded = Number(probe.format.duration), played = (Date.now() - begun) / 1000;
  assert.ok(recorded > played - 15, `the recording covers both games: ${recorded} s of ${played} s`);
  const summary = { reset_ms: resetMs, recorded_sec: recorded, played_sec: played, viewers: after, events };
  writeFileSync(`${evidence}/viewer-reset.json`, JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({ reset_ms: resetMs, recorded_sec: recorded, played_sec: played, connections: Object.fromEntries(seats.map(seat => [seat, after[seat].connections])) }));
} finally {
  await stopRenderers(handle);
  server.kill('SIGTERM');
  await sleep(500);
  if (server.exitCode === null) server.kill('SIGKILL');
}
