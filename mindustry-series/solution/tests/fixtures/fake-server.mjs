import {createServer} from 'node:http';
import {writeFileSync} from 'node:fs';

const E='\x1b';
const at=`${E}[1m${E}[90m[10-15-2026 01:51:18] ${E}[0m`;
const NPE='java.lang.NullPointerException: Cannot invoke "arc.math.geom.QuadTree$QuadTreeObject.hitbox(arc.math.geom.Rect)" because "t" is null';
const CRASH=[
  `${at}${E}[91m${E}[1m[E] java.lang.RuntimeException: java.util.concurrent.ExecutionException: ${NPE}`,
  '\tat mindustry.async.PhysicsProcess.begin(PhysicsProcess.java:62)',
  '\tat mindustry.async.AsyncCore.begin(AsyncCore.java:44)',
  `Caused by: java.util.concurrent.ExecutionException: ${NPE}`,
  '\tat java.base/java.util.concurrent.FutureTask.report(FutureTask.java:122)',
  '\t... 4 more',
  `Caused by: ${NPE}`,
  '\tat arc.math.geom.QuadTree.hitbox(QuadTree.java:387)',
  `${E}[0m`,
];

writeFileSync('server.pid',String(process.pid));
let t=0;
const status={t:0,team:'sharded',you:null,core:null,chat:null,wake_head:0};
const results={'/health':()=>({ready:true}),'/setup':()=>({map:'fixture',game:1}),'/start':()=>({clock:'running',game:1}),'/stop':()=>({stopped:true}),'/state':()=>({t:++t,game:1}),'/status':()=>status};
createServer((request,response)=>{
  let body='';
  request.on('data',chunk=>{body+=chunk;});
  request.on('end',()=>{
    const data=JSON.parse(body||'{}');
    if(request.url==='/say'&&data.text==='crash'){
      for(const line of CRASH)console.log(line);

      response.destroy();
      setTimeout(()=>process.exit(1),100);
      return;
    }
    response.setHeader('content-type','application/json');
    response.end(JSON.stringify({ok:true,result:(results[request.url]??(()=>({})))(),...(data.seat?{status}:{})}));
  });
}).listen(8091,'127.0.0.1',()=>{
  console.log(`${at}${E}[94m${E}[1m[I]${E}[0m Harbor native bridge for Mindustry 160.7 listening on loopback :8091${E}[0m`);
  console.log(`${at}${E}[94m${E}[1m[I]${E}[0m Server loaded. Type 'help' for help.${E}[0m`);
});
