import {mkdirSync,writeFileSync,appendFileSync} from 'node:fs';
import {join} from 'node:path';
import {resolveCameras,resolveTeams,seatsFromRoster,validateSettings} from './settings.mjs';
import {toolsFor,TOOL_NAMES} from './tools.mjs';
import {NativeInputError,NativeTransportError} from './native-error.mjs';

const EMPTY_STATUS={t:null,team:null,you:null,core:null,chat:null,wake_head:0};
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);

export const ending=games=>games===1
  ? 'The game has ended and its result is being recorded; POST /wait returns once that is done.'
  : `Game ${games} of ${games}, the last, has ended and its result is being recorded; POST /wait returns once that is done.`;

export const chatOpen=until=>`The series is over, so act applies no inputs. Team chat (say) stays open until ${until}; then every request answers game_over: true.`;
const clock=ms=>new Date(ms).toISOString().replace(/\.\d{3}Z$/,'Z');

export const restarting=(ended,games)=>`Game ${ended} of ${games} has ended. Game ${ended+1} is starting on the same map, with the same teammates and opponents; POST /wait returns once it is running.`;
const SUMMARY={
  setup:v=>`Mindustry ${v.settings.game_mode}, ${v.settings.games} games, with ${v.seats.length} seats`,
  started:v=>`Game ${v.game} started`,
  act:v=>`${v.seat} acts (${v.arguments?.ops?.length??0} inputs)`,
  say:v=>`${v.seat} says: ${String(v.arguments?.text??'').slice(0,200)}`,
  video:v=>`Seat video ${v.complete?'finalized':'incomplete'}`,
  game_ended:v=>`Game ${v.game} ended: ${v.terminal?.reason}`,
  stopped:v=>`The match was stopped: ${v.reason}`,
  not_started:v=>`The match never started: ${v.reason}`,
};

export class Backend {
  constructor({engine,renderer,evidence,roster,settings,log=()=>{},onChange=()=>{}}) {
    Object.assign(this,{engine,renderer,evidence,log,onChange});
    this.seats=seatsFromRoster(roster);
    this.settings=resolveCameras(resolveTeams(validateSettings(settings??{}),this.seats),this.seats);

    this.agentReady=new Set(); this.agentsReady=new Promise(resolve=>{this.releaseAgents=resolve;});
    this.sequence=0; this.ready=false; this.started=false; this.complete=false;

    this.game=1; this.results=[]; this.restarting=false; this.nextPromise=null; this.ended=false; this.chatUntil=null;
    this.failure=null; this.state={}; this.preparation=new AbortController(); this.inflight=0; this.finishPromise=null;
    mkdirSync(this.evidence,{recursive:true});
  }
  save(name,value) { writeFileSync(join(this.evidence,name),JSON.stringify(value,null,2)+'\n'); }
  note(value) {
    const entry={sequence:++this.sequence,value};
    appendFileSync(join(this.evidence,'journal.jsonl'),JSON.stringify(entry)+'\n');
    this.log({...value,seat:value.seat??null,summary:SUMMARY[value.type]?.(value)??value.type});
  }
  seat(id) { if(!this.seats.includes(id)) throw new Error('Unknown seat'); return id; }
  fail(error,{nativeExit=false}={}) {
    if(this.failure===null||(nativeExit&&this.failureError instanceof NativeTransportError)){
      this.failure=String(error?.message??error);this.failureError=error;
    }
    this.save('failure.json',{error:this.failure});
  }

  phase() {
    if(this.failure) return 'failed';
    if(this.complete) return 'over';
    if(this.chatUntil!=null) return 'chat';
    if(this.finishPromise) return 'ending';
    if(this.restarting) return 'restarting';
    if(this.ended) return this.game<this.settings.games?'restarting':'ending';
    return this.started?'running':this.abandoned?'not_started':'waiting';
  }

