import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootRenderers, startVideo, stopVideo, stopRenderers, normalizeVideo, waitForDisplay } from '../../environment/sim/renderer.mjs';
import { gridShape } from '../../environment/dependencies/screen-recorder.mjs';

test('screen grids cover single seats, pairs and incomplete rows', () => {
  assert.deepEqual(gridShape(1), {columns:1, rows:1});
  assert.deepEqual(gridShape(2), {columns:2, rows:1});
  assert.deepEqual(gridShape(5), {columns:3, rows:2});
  assert.deepEqual(gridShape(20), {columns:5, rows:4});
});

test('video disabled is a complete no-display lifecycle usable on headless hosts', async () => {
  const handle = await bootRenderers({ evidence: '/nonexistent/do-not-create', video: { record: false }, seats: ['seat-1', 'seat-2', 'seat-3', 'seat-4'] });
  assert.equal(handle.processes.length, 0);
  startVideo(handle, 30);
  assert.deepEqual(await stopVideo(handle), { record: false });
  await stopRenderers(handle);
  await stopRenderers(handle);
  assert.throws(() => startVideo(handle, 30), /stopped/);
});

test('aborted startup performs no native process or evidence work', async () => {
  const abort = new AbortController();
  abort.abort(new Error('Simulation shutdown'));
  await assert.rejects(() => bootRenderers({ evidence: '/nonexistent/do-not-create', signal: abort.signal, seats: ['seat-1','seat-2','seat-3','seat-4'] }), /Simulation shutdown/);
});

test('eight native views use the unchanged recorder grid and complete a headless lifecycle', async () => {
  const seats = Array.from({ length: 8 }, (_, i) => ({ id: `seat-${i + 1}` }));
  const handle = await bootRenderers({ evidence: '/nonexistent/do-not-create', video: { record: false }, seats });
  assert.equal(handle.processes.length, 0);
  assert.deepEqual(handle.labels, seats.map(seat => `${seat.id} native view`));
  assert.deepEqual(gridShape(handle.labels.length), { columns: 3, rows: 3 });
  startVideo(handle, 30);
  assert.deepEqual(await stopVideo(handle), { record: false });
  await stopRenderers(handle);
});

test('reject invalid native video sizes and noncanonical seat rosters before spawning', async () => {
  assert.throws(() => normalizeVideo({ width: 961 }), /even/);
  assert.throws(() => normalizeVideo({ fps: 0 }), /fps/);
  assert.throws(() => normalizeVideo({ record: 'false' }), /boolean/);
  await assert.rejects(() => bootRenderers({ evidence: '/nonexistent', video: { record: false }, seats: [] }), /requires seats/);
  for (const seats of [
    ['seat-1', 'seat-2', 'seat-3', 'seat-5'],
    Array.from({ length: 8 }, (_, i) => `seat-${i + 2}`),
    Array.from({ length: 8 }, () => 'seat-1'),
  ]) {
    await assert.rejects(() => bootRenderers({ evidence: '/nonexistent', video: { record: false }, seats }), /requires seats/);
  }
});

function displayFixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'mindustry-x11-probe-'));
  t.after(() => rmSync(dir, { recursive: true }));
  const marker = join(dir, 'display-ready');
  writeFileSync(join(dir, 'xdotool'), '#!/bin/sh\nif [ ! -f "$DISPLAY_READY_MARKER" ]; then echo "Cannot open display $DISPLAY" >&2; exit 1; fi\nprintf "640 360\\n"\n', { mode: 0o755 });
  return { marker, logPath: join(dir, 'probe.jsonl'), env: { PATH: dir, DISPLAY_READY_MARKER: marker }, display: ':99', width: 640, height: 360, xvfb: { child: { exitCode: null, signalCode: null }, logPath: join(dir, 'xvfb.log') } };
}

test('an alive Xvfb waits until an actual X11 geometry probe succeeds', async t => {
  const fixture = displayFixture(t);
  const waiting = waitForDisplay(fixture);

  while (!existsSync(fixture.logPath)) await new Promise(resolve => setTimeout(resolve, 10));
  const timer = setTimeout(() => writeFileSync(fixture.marker, ''), 400);
  t.after(() => clearTimeout(timer));
  await waiting;
  const probes = readFileSync(fixture.logPath, 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(probes.some(probe => probe.code !== 0), 'must observe unavailable X11 before readiness');
  assert.equal(probes.at(-1).stdout, '640 360');
  assert.ok(probes.at(-1).elapsed_ms >= 350, 'must not launch after the old 300ms delay');
});

test('an unavailable display keeps the wait open, with its X11 diagnostics, until the abort', async t => {
  const fixture = displayFixture(t);
  const abort = new AbortController();
  const waiting = waitForDisplay({ ...fixture, signal: abort.signal });
  let settled = false;
  waiting.then(() => { settled = true; }, () => { settled = true; });
  await new Promise(resolve => setTimeout(resolve, 1500));
  assert.equal(settled, false, 'no clock of its own ends the wait');
  abort.abort(new Error('lobby_sec elapsed'));
  await assert.rejects(waiting, /lobby_sec elapsed/);
  assert.match(readFileSync(fixture.logPath, 'utf8'), /Cannot open display :99/);
});

test('display readiness abort and dead Xvfb stop startup promptly', async t => {
  const fixture = displayFixture(t);
  const abort = new AbortController();
  abort.abort(new Error('Simulation stopped during X11 startup'));
  await assert.rejects(() => waitForDisplay({ ...fixture, signal: abort.signal }), /Simulation stopped during X11 startup/);
  fixture.xvfb.child.exitCode = 1;
  await assert.rejects(() => waitForDisplay(fixture), /Xvfb exited before display readiness/);
});
