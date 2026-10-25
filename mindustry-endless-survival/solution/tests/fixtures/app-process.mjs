import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export async function startApp({ main, seats, settings, env = {}, args = [] }) {
  const logs = mkdtempSync(join(tmpdir(), 'game-logs-'));
  const tokens = Object.fromEntries(seats.map((seat) => [seat, `token-${seat}-${randomUUID()}`]));
  const child = spawn(process.execPath, [main, ...args], {
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      HARBOR_SEATS: JSON.stringify(seats),
      HARBOR_SEAT_TOKENS: JSON.stringify(tokens),
      HARBOR_SIM_SETTINGS: JSON.stringify(settings),
      SIM_LOGS: logs,
      PORT: '0',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  const port = await new Promise((resolve, reject) => {
    const onData = (chunk) => {
      output += chunk;
      const match = /listening on (\d+)/.exec(output);
      if (match) resolve(Number(match[1]));
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', (chunk) => {
      output += chunk;
    });
    child.once('exit', (code) => reject(new Error(`The game exited (${code}) before it listened:\n${output}`)));
  });
  const base = `http://127.0.0.1:${port}`;

  async function request(path, { seat, token = seat ? tokens[seat] : undefined, method = 'GET', body, signal } = {}) {
    const response = await fetch(base + path, {
      method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
    const text = await response.text();
    return { status: response.status, body: text.trim() ? JSON.parse(text) : null };
  }
  const ok = async (promise) => {
    const reply = await promise;
    if (reply.status !== 200) throw new Error(`HTTP ${reply.status}: ${JSON.stringify(reply.body)}`);
    return reply.body;
  };
  const seat = (id) => ({
    get: (path, options = {}) => ok(request(path, { ...options, seat: id })),
    post: (path, body = {}, options = {}) => ok(request(path, { ...options, seat: id, method: 'POST', body })),
    request: (path, options = {}) => request(path, { ...options, seat: id }),
  });

  async function until(predicate, { timeoutMs = 20_000, what = 'condition' } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = await predicate();
      if (value) return value;
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}\n${output.slice(-4000)}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  const healthy = async () => (await request('/health')).status === 200;
  const file = (name) => (existsSync(join(logs, name)) ? readFileSync(join(logs, name), 'utf8') : null);
  const log = () => (file('log.jsonl') ?? '').split('\n').filter(Boolean).map((line) => JSON.parse(line));

  async function stop() {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          resolve();
        }, 5000);
        child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    rmSync(logs, { recursive: true, force: true });
  }

  return { base, child, logs, tokens, request, seat, until, healthy, file, log, stop, output: () => output };
}
