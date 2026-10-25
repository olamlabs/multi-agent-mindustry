import {readFileSync} from 'node:fs';
import {isDeepStrictEqual} from 'node:util';
import {validateSettings, resolveTeams, seatsFromRoster} from '../sim/settings.mjs';

export const contract = JSON.parse(readFileSync(new URL('./contract.json', import.meta.url), 'utf8'));

export const LAUNCH_SETTINGS = Object.freeze(['wave_schedule_briefing']);

export function assertBenchmarkSettings(settings, seats) {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('Invalid benchmark settings');
  const [low, high] = contract.seat_range;
  const canonical = seatsFromRoster(Object.fromEntries(seats.map(seat => [seat, {}])));
  if (seats.length < low || seats.length > high || !isDeepStrictEqual(seats, canonical)) {
    throw new Error(`Survival requires ordered seat-1 through seat-N, exactly once, with N from ${low} to ${high}`);
  }
  const chosen = Object.fromEntries(LAUNCH_SETTINGS.filter(key => Object.hasOwn(settings, key)).map(key => [key, settings[key]]));
  const fixed = Object.fromEntries(Object.entries(settings).filter(([key]) => !LAUNCH_SETTINGS.includes(key)));
  const expected = resolveTeams(validateSettings(contract.settings), seats);
  const actual = resolveTeams(validateSettings({...contract.settings, ...fixed}), seats);
  if (!isDeepStrictEqual(actual, expected)) {
    const changed = Object.keys({...expected, ...actual}).filter(key => !isDeepStrictEqual(actual[key], expected[key]));
    throw new Error(`Fixed survival settings changed: ${changed.join(', ')}. Use a new version.`);
  }
  return resolveTeams(validateSettings({...contract.settings, ...fixed, ...chosen}), seats);
}
