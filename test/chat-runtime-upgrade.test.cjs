'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {fixture}=require('./helpers/chat-upgrade-fixture.cjs');
const sign=value=>{const result={...value};delete result.integrity;return {...result,integrity:crypto.createHash('sha256').update(JSON.stringify(result)).digest('hex')};};
async function setup(t,folder,extra={}){
  let history=[{id:'original-turn',status:'completed',items:[],itemsView:'notLoaded'}];
  const h=fixture(t,{folder,onRpc:(m,ctx)=>{
    if(m.method==='thread/turns/list')return {data:history,nextCursor:null};
    return extra.onRpc?.(m,ctx);
  }});await h.runtime.start();const {threadId}=await h.runtime.startThread();
  h.runtime.active.set(threadId,{threadId,id:'original-turn',status:'completed'});
  h.runtime.contextBounds.set(threadId,{textUpper:10000,observedUsed:8976,observedWindow:258400});
  const original=h.runtime.contextMetadata(threadId);
  const legacy={...original,schema:'codex-maid-context-bound/1',cliVersion:'codex-cli old',executableSha256:'a'.repeat(64),catalogSha256:'c'.repeat(64)};delete legacy.contextSemantics;
  const proof=sign(legacy),admission={...h.runtime.nativeInfo.proof,cliVersion:proof.cliVersion,executableSha256:proof.executableSha256,catalogSha256:proof.catalogSha256,
    verifiedAt:Date.now()-20*86400000,expiresAt:Date.now()-13*86400000};
  fs.mkdirSync(h.runtime.cacheRoot,{recursive:true});const file=path.join(h.runtime.cacheRoot,'admission-'+proof.executableSha256.slice(0,16)+'.json');fs.writeFileSync(file,JSON.stringify(admission));
  return Object.assign(h,{threadId,proof,file,admission,setHistory:value=>{history=value}});
}
for(const folder of ['src','macos/src']){
  test(folder+': an expired running-client admission is refreshed before recovery',async t=>{
    const h=await setup(t,folder);await h.runtime.resumeThread(h.threadId,{contextMetadata:h.proof});const proof=h.runtime.contextMetadata(h.threadId),before=h.admissions;
    h.runtime.nativeInfo.proof.expiresAt=Date.now()-1;await h.runtime.resumeThread(h.threadId,{contextMetadata:proof});
    assert.equal(h.admissions,before+1);assert.equal(h.runtime.contextMetadata(h.threadId).contextReady,true);
    assert.equal(h.written.filter(x=>x.method==='turn/start').length,0);
  });
  test(folder+': CLI upgrade migrates a legacy bound and continues the original thread without replacement',async t=>{
    const h=await setup(t,folder);h.runtime.contextBounds.clear();
    const restored=await h.runtime.resumeThread(h.threadId,{contextMetadata:h.proof});assert.equal(restored.contextRecoveryRequired,false);
    const current=h.runtime.contextMetadata(h.threadId);assert.equal(current.schema,'codex-maid-context-bound/2');assert.equal(current.textUpper,10000);assert.equal(current.contextReady,true);
    assert.equal(h.written.filter(x=>x.method==='thread/start').length,1);assert.ok(h.written.filter(x=>x.method==='thread/turns/list').every(x=>x.params.itemsView==='notLoaded'));
    await h.runtime.send(h.threadId,{text:'Synthetic continuation after upgrade'});
    assert.equal(h.written.filter(x=>x.method==='turn/start').length,1);assert.equal(h.written.find(x=>x.method==='turn/start').params.threadId,h.threadId);
  });
  test(folder+': later app and CLI upgrades retain stable v2 semantics while a smaller window stays bounded',async t=>{
    const h=await setup(t,folder);await h.runtime.resumeThread(h.threadId,{contextMetadata:h.proof});const current=h.runtime.contextMetadata(h.threadId);
    const info=h.runtime.nativeInfo;info.cliVersion='future-cli';info.executableSha256='d'.repeat(64);info.schemaFingerprint='e'.repeat(64);info.catalogSha256='f'.repeat(64);
    Object.assign(info.proof,{cliVersion:info.cliVersion,executableSha256:info.executableSha256,schemaFingerprint:info.schemaFingerprint,catalogSha256:info.catalogSha256});info.models[0].nominal=200000;
    h.runtime.contextBounds.clear();await h.runtime.resumeThread(h.threadId,{contextMetadata:current});
    assert.equal(h.runtime.contextMetadata(h.threadId).textUpper,10000);assert.equal(h.runtime.contextMetadata(h.threadId).observedWindow,190000);
    h.runtime.contextBounds.get(h.threadId).textUpper=189999;await assert.rejects(h.runtime.send(h.threadId,{text:'Retained near-limit draft'}),{code:'CHAT_HANDOFF_REQUIRED'});
    assert.equal(h.written.filter(x=>x.method==='turn/start').length,0);
  });
  test(folder+': recertification and expired historical admission do not invalidate an already measured terminal bound',async t=>{
    const h=await setup(t,folder);h.admission.verifiedAt=Date.now()-10;h.admission.expiresAt=Date.now()+86400000;fs.writeFileSync(h.file,JSON.stringify(h.admission));
    const older=sign({...h.proof,capturedAt:Date.now()-86400000});await h.runtime.resumeThread(h.threadId,{contextMetadata:older});assert.equal(h.runtime.contextMetadata(h.threadId).contextReady,true);
  });
  test(folder+': incomplete provenance, damaged semantics, changed native head and unknown execution remain blocked',async t=>{
    const h=await setup(t,folder);fs.unlinkSync(h.file);await assert.rejects(h.runtime.resumeThread(h.threadId,{contextMetadata:h.proof}),{code:'CHAT_CONTEXT_METADATA_INVALID'});
    fs.writeFileSync(h.file,JSON.stringify(h.admission));await h.runtime.resumeThread(h.threadId,{contextMetadata:h.proof});const current=h.runtime.contextMetadata(h.threadId);
    await assert.rejects(h.runtime.resumeThread(h.threadId,{contextMetadata:sign({...current,contextSemantics:'different'})}),{code:'CHAT_CONTEXT_METADATA_INVALID'});
    h.setHistory([{id:'another-turn',status:'completed',items:[],itemsView:'notLoaded'}]);await assert.rejects(h.runtime.resumeThread(h.threadId,{contextMetadata:current}),{code:'CHAT_CONTEXT_RECOVERY_REQUIRED'});
    h.setHistory([{id:'original-turn',status:'inProgress',items:[],itemsView:'notLoaded'}]);await assert.rejects(h.runtime.resumeThread(h.threadId,{contextMetadata:current}),{code:'CHAT_EXECUTION_UNKNOWN'});
    assert.equal(h.written.filter(x=>x.method==='turn/start').length,0);assert.equal(h.written.filter(x=>x.method==='thread/start').length,1);
  });
  test(folder+': resume buffers fresh usage and rejects old or decreasing observations',async t=>{
    const h=await setup(t,folder,{onRpc:(m,{emit})=>{if(m.method==='thread/resume')emit({method:'thread/tokenUsage/updated',params:{threadId:m.params.threadId,turnId:'original-turn',tokenUsage:{last:{inputTokens:11000,outputTokens:1000},modelContextWindow:258400}}});}});
    h.runtime.contextBounds.clear();await h.runtime.resumeThread(h.threadId,{contextMetadata:h.proof});const before=h.runtime.contextMetadata(h.threadId);assert.equal(before.textUpper,13024);
    for(const [id,input,output]of [['older-turn',10,1],['original-turn',100,1]])h.emit({method:'thread/tokenUsage/updated',params:{threadId:h.threadId,turnId:id,tokenUsage:{last:{inputTokens:input,outputTokens:output},modelContextWindow:258400}}});
    assert.equal(h.runtime.contextMetadata(h.threadId).textUpper,before.textUpper);
  });
}
