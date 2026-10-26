import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('native replay seeking excludes preroll worlds but preserves the current and later worlds', () => {
  const task = fileURLToPath(new URL('../../..', import.meta.url));
  const work = mkdtempSync(join(tmpdir(), 'replay-viewer-state-'));
  const desktopJar = process.env.MINDUSTRY_DESKTOP_JAR ?? '/opt/mindustry/Mindustry.jar';
  const viewer = join(task, 'environment/render-recording/viewer/src/agentbridge/replay');
  try {
    execFileSync('javac', ['--release', '17', '-cp', desktopJar, '-d', work,
      join(task, 'environment/plugin/src/agentbridge/ReplayFormat.java'), join(viewer, 'BridgeJson.java'), join(viewer, 'ReplayViewer.java'),
      join(task, 'solution/tests/fixtures/ReplayViewerStateCheck.java')]);
    const result = JSON.parse(execFileSync('java', ['-cp', `${work}${delimiter}${desktopJar}`, 'agentbridge.replay.ReplayViewerStateCheck'], { encoding: 'utf8' }));
    assert.deepEqual(result, { ok: true, preroll_cases: 4, later_world_kept: true, empty_worlds_kept: true });
  } finally { rmSync(work, { recursive: true, force: true }); }
});
