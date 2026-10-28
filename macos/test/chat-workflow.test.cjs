'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createChatProject } = require('../src/chat-project.cjs'); const { MemoryStore } = require('../src/chat-memory.cjs');
const { createDefaultPersona } = require('../src/chat-persona.cjs'); const { ChatWorkflow, relocateChatProject } = require('../src/chat-workflow.cjs'); const { createConversation } = require('../src/chat-archive.cjs');
const { LIMITS } = require('../src/chat-policy.cjs');
const { DEFAULT_BUDGET } = require('../src/chat-maintenance.cjs');
function fixture(t) { const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'maid-workflow-')); const project = createChatProject({ parentDir: sandbox, userNickname: '测试' }); const measure = text => Buffer.byteLength(text); const memory = new MemoryStore({ projectRoot: project.root, countTokens: measure }); memory.initialize({ pet_name: '小龙娘', user_nickname: '测试', persona: createDefaultPersona({ user_nickname: '测试' }) }); const result = { sandbox, project, memory, measure }; t.after(async () => { await result.workflow?.history.close(); fs.rmSync(sandbox, { recursive: true, force: true }); }); return result; }
function primeSummary(data) {
 assert.equal(data.inputLimit,LIMITS.node);assert.equal(data.outputLimit,LIMITS.leafPrime);
 const text=data.leaf.content.entries.map(entry=>entry.text).join(';');
 return{text,guide:'完整细节和条件回查原L1。',entries:[{text,refs:[data.leaf.ref]}]};
}
test('real workflow connects native source, archive, extraction, views, unique tree, handoff and confirmed switch', async t => {
  const f = fixture(t), conversation = createConversation({ root: f.project.root, startedAt: '2026-10-26T12:00:00+08:00', timezone: 'Asia/Shanghai', nativeThreadId: 'thread' }); let calls = 0;
  const refs = [`${conversation.conversationId}/M000001/P01`];
  const runtime = {
    async readOwnThread(_id, input) { return input ? { threadId: 'thread', sourceRecoveryVerified: true, data: [{ id: 'turn', status: 'completed', fullItems: true, items: [
      { id: 'user', clientId: 'client', turnId: 'turn', role: 'user', contentComplete: true, content: [{ text: '我有一只叫桃子的猫。' }] },
      { id: 'assistant', turnId: 'turn', role: 'assistant', phase: 'final_answer', content: [{ text: '记得桃子这个名字。' }] }] }], complete: true, nextCursor: null } : { status: 'idle' }; },
    async generate(input) { calls++; const data = JSON.parse(input.input); let output;
      if (input.instructions.includes('提取明确事实')) output = { summary: {text:'用户介绍了猫桃子。',guide:'猫名字可回原文核对。',entries:[{text:'猫叫桃子。',refs}]}, changes: [{ module: 'facts', action: 'upsert', automatic: false, payload: JSON.stringify({ entry: { id: 'F-cat', kind: 'fact', content: '用户的猫叫桃子', certainty: 'explicit' } }), refs }] };
      else if (input.instructions.includes('压缩预输入')) output = { segments: [{ text: '用户的猫叫桃子', refs: ['F-cat@1'], kind: 'fact' }] };
      else if (data.leaf) output = primeSummary(data);
      else if (input.instructions.includes('递归交接')) output = { text: '刚聊到用户的猫桃子。', refs };
      else output = { text: '用户介绍了猫桃子。', guide: '猫名字可回原文核对。', entries: [{ text: '猫叫桃子。', refs }] };
      return { status: 'completed', finalText: JSON.stringify(output) };
    }
  };
  const workflow = new ChatWorkflow({ ...f, projectRoot: f.project.root, runtime }); f.workflow = workflow;
  assert.equal(workflow.prepareStartup({ requestId: 'first', window: 64000 }).ready, true);
  const input = { conversation, cutoffTurnId: 'turn', terminal: 'completed', window: 64000, clientOperations: new Map([['client', { kind: 'send', delivered: true, turnId: 'turn', observedAt: '2026-10-26T12:00:01+08:00' }]]) };
  const result = await workflow.checkpoint(input); assert.equal(result.state, 'startup-ready'); assert.equal(f.memory.getModule('facts').entries[0].content, '用户的猫叫桃子');
  assert.equal(Object.keys(workflow.tree.state().conversations).length, 1); assert.equal(workflow.confirmSwitch({ taskId: result.taskId, newThreadId: 'next', operationWatermark: result.startup.operationWatermark }).state, 'completed');
  const list = workflow.history.listConversations(); assert.equal(list.conversations.length, 1); const read = await workflow.history.readConversation({ conversationId: conversation.conversationId }); assert.equal(read.messages[0].text, '我有一只叫桃子的猫。');
  const found = await workflow.history.searchRecords({ queries: ['桃子'] }, workflow.history.beginTurn()); assert.ok(found.cards.some(card => card.text.includes('桃子'))); assert.equal(calls, 4);
});
test('restoration creates new revisions, preserves exclusions and persona defaults retain names', t => {
  const f = fixture(t); f.memory.save({ module: 'persona', baseVersion: 1, operationId: 'rename', action: 'upsert', payload: { names: { pet_name: '晴' } } });
  f.memory.restorePersonaDefaults({ operationId: 'defaults', baseVersion: 2 }); assert.equal(f.memory.getModule('persona').names.pet_name, '晴');
  const history = f.memory.history('persona'); assert.ok(history.revisions.length >= 3); const current = f.memory.getModule('persona'); f.memory.restore({ module: 'persona', revision: 1, baseVersion: current.version, operationId: 'restore' }); assert.equal(f.memory.getModule('persona').version, current.version + 1);
});
test('two real checkpoints recursively combine the previous handoff with each new L1 and exact latest original',async t=>{
 const f=fixture(t),handoffs=[],extracts=[],history={close(){},syncIndex:async()=>({status:'ready'})};
 const originals=new Map([['recursive-one','第一段合成原话：不要删除原件。'],['recursive-two','第二段合成原话：把交接期限改为周六。']]);
 let active;
 const runtime={
  async readOwnThread(threadId,input){if(!input)return{status:'idle'};return{threadId,sourceRecoveryVerified:true,complete:true,nextCursor:null,data:[{id:`turn-${threadId}`,status:'completed',fullItems:true,items:[{id:`user-${threadId}`,turnId:`turn-${threadId}`,role:'user',contentComplete:true,content:[{text:originals.get(threadId)}]}]}]};},
  async generate(input){const data=JSON.parse(input.input);let output;
   if(input.instructions.includes('提取明确事实')){extracts.push(input);const refs=data.sources.map(source=>source.ref);output={changes:[],summary:{text:`${active.title} ${'x'.repeat(7000)}`,guide:'synthetic original lookup',entries:[{text:originals.get(active.nativeThreadId),refs}]}};}
   else if(data.leaf)output=primeSummary(data);
   else if(input.instructions.includes('递归交接')){handoffs.push(data);assert.ok(Buffer.byteLength(JSON.stringify(data.current))>6000);assert.ok(input.maxOutputTokens>1800);assert.ok(input.maxOutputTokens<=LIMITS.handoffSummary);const marker=originals.get(active.nativeThreadId);assert.ok(data.latest.some(original=>original.text.includes(marker)));if(handoffs.length===1)assert.equal(data.previous,null);else assert.match(data.previous.text,/第一段合成原话/);output={text:[data.previous?.text,marker].filter(Boolean).join('；'),refs:[data.latest.at(-1).ref]};}
   else if(input.instructions.includes('合并最多4个直接下级'))output={text:'两段已归纳，当前期限周六。',guide:'synthetic versioned children',entries:data.children.map(child=>({text:child.content.entries[0].text,refs:[`${child.ref}#I01`]}))};
   else throw new Error(`unexpected generation stage ${input.purpose}`);
   return{status:'completed',finalText:JSON.stringify(output)};
  }
 };
 const workflow=new ChatWorkflow({...f,projectRoot:f.project.root,runtime,history});f.workflow=workflow;
 for(const [index,threadId]of [...originals.keys()].entries()){
  active=createConversation({root:f.project.root,startedAt:`2026-10-26T12:00:0${index}+08:00`,timezone:'Asia/Shanghai',nativeThreadId:threadId});
  const result=await workflow.checkpoint({conversation:active,cutoffTurnId:`turn-${threadId}`,terminal:'completed',window:128000});assert.equal(result.state,'startup-ready');
  workflow.confirmSwitch({taskId:result.taskId,newThreadId:`after-${threadId}`,operationWatermark:result.startup.operationWatermark});
 }
 assert.equal(extracts.length,2);assert.equal(handoffs.length,2);assert.equal(workflow.handoff.current().version,2);
 assert.match(workflow.handoff.current().modelView.summary.text,/第一段合成原话/);assert.match(workflow.handoff.current().modelView.summary.text,/第二段合成原话/);
 assert.equal(workflow.tree.read(workflow.tree.state().root).leaves,2);
});
test('near-limit summaries with eighty entries publish both leaves and parents after stable IDs are assigned',async t=>{
 const f=fixture(t),requests=[],history={close(){},syncIndex:async()=>({status:'ready'})};
 const runtime={
  async readOwnThread(threadId,input){return input?{threadId,sourceRecoveryVerified:true,complete:true,nextCursor:null,data:[{id:'turn',status:'completed',fullItems:true,items:[{id:'user',turnId:'turn',role:'user',contentComplete:true,content:[{text:'Eighty synthetic source details remain available in the archive.'}]}]}]}:{status:'idle'};},
  async generate(input){const data=JSON.parse(input.input);let output;
   if(input.instructions.includes('提取明确事实')||input.instructions.includes('合并最多4个直接下级')){
    const extraction=Array.isArray(data.sources),summary={text:'',guide:'all eighty source entries',entries:Array.from({length:80},(_,index)=>({text:`synthetic fact ${index+1}`,refs:[extraction?data.sources[0].ref:`${data.children[index%data.children.length].ref}#I${String(index+1).padStart(2,'0')}`]}))};
    output=extraction?{changes:[],summary}:summary;
    summary.text='x'.repeat(input.maxOutputTokens-Buffer.byteLength(JSON.stringify(output)));
    assert.equal(Buffer.byteLength(JSON.stringify(output)),input.maxOutputTokens);assert.ok(input.maxOutputTokens>17000);assert.ok(input.maxOutputTokens<LIMITS.node);
    assert.ok(summary.entries.every(entry=>!Object.hasOwn(entry,'id')));requests.push({extraction,bytes:Buffer.byteLength(JSON.stringify(summary))});
   }else if(data.leaf){assert.equal(data.leaf.content.entries.length,80);output=primeSummary(data);}
   else if(input.instructions.includes('递归交接'))output={text:'Eighty source facts were archived.',refs:[data.latest[0].ref]};
   else throw new Error(`unexpected generation stage ${input.purpose}`);
   return{status:'completed',finalText:JSON.stringify(output)};
  }
 };
 const workflow=new ChatWorkflow({...f,projectRoot:f.project.root,runtime,history});f.workflow=workflow;
 for(let index=0;index<4;index++){
  const conversation=createConversation({root:f.project.root,startedAt:`2026-10-26T12:00:0${index}+08:00`,timezone:'Asia/Shanghai',nativeThreadId:`eighty-${index}`});
  const result=await workflow.checkpoint({conversation,cutoffTurnId:'turn',terminal:'completed',window:128000});assert.equal(result.state,'startup-ready');
  for(const reference of new Set([result.tree.leaf,...(index===3?[result.tree.root]:[])])){
   const node=workflow.tree.read(reference),bytes=Buffer.byteLength(JSON.stringify(node.content));assert.ok(bytes>19000);assert.ok(bytes<=LIMITS.node);assert.equal(node.content.entries.length,80);
   assert.deepEqual(node.content.entries.map(entry=>entry.id),Array.from({length:80},(_,i)=>`I${String(i+1).padStart(2,'0')}`));assert.equal(node.content.entries[79].text,'synthetic fact 80');
  }
  const root=workflow.tree.read(result.tree.root);assert.equal(root.leaves,index+1);assert.equal(root.level,2);
  assert.ok(Buffer.byteLength(JSON.stringify(root.content))<=LIMITS.root);
  if(index<3){assert.equal(root.status,0);assert.equal(root.integration.tail.length,index+1);}
  else{assert.equal(root.status,2);assert.equal(root.children.length,4);assert.ok(root.content.entries.every(entry=>entry.refs.every(reference=>root.children.some(child=>reference.startsWith(`${child}#`)))));}
  workflow.confirmSwitch({taskId:result.taskId,newThreadId:`after-eighty-${index}`,operationWatermark:result.startup.operationWatermark});
 }
 assert.deepEqual(requests.map(request=>request.extraction),[true,true,true,true,false]);assert.equal(workflow.tree.read(workflow.tree.state().root).leaves,4);
});
test('UTF8 upper-bound startup is locally ready and an explicit baseline edit is applied to the next request without a model', t => {
  const f = fixture(t), workflow = new ChatWorkflow({ ...f, projectRoot: f.project.root, runtime: { generate: async () => { throw new Error('must not generate'); } } }); f.workflow = workflow;
  const first = workflow.prepareStartup({ requestId: 'first', window: 64000 }); assert.equal(first.ready, true); assert.ok(first.tokens < LIMITS.root+LIMITS.persona+2*LIMITS.views+LIMITS.handoff);
  f.memory.save({ module: 'persona', operationId: 'core-edit', baseVersion: 1, action: 'upsert', payload: { persona: { core: ['认真而温暖的新风格。'], boundaries: ['禁止冒充真实经历。'] } } });
  const second = workflow.prepareStartup({ requestId: 'next', window: 64000 }); assert.equal(second.ready, true); assert.match(second.content, /认真而温暖的新风格/); assert.doesNotMatch(second.content, /犯错坦率承认/);
});
test('relocation copies and verifies every byte without removing the original or allowing nested copies', t => {
  const f = fixture(t); assert.throws(() => relocateChatProject({ projectRoot: f.project.root, parentDir: f.project.root }), /OVERLAP/);
  const parent = path.join(f.sandbox, '自定义 中文 目录'); fs.mkdirSync(parent); const moved = relocateChatProject({ projectRoot: f.project.root, parentDir: parent }); assert.equal(moved.originalPreserved, true); assert.ok(fs.existsSync(path.join(f.project.root, 'project.json'))); assert.ok(fs.existsSync(path.join(moved.root, 'project.json')));
});

