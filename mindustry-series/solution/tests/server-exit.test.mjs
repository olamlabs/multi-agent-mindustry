import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {chmodSync,mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {startApp} from './app-process.mjs';

const main=fileURLToPath(new URL('../../environment/sim/main.mjs',import.meta.url));
const server=fileURLToPath(new URL('./fixtures/fake-server.mjs',import.meta.url));
const verify=fileURLToPath(new URL('../../environment/sim/verify.mjs',import.meta.url));
const seats=['seat-1','seat-2'];
const settings={game_mode:'pvp',time_limit_sec:600,seed:1,games:1,chat_after_sec:0,video:{record:false}};
const NPE='Cannot invoke "arc.math.geom.QuadTree$QuadTreeObject.hitbox(arc.math.geom.Rect)" because "t" is null';

async function open(t) {
  const bin=mkdtempSync(join(tmpdir(),'fake-jdk-'));
  const tool=(name,body)=>{writeFileSync(join(bin,name),`#!/bin/sh\n${body}\n`);chmodSync(join(bin,name),0o755);};
  tool('java',`exec "${process.execPath}" "${server}"`);
  tool('javac','exit 0');
  tool('jar','exit 0');
  const run=mkdtempSync(join(tmpdir(),'mindustry-run-'));
  const app=await startApp({main,seats,settings,env:{PATH:`${bin}:${process.env.PATH}`,MINDUSTRY_RUN_DIR:run}});
  t.after(()=>app.stop());
  await app.until(()=>app.healthy(),{what:'health'});
  await Promise.all(seats.map(s=>app.seat(s).get('/brief')));
  await app.until(async()=>(await app.seat('seat-1').get('/update')).status.phase==='running',{what:'the match clock'});
  return {app,run};
}
async function recorded(app,expected) {
  const failure=()=>JSON.parse(app.file('failure.json')??'{}').error;
  await app.until(()=>failure()===expected&&JSON.parse(app.file('result.json')??'{}').failure===expected,{what:expected});
  assert.equal((await app.request('/health')).status,503,'Harbor sees the simulation unhealthy and fails the trial');
  const out=join(mkdtempSync(join(tmpdir(),'reward-')),'reward.json');
  assert.throws(()=>execFileSync(process.execPath,[verify,app.logs,out],{stdio:'pipe'}),error=>String(error.stderr).includes(`The match failed: ${expected}`));
}

test('a server that crashes mid-series fails it with its exit code and the error its log ends on',async t=>{
  const {app}=await open(t);
  const said=await app.seat('seat-1').request('/say',{method:'POST',body:{text:'crash'}});
  assert.equal(said.status,500);
  await recorded(app,`Mindustry server exited with code 1: [10-15-2026 01:51:18] [E] java.lang.RuntimeException: java.util.concurrent.ExecutionException: java.lang.NullPointerException: ${NPE}\nCaused by: java.util.concurrent.ExecutionException: java.lang.NullPointerException: ${NPE}`);
});

test('a server killed without an error line fails the series with the signal and the last lines of its log',async t=>{
  const {app,run}=await open(t);
  process.kill(Number(readFileSync(join(run,'server.pid'),'utf8')),'SIGKILL');
  await recorded(app,"Mindustry server was killed by SIGKILL: [10-15-2026 01:51:18] [I] Agent bridge for Mindustry 160.7 listening on loopback :8091\n[10-15-2026 01:51:18] [I] Server loaded. Type 'help' for help.");
});
