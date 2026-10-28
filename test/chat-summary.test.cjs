'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {SummaryTree,sourceBatches,digest}=require('../src/chat-summary.cjs');
const {LIMITS}=require('../src/chat-policy.cjs');
const meter=t=>Array.from(t).length;
const content=c=>({text:`经历${c}`,guide:'原文下查',entries:[{text:`经历${c}`,refs:[`${c}/M000001/P01`]}]});
const summarize=async({children})=>({text:'时期概括',guide:'按直接下级下查',entries:children.map(c=>({text:c.content.text,refs:[`${c.ref}#I01`]}))});
function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'maid-tree-中文 '));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return new SummaryTree({projectRoot:root,countTokens:meter,resolveSource:()=>true});}

test('confirmed source correction projects current root and future parent input while preserving every historical node byte',async t=>{
 const tree=fixture(t),source='C-old/M000001/P01',wrong='合成用户喜欢咖啡。',correct='合成用户不喜欢咖啡。';
 const first=await tree.publishLeaf({conversationId:'C-old',sourceFingerprint:digest('old'),sourceComplete:true,content:{text:wrong,guide:'旧表达',entries:[{text:wrong,refs:[source]}]}});
 const file=path.join(tree.journal.root,'memory','summaries','nodes',`${first.leaf}.jsonl`),bytes=fs.readFileSync(file),corrections=[{memoryRef:'F-coffee@2',text:correct,sourceRefs:[source]}];
 const projected=tree.projectCurrent(first.root,{corrections});assert.match(projected.content.text,/合成用户不喜欢咖啡/);assert.doesNotMatch(projected.content.text,/合成用户喜欢咖啡/);assert.match(projected.content.text,/F-coffee@2/);
 let requests=0;
 const next=await tree.publishLeaf({conversationId:'C-new',sourceFingerprint:digest('new'),sourceComplete:true,content:content('C-new'),projectionWatermark:digest(corrections),
  currentProjection:node=>tree.projectCurrent(node,{corrections}),summarize:async input=>{requests++;assert.doesNotMatch(JSON.stringify(input),/合成用户喜欢咖啡/);assert.match(JSON.stringify(input),/F-coffee@2/);return summarize(input)}});
 assert.equal(requests,1);assert.deepEqual(fs.readFileSync(file),bytes);assert.equal(tree.read(first.leaf).content.text,wrong);assert.equal(tree.projectCurrent(next.root,{corrections}).currentProjectionWatermark,digest(corrections));
});

