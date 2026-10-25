import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, copyFileSync, existsSync, openSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startRecording, stopRecording, grabStill, gridShape } from '../dependencies/screen-recorder.mjs';

const taskDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function launch(handle, name, executable, args, extraEnv = {}) {
  handle.signal?.throwIfAborted();
  if (handle.stopped) throw new Error('Native renderer has stopped');
  const logPath = join(handle.logDir, `${name}.log`);
  const log = openSync(logPath, 'a');
  const child = spawn(executable, args, {
    env: { ...process.env, ...extraEnv }, stdio: ['ignore', log, log],
  });
  const proc = { name, child, logPath, error: null };
  child.on('error', error => { proc.error = error; });
  handle.processes.push(proc);
  return proc;
}

async function finish(proc, signal) {
  while (proc.child.exitCode === null && proc.child.signalCode === null && !proc.error) {
    if (signal?.aborted) proc.child.kill('SIGKILL');
    signal?.throwIfAborted();
    await sleep(100);
  }
  if (proc.error || proc.child.exitCode !== 0) throw new Error(`${proc.name} failed: ${proc.error?.message ?? proc.child.exitCode ?? proc.child.signalCode}; see ${proc.logPath}`);
}

function displayProbe(display, env, signal) {
  return new Promise(resolve => {
    let stdout = '', stderr = '', settled = false;
    const child = spawn('xdotool', ['getdisplaygeometry'], { env: { ...env, DISPLAY: display }, stdio: ['ignore', 'pipe', 'pipe'] });
    const finish = result => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      resolve({ ...result, stdout: stdout.trim(), stderr: stderr.trim() });
    };
    const abort = () => { child.kill('SIGKILL'); finish({ error: 'aborted' }); };
    child.stdout.on('data', data => { stdout = (stdout + data).slice(-1000); });
    child.stderr.on('data', data => { stderr = (stderr + data).slice(-1000); });
    child.once('error', error => finish({ error: error.message }));
    child.once('close', code => finish({ code }));
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}

export async function waitForDisplay({ display, width, height, xvfb, signal, logPath, env = process.env }) {
  const started = performance.now();
  while (true) {
    signal?.throwIfAborted();
    if (xvfb.error || xvfb.child.exitCode !== null || xvfb.child.signalCode !== null) throw new Error(`${display} Xvfb exited before display readiness; see ${xvfb.logPath}`);
    const last = await displayProbe(display, env, signal);
    appendFileSync(logPath, JSON.stringify({ elapsed_ms: Math.round(performance.now() - started), display, ...last }) + '\n');
    signal?.throwIfAborted();
    if (last.code === 0 && last.stdout === `${width} ${height}`) return;
    await sleep(100);
  }
}

export function normalizeVideo(input = {}) {
  const video = { record: true, fps: 5, width: 960, height: 540, ...input };
  if (typeof video.record !== 'boolean') throw new Error('video.record must be boolean');
  for (const [key, min, max] of [['fps', 1, 30], ['width', 320, 1920], ['height', 240, 1080]]) {
    if (!Number.isInteger(video[key]) || video[key] < min || video[key] > max) throw new Error(`video.${key} must be an integer from ${min} to ${max}`);
  }
  if (video.width % 2 || video.height % 2) throw new Error('Video dimensions must be even for H264 yuv420p');
  return video;
}

export async function bootRenderers({ evidence, video: input, seats, signal, seatScoped = false, onProgress = () => {} }) {
  signal?.throwIfAborted();
  const video = normalizeVideo(input);
  const seatNames = seats.map(seat => typeof seat === 'string' ? seat : seat.id);
  const expectedSeats = new Set(Array.from({ length: seatNames.length }, (_, i) => `seat-${i + 1}`));
  if (seatScoped ? seatNames.length !== 1 || !/^seat-([1-9]|1[0-9]|20)$/.test(seatNames[0]) : (seatNames.length < 1 || seatNames.length > 20) || new Set(seatNames).size !== seatNames.length || seatNames.some(s => !expectedSeats.has(s))) throw new Error(seatScoped ? 'Native renderer requires a single canonical seat in seatScoped mode' : 'Native renderer requires seats seat-1 through seat-N, with 1..20 seats');
  const runDir = process.env.MINDUSTRY_RENDER_DIR ?? join('/tmp', `mindustry-view-${process.pid}`);
  const handle = { video, evidence, runDir, signal, logDir: join(evidence, 'renderers'), processes: [], labels: seatNames.map(s => `${s} native view`), recording: null, stopped: false };
  if (!video.record) return handle;
  mkdirSync(handle.logDir, { recursive: true });
  mkdirSync(runDir, { recursive: true });
  const displayEnvKeys = ['DISPLAY', 'SDL_VIDEODRIVER', 'SDL_AUDIODRIVER', 'LIBGL_ALWAYS_SOFTWARE', 'LD_LIBRARY_PATH', 'XAUTHORITY', 'XDG_RUNTIME_DIR'];
  writeFileSync(join(handle.logDir, 'display-runtime.json'), JSON.stringify({ platform: process.platform, arch: process.arch, uid: process.getuid?.(), inherited_display_environment: Object.fromEntries(displayEnvKeys.filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]])), native_display_environment: { SDL_VIDEODRIVER: 'x11', SDL_AUDIODRIVER: 'dummy', LIBGL_ALWAYS_SOFTWARE: '1', LP_NUM_THREADS: '1' }, viewer_fps: video.fps, viewer_nice: 10, viewer_jvm_processors: 2 }, null, 2));
  const jar = process.env.MINDUSTRY_DESKTOP_JAR ?? '/opt/mindustry/Mindustry.jar';
  if (!existsSync(jar)) throw new Error(`Missing native Mindustry desktop jar: ${jar}`);
  const classes = join(runDir, 'classes');
  mkdirSync(classes, { recursive: true });
  handle.abortListener = () => { void stopRenderers(handle); };
  signal?.addEventListener('abort', handle.abortListener, { once: true });
  try {
    onProgress('Compiling native spectator camera plugin');
    await finish(launch(handle, 'viewer-compile', 'javac', ['--release', '17', '-cp', jar, '-d', classes, join(taskDir, 'renderer/src/harbor/mindustry/SeatViewer.java')]), signal);
    const licenseDir = existsSync(join(taskDir, '../LICENSE')) ? join(taskDir, '..') : '/opt/licenses';
    for (const name of ['LICENSE', 'NOTICE.md']) copyFileSync(join(licenseDir, name), join(classes, name));
    const mod = join(runDir, 'seat-viewer.jar');
    await finish(launch(handle, 'viewer-package', 'jar', ['cf', mod, '-C', classes, '.', '-C', join(taskDir, 'renderer'), 'mod.json']), signal);
    for (let index = 0; index < seatNames.length; index++) {
      signal?.throwIfAborted();
      const seat = seatNames[index], display = `:${99 + index}`;
      const dataDir = join(runDir, seat), ready = join(dataDir, 'ready.json');
      mkdirSync(join(dataDir, 'mods'), { recursive: true });
      copyFileSync(mod, join(dataDir, 'mods', 'seat-viewer.jar'));
      const xvfb = launch(handle, `${seat}-xvfb`, 'Xvfb', [display, '-screen', '0', `${video.width}x${video.height}x24`, '-nolisten', 'tcp']);
      await waitForDisplay({ display, width: video.width, height: video.height, xvfb, signal, logPath: join(handle.logDir, `${seat}-display-probe.jsonl`) });
      onProgress(`Starting native Mindustry renderer ${seat}`);

      const game = launch(handle, `${seat}-client`, 'nice', ['-n', '10', 'java', '-XX:ActiveProcessorCount=2', '-Xms128m', '-Xmx640m', '-Dnodiscord=true', '-Djava.awt.headless=false', `-Dmindustry.data.dir=${dataDir}`, '-jar', jar, '-width', String(video.width), '-height', String(video.height), '-maximized', 'false'], {
        DISPLAY: display, SDL_VIDEODRIVER: 'x11', SDL_AUDIODRIVER: 'dummy', LIBGL_ALWAYS_SOFTWARE: '1', LP_NUM_THREADS: '1',
        HARBOR_VIEW_SEAT: seat, HARBOR_VIEW_READY: ready, HARBOR_VIEW_HEALTH: join(handle.logDir, `${seat}-connection.json`), HARBOR_VIEW_FPS: String(video.fps),
      });
      while (!existsSync(ready)) {
        signal?.throwIfAborted();
        if (game.error || game.child.exitCode !== null || game.child.signalCode !== null) throw new Error(`${seat} native client exited; see ${game.logPath}`);
        await sleep(250);
      }
      await finish(launch(handle, `${seat}-position`, 'xdotool', ['search', '--sync', '--name', '^Mindustry$', 'windowmove', '0', '0'], { DISPLAY: display }), signal);
      copyFileSync(ready, join(handle.logDir, `${seat}-ready.json`));
    }
    onProgress(`All ${seatNames.length} native game views connected and rendering`);
    return handle;
  } catch (error) {
    await stopRenderers(handle);
    throw error;
  }
}

