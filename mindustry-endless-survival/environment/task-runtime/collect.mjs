import {existsSync} from 'node:fs';
while (!existsSync('/logs/sim/result.json') && !existsSync('/logs/sim/failure.json')) {
  await new Promise(resolve=>setTimeout(resolve,1000));
}
