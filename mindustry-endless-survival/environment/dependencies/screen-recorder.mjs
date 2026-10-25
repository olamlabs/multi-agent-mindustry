import { spawn } from 'node:child_process';
import { mkdirSync, openSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const RUN_DIR = process.env.OLAM_RUN_DIR ?? '/tmp/olam';
const FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';
const displayOf = (index) => `:${99 + index}`;

function watched(name, child) {
  const report = (error) => console.error(`${name}: ${error.message}`);
  child.on('error', report);
  child.stdin?.on('error', report);
  return child;
}

async function finished(child, timeoutMs) {
  if (await exited(child, timeoutMs)) return true;
  child.kill('SIGKILL');
  await exited(child, 5_000);
  return false;
}

export function gridShape(count) {
  const columns = count <= 2 ? count : Math.ceil(Math.sqrt(count));
  return { columns, rows: Math.ceil(count / columns) };
}

export function screenGrid(video, labels) {
  const input = (display) => ['-f', 'x11grab', '-draw_mouse', '0', '-framerate', String(video.fps), '-video_size', `${video.width}x${video.height}`, '-i', display];
  const label = (index) => {
    const file = join(RUN_DIR, `label-${index}.txt`);
    mkdirSync(RUN_DIR, { recursive: true });
    writeFileSync(file, labels[index]);
    return `drawtext=fontfile=${FONT}:textfile=${file}:expansion=none:x=12:y=12:fontsize=22:fontcolor=white:box=1:boxcolor=black@0.55:boxborderw=8`;
  };
  const { columns } = gridShape(labels.length);
  const labelled = labels.map((_, index) => `[${index}:v]${label(index)}[s${index}]`);
  const layout = labels.map((_, index) => `${(index % columns) * video.width}_${Math.floor(index / columns) * video.height}`).join('|');
  const cells = labels.map((_, index) => `[s${index}]`).join('');
  return {
    inputs: labels.flatMap((_, index) => input(displayOf(index))),
    filter: `${labelled.join(';')};${cells}${labels.length === 1 ? '' : `xstack=inputs=${labels.length}:layout=${layout}:fill=black,`}format=yuv420p[v]`,
  };
}

export function startRecording({ video, labels, out, seconds }) {
  const { inputs, filter } = screenGrid(video, labels);
  const rate = ['-crf', '28'];
  const encode = ['-c:v', 'libx264', '-preset', 'medium', '-tune', 'animation', '-x264-params', 'rc-lookahead=10', ...rate, '-g', String(video.fps * 10), '-r', String(video.fps)];
  const container = ['-flush_packets', '1', '-movflags', '+empty_moov+default_base_moof', '-frag_duration', '2000000'];
  const args = ['-y', '-loglevel', 'error', ...inputs, '-filter_complex', filter, '-map', '[v]', ...encode, '-t', String(seconds), ...container, out];
  const log = openSync(join(RUN_DIR, 'ffmpeg.txt'), 'a');
  const child = spawn('nice', ['-n', '10', 'ffmpeg', ...args], { env: { PATH: process.env.PATH }, stdio: ['pipe', log, log] });
  return { child: watched('ffmpeg', child), out };
}

function exited(child, timeoutMs) {
  if (child.exitCode != null || child.signalCode != null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const done = (ended) => () => {
      clearTimeout(timer);
      resolve(ended);
    };
    const timer = setTimeout(done(false), timeoutMs);
    child.once('exit', done(true));
    child.once('error', done(true));
  });
}

export async function stopRecording(recording, timeoutMs = 30_000) {
  const { child } = recording;
  if (child.exitCode == null && child.signalCode == null && child.stdin.writable) child.stdin.end('q');
  return (await finished(child, timeoutMs)) && child.exitCode === 0;
}

export async function grabStill({ video, labels, out }) {
  const { inputs, filter } = screenGrid(video, labels);
  const child = spawn('ffmpeg', ['-y', '-loglevel', 'error', ...inputs, '-filter_complex', filter, '-map', '[v]', '-frames:v', '1', out], { env: { PATH: process.env.PATH }, stdio: 'ignore' });
  return (await finished(watched('ffmpeg still', child), 15_000)) && child.exitCode === 0;
}
