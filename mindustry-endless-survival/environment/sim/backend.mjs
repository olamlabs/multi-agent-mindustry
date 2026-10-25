import {mkdirSync,appendFileSync} from 'node:fs';
import {join} from 'node:path';
import {writeJsonAtomic} from './atomic-json.mjs';
import {readNativeSurvival} from './survival-evidence.mjs';
import {buildSurvivalBenchmark} from './survival-contract.mjs';
import {resolveCameras,resolveTeams,seatsFromRoster,validateSettings} from './settings.mjs';
import {toolsFor,TOOL_NAMES} from './tools.mjs';
import {NativeInputError,NativeTransportError} from './native-error.mjs';

const EMPTY_STATUS={t:null,team:null,you:null,core:null,chat:null,wake_head:0};
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
export const ENDING='The match has ended and is recording its result; POST /wait returns once the game is over.';
const SUMMARY={
  setup:v=>`Mindustry ${v.settings.game_mode} with ${v.seats.length} seats`,
  started:()=>'The match started',
  act:v=>`${v.seat} acts (${v.arguments?.ops?.length??0} inputs)`,
  say:v=>`${v.seat} says: ${String(v.arguments?.text??'').slice(0,200)}`,
  video:v=>`Seat video ${v.complete?'finalized':'incomplete'}`,
  game_ended:v=>`The match ended: ${v.terminal?.reason}`,
  stopped:v=>`The match was stopped: ${v.reason}`,
  not_started:v=>`The match never started: ${v.reason}`,
  agent_ready:v=>`${v.seat} registered for the match`,
};

export class Backend {
  constructor({engine,renderer,evidence,roster,settings,log=()=>{},onChange=()=>{}}) {
    Object.assign(this,{engine,renderer,evidence,log,onChange});
    this.seats=seatsFromRoster(roster);
    this.settings=resolveCameras(resolveTeams(validateSettings(settings??{}),this.seats),this.seats);
    this.journal=[]; this.ready=false; this.started=false; this.complete=false;
    this.failure=null; this.state={}; this.preparation=new AbortController(); this.inflight=0; this.finishPromise=null;

    this.ended=false;
    mkdirSync(this.evidence,{recursive:true});
    if(this.settings.agent_ready_required) {
      this.agentReadiness={schema_version:'1.0',required:true,created_at:new Date().toISOString(),expected_seats:[...this.seats],
        acknowledgments:{},all_agents_ready_at:null,cameras_ready_at:null,native_start_requested_at:null,native_started_at:null,native_start:null,failure:null};
      this.saveReadiness();
    }
  }
  save(name,value) { writeJsonAtomic(join(this.evidence,name),value); }
  note(value) {
    const entry={sequence:this.journal.length+1,value};
    this.journal.push(entry); appendFileSync(join(this.evidence,'journal.jsonl'),JSON.stringify(entry)+'\n');
    this.log({...value,seat:value.seat??null,summary:SUMMARY[value.type]?.(value)??value.type});
  }
  seat(id) { if(!this.seats.includes(id)) throw new Error('Unknown seat'); return id; }
  fail(error,{nativeExit=false}={}) {
    if(this.failure===null||(nativeExit&&this.failureError instanceof NativeTransportError)){
      this.failure=String(error?.message??error);this.failureError=error;
    }
    this.save('failure.json',{error:this.failure});

    if(this.agentReadiness&&!this.agentReadiness.native_started_at) {
      this.agentReadiness.failure=this.failure;this.saveReadiness();
      this.preparation.abort();
    }
  }
  saveReadiness() {
    if(!this.agentReadiness) return;
    const ready_seats=this.seats.filter(seat=>Object.hasOwn(this.agentReadiness.acknowledgments,seat));
    const pending_seats=this.seats.filter(seat=>!Object.hasOwn(this.agentReadiness.acknowledgments,seat));
    const state=this.agentReadiness.failure?'failed':this.agentReadiness.native_started_at?'started':pending_seats.length?'waiting':'ready';
    this.save('agent-readiness.json',{...this.agentReadiness,state,ready_seats,pending_seats});
  }
  readinessFor(seat) {
    const registered=Object.hasOwn(this.agentReadiness.acknowledgments,seat);
    return {required:true,registered,ready_count:Object.keys(this.agentReadiness.acknowledgments).length,expected_count:this.seats.length};
  }
  registerReady(seat) {
    if(!Object.hasOwn(this.agentReadiness.acknowledgments,seat)) {
      const received_at=new Date().toISOString();
      this.note({type:'agent_ready',seat,received_at});
      this.agentReadiness.acknowledgments[seat]={received_at,journal_sequence:this.journal.length};
      if(Object.keys(this.agentReadiness.acknowledgments).length===this.seats.length) this.agentReadiness.all_agents_ready_at=received_at;
      this.saveReadiness();
      this.resolveAgentReadiness?.();
      this.onChange();
    }
    return this.readinessFor(seat);
  }
  async waitForAgentReadiness() {
    if(!this.agentReadiness||this.agentReadiness.all_agents_ready_at) return;
    await new Promise((resolve,reject)=>{
      const signal=this.preparation.signal;
      const cleanup=()=>{signal.removeEventListener('abort',aborted);this.resolveAgentReadiness=null;};
      const aborted=()=>{cleanup();reject(new Error(this.failure??this.abandoned??'Match preparation was stopped'));};
      this.resolveAgentReadiness=()=>{if(this.agentReadiness.all_agents_ready_at){cleanup();resolve();}};
      if(signal.aborted) aborted();
      else signal.addEventListener('abort',aborted,{once:true});
    });
  }

