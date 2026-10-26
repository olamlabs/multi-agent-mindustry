import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, copyFileSync, createReadStream, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const here = dirname(fileURLToPath(import.meta.url));
const plugin = join(here, '..', 'plugin');
const sleep = ms => new Promise(done => setTimeout(done, ms));
const USAGE = 'node environment/render-recording/render.mjs --replay <dir> --out <dir> [--seats seat-1,seat-3] [--at <x>,<y>] [--from <sec>] [--to <sec>] [--client-fps 30] [--video-fps 10] [--size 960x540] [--desktop-jar /opt/mindustry/Mindustry.jar] [--server-jar /opt/mindustry/server.jar]';

export class Refused extends Error {}

export function options(argv) {
  const { values } = parseArgs({ args: argv, strict: true, options: {
    replay: { type: 'string' }, out: { type: 'string' }, seats: { type: 'string' }, at: { type: 'string' },
    from: { type: 'string', default: '0' }, to: { type: 'string' }, 'client-fps': { type: 'string', default: '30' }, 'video-fps': { type: 'string', default: '10' },
    size: { type: 'string', default: '960x540' }, 'desktop-jar': { type: 'string', default: '/opt/mindustry/Mindustry.jar' }, 'server-jar': { type: 'string', default: '/opt/mindustry/server.jar' },
  } });
  const fail = message => { throw new Error(`${message}\nUsage: ${USAGE}`); };
  if (!values.replay) fail('--replay is required');
  if (!values.out) fail('--out is required');
  const seats = values.seats ? values.seats.split(',') : [];
  if (seats.some(seat => !/^seat-([1-9]|[1-9][0-9]|1[0-9][0-9]|200)$/.test(seat)) || new Set(seats).size !== seats.length) fail('--seats is a list of distinct seats from seat-1 through seat-200');
  let at = null;
  if (values.at !== undefined) {
    if (!/^-?\d+(\.\d+)?,-?\d+(\.\d+)?$/.test(values.at)) fail('--at is a tile position such as 160,160');
    at = values.at.split(',').map(Number);
  }
  if (!seats.length && !at) fail('Name at least one seat (--seats) or a fixed camera (--at)');
  const number = (name, value, check) => { const n = Number(value); if (value === '' || !check(n)) fail(`Invalid --${name} ${value}`); return n; };
  const from = number('from', values.from, n => n >= 0);
  const to = values.to === undefined ? null : number('to', values.to, n => n > from);
  const clientFps = number('client-fps', values['client-fps'], n => Number.isInteger(n) && n >= 1 && n <= 120);
  const videoFps = number('video-fps', values['video-fps'], n => Number.isInteger(n) && n >= 1 && n <= 60);
  const size = /^(\d+)x(\d+)$/.exec(values.size);
  const [width, height] = size ? [Number(size[1]), Number(size[2])] : [];
  if (!size || width % 2 || height % 2 || width < 320 || height < 240 || width > 3840 || height > 2160) fail('--size is an even WIDTHxHEIGHT from 320x240 to 3840x2160');
  const views = [...seats.map(seat => ({ name: seat, seat })), ...(at ? [{ name: `at-${at[0]}-${at[1]}`, seat: 'none', at }] : [])];
  return { replay: resolve(values.replay), out: resolve(values.out), views, from, to, clientFps, videoFps, width, height, desktopJar: values['desktop-jar'], serverJar: values['server-jar'] };
}

export function segments(path) {
  if (!statSync(path).isDirectory()) return [path];
  return readdirSync(path).filter(name => /^segment-\d+\.mreplay$/.test(name)).sort((a,b)=>Number(a.match(/\d+/)[0])-Number(b.match(/\d+/)[0])).map(name => join(path, name));
}