test('stop and close preserve a completed checkpoint so a new conversation can checkpoint after reopening',async t=>{
 const f=fixture(t), runtime={generate:async()=>{throw new Error('unused');}}, workflow=new ChatWorkflow({...f,projectRoot:f.project.root,runtime}); f.workflow=workflow;
 workflow.journal.write('memory/maintenance/workflow.jsonl',{id:'completed-job',sourceIdentity:'old',state:'completed',completed:{switch:true}});
 assert.equal(workflow.stop().state,'completed'); workflow.close(); assert.equal(workflow.status().state,'completed');
 const next=new ChatWorkflow({...f,projectRoot:f.project.root,runtime:{...runtime,readOwnThread:async()=>{throw new Error('reached-new-native');}}}); f.workflow=next;
 const conversation=createConversation({root:f.project.root,startedAt:'2026-10-26T12:00:00+08:00',timezone:'Asia/Shanghai',nativeThreadId:'new'});
 await assert.rejects(next.checkpoint({conversation,cutoffTurnId:'new-turn',terminal:'completed',window:64000}),/reached-new-native/);
 next.journal.write('memory/maintenance/workflow.jsonl',{id:'ready-job',state:'startup-ready',completed:{archive:true}}); assert.equal(next.stop().state,'startup-ready');
});