  phase() { return this.failure?'failed':this.complete?'over':this.finishPromise||this.ended?'ending':this.started?'running':this.abandoned?'not_started':'waiting'; }

  async boot() {
    await this.engine.boot();
    this.engine.exit?.then(reason=>{
      this.nativeExited=true;
      if(this.closing||this.complete||this.terminal) return;
      this.fail(new Error(reason),{nativeExit:true});
      this.preparation.abort();
      this.onChange();
    });

    const {lobby_sec:_lobby,agent_ready_required:_agentReady,wave_schedule_briefing:_briefing,...native}=this.settings;
    this.setup=await this.engine.call('/setup',{...native,seats:this.seats});
    if(this.settings.endless_survival) {
      const receipts=readNativeSurvival(this.evidence);
      if(receipts.evidence_read_errors.length) throw new Error(`Invalid native survival setup receipts: ${JSON.stringify(receipts.evidence_read_errors)}`);
      this.benchmark=buildSurvivalBenchmark({settings:this.settings,seats:this.seats,nativeSetup:receipts.nativeSetup});
    }
    this.note({type:'setup',settings:this.settings,seats:this.seats,engine:this.setup});
    this.save('setup.json',{settings:this.settings,seats:this.seats,engine:this.setup,...(this.benchmark?{benchmark:this.benchmark}:{})});

    if(!this.renderer.alwaysBoot && this.settings.video.seats.length!==this.seats.length) throw new Error('video.seats needs the per-seat game clients (--seat-clients)');
    if(this.settings.video.record || this.renderer.alwaysBoot) {

      let listening;const ports=new Promise(resolve=>{listening=resolve;});
      this.renderBoot=this.renderer.boot({evidence:this.evidence,video:this.settings.video,settings:this.settings,seats:this.seats,signal:this.preparation.signal,onListening:()=>listening()});
      this.renderBoot.then(handle=>{this.renderHandle=handle;},error=>{if(!this.preparation.signal.aborted){this.fail(error);this.onChange();}});
      await Promise.race([ports,this.renderBoot]);
    }
    this.ready=true;
  }

  start() {
    this.beginPromise??=(async()=>{
      try {
        if(this.renderBoot) this.renderHandle=await this.renderBoot;
        await this.waitForAgentReadiness();
        if(this.failure||this.preparation.signal.aborted) throw new Error(this.failure??'Match preparation was stopped');
        if(this.abandoned) throw new Error(this.abandoned);
        if(this.renderHandle) await this.renderer.start(this.renderHandle,this.settings.time_limit_sec);
        if(this.failure||this.preparation.signal.aborted) throw new Error(this.failure??'Match preparation was stopped');
        if(this.agentReadiness) {
          this.agentReadiness.cameras_ready_at=new Date().toISOString();
          this.agentReadiness.native_start_requested_at=new Date().toISOString();

          this.saveReadiness();
        }
        this.startingNative=true;
        const native=await this.engine.call('/start',this.settings.endless_survival?{ready_seats:this.seats}:{});
        this.note({type:'started',native});
        this.started=true;
        if(this.agentReadiness) {
          this.agentReadiness.native_started_at=new Date().toISOString();
          this.agentReadiness.native_start=native;
          this.saveReadiness();
        }
      } catch(error) {
        if(this.abandoned) this.note({type:'not_started',reason:this.abandoned});
        else this.fail(error);
      }
      this.onChange();
    })();
    return this.beginPromise;
  }

