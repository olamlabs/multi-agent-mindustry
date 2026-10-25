import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const work = mkdtempSync(join(tmpdir(), 'screen-grid-'));
process.env.OLAM_RUN_DIR = work;
const { screenGrid, gridShape } = await import('../../../environment/dependencies/screen-recorder.mjs');
try {
  for (const count of [1, 4]) {
    const video = { fps: 1, width: 640, height: 360 };
    const { filter } = screenGrid(video, Array.from({ length: count }, (_, i) => `seat-${i + 1}`));
    const inputs = Array.from({ length: count }, () => ['-f', 'lavfi', '-i', 'color=c=blue:s=640x360:r=1']).flat();
    const out = join(work, `${count}.mp4`);
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...inputs, '-filter_complex', filter, '-map', '[v]', '-frames:v', '1', '-c:v', 'libx264', out]);
    const result = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-count_frames', '-show_streams', '-of', 'json', out], { encoding: 'utf8' }));
    const shape = gridShape(count), stream = result.streams[0];
    assert.equal(Number(stream.nb_read_frames), 1);
    assert.equal(stream.width, shape.columns * video.width);
    assert.equal(stream.height, shape.rows * video.height);
  }
  console.log('PASS one-camera and four-camera grids encode decodable frames');
} finally {
  rmSync(work, { recursive: true, force: true });
}
