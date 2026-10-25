import {spawn} from 'node:child_process';
import {mkdirSync,openSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {serveMindustry} from './app.mjs';
import {readEnvironment} from './game-files.mjs';
import {NativeInputError,NativeTransportError} from './native-error.mjs';
import {bootRenderers,startVideo,stopVideo,stopRenderers} from './renderer.mjs';
import * as seatRenderers from './seat-renderers.mjs';

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
const engine={
  async boot() {
    mkdirSync(join(runDir,'config/mods'),{recursive:true}); mkdirSync(join(runDir,'classes'),{recursive:true});
    const jar=process.env.MINDUSTRY_SERVER_JAR??'/opt/mindustry/server.jar';
    await exited(launch('plugin-compile','sh',[join(taskDir,'plugin/build.sh'),jar,join(runDir,'config/mods/harbor-bridge.jar')]),'plugin compile');

    this.proc=launch('mindustry-server','java',['-Xms256m','-XX:MaxRAMPercentage=75','-jar',jar],{env:{...process.env,MINDUSTRY_EVIDENCE_DIR:join(evidence,'engine')}});
    this.exit=new Promise(resolve=>this.proc.once('exit',(code,signal)=>resolve(`Mindustry server ${signal?`was killed by ${signal}`:`exited with code ${code}`}`)));

    for(;;) {
      if(this.proc.bootError||this.proc.exitCode!==null||this.proc.signalCode!==null) throw new Error('Mindustry server exited during startup');
      try { const result=await this.call('/health'); if(result.ready||result.ok) return; } catch {}
      await sleep(250);
    }
  },
  async call(path,data={}) { return (await this.tool(path,data)).result; },

  async tool(path,data={}) {
    const response=await fetch('http://127.0.0.1:8091'+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)}).catch(error=>{throw new NativeTransportError(error);});
    const reply=await response.json().catch(error=>{throw error instanceof TypeError?new NativeTransportError(error):error;});
    if(!response.ok) throw new Error(reply.error??`Native engine HTTP ${response.status}`);
    if(reply.ok===false) throw new NativeInputError(reply.error??'Native engine rejected the request',reply.status??null,reply.invalid===true);
    return {result:reply.result,status:reply.status??null};
  },
  async close(){for(const proc of processes) if(proc.exitCode===null) proc.kill('SIGTERM');}
};
const renderer=process.argv.includes('--seat-clients')
  ? {boot:seatRenderers.bootRenderers,start:seatRenderers.startVideo,stop:seatRenderers.stopVideo,close:seatRenderers.stopRenderers,alwaysBoot:true}
  : {boot:bootRenderers,start:startVideo,stop:stopVideo,close:stopRenderers};
await serveMindustry({engine,renderer,env});
