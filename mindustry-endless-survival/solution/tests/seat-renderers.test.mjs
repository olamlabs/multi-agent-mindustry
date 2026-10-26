import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { bootRenderers, startVideo, stopVideo, stopRenderers } from '../../environment/sim/seat-renderers.mjs';

const seats = Array.from({ length: 8 }, (_, i) => `seat-${i + 1}`);

async function fixture(t, { record = true, signal, settings = {}, video = {}, seats = Array.from({ length: 8 }, (_, i) => `seat-${i + 1}`) } = {}) {
  const evidence = mkdtempSync(join(tmpdir(), 'mindustry-seat-renderers-'));
  let resolveListen;
  const listening = new Promise(resolve => { resolveListen = resolve; });
  const boot = bootRenderers({ evidence, seats, settings: { game_mode: 'survival', time_limit_sec: null, ...settings }, video: { record, ...video }, controlHost: '127.0.0.1', controlPort: 0, onListening: resolveListen, signal });

  boot.catch(() => {});
  const address = await listening;
  let handle;
  t.after(async () => { await stopRenderers(handle); rmSync(evidence, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${address.port}`;

  function request(seat, body) {
    return new Promise((resolve, reject) => {
      const req = httpRequest(`${url}/seats/${seat}`, { method: body ? 'POST' : 'GET', agent: false, headers: { 'Content-Type': 'application/json' } }, res => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', chunk => { text += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, json: async () => JSON.parse(text) }));
        res.on('error', reject);
      });
      req.on('error', reject);
      req.end(body ? JSON.stringify(body) : undefined);
    });
  }
  async function ready() {
    for (const seat of seats) assert.equal((await request(seat, { status: 'ready', metadata: { team: seat < 'seat-5' ? 'sharded' : 'crux' } })).status, 200);
    handle = await boot;
    return handle;
  }
  return { evidence, request, ready, boot, url };
}
function stopped(seat) { return { status: 'stopped', metadata: { complete: true, first_frame: true, frames: 45, files: [{ name: `${seat}-000.mp4`, bytes: 12345, frames: 45, duration_sec: 9 }] } }; }

test('eight native seats synchronize first frames and preserve distributed artifact metadata', async t => {
  const f = await fixture(t);
  const initial = await (await f.request('seat-1')).json();
  assert.equal(initial.phase, 'connect');
  assert.equal(initial.settings.game_mode, 'survival');
  const handle = await f.ready();
  let started = false;
  const starting = startVideo(handle).then(() => { started = true; });
  for (const seat of seats.slice(0, 7)) assert.equal((await f.request(seat, { status: 'recording', metadata: { first_frame: true } })).status, 200);
  assert.equal(started, false);
  assert.equal((await f.request('seat-8', { status: 'recording', metadata: { first_frame: true } })).status, 200);
  await starting;
  const stopping = stopVideo(handle, { elapsed_sec: 9 });
  assert.equal((await (await f.request('seat-1')).json()).elapsed_sec, 9);
  for (const seat of seats) assert.equal((await f.request(seat, stopped(seat))).status, 200);
  const result = await stopping;
  assert.equal(result.complete, true);
  assert.equal(result.native_clients, 8);
  assert.equal(result.per_seat['seat-8'].metadata.files[0].name, 'seat-8-000.mp4');
  assert.deepEqual(JSON.parse(readFileSync(join(f.evidence, 'video/metadata.json'))), result);
  assert.equal(await stopVideo(handle), result);
});

test('coordinator rejects foreign seats and premature or unverified acknowledgments, whatever their size', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('seat-9')).status, 404);
  assert.equal((await f.request('seat-1', { status: 'recording', metadata: { first_frame: true } })).status, 409);

  assert.equal((await f.request('seat-1', { status: 'recording', metadata: { first_frame: true, note: 'x'.repeat(70_000) } })).status, 409);
  const handle = await f.ready();
  const starting = startVideo(handle);
  assert.equal((await f.request('seat-1', { status: 'recording', metadata: { first_frame: false } })).status, 400);
  for (const seat of seats) await f.request(seat, { status: 'recording', metadata: { first_frame: true } });
  await starting;
  assert.equal((await f.request('seat-1', { status: 'ready' })).status, 409);
  const stopping = stopVideo(handle, { elapsed_seconds: 9 });
  const wrongSeat = stopped('seat-2');
  assert.equal((await f.request('seat-1', wrongSeat)).status, 400);
  const traversal = stopped('seat-1'); traversal.metadata.files[0].name = '../seat-1-000.mp4';
  assert.equal((await f.request('seat-1', traversal)).status, 400);
  const empty = stopped('seat-1'); empty.metadata.frames = 0;
  assert.equal((await f.request('seat-1', empty)).status, 400);
  for (const seat of seats) await f.request(seat, stopped(seat));
  assert.equal((await stopping).complete, true);
});

async function settledSoon(promise) {
  let settled = false;
  promise.then(() => { settled = true; }, () => { settled = true; });
  await new Promise(resolve => setTimeout(resolve, 400));
  return settled;
}

test('coordinator accepts verified segments beyond 999 while retaining seat and path checks', async t => {
  const f = await fixture(t, { seats: ['seat-1'] });
  const handle = await f.ready();
  const starting = startVideo(handle);
  await f.request('seat-1', { status: 'recording', metadata: { first_frame: true } });
  await starting;
  const stopping = stopVideo(handle, { elapsed_sec: 1800 });
  for (const name of ['seat-1-99.mp4', 'seat-2-1000.mp4', '../seat-1-1000.mp4']) {
    const bad = stopped('seat-1'); bad.metadata.files[0].name = name;
    assert.equal((await f.request('seat-1', bad)).status, 400, name);
  }
  const report = stopped('seat-1');
  report.metadata.files = [999, 1000, 10000].map(index => ({ name: `seat-1-${index}.mp4`, bytes: 12345, frames: 3000, duration_sec: 600 }));
  report.metadata.frames = 9000;
  assert.equal((await f.request('seat-1', report)).status, 200);
  const result = await stopping;
  assert.equal(result.complete, true);
  assert.deepEqual(result.per_seat['seat-1'].metadata.files, report.metadata.files);
});

test('a camera that fails at the stop leaves the result incomplete, and the stop still waits for the other cameras', async t => {
  const f = await fixture(t);
  const handle = await f.ready();
  const starting = startVideo(handle);
  for (const seat of seats) await f.request(seat, { status: 'recording', metadata: { first_frame: true } });
  await starting;
  const stopping = stopVideo(handle, { elapsed_sec: 12 });
  await f.request('seat-3', { status: 'failed', error: 'No decodable final frames' });
  assert.equal(await settledSoon(stopping), false, 'the other seats are still finalizing their recordings');
  for (const seat of seats.filter(seat => seat !== 'seat-3')) assert.equal((await f.request(seat, stopped(seat))).status, 200);
  const result = await stopping;
  assert.equal(result.complete, false);
  assert.match(result.error, /^seat-3 native recorder failed: No decodable final frames$/);
  assert.equal(result.per_seat['seat-3'].status, 'failed');
  for (const seat of seats.filter(seat => seat !== 'seat-3')) assert.equal(result.per_seat[seat].status, 'stopped', seat);
});

test('a camera that fails while the clients join does not hold the lobby', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('seat-2', { status: 'failed', error: 'seat-2 native client exited' })).status, 200);
  for (const seat of seats.filter(seat => seat !== 'seat-2')) assert.equal((await f.request(seat, { status: 'ready', metadata: {} })).status, 200);
  const handle = await f.boot;
  t.after(() => stopRenderers(handle));
  assert.equal(handle.reports.get('seat-2').status, 'failed');
});

test('a camera that fails during the game is settled: the clock starts and the stop waits only for the others', async t => {
  const f = await fixture(t);
  const handle = await f.ready();
  const starting = startVideo(handle);

  assert.equal((await f.request('seat-5', { status: 'failed', error: 'seat-5 control: transport failure' })).status, 200);
  for (const seat of seats.filter(seat => seat !== 'seat-5')) await f.request(seat, { status: 'recording', metadata: { first_frame: true } });
  await starting;
  const stopping = stopVideo(handle, { elapsed_sec: 9 });
  assert.equal((await (await f.request('seat-1')).json()).phase, 'stop', 'the healthy cameras get the stop phase');
  assert.equal(await settledSoon(stopping), false, 'the stop waits for the healthy cameras');
  for (const seat of seats.filter(seat => seat !== 'seat-5')) await f.request(seat, stopped(seat));
  const result = await stopping;
  assert.equal(result.complete, false);
  assert.equal(result.first_frame, false);
  assert.deepEqual(Object.keys(result.per_seat), seats);
  assert.deepEqual([result.per_seat['seat-5'].status, result.per_seat['seat-5'].error], ['failed', 'seat-5 control: transport failure']);
  for (const seat of seats.filter(seat => seat !== 'seat-5')) assert.equal(result.per_seat[seat].metadata.files[0].name, `${seat}-000.mp4`);
  assert.match(result.error, /^seat-5 native recorder failed: seat-5 control: transport failure$/);
});

test('disabled recording still synchronizes native game clients without claiming video', async t => {
  const f = await fixture(t, { record: false });
  const handle = await f.ready();
  const starting = startVideo(handle);
  for (const seat of seats) await f.request(seat, { status: 'recording', metadata: { record: false, first_frame: false } });
  await starting;
  const stopping = stopVideo(handle, { elapsed_sec: 9 });
  for (const seat of seats) await f.request(seat, { status: 'stopped', metadata: { record: false, complete: true, frames: 0, files: [] } });
  const result = await stopping;
  assert.equal(result.complete, true);
  assert.equal(result.record, false);
  assert.equal(result.first_frame, false);
});

test('missing clients fail nothing however long they take; the lobby abort ends the wait', async t => {
  const controller = new AbortController();
  const f = await fixture(t, { signal: controller.signal });
  let settled = false;
  f.boot.then(() => { settled = true; }, () => { settled = true; });

  const start = performance.now();
  let elapsed = 0;
  t.mock.method(performance, 'now', () => start + elapsed);
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  for (; elapsed < 700_000; elapsed += 100) {
    t.mock.timers.tick(100);
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(settled, false, 'nothing fails at 600 s');
  controller.abort(new Error('Not every seat joined within lobby_sec'));
  t.mock.timers.tick(100);
  await assert.rejects(f.boot, /lobby_sec/);
  t.mock.timers.reset();
  await assert.rejects(fetch(`${f.url}/seats/seat-1`));
});

test('abort during setup closes the listener', async t => {
  const controller = new AbortController();
  const f = await fixture(t, { signal: controller.signal });
  controller.abort(new Error('Preparation cancelled'));
  await assert.rejects(f.boot, /Preparation cancelled/);
  await assert.rejects(fetch(`${f.url}/seats/seat-1`));
});

test('endless survival passes the recording barrier without a deadline: seats record until the stop', async t => {
  for (const time_limit_sec of [null]) {
    const f = await fixture(t, { settings: { time_limit_sec } });
    const handle = await f.ready();
    const starting = startVideo(handle);
    await Promise.all([starting, ...seats.map(seat => f.request(seat, { status: 'recording', metadata: { first_frame: true } }))]);
    const state = await (await f.request('seat-1')).json();
    assert.equal(state.phase, 'record');
    assert.equal(state.settings.time_limit_sec, time_limit_sec);
    assert.ok(!('time_limit_sec' in state) && !('duration_budget_sec' in state.video), 'a seat gets no recording clock');
    const stopping = stopVideo(handle, { elapsed_seconds: 48.2, reason: time_limit_sec === null ? 'core_destroyed' : 'time_limit' });
    for (const seat of seats) await f.request(seat, stopped(seat));
    assert.equal((await stopping).complete, true);
  }
});

test('twenty seats complete the distributed recording barrier including seat-20', async t => {
  const seats = Array.from({length:20},(_,i)=>`seat-${i+1}`);
  const f = await fixture(t,{seats,settings:{team_sizes:[20]}});
  assert.equal((await f.request('seat-20')).status,200);
  assert.equal((await f.request('seat-51')).status,404);
  const handle = await f.ready();
  const starting = startVideo(handle);
  for(const seat of seats) assert.equal((await f.request(seat,{status:'recording',metadata:{first_frame:true}})).status,200);
  await starting;
  const stopping = stopVideo(handle,{elapsed_seconds:9});
  for(const seat of seats) assert.equal((await f.request(seat,stopped(seat))).status,200);
  const result = await stopping;
  assert.equal(result.complete,true);
  assert.equal(result.native_clients,20);
  assert.equal(Object.keys(result.per_seat).length,20);
});

test('only camera seats join, record and stop; the others learn they have no camera and cannot report', async t => {
  const f = await fixture(t, { video: { seats: ['seat-2', 'seat-7'] } });
  const told = await (await f.request('seat-1')).json();
  assert.equal(told.camera, false);
  assert.equal((await (await f.request('seat-2')).json()).camera, true);
  assert.equal((await f.request('seat-1', { status: 'ready' })).status, 409);
  for (const seat of ['seat-2', 'seat-7']) assert.equal((await f.request(seat, { status: 'ready' })).status, 200);
  const handle = await f.boot;
  t.after(() => stopRenderers(handle));
  const starting = startVideo(handle);
  for (const seat of ['seat-2', 'seat-7']) await f.request(seat, { status: 'recording', metadata: { first_frame: true } });
  await starting;
  const stopping = stopVideo(handle, { elapsed_sec: 9 });
  for (const seat of ['seat-2', 'seat-7']) await f.request(seat, stopped(seat));
  const result = await stopping;
  assert.equal(result.complete, true);
  assert.equal(result.native_clients, 2);
  assert.deepEqual(result.cameras, ['seat-2', 'seat-7']);
  assert.deepEqual(Object.keys(result.per_seat), ['seat-2', 'seat-7']);
});

test('with no cameras the coordinator is ready at once and its video is complete', async t => {
  const f = await fixture(t, { video: { seats: [] } });
  const handle = await f.boot;
  t.after(() => stopRenderers(handle));
  assert.equal((await (await f.request('seat-4')).json()).camera, false);
  await startVideo(handle);
  const result = await stopVideo(handle, { elapsed_sec: 9 });
  assert.equal(result.complete, true);
  assert.equal(result.native_clients, 0);
  assert.equal(result.first_frame, false);
});