test('one MiB Chinese source uses one bounded call per source batch and stays inside the shared finite task ledger',async t=>{
 const f=fixture(t),text='这是一段合成的中文压力资料，保留最后否定，不是现实聊天。'.repeat(16000),conversation=createConversation({root:f.project.root,startedAt:'2026-10-26T12:00:00+08:00',timezone:'Asia/Shanghai',nativeThreadId:'large'}); let calls=0;
 assert.ok(Buffer.byteLength(text)>1024*1024);
 const runtime={readOwnThread:async(_id,input)=>input?{threadId:'large',sourceRecoveryVerified:true,complete:true,nextCursor:null,data:[{id:'turn',status:'completed',fullItems:true,items:[{id:'user',turnId:'turn',role:'user',contentComplete:true,content:[{text}]}]}]}:{status:'idle'},generate:async input=>{
  calls++; assert.ok(Buffer.byteLength(JSON.stringify({instructions:input.instructions,input:input.input,outputSchema:input.outputSchema}))<=30000);
  const data=JSON.parse(input.input),ref=data.sources?.at(-1)?.ref||`${conversation.conversationId}/M000001/P01`;
  if(data.leaf)return{status:'completed',finalText:JSON.stringify(primeSummary(data))};
  return{status:'completed',finalText:JSON.stringify(input.instructions.includes('提取明确事实')?{changes:[],summary:{text:'合成资料末尾否定。',guide:'合成压力资料',entries:[{text:'不要推断现实事实。',refs:[ref]}]}}:{text:'合成资料已交接。',refs:[ref]})};
 }};
 const workflow=new ChatWorkflow({...f,projectRoot:f.project.root,runtime});f.workflow=workflow;
 const result=await workflow.checkpoint({conversation,cutoffTurnId:'turn',terminal:'completed',window:64000});assert.equal(result.state,'startup-ready');
 const status=workflow.status();t.diagnostic(JSON.stringify({sourceBytes:Buffer.byteLength(text),calls,used:status.used,limits:status.limits}));assert.ok(calls<96);assert.ok(status.used.input<=status.limits.input);assert.ok(status.used.output<=DEFAULT_BUDGET.output);assert.equal(status.plan.length,7);assert.equal(status.used.calls,calls);assert.equal(Object.keys(workflow.tree.state().conversations).length,1);
});
test('local dreaming distinguishes exact semantic duplicates, references, and expiration without model calls or completed-event inference',async t=>{
 const f=fixture(t),workflow=new ChatWorkflow({...f,projectRoot:f.project.root,runtime:{generate:async()=>{throw new Error('forbidden');}}});f.workflow=workflow;
 f.memory.save({module:'facts',operationId:'one',baseVersion:1,action:'upsert',payload:{entry:{id:'F-one',kind:'plan',content:'合成旧计划',valid_to:'2020-01-01T00:00:00Z',event_status:'proposed'}}});
 f.memory.save({module:'facts',operationId:'two',baseVersion:2,action:'upsert',payload:{entry:{id:'F-two',kind:'plan',content:'合成旧计划',valid_to:'2020-01-01T00:00:00Z',event_status:'cancelled'}}});
 const duplicate=await workflow.dream({action:'check',target:'duplicates'});assert.equal(duplicate.checks.result.duplicates.length,0);
 const expired=await workflow.dream({action:'check',target:'expired'});assert.equal(expired.checks.result.expired.length,2);assert.equal(expired.checks.result.expired[0].treatment,'filtered-without-inferring-completion');assert.equal(f.memory.getModule('facts').entries[0].event_status,'proposed');
 const refs=await workflow.dream({action:'check',target:'references'});assert.equal(refs.checks.result.invalidReferences.length,0);assert.equal(refs.modelRequests,0);assert.equal(refs.paid.guarantee,false);
});


