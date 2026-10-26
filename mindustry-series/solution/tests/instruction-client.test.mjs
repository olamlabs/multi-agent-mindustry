import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { ApiError, serveApi } from '../../environment/sim/http.mjs';

const run = promisify(execFile);
const instruction = fileURLToPath(new URL('../../instruction.md', import.meta.url));
const probe = `
import json, os, sys
from pathlib import Path
from unittest.mock import patch
text = Path(sys.argv[1]).read_text()
example = text.split("\x60\x60\x60python\\n", 1)[1].split("\x60\x60\x60", 1)[0]
client = {}
exec(compile(example.split("players = call(", 1)[0], "instruction.md", "exec"), client)
with patch.dict(os.environ, {"MINDUSTRY_SIM_URL": sys.argv[2]}), patch.object(Path, "read_text", return_value="test-token"):
    try:
        result = client["call"](sys.argv[3], {})
    except client["GameAPIError"] as error:
        print(json.dumps({"raised": True, "message": str(error), "response": error.response}))
    else:
        print(json.dumps({"raised": False, "response": result}))
`;

test('documented client preserves HTTP, streamed, and per-operation error responses', async t => {
  const mixed = { results: [
    { index: 0, ok: true, effect: { queued: 1 } },
    { index: 1, ok: false, error: { code: 'out_of_range', message: 'outside transfer range' } },
  ] };
  const server = await serveApi({
    port: 0,
    tokens: { 'seat-1': 'test-token' },
    routes: {
      'POST /fast': () => { throw new ApiError(400, 'invalid field', { status: { phase: 'running' } }); },
      'POST /delayed': async () => {
        await new Promise(resolve => setTimeout(resolve, 5100));
        throw new ApiError(409, 'delayed refusal', { status: { phase: 'running' } });
      },
      'POST /act': () => mixed,
    },
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  const call = async path => {
    const { stdout, stderr } = await run('python3', ['-c', probe, instruction, url, path], { timeout: 15000 });
    return { ...JSON.parse(stdout), stderr };
  };

  const fast = await call('/fast');
  assert.equal(fast.raised, true);
  assert.match(fast.message, /^HTTP 400: invalid field$/);
  assert.deepEqual(fast.response, { error: 'invalid field', status: { phase: 'running' } });

  const delayed = await call('/delayed');
  assert.equal(delayed.raised, true);
  assert.equal(delayed.message, '/delayed: delayed refusal');
  assert.deepEqual(delayed.response, { error: 'delayed refusal', status: { phase: 'running' } });

  const partial = await call('/act');
  assert.equal(partial.raised, false);
  assert.deepEqual(partial.response, mixed);
  assert.match(partial.stderr, /input 1 refused: out_of_range: outside transfer range/);
});
