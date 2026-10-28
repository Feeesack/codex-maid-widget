'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {collectOwnHistory,nativeArchiveRecords}=require('../src/chat-source.cjs');
const conversation={conversationId:'C-one',nativeThreadId:'own',startedAt:'2026-10-26T09:00:00+08:00',archiveDate:'2026-10-26',timezone:'Asia/Shanghai',title:'2026-10-26_09-00-00',messageTimeSource:'unknown'};
const turn={id:'native-t',status:'completed',fullItems:true,items:[
 {id:'u1',clientId:'request1',turnId:'native-t',role:'user',contentComplete:true,content:[{text:'  不要删\n原图  '}]},
 {id:'u2',clientId:'request2',turnId:'native-t',role:'user',contentComplete:true,content:[{text:'追加：也别重编码'}]},
 {id:'comment',turnId:'native-t',role:'assistant',phase:'commentary',content:[{text:'过程不归档'}]},
 {id:'final',turnId:'native-t',role:'assistant',phase:'final_answer',content:[{text:'好的，保留原件。'}]}]};
test('bounded own-history pagination needs terminal cutoff and verified source capability',async()=>{
 const read=async(_id,options)=>options?{threadId:'own',data:[turn],nextCursor:null,complete:true,sourceRecoveryVerified:true}:{status:'idle'};
 const source=await collectOwnHistory({readOwnThread:read},{threadId:'own',cutoffTurnId:'native-t',isFrozen:()=>true});
 assert.equal(source.complete,true);assert.equal(source.turns.length,1);
 await assert.rejects(collectOwnHistory({readOwnThread:read},{threadId:'own',cutoffTurnId:'other',isFrozen:()=>true}),/CUTOFF/);
 await assert.rejects(collectOwnHistory({readOwnThread:async()=>({status:'active'})},{threadId:'own',cutoffTurnId:'native-t',isFrozen:()=>true}),/TERMINAL/);
});
test('native-to-archive keeps exact body, explicit append and actual loaded versions, skips commentary',()=>{
 const records=nativeArchiveRecords({threadId:'own',cutoffTurnId:'native-t',complete:true,turns:[turn]},{conversation,
  clientOperations:new Map([['request1',{kind:'send',turnId:'native-t',delivered:true}],['request2',{kind:'steer',turnId:'native-t',delivered:true,appendToClientId:'request1'}]]),
  loadedVersions:new Map([['native-t',{personaVersion:1,memoryViewVersions:{facts:2}}]])});
 assert.equal(records.filter(r=>r.role).length,3);assert.equal(records[1].content[0].text,'  不要删\n原图  ');
 assert.equal(records[2].append_to,records[1].id);assert.equal(records[0].turn.persona_version,1);
 assert.equal(records.some(r=>JSON.stringify(r).includes('过程不归档')),false);assert.equal(records[1].time,null);
});
test('unknown execution or unavailable image bytes cannot be normalized into a successful archive',()=>{
 const source={threadId:'own',cutoffTurnId:'native-t',complete:true,turns:[{...turn,status:'unknown'}]};
 assert.throws(()=>nativeArchiveRecords(source,{conversation}),/TERMINAL/);
 assert.throws(()=>nativeArchiveRecords({...source,turns:[{...turn,items:[{...turn.items[0],contentComplete:false}]}]},{conversation}),/IMAGE/);
});
test('failed displayed fragments keep unknown phase unknown and never invent final/partial phase',()=>{
 const failed={...turn,status:'failed',items:[{id:'visible',turnId:'native-t',role:'assistant',phase:null,content:[{text:'已经显示的半句'}]}]};
 const source={threadId:'own',cutoffTurnId:'native-t',complete:true,turns:[failed]};
 const records=nativeArchiveRecords(source,{conversation,displayedItems:new Set(['visible'])});
 assert.equal(records.find(r=>r.role==='assistant').phase,null);
 assert.throws(()=>nativeArchiveRecords(source,{conversation}),/DISPLAY_UNKNOWN/);
});

test('explicit answer envelope decoding archives only user-visible text including failed partials',()=>{
 const encoded={...turn,items:[turn.items[0],{...turn.items.at(-1),content:[{text:'{"answer":"最终\\n原话","signals":[{"kind":"emotion","label":"不得归档","eventId":"one"}]}'}]}]};
 const source={threadId:'own',cutoffTurnId:'native-t',complete:true,turns:[encoded]};
 const records=nativeArchiveRecords(source,{conversation,decodeAnswers:true}); assert.equal(records.find(r=>r.role==='assistant').content[0].text,'最终\n原话'); assert.equal(JSON.stringify(records).includes('不得归档'),false);
 const failed={...encoded,status:'interrupted',items:[{...encoded.items.at(-1),content:[{text:'{"answer":"已显示的半句'}]}]};
 const partial=nativeArchiveRecords({...source,turns:[failed]},{conversation,decodeAnswers:true,displayedItems:new Set(['final'])}); assert.equal(partial.find(r=>r.role==='assistant').content[0].text,'已显示的半句');
});
