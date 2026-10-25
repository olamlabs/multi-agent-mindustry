import {readFileSync} from 'node:fs';

const COLORS=/\x1b\[[0-9;]*m/g;
const ENTRY=/^\[[^\]]*\] \[[A-Z]\] /;
const ERROR=/^\[[^\]]*\] \[E\] /;

export function exitReason(code,signal,log) {
  const lines=log.replace(COLORS,'').split('\n').map(line=>line.trimEnd());
  const at=lines.findLastIndex(line=>ERROR.test(line));
  let detail;
  if(at<0) detail=lines.filter(Boolean).slice(-5).join('\n');
  else {
    const after=lines.slice(at+1);
    const end=after.findIndex(line=>ENTRY.test(line));
    const cause=(end<0?after:after.slice(0,end)).find(line=>line.startsWith('Caused by: '));
    detail=[lines[at],cause].filter(Boolean).join('\n');
  }
  const how=code===null?`was killed by ${signal}`:`exited with code ${code}`;
  return `Mindustry server ${how}${detail?`: ${detail}`:''}`;
}

export function watchServer(proc,logPath) {
  const server={reason:null,closing:false};
  server.exit=new Promise(resolve=>proc.once('exit',(code,signal)=>{
    if(server.closing) return;
    server.reason=exitReason(code,signal,readFileSync(logPath,'utf8'));
    resolve(server.reason);
  }));
  return server;
}