test('completed extraction is repaired and reused even when the new per-batch output allowance is below the dispatch minimum',async t=>{
 const {normalizeExtraction}=require('../src/chat-workflow.cjs'), f=fixture(t),change={module:'facts',payload:JSON.stringify({entry:{id:'synthetic-acceptance-context',kind:'fact',content:'合成验收资料',event_status:'已回复，后续未知'}})};
 const normalized=normalizeExtraction(change,f.memory.getState());assert.match(normalized.entry.id,/^F-[a-f0-9]{40}$/);assert.equal(normalized.entry.event_status,'unknown');assert.match(normalized.entry.followup,/已回复，后续未知/);assert.deepEqual(normalizeExtraction(change,f.memory.getState()),normalized);
 const conversation=createConversation({root:f.project.root,startedAt:'2026-10-26T12:00:00+08:00',timezone:'Asia/Shanghai',nativeThreadId:'repair'}),ref=`${conversation.conversationId}/M000001/P01`;let extracts=0,blocked=true;
 const runtime={readOwnThread:async(_id,input)=>input?{threadId:'repair',sourceRecoveryVerified:true,complete:true,nextCursor:null,data:[{id:'turn',status:'completed',fullItems:true,items:[{id:'user',turnId:'turn',role:'user',contentComplete:true,content:[{text:'合成验收资料'}]}]}]}:{status:'idle'},generate:async input=>{const data=JSON.parse(input.input);if(data.leaf)return{status:'completed',finalText:JSON.stringify(primeSummary(data))};if(input.instructions.includes('提取明确事实')){extracts++;return{status:'completed',finalText:JSON.stringify({changes:[{...change,action:'upsert',automatic:false,refs:[ref]}],summary:{text:'合成验收。',guide:'原文',entries:[{text:'合成资料。',refs:[ref]}]}})};}if(input.instructions.includes('压缩预输入'))return{status:'completed',finalText:JSON.stringify({segments:[{text:'合成验收资料，后续未知。',kind:'fact',refs:[`${normalized.entry.id}@1`]}]})};return{status:'completed',finalText:JSON.stringify({text:'合成资料。',refs:[ref]})};}};
 const original=f.memory.commitCheckpoint.bind(f.memory);f.memory.commitCheckpoint=input=>{if(blocked){blocked=false;throw Object.assign(new Error('simulated-commit-failure'),{code:'MEMORY_INPUT'});}return original(input);};
 const workflow=new ChatWorkflow({...f,projectRoot:f.project.root,runtime});f.workflow=workflow;const input={conversation,cutoffTurnId:'turn',terminal:'completed',window:64000};await assert.rejects(workflow.checkpoint(input),/simulated/);
 const interrupted=workflow.status(),ledger=workflow.generator.task(interrupted.id),reserved=LIMITS.views*3+LIMITS.handoffSummary+LIMITS.leafPrime*LIMITS.children;ledger.limits.output=reserved+1000;workflow.journal.write(`memory/maintenance/generation/${ledger.id}.jsonl`,ledger);
 assert.equal(ledger.limits.output-reserved,1000);assert.ok(Object.values(ledger.batches).some(batch=>batch.status==='completed'));
 const result=await workflow.resume({...input,clientOperations:new Map(),loadedVersions:new Map()});assert.equal(result.state,'startup-ready');assert.equal(extracts,1);assert.equal(f.memory.getModule('facts').entries[0].event_status,'unknown');assert.ok(workflow.status().used.output<=ledger.limits.output);
});