  async boot() {
    await this.engine.boot(this.settings);
    this.engine.exit?.then(reason=>{
      this.nativeExited=true;
      if(this.closing||this.complete) return;
      this.fail(new Error(reason),{nativeExit:true});
      this.releaseAgents();
      this.preparation.abort();
      this.onChange();
    });

    const {lobby_sec:_lobby,games:_games,chat_after_sec:_chat,replay:_replay,...native}=this.settings;
    this.setup=await this.engine.call('/setup',{...native,seats:this.seats});
    this.note({type:'setup',settings:this.settings,seats:this.seats,engine:this.setup});
    this.save('setup.json',{settings:this.settings,seats:this.seats,engine:this.setup});

    if(!this.renderer.alwaysBoot && this.settings.video.seats.length!==this.seats.length) throw new Error('video.seats needs the per-seat game clients (--seat-clients)');
    if(this.settings.video.record || this.renderer.alwaysBoot) {

      let listening;const ports=new Promise(resolve=>{listening=resolve;});
      this.renderBoot=this.renderer.boot({evidence:this.evidence,video:this.settings.video,settings:this.settings,seats:this.seats,signal:this.preparation.signal,onListening:()=>listening()});
      this.renderBoot.then(handle=>{this.renderHandle=handle;},error=>{if(!this.preparation.signal.aborted){this.fail(error);this.onChange();}});
      await Promise.race([ports,this.renderBoot]);
    }
    this.ready=true;
  }

  agentArrived(seat) {
    this.seat(seat);
    if(this.agentReady.has(seat)) return;
    this.agentReady.add(seat);
    this.note({type:'agent_ready',seat,at:new Date().toISOString()});
    if(this.agentReady.size===this.seats.length) {
      this.note({type:'all_agents_ready',at:new Date().toISOString()});
      this.releaseAgents();
    }
  }
  start() {
    this.beginPromise??=(async()=>{
      try {
        await this.agentsReady;
        if(this.renderBoot) this.renderHandle=await this.renderBoot;
        if(this.failure||this.preparation.signal.aborted) throw new Error(this.failure??'Match preparation was stopped');
        if(this.abandoned) throw new Error(this.abandoned);
        if(this.renderHandle) await this.renderer.start(this.renderHandle,this.settings.time_limit_sec);
        this.note({type:'started',game:this.game,at:new Date().toISOString(),native:await this.engine.call('/start',{})});
        this.started=true;
      } catch(error) {
        if(this.abandoned) this.note({type:'not_started',reason:this.abandoned});
        else this.fail(error);
      }
      this.onChange();
    })();
    return this.beginPromise;
  }

  abandon(reason) { if(this.started||this.failure||this.abandoned) return false; this.abandoned=reason; this.releaseAgents(); this.preparation.abort(); return true; }
  async finish(terminal) {
    this.finishPromise??=(async()=>{
      try {
        this.terminal=terminal;

        await this.engine.call('/stop',{});
        if(this.settings.replay.record) await this.engine.call('/finalize-replay',{});

        if(this.renderHandle) this.note({type:'video',...await this.renderer.stop(this.renderHandle,terminal)});
        this.note({type:'game_ended',game:this.game,source:'mindustry',terminal,app_memory:process.memoryUsage()});
        this.save('final-summary.json',{settings:this.settings,results:this.results,state:this.state});

        if(this.settings.chat_after_sec>0) this.chatUntil=Date.now()+this.settings.chat_after_sec*1000;
        else this.complete=true;
      } catch(error) { this.fail(error); }
      this.onChange();
    })();
    return this.finishPromise;
  }

  async next(terminal) {
    this.restarting=true;
    try {
      this.note({type:'game_ended',game:this.game,source:'mindustry',terminal,app_memory:process.memoryUsage()});
      this.game+=1; this.ended=false;

      this.onChange();
      const native=await this.engine.call('/reset',{});
      if(native.game!==this.game) throw new Error(`The engine reset to game ${native.game}, not game ${this.game}`);
      this.note({type:'started',game:this.game,at:new Date().toISOString(),native:await this.engine.call('/start',{})});
    } catch(error) { this.fail(error); }
    finally { this.restarting=false; }
  }

