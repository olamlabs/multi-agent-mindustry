import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { grade, isEndlessSurvival } from './grade.mjs';
import { gradeEndlessSurvival } from './survival-grade.mjs';
import { readAppSurvivalEvidence, readEndlessEvidence } from './survival-evidence.mjs';
import { writeJsonAtomic } from './atomic-json.mjs';

export function readGame(dir) {
  const app=readAppSurvivalEvidence(dir,['setup','result']);
  if(isEndlessSurvival(app.setup)) return readEndlessEvidence(dir);
  const error=app.evidence_read_errors.find(entry=>entry.code!=='ENOENT');
  if(error) throw new Error(`Invalid game evidence: ${error.path}: ${error.code}`);
  throw new Error('Only endless survival evidence can be verified');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dir = process.argv[2] ?? '/logs/sim';
  const out = process.argv[3] ?? '/logs/verifier/reward.json';

  rmSync(out,{force:true});
  rmSync(join(dir,'survival-outcome.json'),{force:true});
  const game = readGame(dir);

  const expected = process.env.MINDUSTRY_SURVIVAL_SEATS;
  const options = expected === undefined ? {} : {seats: Number(expected)};
  if (isEndlessSurvival(game.setup)) writeJsonAtomic(join(dir, 'survival-outcome.json'), gradeEndlessSurvival(game, options));
  const scores = grade(game, options);

  const reward = isEndlessSurvival(game.setup)
    ? {reward: scores.reward, ...Object.fromEntries(game.setup.seats.map(seat => [seat, scores.reward]))}
    : scores;
  mkdirSync(dirname(out), { recursive: true });
  writeJsonAtomic(out, reward);
  console.log(JSON.stringify(reward));
}
