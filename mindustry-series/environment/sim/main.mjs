import {spawn} from 'node:child_process';
import {mkdirSync,openSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {serveMindustry} from './app.mjs';
import {readEnvironment} from './game-files.mjs';
import {NativeInputError,NativeTransportError} from './native-error.mjs';
import {bootRenderers,startVideo,stopVideo,stopRenderers} from './renderer.mjs';
import * as seatRenderers from './seat-renderers.mjs';
import {validateReplay} from './replay-integrity.mjs';
import {watchServer} from './server-exit.mjs';

const taskDir=join(dirname(fileURLToPath(import.meta.url)),'..');
const env=readEnvironment();
const evidence=env.logs;
const runDir=process.env.MINDUSTRY_RUN_DIR??`/tmp/mindustry-${process.pid}`;
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const processes=[];
function launch(name,cmd,args,options={}) {
  const log=openSync(join(evidence,`${name}.log`),'a');
  const proc=spawn(cmd,args,{cwd:runDir,stdio:['pipe',log,log],...options});
  proc.on('error',error=>{proc.bootError=error;}); processes.push(proc); return proc;
}
async function exited(proc,name) {
  await new Promise((resolve,reject)=>{proc.once('exit',code=>code===0?resolve():reject(new Error(`${name} exited ${code}`)));proc.once('error',reject);});
}
const replayEnvironment=replay=>replay.record?{HARBOR_REPLAY_DIR:join(evidence,'replay'),HARBOR_REPLAY_SEGMENT_SEC:String(replay.segment_sec),HARBOR_REPLAY_KEYFRAME_SEC:String(replay.keyframe_sec)}:{};
const engine={
  async boot(settings) {
    mkdirSync(join(runDir,'config/mods'),{recursive:true}); mkdirSync(join(runDir,'classes'),{recursive:true});
    const jar=process.env.MINDUSTRY_SERVER_JAR??'/opt/mindustry/server.jar';
    await exited(launch('plugin-compile','sh',[join(taskDir,'plugin/build.sh'),jar,join(runDir,'config/mods/harbor-bridge.jar')]),'plugin compile');

    this.proc=launch('mindustry-server','java',['-Xms256m','-XX:MaxRAMPercentage=75',`-Xlog:gc:file=${join(evidence,'engine-gc.log')}:time,uptime`,'-jar',jar],{env:{...process.env,MINDUSTRY_EVIDENCE_DIR:join(evidence,'engine'),...replayEnvironment(settings.replay)}});
    this.server=watchServer(this.proc,join(evidence,'mindustry-server.log'));
    this.exit=this.server.exit;

    for(;;) {
      if(this.proc.bootError||this.server.reason) throw new Error(this.server.reason??'Mindustry server exited during startup');
      try { const result=await this.call('/health'); if(result.ready||result.ok) return; } catch {}
      await sleep(250);
    }
  },
  async call(path,data={}) {
    const result=(await this.tool(path,data)).result;
    if(path==='/finalize-replay') await validateReplay(join(evidence,'replay'));
    return result;
  },

  async tool(path,data={}) {
    const response=await fetch('http://127.0.0.1:8091'+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)}).catch(error=>{throw this.server.reason?new Error(this.server.reason):new NativeTransportError(error);});
    const reply=await response.json().catch(error=>{throw error instanceof TypeError?new NativeTransportError(error):error;});
    if(!response.ok) throw new Error(reply.error??`Native engine HTTP ${response.status}`);
    if(reply.ok===false) throw new NativeInputError(reply.error??'Native engine rejected the request',reply.status??null,reply.invalid===true);
    return {result:reply.result,status:reply.status??null};
  },
  async close(){if(this.server)this.server.closing=true;for(const proc of processes) if(proc.exitCode===null) proc.kill('SIGTERM');}
};
const renderer=process.argv.includes('--seat-clients')
  ? {boot:seatRenderers.bootRenderers,start:seatRenderers.startVideo,stop:seatRenderers.stopVideo,close:seatRenderers.stopRenderers,alwaysBoot:true}
  : {boot:bootRenderers,start:startVideo,stop:stopVideo,close:stopRenderers};
await serveMindustry({engine,renderer,env});
