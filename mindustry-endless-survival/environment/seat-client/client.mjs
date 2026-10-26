import { spawn } from 'node:child_process';
import { appendFileSync, chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { bootRenderers, normalizeVideo, stopRenderers } from '../sim/renderer.mjs';
import { ViewerHealth } from './view-health.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function recordingSettings(state) {
  const seats = state.seats?.map(seat => typeof seat === 'string' ? seat : seat.id);
  if ((!seats || seats.length < 1 || seats.length > 20) || new Set(seats).size !== seats.length || seats.some(seat => !Array.from({length: seats.length}, (_, i) => `seat-${i + 1}`).includes(seat))) throw new Error('Recording requires the canonical roster of one through 20 seats');
  const input = state.video ?? state.settings?.video ?? {};
  if (input.kbps !== undefined) throw new Error('video.kbps is not used: recordings encode at constant quality');
  const video = normalizeVideo(input);
  const segmentSec = input.segment_sec ?? 600;
  if (!Number.isFinite(segmentSec) || segmentSec < 2) throw new Error('video.segment_sec must be at least two seconds');
  return { ...video, segment_sec: Math.floor(segmentSec) };
}

function launch(name, executable, args, logDir, extra = {}) {
  const logPath = join(logDir, `${name}.log`), fd = openSync(logPath, 'a');
  const child = spawn(executable, args, { env: { ...process.env, ...extra.env }, stdio: ['pipe', fd, fd] });
  closeSync(fd);
  const proc = { name, child, logPath, error: null };
  child.on('error', error => { proc.error = error; });
  child.stdin?.on('error', error => { proc.error = error; });
  return proc;
}

function alive(proc) {
  return !proc.error && proc.child.exitCode === null && proc.child.signalCode === null;
}

function requireAlive(proc) {
  if (!alive(proc)) throw new Error(`${proc.name} exited (${proc.error?.message ?? proc.child.exitCode ?? proc.child.signalCode}); see ${proc.logPath}`);
}

export async function finish(proc) {
  while (alive(proc)) await sleep(100);
  if (proc.error || proc.child.exitCode !== 0) throw new Error(`${proc.name} failed (${proc.error?.message ?? proc.child.exitCode ?? proc.child.signalCode}); see ${proc.logPath}`);
}

export function capture(executable, args) {
  return new Promise((resolve, reject) => {
    let output = '', error = '', settled = false;
    const child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const done = (err, value) => {
      if (settled) return;
      settled = true;
      err ? reject(err) : resolve(value);
    };
    child.stdout.on('data', data => { output = (output + data).slice(-100_000); });
    child.stderr.on('data', data => { error = (error + data).slice(-2000); });
    child.once('error', err => done(err));
    child.once('close', code => done(code === 0 ? null : new Error(`${executable} exited ${code}: ${error}`), output));
  });
}

export async function firstFrame(path, probe = capture) {
  try {
    const result = JSON.parse(await probe('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-read_intervals', '%+#1', '-show_entries', 'frame=best_effort_timestamp_time', '-of', 'json', path]));
    return result.frames?.length > 0;
  } catch { return false; }
}

export function recordingArgs(video, seat, recordings) {
  return ['-y', '-loglevel', 'warning', '-f', 'x11grab', '-draw_mouse', '0', '-framerate', String(video.fps), '-video_size', `${video.width}x${video.height}`, '-i', ':99',
    '-c:v', 'libx264', '-threads', '1', '-preset', 'veryfast', '-tune', 'animation', '-crf', '28',
    '-g', String(video.fps * 2), '-pix_fmt', 'yuv420p', '-r', String(video.fps), '-f', 'segment', '-segment_time', String(video.segment_sec), '-reset_timestamps', '1',
    '-segment_format', 'mp4', '-segment_format_options', 'movflags=+frag_keyframe+empty_moov+default_base_moof', join(recordings, `${seat}-%03d.mp4`)];
}

