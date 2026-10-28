'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const {EventEmitter} = require('node:events');

// Every dependency receives the bounded filesystem and explicit data/project
// roots. No environment-only override can fall through to a real profile.
function isolatedFs(root) {
  const io = Object.create(fs);
  for (const name of ['existsSync','lstatSync','statSync','realpathSync','readFileSync','writeFileSync','mkdirSync','readdirSync','openSync','renameSync','unlinkSync','rmSync','accessSync','utimesSync']) {
    io[name] = (...args) => {
      for (const index of name === 'renameSync' ? [0,1] : [0]) if (typeof args[index] === 'string' || Buffer.isBuffer(args[index])) {
        const relative = path.relative(root, path.resolve(String(args[index])));
        assert.ok(relative === '' || !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative), 'Fixture attempted access outside its isolated directory');
      }
      return fs[name](...args);
    };
  }
  return io;
}
async function fixture(t, folder) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'maid-context-隔离 ')), dataDir = path.join(sandbox, '自定义 数据'), parent = path.join(sandbox, '中文 空格项目');
  fs.mkdirSync(dataDir); fs.mkdirSync(parent); const io = isolatedFs(sandbox), native = new EventEmitter();
  const {ChatService} = require('../' + folder + '/chat-service.cjs');
  native.active = new Map(); native.calls = {resume:0,send:0,start:0};
  native.start = async () => ({}); native.status = () => ({accountType:'chatgpt'}); native.capabilities = () => ({ready:true});
  native.models = () => [{model:'gpt-6.1-sol',efforts:['medium']}]; native.measure = value => Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value));
  native.window = () => ({verified:true,effective:258400,outputReserve:32768,maintenanceReserve:8192});
  native.startThread = async () => ({threadId:'thread-' + (++native.calls.start)});
  native.turn = {id:'turn-safe',status:'completed',items:[]}; native.bound = {textUpper:10000,observedUsed:8000,observedWindow:258400,contextReady:true};
  native.contextMetadata = id => ({threadId:id,model:'gpt-6.1-sol',effort:'medium',turnId:native.turn?.id??null,turnStatus:native.turn?.status??null,...native.bound});
  native.resumeThread = async (id, options) => {native.calls.resume++; native.resumeOptions = options; return {contextRecoveryRequired:false};};
  native.readOwnThread = async id => ({threadId:id,data:native.turn?[native.turn]:[],complete:true,nextCursor:null});
  native.send = async () => {native.calls.send++; throw Error('A recovery check must never send');}; native.close = () => {};
  const service = new ChatService({dataDir,fs:io,autoConnect:false,transportFactory:()=>native,
    historyFactory: options => {assert.equal(options.fs,io); assert.ok(options.projectRoot.startsWith(sandbox)); return {initialize:async()=>({ready:true}),close(){}};},
    workflowFactory: options => {assert.equal(options.fs,io); assert.ok(options.projectRoot.startsWith(sandbox)); return {status:()=>({state:'idle'}),dream:async()=>({state:'idle'}),cancelDream(){},stop(){}};}});
  const choice = service.selectDirectory(parent); service.initialize({selectionId:choice.selectionId,petName:'隔离角色',userNickname:'合成用户'});
  await service._ensureConnected(); const created = await service._newThread({content:'合成测试上下文'});
  service.threadId = created.threadId; service.conversation = created.conversation; service.pendingCreation = null;
  service.activeTurnId = native.turn.id; service.activeTurnStatus = native.turn.status; service.contextNeedsCheckpoint = true;
  service.setDraft({scope:'chat',text:'保留的合成草稿'}); service._persistRecovery();
  t.after(async()=>{await service.close(); assert.ok(path.basename(sandbox).startsWith('maid-context-隔离 ')); fs.rmSync(sandbox,{recursive:true,force:true});});
  return {service,native,sandbox};
}

