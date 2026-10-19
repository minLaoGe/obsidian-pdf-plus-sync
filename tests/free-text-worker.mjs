import {build} from 'esbuild';
import assert from 'node:assert/strict';
import {Worker} from 'node:worker_threads';
import {readFile} from 'node:fs/promises';
import {performance} from 'node:perf_hooks';
import {PDFDocument} from '@cantoo/pdf-lib';
const compiled=await build({entryPoints:['src/free-text/worker-entry.ts'],bundle:true,write:false,platform:'browser',format:'iife',target:'es2020'});
const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
const prelude=`const {parentPort}=require('node:worker_threads');
globalThis.postMessage=(data,transfer)=>parentPort.postMessage(data,transfer);
Object.defineProperty(globalThis,'onmessage',{set(fn){parentPort.on('message',data=>fn({data}));}});
globalThis.OffscreenCanvas=class{getContext(){return{font:'',measureText:s=>({width:s.length*6}),scale(){},fillText(){}};}async convertToBlob(){return new Blob([Buffer.from('${png}','base64')]);}};
`;
const worker=new Worker(prelude+compiled.outputFiles[0].text,{eval:true});
let sequence=0;
const send=(kind,payload,bytes)=>new Promise((resolve,reject)=>{
 const id=++sequence;
 const listener=data=>{if(data.id!==id)return;worker.off('message',listener);data.error?reject(Error(data.error)):resolve(data.value);};
 worker.on('message',listener);worker.postMessage({id,kind,...payload},[bytes]);
});
try{
 const doc=await PDFDocument.create();doc.addPage([595,842]);const initial=Uint8Array.from(await doc.save()).buffer;
 const input=initial.slice(0);
 const operation={key:'new:a',version:1,box:{page:1,rect:[20,100,220,150],text:'后台保存',fontSize:12,color:'#222222'}};
 const pending=send('process',{input:{bytes:input,operations:[operation],author:'worker-test'}},input);
 assert.equal(input.byteLength,0,'Source bytes are transferred rather than cloned');
 const output=await pending;assert(output.notes['new:a'].id);
 const indexBuffer=Uint8Array.from(output.bytes).buffer;
 const notes=await send('index',{bytes:indexBuffer},indexBuffer);assert.equal(notes[0].text,'后台保存');
 const verify=initial.slice(0);assert(await send('verify',{bytes:verify,digest:output.inputDigest},verify));
 if(process.env.PDF_SYNC_BENCHMARK_FILE){
  const bytes=Uint8Array.from(await readFile(process.env.PDF_SYNC_BENCHMARK_FILE)).buffer;
  const size=bytes.byteLength;let ticks=0,maxGap=0,last=performance.now();
  const timer=setInterval(()=>{const now=performance.now();maxGap=Math.max(maxGap,now-last);last=now;ticks++;},10);
  const start=performance.now();await send('process',{input:{bytes,operations:[],author:'benchmark'}},bytes);clearInterval(timer);
  console.log(JSON.stringify({pdfMB:Math.round(size/1024/1024),workerMs:Math.round(performance.now()-start),mainThreadTicks:ticks,maxMainThreadGapMs:Math.round(maxGap)}));
  assert(ticks>0,'Main event loop remains responsive while the PDF worker processes the file');
 }
 console.log('Passed: real worker isolation, transferable buffers, offscreen render pipeline, batch serialization, metadata indexing and conflict digest verification.');
}finally{await worker.terminate();}
