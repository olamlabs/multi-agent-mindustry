import {randomBytes} from 'node:crypto';
import {mkdirSync, writeFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {validateSettings, seatsFromRoster, resolveTeams, resolveCameras} from './settings.mjs';

export function prepareSeats(env = process.env) {
  const seats = JSON.parse(env.MINDUSTRY_SEATS ?? '[]');
  if (!Array.isArray(seats) || new Set(seats).size !== seats.length) throw Error('MINDUSTRY_SEATS must list distinct canonical seats');
  const canonical = seatsFromRoster(Object.fromEntries(seats.map(s => [s, {}])));
  const settings = validateSettings(JSON.parse(env.MINDUSTRY_SIM_SETTINGS ?? '{}'));
  resolveCameras(resolveTeams(settings, canonical), canonical);
  const tokens = {};
  for (const seat of canonical) {
    tokens[seat] = randomBytes(24).toString('hex');
    const folder = `${env.MINDUSTRY_SEAT_TOKENS ?? '/run/seat-tokens'}/${seat}`;
    mkdirSync(folder, {recursive: true});
    writeFileSync(`${folder}/token`, `${tokens[seat]}\n`, {mode: 0o644});
  }
  env.MINDUSTRY_SEAT_TOKEN_MAP = JSON.stringify(tokens);
  return {seats: canonical, settings};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  prepareSeats();
  await import('./main.mjs');
}
