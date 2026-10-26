import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp, mkdir, writeFile, readFile, rm, access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';

const main = fileURLToPath(new URL('../../environment/sim/main.mjs', import.meta.url));
const verify = fileURLToPath(new URL('../../environment/sim/verify.mjs', import.meta.url));

async function run(args, env, timeout = 5000) {
  const child = spawn(process.execPath, args, {env, stdio: ['ignore', 'pipe', 'pipe']});
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeout);
  try {
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    assert.equal(timedOut, false, `Entrypoint did not exit after its native child died:\n${output}`);
    return {code, output};
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
}

for (const [name, command] of [['SIGKILL', 'kill -KILL $$'], ['SIGTERM', 'kill -TERM $$'], ['exit 7', 'exit 7']]) {
  test(`native startup ${name} fails the actual app and leaves no reward`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mindustry-startup-exit-'));
    try {
      const bin = join(directory, 'bin'), logs = join(directory, 'logs');
      await mkdir(bin);
      await mkdir(logs);
      await writeFile(join(bin, 'sh'), '#!/bin/sh\nexit 0\n', {mode: 0o755});
      await writeFile(join(bin, 'java'), `#!/bin/sh\n${command}\n`, {mode: 0o755});
      const env = {...process.env, PATH: `${bin}:${process.env.PATH}`, PORT: '0',
        MINDUSTRY_SEATS: '["seat-1"]', MINDUSTRY_SEAT_TOKEN_MAP: '{"seat-1":"test-token"}',
        MINDUSTRY_SIM_SETTINGS: '{}', SIM_LOGS: logs, MINDUSTRY_RUN_DIR: join(directory, 'run')};
      const app = await run([main], env);
      assert.equal(app.code, 1, app.output);
      assert.match(app.output, /Mindustry server exited during startup/);
      const result = JSON.parse(await readFile(join(logs, 'result.json'), 'utf8'));
      assert.match(result.failure, /Mindustry server exited during startup/);
      const reward = join(directory, 'verifier', 'reward.json');
      const verified = await run([verify, logs, reward], env);
      assert.notEqual(verified.code, 0, verified.output);
      await assert.rejects(access(reward), {code: 'ENOENT'});
    } finally {
      await rm(directory, {recursive: true, force: true});
    }
  });
}
