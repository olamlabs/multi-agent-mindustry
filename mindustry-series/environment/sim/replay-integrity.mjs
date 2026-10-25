import {open,readFile,writeFile,rename,readdir,rm} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {createGunzip} from 'node:zlib';
import {Writable} from 'node:stream';
import {pipeline} from 'node:stream/promises';

export async function validateReplay(dir) {
  await rm(join(dir,'manifest.json'),{force:true});
  const stats=JSON.parse(await readFile(join(dir,'stats.json'),'utf8'));
  if(!stats.closed||!stats.complete||stats.failure)throw Error('Replay recorder did not close successfully');
  const names=(await readdir(dir)).filter(n=>/^segment-\d+\.mreplay$/.test(n)).sort((a,b)=>Number(a.match(/\d+/)[0])-Number(b.match(/\d+/)[0]));
  if(!names.length||names.length!==stats.segments)throw Error('Replay segment count mismatch');
  const segments=[];
  for(const [index,name] of names.entries()){
    const path=join(dir,name),file=await open(path,'r');let offset;
    try{
      const head=Buffer.alloc(12);await file.read(head,0,12,0);
      if(head.subarray(0,8).toString()!=='MREPLAY1')throw Error('Invalid replay magic');
      const length=head.readUInt32BE(8);
      if(length>1024*1024)throw Error('Oversized replay header');
      const data=Buffer.alloc(length);const read=await file.read(data,0,length,12);
      if(read.bytesRead!==length||JSON.parse(data).segment!==index)throw Error('Invalid replay header/sequence');
      offset=12+length;
    } finally {await file.close();}
    let decompressed=0, header=Buffer.alloc(0), payload=0, records=0;
    await pipeline(createReadStream(path,{start:offset}),createGunzip(),new Writable({write(chunk,encoding,done){
      try {
        decompressed+=chunk.length;
        let at=0;
        while(at<chunk.length){
          if(payload){const take=Math.min(payload,chunk.length-at);payload-=take;at+=take;continue;}
          const size=header.length ? (header[0]===1?14:13) : 1;
          const take=Math.min(size-header.length,chunk.length-at);
          header=Buffer.concat([header,chunk.subarray(at,at+take)]);at+=take;
          if(![1,2,3].includes(header[0]))throw Error('Invalid replay record kind');
          const needed=header[0]===1?14:13;
          if(header.length===needed){
            payload=header.readInt32BE(needed-4);
            if(payload<0||header.readBigInt64BE(1)<0)throw Error('Invalid replay record length/time');
            records++;header=Buffer.alloc(0);
          }
        }
        done();
      } catch(error){done(error);}
    }}));
    if(header.length||payload||!records)throw Error('Replay ends inside a record or contains no records');
    const hash=createHash('sha256');let bytes=0;
    for await(const chunk of createReadStream(path)){hash.update(chunk);bytes+=chunk.length;}
    segments.push({file:name,bytes,decompressed_bytes:decompressed,sha256:hash.digest('hex')});
  }
  const receipt={closed:true,validated_at:new Date().toISOString(),segments};
  await writeFile(join(dir,'manifest.json.tmp'),JSON.stringify(receipt,null,2)+'\n');
  await rename(join(dir,'manifest.json.tmp'),join(dir,'manifest.json'));
  return receipt;
}