test('a bounded current projection hides unresolved old claims when provenance traversal exceeds its budget',async t=>{
 const tree=fixture(t);for(const id of ['C-one','C-two','C-three'])await tree.publishLeaf({conversationId:id,sourceFingerprint:digest(id),sourceComplete:true,content:content(id),summarize});
 const projected=tree.projectCurrent(tree.state().root,{corrections:[{memoryRef:'F-repaired@2',text:'核验后的合成原话。',sourceRefs:['C-one/M000001/P01']}],nodeLimit:0});
 assert.equal(projected.currentProjection.partial,true);assert.equal(projected.currentProjection.visitedNodes,0);assert.match(projected.content.guide,/部分/);assert.doesNotMatch(projected.content.text,/时期概括/);
});
test('one C has one stable L1, revisions preserve old source references',async t=>{
 const tree=fixture(t);const args={conversationId:'C-one',sourceFingerprint:digest('one'),sourceComplete:true,content:content('C-one'),summarize};
 const first=await tree.publishLeaf(args),again=await tree.publishLeaf(args);assert.equal(again.reused,true);
 const changed=await tree.publishLeaf({...args,sourceFingerprint:digest('two')});
 assert.equal(first.leaf.split('@')[0],changed.leaf.split('@')[0]);assert.equal(tree.read(first.leaf).version,1);assert.equal(Object.keys(tree.state().conversations).length,1);
});
test('right branches fill to sixteen before seventeen grows the root',async t=>{
 const tree=fixture(t);const first=[];
 for(let i=1;i<=17;i++){
  const c=`C-${i}`;const result=await tree.publishLeaf({conversationId:c,sourceFingerprint:digest(c),content:content(c),sourceComplete:true,summarize});
  const root=tree.read(result.root);first.push(root.level);
  assert.equal(root.leaves,i);assert.ok(root.children.length<=4);
 }
 assert.equal(first[12],3);assert.equal(first[15],3);assert.equal(first[16],4);
 assert.equal(Object.keys(tree.state().conversations).length,17);
});
test('missing sources or oversized generation never publish a new head',async t=>{
 const tree=fixture(t);
 await assert.rejects(tree.publishLeaf({conversationId:'C-one',sourceFingerprint:digest('x'),sourceComplete:false,content:content('C-one')}),/SOURCE/);
 await assert.rejects(tree.publishLeaf({conversationId:'C-one',sourceFingerprint:digest('x'),sourceComplete:true,content:{...content('C-one'),text:'x'.repeat(LIMITS.node+1)}}),/BUDGET/);
 assert.equal(tree.state().root,null);
});
test('four expanded leaves can supply nearly 80K to a parent and retain the 20K per-node boundary',async t=>{
 const tree=fixture(t),observed=[];
 const expanded=c=>{const value={text:'',guide:'synthetic original',entries:[{text:'synthetic fact',refs:[`${c}/M000001/P01`]}]};value.text='x'.repeat(LIMITS.node-16-meter(JSON.stringify(value)));return value;};
 const merge=async input=>{observed.push(input);assert.equal(input.inputLimit,LIMITS.parentInput);assert.equal(input.outputLimit,LIMITS.node);return{text:'p'.repeat(7000),guide:'synthetic four-child summary',entries:input.children.map(child=>({text:'child evidence retained',refs:[`${child.ref}#I01`]}))};};
 for(let i=1;i<=4;i++){const c=`C-wide-${i}`;await tree.publishLeaf({conversationId:c,sourceFingerprint:digest(c),content:expanded(c),sourceComplete:true,summarize:merge});}
 const last=observed.at(-1);assert.equal(last.children.length,4);assert.ok(meter(JSON.stringify(last.children.map(child=>child.content)))>79000);assert.ok(meter(JSON.stringify(last.children.map(child=>child.content)))<=LIMITS.parentInput);
 const root=tree.read(tree.state().root);assert.equal(root.leaves,4);assert.ok(meter(JSON.stringify(root.content))>6000);assert.ok(meter(JSON.stringify(root.content))<=LIMITS.node);
 const before=tree.state().revision;
 await assert.rejects(tree.publishLeaf({conversationId:'C-too-large',sourceFingerprint:digest('too-large'),content:{...content('C-too-large'),text:'x'.repeat(LIMITS.node+1)},sourceComplete:true,summarize:merge}),/BUDGET/);
 assert.equal(tree.state().revision,before);
});
test('400K internal batches preserve exact sources without adding leaf IDs',()=>{
 const text='甲'.repeat(400000)+'末尾否定：不要这样';
 const parts=sourceBatches([{ref:'C-one/M000001/P01',text}],{countTokens:meter,carry:'old'});
 assert.ok(parts.length>6);assert.equal(parts.flat().map(p=>p.text).join(''),text);
 for(const p of parts)assert.ok(meter(JSON.stringify({carry:'old',parts:p}))<=30000);
 assert.ok(parts.flat().every(p=>!p.ref.startsWith('L1-')));
});
test('a parent cannot invent a non-existent entry in a real child',async t=>{
 const tree=fixture(t);await tree.publishLeaf({conversationId:'C-one',sourceFingerprint:digest('one'),content:content('C-one'),sourceComplete:true,summarize});
 await assert.rejects(tree.publishLeaf({conversationId:'C-two',sourceFingerprint:digest('two'),content:content('C-two'),sourceComplete:true,
  summarize:async({children})=>({text:'x',guide:'x',entries:[{text:'x',refs:[`${children[0].ref}#I999999`]}]})}),/DIRECT_CHILD/);
 assert.equal(Object.keys(tree.state().conversations).length,1);
});
test('direct child slash notation is normalized only for an existing versioned child entry',async t=>{
 const tree=fixture(t);await tree.publishLeaf({conversationId:'C-one',sourceFingerprint:digest('one'),content:content('C-one'),sourceComplete:true,summarize});
 const result=await tree.publishLeaf({conversationId:'C-two',sourceFingerprint:digest('two'),content:content('C-two'),sourceComplete:true,
  summarize:async({children})=>({text:'合成两段',guide:'直接孩子',entries:children.map(child=>({text:child.content.text,refs:[`${child.ref}/I01`]}))})});
 assert.ok(tree.read(result.root).content.entries.every(entry=>entry.refs[0].includes('#I01')));
 const before=tree.state().revision;
 await assert.rejects(tree.publishLeaf({conversationId:'C-three',sourceFingerprint:digest('three'),content:content('C-three'),sourceComplete:true,
  summarize:async({children})=>({text:'x',guide:'x',entries:[{text:'x',refs:[`${children[0].ref}/I999999`]}]})}),/DIRECT_CHILD/);
 assert.equal(tree.state().revision,before);
});
test('interrupted parent publication preserves leaf and intermediate identities so completed generation is reused',async t=>{
 const tree=fixture(t);await tree.publishLeaf({conversationId:'C-one',sourceFingerprint:digest('one'),content:content('C-one'),sourceComplete:true,summarize});
 const cache=new Map();let paid=0,interrupt=true;const generate=async data=>{const key=digest(data);if(!cache.has(key)){paid++;cache.set(key,await summarize(data));}return cache.get(key);};
 const original=tree.validateContent.bind(tree);tree.validateContent=(value,sources,options)=>{const result=original(value,sources,options);if(!options?.leaf&&interrupt){interrupt=false;throw new Error('synthetic-interruption-after-completed-generation');}return result;};
 const request={conversationId:'C-two',sourceFingerprint:digest('two'),content:content('C-two'),sourceComplete:true,summarize:generate};
 await assert.rejects(tree.publishLeaf(request),/synthetic-interruption/);const done=await tree.publishLeaf(request);
 assert.equal(paid,1);assert.equal(tree.read(done.root).leaves,2);assert.equal(Object.keys(tree.state().conversations).length,2);
});
