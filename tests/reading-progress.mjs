import { build } from 'esbuild';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
globalThis.crypto ??= webcrypto;
globalThis.window = globalThis;
const output = await build({ entryPoints: ['src/reading-progress.ts'], bundle: true, write: false, format: 'esm', platform: 'node', plugins: [{ name: 'obsidian-mock', setup(b) {
 b.onResolve({filter:/^obsidian$/},()=>({path:'obsidian',namespace:'mock'}));
 b.onLoad({filter:/.*/,namespace:'mock'},()=>({contents:`
 export class Component { register() {} registerEvent() {} registerDomEvent(el,e,f,o) {el.addEventListener(e,f,o);} }
 export class Notice {} export class TFile { constructor(path){this.path=path;this.extension='json';} }
 globalThis.MockTFile=TFile;
 `}));
} }] });
const {ReadingProgressSync,latest,validProgress,ROOT}=await import('data:text/javascript;base64,'+Buffer.from(output.outputFiles[0].text).toString('base64'));
const base={schema:1,file:'books/a.pdf',device:'a',revision:10,page:30};
assert(validProgress(base));
for(const change of [{page:0},{page:NaN},{revision:Infinity},{zoom:-1},{top:'x'},{schema:2},{device:'../bad'}]) assert(!validProgress({...base,...change}));
assert.equal(latest([base,{...base,revision:11,page:5}]).page,5);
assert.equal(latest([base,{...base,device:'z'}]).device,'z');
const realNow=Date.now;let testTime=realNow();Date.now=()=>++testTime;
const storage=new Map(),folders=new Set(),unindexed=new Set();
let creates=0,modifies=0,fail=false;
const vault={
 on(){},
 getName:()=> 'test',
 getAbstractFileByPath:p=>storage.has(p)&&!unindexed.has(p)?new MockTFile(p):null,
 createFolder:async p=>{folders.add(p);},
 create:async(p,s)=>{if(fail)throw Error('disk full');if(storage.has(p))throw Error('already exists');creates++;storage.set(p,s);},
 modify:async(f,s)=>{if(fail)throw Error('disk full');modifies++;storage.set(f.path,s);},
 adapter:{
  exists:async p=>storage.has(p)||folders.has(p),
  list:async p=>({files:[...storage.keys()].filter(k=>k.startsWith(p+'/')&&!k.slice(p.length+1).includes('/')),folders:[]}),
  read:async p=>storage.get(p),
  write:async(p,s)=>{if(fail)throw Error('disk full');storage.set(p,s);}
 }
};
function target(){const handlers=new Map();return{handlers,hidden:false,addEventListener:(e,f)=>handlers.set(e,f),removeEventListener:e=>handlers.delete(e),setAttribute(){},remove(){}};}
function device({ready=true,explicit}={}) {
 const events=new Map(),root=target(),doc=target(),viewport=target();viewport.ownerDocument=doc;
 const viewer={pagesCount:ready?100:0,currentPageNumber:1,currentScale:1,_location:{pageNumber:1,left:0,top:800},container:viewport,eventBus:{on:(e,f)=>events.set(e,f),off:e=>events.delete(e)}};
 const component={containerEl:root,then:cb=>cb({unloaded:false,pdfViewer:{pdfViewer:viewer}}),register(){}};
 const plugin={settings:{readingProgressSync:true},addStatusBarItem:()=>target(),addCommand(){},app:{vault,workspace:{activeLeaf:{view:{viewer:component}},on(){}}},lib:{isPDFView:()=>true,applyPDFViewStateToViewer:(v,p)=>{v.currentPageNumber=p.page;v.currentScale=p.zoom??1;v._location={pageNumber:p.page,left:p.left,top:p.top};}}};
 const sync=new ReadingProgressSync(plugin);sync.onload();
 return{sync,component,viewer,events,root,doc,plugin,explicit,
  async open(){await sync.open(component,{path:base.file},explicit);},
  input(type='wheel'){root.handlers.get(type)();},
  change(page){viewer.currentPageNumber=page;viewer._location.pageNumber=page;events.get('updateviewarea')();},
  session(){return sync.sessions.get(component);}
 };
}
const a=device();await a.open();
a.change(2);await a.session().flush();assert.equal(storage.size,0,'Passive load never writes');
a.input();a.change(30);await a.session().flush();assert.equal(creates,1);
a.change(31);await a.session().flush();assert.equal(modifies,1,'Repeated saves modify the existing TFile');
const b=device();await b.open();assert.equal(b.viewer.currentPageNumber,31,'Other device resumes');
b.input('input');b.change(5);await b.session().flush();assert.equal(creates,2,'Independent writers');
const c=device();await c.open();assert.equal(c.viewer.currentPageNumber,5,'Backward reading wins');
const explicit=device({explicit:'#page=12'});await explicit.open();assert.equal(explicit.viewer.currentPageNumber,1,'Explicit links are left to native destination handling');
const delayed=device({ready:false});await delayed.open();delayed.viewer.pagesCount=100;delayed.events.get('pagesloaded')();assert.equal(delayed.viewer.currentPageNumber,5,'Restore waits for pages');
// Navigation outside the page container: root-level input is required for toolbar page fields.
a.input('input');a.change(40);await a.session().flush();assert.equal((await a.sync.store.newest(base.file)).page,40,'Toolbar navigation is recorded');
// Cleanup must persist the captured page, not whichever location is present at disposal.
a.input('keydown');a.change(41);a.viewer._location.pageNumber=99;a.session().dispose();await a.sync.store.flush();assert.equal((await a.sync.store.newest(base.file)).page,41,'Disposal saves last user snapshot, never a stale viewer');
// Repeated saving of incoming, unindexed JSON works without waiting for Obsidian metadata.
const recordPaths=[...storage.keys()];recordPaths.forEach(p=>unindexed.add(p));
await b.sync.resumeActive(true);b.input();b.change(42);await b.session().flush();assert.equal((await b.sync.store.newest(base.file)).page,42,'Adapter reads/writes unindexed JSON');
const remote={...base,device:'remote',page:50,revision:Date.now()+1000};await b.sync.store.write(remote);
await b.session().observeRemote();assert(b.sync.status.textContent.includes('新进度'),'Incoming progress is announced without jumping');assert.equal(b.viewer.currentPageNumber,42);
await b.sync.resumeActive(true);assert.equal(b.viewer.currentPageNumber,50,'Manual refresh reads newly synced records');
b.viewer._location.pageNumber=1;b.session().deactivate();await b.sync.store.flush();assert.equal((await b.sync.store.newest(base.file)).page,50,'Background close does not promote stale state');
folders.add('PDF++ Reading Progress');storage.set('PDF++ Reading Progress/old.json',JSON.stringify({...remote,page:60,revision:remote.revision+1}));storage.set('PDF++ Reading Progress/broken.json','{');
await b.sync.initialize();assert.equal((await b.sync.store.newest(base.file)).page,60);assert([...storage.keys()].some(p=>p.startsWith(ROOT+'/')),'Legacy records migrate to unified root');
const before=creates+modifies;await b.sync.initialize();assert.equal((await b.sync.store.newest(base.file)).page,60,'Migration is repeatable');
// Failed disk writes retain a pending snapshot and can be retried.
await b.sync.resumeActive(true);b.input();b.change(61);fail=true;const errorLog=console.error;console.error=()=>{};await b.session().flush();console.error=errorLog;assert(b.session().pending,'Failure preserves pending progress');fail=false;await b.session().flush();assert.equal((await b.sync.store.newest(base.file)).page,61);
// Older queued writes must not overwrite this writer's newer record.
const newest=await b.sync.store.newest(base.file);await b.sync.store.write({...newest,page:2,revision:1});assert.equal((await b.sync.store.newest(base.file)).page,61);
// Detach before a file load can move the previous viewer to another PDF's position.
const switching=device();await switching.open();switching.input();switching.change(70);
switching.sync.beforeOpen(switching.component);switching.viewer._location.pageNumber=90;
await switching.sync.open(switching.component,{path:'books/other.pdf'});
assert.equal((await switching.sync.store.newest(base.file)).page,70,'Switching PDFs cannot contaminate the old file position');
assert.equal((await switching.sync.store.newest('books/other.pdf')),undefined,'New PDF does not inherit an old pending snapshot');
for(const d of [a,b,c,explicit,delayed,switching])for(const s of d.sync.sessions.values())s.dispose();
Date.now=realNow;
console.log('Passed: validation, actual create/modify paths, toolbar input, cross-device/backward resume, deferred pages, explicit links, unindexed sync, manual refresh, stale disposal, legacy migration, retry, and out-of-order writes.');
