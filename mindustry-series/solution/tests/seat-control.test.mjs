import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { controlFetch, seatControl } from '../../environment/seat-client/client.mjs';

const SECRETS = ['private:password', 'private-route', 'private-token', 'private-header', 'private-tunnel-key', 'private-response'];

function harness(t, fetchImpl) {
  const logDir = mkdtempSync(join(tmpdir(), 'mindustry-seat-control-'));
  t.after(() => rmSync(logDir, { recursive: true, force: true }));
  const control = seatControl({ seat: 'seat-2', url: 'https://private:password@example.invalid/private-route/seats/seat-2?token=private-token', headers: { Authorization: 'Bearer private-header' }, secret: 'private-tunnel-key', logDir, fetchImpl });
  return { ...control, logDir };
}

test('a control request is one attempt with no clock: its first HTTP failure fails it, without leaking credentials', async t => {
  let calls = 0;
  const { request } = harness(t, async (url, options) => {
    calls++;
    assert.equal(options.signal, undefined, 'no request deadline');
    return { ok: false, status: 503, json: async () => { throw new Error('private-response'); } };
  });
  await assert.rejects(request(), error => {
    assert.equal(error.message, 'seat-2 control: HTTP 503');
    for (const secret of SECRETS) assert.ok(!String(error.stack).includes(secret), secret);
    return true;
  });
  assert.equal(calls, 1);
});

test('a report is sent exactly once, and what it tried to say is kept in status.json', async t => {
  const calls = [];
  const { report, logDir } = harness(t, async (url, options) => { calls.push(options); throw Object.assign(new Error('private-token'), { cause: { code: 'ECONNRESET' } }); });
  await assert.rejects(report('ready', { record: true }), /seat-2 control: transport failure/);
  assert.equal(calls.length, 1, 'no retries');
  assert.equal(calls[0].method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].body), { status: 'ready', metadata: { record: true } });
  assert.deepEqual(JSON.parse(readFileSync(join(logDir, 'status.json'), 'utf8')), { seat: 'seat-2', status: 'ready', metadata: { record: true } });
});

test('a control poll that fails is written to failure.txt and leaves the camera on its last state, once per outage', async t => {
  const answers = ['transport', 'transport', { phase: 'record' }, 503, { phase: 'stop' }];
  const calls = [];
  const { poll, logDir } = harness(t, async (url, options) => {
    calls.push(options.method);
    const answer = answers.shift();
    if (answer === 'transport') throw Object.assign(new Error('private-token'), { cause: { code: 'ECONNRESET' } });
    if (typeof answer === 'number') return { ok: false, status: answer };
    return { ok: true, status: 200, json: async () => answer };
  });
  const connected = { phase: 'connect' };
  assert.equal(await poll(connected), connected);
  assert.equal(await poll(connected), connected);
  assert.deepEqual(await poll(connected), { phase: 'record' });
  assert.deepEqual(await poll({ phase: 'record' }), { phase: 'record' });
  assert.deepEqual(await poll({ phase: 'record' }), { phase: 'stop' });
  assert.deepEqual(calls, ['GET', 'GET', 'GET', 'GET', 'GET'], 'one request per poll');
  const lines = readFileSync(join(logDir, 'failure.txt'), 'utf8').trim().split('\n').map(line => line.replace(/^\S+ /, ''));
  assert.deepEqual(lines, ['seat-2 control: transport failure; the recording goes on', 'seat-2 control answers again', 'seat-2 control: HTTP 503; the recording goes on', 'seat-2 control answers again']);
  for (const secret of SECRETS) assert.ok(!readFileSync(join(logDir, 'failure.txt'), 'utf8').includes(secret), secret);
});

test('the first control request is one attempt: a refused connection, a proxy 502/503 or bad JSON fails it at once', async t => {
  for (const kind of ['refused', 401, 404, 502, 503, 'transport', 'json']) {
    let attempts = 0;
    const failing = harness(t, async () => {
      attempts++;
      if (kind === 'refused') throw Object.assign(new Error('private-token'), { cause: { code: 'ECONNREFUSED' } });
      if (kind === 'transport') throw Object.assign(new Error('private-token'), { cause: { code: 'ECONNRESET' } });
      if (kind === 'json') return { ok: true, status: 200, json: async () => { throw new Error('private-response'); } };
      return { ok: false, status: kind };
    });
    await assert.rejects(failing.request(), error => {
      assert.match(error.message, /^seat-2 control: /);
      for (const secret of SECRETS) assert.ok(!String(error.stack).includes(secret), secret);
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
    req.on('end', () => setTimeout(() => res.writeHead(req.url === '/down' ? 503 : 200, { 'content-type': 'application/json' }).end(JSON.stringify({ method: req.method, body, key: req.headers['x-mindustry-key'] })), 150));
  });
  server.on('connection', () => { sockets++; });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const ok = await controlFetch(`${base}/seats/seat-1`, { method: 'POST', headers: { 'X-Mindustry-Key': 'k', 'Content-Type': 'application/json' }, body: '{"a":1}' });
  assert.equal(ok.ok, true);
  assert.deepEqual(await ok.json(), { method: 'POST', body: '{"a":1}', key: 'k' });
  const down = await controlFetch(`${base}/down`, { method: 'GET', headers: {} });
  assert.equal(down.status, 503);
  assert.equal(sockets, 2, 'no shared keep-alive agent');
  server.close();
  await assert.rejects(controlFetch(`${base}/seats/seat-1`, { method: 'GET', headers: {} }), error => error.code === 'ECONNREFUSED');
});
