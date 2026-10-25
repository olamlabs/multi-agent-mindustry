import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { SegmentVerifier, recordingSettings } from '../../environment/seat-client/client.mjs';

function fixture(t, probe) {
  const directory = mkdtempSync(join(tmpdir(), 'mindustry-recording-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const video = recordingSettings({ seats: Array.from({ length: 8 }, (_, i) => `seat-${i + 1}`) });
  const calls = [];
  const valid = { streams: [{ nb_read_frames: '3000', width: 960, height: 540 }], format: { duration: '600' } };
  const verifier = new SegmentVerifier(video, 'seat-1', directory, directory, async (path, ...rest) => {
    calls.push(basename(path));
    assert.deepEqual(rest, [], 'a probe gets no clock');
    return probe ? probe(path, valid) : valid;
  });
  const segment = (index, text = 'encoded video') => {
    const path = join(directory, `seat-1-${String(index).padStart(3, '0')}.mp4`);
    writeFileSync(path, text);
    return path;
  };
  return { verifier, calls, segment };
}

test('five hours of closed segments are verified during play; shutdown probes only the tail', async t => {
  const { verifier, calls, segment } = fixture(t);
  segment(0);
  assert.deepEqual(await verifier.verify(), []);
  for (let i = 1; i <= 30; i++) {
    segment(i);
    const files = await verifier.verify();
    assert.equal(files.length, i);
    assert.equal(calls.length, i);
    assert.equal(calls.at(-1), `seat-1-${String(i - 1).padStart(3, '0')}.mp4`);
    await verifier.verify();
    assert.equal(calls.length, i, 'closed files must not be decoded on every poll');
  }
  const files = await verifier.verify({ final: true });
  assert.equal(calls.length, 31);
  assert.equal(calls.at(-1), 'seat-1-030.mp4');
  assert.equal(files.reduce((sum, file) => sum + file.frames, 0), 31 * 3000);
  assert.equal(files.reduce((sum, file) => sum + file.duration_sec, 0), 31 * 600);
});

test('changed segments are revalidated and deleted verified segments fail shutdown', async t => {
  const { verifier, calls, segment } = fixture(t);
  const first = segment(0);
  segment(1);
  await verifier.verify();

  unlinkSync(first);
  segment(0, 'changed video');
  await verifier.verify();
  assert.equal(calls.length, 2);
  unlinkSync(first);
  await assert.rejects(verifier.verify({ final: true }), /previously verified video segment is missing/);
});

test('recordings retain numeric order and the open tail across segment digit boundaries', async t => {
  const { verifier, calls, segment } = fixture(t);
  for (const index of [10001, 10000, 1001, 1000, 999, 998, 1]) segment(index);
  const names = [1, 998, 999, 1000, 1001, 10000, 10001].map(index => `seat-1-${String(index).padStart(3, '0')}.mp4`);
  assert.deepEqual((await verifier.verify()).map(file => file.name), names.slice(0, -1));
  assert.deepEqual(calls, names.slice(0, -1));
  assert.deepEqual((await verifier.verify({ final: true })).map(file => file.name), names);
  assert.deepEqual(calls, names);
});

test('bad video metadata still fails with the seat and segment in the error', async t => {
  for (const invalid of [
    { streams: [], format: { duration: '600' } },
    { streams: [{ nb_read_frames: '0', width: 960, height: 540 }], format: { duration: '600' } },
    { streams: [{ nb_read_frames: '3000', width: 640, height: 540 }], format: { duration: '600' } },
    { streams: [{ nb_read_frames: '3000', width: 960, height: 540 }], format: { duration: 'NaN' } },
  ]) {
    const { verifier, segment } = fixture(t, () => invalid);
    segment(0); segment(1);
    await assert.rejects(verifier.verify(), /seat-1 segment seat-1-000.mp4: Invalid encoded video segment/);
    assert.equal(verifier.verified.size, 0);
  }
});

test('probe failures and concurrent file changes cannot become cached success', async t => {
  const failed = fixture(t, () => { throw new Error('ffprobe exited 1'); });
  failed.segment(0); failed.segment(1);
  await assert.rejects(failed.verifier.verify(), /seat-1 segment seat-1-000.mp4: ffprobe exited 1/);
  assert.equal(failed.verifier.verified.size, 0);
  const changed = fixture(t, (path, valid) => { writeFileSync(path, 'modified while decoding'); return valid; });
  changed.segment(0); changed.segment(1);
  await assert.rejects(changed.verifier.verify(), /changed during validation/);
  assert.equal(changed.verifier.verified.size, 0);
});

test('finalization waits for a slow probe of the unverified tail: it has no clock of its own', async t => {
  const { verifier, segment, calls } = fixture(t, async (path, valid) => { await new Promise(resolve => setTimeout(resolve, 300)); return valid; });
  segment(0);
  const files = await verifier.verify({ final: true });
  assert.equal(calls.length, 1);
  assert.equal(files[0].frames, 3000);
});
