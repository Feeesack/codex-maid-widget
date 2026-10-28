'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {latestOriginals,HandoffStore}=require('../src/chat-handoff.cjs');
const {LIMITS}=require('../src/chat-policy.cjs');
const meter=s=>Array.from(s).length;
test('latest long question/answer retain exact ending negation inside the originals budget including wrappers',()=>{
 const parts=[{ref:'C-one/M1/P1',role:'user',time:null,text:'问题：'+ '很长'.repeat(1000)+'末尾：不要删除'},
  {ref:'C-one/M2/P1',role:'assistant',time:null,text:'解释'+ '很长'.repeat(1000)+'结论：不删除'}];
 const q=latestOriginals(parts,{countTokens:meter});assert.ok(meter(JSON.stringify(q))<=LIMITS.handoffOriginal);
 assert.ok(q.some(x=>x.text.includes('不要删除')));assert.ok(q.some(x=>x.text.includes('不删除')));
 for(const x of q){const p=parts.find(p=>p.ref===x.ref);assert.equal(Array.from(p.text).slice(x.start,x.end).join(''),x.text);}
});
test('expanded recursive handoff keeps more than the old 3K package and enforces all three new limits',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'maid-handoff-expanded-中文 '));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const p={ref:'C-large/M1/P1',role:'user',time:null,text:'x'.repeat(1700)+'do not remove the source'};
 const store=new HandoffStore({projectRoot:root,countTokens:meter,resolveSource:r=>r===p.ref?p:null});
 const args={taskId:'expanded',baseVersion:0,sourceWatermark:'source',operationWatermark:0,summary:'s'.repeat(2800),originals:latestOriginals([p],{countTokens:meter}),hasHistory:true,sourceRefs:[p.ref],complete:true};
 const value=store.publish(args);assert.ok(meter(JSON.stringify(value.modelView))>4500);assert.ok(meter(JSON.stringify(value.modelView))<=LIMITS.handoff);
 assert.ok(meter(JSON.stringify(value.modelView.summary))>2000);assert.ok(meter(JSON.stringify(value.modelView.originals))>1000);
 assert.equal(value.modelView.originals[0].text,p.text);
 assert.throws(()=>store.publish({...args,taskId:'summary-over',baseVersion:1,summary:'x'.repeat(LIMITS.handoffSummary+1)}),/BUDGET/);
 assert.throws(()=>store.publish({...args,taskId:'originals-over',baseVersion:1,originals:[...args.originals,...args.originals]}),/BUDGET/);
 assert.throws(()=>store.publish({...args,taskId:'changed-quote',baseVersion:1,originals:[{...args.originals[0],text:'invented'}]}),/QUOTE/);
 assert.equal(store.current().version,1);
});
test('published handoff verifies quotations, baselines, source references and old citations',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'maid-handoff-中文 '));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const p={ref:'C-one/M1/P1',role:'user',text:'不要删原件'};
 const store=new HandoffStore({projectRoot:root,countTokens:meter,resolveSource:r=>r===p.ref?p:null});
 const args={taskId:'task1',baseVersion:0,sourceWatermark:'source1',operationWatermark:0,summary:'刚才在讨论原图保护',originals:latestOriginals([p],{countTokens:meter}),hasHistory:true,sourceRefs:[p.ref],complete:true};
 const first=store.publish(args);assert.equal(first.version,1);assert.equal(store.publish(args).version,1);
 assert.throws(()=>store.publish({...args,taskId:'task2'}),/BASELINE/);
 assert.throws(()=>store.publish({...args,taskId:'task2',baseVersion:1,originals:[{...args.originals[0],text:'伪引文'}]}),/QUOTE/);
 const next=store.publish({...args,taskId:'task2',baseVersion:1,sourceWatermark:'source2'});assert.equal(next.version,2);
 assert.equal(store.read(`${first.id}@v1`).version,1);
 store.pin(`${first.id}@v1`);
 store.publish({...args,taskId:'task3',baseVersion:2,sourceWatermark:'source3'});
 assert.equal(store.read(`${first.id}@v1`).version,1);
 assert.equal(fs.existsSync(path.join(root,'memory/recent/versions')),false);
 assert.equal(fs.readdirSync(path.join(root,'memory/recent/pinned')).length,1);
});
