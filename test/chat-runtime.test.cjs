'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto'),{EventEmitter}=require('node:events');
const {ChatRuntime,measure,MEASURE_INFO}=require('../src/chat-runtime.cjs');
const {RECOVERY_SCENARIOS}=require('../src/chat-transport.cjs');
function fixture(t,{accountType='chatgpt',bootstrapNotice=false,noticeDuringAccountRead=false,nativeModels,modelPages}={}){
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'maid-runtime-隔离 ')),root=path.join(base,'项目'),data=path.join(base,'data'),home=path.join(base,'codex');for(const p of [root,data,home])fs.mkdirSync(p);
  const exe=path.join(base,'codex.exe');fs.writeFileSync(exe,'native fixture');const digest=crypto.createHash('sha256').update(fs.readFileSync(exe)).digest('hex');let admissions=0,child,written=[],thread=0,current;const quotaReset=Math.floor(Date.now()/1000)+3600;
  const emit=m=>child.stdout.emit('data',JSON.stringify(m)+'\n');
  const runtime=new ChatRuntime({projectRoot:root,dataDir:data,codexHome:home,codexPath:exe,env:{PATH:'',HOME:home,USERPROFILE:home,CODEX_HOME:home},resolveExecutable:async()=>exe,
    admitNative:async()=>{admissions++;return {executableSha256:digest,cliVersion:'fixture-cli',schemaFingerprint:'b'.repeat(64),catalogPath:path.join(data,'public-catalog.json'),models:nativeModels||[{model:'gpt-6.1-sol',nominal:272000,percent:95}],proof:{revision:10,cliVersion:'fixture-cli',executableSha256:digest,schemaFingerprint:'b'.repeat(64),catalogSha256:null,verifiedAt:Date.now()-10,expiresAt:Date.now()+60000,checks:Object.fromEntries([...RECOVERY_SCENARIOS,'effectiveWindow','effort','context','failed','interrupted','controlledTool','imageDelivered','globalToolsSuppressed'].map(k=>[k,true]))}};},
    toolHandler:async request=>({ref:'C-safe/M1',text:request.arguments.query||'exact source'}),
    spawn:()=>{child=new EventEmitter();child.stdout=new EventEmitter();child.stdout.setEncoding=()=>{};child.stderr=new EventEmitter();child.stdin=new EventEmitter();child.stdin.destroy=()=>{};child.kill=()=>{};
      child.stdin.write=(text,callback)=>{const m=JSON.parse(text);written.push(m);callback?.();if(!m.method)return true;let result={};
        if(m.method==='account/read')result={account:{type:accountType,planType:'pro',email:'never-output@example.invalid'}};
        else if(m.method==='config/read')result={config:{mcp_servers:{'isolated tools':{command:'never-start',private:'never-output'}},model_providers:{secret:'not-retained'}}};
        else if(m.method==='account/rateLimits/read')result={rateLimits:{primary:{usedPercent:10,windowDurationMins:300,resetsAt:quotaReset},secondary:{usedPercent:10,windowDurationMins:10080,resetsAt:quotaReset}}};
        else if(m.method==='model/list')result=modelPages?modelPages(m.params):{data:[{model:'gpt-6.1-sol',id:'gpt-6.1-sol',hidden:false,supportedReasoningEfforts:[{reasoningEffort:'medium'},{reasoningEffort:'low'}]}]};
        else if(m.method==='thread/start')result={thread:{id:'thread-'+(++thread),cwd:root,createdAt:1}};
        else if(m.method==='thread/read'||m.method==='thread/resume')result={thread:{id:m.params.threadId,cwd:root,status:{type:'idle'}}};
        else if(m.method==='thread/turns/list')result={data:[],nextCursor:null};
        else if(m.method==='turn/start'){current={id:'turn-'+thread,threadId:m.params.threadId};result={turn:{id:current.id,status:'inProgress'}};
          setTimeout(()=>{emit({method:'turn/started',params:{threadId:current.threadId,turn:{id:current.id,status:'inProgress'}}});emit({method:'item/completed',params:{threadId:current.threadId,turnId:current.id,item:{type:'agentMessage',id:'answer-'+thread,phase:'final_answer',text:'{"ok":true}'}}});emit({method:'turn/completed',params:{threadId:current.threadId,turn:{id:current.id,status:'completed'}}});},5);}
        if(m.id!==undefined)queueMicrotask(()=>{emit({id:m.id,result});if(m.method==='initialize'&&bootstrapNotice)emit({method:'account/updated',params:{}});if(m.method==='account/read'&&noticeDuringAccountRead){noticeDuringAccountRead=false;emit({method:'account/updated',params:{}});}});return true;};return child;}});
  t.after(()=>{runtime.close();fs.rmSync(base,{recursive:true,force:true});});return {runtime,root,written,emit,get admissions(){return admissions;},set accountType(value){accountType=value;}};
}
test('automatic admission binds native binary and exposes model/effort plus conservative byte semantics',async t=>{
  const h=fixture(t),status=await h.runtime.start();assert.equal(status.ready,true);assert.equal(h.admissions,1);await h.runtime.start();assert.equal(h.admissions,1);
  assert.equal(h.runtime.window().effective,258400);assert.equal(h.runtime.window().generationHardLimitVerified,false);assert.equal(measure('中文🙂'),10);assert.equal(MEASURE_INFO.exactTokens,false);
  assert.deepEqual((await h.runtime.models())[0].efforts,['medium','low']);await assert.rejects(h.runtime.startThread({model:'unknown'}),{code:'MODEL_UNAVAILABLE'});
  const thread=await h.runtime.startThread({effort:'low'});const creation=h.written.find(m=>m.method==='thread/start');assert.equal(creation.params.config.model_reasoning_effort,'low');assert.equal(creation.params.dynamicTools.length,2);
  assert.deepEqual(creation.params.config.mcp_servers,{'isolated tools':{enabled:false}});assert.equal(JSON.stringify(h.runtime.status()).includes('never-output'),false);
  await h.runtime.send(thread.threadId,{text:'hello',effort:'low',additionalContext:'saved override'});const sent=h.written.find(m=>m.method==='turn/start');assert.equal(sent.params.effort,'low');assert.equal(sent.params.additionalContext.companion_context.value,'saved override');assert.deepEqual(sent.params.input,[{type:'text',text:'hello'}]);
  await assert.rejects(h.runtime.send(thread.threadId,{text:'not sent',model:'unavailable'}),{code:'MODEL_UNAVAILABLE',executionState:'not-executed'});
});
test('complete paged model refresh admits Terra only with native metadata and preserves capacity gates',async t=>{
  let mode='complete',sequence=0;
  const entry=(model,hidden=false)=>({model,id:model+'-display',hidden,supportedReasoningEfforts:[{reasoningEffort:'medium'}]});
  const h=fixture(t,{nativeModels:[{model:'gpt-6.1-sol',nominal:272000,percent:95},{model:'gpt-6.1-terra',nominal:500000,percent:95}],
    modelPages:params=>mode==='complete'?{data:params.cursor?[entry('gpt-6.1-terra'),entry('unverified-future'),entry('gpt-6.1-sol',true)]:[entry('gpt-6.1-sol')],nextCursor:params.cursor?null:'next-page'}:{data:[],nextCursor:mode==='loop'?'repeat':'page-'+(++sequence)}});
  await h.runtime.start();
  assert.deepEqual(h.runtime.modelChoices.map(model=>model.model),['gpt-6.1-sol','gpt-6.1-terra']);
  assert.equal(h.runtime.window('gpt-6.1-terra').effective,258400);
  assert.equal(h.runtime.window('unverified-future').verified,false);
  assert.deepEqual(h.runtime.selection('gpt-6.1-terra','medium'),{model:'gpt-6.1-terra',effort:'medium'});
  const confirmed=h.runtime.modelChoices;
  mode='limit';await assert.rejects(h.runtime.models(),{code:'MODEL_PAGE_LIMIT'});assert.strictEqual(h.runtime.modelChoices,confirmed);
  mode='loop';await assert.rejects(h.runtime.models(),{code:'MODEL_CURSOR_LOOP'});assert.strictEqual(h.runtime.modelChoices,confirmed);
  assert.equal(h.written.filter(message=>message.method==='turn/start').length,0);
});
test('maintenance generate waits for final terminal and sends structured schema without a second call',async t=>{
  const h=fixture(t);const result=await h.runtime.generate({projectRoot:h.root,input:'fixture',instructions:'return JSON',outputSchema:{type:'object'},maxOutputTokens:1000});assert.equal(result.status,'completed');assert.equal(result.finalText,'{"ok":true}');
  assert.equal(h.written.filter(m=>m.method==='turn/start').length,1);assert.equal(h.written.find(m=>m.method==='thread/start').params.dynamicTools,undefined);assert.deepEqual(h.written.find(m=>m.method==='turn/start').params.outputSchema,{type:'object'});
  await assert.rejects(h.runtime.generate({purpose:'dream'}),{code:'DREAM_ESTIMATE_PERMIT_REQUIRED'});
});
test('estimated dream requires fresh same-window quota and synchronous foreground permit, with one request and owned locator',async t=>{
 const h=fixture(t);await h.runtime.start();const quota=await h.runtime.quotaObservation();assert.equal(quota.windowMinutes,300);assert.equal(quota.remaining,90);assert.equal(quota.weekBlocked,false);
 let guards=0;const events=[],permit={id:'D-11111111-1111-1111-1111-111111111111',scope:quota.scope,windowId:quota.windowId,mode:'manual',estimatedPoints:3,guarantee:false,guard:()=>{guards++;}};
 const result=await h.runtime.generate({purpose:'dream',instructions:'synthetic estimate only',input:'no real source',outputSchema:{type:'object'},maxOutputTokens:2000,dreamPermit:permit,requestId:permit.id,onEvent:event=>events.push(event)});
 assert.equal(result.status,'completed');assert.ok(guards>=3);assert.equal(h.written.filter(m=>m.method==='turn/start').length,1);assert.equal(events.filter(e=>e.type==='locator').length,2);
 assert.equal(h.runtime.dreamGuards.size,0);assert.equal(JSON.stringify(quota).includes('never-output'),false);
 await assert.rejects(h.runtime.generate({purpose:'dream',instructions:'x',input:'x'.repeat(8000),maxOutputTokens:2000,dreamPermit:permit}),{code:'CHAT_DREAM_INPUT_BUDGET'});
 const allow=h.runtime._allowMutation.bind(h.runtime);let interrupted=false;h.runtime._allowMutation=async()=>{await allow();interrupted=true;};
 await assert.rejects(h.runtime.generate({purpose:'dream',input:'synthetic',maxOutputTokens:2000,dreamPermit:{...permit,guard:()=>{if(interrupted)throw Object.assign(new Error('foreground'),{code:'CHAT_DREAM_FOREGROUND_PRIORITY'});}}}),{code:'CHAT_DREAM_FOREGROUND_PRIORITY'});
 assert.equal(h.written.filter(m=>m.method==='turn/start').length,1);
});
test('fresh shared quota depletion between reservation and native dispatch prevents a paid dream',async t=>{
 const h=fixture(t);await h.runtime.start();const quota=await h.runtime.quotaObservation(),permit={id:'D-22222222-2222-2222-2222-222222222222',scope:quota.scope,windowId:quota.windowId,mode:'automatic',estimatedPoints:3,guarantee:false,guard:()=>{}};
 const allow=h.runtime._allowMutation.bind(h.runtime);h.runtime._allowMutation=async()=>{await allow();if(h.runtime.lastQuota)h.runtime.lastQuota={...h.runtime.lastQuota,remaining:29};};
 await assert.rejects(h.runtime.generate({purpose:'dream',instructions:'synthetic',input:'synthetic',maxOutputTokens:2000,dreamPermit:permit}),{code:'CHAT_DREAM_QUOTA_CHANGED',executionState:'not-executed'});
 assert.equal(h.written.filter(m=>m.method==='turn/start').length,0);
});
test('API mode cannot send and never falls through to API billing',async t=>{
  const h=fixture(t,{accountType:'apiKey'});await h.runtime.start();await assert.rejects(h.runtime.startThread(),{code:'CHATGPT_LOGIN_REQUIRED'});assert.equal(h.written.filter(m=>m.method==='turn/start').length,0);
});
test('an account reconnection retains project ownership and never replays an unresolved turn',async t=>{
  const h=fixture(t);await h.runtime.start();const {threadId}=await h.runtime.startThread();h.runtime.active.set(threadId,{threadId,id:'inflight',status:'inProgress'});
  h.emit({method:'account/updated',params:{}});assert.equal(h.runtime.status().ready,false);const refreshed=await h.runtime.refreshConnection();assert.equal(refreshed.reconciliationRequired,true);assert.equal(h.runtime.owned.has(threadId),true);
  await assert.rejects(h.runtime.send(threadId,{text:'must not replay'}),{code:'UNKNOWN_EXECUTION',executionState:'not-executed'});assert.equal(h.written.filter(m=>m.method==='turn/start').length,0);
});

