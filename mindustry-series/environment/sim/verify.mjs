import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { grade } from './grade.mjs';

export function readGame(dir) {
  const read = (name) => (existsSync(join(dir, name)) ? JSON.parse(readFileSync(join(dir, name), 'utf8')) : null);
  return { setup: read('setup.json'), result: read('result.json') };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dir = process.argv[2] ?? '/logs/sim';
  const out = process.argv[3] ?? '/logs/verifier/reward.json';
  const summary = join(dirname(out), 'series.json');
  for(const path of [out, summary, out+'.tmp', summary+'.tmp']) rmSync(path,{force:true});
  mkdirSync(dirname(out), { recursive: true });
  const validity=join(dirname(out),'validity.json');
  rmSync(validity,{force:true});
  try {
    const { reward, series } = grade({...readGame(dir), expected: process.env.MINDUSTRY_SEATS && process.env.MINDUSTRY_SIM_SETTINGS ? {seats:JSON.parse(process.env.MINDUSTRY_SEATS),settings:JSON.parse(process.env.MINDUSTRY_SIM_SETTINGS)} : null});
    writeFileSync(summary+'.tmp', `${JSON.stringify(series, null, 2)}\n`);
    renameSync(summary+'.tmp',summary);
    writeFileSync(out+'.tmp', `${JSON.stringify(reward, null, 2)}\n`);
    renameSync(out+'.tmp',out);
    console.log(JSON.stringify(series));
    writeFileSync(validity, JSON.stringify({status:'valid',scored:true})+'\n');
  } catch(error) {

    rmSync(out,{force:true});rmSync(summary,{force:true});
    writeFileSync(validity, JSON.stringify({status:'infrastructure_invalid',scored:false,reason:error.message})+'\n');
    throw error;
  }

}
