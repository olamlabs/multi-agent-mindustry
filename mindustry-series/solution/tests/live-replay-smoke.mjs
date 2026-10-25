import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startApp } from './app-process.mjs';
import { grade } from '../../environment/sim/grade.mjs';
import { header, sha256 } from '../../environment/render-recording/render.mjs';

const task = fileURLToPath(new URL('../..', import.meta.url));
const evidence = process.env.SMOKE_EVIDENCE ?? '/tmp/mindustry-series-replay-smoke';
const serverJar = process.env.MINDUSTRY_SERVER_JAR ?? '/opt/mindustry/server.jar';
const seats = ['seat-1', 'seat-2', 'seat-3', 'seat-4'];
const sleep = ms => new Promise(done => setTimeout(done, ms));
const json = file => JSON.parse(readFileSync(file, 'utf8'));
mkdirSync(evidence, { recursive: true });

async function series(name, settings, prepare = () => {}, expectedFailure = null) {
  const app = await startApp({ main: join(task, 'environment/sim/main.mjs'), seats, settings: { game_mode: 'pvp', map: 'Harbor Ring', team_count: 2, team_size: 2, seed: 7, chat_after_sec: 0, video: { record: false }, ...settings } });
  try {
    prepare(app.logs);
    const deadline = Date.now() + 600_000;
    while (!(await app.healthy())) {
      assert.ok(app.child.exitCode === null && Date.now() < deadline, `${name}: the app did not boot\n${app.output()}`);
      await sleep(250);
    }
    for (let step = 0; !app.file('result.json'); step++) {
      assert.ok(Date.now() < deadline, `${name}: the series did not finish`);
      for (const [index, seat] of seats.entries()) {
        const angle = step / 3 + index * Math.PI / 2;
        const reply = await app.seat(seat).request('/act', { method: 'POST', body: { ops: [{ op: 'input', move_to: { x: 160 + 60 * Math.cos(angle), y: 160 + 60 * Math.sin(angle) } }] } });
        assert.ok([200, 409, 410].includes(reply.status), `${name}: ${seat} act answered ${reply.status}: ${JSON.stringify(reply.body)}`);
      }
      await sleep(1000);
    }
    const result = JSON.parse(app.file('result.json'));
    if (expectedFailure) {
      assert.match(result.failure, expectedFailure);
      assert.throws(() => grade({ setup: JSON.parse(app.file('setup.json')), result }), /The match failed/);
    } else assert.equal(result.failure, undefined, `${name}: ${JSON.stringify(result)}`);
    app.child.kill('SIGTERM');
    while (app.child.exitCode === null && app.child.signalCode === null) await sleep(100);
    const stats = join(app.logs, 'replay', 'stats.json');
    for (const until = Date.now() + 60_000; !(existsSync(stats) && json(stats).closed) && !(existsSync(stats) && json(stats).failure); ) {
      assert.ok(Date.now() < until, `${name}: the recorder did not close its recording after the server stopped`);
      await sleep(250);
    }
    await sleep(1000);
    cpSync(app.logs, join(evidence, name), { recursive: true });
    return { result, logs: join(evidence, name) };
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

const played = await series('two-games', { time_limit_sec: 20, games: 2, replay: { segment_sec: 600, keyframe_sec: 10 } });
const recording = join(played.logs, 'replay');
const stats = json(join(recording, 'stats.json'));
assert.equal(stats.complete, true, JSON.stringify(stats));
assert.equal(stats.closed, true);
assert.equal(stats.worlds, 2, 'one world per game');
assert.deepEqual(stats.marks.map(({ event, game, reason }) => [event, game, reason]), [['world', 1, undefined], ['start', 1, undefined], ['end', 1, 'time_limit'], ['world', 2, undefined], ['start', 2, undefined], ['end', 2, 'time_limit']], JSON.stringify(stats.marks));
assert.ok(stats.packets.EntitySnapshotCallPacket.count > 150 && stats.packets.WorldDataBeginCallPacket.count === 1, JSON.stringify(stats.packets));
assert.ok(stats.keyframes >= 6, `a keyframe at each world and every 10 s: ${stats.keyframes}`);
const head = header(join(recording, 'segment-000.mreplay'));
assert.equal(head.mindustry.server_jar_sha256, await sha256(serverJar));
assert.ok(Number.isInteger(head.mindustry.build) && head.mindustry.build > 0 && head.mods.some(mod => mod.name === 'harbor-bridge' && mod.hidden === true), JSON.stringify(head));

const [, game1Start, game1End, game2World, game2Start, game2End] = stats.marks.map(mark => mark.t);
const whole = render('render-seat-1', ['--replay', recording, '--seats', 'seat-1', '--client-fps', '10', '--video-fps', '5', '--size', '640x360']);
assert.equal(whole.status, 0, whole.stderr);
const seat1 = json(join(whole.out, 'seat-1.json'));
assert.equal(seat1.ok, true);
assert.equal(seat1.viewer.worlds, 2, JSON.stringify(seat1.viewer));
assert.deepEqual(seat1.viewer.seat_seen, [true, true], 'the view follows seat-1 in both games');
assert.equal(seat1.viewer.cut_short, null);
assert.ok(seat1.viewer.last_rec_sec >= game2End - 1, JSON.stringify(seat1.viewer));
const seat1Frames = frames(seat1.video);
assert.ok(seat1Frames >= 5 * (game2End - seat1.viewer.start_rec_sec) * 0.9, `${seat1Frames} frames for ${game2End - seat1.viewer.start_rec_sec} s`);
const atVideo = rec => rec - seat1.viewer.start_rec_sec + (seat1.go_ms - seat1.ffmpeg_started_ms) / 1000;
for (const rec of [(game1Start + game1End) / 2, (game2Start + game2End) / 2]) assert.ok(contrast(seat1.video, atVideo(rec)) > 60, `a picture, not a blank frame, at ${rec} s`);

const seek = render('render-from-game-2', ['--replay', recording, '--seats', 'seat-3', '--at', '160,160', '--from', String(Math.ceil(game2World + 5)), '--client-fps', '10', '--video-fps', '5', '--size', '640x360']);
assert.equal(seek.status, 0, seek.stderr);
const seat3 = json(join(seek.out, 'seat-3.json')), fixed = json(join(seek.out, 'at-160-160.json'));
for (const view of [seat3, fixed]) {
  assert.equal(view.ok, true, JSON.stringify(view));
  assert.ok(view.viewer.start_rec_sec >= game2World + 5 && view.viewer.start_rec_sec < game2World + 6, JSON.stringify(view.viewer));
  assert.equal(view.viewer.worlds, 1, 'a seek joins at the keyframe before it');
}
assert.deepEqual(seat3.viewer.seat_seen, [true]);

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

const broken = await series('recorder-fails', { time_limit_sec: 20, games: 1, replay: { segment_sec: 1, keyframe_sec: 2 } }, logs => mkdirSync(join(logs, 'replay', 'segment-001.mreplay'), { recursive: true }), /Replay incomplete: cannot write the recording/);
const nativeTerminal = json(join(broken.logs, 'engine', 'state.json')).terminal;
assert.equal(nativeTerminal.reason, 'time_limit', 'the native game is played to its end but the trial is invalid');
assert.equal(broken.result.results, undefined, 'failed recording must not publish a scored series');
const failed = json(join(broken.logs, 'replay', 'stats.json'));
assert.equal(failed.complete, false);
assert.match(failed.failure, /^cannot write the recording: java\.nio\.file\.FileAlreadyExistsException: .*segment-001\.mreplay$/);
assert.equal(failed.segments, 1);
const stoppedLines = readFileSync(join(broken.logs, 'mindustry-server.log'), 'utf8').split('\n').filter(line => line.includes('Harbor replay recorder stopped'));
assert.equal(stoppedLines.length, 1, stoppedLines.join('\n'));
assert.ok(header(join(broken.logs, 'replay', 'segment-000.mreplay')).mindustry.build > 0, 'what was recorded before the failure stays readable');

const summary = { stats: { worlds: stats.worlds, keyframes: stats.keyframes, bytes: stats.bytes, game_thread_ms: stats.game_thread_ms, marks: stats.marks }, seat1: { frames: seat1Frames, viewer: seat1.viewer }, seek: { seat3: seat3.viewer, fixed: fixed.viewer }, failure: failed.failure };
writeFileSync(join(evidence, 'replay-smoke.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary));