test('bootstrap and idle delayed account snapshots do not block the first request',async t=>{
  const h=fixture(t,{bootstrapNotice:true,noticeDuringAccountRead:true});let paused=0;h.runtime.on('accountChanged',()=>paused++);
  assert.equal((await h.runtime.start()).ready,true);assert.equal(h.runtime.authChanged,false);assert.equal(paused,0);
  h.emit({method:'account/updated',params:{}});
  const {threadId}=await h.runtime.startThread();assert.equal(h.runtime.status().ready,true);assert.equal(paused,0);
  await h.runtime.send(threadId,{text:'first request after native bootstrap'});
  assert.equal(h.written.filter(m=>m.method==='turn/start').length,1);
});
test('only scoped search/read dynamic tools are serviced and duplicate calls cannot spend the budget again',async t=>{
  const h=fixture(t);await h.runtime.start();const {threadId}=await h.runtime.startThread();h.runtime.active.set(threadId,{threadId,id:'tool-turn',status:'inProgress'});
  h.emit({id:800,method:'item/tool/call',params:{threadId,turnId:'tool-turn',callId:'one',tool:'search_records',arguments:{query:'糖罐'}}});await new Promise(resolve=>setTimeout(resolve,5));assert.equal(h.written.find(m=>m.id===800).result.success,true);
  h.emit({id:801,method:'item/tool/call',params:{threadId,turnId:'tool-turn',callId:'one',tool:'search_records',arguments:{query:'糖罐'}}});await new Promise(resolve=>setTimeout(resolve,5));assert.equal(h.written.find(m=>m.id===801).result.success,false);
  h.emit({id:802,method:'item/commandExecution/requestApproval',params:{threadId,turnId:'tool-turn'}});assert.equal(h.written.find(m=>m.id===802).error.code,-32601);
});
test('fresh native current-context usage replaces earlier source upper bound without altering cumulative body state',async t=>{
  const h=fixture(t);await h.runtime.start();const {threadId}=await h.runtime.startThread();h.runtime.contextBounds.get(threadId).textUpper=240000;h.runtime.active.set(threadId,{id:'compacted',status:'completed'});h.runtime.contextBounds.get(threadId).liveTurnId='compacted';
  h.emit({method:'thread/tokenUsage/updated',params:{threadId,turnId:'compacted',tokenUsage:{last:{inputTokens:1000,outputTokens:200,totalTokens:1200},total:{inputTokens:400000,outputTokens:100000,totalTokens:500000},modelContextWindow:258400}}});
  assert.equal(h.runtime.contextBounds.get(threadId).textUpper,2224);assert.equal(h.runtime.contextBounds.get(threadId).observedUsed,1200);
  await h.runtime.send(threadId,{text:'after compaction'});
});