export function startVideo(handle, timeLimitSec) {
  handle.signal?.throwIfAborted();
  if (handle.stopped) throw new Error('Native renderer has stopped');
  if (!handle.video.record) return;
  if (handle.recording) throw new Error('Video already started');
  mkdirSync(join(handle.evidence, 'video'), { recursive: true });
  handle.recording = startRecording({ video: handle.video, labels: handle.labels, out: join(handle.evidence, 'video/game.mp4'), seconds: timeLimitSec + 30 });
  return waitForRecording(handle);
}

function probeRecording(path, signal) {
  return new Promise(resolve => {
    let stdout = '', settled = false;
    const child = spawn('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-read_intervals', '%+#1', '-show_entries', 'frame=best_effort_timestamp_time', '-of', 'json', path], { stdio: ['ignore', 'pipe', 'ignore'] });
    const done = ready => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      resolve(ready);
    };
    const abort = () => { child.kill('SIGKILL'); done(false); };
    child.stdout.on('data', data => { stdout = (stdout + data).slice(-4000); });
    child.once('error', () => done(false));
    child.once('close', code => {
      try { done(code === 0 && JSON.parse(stdout).frames?.length > 0); }
      catch { done(false); }
    });
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}

async function waitForRecording(handle) {
  const started = performance.now();

  while (true) {
    handle.signal?.throwIfAborted();
    if (handle.stopped) throw new Error('Native renderer stopped before recording readiness');
    const child = handle.recording.child;
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Native recorder exited before its first frame (${child.exitCode ?? child.signalCode})`);
    const bytes = existsSync(handle.recording.out) ? statSync(handle.recording.out).size : 0;
    if (bytes > 1024) {
      const ready = await probeRecording(handle.recording.out, handle.signal);
      appendFileSync(join(handle.logDir, 'recording-readiness.log'), JSON.stringify({ elapsed_ms: Math.round(performance.now() - started), bytes, ready }) + '\n');
      handle.signal?.throwIfAborted();
      if (ready && !handle.stopped) return;
    }
    await sleep(250);
  }
}

export async function stopVideo(handle) {
  if (handle.videoResult) return handle.videoResult;
  if (!handle.recording) return { record: false };
  const out = join(handle.evidence, 'video');
  let still = false;

  const pausedViews = [];
  for (const proc of handle.processes) {
    if (proc.name.endsWith('-client') && proc.child.exitCode === null && proc.child.signalCode === null && proc.child.kill('SIGSTOP')) pausedViews.push(proc);
  }

  const stillVideo = { ...handle.video, fps: 30 };
  try {
    try { still = await grabStill({ video: stillVideo, labels: handle.labels, out: join(out, 'ending.png') }); }
    finally { handle.videoComplete = await stopRecording(handle.recording); }
  } finally {
    for (const proc of pausedViews) proc.child.kill('SIGCONT');
  }
  const { columns, rows } = gridShape(handle.labels.length);
  const files = ['game.mp4', 'ending.png'].filter(name => existsSync(join(out, name))).map(name => ({ name: `video/${name}`, bytes: statSync(join(out, name)).size }));
  const result = { type: 'video', record: true, native_clients: handle.labels.length, complete: handle.videoComplete, recorder_exit_code: handle.recording.child.exitCode, recorder_signal: handle.recording.child.signalCode, still, fps: handle.video.fps, width: columns * handle.video.width, height: rows * handle.video.height, files };
  handle.videoResult = result;
  writeFileSync(join(out, 'metadata.json'), JSON.stringify(result, null, 2));
  const ffmpegLog = join(process.env.OLAM_RUN_DIR ?? '/tmp/olam', 'ffmpeg.txt');
  if (existsSync(ffmpegLog)) copyFileSync(ffmpegLog, join(handle.logDir, 'ffmpeg.log'));
  return result;
}

export async function stopRenderers(handle) {
  if (!handle) return;
  if (handle.closePromise) return handle.closePromise;
  handle.closePromise = (async () => {
    handle.stopped = true;
    handle.signal?.removeEventListener('abort', handle.abortListener);
    if (handle.recording && !handle.videoResult) await stopRecording(handle.recording, 5_000).catch(() => {});
    for (const proc of [...handle.processes].reverse()) {
      if (proc.child.exitCode === null && proc.child.signalCode === null) proc.child.kill('SIGTERM');
    }
    await sleep(250);
    for (const proc of handle.processes) {
      if (proc.child.exitCode === null && proc.child.signalCode === null) proc.child.kill('SIGKILL');
    }
  })();
  return handle.closePromise;
}
