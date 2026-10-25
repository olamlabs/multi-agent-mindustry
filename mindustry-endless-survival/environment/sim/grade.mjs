import { gradeEndlessSurvival, SURVIVAL_SCHEMA } from './survival-grade.mjs';

export function isEndlessSurvival(setup) {
  return setup?.settings?.endless_survival !== undefined || setup?.benchmark?.schema_version === SURVIVAL_SCHEMA;
}

export function grade(input, options = {}) {
  const {setup, result} = input;
  if (result?.failure != null) throw new Error(`The match failed: ${result.failure}`);
  if (isEndlessSurvival(setup)) {
    const outcome = gradeEndlessSurvival(input, options);
    if (outcome.status !== 'valid') throw new Error(`Endless survival is unscored (${outcome.status}): ${outcome.issues.map(issue => issue.code).join(', ')}`);
    return {
      completed: 1, lobby_expired: 0, reward: outcome.reward_minutes,
      ...Object.fromEntries(setup.seats.map(seat => [seat, outcome.reward_minutes])),
      survival_seconds: outcome.score_seconds, survival_minutes: outcome.score_minutes, clearance: outcome.clearance_mean,
      clearance_minutes: outcome.clearance_minutes, time_limit_reached: 0,
      ...(Number.isSafeInteger(result.terminal.waves_completed) && result.terminal.waves_completed >= 0 ? {waves_completed: result.terminal.waves_completed} : {}),
    };
  }
  throw new Error('Only endless survival can be graded');
}