test('the synchronous dispatch guard rejects a newer save after account preflight without sending stale context',async t=>{
  const h=fixture(t);await h.runtime.start();const {threadId}=await h.runtime.startThread();let saved=1,expected=1;
  h.runtime.options.beforeDispatch=event=>{assert.equal(event.kind,'send');if(saved!==expected)throw Object.assign(new Error('changed'),{code:'CHAT_CONTEXT_CHANGED'});};
  const allow=h.runtime._allowMutation.bind(h.runtime);h.runtime._allowMutation=async()=>{await allow();saved=2;};
  await assert.rejects(h.runtime.send(threadId,{text:'retained input',clientMessageId:'stale'}),{code:'CHAT_CONTEXT_CHANGED',executionState:'not-executed'});
  assert.equal(h.written.filter(m=>m.method==='turn/start').length,0);assert.equal(h.runtime.active.has(threadId),false);
  h.runtime.options.beforeDispatch=async()=>{};
  await assert.rejects(h.runtime.send(threadId,{text:'async guards forbidden'}),{code:'DISPATCH_GUARD_ASYNC',executionState:'not-executed'});
  assert.equal(h.written.filter(m=>m.method==='turn/start').length,0);
  h.runtime.active.set(threadId,{threadId,id:'guard-steer',status:'inProgress'});const beforeSteer=h.runtime.contextBounds.get(threadId).textUpper;
  h.runtime.options.beforeDispatch=event=>{assert.equal(event.kind,'steer');throw Object.assign(new Error('changed'),{code:'CHAT_CONTEXT_CHANGED'});};
  await assert.rejects(h.runtime.steer(threadId,{text:'retained append',expectedTurnId:'guard-steer'}),{code:'CHAT_CONTEXT_CHANGED',executionState:'not-executed'});
  assert.equal(h.written.filter(m=>m.method==='turn/steer').length,0);assert.equal(h.runtime.active.get(threadId).status,'inProgress');assert.equal(h.runtime.contextBounds.get(threadId).textUpper,beforeSteer);
});

