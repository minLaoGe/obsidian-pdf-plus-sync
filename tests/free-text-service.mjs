import {build} from 'esbuild';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
globalThis.crypto ??= webcrypto;
const bundle=await build({stdin:{contents:"export * from './src/free-text/service';export * from './src/free-text/pdf';export {PDFDocument} from '@cantoo/pdf-lib';",resolveDir:process.cwd()},bundle:true,write:false,format:'esm',platform:'node',plugins:[{name:'obsidian',setup(b){b.onResolve({filter:/^obsidian$/},()=>({path:'obsidian',namespace:'mock'}));b.onLoad({filter:/.*/,namespace:'mock'},()=>({contents:'export class Notice {} export class TFile {}'}));}}]});
const api=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'));
const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
const pngBytes=Uint8Array.from(Buffer.from(png,'base64'));
const ownerDocument={createElement:()=>({getContext:()=>({font:'',measureText:s=>({width:s.length*6}),scale(){},fillText(){}}),toDataURL:()=> 'data:image/png;base64,'+png})};
let original=await api.PDFDocument.create();original.addPage([595,842]);
const asBuffer=x=>Uint8Array.from(x).buffer;
const files=new Map([['book.pdf',asBuffer(await original.save())]]),folders=new Set();
let writes=0,backups=0,readCount=0,concurrent=false;
const vault={
 readBinary:async f=>{readCount++;if(concurrent&&readCount===2)return new Uint8Array([0]).buffer;return files.get(f.path).slice(0);},
 createFolder:async p=>folders.add(p),createBinary:async(p,b)=>{backups++;files.set(p,b.slice(0));},
 modifyBinary:async(f,b)=>{writes++;files.set(f.path,asBuffer(b));},
 adapter:{exists:async p=>files.has(p)||folders.has(p)}
};
const plugin={settings:{enablePDFEdit:true,author:'test'},app:{vault}};
const service=new api.FreeTextService(plugin),file={path:'book.pdf'};
const box={page:1,rect:[72,500,300,600],text:'中文文字批注',fontSize:12,color:'#222222'};
await service.save(file,box,ownerDocument);
assert.equal(writes,1);assert.equal(backups,1,'Original backed up before first edit');
let doc=await api.PDFDocument.load(files.get(file.path));
const id=doc.getPage(0).node.Annots().asArray()[0].toString().replace(' 0 R','R');
const loaded=await service.read(file,1,id);
await service.save(file,{...loaded,text:'edited'},ownerDocument);
assert.equal(backups,1,'Do not duplicate the full PDF backup on each save');
assert.equal((await service.read(file,1,id)).text,'edited');
// Remote changes after opening the editor must not be silently overwritten.
await assert.rejects(()=>service.save(file,{...loaded,text:'stale'},ownerDocument),/其他操作修改/);
assert.equal(writes,2);
const fresh=await service.read(file,1,id);
readCount=0;concurrent=true;
await assert.rejects(()=>service.save(file,{...fresh,text:'in-flight change'},ownerDocument),/同步修改/);
concurrent=false;assert.equal(writes,2,'Abort before writing if source bytes changed');
await service.remove(file,1,id);assert.equal(writes,3);
doc=await api.PDFDocument.load(files.get(file.path));assert.equal(doc.getPage(0).node.Annots().size(),0);
plugin.settings.enablePDFEdit=false;
await assert.rejects(()=>service.save(file,box,ownerDocument),/开启 PDF 编辑/);
console.log('Passed: save/modify/delete service, single baseline backup, stale-editor detection, concurrent-file detection, and edit permission.');
