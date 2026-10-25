import {randomBytes} from 'node:crypto';
import {mkdirSync, writeFileSync} from 'node:fs';

const seats = JSON.parse(process.env.HARBOR_SEATS ?? '[]');
if (!Array.isArray(seats) || seats.length === 0 || seats.some(seat => !/^seat-[1-9][0-9]*$/.test(seat)))
  throw new Error('HARBOR_SEATS must list the seats, seat-1 onwards');
const control = process.env.MINDUSTRY_CONTROL_DIR ?? '/run/mindustry-control';
mkdirSync(control, {recursive: true});
writeFileSync(`${control}/tunnel-secret`, randomBytes(32).toString('hex'), {mode: 0o600});
const tokens = {};
for (const seat of seats) {
  tokens[seat] = randomBytes(24).toString('hex');
  const folder = `${process.env.MINDUSTRY_SEAT_TOKENS ?? '/run/seat-tokens'}/${seat}`;
  mkdirSync(folder, {recursive: true});
  writeFileSync(`${folder}/token`, `${tokens[seat]}\n`, {mode: 0o644});
}
process.env.HARBOR_SEAT_TOKENS = JSON.stringify(tokens);
await import('./launch.mjs');
