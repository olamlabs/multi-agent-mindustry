import test from 'node:test';
import assert from 'node:assert/strict';
import { recordingSettings, recordingArgs } from '../../environment/seat-client/client.mjs';
import { bootRenderers, stopRenderers } from '../../environment/sim/renderer.mjs';
import { validateSettings } from '../../environment/sim/settings.mjs';

const seats = count => Array.from({ length: count }, (_, i) => `seat-${i + 1}`);

test('every seat records at constant quality until the match stops it, whatever the seat count or game clock', () => {
  for (const count of [1, 2, 4, 6, 8, 12, 20]) {
    const video = recordingSettings({ seats: seats(count), video: { segment_sec: 99999 } });
    assert.deepEqual(video, { record: true, fps: 5, width: 960, height: 540, segment_sec: 99999 });
    assert.deepEqual(recordingSettings({ seats: seats(count), settings: { time_limit_sec:null }, video: { segment_sec: 99999 } }), video);
    const args = recordingArgs(video, 'seat-1', '/recordings');
    assert.equal(args[args.indexOf('-crf') + 1], '28');
    for (const flag of ['-t', '-to', '-fs', '-frames:v', '-b:v', '-maxrate', '-bufsize']) assert.ok(!args.includes(flag), flag);
  }
  assert.equal(recordingSettings({ seats: seats(8) }).segment_sec, 600);
  assert.throws(() => recordingSettings({ seats: seats(8), video: { kbps: 400 } }), /video.kbps is not used/);
  assert.ok(!('duration_budget_sec' in validateSettings({}).video));
  assert.throws(() => validateSettings({ game_mode: 'survival', time_limit_sec: null, video: { duration_budget_sec: 7200 } }), /Unknown video setting: duration_budget_sec/);
});

test('recording uses the resolved video settings and canonical seats', () => {
  const video = recordingSettings({ seats: seats(8).map(id => ({ id })), settings: { video: { width: 1280 } }, video: { fps: 10, width: 640, height: 360 } });
  assert.equal(video.width, 640);
  assert.equal(video.fps, 10);
  const args = recordingArgs(video, 'seat-8', '/recordings');
  assert.equal(args.at(-1), '/recordings/seat-8-%03d.mp4');
  assert.equal(args[args.indexOf('-i') + 1], ':99');
  assert.ok(args.includes('movflags=+frag_keyframe+empty_moov+default_base_moof'));
  for (const invalid of [[], seats(8).fill('seat-1'), [...seats(7), 'seat-9']]) {
    assert.throws(() => recordingSettings({ seats: invalid }), /canonical/);
  }
});

test('single native camera requires explicit seatScoped opt-in and one canonical seat', async () => {
  const base = { evidence: '/nonexistent/do-not-create', video: { record: false } };
  await assert.rejects(() => bootRenderers({ ...base, seats: ['seat-8'] }), /requires seats/);
  for (const invalid of [[], ['seat-21'], ['seat-1', 'seat-2']]) {
    await assert.rejects(() => bootRenderers({ ...base, seats: invalid, seatScoped: true }), /single canonical/);
  }
  const handle = await bootRenderers({ ...base, seats: ['seat-20'], seatScoped: true });
  assert.deepEqual(handle.labels, ['seat-20 native view']);
  assert.equal(handle.processes.length, 0);
  await stopRenderers(handle);
});
