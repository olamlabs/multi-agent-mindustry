import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {header,options,refusal,segments} from '../../environment/render-recording/render.mjs';

const task=fileURLToPath(new URL('../..',import.meta.url));
const work=mkdtempSync(join(tmpdir(),'replay-format-'));
execFileSync('javac',['--release','17','-d',join(work,'classes'),join(task,'environment/plugin/src/agentbridge/ReplayFormat.java'),join(task,'solution/tests/fixtures/ReplayFormatCheck.java')]);
const run=(...args)=>execFileSync('java',['-cp',join(work,'classes'),'ReplayFormatCheck',...args],{encoding:'utf8',maxBuffer:1<<26}).trim().split('\n').map(line=>JSON.parse(line));
const read=file=>{const lines=run('read',file);return {header:lines[0].header,records:lines.slice(1,-1),cutShort:lines.at(-1).cut_short};};

test('native replay orders segments numerically across digit boundaries',()=>{
  const dir=mkdtempSync(join(tmpdir(),'replay-order-'));
  for(const n of [1001,999,998,1000,1,10,9])writeFileSync(join(dir,`segment-${String(n).padStart(3,'0')}.mreplay`),'');
  writeFileSync(join(dir,'notes.mreplay'),'');
  const names=run('segments',dir);
  assert.deepEqual(names,['segment-001.mreplay','segment-009.mreplay','segment-010.mreplay','segment-998.mreplay','segment-999.mreplay','segment-1000.mreplay','segment-1001.mreplay']);
  assert.deepEqual(names,segments(dir).map(p=>p.split('/').at(-1)));
});

test('a closed segment reads back every record it was given, in order',()=>{
  const file=join(work,'segment-000.mreplay');
  const written=run('write',file,'300','closed');
  const back=read(file);
  assert.deepEqual(back.header,{format:'mindustry-replay/1',segment:0});
  assert.deepEqual(back.records,written);
  assert.equal(back.cutShort,null);
  assert.ok(written.some(r=>r.bytes===200000)&&written.some(r=>r.kind===2)&&written.some(r=>r.kind===3));
});

test('a segment still being written, or cut anywhere, reads up to its last complete record and says it was cut',()=>{
  const open=join(work,'open.mreplay');
  const written=run('write',open,'300','open');
  const live=read(open);
  assert.deepEqual(live.records,written,'every record flushed before the writer stopped');
  assert.equal(live.cutShort,true);
  const closed=join(work,'segment-000.mreplay');
  const whole=readFileSync(closed);
  const headerEnd=12+whole.readUInt32BE(8);
  let previous=-1;
  for(const at of [headerEnd+10,headerEnd+500,Math.floor(whole.length/4),Math.floor(whole.length/2),whole.length-9,whole.length-1]){
    const cut=join(work,`cut-${at}.mreplay`);
    writeFileSync(cut,whole.subarray(0,at));
    const back=read(cut);
    assert.equal(back.cutShort,true,`cut at ${at}`);
    assert.deepEqual(back.records,written.slice(0,back.records.length),`cut at ${at} gives a prefix`);
    assert.ok(back.records.length>=previous,'a longer file never reads fewer records');
    previous=back.records.length;
  }
  assert.ok(previous>=written.length-1,'cutting only the gzip trailer loses at most the last record');
});

test('the render script reads segment headers and refuses a recording this image cannot play, in plain words',()=>{
  const dir=mkdtempSync(join(tmpdir(),'replay-headers-'));
  const made={format:'mindustry-replay/1',mindustry:{build:160,revision:7,type:'official',server_jar_sha256:'a'.repeat(64)},mods:[{name:'agent-bridge',version:'0.1.0',hidden:true,sha256:'b'.repeat(64)}],started_unix_ms:1,segment:0};
  const segment=(name,value)=>{const json=Buffer.from(JSON.stringify(value));const head=Buffer.alloc(12);head.write('MREPLAY1',0,'ascii');head.writeUInt32BE(json.length,8);writeFileSync(join(dir,name),Buffer.concat([head,json,Buffer.from([0x1f,0x8b])]));};
  segment('segment-001.mreplay',{...made,segment:1});
  segment('segment-000.mreplay',made);
  writeFileSync(join(dir,'stats.json'),'{}');
  const files=segments(dir);
  assert.deepEqual(files.map(file=>file.split('/').at(-1)),['segment-000.mreplay','segment-001.mreplay']);
  const headers=files.map(header);
  assert.deepEqual(headers[0],made);
  assert.equal(refusal(headers,'/opt/mindustry/server.jar','a'.repeat(64)),null);
  assert.equal(refusal(headers,'/opt/mindustry/server.jar','c'.repeat(64)),`The recording was made by Mindustry 160.7 (official) with a server jar whose SHA-256 is ${'a'.repeat(64)}; /opt/mindustry/server.jar here has ${'c'.repeat(64)}. Render it in the game image the recording was made with.`);
  assert.match(refusal([{...made,mods:[...made.mods,{name:'flowers',version:'2',hidden:false}]}],'s','a'.repeat(64)),/content mods flowers 2; this renderer loads only its viewer mod/);
  assert.match(refusal([made,{...made,started_unix_ms:2}],'s','a'.repeat(64)),/more than one recording/);
  assert.match(refusal([{...made,format:'mindustry-replay/2'}],'s','a'.repeat(64)),/format is mindustry-replay\/2/);
  segment('segment-999.mreplay',{...made,segment:999});
  segment('segment-1000.mreplay',{...made,segment:1000});
  assert.deepEqual(segments(dir).slice(-2).map(p=>p.split('/').at(-1)),['segment-999.mreplay','segment-1000.mreplay']);
  writeFileSync(join(dir,'segment-002.mreplay'),'not a replay');
  assert.throws(()=>header(join(dir,'segment-002.mreplay')),/is not a Mindustry replay segment/);
});

test('the render script checks its options',()=>{
  const run=options(['--replay','/r','--out','/o','--seats','seat-1,seat-17','--at','160,80','--from','60','--to','120','--client-fps','30','--video-fps','10','--size','1280x720']);
  assert.deepEqual(run.views,[{name:'seat-1',seat:'seat-1'},{name:'seat-17',seat:'seat-17'},{name:'at-160-80',seat:'none',at:[160,80]}]);
  assert.deepEqual([run.from,run.to,run.clientFps,run.videoFps,run.width,run.height],[60,120,30,10,1280,720]);
  assert.equal(options(['--replay','/r','--out','/o','--seats','seat-2']).to,null);
  for(const [args,message] of [[['--out','/o','--seats','seat-1'],/--replay is required/],[['--replay','/r','--seats','seat-1'],/--out is required/],
    [['--replay','/r','--out','/o'],/Name at least one seat/],[['--replay','/r','--out','/o','--seats','seat-1,seat-1'],/distinct seats/],
    [['--replay','/r','--out','/o','--seats','seat-1','--size','961x540'],/even WIDTHxHEIGHT/],[['--replay','/r','--out','/o','--seats','seat-1','--from','30','--to','20'],/Invalid --to 20/],
    [['--replay','/r','--out','/o','--at','north'],/tile position/],[['--replay','/r','--out','/o','--seats','seat-1','--client-fps','0'],/Invalid --client-fps 0/]])
    assert.throws(()=>options(args),message);
});
