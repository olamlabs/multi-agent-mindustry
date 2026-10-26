import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { controlFetch, seatControl } from '../../environment/seat-client/client.mjs';

function harness(t, fetchImpl) {
  const logDir = mkdtempSync(join(tmpdir(), 'mindustry-seat-control-'));
  t.after(() => rmSync(logDir, { recursive: true, force: true }));
  const control = seatControl({ seat: 'seat-2', url: 'http://main:9001/seats/seat-2', logDir, fetchImpl });
  return { ...control, logDir };
}

test('a control request is one attempt with no clock: its first HTTP failure fails it', async t => {
  let calls = 0;
  const { request } = harness(t, async (url, options) => {
    calls++;
    assert.equal(options.signal, undefined, 'no request deadline');
    return { ok: false, status: 503, json: async () => { throw new Error('not JSON'); } };
  });
  await assert.rejects(request(), error => {
    assert.equal(error.message, 'seat-2 control: HTTP 503');
    return true;
  });
  assert.equal(calls, 1);
});

test('a report is sent exactly once, and what it tried to say is kept in status.json', async t => {
  const calls = [];
  const { report, logDir } = harness(t, async (url, options) => { calls.push(options); throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }); });
  await assert.rejects(report('ready', { record: true }), { message: 'seat-2 control: transport failure: socket hang up' });
  assert.equal(calls.length, 1, 'no retries');
  assert.equal(calls[0].method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].body), { status: 'ready', metadata: { record: true } });
  assert.deepEqual(JSON.parse(readFileSync(join(logDir, 'status.json'), 'utf8')), { seat: 'seat-2', status: 'ready', metadata: { record: true } });
});

test('the first control request is one attempt: a refused connection, an HTTP error or bad JSON fails it at once', async t => {
  for (const kind of ['refused', 401, 404, 502, 503, 'transport', 'json']) {
    let attempts = 0;
    const failing = harness(t, async () => {
      attempts++;
      if (kind === 'refused') throw Object.assign(new Error('connect ECONNREFUSED 172.18.0.2:9001'), { code: 'ECONNREFUSED' });
      if (kind === 'transport') throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
      if (kind === 'json') return { ok: true, status: 200, json: async () => { throw new Error('not JSON'); } };
      return { ok: false, status: kind };
    });
    await assert.rejects(failing.request(), error => {
      assert.match(error.message, /^seat-2 control: /);
      return true;
    });
    assert.equal(attempts, 1, String(kind));
  }
});

test('controlFetch is one request on its own socket, with no deadline of its own', async t => {
  let sockets = 0;
  const server = createServer({ requestTimeout: 0, headersTimeout: 0 }, (req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => setTimeout(() => res.writeHead(req.url === '/down' ? 503 : 200, { 'content-type': 'application/json' }).end(JSON.stringify({ method: req.method, body, type: req.headers['content-type'] })), 150));
  });
  server.on('connection', () => { sockets++; });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const ok = await controlFetch(`${base}/seats/seat-1`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"a":1}' });
  assert.equal(ok.ok, true);
  assert.deepEqual(await ok.json(), { method: 'POST', body: '{"a":1}', type: 'application/json' });
  const down = await controlFetch(`${base}/down`, { method: 'GET', headers: {} });
  assert.equal(down.status, 503);
  assert.equal(sockets, 2, 'no shared keep-alive agent');
  server.close();
  await assert.rejects(controlFetch(`${base}/seats/seat-1`, { method: 'GET', headers: {} }), error => error.code === 'ECONNREFUSED');
});
