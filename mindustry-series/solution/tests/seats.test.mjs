import test from 'node:test';
import assert from 'node:assert/strict';
import {cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync, spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {prepareSeats} from '../../environment/sim/seats.mjs';

const root=fileURLToPath(new URL('../..',import.meta.url));
test('Harbor Multiagent gets fresh per-seat tokens and validates before writing them',t=>{
  const dir=mkdtempSync(join(tmpdir(),'series-tokens-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const env={MINDUSTRY_SEATS:'["seat-1","seat-2"]',MINDUSTRY_SIM_SETTINGS:'{"games":1}',MINDUSTRY_SEAT_TOKENS:dir};
  prepareSeats(env);
  const tokens=JSON.parse(env.MINDUSTRY_SEAT_TOKEN_MAP);
  assert.notEqual(tokens['seat-1'],tokens['seat-2']);
  for(const seat of ['seat-1','seat-2']) assert.equal(readFileSync(join(dir,seat,'token'),'utf8').trim(),tokens[seat]);
  prepareSeats(env);
  assert.notEqual(JSON.parse(env.MINDUSTRY_SEAT_TOKEN_MAP)['seat-1'],tokens['seat-1']);
  const invalid={...env,MINDUSTRY_SIM_SETTINGS:'{"games":101}',MINDUSTRY_SEAT_TOKENS:join(dir,'invalid')};
  assert.throws(()=>prepareSeats(invalid),/1 to 100/);
  assert.equal(existsSync(invalid.MINDUSTRY_SEAT_TOKENS),false);
  for(const roster of ['[]','["seat-1","seat-1"]','["seat-2"]','["../other"]'])
    assert.throws(()=>prepareSeats({...env,MINDUSTRY_SEATS:roster}));
});

test('configuration round trips games 1 and 100, validates before mutation, and keeps seats and artifacts aligned',t=>{
  const dir=mkdtempSync(join(tmpdir(),'series-config-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  for(const path of ['scripts','environment/sim','config.json','task.toml','instruction.md'])
    cpSync(join(root,path),join(dir,path),{recursive:true});
  const configure=(...args)=>execFileSync('python3',[join(dir,'scripts/configure.py'),'--task',dir,...args],{stdio:'pipe'});
  for(const games of [1,100]) {
    configure('--games',String(games),'--seats','2');
    const compose=JSON.parse(readFileSync(join(dir,'environment/docker-compose.yaml')));
    assert.equal(JSON.parse(compose.services.main.environment.MINDUSTRY_SIM_SETTINGS).games,games);
    assert.equal(JSON.parse(compose.services.main.environment.MINDUSTRY_SIM_SETTINGS).map,'Ring Arena');
    assert.deepEqual(JSON.parse(compose.services.main.environment.MINDUSTRY_SEATS),['seat-1','seat-2']);
    const task=JSON.parse(execFileSync('python3',['-c','import json,sys,tomllib;print(json.dumps(tomllib.load(open(sys.argv[1],"rb"))))',join(dir,'task.toml')]));
    assert.deepEqual(Object.keys(task.agents),['seat-1','seat-2']);
    if(games===100) assert.ok(task.agent.timeout_sec>100*600+1800+300);
    assert.equal(task.environment.build_timeout_sec,3600);
    assert.equal(task.verifier.timeout_sec,600);
    assert.equal(task.verifier.collect[0].timeout_sec,task.agent.timeout_sec);
    assert.match(task.verifier.collect[0].command,/wait-for-series/);
    for(const seat of ['seat-1','seat-2']) {
      assert.deepEqual(compose.services[seat].volumes,[`${seat}-token:/run/mindustry:ro`]);
      const instruction=readFileSync(join(dir,`instructions/${seat}.md`),'utf8');
      assert.equal(instruction,readFileSync(join(dir,'instruction.md'),'utf8').replaceAll('{seat}',seat));
      assert.ok(instruction.startsWith(`You are ${seat},`));
      assert.equal(instruction.includes('{seat}'),false);
      assert.ok(instruction.includes('/run/mindustry/token'));
      assert.equal(compose.services[`${seat}-game`],undefined);
      assert.equal(task.artifacts.some(a=>a.service===`${seat}-game`),false);
    }
  }
  const before=readFileSync(join(dir,'config.json'),'utf8');
  for(const games of ['0','101','1.5']) {
    assert.notEqual(spawnSync('python3',[join(dir,'scripts/configure.py'),'--task',dir,'--games',games]).status,0);
    assert.equal(readFileSync(join(dir,'config.json'),'utf8'),before);
  }
  configure('--games','3','--seats','4');
  assert.equal(existsSync(join(dir,'instructions/seat-3.md')),true);
  configure('--games','3','--seats','2');
  assert.equal(existsSync(join(dir,'instructions/seat-3.md')),false);
  const compose=readFileSync(join(dir,'environment/docker-compose.yaml'),'utf8');
  configure();
  assert.equal(readFileSync(join(dir,'environment/docker-compose.yaml'),'utf8'),compose);
});

test('documented team, match-limit and game-count settings reach the runtime together',t=>{
  const dir=mkdtempSync(join(tmpdir(),'series-match-settings-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  for(const path of ['scripts','environment/sim','config.json','task.toml','instruction.md'])
    cpSync(join(root,path),join(dir,path),{recursive:true});
  const config=JSON.parse(readFileSync(join(dir,'config.json'),'utf8'));
  config.seats=10;
  Object.assign(config.settings,{map:'Ring Arena',team_count:2,team_size:5,games:1});
  for(const time_limit_sec of [1800,null]) {
    config.settings.time_limit_sec=time_limit_sec;
    writeFileSync(join(dir,'config.json'),JSON.stringify(config));
    execFileSync('python3',[join(dir,'scripts/configure.py'),'--task',dir]);
    const compose=JSON.parse(readFileSync(join(dir,'environment/docker-compose.yaml')));
    const settings=JSON.parse(compose.services.main.environment.MINDUSTRY_SIM_SETTINGS);
    assert.deepEqual(settings,{...config.settings,video:{...config.settings.video,seats:[]}});
    const roster=Array.from({length:10},(_,i)=>`seat-${i+1}`);
    assert.deepEqual(JSON.parse(compose.services.main.environment.MINDUSTRY_SEATS),roster);
    const task=JSON.parse(execFileSync('python3',['-c','import json,sys,tomllib;print(json.dumps(tomllib.load(open(sys.argv[1],"rb"))))',join(dir,'task.toml')]));
    assert.deepEqual(Object.keys(task.agents),roster);
    assert.equal(task.agent.timeout_sec,63000);
    assert.equal(task.verifier.collect[0].timeout_sec,63000);
    assert.equal(task.verifier.timeout_sec,600);
    assert.equal(task.environment.build_timeout_sec,3600);
  }
  config.settings.team_size=4;
  writeFileSync(join(dir,'config.json'),JSON.stringify(config));
  const before=readFileSync(join(dir,'environment/docker-compose.yaml'),'utf8');
  assert.notEqual(spawnSync('python3',[join(dir,'scripts/configure.py'),'--task',dir]).status,0);
  assert.equal(readFileSync(join(dir,'environment/docker-compose.yaml'),'utf8'),before);
});