for (const folder of ['src','macos/src']) {
  test(folder+': an already-connected check revalidates current proof and recovers the same conversation without sending',async t=>{
    const {service,native} = await fixture(t,folder), thread = service.threadId, conversation = service.conversation;
    service.savedContext = {threadId:thread,oldDiskProof:true};
    const state = await service.reconcile();
    assert.equal(native.calls.resume,1); assert.equal(native.resumeOptions.contextMetadata.textUpper,10000);
    assert.equal(state.contextRecoveryRequired,false); assert.equal(state.ready,true); assert.equal(state.reconciling,false);
    assert.equal(service.threadId,thread); assert.equal(service.conversation,conversation); assert.equal(state.draft,'保留的合成草稿');
    assert.equal(native.calls.send,0); assert.equal(native.calls.start,1);
  });
  test(folder+': unavailable, invalid, unconfirmed and mismatched proofs give explicit failure and retain the draft',async t=>{
    for (const mode of ['missing','invalid','pending','no-confirmation','wrong-turn','wrong-thread','read-failed']) await t.test(mode,async sub=>{
      const {service,native} = await fixture(sub,folder), thread = service.threadId;
      if (mode === 'missing') {native.contextMetadata=()=>null; service.savedContext=null;}
      if (mode === 'invalid') native.resumeThread=async()=>{throw Object.assign(Error('synthetic private detail'),{code:'CHAT_CONTEXT_METADATA_INVALID'});};
      if (mode === 'pending') native.bound.contextReady=false;
      if (mode === 'no-confirmation') native.resumeThread=async()=>({});
      if (mode === 'wrong-turn') native.contextMetadata=id=>({...native.bound,threadId:id,turnId:'different',turnStatus:'completed',model:'gpt-6.1-sol',effort:'medium'});
      if (mode === 'wrong-thread') native.contextMetadata=()=>({...native.bound,threadId:'foreign'});
      if (mode === 'read-failed') native.readOwnThread=async()=>{throw Object.assign(Error('synthetic source failure'),{code:'CHAT_SOURCE_UNAVAILABLE'});};
      await assert.rejects(service.reconcile(),error=>{assert.equal(error.code,mode==='read-failed'?'CHAT_SOURCE_UNAVAILABLE':'CHAT_CONTEXT_RECOVERY_REQUIRED'); if(mode!=='read-failed')assert.match(error.message,/容量证明仍无法核验/); return true;});
      assert.equal(service.getState().contextRecoveryRequired,true); assert.equal(service.getState().ready,false); assert.equal(service.getState().reconciling,false);
      assert.equal(service.threadId,thread); assert.equal(service.getState().draft,'保留的合成草稿'); assert.equal(native.calls.send,0); assert.equal(native.calls.start,1);
    });
  });
  test(folder+': a verified capacity at the protection line requires explicit maintenance without a fork',async t=>{
    const {service,native} = await fixture(t,folder), thread=service.threadId; native.bound.textUpper=250000;
    await assert.rejects(service.reconcile(),error=>{assert.equal(error.code,'CHAT_HANDOFF_REQUIRED'); assert.match(error.message,/已到保护线/); return true;});
    assert.equal(service.getState().contextRecoveryRequired,true); assert.equal(service.threadId,thread); assert.equal(service.getState().draft,'保留的合成草稿'); assert.equal(native.calls.start,1); assert.equal(native.calls.send,0);
  });
  test(folder+': unresolved native execution is never resumed, replayed or forked',async t=>{
    const {service,native} = await fixture(t,folder); service.unknownExecution=true; native.turn.status='unknown';
    await assert.rejects(service.reconcile(),{code:'CHAT_EXECUTION_UNKNOWN'}); assert.equal(native.calls.resume,0); assert.equal(native.calls.send,0); assert.equal(native.calls.start,1);
    assert.equal(service.getState().draft,'保留的合成草稿'); assert.equal(service.getState().contextRecoveryRequired,true);
  });
  test(folder+': a stale generating flag can be reconciled after native completion',async t=>{
    const {service,native} = await fixture(t,folder); service.generating=true;
    const result=await service.reconcile();
    assert.equal(result.generating,false); assert.equal(result.ready,true); assert.equal(result.reconciling,false);
    assert.equal(native.calls.resume,1); assert.equal(native.calls.send,0);
  });
  test(folder+': an in-progress native answer is checked without resuming or replaying it',async t=>{
    const {service,native} = await fixture(t,folder); service.generating=true; native.turn.status='inProgress';
    await assert.rejects(service.reconcile(),error=>{assert.equal(error.code,'CHAT_REQUEST_PENDING'); assert.match(error.message,/当前回答仍在进行/); return true;});
    assert.equal(native.calls.resume,0); assert.equal(native.calls.send,0); assert.equal(service.getState().reconciling,false);
    assert.equal(service.getState().draft,'保留的合成草稿');
  });
  test(folder+': checking before a native thread exists returns a final idle state',async t=>{
    const {service,native} = await fixture(t,folder); service.threadId=null; service.conversation=null; service.activeTurnId=null; service.contextNeedsCheckpoint=false;
    const result=await service.reconcile();
    assert.equal(result.reconciling,false); assert.equal(result.ready,true); assert.equal(native.calls.resume,0); assert.equal(native.calls.send,0);
  });
  test(folder+': checks serialize with sending, steering, queued draining and explicit maintenance',async t=>{
    const {service,native} = await fixture(t,folder); let release,entered;
    const started=new Promise(resolve=>{entered=resolve;}); native.resumeThread=async()=>{native.calls.resume++; entered(); await new Promise(resolve=>{release=resolve;}); return {contextRecoveryRequired:false};};
    const checking=service.reconcile(); await started;
    try {
      await assert.rejects(service.reconcile(),{code:'CHAT_REQUEST_PENDING'});
      await assert.rejects(service.send({text:'保留的合成草稿',queue:true}),{code:'CHAT_REQUEST_PENDING'});
      await assert.rejects(service.steer({text:'保留的合成草稿'}),{code:'CHAT_REQUEST_PENDING'});
      await assert.rejects(service.maintenance({action:'checkpoint'}),{code:'CHAT_REQUEST_PENDING'});
      await assert.rejects(service.configure({model:'gpt-6.1-sol',reasoningEffort:'medium'}),{code:'CHAT_REQUEST_PENDING'});
      service.checkpointPending=true; service._drain(); await Promise.resolve(); assert.equal(native.calls.send,0); assert.equal(native.calls.start,1); assert.equal(service.queued.length,0);
    } finally {release();}
    await checking; assert.equal(native.calls.resume,1); assert.equal(native.calls.start,1); assert.equal(service.checkpointPending,true); assert.equal(service.getState().draft,'保留的合成草稿');
  });
  test(folder+': a completed assistant item persists the newest runtime bound even after the turn terminal',async t=>{
    const {service,native}=await fixture(t,folder),journal=new (require('../'+folder+'/chat-journal.cjs').ChatJournal)(service.project.root,{fs:service.io});
    native.emit('turn',{threadId:service.threadId,id:native.turn.id,status:'completed'});
    native.bound.textUpper=12345;
    native.emit('message',{threadId:service.threadId,turnId:native.turn.id,id:'delayed-final',role:'assistant',phase:'final_answer',content:[{text:'Synthetic delayed final answer'}],completed:true});
    const saved=journal.read('chat-service-recovery.jsonl'); assert.equal(saved.contextMetadata.textUpper,12345); assert.equal(saved.lastReadyContextMetadata.textUpper,12345);
  });
  test(folder+': old-turn usage remains billable without lowering the accepted context and recovery snapshots are not billed twice',async t=>{
    const {service,native}=await fixture(t,folder); await service._hydrateThread(); const observe=service.usageLedger.observe.bind(service.usageLedger); let ledgerObservations=0;
    service.usageLedger.observe=input=>{ledgerObservations++;return observe(input);};
    for(const turnId of [native.turn.id,'older-turn'])service.usageLedger.begin({id:'synthetic-request-'+turnId,kind:'chat',threadId:service.threadId,turnId,model:'gpt-6.1-sol',effort:'medium'});
    native.emit('usage',{threadId:service.threadId,turnId:native.turn.id,last:{inputTokens:6000,outputTokens:1000},modelContextWindow:258400,contextAccepted:true});
    assert.equal(service.getState().budget.used,10000);
    native.emit('usage',{threadId:service.threadId,turnId:'older-turn',last:{inputTokens:12,outputTokens:3},modelContextWindow:258400,contextAccepted:false});
    assert.equal(service.getState().budget.used,10000); assert.equal(ledgerObservations,2); assert.ok(service.usageLedger.forTurn(service.threadId,'older-turn'));
    native.bound.textUpper=14000; native.bound.observedUsed=12000;
    native.emit('contextUsage',{threadId:service.threadId,turnId:native.turn.id,last:{inputTokens:10000,outputTokens:2000},modelContextWindow:258400,contextAccepted:true});
    assert.equal(service.getState().budget.used,14000); assert.equal(ledgerObservations,2);
  });
  test(folder+': a successful revalidation replaces stale displayed context usage with the verified bound',async t=>{
    const {service}=await fixture(t,folder); service.usage={used:999999,window:1,model:'gpt-6.1-sol'};
    const state=await service.reconcile();assert.equal(state.budget.used,10000);assert.equal(state.budget.window,258400);assert.equal(state.contextRecoveryRequired,false);
  });
  test(folder+': pending proofs preserve a covering terminal candidate without opening the send gate',async t=>{
    const {service,native}=await fixture(t,folder),ready=service.lastReadyContext;
    assert.equal(ready.contextReady,true); native.bound.contextReady=false; native.bound.textUpper=9000; service._persistRecovery();
    const journal=new (require('../'+folder+'/chat-journal.cjs').ChatJournal)(service.project.root,{fs:service.io}),saved=journal.read('chat-service-recovery.jsonl');
    assert.equal(saved.contextMetadata.contextReady,false);assert.equal(saved.lastReadyContextMetadata.contextReady,true);assert.deepEqual(service._recoveryContextMetadata(),ready);
    assert.equal(service.getState().contextRecoveryRequired,true);
    await assert.rejects(service.reconcile(),{code:'CHAT_CONTEXT_RECOVERY_REQUIRED'});assert.equal(service.getState().contextRecoveryRequired,true);assert.equal(native.calls.send,0);
  });
  test(folder+': a stronger or unrelated pending bound never falls back to an older terminal proof',async t=>{
    const {service,native}=await fixture(t,folder); native.bound.contextReady=false;
    const assertCurrent=()=>assert.equal(service._recoveryContextMetadata().contextReady,false);
    native.bound.textUpper=11000;assertCurrent();native.bound.textUpper=9000;
    for(const [key,value]of [['generating',true],['unknownExecution',true],['pendingDispatch',{clientId:'unknown'}],['pendingCreation',{nativeThreadId:service.threadId}]]){const before=service[key];service[key]=value;assertCurrent();service[key]=before;}
    const turn=native.turn;native.turn={...turn,id:'newer-turn'};assertCurrent();native.turn=turn;
    const previous=service.lastReadyContext;service.lastReadyContext={...previous,model:'different-model'};assertCurrent();service.lastReadyContext={...previous,effort:'high'};assertCurrent();service.lastReadyContext=previous;
    assert.equal(service.getState().contextRecoveryRequired,true);assert.equal(native.calls.resume,0);
  });
}