  async tick() {
    if(this.chatUntil!=null && !this.complete && !this.failure && Date.now()>=this.chatUntil) {
      this.complete=true;
      this.onChange();
      return false;
    }
    if(!this.started || this.complete || this.failure || this.finishPromise || this.restarting) return false;
    try {
      const state=await this.engine.call('/state');
      const changed=!same(state,this.state);
      this.state=state;
      if(state.terminal) {
        if(state.terminal.game!==this.game) throw new Error(`The engine ended game ${state.terminal.game} while the series is on game ${this.game}`);
        if(!this.ended) { this.ended=true; this.results.push(state.terminal); }
        if(this.inflight===0) {
          if(this.game<this.settings.games) await (this.nextPromise=this.next(state.terminal));
          else await this.finish(state.terminal);
        }
      }
      return changed;
    } catch(error) { this.fail(error); return true; }
  }

  async stop({reason}) {

    await this.nextPromise;
    if(this.complete || this.finishPromise) {
      await this.finishPromise;

      if(this.chatUntil!=null) this.complete=true;
      return;
    }
    this.finishPromise=(async()=>{
      try { await this.engine.call('/stop',{}); } catch(error) { console.error(`Native stop failed: ${error.message}`); }
      if(this.renderHandle) {
        try { this.note({type:'video',...await this.renderer.stop(this.renderHandle,this.state?.terminal??{})}); }
        catch(error) { console.error(`Recording stop failed: ${error.message}`); }
      }
      this.note({type:'stopped',reason});
    })();
    return this.finishPromise;
  }
  status() { return this.failure?'failed':this.complete?'completed':this.abandoned&&!this.started?'not_started':'running'; }

  shown(seat,status) {
    (this.lastStatus??=new Map()).set(seat,status);
    const {wake_head:_wake,...rest}=status;
    const phase=this.phase();

    const view={phase,game:{number:this.ended&&this.game<this.settings.games?this.game+1:this.game,of:this.settings.games},...rest};
    if(this.results.length) view.results=this.results.map(({seat_teams:_teams,...result})=>result);
    if(phase==='chat') view.chat_open_until=clock(this.chatUntil);
    return view;
  }

  async observe(seat) {
    this.seat(seat);
    let status=this.lastStatus?.get(seat)??EMPTY_STATUS;
    if(this.ready&&!this.failure&&!(this.nativeExited&&this.complete)) {
      try { status=await this.engine.call('/status',{seat}); }
      catch(error) {
        if(!this.complete||!(this.nativeExited||error instanceof NativeTransportError)) {
          this.fail(error); this.onChange(); throw error;
        }
      }
    }
    const shown=this.shown(seat,status);
    return {status:shown,wake_key:{game:shown.game.number,phase:shown.phase,wake_head:status.wake_head}};
  }
  tools(seat) { this.seat(seat); return toolsFor(this.settings); }
  async call(seat,name,args) {
    this.seat(seat);
    const reject=error=>({ok:false,error});
    if(!TOOL_NAMES.includes(name)) return reject('Unknown tool');
    if(this.failure) return reject('The match failed');
    if(this.abandoned&&!this.started) return reject('The match never started');
    if(!this.started && !['query','events'].includes(name)) return reject('The match has not started.');
    if(this.complete) return reject('The series is over.');

    if(this.chatUntil!=null) { if(name==='act') return reject(chatOpen(clock(this.chatUntil))); }
    else if(this.finishPromise||this.ended&&this.game===this.settings.games) return reject(ending(this.settings.games));
    else if(this.restarting||this.ended) return reject(restarting(this.ended?this.game:this.game-1,this.settings.games));
    this.inflight++;
    try {
      const {result,status}=await this.engine.tool('/'+name,{...(args??{}),seat});
      if(name==='act'||name==='say') this.note({type:name,seat,arguments:args,result});
      return {ok:true,result,status:status&&this.shown(seat,status)};
    } catch(error) {

      if(error instanceof NativeInputError) return {ok:false,error:error.message,invalid:error.invalid,status:error.seatStatus&&this.shown(seat,error.seatStatus)};

      this.fail(error);
      throw error;
    } finally { this.inflight--; }
  }
  async close() {
    this.closing=true;
    this.preparation.abort();
    await this.engine.close();
    if(this.renderHandle) await this.renderer.close(this.renderHandle);
  }
}
