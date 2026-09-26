import { describe, expect, test } from 'bun:test';
import { MAX_RENDER_BYTES, storeRenderedMp4 } from '../src/workers/render-output.ts';

function fixture(chunks: Uint8Array[]) {
  const uploads: Array<{part:number;size:number;byte:number}> = [];
  let aborted=false, completed=false;
  const bucket={createMultipartUpload:async(_key:string,options:unknown)=>{
    expect(options).toEqual({httpMetadata:{contentType:'video/mp4'}});
    return {uploadPart:async(part:number,data:Uint8Array)=>{
      uploads.push({part,size:data.byteLength,byte:data[0]});
      return {partNumber:part,etag:`part-${part}`};
    },complete:async(parts:Array<{partNumber:number}>)=>{
      expect(parts.map(p=>p.partNumber)).toEqual(uploads.map(p=>p.part));completed=true;
    },abort:async()=>{aborted=true}};
  }} as unknown as R2Bucket;
  const stream=new ReadableStream<Uint8Array>({start(controller){for(const c of chunks)controller.enqueue(c);controller.close()}});
  return {bucket,stream,uploads,get aborted(){return aborted},get completed(){return completed}};
}

describe('Container streaming MP4 upload to R2',()=>{
  test('accepts chunked responses without Content-Length, including a short final part',async()=>{
    const f=fixture([new Uint8Array(5_000_000).fill(42),new Uint8Array(4_000_000).fill(17)]);
    expect(await storeRenderedMp4(f.bucket,'private/revision.mp4',f.stream,null)).toBe(9_000_000);
    expect(f.uploads).toEqual([{part:1,size:8*1024*1024,byte:42},{part:2,size:9_000_000-8*1024*1024,byte:17}]);
    expect(f.completed).toBe(true);expect(f.aborted).toBe(false);
  });
  test('rejects empty and mismatched lengths and aborts incomplete multipart uploads',async()=>{
    for(const [chunks,length] of [[[],null],[[new Uint8Array([1])],'2']] as const){
      const f=fixture([...chunks]);
      await expect(storeRenderedMp4(f.bucket,'x',f.stream,length)).rejects.toThrow('render_size_invalid');
      expect(f.aborted).toBe(true);expect(f.completed).toBe(false);
    }
  });
  test('rejects forged oversized length before creating an R2 object',async()=>{
    const f=fixture([new Uint8Array(1)]);
    await expect(storeRenderedMp4(f.bucket,'x',f.stream,String(MAX_RENDER_BYTES+1))).rejects.toThrow('render_size_invalid');
    expect(f.uploads).toHaveLength(0);expect(f.completed).toBe(false);
  });
});