export function header(file) {
  const fd = openSync(file, 'r');
  try {
    const head = Buffer.alloc(12);
    if (readSync(fd, head, 0, 12, 0) !== 12 || head.subarray(0, 8).toString('ascii') !== 'MREPLAY1') throw new Refused(`${file} is not a Mindustry replay segment`);
    const json = Buffer.alloc(head.readUInt32BE(8));
    if (readSync(fd, json, 0, json.length, 12) !== json.length) throw new Refused(`${file} ends inside its header`);
    return JSON.parse(json.toString('utf8'));
  } finally { closeSync(fd); }
}

export function sha256(file) {
  return new Promise((done, failed) => {
    const hash = createHash('sha256');
    createReadStream(file).on('error', failed).on('data', chunk => hash.update(chunk)).on('end', () => done(hash.digest('hex')));
  });
}

const describe = mindustry => `Mindustry ${mindustry.build}.${mindustry.revision} (${mindustry.type})`;

export function refusal(headers, serverJar, serverJarSha256) {
  const [first] = headers;
  if (!first) return 'The recording has no .mreplay segments.';
  if (headers.some(head => head.format !== 'mindustry-replay/1')) return `The recording's format is ${headers.find(head => head.format !== 'mindustry-replay/1').format}; this renderer plays mindustry-replay/1.`;
  if (headers.some(head => head.started_unix_ms !== first.started_unix_ms || head.mindustry.server_jar_sha256 !== first.mindustry.server_jar_sha256)) return 'The segments come from more than one recording; render one recording at a time.';
  const content = first.mods.filter(mod => !mod.hidden);
  if (content.length) return `The recording was made with the content mods ${content.map(mod => `${mod.name} ${mod.version}`).join(', ')}; this renderer loads only its viewer mod.`;
  if (first.mindustry.server_jar_sha256 !== serverJarSha256) return `The recording was made by ${describe(first.mindustry)} with a server jar whose SHA-256 is ${first.mindustry.server_jar_sha256}; ${serverJar} here has ${serverJarSha256}. Render it in the game image the recording was made with.`;
  return null;
}

function launch(dir, name, command, args, env = {}) {
  const fd = openSync(join(dir, `${name}.log`), 'a');
  const child = spawn(command, args, { cwd: dir, env: { ...process.env, ...env }, stdio: ['pipe', fd, fd] });
  closeSync(fd);
  const proc = { name, child, log: join(dir, `${name}.log`), error: null };
  child.on('error', error => { proc.error = error; });
  child.stdin.on('error', error => { proc.error ??= error; });
  return proc;
}
const alive = proc => !proc.error && proc.child.exitCode === null && proc.child.signalCode === null;
const exited = proc => `${proc.name} exited (${proc.error?.message ?? proc.child.exitCode ?? proc.child.signalCode}); see ${proc.log}`;

function display(used) {
  for (let n = 120; ; n++) if (!used.has(n) && !existsSync(`/tmp/.X11-unix/X${n}`) && !existsSync(`/tmp/.X${n}-lock`)) { used.add(n); return n; }
}

