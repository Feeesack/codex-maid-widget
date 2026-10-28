'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
function fixture(t,variant,options={}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'maid-usage-中文 '));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const {ChatUsage}=require(path.join(__dirname,'..',variant,'src/chat-usage.cjs'));
  let now=Date.parse('2026-10-28T00:00:00Z');const ledger=new ChatUsage({projectRoot:root,clock:()=>now,...options});
  return{root,ledger,ChatUsage,clock:()=>now,tick:ms=>now+=ms};
}
for(const variant of ['','macos']){
test(variant+': dedicated native token ledger deduplicates updates and derives turn deltas without charging cache twice',t=>{
  const f=fixture(t,variant),first=f.ledger.begin({id:'request-1',kind:'chat',threadId:'owned',model:'gpt-6.1-sol',effort:'medium',freshThread:true});
  f.ledger.bind(first,{threadId:'owned',turnId:'turn-1'});
  const initial={inputTokens:100,cachedInputTokens:25,outputTokens:20,reasoningOutputTokens:5,totalTokens:120};
  f.ledger.observe({id:first,threadId:'owned',turnId:'turn-1',last:initial,total:initial});f.tick(1000);f.ledger.settle(first,{status:'completed'});
  const second=f.ledger.begin({id:'request-2',kind:'chat',threadId:'owned',turnId:'turn-2',model:'gpt-6.1-terra',effort:'high'});
  const event={id:second,threadId:'owned',turnId:'turn-2',last:{inputTokens:200,cachedInputTokens:50,outputTokens:10,reasoningOutputTokens:2,totalTokens:210},total:{inputTokens:300,cachedInputTokens:75,outputTokens:30,reasoningOutputTokens:7,totalTokens:330}};
  f.ledger.observe(event);f.ledger.observe(event);
  f.ledger.observe({...event,last:{inputTokens:1,outputTokens:1,totalTokens:2},total:{inputTokens:110,outputTokens:21,totalTokens:131}});
  f.tick(2000);f.ledger.settle(second,{status:'completed'});f.tick(1000);f.ledger.settle(second,{status:'completed'});
  const result=f.ledger.list({});assert.equal(result.summary.requests,2);assert.equal(result.summary.tokens.totalTokens,330);assert.equal(result.summary.tokens.inputTokens,300);assert.equal(result.summary.tokens.cachedInputTokens,75);
  assert.equal(result.records.find(row=>row.id===second).durationMs,2000);assert.equal(result.attribution,'companion-only-native-tokens');assert.equal(result.byModel.length,2);
  assert.equal(f.ledger.begin({id:'steer-id',kind:'chat',threadId:'owned',turnId:'turn-2'}),second);assert.equal(f.ledger.list({}).summary.requests,2);
});
test(variant+': missing, partial, reset and unknown telemetry stay explicit across restart',t=>{
  const f=fixture(t,variant),id=f.ledger.begin({id:'resumed',kind:'chat',threadId:'resumed-thread',turnId:'turn',model:'model'});
  f.ledger.observe({id,threadId:'resumed-thread',turnId:'turn',last:{inputTokens:12,outputTokens:3,totalTokens:15},total:{inputTokens:1000,outputTokens:500,totalTokens:1500}});f.ledger.settle(id,{status:'unknown'});
  const missing=f.ledger.begin({id:'missing',kind:'maintenance'});f.ledger.settle(missing,{status:'failed'});
  const partial=f.ledger.begin({id:'partial',kind:'dream'});f.ledger.settle(partial,{status:'cancelled',tokens:{outputTokens:9,reasoningOutputTokens:4}});
  const restored=new f.ChatUsage({projectRoot:f.root,clock:f.clock}),state=restored.list({});assert.equal(state.summary.requests,3);assert.equal(state.summary.unknown,1);assert.equal(state.summary.missingRequests,1);assert.equal(state.summary.partialRequests,2);
  assert.equal(state.records.find(row=>row.id===missing).tokens.totalTokens,null);assert.equal(state.records.find(row=>row.id===id).tokens.totalTokens,15);assert.equal(state.coverage.foregroundHistoricalBackfill,false);
});
test(variant+': date, kind and model filters and pagination return bounded independent summaries',t=>{
  const f=fixture(t,variant);for(let index=0;index<4;index++){const id=f.ledger.begin({id:'record-'+index,kind:index%2?'dream':'chat',model:index%2?'model-b':'model-a'});f.ledger.settle(id,{status:'completed',tokens:{inputTokens:10,outputTokens:2,totalTokens:12}});f.tick(86400000);}
  const state=f.ledger.list({from:'2026-10-29',to:'2026-10-31',kind:'dream',page:2,pageSize:1});assert.equal(state.summary.requests,2);assert.equal(state.summary.tokens.totalTokens,24);assert.equal(state.records.length,1);assert.equal(state.pagination.pages,2);assert.equal(state.byDay.length,2);assert.equal(state.byKind[0].kind,'dream');
  assert.equal(f.ledger.list({model:'model-a'}).summary.requests,2);assert.throws(()=>f.ledger.list({from:'2026-02-30'}),/FILTER/);assert.throws(()=>f.ledger.list({model:'\n'}),/FILTER/);assert.throws(()=>f.ledger.list({path:'untrusted'}),/FILTER/);assert.throws(()=>f.ledger.list({pageSize:101}),/FILTER/);
});
test(variant+': bounded legacy maintenance and dream import is idempotent and never manufactures foreground usage',t=>{
  const f=fixture(t,variant),j=f.ledger.journal;
  j.write('memory/maintenance/generation/task.jsonl',{schema:'codex-maid-generation/1',id:'old-task',model:'old-model',effort:'medium',batches:{one:{stage:'tree',status:'completed',startedAt:Date.parse('2026-10-20T00:00:00Z'),finishedAt:Date.parse('2026-10-20T00:00:01Z'),usage:{inputTokens:50,outputTokens:10,totalTokens:60,raw:'PRIVATE_RAW'}}}});
  j.write('memory/dreaming/state.jsonl',{schema:'codex-maid-dream/2',jobs:[{id:'dream-old',status:'adopted',createdAt:Date.parse('2026-10-21T00:00:00Z'),finishedAt:Date.parse('2026-10-21T00:00:03Z'),model:'dream-model',usage:{inputTokens:20,outputTokens:2,totalTokens:22},taskSnapshot:{text:'PRIVATE_CHAT_BODY'}}]});
  let result=f.ledger.list({});assert.equal(result.summary.requests,2);assert.equal(result.coverage.importedRecords,2);assert.equal(result.summary.tokens.totalTokens,82);assert.ok(result.records.every(row=>row.imported&&row.kind!=='chat'));
  result=new f.ChatUsage({projectRoot:f.root}).list({});assert.equal(result.summary.requests,2);
  const files=[];const walk=dir=>{for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const file=path.join(dir,entry.name);if(entry.isDirectory())walk(file);else files.push(fs.readFileSync(file,'utf8'));}};walk(path.join(f.root,'memory/usage'));
  assert.ok(files.every(value=>!/PRIVATE_RAW|PRIVATE_CHAT_BODY|token_secret|password/.test(value)));
});
test(variant+': usage persistence rejects links and retains recording failure without reading another profile',t=>{
  const f=fixture(t,variant),id=f.ledger.begin({id:'safe',kind:'chat'});assert.ok(id);
  fs.writeFileSync(path.join(f.root,'memory/usage/index.jsonl'),'broken\n');assert.equal(f.ledger.begin({id:'bad',kind:'chat'}),null);assert.equal(f.ledger.error,'CHAT_USAGE_RECORDING_UNAVAILABLE');
  assert.throws(()=>f.ledger.list({}),/JSON|Unexpected|INDEX/);
});
test(variant+': maintenance streaming usage survives an unknown dispatch and completed batch reuse has no extra charge',async t=>{
  const f=fixture(t,variant),{ChatGeneration}=require(path.join(__dirname,'..',variant,'src/chat-generation.cjs'));
  let calls=0;const generation=new ChatGeneration({projectRoot:f.root,countTokens:value=>Buffer.byteLength(value),usageLedger:f.ledger,runtime:{generate:async input=>{calls++;input.onEvent({type:'locator',threadId:'aux',turnId:'turn'});input.onEvent({type:'usage',threadId:'aux',turnId:'turn',last:{inputTokens:4,outputTokens:2,totalTokens:6},total:{inputTokens:4,outputTokens:2,totalTokens:6}});return{status:'completed',threadId:'aux',turnId:'turn',finalText:'{"text":"ok"}',usage:{inputTokens:4,outputTokens:2,totalTokens:6}};}}});
  generation.begin({id:'task',sourceWatermark:'synthetic'});const request={taskId:'task',batchId:'one',stage:'memory',instructions:'PRIVATE_PROMPT',input:'PRIVATE_INPUT',outputSchema:{type:'object',properties:{text:{type:'string'}},required:['text']}};
  await generation.request(request);await generation.request(request);assert.equal(calls,1);assert.equal(f.ledger.list({}).summary.tokens.totalTokens,6);assert.equal(f.ledger.list({}).summary.requests,1);
  generation.runtime.generate=async input=>{input.onEvent({type:'locator',threadId:'aux-unknown',turnId:'turn-unknown'});input.onEvent({type:'usage',threadId:'aux-unknown',turnId:'turn-unknown',last:{inputTokens:8},total:{inputTokens:8}});throw Object.assign(new Error('private server text'),{executionState:'unknown'});};
  await assert.rejects(generation.request({...request,batchId:'unknown'}));const result=f.ledger.list({});assert.equal(result.summary.requests,2);assert.equal(result.summary.unknown,1);assert.equal(result.summary.tokens.inputTokens,12);assert.equal(result.summary.partialRequests,1);
});
}