  abandon(reason) { if(this.started||this.startingNative||this.failure||this.abandoned) return false; this.abandoned=reason; this.preparation.abort(); return true; }
  async finish(terminal) {
    this.finishPromise??=(async()=>{
      try {
        this.terminal=terminal;
        const cleanup=async(stage,work)=>{
          try { return await work(); }
          catch(error) {
            if(!this.settings.endless_survival) throw error;

            const entry={stage,error:String(error?.message??error),after_native_terminal:true};
            (this.ancillaryErrors??=[]).push(entry);
            this.save('ancillary-errors.json',{schema_version:'1.0',errors:this.ancillaryErrors});
            this.note({type:'post_terminal_cleanup_failed',...entry});
            return null;
          }
        };

        await cleanup('engine_stop',()=>this.engine.call('/stop',{}));

        if(this.renderHandle) {
          const video=await cleanup('recording_finalization',()=>this.renderer.stop(this.renderHandle,terminal));
          this.note({type:'video',...(video??{complete:false,error:'Recording finalization failed; see ancillary-errors.json'})});
        }
        this.note({type:'game_ended',source:'mindustry',terminal});
        await cleanup('final_summary',()=>this.save('final-summary.json',{settings:this.settings,terminal,state:this.state}));
        this.complete=true;
      } catch(error) { this.fail(error); }
    })();
    return this.finishPromise;
  }

  async tick() {
    if(!this.started || this.complete || this.failure || this.finishPromise) return false;
    try {
      const state=await this.engine.call('/state');
      const changed=!same(state,this.state);
      this.state=state;
      if(state.terminal) {
        this.ended=true;
        if(this.inflight===0) await this.finish(state.terminal);
      }
      return changed;
    } catch(error) { this.fail(error); return true; }
  }

  async stop({reason}) {
    if(this.complete || this.finishPromise) return this.finishPromise;
    this.finishPromise=(async()=>{
      try {
        const stopped=await this.engine.call('/stop',{});

        if(this.settings.endless_survival&&this.started&&stopped?.terminal) this.stoppedTerminal=stopped.terminal;
      } catch(error) { console.error(`Native stop failed: ${error.message}`); }
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
    const view={phase:this.phase(),...rest};
    if(this.agentReadiness) view.readiness=this.readinessFor(seat);
    if(this.complete&&this.terminal){const {seat_teams:_teams,...result}=this.terminal;view.result=result;}
    return view;
  }

  async observe(seat) {
    this.seat(seat);
    let status=this.lastStatus?.get(seat)??EMPTY_STATUS;
    if(this.ready&&!this.failure&&!(this.nativeExited&&this.terminal)) {
      try { status=await this.engine.call('/status',{seat}); }
      catch(error) { if(!this.terminal||!(this.nativeExited||error instanceof NativeTransportError)) throw error; }
    }
    const shown=this.shown(seat,status);
    return {status:shown,wake_key:{phase:shown.phase,wake_head:status.wake_head}};
  }
  tools(seat) { this.seat(seat); return toolsFor(this.settings); }
  async call(seat,name,args) {
    this.seat(seat);
    const reject=error=>({ok:false,error});
    if(!TOOL_NAMES.includes(name)||(name==='ready'&&!this.agentReadiness)) return reject('Unknown tool');
    if(this.failure) return reject('The match failed');
    if(this.abandoned&&!this.started) return reject('The match never started');
    if(name==='ready') {
      if(this.complete||this.finishPromise||this.ended) return reject(ENDING);
      return {ok:true,result:this.registerReady(seat)};
    }
    if(!this.started && !['query','events'].includes(name)) return reject('The match has not started.');
    if(this.complete||this.finishPromise||this.ended) return reject(ENDING);
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
