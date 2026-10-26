import { createServer } from 'node:http';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeVideo } from './renderer.mjs';
import { MAX_SEATS } from './settings.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function note(handle, event) {
  appendFileSync(join(handle.logDir, 'events.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n');
}
function save(handle) {
  writeFileSync(join(handle.logDir, 'status.json'), JSON.stringify({ phase: handle.phase, cameras: handle.cameras, seats: Object.fromEntries(handle.reports), video: handle.video, elapsed_sec: handle.elapsedSec }, null, 2) + '\n');
}

async function waitFor(handle, status) {
  while (true) {
    handle.signal?.throwIfAborted();
    if (handle.stopped) throw new Error('Seat renderer coordinator stopped');
    if (handle.cameras.every(seat => [status, 'failed'].includes(handle.reports.get(seat)?.status))) return;
    await sleep(100);
  }
}

function metadataValid(seat, metadata, record = true) {
  if (!record) return metadata.record === false && metadata.complete === true && metadata.frames === 0 && Array.isArray(metadata.files) && metadata.files.length === 0;
  return metadata.complete === true && metadata.first_frame === true && Number.isSafeInteger(metadata.frames) && metadata.frames > 0 &&
    Array.isArray(metadata.files) && metadata.files.length > 0 && metadata.files.every(file => object(file) &&
      new RegExp(`^${seat}-\\d{3,}\\.mp4$`).test(file.name) && Number.isSafeInteger(file.bytes) && file.bytes > 0) &&
    new Set(metadata.files.map(file => file.name)).size === metadata.files.length;
}
function respond(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}
async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('Invalid JSON report'), { status: 400 }); }
}
async function request(handle, req, res) {
  try {
    const match = /^\/seats\/(seat-(?:[1-9]|[1-9][0-9]|1[0-9][0-9]|200))$/.exec(req.url);
    const seat = match?.[1];
    if (!handle.seats.includes(seat)) return respond(res, 404, { error: 'Unknown seat endpoint' });
    if (handle.stopped) return respond(res, 410, { error: 'Coordinator closed' });
    if (req.method === 'GET') return respond(res, 200, { phase: handle.phase, seat, camera: handle.cameras.includes(seat), seats: handle.seats, settings: handle.settings, video: handle.video, elapsed_sec: handle.elapsedSec });
    if (req.method !== 'POST') return respond(res, 405, { error: 'Use GET or POST' });
    if (!handle.cameras.includes(seat)) return respond(res, 409, { error: `${seat} has no camera (video.seats)` });
    if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] ?? '')) return respond(res, 415, { error: 'Report must be JSON' });
    const body = await readBody(req);
    if (!object(body) || !['ready', 'recording', 'stopped', 'failed'].includes(body.status)) return respond(res, 400, { error: 'Invalid renderer status' });
    const metadata = body.metadata ?? Object.fromEntries(Object.entries(body).filter(([key]) => key !== 'status'));
    if (!object(metadata)) return respond(res, 400, { error: 'Invalid renderer metadata' });
    const previous = handle.reports.get(seat);
    const rank = { ready: 1, recording: 2, stopped: 3, failed: 4 };
    if (previous && rank[body.status] < rank[previous.status]) return respond(res, 409, { error: 'Renderer status cannot move backwards' });
    const allowed = { connect: 'ready', record: 'recording', stop: 'stopped' };
    if (body.status !== 'failed' && body.status !== allowed[handle.phase] && body.status !== previous?.status) return respond(res, 409, { error: `Unexpected status during ${handle.phase}` });
    if (body.status === 'recording' && (handle.video.record ? metadata.first_frame !== true : metadata.record !== false)) return respond(res, 400, { error: 'Recording requires a decoded first frame' });
    if (body.status === 'stopped' && !metadataValid(seat, metadata, handle.video.record)) return respond(res, 400, { error: 'Stopped requires verified nonempty seat recordings and decoded frames' });
    if (body.status === 'failed' && (typeof (body.error ?? metadata.error) !== 'string' || !(body.error ?? metadata.error).trim())) return respond(res, 400, { error: 'Failed requires an error message' });
    const report = { status: body.status, metadata, ...(body.status === 'failed' ? { error: (body.error ?? metadata.error).slice(0, 4000) } : {}), at: new Date().toISOString() };
    handle.reports.set(seat, report);
    note(handle, { seat, ...report });
    save(handle);
    return respond(res, 200, { accepted: true, phase: handle.phase });
  } catch (error) {
    if (!res.headersSent && !res.destroyed) respond(res, error.status ?? 500, { error: error.status ? error.message : 'Could not store renderer report' });
  }
}

