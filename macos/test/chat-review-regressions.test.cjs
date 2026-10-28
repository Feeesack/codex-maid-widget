'use strict';
const { test }=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const { createChatProject }=require('../src/chat-project.cjs');
const { createConversation,commitCheckpoint }=require('../src/chat-archive.cjs');
const { MemoryStore }=require('../src/chat-memory.cjs');
const { ChatHistory }=require('../src/chat-history.cjs');
const { HandoffStore }=require('../src/chat-handoff.cjs');
// Every directory dependency is explicit; no host data-home/auth/reader is used.
function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'maid-review-中文 ')),project=createChatProject({parentDir:root,userNickname:'合成审查'}),measure=value=>Buffer.byteLength(value);
  const memory=new MemoryStore({projectRoot:project.root,countTokens:measure,resolveSource:()=>true});memory.initialize({pet_name:'合成角色',user_nickname:'合成审查'});
  const history=new ChatHistory({projectRoot:project.root,memory,measure,worker:false,semanticOptions:{resourceRoot:path.join(root,'missing-semantic-model')}});
  t.after(async()=>{await history.close();assert.equal(path.dirname(root),os.tmpdir());assert.ok(path.basename(root).startsWith('maid-review-中文 '));fs.rmSync(root,{recursive:true,force:true});});
  return {root,project,memory,history,measure};
}
test('review: withdrawing a source also filters its committed handoff before index rebuild',async t=>{
  const f=fixture(t),text='咖啡是这个合成项目的旧偏好。',time='2026-10-26T12:00:00+08:00';
  const conversation=createConversation({root:f.project.root,startedAt:time,timezone:'Asia/Shanghai',nativeThreadId:'synthetic-review-thread'});
  commitCheckpoint({root:f.project.root,conversation,sourceComplete:true,trigger:'new-conversation',records:[{turn:{id:'T1',observed_at:null}},{id:'M1',turn_id:'T1',role:'user',time,content:[{text}]},{turn_result:{id:'T1',observed_at:null,status:'completed'}}]});
  const reference=`${conversation.conversationId}/M1/P01`,source={type:'chat',conversationId:conversation.conversationId,messageId:'M1',part:'P01',at:time};
  f.memory.commitCheckpoint({taskId:'review-memory',operationWatermark:f.memory.getState().operationWatermark,baseVersions:{userView:1},sourceWatermark:'review-source',patches:[{module:'userView',action:'upsert',automatic:false,payload:{entry:{id:'V-review-coffee',kind:'preference',content:text,sources:[source]}}}]});
  const handoff=new HandoffStore({projectRoot:f.project.root,countTokens:f.measure,resolveSource:()=>({text,role:'user',time})});
  handoff.publish({taskId:'review-handoff',sourceWatermark:'review-source',operationWatermark:f.memory.getState().operationWatermark,complete:true,summary:'旧的合成咖啡偏好。',sourceRefs:[reference],originals:[{ref:reference,text,role:'user',time,unit:'unicode-code-point',start:0,end:Array.from(text).length}]});
  await f.history.rebuildIndex();
  f.memory.save({module:'userView',operationId:'review-withdraw',baseVersion:2,action:'withdraw',payload:{id:'V-review-coffee'}});
  const result=await f.history.searchRecords({query:'咖啡'},f.history.beginTurn());
  assert.deepEqual(result.cards,[],'withdrawn evidence must not return through handoff summaries');
});
test('review: an awaited overlapping index sync covers archives committed during the active pass',async t=>{
  const f=fixture(t),archive=(day,text)=>{
    const conversation=createConversation({root:f.project.root,startedAt:`2026-10-${day}T12:00:00+08:00`,timezone:'Asia/Shanghai',nativeThreadId:`synthetic-review-${day}`});
    commitCheckpoint({root:f.project.root,conversation,sourceComplete:true,trigger:'new-conversation',records:[{turn:{id:'T1',observed_at:null}},{id:'M1',turn_id:'T1',role:'user',time:null,content:[{text}]},{turn_result:{id:'T1',observed_at:null,status:'completed'}}]});return conversation;
  };
  archive('25','合成第一份来源');
  let release,entered;const blocked=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{entered=resolve;}),documents=f.history._documents.bind(f.history);let once=false;
  f.history._documents=async function*(source){if(!once){once=true;entered();await blocked;}yield* documents(source);};
  const first=f.history.syncIndex();await started;
  const secondArchive=archive('26','同步过程中新增的合成第二份来源');
  const second=f.history.syncIndex();release();await first;const result=await second;
  assert.equal(result.status,'ready','await syncIndex must not report an unfinished indexing placeholder');
  assert.equal(f.history.resolveReference(`${secondArchive.conversationId}/M1/P01`).text,'同步过程中新增的合成第二份来源');
});
