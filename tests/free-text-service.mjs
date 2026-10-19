import {build} from 'esbuild';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
globalThis.crypto ??= webcrypto;globalThis.window=globalThis;
const bundle=await build({stdin:{contents:"export * from './src/free-text/service';export * from './src/free-text/pdf';export * from './src/free-text/worker-engine';export {PDFDocument} from '@cantoo/pdf-lib';",resolveDir:process.cwd()},bundle:true,write:false,format:'esm',platform:'node',plugins:[{name:'mock',setup(b){
 b.onResolve({filter:/^obsidian$/},()=>({path:'obsidian',namespace:'mock'}));
 b.onResolve({filter:/^virtual:pdf-text-worker$/},()=>({path:'worker',namespace:'mock'}));
 b.onLoad({filter:/.*/,namespace:'mock'},args=>({contents:args.path==='worker'?'export const source="";':'export class Notice {} export class TFile {}'}));
}}]});
const api=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'));
const png=Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64'));
const renderer=async()=>({png,height:32});
let processCount=0,indexCount=0;
const runner={process:input=>{processCount++;return api.processBatch(input,renderer);},index:bytes=>{indexCount++;return api.indexNotes(bytes);},verify:async(bytes,digest)=>api.digest(bytes)===digest};
const original=await api.PDFDocument.create();original.addPage([595,842]);
const asBuffer=x=>Uint8Array.from(x).buffer;
const file={path:'book.pdf',stat:{mtime:1,size:0}};
const files=new Map([[file.path,asBuffer(await original.save())]]),folders=new Set();
let writes=0,backups=0,readCount=0,concurrent=false,local;
const vault={
 readBinary:async f=>{readCount++;if(concurrent&&readCount===2)return new Uint8Array([0]).buffer;return files.get(f.path).slice(0);},
 createFolder:async p=>folders.add(p),createBinary:async(p,b)=>{backups++;files.set(p,b.slice(0));},
 modifyBinary:async(f,b)=>{writes++;files.set(f.path,asBuffer(b));f.stat.mtime++;f.stat.size=b.byteLength;},
 adapter:{exists:async p=>files.has(p)||folders.has(p)}
};
const plugin={settings:{enablePDFEdit:true,author:'test'},app:{vault,loadLocalStorage:()=>local,saveLocalStorage:(_,value)=>{local=structuredClone(value);}}};
const service=new api.FreeTextService(plugin,runner);
const box={page:1,rect:[72,500,300,600],text:'中文文字批注',fontSize:12,color:'#222222'};
service.stage(file,'new:a',box);service.stage(file,'new:b',{...box,rect:[72,300,300,400],text:'second'});
assert.equal(writes,0);assert.equal(readCount,0,'Typing/staging performs no full-PDF I/O or parsing');
assert.equal(service.state(file).count,2);
await service.savePending(file);
assert.equal(processCount,1,'Several notes share one parse/serialization');assert.equal(writes,1);assert.equal(backups,1);
let doc=await api.PDFDocument.load(files.get(file.path));assert.equal(doc.getPage(0).node.Annots().size(),2);
const id=doc.getPage(0).node.Annots().asArray()[0].toString().replace(' 0 R','R');
const loaded=await service.read(file,1,id);await service.read(file,1,id);assert.equal(indexCount,1,'Repeated metadata reads use the index');
await service.save(file,{...loaded,text:'edited'},{});
assert.equal(backups,1);assert.equal((await service.read(file,1,id)).text,'edited');
await assert.rejects(()=>service.save(file,{...loaded,text:'stale'},{}),/其他操作修改/);
assert(service.state(file).count,'Failed saves keep local drafts');assert.equal(writes,2);
service.restore(file,id);
const fresh=await service.read(file,1,id);readCount=0;concurrent=true;
await assert.rejects(()=>service.save(file,{...fresh,text:'in-flight change'},{}),/同步修改/);concurrent=false;
assert.equal(writes,2);service.restore(file,id);
await service.remove(file,1,id);assert.equal(writes,3);
doc=await api.PDFDocument.load(files.get(file.path));assert.equal(doc.getPage(0).node.Annots().size(),1,'Deleting preserves other annotations');
service.stage(file,'new:draft',{...box,text:'recover me'});service.destroy();
const restored=new api.FreeTextService(plugin,runner);assert.equal(restored.changes(file)[0].box.text,'recover me','Client-local drafts survive restart');
restored.restore(file,'new:draft');plugin.settings.enablePDFEdit=false;
await assert.rejects(()=>restored.save(file,box,{}),/开启 PDF 编辑/);
restored.destroy();
const metadata=api.boxFromAnnotation({id:'10R',rect:[0,0,200,50],contentsObj:{str:'中文'},color:[26,115,232]},1);
assert.equal(metadata.text,'中文');assert.equal(metadata.color,'#1a73e8');assert.equal(metadata.originalText,'中文');
console.log('Passed: zero-I/O staging, one-write batching, cached metadata, Unicode save/delete, baseline backup, conflict protection, local draft recovery, and edit permission.');
