import {readFileSync} from 'node:fs';
const headers = {authorization: `Bearer ${readFileSync('/run/mindustry/token', 'utf8').trim()}`};
for (;;) {
  const response = await fetch(`${process.env.MINDUSTRY_SIM_URL}/update`, {headers});
  if (!response.ok) throw new Error(`Game API returned ${response.status}`);
  const state = await response.json();
  if (state.game_over) break;
  await new Promise(resolve => setTimeout(resolve, 1000));
}