async function waitForDisplay(view, xvfb) {
  for (;;) {
    if (!alive(xvfb)) throw new Error(exited(xvfb));
    try {
      if (execFileSync('xdotool', ['getdisplaygeometry'], { env: { ...process.env, DISPLAY: view.display }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() === `${view.width} ${view.height}`) return;
    } catch {}
    await sleep(100);
  }
}

function firstFrame(file) {
  if (!existsSync(file) || statSync(file).size < 1024) return false;
  try {
    return JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-read_intervals', '%+#1', '-show_entries', 'frame=best_effort_timestamp_time', '-of', 'json', file], { encoding: 'utf8' })).frames?.length > 0;
  } catch { return false; }
}

export function recordingArgs(view, fps, file) {
  return ['-y', '-loglevel', 'warning', '-f', 'x11grab', '-draw_mouse', '0', '-framerate', String(fps), '-video_size', `${view.width}x${view.height}`, '-i', view.display,
    '-c:v', 'libx264', '-threads', '1', '-preset', 'veryfast', '-tune', 'animation', '-crf', '28',
    '-g', String(fps * 2), '-pix_fmt', 'yuv420p', '-r', String(fps), '-flush_packets', '1', '-movflags', '+frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4', file];
}

export function validateRenderedView(view, viewer) {
  if (viewer.error) throw new Error(`${view.name}: ${viewer.error}`);
  if (view.seat !== 'none' && (!Number.isSafeInteger(viewer.worlds) || viewer.worlds < 1
    || !Array.isArray(viewer.seat_seen) || viewer.seat_seen.length !== viewer.worlds || viewer.seat_seen.some(seen => seen !== true))) {
    throw new Refused(`${view.name}: requested seat ${view.seat} was not visible in every rendered world; choose a seat present in this recording or a fixed camera (--at).`);
  }
}

async function render(view, run, previous, release) {
  const dir = join(run.out, 'views', view.name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, 'data', 'mods'), { recursive: true });
  copyFileSync(run.viewerJar, join(dir, 'data', 'mods', 'agent-bridge-replay.jar'));
  const files = { ready: join(dir, 'ready.json'), go: join(dir, 'go'), done: join(dir, 'done.json') };
  const video = join(run.out, `${view.name}.mp4`);
  const result = { view: view.name, seat: view.seat, at: view.at ?? null, video, from_sec: run.from, to_sec: run.to, client_fps: run.clientFps, video_fps: run.videoFps, width: run.width, height: run.height };
  const procs = [];
  view.procs = procs;
  try {
    await previous;
    const xvfb = launch(dir, 'xvfb', 'Xvfb', [view.display, '-screen', '0', `${view.width}x${view.height}x24`, '-nolisten', 'tcp']);
    procs.push(xvfb);
    await waitForDisplay(view, xvfb);
    const client = launch(dir, 'client', 'java', ['-XX:ActiveProcessorCount=2', '-Xms128m', '-Xmx1g', '-Dnodiscord=true', '-Djava.awt.headless=false', `-Dmindustry.data.dir=${join(dir, 'data')}`, '-jar', run.desktopJar, '-width', String(view.width), '-height', String(view.height), '-maximized', 'false'], {
      DISPLAY: view.display, SDL_VIDEODRIVER: 'x11', SDL_AUDIODRIVER: 'dummy', LIBGL_ALWAYS_SOFTWARE: '1', LP_NUM_THREADS: '2',
      MINDUSTRY_REPLAY_DIR: run.replay, MINDUSTRY_REPLAY_FROM: String(run.from), MINDUSTRY_REPLAY_TO: run.to === null ? '' : String(run.to),
      MINDUSTRY_VIEW_SEAT: view.seat, MINDUSTRY_VIEW_AT: view.at ? view.at.join(',') : '', MINDUSTRY_VIEW_FPS: String(run.clientFps),
      MINDUSTRY_REPLAY_READY: files.ready, MINDUSTRY_REPLAY_GO: files.go, MINDUSTRY_REPLAY_DONE: files.done,
    });
    procs.push(client);
    while (!existsSync(files.ready)) {
      if (existsSync(files.done)) {
        const done = JSON.parse(readFileSync(files.done, 'utf8'));
        if (done.refused) throw new Refused(done.refused);
        throw new Error(`${view.name}: the viewer ended before it was ready: ${done.error}`);
      }
      if (!alive(client)) throw new Error(exited(client));
      await sleep(100);
    }
    execFileSync('xdotool', ['search', '--sync', '--name', '^Mindustry$', 'windowmove', '0', '0'], { env: { ...process.env, DISPLAY: view.display } });
    release();
    result.ffmpeg_started_ms = Date.now();
    const ffmpeg = launch(dir, 'ffmpeg', 'ffmpeg', recordingArgs(view, run.videoFps, video));
    procs.push(ffmpeg);
    while (!firstFrame(video)) {
      if (!alive(ffmpeg)) throw new Error(exited(ffmpeg));
      await sleep(100);
    }
    result.first_frame_ms = Date.now();
    writeFileSync(files.go, '');
    result.go_ms = Date.now();
    while (!existsSync(files.done)) {
      if (!alive(client)) throw new Error(exited(client));
      if (!alive(ffmpeg)) throw new Error(exited(ffmpeg));
      await sleep(100);
    }
    await sleep(Math.ceil(2000 / run.videoFps));
    ffmpeg.child.stdin.end('q\n');
    while (alive(ffmpeg)) await sleep(100);
    if (ffmpeg.error || ffmpeg.child.exitCode !== 0) throw new Error(exited(ffmpeg));
    result.viewer = JSON.parse(readFileSync(files.done, 'utf8'));
    validateRenderedView(view, result.viewer);
    result.ok = true;
  } catch (error) {
    result.ok = false;
    result.refused = error instanceof Refused ? error.message : null;
    result.error = error instanceof Refused ? null : error.message;
  } finally {
    release();
    await stop(procs);
    writeFileSync(join(run.out, `${view.name}.json`), JSON.stringify(result, null, 2) + '\n');
  }
  return result;
}

async function stop(procs) {
  for (const proc of [...procs].reverse()) if (alive(proc)) proc.child.kill('SIGTERM');
  while (procs.some(alive)) await sleep(100);
}

export async function main(argv = process.argv.slice(2)) {
  const run = options(argv);
  const files = segments(run.replay);
  const problem = refusal(files.map(header), run.serverJar, await sha256(run.serverJar));
  if (problem) throw new Refused(problem);
  mkdirSync(run.out, { recursive: true });
  const build = join(run.out, 'viewer-build');
  rmSync(build, { recursive: true, force: true });
  mkdirSync(join(build, 'classes'), { recursive: true });
  execFileSync('javac', ['--release', '17', '-cp', run.desktopJar, '-d', join(build, 'classes'), join(plugin, 'src', 'agentbridge', 'ReplayFormat.java'), ...readdirSync(join(here, 'viewer', 'src', 'agentbridge', 'replay')).map(name => join(here, 'viewer', 'src', 'agentbridge', 'replay', name))], { stdio: 'inherit' });
  run.viewerJar = join(build, 'agent-bridge-replay.jar');
  execFileSync('jar', ['cf', run.viewerJar, '-C', join(build, 'classes'), '.', '-C', join(here, 'viewer'), 'mod.json', '-C', join(here, '../..'), 'LICENSE', '-C', join(here, '../..'), 'NOTICE'], { stdio: 'inherit' });
  const used = new Set();
  const views = run.views.map(view => ({ ...view, width: run.width, height: run.height, display: `:${display(used)}` }));
  const interrupt = () => { for (const view of views) for (const proc of view.procs ?? []) if (alive(proc)) proc.child.kill('SIGKILL'); process.exit(130); };
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  let launching = Promise.resolve();
  const results = await Promise.all(views.map(view => {
    const previous = launching;
    let release;
    launching = new Promise(done => { release = done; });
    return render(view, run, previous, release);
  }));
  const summary = results.map(({ view, ok, video, refused, error, viewer }) => ({ view, ok, video, refused, error, worlds: viewer?.worlds, seat_seen: viewer?.seat_seen, start_rec_sec: viewer?.start_rec_sec, last_rec_sec: viewer?.last_rec_sec, cut_short: viewer?.cut_short }));
  console.log(JSON.stringify(summary, null, 2));
  const refusedView = results.find(result => result.refused);
  if (refusedView) throw new Refused(refusedView.refused);
  if (results.some(result => !result.ok)) throw new Error('Not every view rendered; see the JSON beside each video');
  return results;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error instanceof Refused ? `Refused: ${error.message}` : error.message);
    process.exitCode = error instanceof Refused ? 2 : 1;
  });
}
