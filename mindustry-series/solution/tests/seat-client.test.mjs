import test from 'node:test';
import assert from 'node:assert/strict';
import { recordingSettings, recordingArgs } from '../../environment/seat-client/client.mjs';
import { bootRenderers, stopRenderers } from '../../environment/sim/renderer.mjs';
import { validateSettings } from '../../environment/sim/settings.mjs';

const seats = count => Array.from({ length: count }, (_, i) => `seat-${i + 1}`);

test('every seat records at constant quality until the match stops it, whatever the seat count or game clock', () => {
  for (const count of [1, 2, 4, 6, 8, 12, 24, 32, 50, 200]) {
    const video = recordingSettings({ seats: seats(count), video: { segment_sec: 99999 } });
    assert.deepEqual(video, { record: true, fps: 5, width: 960, height: 540, segment_sec: 99999 });
    for (const time_limit_sec of [10, 900, 86400, null]) assert.deepEqual(recordingSettings({ seats: seats(count), settings: { time_limit_sec }, video: { segment_sec: 99999 } }), video);
    const args = recordingArgs(video, 'seat-1', '/recordings');
    assert.equal(args[args.indexOf('-crf') + 1], '28');
    for (const flag of ['-t', '-to', '-fs', '-frames:v', '-b:v', '-maxrate', '-bufsize']) assert.ok(!args.includes(flag), flag);
  }
  assert.equal(recordingSettings({ seats: seats(8) }).segment_sec, 600);
  assert.throws(() => recordingSettings({ seats: seats(8), video: { kbps: 400 } }), /video.kbps is not used/);
  assert.ok(!('duration_budget_sec' in validateSettings({}).video));
  assert.throws(() => validateSettings({ game_mode: 'pvp', time_limit_sec: null, video: { duration_budget_sec: 7200 } }), /Unknown video setting: duration_budget_sec/);
});

test('recording uses the resolved video settings and canonical seats', () => {
  const video = recordingSettings({ seats: seats(8).map(id => ({ id })), settings: { video: { width: 1280 } }, video: { fps: 10, width: 640, height: 360 } });
  assert.equal(video.width, 640);
  assert.equal(video.fps, 10);
  const args = recordingArgs(video, 'seat-8', '/recordings');
  assert.equal(args.at(-1), '/recordings/seat-8-%03d.mp4');
  assert.equal(args[args.indexOf('-i') + 1], ':99');
  assert.ok(args.includes('movflags=+frag_keyframe+empty_moov+default_base_moof'));
  for (const invalid of [[], seats(201), seats(8).fill('seat-1'), [...seats(7), 'seat-9']]) {
    assert.throws(() => recordingSettings({ seats: invalid }), /canonical/);
  }
});

test('single native camera requires explicit seatScoped opt-in and one canonical seat', async () => {
  const base = { evidence: '/nonexistent/do-not-create', video: { record: false } };
  await assert.rejects(() => bootRenderers({ ...base, seats: ['seat-8'] }), /requires seats/);
  for (const invalid of [[], ['seat-201'], ['seat-1', 'seat-2']]) {
    await assert.rejects(() => bootRenderers({ ...base, seats: invalid, seatScoped: true }), /single canonical/);
  }
  const handle = await bootRenderers({ ...base, seats: ['seat-200'], seatScoped: true });
  assert.deepEqual(handle.labels, ['seat-200 native view']);
  assert.equal(handle.processes.length, 0);
  await stopRenderers(handle);
});

test('a seat without a camera starts nothing, reports nothing, and exits cleanly once its container is stopped', {timeout:15000}, async t => {
  const { spawn } = await import('node:child_process');
  const { createServer } = await import('node:http');
  const { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'mindustry-no-camera-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const requests = [];
  const coordinator = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ phase: 'connect', seat: 'seat-3', camera: false, seats: ['seat-1', 'seat-2', 'seat-3', 'seat-4'], settings: {}, video: { record: true, fps: 5, width: 960, height: 540, seats: ['seat-1'] }, elapsed_sec: null }));
  });
  await new Promise(resolve => coordinator.listen(0, '127.0.0.1', resolve));
  t.after(() => coordinator.close());
  writeFileSync(join(dir, 'secret'), 'k'.repeat(40));
  const client = spawn(process.execPath, [new URL('../../environment/seat-client/client.mjs', import.meta.url).pathname], { env: { ...process.env, HARBOR_SEAT: 'seat-3', HARBOR_SIM_URLS: JSON.stringify({ 9000: 'http://127.0.0.1:9', 9001: `http://127.0.0.1:${coordinator.address().port}` }), HARBOR_SIM_HEADERS: '{}', MINDUSTRY_TUNNEL_SECRET: join(dir, 'secret'), MINDUSTRY_SEAT_RUN_DIR: join(dir, 'run'), MINDUSTRY_RECORDINGS_DIR: join(dir, 'recordings') }, stdio: 'ignore' });
  t.after(()=>client.kill('SIGKILL'));
  const exited = new Promise(resolve => client.once('exit', (code, signal) => resolve({ code, signal })));
  const status = join(dir, 'run', 'status.json');
  while (!existsSync(status)) {
    assert.equal(client.exitCode,null,'camera client exited before reporting status');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(client.exitCode, null, 'it stays up until Harbor stops its container');
  assert.deepEqual(JSON.parse(readFileSync(status, 'utf8')), { seat: 'seat-3', status: 'no_camera', metadata: {} });
  assert.equal(JSON.parse(readFileSync(join(dir, 'recordings', 'metadata.json'), 'utf8')).camera, false);
  assert.ok(!existsSync(join(dir, 'run', 'tunnel.log')), 'no game tunnel');
  assert.deepEqual(requests, ['GET /seats/seat-3']);
  client.kill('SIGTERM');
  assert.deepEqual(await exited, { code: 0, signal: null });
});
