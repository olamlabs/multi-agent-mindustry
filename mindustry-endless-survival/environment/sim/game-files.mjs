import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { writeJsonAtomic } from './atomic-json.mjs';

export function readEnvironment(env = process.env) {
  const parse = (name, fallback) => {
    const text = env[name];
    if (text == null || text === '') {
      if (fallback !== undefined) return fallback;
      throw new Error(`${name} is not set`);
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`${name} is not JSON`);
    }
  };
  const seats = parse('MINDUSTRY_SEATS');
  if (!Array.isArray(seats) || seats.length === 0 || seats.some((seat) => typeof seat !== 'string' || !seat)) throw new Error('MINDUSTRY_SEATS must be a JSON list of seat names');
  if (new Set(seats).size !== seats.length) throw new Error('MINDUSTRY_SEATS names a seat twice');
  const tokens = parse('MINDUSTRY_SEAT_TOKEN_MAP');
  if (tokens == null || typeof tokens !== 'object' || seats.some((seat) => typeof tokens[seat] !== 'string' || !tokens[seat])) {
    throw new Error('MINDUSTRY_SEAT_TOKEN_MAP must give every seat a token');
  }
  const settings = parse('MINDUSTRY_SIM_SETTINGS', {});
  if (settings == null || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('MINDUSTRY_SIM_SETTINGS must be a JSON object');
  return {
    seats,
    tokens: Object.fromEntries(seats.map((seat) => [seat, tokens[seat]])),
    settings,
    port: Number(env.PORT ?? 8080),
    logs: env.SIM_LOGS ?? '/logs/sim',
  };
}

export function gameFiles(dir) {
  mkdirSync(dir, { recursive: true });
  let sequence = 0;
  let over = false;
  const save = (name, value) => writeJsonAtomic(join(dir, name), value);
  return {
    dir,

    append(entry) {
      sequence += 1;
      appendFileSync(join(dir, 'log.jsonl'), `${JSON.stringify({ sequence, time: new Date().toISOString(), ...entry })}\n`);
      return sequence;
    },
    save,

    finish(result) {
      save('result.json', result);
      over = true;
    },

    get over() {
      return over;
    },
  };
}
