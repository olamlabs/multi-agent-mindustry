import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {gzipSync} from 'node:zlib';
import {validateReplay} from '../../environment/sim/replay-integrity.mjs';

test('replay integrity receipt requires a finalized, untruncated stream',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'survival-replay-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const header=Buffer.from(JSON.stringify({segment:0})),length=Buffer.alloc(4);length.writeUInt32BE(header.length);
 const bytes=Buffer.concat([Buffer.from('MREPLAY1'),length,header,gzipSync(Buffer.from([2,0,0,0,0,0,0,0,0,0,0,0,1,42]))]);
 writeFileSync(join(dir,'segment-000.mreplay'),bytes);writeFileSync(join(dir,'stats.json'),JSON.stringify({closed:true,complete:true,segments:1}));
 assert.equal((await validateReplay(dir)).segments[0].sha256.length,64);
 for(const payload of [Buffer.from('records'),Buffer.from([2,0]),Buffer.from([2,0,0,0,0,0,0,0,0,0,0,0,3,42])]){
  writeFileSync(join(dir,'segment-000.mreplay'),Buffer.concat([bytes.subarray(0,12+header.length),gzipSync(payload)]));
  await assert.rejects(validateReplay(dir),/record/);
  assert.equal(existsSync(join(dir,'manifest.json')),false,'failed validation removes stale receipt');
 }
 writeFileSync(join(dir,'segment-000.mreplay'),bytes.subarray(0,-4));await assert.rejects(validateReplay(dir));
 writeFileSync(join(dir,'stats.json'),JSON.stringify({closed:false,complete:true,segments:1}));await assert.rejects(validateReplay(dir),/did not close/);
});
