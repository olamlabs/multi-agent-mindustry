import {readEnvironment} from '../sim/game-files.mjs';
import {assertBenchmarkSettings} from './contract.mjs';

const {settings, seats} = readEnvironment();
const fixed = assertBenchmarkSettings(settings, seats);

process.env.HARBOR_SIM_SETTINGS = JSON.stringify(fixed);
await import('../sim/main.mjs');
