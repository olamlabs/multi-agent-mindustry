import {spawn} from 'node:child_process';
import {writeFileSync} from 'node:fs';
import {serveMindustry} from '../../../environment/sim/app.mjs';
import * as coordinator from '../../../environment/sim/seat-renderers.mjs';
import {NativeInputError} from '../../../environment/sim/native-error.mjs';

const heads=new Map();
let t=0,terminal=null,seats=[],settings={},game=0;
const team=seat=>seats.indexOf(seat)<seats.length/2?'sharded':'crux';
const teams=()=>Object.fromEntries(seats.map(s=>[s,team(s)]));
const cores=()=>Object.fromEntries(['sharded','crux'].map(t=>[t,{health:4000,max_health:4000}]));
const status=seat=>({t,team:team(seat),you:{unit_id:seats.indexOf(seat)+1,type:'gamma',health:220,x:80,y:30,stack:{item:null,amount:0},mining:null},
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

      const known=new Set(['seats','game_mode','team_count','team_size','team_sizes','time_limit_sec','seed','map','all_chat','video','save_interval_sec']);
      for(const key of Object.keys(args)) if(!known.has(key)) throw new NativeInputError('Unknown field '+key);
      ({seats}=args);settings=args;game=1;seats.forEach(seat=>heads.set(seat,0));return {configured:true,seed:settings.seed,map:settings.map??'Glacier',game,game_mode:settings.game_mode,time_limit_sec:settings.time_limit_sec,seat_teams:teams(),cores:Object.entries(cores()).map(([team,core])=>({team,...core}))};
    }
    if(path==='/start') return {clock:'running',game};
    if(path==='/stop') return {stopped:true};
    if(path==='/reset'){
      if(!terminal) throw new NativeInputError('The game has not ended');
      await new Promise(resolve=>setTimeout(resolve,Number(process.env.FAKE_RESET_MS??0)));

      game+=1;terminal=null;t=0;seats.forEach(seat=>heads.set(seat,0));return {game,started:false};
    }
    if(path==='/state'){t+=1;return {t,game,...(terminal?{terminal}:{})};}
    if(path==='/status') return status(args.seat);

    if(path==='/query'){if(args.of==='tanks')throw new NativeInputError('of: "tanks" is not one of collections, match, units',null,true);if(args.of==='broken')throw new Error('Native engine HTTP 500');return {rows:[{of:args.of,seat:args.seat}]};}
    if(path==='/events'){if(args.cursor==='taken')throw new NativeInputError('The reader "taken" already has another filter; use a different cursor name');return {entries:[],next:0};}
    if(path==='/say'){

      for(const seat of seats) if(args.audience==='self'?seat===args.seat:seat!==args.seat&&(args.audience==='all'||team(seat)===team(args.seat))) heads.set(seat,heads.get(seat)+1);
      if(args.text==='end the game') terminal={game,reason:'time_limit',elapsed_seconds:settings.time_limit_sec,waves_completed:0,wave:1,survival_censored:true,core_health_by_team:cores(),winning_team:null,seat_teams:teams()};
      return {message:{game,from:args.seat,text:args.text,audience:args.audience??'team'}};
    }
    if(path==='/act') return {results:args.ops.map(op=>({ok:true,effect:op.op}))};
    return {path,seat:args.seat};
  },
};
const scripted={alwaysBoot:true,boot:async({signal,onListening})=>{if(process.env.FAKE_BOOT_BARRIER==='1'){
  writeFileSync(process.env.SIM_LOGS+'/camera-boot-waiting','');
  await new Promise((_,reject)=>{if(signal.aborted)reject(new Error('Camera boot aborted'));else signal.addEventListener('abort',()=>reject(new Error('Camera boot aborted')),{once:true});});
}if(process.env.FAKE_NO_CLIENTS==='1'){onListening();await new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(new Error('The lobby closed')),{once:true}));}return {};},start:async()=>{},stop:async()=>({type:'video',complete:true,layout:'fixture'}),close:async()=>{}};
const native={alwaysBoot:true,
  boot:options=>coordinator.bootRenderers({...options,controlHost:'127.0.0.1',controlPort:Number(process.env.FAKE_CONTROL_PORT)}),
  start:coordinator.startVideo,stop:coordinator.stopVideo,close:coordinator.stopRenderers};
await serveMindustry({engine,renderer:process.env.FAKE_SEAT_PORTS==='1'?native:scripted});
