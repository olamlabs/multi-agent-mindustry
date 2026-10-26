import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startApp } from '../fixtures/app-process.mjs';
import { header, sha256 } from '../../../environment/render-recording/render.mjs';

const task = fileURLToPath(new URL('../../..', import.meta.url));
const evidence = process.env.SMOKE_EVIDENCE ?? '/tmp/mindustry-endless-replay-smoke';
const serverJar = process.env.MINDUSTRY_SERVER_JAR ?? '/opt/mindustry/server.jar';
const seats = ['seat-1', 'seat-2'];
const profile = { first_wave_ticks: 600, wave_spacing_ticks: 600, spawn_seed: 1, enemy_unit_health_multiplier: 1, enemy_unit_damage_multiplier: 100 };
const sleep = ms => new Promise(done => setTimeout(done, ms));
const json = file => JSON.parse(readFileSync(file, 'utf8'));
mkdirSync(evidence, { recursive: true });

function score(logs, valid) {
  const reward = join(logs, 'replay-smoke-reward.json');
  const run = spawnSync(process.execPath, [join(task, 'environment/sim/verify.mjs'), logs, reward], { encoding: 'utf8', env: { ...process.env, MINDUSTRY_SURVIVAL_SEATS: String(seats.length) } });
  if (!valid) {
    assert.notEqual(run.status, 0, `the verifier scored a failed run: ${run.stdout}`);
    assert.equal(existsSync(reward), false, 'a failed run has no reward');
    return null;
  }
  assert.equal(run.status, 0, run.stderr);
  return json(reward).reward;
}

async function game(name, replay, prepare = () => {}, expectedFailure = null) {
  const app = await startApp({ main: join(task, 'environment/sim/main.mjs'), seats, settings: { endless_survival: profile, video: { record: false }, replay } });
  try {
    prepare(app.logs);
    const deadline = Date.now() + 900_000;
    while (!(await app.healthy())) {
      assert.ok(app.child.exitCode === null && Date.now() < deadline, `${name}: the app did not boot\n${app.output()}`);
      await sleep(250);
    }
    for (const seat of seats) await app.seat(seat).post('/ready', {});
    const home = {};
    for (let step = 0; !app.file('result.json'); step++) {
      assert.ok(Date.now() < deadline, `${name}: the core did not fall`);
      for (const [index, seat] of seats.entries()) {
        const { status } = await app.seat(seat).get('/update');
        if (status.phase !== 'running' || !status.you) continue;
        home[seat] ??= { x: status.you.x, y: status.you.y };
        const angle = step / 3 + index * Math.PI;
        const reply = await app.seat(seat).request('/act', { method: 'POST', body: { ops: [{ op: 'input', move_to: { x: home[seat].x + 8 * Math.cos(angle), y: home[seat].y + 8 * Math.sin(angle) } }] } });
        assert.ok([200, 409].includes(reply.status), `${name}: ${seat} act answered ${reply.status}: ${JSON.stringify(reply.body)}`);
      }
      await sleep(1000);
    }
    const result = JSON.parse(app.file('result.json'));
    if (expectedFailure) assert.match(result.failure, expectedFailure, `${name}: ${JSON.stringify(result)}`);
    else {
      assert.equal(result.failure, undefined, `${name}: ${JSON.stringify(result)}`);
      assert.equal(result.terminal.reason, 'core_destroyed', `${name}: ${JSON.stringify(result.terminal)}`);
    }
    app.child.kill('SIGTERM');
    while (app.child.exitCode === null && app.child.signalCode === null) await sleep(100);
    cpSync(app.logs, join(evidence, name), { recursive: true });
    const logs = join(evidence, name);
    return { result, logs, home, reward: score(logs, !expectedFailure), provenance: json(join(logs, 'setup.json')).benchmark.scenario.native_setup.provenance };
  } finally {
    await app.stop();
  }
}

function render(name, args) {
  const out = join(evidence, name);
  const run = spawnSync(process.execPath, [join(task, 'environment/render-recording/render.mjs'), '--out', out, ...args], { encoding: 'utf8' });
  writeFileSync(join(evidence, `${name}.log`), `${run.stdout}\n${run.stderr}`);
  return { ...run, out };
}

