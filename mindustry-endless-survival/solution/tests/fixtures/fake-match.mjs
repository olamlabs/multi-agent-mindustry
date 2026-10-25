import {EventEmitter} from 'node:events';
import {spawn} from 'node:child_process';
import {writeFileSync} from 'node:fs';
import {serveMindustry} from '../../../environment/sim/app.mjs';
import * as coordinator from '../../../environment/sim/seat-renderers.mjs';
import {NativeInputError} from '../../../environment/sim/native-error.mjs';

import {scriptedEvidence} from './survival-fixtures.mjs';
let receipt;
const heads=new Map();
let t=0,terminal=null,seats=[],settings={};
const status=seat=>({t,team:'sharded',you:{unit_id:seats.indexOf(seat)+1,type:'gamma',health:220,x:80,y:30,stack:{item:null,amount:0},mining:null},
  core:{id:1,health:4000,max_health:4000,items:{copper:300}},chat:heads.get(seat)?{seq:heads.get(seat),t,from:'seat-1',to:[],text:'fixture',data:null}:null,wake_head:heads.get(seat)});
const engine={
  async boot(){
    if(!process.env.FAKE_NATIVE_EXIT)return;
    this.proc=spawn(process.execPath,['-e',`const fs=require('node:fs');setInterval(()=>{if(fs.existsSync(process.env.SIM_LOGS+'/native-exit')){if(process.env.FAKE_NATIVE_EXIT==='SIGKILL')process.kill(process.pid,'SIGKILL');else process.exit(7);}},10);`],{stdio:'ignore'});
    this.exit=new Promise(resolve=>this.proc.once('exit',(code,signal)=>{this.dead=true;writeFileSync(process.env.SIM_LOGS+'/native-exited','');resolve(`Native fixture ${signal?'was killed by '+signal:'exited with code '+code}`);}));
  },
  async close(){this.proc?.kill('SIGTERM');},

  async tool(path,args={}) {
    try { return {result:await this.call(path,args),status:args.seat?status(args.seat):null}; }
    catch(error) { if(error instanceof NativeInputError&&args.seat) error.seatStatus=status(args.seat); throw error; }
  },
  async call(path,args={}) {
    if(this.dead)throw new Error('Native fixture is no longer running');
    if(path==='/setup'){

      const known=new Set(['seats','game_mode','team_count','team_size','team_sizes','time_limit_sec','seed','map','all_chat','video','save_interval_sec','endless_survival']);
      for(const key of Object.keys(args)) if(!known.has(key)) throw new NativeInputError('Unknown field '+key);
      ({seats}=args);const {seats:_seats,...nativeSettings}=args;settings=nativeSettings;receipt=scriptedEvidence(process.env.SIM_LOGS,settings,seats);seats.forEach(seat=>heads.set(seat,0));return {map:'fixture'};
    }
    if(path==='/start') {const {event:_event,...start}=receipt.input.start;return {clock:'running',survival_start:start};}
    if(path==='/stop') return {stopped:true};
    if(path==='/state'){t+=1;return {t,...(terminal?{terminal}:{})};}
    if(path==='/status') return status(args.seat);

    if(path==='/query'){if(args.of==='tanks')throw new NativeInputError('of: "tanks" is not one of collections, match, units',null,true);if(args.of==='broken')throw new Error('Native engine HTTP 500');return {rows:[{of:args.of,seat:args.seat}]};}
    if(path==='/events'){if(args.cursor==='taken')throw new NativeInputError('The reader "taken" already has another filter; use a different cursor name');return {entries:[],next:0};}
    if(path==='/say'){
      for(const seat of seats) if(seat!==args.seat) heads.set(seat,heads.get(seat)+1);
      if(args.text==='end the match'){receipt.save(true);terminal=receipt.input.terminal;}
      return {message:{from:args.seat,text:args.text,audience:args.audience??'team'}};
    }
    if(path==='/act') return {results:args.ops.map(op=>({ok:true,effect:op.op}))};
    return {path,seat:args.seat};
  },
};
const scripted={alwaysBoot:true,boot:async({signal,onListening})=>{if(process.env.FAKE_BOOT_BARRIER==='1'){
  writeFileSync(process.env.SIM_LOGS+'/camera-boot-waiting','');
  await new Promise((_,reject)=>{if(signal.aborted)reject(new Error('Camera boot aborted'));else signal.addEventListener('abort',()=>reject(new Error('Camera boot aborted')),{once:true});});
}if(process.env.FAKE_NO_CLIENTS==='1'){onListening();await new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(new Error('The lobby closed')),{once:true}));}return {};},start:async()=>{},stop:async()=>({type:'video',complete:true,layout:'fixture'}),close:async()=>{}};
const tunnel=()=>Object.assign(new EventEmitter(),{exitCode:null,signalCode:null,kill(signal){this.signalCode=signal;}});
const native={alwaysBoot:true,
  boot:options=>coordinator.bootRenderers({...options,controlHost:'127.0.0.1',controlPort:Number(process.env.FAKE_CONTROL_PORT),
    tunnelPort:Number(process.env.FAKE_TUNNEL_PORT),secretFile:process.env.FAKE_TUNNEL_SECRET_FILE,launchTunnel:tunnel}),
  start:coordinator.startVideo,stop:coordinator.stopVideo,close:coordinator.stopRenderers};
await serveMindustry({engine,renderer:process.env.FAKE_SEAT_PORTS==='1'?native:scripted});