test('temporary persona shares the expanded package and projects only compact allowed state fields',t=>{
 const f=fixture(t),workflow=new ChatWorkflow({...f,projectRoot:f.project.root,runtime:{generate:async()=>{throw new Error('no maintenance');}}});f.workflow=workflow;
 const ready=workflow.prepareStartup({requestId:'temp',window:64000,temporaryPersona:{emotion:{label:'小得意',phase:'faint',remaining:1,source:{text:'must not enter input'}}}});assert.equal(ready.ready,true);assert.match(ready.content,/小得意/);assert.doesNotMatch(ready.content,/must not enter input/);
 const expanded=workflow.prepareStartup({requestId:'large-temp',window:64000,temporaryPersona:{emotion:{label:'糖'.repeat(500),phase:'natural',remaining:3}}});assert.equal(expanded.ready,true);assert.ok(expanded.tokens>2000);
 const rejected=workflow.prepareStartup({requestId:'invalid-temp',window:64000,temporaryPersona:{emotion:{label:'糖'.repeat(501),phase:'natural',remaining:3}}});assert.equal(rejected.ready,false);assert.equal(rejected.reason,'CHAT_TEMPORARY_PERSONA_INVALID');
});

test('resuming an archived stage rejects externally changed original image bytes before any generation',async t=>{
 const {createHash}=require('node:crypto'),f=fixture(t),workflow=new ChatWorkflow({...f,projectRoot:f.project.root,runtime:{generate:async()=>{throw new Error('must not dispatch');}}});f.workflow=workflow;
 const conversation=createConversation({root:f.project.root,startedAt:'2026-10-26T12:00:00+08:00',timezone:'Asia/Shanghai',nativeThreadId:'image-recovery'}),{commitCheckpoint}=require('../src/chat-archive.cjs');
 const bytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jX1cAAAAASUVORK5CYII=','base64');
 const native={id:'turn',status:'completed',fullItems:true,items:[{id:'user',turnId:'turn',role:'user',contentComplete:true,content:[{image:{originalAvailable:true,bytes}}]}]};
 workflow.runtime.readOwnThread=async(_id,input)=>input?{threadId:'image-recovery',sourceRecoveryVerified:true,complete:true,nextCursor:null,data:[native]}:{status:'idle'};
 const archived=commitCheckpoint({root:f.project.root,conversation,records:[{turn:{id:'T1',native_turn_id:'turn',observed_at:null}},{id:'M1',native_message_id:'user',turn_id:'T1',role:'user',time:null,content:[{image:{bytes}}]},{turn_result:{id:'T1',observed_at:null,status:'completed'}}],trigger:'new-conversation',sourceComplete:true});
 const sourceIdentity=createHash('sha256').update(JSON.stringify({threadId:'image-recovery',cutoffTurnId:'turn',conversationId:conversation.conversationId})).digest('hex');
 workflow.journal.write('memory/maintenance/workflow.jsonl',{id:'image-job',sourceIdentity,state:'failed',completed:{archive:{relativePath:archived.relativePath,sha256:archived.sha256}}});
 const source=fs.readFileSync(path.join(f.project.root,archived.relativePath),'utf8').split('\n').filter(Boolean).map(line=>JSON.parse(line)),relative=source.find(record=>record.id).content[0].image.path;
 const corrupted=Buffer.from(bytes);corrupted[corrupted.length-1]^=1;fs.writeFileSync(path.join(f.project.root,relative),corrupted);
 await assert.rejects(workflow.resume({conversation,cutoffTurnId:'turn',terminal:'completed',window:64000}),/CHAT_ARCHIVE_IMAGE_CHANGED/);assert.equal(workflow.generator.task('image-job'),null);
});