function frames(video) {
  return Number(execFileSync('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', video], { encoding: 'utf8' }).trim());
}

function contrast(video, second) {
  const stats = execFileSync('ffmpeg', ['-v', 'error', '-ss', String(second), '-i', video, '-frames:v', '1', '-vf', 'signalstats,metadata=print:file=-', '-f', 'null', '-'], { encoding: 'utf8' });
  const value = key => Number(new RegExp(`lavfi\\.signalstats\\.${key}=([0-9.]+)`).exec(stats)[1]);
  return value('YMAX') - value('YMIN');
}

function patched(source, target, change) {
  mkdirSync(target, { recursive: true });
  const bytes = readFileSync(source);
  const length = bytes.readUInt32BE(8);
  const head = JSON.parse(bytes.subarray(12, 12 + length).toString('utf8'));
  change(head);
  const text = Buffer.from(JSON.stringify(head));
  const size = Buffer.alloc(4);
  size.writeUInt32BE(text.length);
  writeFileSync(join(target, 'segment-000.mreplay'), Buffer.concat([bytes.subarray(0, 8), size, text, bytes.subarray(12 + length)]));
}

const played = await game('recorded', { record: true, segment_sec: 600, keyframe_sec: 10 });
assert.ok(played.reward > 0, `a recorded game is scored: ${played.reward}`);
const recording = join(played.logs, 'replay');
const stats = json(join(recording, 'stats.json'));
assert.equal(stats.complete, true, JSON.stringify(stats));
assert.equal(stats.closed, true);
assert.equal(stats.worlds, 1, 'one world per survival game');
assert.deepEqual(stats.marks.map(({ event, reason }) => [event, reason]), [['world', undefined], ['start', undefined], ['end', 'core_destroyed']], JSON.stringify(stats.marks));
const [, start, end] = stats.marks.map(mark => mark.t);
assert.ok(stats.packets.EntitySnapshotCallPacket.count > 3 * (end - start), JSON.stringify(stats.packets));
assert.ok(stats.keyframes >= Math.floor((end - stats.marks[0].t) / 10), `a keyframe at the world and every 10 s: ${stats.keyframes}`);
const manifest = json(join(recording, 'manifest.json'));
assert.equal(manifest.closed, true);
assert.equal(manifest.segments.length, stats.segments);
const head = header(join(recording, 'segment-000.mreplay'));
assert.equal(head.mindustry.server_jar_sha256, await sha256(serverJar));
assert.ok(Number.isInteger(head.mindustry.build) && head.mindustry.build > 0 && head.mods.some(mod => mod.name === 'agent-bridge' && mod.hidden === true), JSON.stringify(head));

const whole = render('render-seat-1', ['--replay', recording, '--seats', 'seat-1', '--client-fps', '10', '--video-fps', '5', '--size', '640x360']);
assert.equal(whole.status, 0, whole.stderr);
const seat1 = json(join(whole.out, 'seat-1.json'));
assert.equal(seat1.ok, true);
assert.equal(seat1.viewer.worlds, 1, JSON.stringify(seat1.viewer));
assert.deepEqual(seat1.viewer.seat_seen, [true], 'the view follows seat-1');
assert.equal(seat1.viewer.cut_short, null);
assert.ok(seat1.viewer.last_rec_sec >= end - 1, JSON.stringify(seat1.viewer));
const seat1Frames = frames(seat1.video);
assert.ok(seat1Frames >= 5 * (end - seat1.viewer.start_rec_sec) * 0.9, `${seat1Frames} frames for ${end - seat1.viewer.start_rec_sec} s`);
const atVideo = rec => rec - seat1.viewer.start_rec_sec + (seat1.go_ms - seat1.ffmpeg_started_ms) / 1000;
assert.ok(contrast(seat1.video, atVideo((start + end) / 2)) > 60, `a picture, not a blank frame, at ${(start + end) / 2} s`);