function segments(recordings, seat) {
  return readdirSync(recordings).filter(name => new RegExp(`^${seat}-\\d{3,}\\.mp4$`).test(name)).sort((a, b) => {
    const difference = BigInt(a.slice(seat.length + 1, -4)) - BigInt(b.slice(seat.length + 1, -4));
    return difference < 0n ? -1 : difference > 0n ? 1 : 0;
  }).map(name => ({ name, bytes: statSync(join(recordings, name)).size }));
}

export async function waitForFirstFrame(proc, recordings, seat, logDir, probe = capture) {
  const path = join(recordings, `${seat}-000.mp4`);
  while (true) {
    requireAlive(proc);
    const bytes = existsSync(path) ? statSync(path).size : 0;
    if (bytes > 1024) {
      const ready = await firstFrame(path, probe);
      appendFileSync(join(logDir, 'recording-readiness.jsonl'), JSON.stringify({ bytes, ready, timestamp: new Date().toISOString() }) + '\n');
      if (ready) return;
    }
    await sleep(250);
  }
}

export class SegmentVerifier {
  constructor(video, seat, recordings, logDir, probe = async path => JSON.parse(await capture('ffprobe', ['-v', 'error', '-threads', '1', '-select_streams', 'v:0', '-count_frames', '-show_entries', 'stream=nb_read_frames,width,height:format=duration', '-of', 'json', path]))) {
    Object.assign(this, { video, seat, recordings, logDir, probe });
    this.verified = new Map();
  }