test('resumed sending requires bound metadata tied to binary schema root and owned thread, including hidden context',async t=>{
  const h=fixture(t);await h.runtime.start();const {threadId}=await h.runtime.startThread();
  // Simulate accumulated management context absent from visible native items.
  h.runtime.contextBounds.set(threadId,{textUpper:100000,observedUsed:90000,observedWindow:258400});
  const saved=h.runtime.contextMetadata(threadId);assert.equal(JSON.stringify(saved).includes('hidden context'),false);
  h.runtime.contextBounds.clear();
  await assert.rejects(h.runtime.resumeThread(threadId),{code:'CHAT_CONTEXT_RECOVERY_REQUIRED'});
  assert.equal(h.written.filter(m=>m.method==='thread/resume').length,0);
  for(const patch of [{textUpper:1},{threadId:'foreign'},{schemaFingerprint:'wrong'},{executableSha256:'wrong'},{projectRoot:path.dirname(h.root)},{unexpected:true}])
    assert.throws(()=>h.runtime.restoreContextMetadata(threadId,{...saved,...patch}),{code:'CHAT_CONTEXT_METADATA_INVALID'});
  const invalid={...saved,observedWindow:129*1024*1024};delete invalid.integrity;invalid.integrity=crypto.createHash('sha256').update(JSON.stringify(invalid)).digest('hex');
  assert.throws(()=>h.runtime.restoreContextMetadata(threadId,invalid),{code:'CHAT_CONTEXT_METADATA_INVALID'});
  await h.runtime.resumeThread(threadId,{contextMetadata:saved});
  assert.equal(h.runtime.contextBounds.get(threadId).textUpper,100000);assert.equal(h.runtime.contextBounds.get(threadId).observedUsed,90000);
  await h.runtime.resumeThread(threadId,{contextMetadata:saved,developerInstructions:'restored override'});assert.equal(h.runtime.contextBounds.get(threadId).textUpper,100000+measure('restored override')+256);
  h.runtime.contextBounds.get(threadId).textUpper=240000;
  h.emit({method:'thread/tokenUsage/updated',params:{threadId,tokenUsage:{last:{inputTokens:1000,outputTokens:200},modelContextWindow:258400}}});
  const compacted=h.runtime.contextMetadata(threadId);assert.equal(compacted.textUpper,240000,'An unbound usage event cannot lower the recovered capacity');
  await h.runtime.resumeThread(threadId,{contextMetadata:compacted});assert.equal(h.runtime.contextBounds.get(threadId).textUpper,240000);
  h.runtime.contextBounds.get(threadId).textUpper=100000;
  await h.runtime.send(threadId,{text:'after safe resume'});assert.equal(h.written.filter(m=>m.method==='turn/start').length,1);
  const inFlight=h.runtime.contextMetadata(threadId);assert.equal(inFlight.contextReady,false);
  await assert.rejects(h.runtime.resumeThread(threadId,{contextMetadata:inFlight}),{code:'CHAT_CONTEXT_RECOVERY_REQUIRED'});
  h.runtime.contextBounds.get(threadId).recoveryPending=true;
  await assert.rejects(h.runtime.send(threadId,{text:'cannot use incomplete crash bound'}),{code:'CHAT_CONTEXT_RECOVERY_REQUIRED',executionState:'not-executed'});
});