const from = Math.ceil((start + end) / 2);
const at = `${Math.round(played.home['seat-1'].x)},${Math.round(played.home['seat-1'].y)}`;
const seek = render('render-seek', ['--replay', recording, '--seats', 'seat-2', '--at', at, '--from', String(from), '--client-fps', '10', '--video-fps', '5', '--size', '640x360']);
assert.equal(seek.status, 0, seek.stderr);
const seat2 = json(join(seek.out, 'seat-2.json')), fixed = json(join(seek.out, `at-${at.replace(',', '-')}.json`));
for (const view of [seat2, fixed]) {
  assert.equal(view.ok, true, JSON.stringify(view));
  assert.ok(view.viewer.start_rec_sec >= from && view.viewer.start_rec_sec < from + 1, JSON.stringify(view.viewer));
  assert.equal(view.viewer.worlds, 1, 'a seek joins at the keyframe before it');
}
assert.deepEqual(seat2.viewer.seat_seen, [true]);

const otherJar = join(evidence, 'other-server');
patched(join(recording, 'segment-000.mreplay'), otherJar, made => { made.mindustry.server_jar_sha256 = '0'.repeat(64); });
const refusedJar = render('refused-server-jar', ['--replay', otherJar, '--seats', 'seat-1']);
assert.equal(refusedJar.status, 2, refusedJar.stderr);
assert.match(refusedJar.stderr, new RegExp(`^Refused: The recording was made by Mindustry \\d+\\.\\d+ \\(\\w+\\) with a server jar whose SHA-256 is 0{64}; ${serverJar} here has [0-9a-f]{64}\\. Render it in the game image the recording was made with\\.`));
assert.equal(existsSync(join(refusedJar.out, 'views')), false, 'nothing started');
const otherBuild = join(evidence, 'other-build');
patched(join(recording, 'segment-000.mreplay'), otherBuild, made => { made.mindustry.build += 1000; });
const refusedBuild = render('refused-build', ['--replay', otherBuild, '--seats', 'seat-1']);
assert.equal(refusedBuild.status, 2, refusedBuild.stderr);
assert.match(refusedBuild.stderr, /^Refused: This recording was made by Mindustry \d+\.\d+ \(\w+, major \d+\); this client is Mindustry \d+\.\d+ \(\w+, major \d+\)\. Render it with the game image of the build that recorded it\./);

const broken = await game('recorder-fails', { record: true, segment_sec: 1, keyframe_sec: 2 }, logs => mkdirSync(join(logs, 'replay', 'segment-001.mreplay'), { recursive: true }), /Replay incomplete: cannot write the recording/);
assert.equal(json(join(broken.logs, 'engine', 'state.json')).reason, 'core_destroyed', 'the native game is played to its end but the run is invalid');
assert.equal(broken.reward, null, 'a failed recording fails the run');
assert.match(json(join(broken.logs, 'failure.json')).error, /Replay incomplete: cannot write the recording/);
const failed = json(join(broken.logs, 'replay', 'stats.json'));
assert.equal(failed.complete, false);
assert.match(failed.failure, /^cannot write the recording: java\.nio\.file\.FileAlreadyExistsException: .*segment-001\.mreplay$/);
assert.equal(failed.segments, 1);
assert.equal(existsSync(join(broken.logs, 'replay', 'manifest.json')), false);
const stoppedLines = readFileSync(join(broken.logs, 'mindustry-server.log'), 'utf8').split('\n').filter(line => line.includes('Replay recorder stopped'));
assert.equal(stoppedLines.length, 1, stoppedLines.join('\n'));
assert.ok(header(join(broken.logs, 'replay', 'segment-000.mreplay')).mindustry.build > 0, 'what was recorded before the failure stays readable');

const unrecorded = await game('not-recorded', { record: false });
assert.ok(unrecorded.reward > 0);
assert.equal(existsSync(join(unrecorded.logs, 'replay')), false, 'replay.record false writes no recording');
assert.deepEqual(unrecorded.provenance, played.provenance, 'recording does not change the map, rules, profile or wave schedule');
assert.deepEqual(broken.provenance, played.provenance);

const summary = { stats: { worlds: stats.worlds, keyframes: stats.keyframes, bytes: stats.bytes, game_thread_ms: stats.game_thread_ms, marks: stats.marks }, rewards: { recorded: played.reward, failed_recording: broken.reward, not_recorded: unrecorded.reward }, seat1: { frames: seat1Frames, viewer: seat1.viewer }, seek: { seat2: seat2.viewer, fixed: fixed.viewer }, failure: failed.failure };
writeFileSync(join(evidence, 'replay-smoke.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary));
