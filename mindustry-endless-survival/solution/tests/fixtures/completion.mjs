import {existsSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {isEndlessSurvival} from '../../../environment/sim/grade.mjs';
import {gradeEndlessSurvival} from '../../../environment/sim/survival-grade.mjs';
import {readGame} from '../../../environment/sim/verify.mjs';

export function completion(input) {
  if (!isEndlessSurvival(input.setup)) throw new Error('The endless-survival completion probe requires its configured scenario');
  if (input.result?.failure != null) throw new Error(`Simulation failed: ${input.result.failure}`);
  if (input.result == null) return {complete: false};
  const outcome = gradeEndlessSurvival(input);
  if (outcome.status !== 'valid') throw new Error(`Unscored terminal: ${outcome.status}; ${outcome.issues.map(issue => issue.code).join(', ')}`);
  return {complete: true};
}

export function completionAt(dir) {
  const failurePath = join(dir, 'failure.json');
  if (existsSync(failurePath)) throw new Error(`Simulation failed: ${JSON.parse(readFileSync(failurePath, 'utf8')).error ?? 'see failure.json'}`);
  return completion(readGame(dir));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {

    console.log(JSON.stringify(completionAt(process.argv[2] ?? '/logs/sim')));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
