import test from 'node:test';
import assert from 'node:assert/strict';
import { options, Refused, validateRenderedView } from '../../environment/render-recording/render.mjs';

test('a replay seat view requires evidence that the requested player appeared in every rendered world', () => {
  const view = { name: 'seat-3', seat: 'seat-3' };
  for (const viewer of [
    { worlds: 1, seat_seen: [false] },
    { worlds: 2, seat_seen: [true, false] },
    { worlds: 0, seat_seen: [] },
    { worlds: 1, seat_seen: null },
    { worlds: 2, seat_seen: [true] },
  ]) assert.throws(() => validateRenderedView(view, viewer), error => error instanceof Refused && /requested seat seat-3/.test(error.message));
  assert.doesNotThrow(() => validateRenderedView(view, { worlds: 2, seat_seen: [true, true], error: null }));
  assert.doesNotThrow(() => validateRenderedView({ name: 'at-160-80', seat: 'none' }, { worlds: 1, seat_seen: null, error: null }));
  assert.throws(() => validateRenderedView(view, { worlds: 1, seat_seen: [true], error: 'packet decode failed' }), /packet decode failed/);
});

test('replay seat options stay within the native series roster range', () => {
  const base = ['--replay', '/r', '--out', '/o', '--seats'];
  assert.equal(options([...base, 'seat-200']).views[0].seat, 'seat-200');
  for (const seat of ['seat-0', 'seat-201', 'seat-999']) assert.throws(() => options([...base, seat]), /seat-1 through seat-200/);
});