  async verify({ final = false } = {}) {
    const files = segments(this.recordings, this.seat);

    const closed = final ? files : files.slice(0, -1);
    for (const file of closed) {
      const path = join(this.recordings, file.name);
      const identity = () => {
        const stat = statSync(path, { bigint: true });
        return `${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
      };
      const before = identity(), previous = this.verified.get(file.name);
      if (previous?.identity === before) {
        Object.assign(file, previous.metadata);
        continue;
      }
      const started = performance.now();
      try {
        const probe = await this.probe(path);
        const stream = probe.streams?.[0];
        file.frames = Number(stream?.nb_read_frames ?? 0);
        file.duration_sec = Number(probe.format?.duration ?? 0);
        if (!Number.isSafeInteger(file.frames) || file.frames <= 0 || !Number.isFinite(file.duration_sec) || file.duration_sec <= 0 || stream.width !== this.video.width || stream.height !== this.video.height) throw new Error('Invalid encoded video segment');
        if (identity() !== before) throw new Error('Closed video segment changed during validation');
        this.verified.set(file.name, { identity: before, metadata: { frames: file.frames, duration_sec: file.duration_sec } });
        appendFileSync(join(this.logDir, 'recording-validation.jsonl'), JSON.stringify({ file: file.name, bytes: file.bytes, frames: file.frames, duration_sec: file.duration_sec, final, validation_ms: performance.now() - started }) + '\n');
      } catch (error) {
        throw new Error(`${this.seat} segment ${file.name}: ${error.message}`, { cause: error });
      }
    }
    if (final && [...this.verified.keys()].some(name => !files.some(file => file.name === name))) throw new Error(`${this.seat}: previously verified video segment is missing`);
    return closed;
  }
}

async function stopAndVerify(proc, video, seat, recordings, logDir, state, verifier) {
  if (alive(proc) && proc.child.stdin.writable) proc.child.stdin.end('q\n');
  await finish(proc);
  const files = await verifier.verify({ final: true });
  if (!files.length) throw new Error('Recorder produced no MP4 segments');
  const duration = files.reduce((sum, file) => sum + file.duration_sec, 0);
  const elapsed = state.elapsed_sec ?? state.elapsed_game_sec ?? state.elapsed_seconds;
  if (Number.isFinite(elapsed) && duration + Math.max(1, 2 / video.fps) < elapsed) throw new Error(`Video covers only ${duration.toFixed(2)} seconds of ${elapsed.toFixed(2)} game seconds`);
  let still = false;
  try {
    await capture('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'x11grab', '-draw_mouse', '0', '-framerate', '30', '-video_size', `${video.width}x${video.height}`, '-i', ':99', '-frames:v', '1', '-threads', '1', join(recordings, 'ending.png')]);
    still = existsSync(join(recordings, 'ending.png'));
  } catch (error) { appendFileSync(join(logDir, 'ending-still.log'), `${error.message}\n`); }
  return { type: 'video', seat, record: true, complete: true, first_frame: true, frames: files.reduce((sum, file) => sum + file.frames, 0), duration_sec: duration, fps: video.fps, width: video.width, height: video.height, recorder_exit_code: proc.child.exitCode, still, files };
}

export function controlFetch(url, { method, headers, body }) {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const req = (target.protocol === 'https:' ? httpsRequest : httpRequest)(target, { method, headers, agent: false }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, json: async () => JSON.parse(text) });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

export function seatControl({ seat, url, headers, secret, logDir, fetchImpl = controlFetch }) {
  const failure = (detail) => new Error(`${seat} control: ${detail}`);
  const request = async body => {
    let result;
    try {
      result = await fetchImpl(url, { method: body ? 'POST' : 'GET', headers: { ...headers, 'X-Mindustry-Key': secret, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    } catch (error) {

      throw failure((error?.cause?.code ?? error?.code) === 'ECONNREFUSED' ? 'connection refused' : 'transport failure');
    }

    if (!result.ok) throw failure(`HTTP ${result.status}`);
    try { return await result.json(); }
    catch { throw failure(`HTTP ${result.status}: invalid JSON response`); }
  };
  const report = async (status, metadata = {}) => {
    writeFileSync(join(logDir, 'status.json'), JSON.stringify({ seat, status, metadata }, null, 2));
    return request({ status, metadata });
  };
  return { request, report };
}

export async function main() {
  const seat = process.env.MINDUSTRY_SEAT;
  if (!/^seat-([1-9]|1[0-9]|20)$/.test(seat ?? '')) throw new Error('MINDUSTRY_SEAT must be seat-1 through seat-20');
  const urls = JSON.parse(process.env.MINDUSTRY_SIM_URLS ?? '{}');
  const headers = JSON.parse(process.env.MINDUSTRY_SIM_HEADERS ?? '{}');
  if (!urls['9000'] || !urls['9001']) throw new Error('MINDUSTRY_SIM_URLS needs the tunnel and control ports, 9000 and 9001');
  const secret = readFileSync(process.env.MINDUSTRY_TUNNEL_SECRET ?? '/run/mindustry-control/tunnel-secret', 'utf8').trim();
  if (!secret) throw new Error('Missing private game tunnel key');
  const logDir = process.env.MINDUSTRY_SEAT_RUN_DIR ?? '/tmp/mindustry-seat';
  const recordings = process.env.MINDUSTRY_RECORDINGS_DIR ?? '/recordings';
  mkdirSync(logDir, { recursive: true });
  mkdirSync(recordings, { recursive: true });
  const controller = new AbortController();
  let native = null, tunnel = null, recording = null, lastState = null, stopping = false, idle = null;
  const url = `${urls['9001'].replace(/\/$/, '')}/seats/${seat}`;
  const { request, report } = seatControl({ seat, url, headers, secret, logDir });

  const cleanup = async () => {
    controller.abort();
    if (recording && alive(recording)) {
      if (recording.child.stdin.writable) recording.child.stdin.end('q\n');
      while (alive(recording)) await sleep(100);
    }
    await stopRenderers(native);
    if (tunnel && alive(tunnel)) tunnel.child.kill('SIGTERM');
  };
  const interrupted = async signal => {

    if (idle) return idle();
    if (stopping) return;
    stopping = true;

    await report('failed', { error: `Sidecar interrupted by ${signal}` }).catch(failure => console.error(`${seat} could not report its failure: ${failure.message}`));
    await cleanup();
    process.exitCode = 1;
  };
  process.once('SIGTERM', () => { void interrupted('SIGTERM'); });
  process.once('SIGINT', () => { void interrupted('SIGINT'); });
  try {
    lastState = await request();
    if (lastState.camera === false) {

      writeFileSync(join(logDir, 'status.json'), JSON.stringify({ seat, status: 'no_camera', metadata: {} }, null, 2));
      writeFileSync(join(recordings, 'metadata.json'), JSON.stringify({ type: 'video', seat, camera: false, record: false, complete: true, frames: 0, files: [] }, null, 2));
      const keepAlive = setInterval(() => {}, 2 ** 30);
      await new Promise(resolve => { idle = resolve; });
      clearInterval(keepAlive);
      return;
    }
    if (lastState.phase === 'stop') throw new Error('The match stopped before this client connected');
    const video = recordingSettings(lastState);
    const verifier = new SegmentVerifier(video, seat, recordings, logDir);
    const viewer = new ViewerHealth(seat);
    const checkViewer = () => viewer.update(JSON.parse(readFileSync(join(native.logDir, `${seat}-connection.json`), 'utf8')));
    if (!lastState.seats.some(value => (typeof value === 'string' ? value : value.id) === seat)) throw new Error('Seat is absent from the roster');
    {
      const headerFile = join(logDir, 'sim-headers.txt');
      if (Object.entries(headers).some(([key, value]) => /[\r\n]/.test(key + value))) throw new Error('Invalid tunnel headers');
      writeFileSync(headerFile, Object.entries(headers).map(([key, value]) => `${key}: ${value}\n`).join(''), { mode: 0o600 });
      chmodSync(headerFile, 0o600);
      tunnel = launch('tunnel', 'wstunnel', ['client', '-L', 'tcp://127.0.0.1:6567:127.0.0.1:6567', '-L', 'udp://127.0.0.1:6567:127.0.0.1:6567?timeout_sec=0', '--http-headers-file', headerFile, urls['9000'].replace(/^http/, 'ws')], logDir, { env: { WSTUNNEL_HTTP_UPGRADE_PATH_PREFIX: secret } });
      await sleep(500);
      requireAlive(tunnel);
      native = await bootRenderers({ evidence: logDir, video: { ...video, record: true }, seats: [seat], seatScoped: true, signal: controller.signal, onProgress: message => console.log(message) });
      const ready = JSON.parse(readFileSync(join(native.logDir, `${seat}-ready.json`), 'utf8'));
      if (ready.seat !== seat || ready.native_client !== true) throw new Error('Native camera readiness did not match the assigned seat');
      await report('ready', { record: video.record, camera: ready });
    }
    let recordAcknowledged = false;
    while (!stopping) {
      if (tunnel) requireAlive(tunnel);
      for (const proc of native?.processes ?? []) if (proc.name.endsWith('-client') || proc.name.endsWith('-xvfb')) requireAlive(proc);

      lastState = await request();
      checkViewer();
      if (lastState.phase === 'stop') {
        viewer.requireConnected();
        stopping = true;
        if (video.record && !recording) throw new Error('The match stopped before recording began');
        const metadata = video.record ? await stopAndVerify(recording, video, seat, recordings, logDir, lastState, verifier) : { record: false, complete: true, first_frame: false, frames: 0, files: [] };
        metadata.viewer_connection = checkViewer();
        viewer.requireConnected();
        writeFileSync(join(recordings, 'metadata.json'), JSON.stringify(metadata, null, 2));
        await report('stopped', metadata);
        await cleanup();
        return;
      }
      if (lastState.phase === 'record' && !recordAcknowledged) {
        if (video.record && !recording) {
          recording = launch('ffmpeg', 'nice', ['-n', '10', 'ffmpeg', ...recordingArgs(video, seat, recordings)], logDir);
          await waitForFirstFrame(recording, recordings, seat, logDir);
        }
        if (checkViewer().connected) {
          await report('recording', { record: video.record, first_frame: video.record, fps: video.fps, width: video.width, height: video.height });
          recordAcknowledged = true;
        }
      }
      if (recording) { requireAlive(recording); await verifier.verify(); }
      await sleep(500);
    }
  } catch (error) {
    stopping = true;
    writeFileSync(join(logDir, 'failure.txt'), `${error.stack ?? error}\n`);
    await report('failed', { error: error.message }).catch(failure => console.error(`${seat} could not report its failure: ${failure.message}`));
    await cleanup();
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(error); process.exitCode = 1; });