function dreamingFixture(t) {
 const f=fixture(t),now=1000000000,environment={foreground:false,maintenance:false,recovering:false,drafts:false,lastInputAt:now-1800001};let modelCalls=0;
 f.memory.resolveSource=source=>({verified:true,complete:true,eventId:`event-${source.conversationId}`,originalTurnId:`turn-${source.conversationId}`,at:'2026-10-25T12:00:00Z',localDate:'2026-10-25'});
 const source=conversationId=>({type:'chat',conversationId,messageId:'M1',part:'P01'});
 f.memory.commitCheckpoint({taskId:'synthetic-committed',baseVersions:{facts:1},operationWatermark:f.memory.getState().operationWatermark,sourceWatermark:'synthetic-covered',patches:[
  {module:'facts',action:'upsert',automatic:false,payload:{entry:{id:'F-a',kind:'fact',content:'合成的猫桃子喜欢安静。',certainty:'tentative',sources:[source('C-one')]}}},
  {module:'facts',action:'upsert',automatic:false,payload:{entry:{id:'F-b',kind:'fact',content:'合成的猫桃子使用皇家糖罐。',certainty:'tentative',sources:[source('C-two')]}}}
 ]});
 const facts=f.memory.getModule('facts');f.memory.publishPreinput({module:'facts',baseVersion:facts.version,segments:facts.entries.map(entry=>({text:entry.content,refs:[`${entry.id}@${entry.rev}`],kind:'fact'}))});
 let conversation;
 const runtime={quotaObservation:async()=>({authType:'chatgpt',windowMinutes:300,observedAt:now,scope:'synthetic-account-scope',windowId:'synthetic-five-hour',remaining:80-modelCalls,weekBlocked:false}),
  readOwnThread:async(threadId,input)=>input?{threadId,sourceRecoveryVerified:true,complete:true,nextCursor:null,data:[{id:'next-turn',status:'completed',fullItems:true,items:[{id:'next-user',turnId:'next-turn',role:'user',contentComplete:true,content:[{text:'这是一句不改变旧记忆的合成话语。'}]}]}]}:{threadId,status:'idle'},
  generate:async input=>{if(input.purpose==='dream'){modelCalls++;input.dreamPermit.guard();input.onEvent({type:'locator',threadId:'dream-owned',turnId:'dream-turn'});const data=JSON.parse(input.input);return{status:'completed',finalText:JSON.stringify({text:'整理合成猫的共同主题。',changes:[{target:data.entries[0].ref,kind:'organize',content:'合成猫桃子喜欢安静，使用皇家糖罐。',refs:data.entries.map(entry=>entry.ref),evidence:data.evidence.filter(item=>item.kind==='original').map(item=>item.id)}]})};}
   if(input.instructions.includes('压缩预输入')){const data=JSON.parse(input.input);return{status:'completed',finalText:JSON.stringify({segments:data.entries.map(entry=>({text:'合成猫桃子喜欢安静，使用皇家糖罐。',refs:[entry.ref],kind:'fact'}))})};}
   const data=JSON.parse(input.input);if(data.leaf)return{status:'completed',finalText:JSON.stringify(primeSummary(data))};
   const ref=`${conversation.conversationId}/M000001/P01`;return{status:'completed',finalText:JSON.stringify(input.instructions.includes('提取明确事实')?{changes:[],summary:{text:'无新的长期事实。',guide:'合成问候',entries:[{text:'合成问候。',refs:[ref]}]}}:{text:'合成问候已交接。',refs:[ref]})};}
 };
 const history={close(){},syncIndex:async()=>({status:'ready'}),resolveReference:()=>({text:'已提交合成来源'})};
 const options={...f,projectRoot:f.project.root,runtime,history,clock:()=>now,getDreamEnvironment:()=>environment};
 const workflow=new ChatWorkflow(options);f.workflow=workflow;
 return{...f,workflow,runtime,options,environment,get calls(){return modelCalls;},setConversation:value=>{conversation=value;}};
}
test('estimated model candidate stays separate and a real next checkpoint appends a source-backed formal memory revision',async t=>{
 const f=dreamingFixture(t),original=JSON.stringify(f.memory.getModule('facts').entries);
 const result=await f.workflow.dream({action:'run',target:'organize'});assert.equal(result.state,'candidate');assert.equal(result.paid.guarantee,false);assert.equal(result.budget.mode,'estimate');assert.equal(result.observation.attribution,'shared');assert.equal(result.observation.sameWindowChange,1);assert.equal(f.calls,1);
 assert.equal(JSON.stringify(f.memory.getModule('facts').entries),original);assert.equal(f.memory.getModule('facts').preinput.revision,1);
 const conversation=createConversation({root:f.project.root,startedAt:'2026-10-26T12:00:00Z',timezone:'Asia/Shanghai',nativeThreadId:'next-native'});f.setConversation(conversation);
 const checkpoint=await f.workflow.checkpoint({conversation,cutoffTurnId:'next-turn',terminal:'completed',window:64000});assert.equal(checkpoint.state,'startup-ready');
 assert.equal(f.workflow.dreamSnapshot().jobs[0].status,'adopted');assert.equal(f.memory.getModule('facts').preinput.revision,2);assert.notEqual(JSON.stringify(f.memory.getModule('facts').entries),original);assert.equal(f.memory.revision('facts',2).snapshot.entries[0].content,'合成的猫桃子喜欢安静。');assert.equal(f.calls,1);
 assert.match(checkpoint.startup.content,/使用皇家糖罐/);
});
test('new management save invalidates pending dream without a second paid review or resurrecting old content',async t=>{
 const f=dreamingFixture(t);await f.workflow.dream({action:'run',target:'organize'});const facts=f.memory.getModule('facts');
 f.memory.save({module:'facts',operationId:'later-correction',baseVersion:facts.version,action:'withdraw',payload:{id:'F-a'}});
 await f.workflow._adoptDreams({id:'next-checkpoint'});assert.equal(f.workflow.dreamSnapshot().jobs[0].status,'discarded');assert.equal(f.memory.filterEvidence('F-a@1').allowed,false);assert.equal(f.calls,1);
});
test('automatic scheduling uses eight distinct completed checkpoints, long cooldown and idle time; drafts defer it',async t=>{
 const f=dreamingFixture(t);f.workflow.journal.write('memory/dreaming/schedule.jsonl',{checkpoints:8,seen:['synthetic'],initializedAt:0});
 f.workflow.dreamCatalog.recordSignals({checkpointId:'synthetic-checkpoint',sourceWatermark:'source',signals:[{kind:'distributed',topic:'合成跨检查点猫资料',targets:['F-a@1','F-b@1'],sources:['C-one/M1/P01']}],allowedSources:new Set(['C-one/M1/P01'])});
 assert.equal(f.workflow.nextDreamAt(f.environment.lastInputAt),f.environment.lastInputAt+1800000);
 f.environment.drafts=true;let result=await f.workflow.dream({action:'automatic'});assert.equal(result.state,'budget-not-ready');assert.ok(result.missing.includes('foreground-priority'));assert.equal(f.calls,0);
 f.environment.drafts=false;result=await f.workflow.dream({action:'automatic'});assert.equal(result.state,'candidate');assert.equal(result.job.mode,'automatic');assert.equal(result.job.limit,5);assert.equal(f.calls,1);
});
test('unknown dream survives restart and is reconciled by owned locator without resending',async t=>{
 const f=dreamingFixture(t);let calls=0;f.runtime.generate=async input=>{calls++;input.onEvent({type:'locator',threadId:'dream-owned',turnId:'dream-turn'});throw Object.assign(new Error('lost-ack'),{executionState:'unknown'});};
 const result=await f.workflow.dream({action:'run',target:'organize'});assert.equal(result.state,'unknown');
 const reopened=new ChatWorkflow(f.options);assert.equal((await reopened.dream({action:'run',target:'organize'})).state,'unknown');assert.equal(calls,1);
 f.runtime.readOwnThread=async()=>({threadId:'dream-owned',sourceRecoveryVerified:true,complete:true,data:[{id:'dream-turn',status:'completed',items:[{role:'assistant',phase:'final_answer',content:[{text:JSON.stringify({text:'恢复合成主题。',changes:[{target:'F-a@1',kind:'organize',content:'合成猫桃子喜欢安静并使用皇家糖罐。',refs:['F-a@1','F-b@1'],evidence:['E1','E2']}]})}]}]}]});
 const reconciled=await reopened.dream({action:'reconcile'});assert.equal(reconciled.state,'candidate');assert.equal(reconciled.job.id,result.job.id);assert.equal(calls,1);assert.equal(reconciled.job.reservedPoints,3);reopened.close();
});
test('missing scheduling file is a safe initialized baseline, and interrupted unreserved task resumes same identity',async t=>{
 const f=dreamingFixture(t),task=f.workflow._dreamTask('organize','manual');assert.ok(f.workflow._dreamSchedule().initializedAt>0);
 const pending=f.workflow.dreams.begin({mode:'manual',task,quota:await f.runtime.quotaObservation(),environment:f.environment});
 const reopened=new ChatWorkflow(f.options);const result=await reopened.dream({action:'run',target:'organize'});
 assert.equal(result.state,'candidate');assert.equal(result.job.id,pending.id);assert.equal(f.calls,1);reopened.close();
});
test('the same committed maintenance scope cannot run twice by changing duplicates to organize',async t=>{
 const f=dreamingFixture(t);f.runtime.generate=async()=>{return{status:'completed',finalText:JSON.stringify({text:'没有需要调整的表达。',changes:[]})};};let calls=0;const generate=f.runtime.generate;f.runtime.generate=async input=>{calls++;return generate(input);};
 const first=await f.workflow.dream({action:'run',target:'duplicates'});assert.equal(first.state,'no-change');
 const second=await f.workflow.dream({action:'run',target:'organize'});assert.equal(second.job.id,first.job.id);assert.equal(calls,1);assert.equal(second.job.calls,1);
});
test('confirmed terminal invalid output exits unknown without retry or releasing its spent estimate',async t=>{
 const f=dreamingFixture(t);let calls=0;f.runtime.generate=async input=>{calls++;input.onEvent({type:'locator',threadId:'dream-owned',turnId:'dream-turn'});throw Object.assign(new Error('lost'),{executionState:'unknown'});};
 const first=await f.workflow.dream({action:'run',target:'organize'});assert.equal(first.state,'unknown');
 f.runtime.readOwnThread=async()=>({sourceRecoveryVerified:true,complete:true,data:[{id:'dream-turn',status:'completed',items:[{role:'assistant',phase:'final_answer',content:[{text:'invalid final JSON'}]}]}]});
 const reconciled=await f.workflow.dream({action:'reconcile'});assert.equal(reconciled.state,'failed');assert.equal(reconciled.job.reservedPoints,3);assert.equal(reconciled.job.calls,1);
 await f.workflow.dream({action:'run',target:'duplicates'});assert.equal(calls,1);
});
test('legacy interrupted parent recovers only a leaf ID whose rebuilt input matches its completed artifact batch',async t=>{
 const {digest}=require('../src/chat-summary.cjs'),f=dreamingFixture(t),workflow=f.workflow;
 workflow.tree.resolveSource=()=>true;const leafContent={text:'合成首段',guide:'原文',entries:[{text:'首段',refs:['C-first/M1/P01']}]};
 await workflow.tree.publishLeaf({conversationId:'C-first',sourceFingerprint:digest('first'),content:leafContent,sourceComplete:true});
 const old=workflow.tree.state(),published=workflow.tree.read(old.root),id='L1-11111111-1111-1111-1111-111111111111',content={text:'合成次段',guide:'原文',entries:[{id:'I01',text:'次段',refs:['C-second/M1/P01']}]};
 const data={level:2,children:[{ref:old.root,content:published.content},{ref:`${id}@v1`,content}],inputLimit:24000,outputLimit:6000},name=`parent-${digest(data).slice(0,24)}`;
 const task=workflow.generator.begin({id:'legacy-job',sourceWatermark:'synthetic',operationWatermark:0}),artifact='memory/maintenance/results/legacy.jsonl',output={text:'两段',guide:'孩子',entries:[{text:'次段',refs:[`${id}@v1/I01`]}]};
 workflow.journal.write(artifact,{output});task.batches[name]={status:'completed',artifact,outputDigest:digest(output)};workflow.journal.write('memory/maintenance/generation/legacy-job.jsonl',task);
 assert.equal(workflow._recoverPreparedLeaf({id:task.id},{content,old}),id);
 assert.throws(()=>workflow._recoverPreparedLeaf({id:task.id},{content:{...content,text:'changed'},old}),/PREPARATION_REPAIR_REQUIRED/);
});
test('expanded parent capacity reuses completed legacy generations and repairs without paying again',async t=>{
 const {digest}=require('../src/chat-summary.cjs'),f=fixture(t);let calls=0;
 const workflow=new ChatWorkflow({...f,projectRoot:f.project.root,runtime:{generate:async()=>{calls++;throw new Error('synthetic-new-generation');}},history:{close(){}}});f.workflow=workflow;
 const children=[{ref:'L1-11111111-1111-1111-1111-111111111111@v1',content:{text:'first synthetic child',guide:'source',entries:[{id:'I01',text:'first',refs:['C-first/M1/P01']}]}},
  {ref:'L1-22222222-2222-2222-2222-222222222222@v1',content:{text:'second synthetic child',guide:'source',entries:[{id:'I01',text:'second',refs:['C-second/M1/P01']}]}}];
 const data={level:2,children,inputLimit:LIMITS.parentInput,outputLimit:LIMITS.node},legacyData={...data,inputLimit:24000,outputLimit:6000},legacyId=`parent-${digest(legacyData).slice(0,24)}`;
 const output={text:'Already completed synthetic parent.',guide:'immutable child versions',entries:children.map(child=>({text:child.content.text,refs:[`${child.ref}#I01`]}))};
 for(const repaired of [false,true]){
  const id=repaired?'legacy-parent-repaired':'legacy-parent-completed',task=workflow.generator.begin({id,sourceWatermark:'legacy-source',operationWatermark:0}),artifact=`memory/maintenance/results/${id}.jsonl`;
  workflow.journal.write(artifact,{output});task.limits.output=192000;task.used.calls=1;task.used.output=6000;
  task.batches[repaired?`${legacyId}-repair`:legacyId]={status:'completed',artifact,outputDigest:digest(output)};
  if(repaired)task.batches[legacyId]={status:'invalid-output'};
  workflow.journal.write(`memory/maintenance/generation/${id}.jsonl`,task);
  assert.deepEqual(await workflow._summarizeParent({id},data),output);assert.equal(calls,0);assert.equal(workflow.generator.task(id).used.calls,1);assert.equal(workflow.generator.task(id).limits.output,192000);
 }
 const changed={...data,children:[children[0],{...children[1],content:{...children[1].content,text:'different source version content'}}]};
 await assert.rejects(workflow._summarizeParent({id:'legacy-parent-completed'},changed),/synthetic-new-generation/);assert.equal(calls,1);
});
test('crash after a formal dream revision but before its adoption receipt does not repeat the committed change or block chat',async t=>{
 const f=dreamingFixture(t);await f.workflow.dream({action:'run',target:'organize'});const original=f.workflow.dreams._write.bind(f.workflow.dreams);let interrupted=true;
 f.workflow.dreams._write=state=>{if(interrupted&&state.jobs.some(job=>job.status==='adopted')){interrupted=false;throw new Error('synthetic-receipt-crash');}return original(state);};
 await f.workflow._adoptDreams({id:'next-checkpoint'});assert.equal(f.memory.getModule('facts').entries[0].rev,2);assert.equal(f.workflow.dreamSnapshot().job.status,'candidate');
 await f.workflow._adoptDreams({id:'later-checkpoint'});assert.equal(f.memory.getModule('facts').entries[0].rev,2);assert.equal(f.workflow.dreamSnapshot().job.status,'adopted');assert.equal(f.calls,1);
});