export async function bootRenderers({ evidence, video: input, seats, settings = {}, signal, onProgress = () => {}, controlHost = '0.0.0.0', controlPort = 9001, onListening = () => {} }) {
  signal?.throwIfAborted();
  const names = seats.map(seat => typeof seat === 'string' ? seat : seat.id);
  const expected = Array.from({ length: names.length }, (_, i) => `seat-${i + 1}`);
  if ((names.length < 1 || names.length > MAX_SEATS) || new Set(names).size !== names.length || names.some(seat => !expected.includes(seat))) throw new Error(`Seat renderers require canonical roster of one through ${MAX_SEATS} seats`);
  const video = normalizeVideo(input);

  const cameras = Array.isArray(video.seats) ? video.seats : expected;
  const handle = { evidence, logDir: join(evidence, 'seat-renderers'), settings, video, seats: expected, cameras, signal, phase: 'connect', reports: new Map(), elapsedSec: null, stopped: false };
  mkdirSync(handle.logDir, { recursive: true });
  handle.abortListener = () => { void stopRenderers(handle); };
  try {
    handle.server = createServer({ requestTimeout: 0, headersTimeout: 0 }, (req, res) => { void request(handle, req, res); });
    await new Promise((resolve, reject) => {
      handle.server.once('error', reject);
      handle.server.listen(controlPort, controlHost, () => { handle.server.removeListener('error', reject); resolve(); });
    });
    signal?.throwIfAborted();
    signal?.addEventListener('abort', handle.abortListener, { once: true });
    save(handle);
    onListening(handle.server.address());
    onProgress(`Waiting for ${cameras.length} of ${names.length} seats' native game clients`);
    await waitFor(handle, 'ready');
    onProgress(`All ${cameras.length} camera seats' game clients connected and rendering`);
    return handle;
  } catch (error) {
    note(handle, { failure: error.message });
    await stopRenderers(handle);
    throw error;
  }
}

export async function startVideo(handle) {
  handle.signal?.throwIfAborted();
  if (handle.stopped) throw new Error('Seat renderer coordinator stopped');
  if (handle.phase !== 'connect') throw new Error('Seat recording already started');
  handle.phase = 'record';
  note(handle, { phase: handle.phase });
  save(handle);
  await waitFor(handle, 'recording');
  note(handle, { first_frame: handle.video.record, seats: handle.cameras });
}

export async function stopVideo(handle, terminal = {}) {
  if (handle.stopPromise) return handle.stopPromise;
  handle.stopPromise = (async () => {
    handle.phase = 'stop';
    const elapsed = terminal.elapsed_sec ?? terminal.elapsed_seconds ?? terminal.elapsed_game_sec;
    handle.elapsedSec = typeof elapsed === 'number' && Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : null;
    note(handle, { phase: 'stop', elapsed_sec: handle.elapsedSec });
    save(handle);
    let failure;
    try { await waitFor(handle, 'stopped'); }
    catch (error) { failure = error.message; note(handle, { failure }); }
    const perSeat = Object.fromEntries(handle.cameras.map(seat => [seat, handle.reports.get(seat) ?? { status: 'missing' }]));
    failure ??= handle.cameras.filter(seat => perSeat[seat].status === 'failed').map(seat => `${seat} native recorder failed: ${perSeat[seat].error}`).join('; ') || undefined;
    const complete = !failure && handle.cameras.every(seat => perSeat[seat].status === 'stopped' && metadataValid(seat, perSeat[seat].metadata, handle.video.record));
    const result = { type: 'video', layout: 'seat-containers', record: handle.video.record, cameras: handle.cameras, native_clients: handle.cameras.length, complete, first_frame: handle.cameras.length > 0 && handle.cameras.every(seat => perSeat[seat].metadata?.first_frame === true), fps: handle.video.fps, width: handle.video.width, height: handle.video.height, artifact_location: 'seat game containers:/recordings', per_seat: perSeat, ...(failure ? { error: failure } : {}) };
    mkdirSync(join(handle.evidence, 'video'), { recursive: true });
    writeFileSync(join(handle.evidence, 'video', 'metadata.json'), JSON.stringify(result, null, 2) + '\n');
    handle.videoResult = result;
    return result;
  })();
  return handle.stopPromise;
}

export async function stopRenderers(handle) {
  if (!handle) return;
  if (handle.closePromise) return handle.closePromise;
  handle.closePromise = (async () => {
    handle.stopped = true;
    handle.signal?.removeEventListener('abort', handle.abortListener);
    if (handle.server) {
      await new Promise(resolve => { handle.server.close(resolve); handle.server.closeAllConnections(); });
    }
  })();
  return handle.closePromise;
}
