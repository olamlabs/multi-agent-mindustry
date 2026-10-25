import test from 'node:test';
import assert from 'node:assert/strict';
import { ViewerHealth } from '../../environment/seat-client/view-health.mjs';
const heartbeat = (now, extra = {}) => ({ seat: 'seat-7', timestamp_ms: now, connected: true, connections: 1, attempts: 1, disconnected_since_ms: 0, ...extra });

test('a running recorder does not make a disconnected native view healthy, and a long disconnect does not stop the recording', () => {
  const view = new ViewerHealth('seat-7');
  view.update(heartbeat(1000), 1000);
  view.requireConnected();
  view.update(heartbeat(2000, { connected: false, disconnected_since_ms: 2000 }), 2000);
  assert.throws(() => view.requireConnected(), /not connected/);
  assert.equal(view.update(heartbeat(3_602_000, { connected: false, disconnected_since_ms: 2000 }), 3_602_000).connected, false);
  view.update(heartbeat(3_603_000, { connections: 2, attempts: 3 }), 3_603_000);
  assert.equal(view.requireConnected().recoveries, 1);
});

test('a stale connected flag cannot hide a frozen viewer process', () => {
  const view = new ViewerHealth('seat-7');
  view.update(heartbeat(1000), 1000);
  view.update(heartbeat(1000), 17000);
  assert.throws(() => view.requireConnected(), /not connected/);
  assert.equal(view.update(heartbeat(1000), 61000).connected, false);
});

test('wrong-seat and malformed heartbeat evidence is rejected', () => {
  const view = new ViewerHealth('seat-7');
  for (const value of [null, {}, heartbeat(1000, { seat: 'seat-1' }), heartbeat(1000, { connected: 'true' }), heartbeat(1000, { connections: -1 })]) {
    assert.throws(() => view.update(value, 1000), /invalid/);
  }
});
