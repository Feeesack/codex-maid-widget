'use strict';
// Independent counterexamples against the real catalog/workflow/memory chain.
// Every directory and source adapter is explicit and synthetic; no host home,
// authentication file, native client, network or actual model is accessed.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {createChatProject}=require('../src/chat-project.cjs');
const {MemoryStore}=require('../src/chat-memory.cjs');
const {ChatWorkflow}=require('../src/chat-workflow.cjs');
function fixture(t,rows){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'maid-dream-review-中文 空格 ')),parent=path.join(directory,'synthetic projects');fs.mkdirSync(parent);
  const project=createChatProject({parentDir:parent,userNickname:'合成用户'}),now=Date.parse('2026-10-27T09:00:00Z'),sources=new Map(),meter=value=>Buffer.byteLength(value);
  const memory=new MemoryStore({projectRoot:project.root,countTokens:meter,clock:()=>new Date(now).toISOString(),resolveSource:()=>({verified:true,eventId:'synthetic-event',originalTurnId:'synthetic-turn',complete:true,at:'2026-10-26T12:00:00Z',localDate:'2026-10-26'})});
  memory.initialize({pet_name:'合成桌宠',user_nickname:'合成用户',persona:{core:[],preferences:[],background:[],examples:[],boundaries:[]}});
  const patches=rows.map((row,index)=>{const{module='facts',sourceText=row.content,sourceId=`C-review-${index+1}`,message='M1',...entry}=row,source={type:'chat',conversationId:sourceId,messageId:message,part:'P01'};sources.set(`${sourceId}/${message}/P01`,sourceText);return{module,action:'upsert',automatic:false,payload:{entry:{certainty:'explicit',...entry,sources:[source]}}};});
  memory.commitCheckpoint({taskId:'review-seed',baseVersions:{persona:1,userView:1,facts:1},operationWatermark:memory.getState().operationWatermark,sourceWatermark:'synthetic-seed-source',patches});
  let produce,calls=0,sourceReads=0;
  const runtime={quotaObservation:async()=>({authType:'chatgpt',scope:'synthetic-review-scope',windowId:'synthetic-window',windowMinutes:300,observedAt:now,remaining:80-calls,weekBlocked:false}),generate:async input=>{calls++;input.dreamPermit.guard();input.onEvent({type:'locator',threadId:'synthetic-dream-thread',turnId:'synthetic-dream-turn'});return{status:'completed',finalText:JSON.stringify(produce(JSON.parse(input.input)))}}};
  const history={close(){},syncIndex:async()=>({status:'ready'}),async resolveReference(reference,{maxBytes}={}){sourceReads++;const text=sources.get(reference);if(typeof text!=='string'||Buffer.byteLength(text)>maxBytes)throw new Error('synthetic source unavailable');return{ref:reference,text,role:'user',start:0,end:Array.from(text).length,committed:true}}};
  const workflow=new ChatWorkflow({projectRoot:project.root,memory,runtime,history,countTokens:meter,clock:()=>now,getDreamEnvironment:()=>({foreground:false,maintenance:false,recovering:false,drafts:false,lastInputAt:now-1800001})});
  t.after(()=>{workflow.close();fs.rmSync(directory,{recursive:true,force:true})});
  return{memory,workflow,sources,setOutput:fn=>{produce=fn},get calls(){return calls},get sourceReads(){return sourceReads},async task(){return workflow.dreamCatalog.materialize(workflow._dreamTask('organize','manual'))}};
}
const dep=(f,ref)=>{const{entry,...value}=f.memory.maintenanceDependency(ref);return value};
test('source repair cannot transplant another subject from the same original message',async t=>{
  const f=fixture(t,[{id:'F-my-cat',kind:'fact',subject:'我的猫',object_ids:['我的猫'],content:'我的猫叫桃子。',sourceText:'我的猫叫桃子。朋友的猫叫香蕉。'}]),task=await f.task();
  const original=task.evidence.find(item=>item.kind==='original');
  assert.throws(()=>f.workflow._semanticDreamCandidate({text:'错误纠偏',changes:[{target:'F-my-cat@1',kind:'source-repair',content:'朋友的猫叫香蕉。',refs:[],evidence:[original.id]}]},task),error=>/^CHAT_DREAM_/.test(error.code));
});
test('organizing a target cannot cite only a related entry while omitting target evidence',async t=>{
  const f=fixture(t,[{id:'F-a',kind:'fact',content:'合成猫叫桃子。'},{id:'F-b',kind:'fact',content:'合成狗叫香蕉。'}]),task=await f.task(),other=task.evidence.find(item=>item.kind==='original'&&item.supports.includes('F-b@1'));
  assert.ok(task.entryRefs.includes('F-a@1'));assert.ok(other);
  assert.throws(()=>f.workflow._semanticDreamCandidate({text:'遗漏目标依据',changes:[{target:'F-a@1',kind:'organize',content:'合成狗叫香蕉。',refs:['F-b@1'],evidence:[other.id]}]},task),error=>/^CHAT_DREAM_/.test(error.code));
});
test('source repair cannot replace a name claim with another property of the same subject',async t=>{
  const f=fixture(t,[{id:'F-my-cat',kind:'fact',subject:'我的猫',object_ids:['我的猫'],content:'我的猫叫桃子。',sourceText:'我的猫叫桃子。我的猫喜欢鱼。'}]),task=await f.task(),original=task.evidence.find(item=>item.kind==='original');
  assert.throws(()=>f.workflow._semanticDreamCandidate({text:'错误替换属性',changes:[{target:'F-my-cat@1',kind:'source-repair',content:'我的猫喜欢鱼。',refs:[],evidence:[original.id]}]},task),error=>/^CHAT_DREAM_/.test(error.code));
});
test('polarity normalization cannot erase negation-shaped characters inside a known person name',async t=>{
  const f=fixture(t,[{id:'F-buer',kind:'fact',subject:'不二',object_ids:['不二'],content:'不二喜欢茶。',sourceText:'不二喜欢茶。二喜欢茶。'}]),task=await f.task(),original=task.evidence.find(item=>item.kind==='original');
  assert.throws(()=>f.workflow._semanticDreamCandidate({text:'错误改变姓名',changes:[{target:'F-buer@1',kind:'source-repair',content:'二喜欢茶。',refs:[],evidence:[original.id]}]},task),error=>/^CHAT_DREAM_/.test(error.code));
});
test('checkpoint extraction cannot inject a self-canonical pointer that hides its only fact',t=>{
  const f=fixture(t,[{id:'F-only',kind:'fact',content:'唯一合成事实。'}]),state=f.memory.getState();
  try{f.memory.commitCheckpoint({taskId:'review-internal-injection',baseVersions:Object.fromEntries(Object.entries(state.modules).map(([key,value])=>[key,value.version])),operationWatermark:state.operationWatermark,sourceWatermark:'synthetic-new-source',patches:[{module:'facts',action:'upsert',automatic:false,payload:{entry:{id:'F-only',kind:'fact',content:'唯一合成事实。',canonical_ref:'F-only@2',maintenance:{kind:'canonical',jobId:'fake'},sources:[{type:'chat',conversationId:'C-review-new',messageId:'M2'}]}}}]})}catch(error){assert.equal(error.code,'MEMORY_INPUT')}
  assert.equal(f.memory.currentFacts().entries.length,1);assert.equal(f.memory.getModule('facts').entries[0].canonical_ref,undefined);
});
test('explicit source withdrawal invalidates a waiting candidate sharing that source',t=>{
  const f=fixture(t,[{id:'F-a',kind:'fact',content:'同源合成事实甲。',sourceId:'C-review-shared'},{id:'F-b',kind:'fact',content:'同源合成事实乙。',sourceId:'C-review-shared'}]),dependency=dep(f,'F-a@1');
  f.memory.save({module:'facts',baseVersion:f.memory.getModule('facts').version,operationId:'review-withdraw-same-source',action:'withdraw',payload:{id:'F-b',scope:'source'}});
  const result=f.memory.commitDreamCandidate({operationId:'review-block-withdrawn-source',checkpointId:'review-cp',dependencies:[dependency],changes:[{target:'F-a@1',kind:'organize',content:'同源合成事实甲的整理。',refs:[],evidenceRefs:['C-review-shared/M1/P01']}]});
  assert.equal(result.state,'discarded');assert.equal(result.applied.length,0);assert.equal(f.memory.getModule('facts').entries.find(item=>item.id==='F-a').rev,1);
});
test('adoption resumes its committed receipt after a crash without creating another revision',async t=>{
  const f=fixture(t,[{id:'F-a',kind:'fact',content:'合成猫叫桃子。'}]);f.setOutput(data=>({text:'合成整理',changes:[{target:'F-a@1',kind:'organize',content:'合成猫的名字是桃子。',refs:[],evidence:[data.evidence.find(item=>item.kind==='original').id]}]}));
  assert.equal((await f.workflow.dream({action:'run',target:'organize'})).state,'candidate');
  const originalWrite=f.workflow.dreams._write.bind(f.workflow.dreams);let injected=false;
  f.workflow.dreams._write=state=>{if(!injected&&state.jobs.some(job=>job.status==='adopted')){injected=true;throw Object.assign(new Error('synthetic crash after memory commit'),{code:'SYNTHETIC_CRASH'})}return originalWrite(state)};
  await f.workflow._adoptDreams({id:'review-first-cp'});assert.equal(injected,true);assert.equal(f.memory.getModule('facts').entries[0].rev,2);assert.equal(f.workflow.dreams.state().jobs.at(-1).status,'candidate');
  const committedRevision=f.memory.getState().revision,reads=f.sourceReads;f.sources.clear();await f.workflow._adoptDreams({id:'review-later-cp'});
  assert.equal(f.memory.getState().revision,committedRevision);assert.equal(f.memory.getModule('facts').entries[0].rev,2);assert.equal(f.sourceReads,reads);assert.equal(f.workflow.dreams.state().jobs.at(-1).status,'adopted');assert.equal(f.calls,1);
});
