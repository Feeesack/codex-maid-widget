'use strict';
// Production runtime: native admission is automatic, credentials stay inside the
// installed CLI, and the project remains the same across account changes.
const fs=require('node:fs'),path=require('node:path'),{randomUUID,createHash}=require('node:crypto');
const {ChatTransport,prepareInput,READ_TOOLS,RECOVERY_SCENARIOS}=require('./chat-transport.cjs');
const {resolveCodexExecutable,findCodexCandidate,environmentValue}=require('./codex-cli.cjs');
const {admission,policyConfig,BASE,REVISION}=require('./chat-capabilities.cjs');
const {LIMITS}=require('./chat-policy.cjs');
const DEFAULT_MODEL='gpt-6.1-sol',DEFAULT_EFFORT='medium';
const fail=(code,executionState)=>Object.assign(new Error(code),{code,...(executionState?{executionState}:{})});
const terminal=status=>['completed','interrupted','cancelled','failed'].includes(status);
function measure(value){return Buffer.byteLength(typeof value==='string'?value:JSON.stringify(value??null),'utf8');}
const MEASURE_INFO=Object.freeze({kind:'utf8-byte-bpe-upper-bound',exactTokens:false,description:'UTF-8 bytes upper-bound byte-level BPE text tokens. JSON and application framing are charged separately. Images use encoded bytes plus an image reserve.'});
const CONTEXT_SCHEMA='codex-maid-context-bound/2',LEGACY_CONTEXT_SCHEMA='codex-maid-context-bound/1';
// This contract changes only when the meaning of a recorded bound changes.
// App releases, CLI binaries and public model catalogs are provenance, not a
// reason to discard a conservative bound over the same terminal conversation.
const CONTEXT_SEMANTICS=createHash('sha256').update(JSON.stringify({measurement:MEASURE_INFO.kind,base:BASE,tools:READ_TOOLS,
  charging:'utf8-json-framing-image-reserve/native-current-context-plus-1024/v1'})).digest('hex');
const ADMISSION_CHECKS=[...RECOVERY_SCENARIOS,'effectiveWindow','effort','context','failed','interrupted','controlledTool','imageDelivered','globalToolsSuppressed'];
async function resolveRuntimeExecutable(options={}){
  const platform=options.platform||process.platform,env=options.env||process.env;
  const explicit=options.codexPath||environmentValue(env,'CODEX_MAID_CODEX_PATH',platform);
  if(options.resolveExecutable)return options.resolveExecutable(explicit);
  const discovery={...options,platform,env};
  const fromPath=candidate=>findCodexCandidate(candidate,discovery);
  if(explicit)return resolveCodexExecutable(explicit,{...discovery,find:fromPath});
  // Explorer can retain an old PATH after the desktop app updates. Prefer the
  // CLI beside the identity-verified running desktop, then use normal discovery.
  try{return await resolveCodexExecutable(undefined,{...discovery,find:()=>{throw fail('CLI_MISSING');}});}
  catch(error){if(error?.code!=='CLI_MISSING')throw error;}
  return resolveCodexExecutable(undefined,{...discovery,find:fromPath});
}
class ChatRuntime extends ChatTransport{
  constructor(options={}){
    super({...options,isolateConfiguredTools:true});if(typeof options.dataDir!=='string'||!path.isAbsolute(options.dataDir))throw fail('RUNTIME_DATA_DIR_REQUIRED');
    this.cacheRoot=path.join(options.dataDir,'chat-native-runtime');this.nativeInfo=null;this.modelChoices=[];this.runtimeStarting=null;this.progress='idle';this.contextBounds=new Map();this.threadModels=new Map();this.threadInstructions=new Map();
    this.quotaScope=randomUUID();this.dreamGuards=new Map();
    this.recoveries=new Map();this.liveDispatch=new Set();this.pendingContextUsage=new Map();this.acceptedContextUsage=new Map();
    this.on('accountChanged',()=>{this.quotaScope=randomUUID();this.lastQuota=null;});
    this.on('usage',event=>{
      event.contextAccepted=false;
      const recovery=this.recoveries.get(event.threadId);
      if(recovery){if(recovery.usage.length<64)recovery.usage.push({...event});return;}
      if(this.liveDispatch.has(event.threadId)&&this.active.get(event.threadId)?.id!==event.turnId){
        const pending=this.pendingContextUsage.get(event.threadId)||[];if(pending.length<64)pending.push({...event});this.pendingContextUsage.set(event.threadId,pending);return;
      }
      this._acceptContextUsage(event);
    });
    this.on('turn',event=>{const state=this.contextBounds.get(event.threadId);
      if(state&&this.liveDispatch.has(event.threadId)&&event.status==='inProgress')state.liveTurnId=event.id;
      this._flushContextUsage(event.threadId);
    });
    this.on('message',event=>{if(event.completed&&event.role==='assistant'){const state=this.contextBounds.get(event.threadId);if(state)state.textUpper+=measure(event.content)+128;}});
  }
  measure(value){return measure(value);}
  _acceptContextUsage(event,{recovery=false}={}){
    event.contextAccepted=false;
    const state=this.contextBounds.get(event.threadId),active=this.active.get(event.threadId),selected=this.threadModels.get(event.threadId);
    const input=event.last?.inputTokens,output=event.last?.outputTokens,current=input+output;
    if(!state||!selected||state.recoveryPending===true||typeof event.turnId!=='string'||!event.turnId||active?.id!==event.turnId||
      !['inProgress','completed','interrupted','cancelled','failed'].includes(active.status)||
      !Number.isSafeInteger(input)||input<0||!Number.isSafeInteger(output)||output<0||!Number.isSafeInteger(current)||current<0||current>128*1024*1024-1024)return false;
    const previous=this.acceptedContextUsage.get(event.threadId);
    if(previous?.turnId===event.turnId&&(input<previous.input||output<previous.output||input===previous.input&&output===previous.output))return false;
    // Only a live turn dispatched by this runtime may replace the old bound
    // with a fresh native current-context observation. A resumed terminal turn
    // can increase an authenticated bound, never reduce it or clear pending.
    const reset=!recovery&&state.liveTurnId===event.turnId;
    state.textUpper=reset?current+1024:Math.max(state.textUpper,current+1024);
    state.observedUsed=reset?current:Math.max(state.observedUsed||0,current);
    if(Number.isSafeInteger(event.modelContextWindow)&&event.modelContextWindow>0)
      state.observedWindow=Math.min(state.observedWindow,this.window(selected.model).effective,event.modelContextWindow);
    this.acceptedContextUsage.set(event.threadId,{turnId:event.turnId,input,output});
    event.contextAccepted=true;event.contextUpper=state.textUpper;event.contextUsed=Math.max(state.textUpper,state.observedUsed||0);return true;
  }
  _flushContextUsage(threadId){
    const pending=this.pendingContextUsage.get(threadId);if(!pending||this.recoveries.has(threadId))return;
    this.pendingContextUsage.delete(threadId);
    for(const event of pending)if(this._acceptContextUsage(event))this.emit('contextUsage',event);
  }
  _quotaObservation(limits){
    const windows=[limits?.primary,limits?.secondary].filter(Boolean),five=windows.find(w=>w.windowDurationMins===300),week=windows.find(w=>w.windowDurationMins===10080),now=Date.now();
    if(this.account.type!=='chatgpt'||this.authChanged||!five||!week||![five.usedPercent,week.usedPercent,five.resetsAt].every(Number.isFinite)||five.resetsAt*1000<=now)return null;
    return {authType:'chatgpt',windowMinutes:300,observedAt:now,scope:`${this.quotaScope}:${this.authRevision}`,windowId:`300:${five.resetsAt}`,
      remaining:100-five.usedPercent,weekBlocked:week.usedPercent>=100,planType:this.account.planType,attribution:'shared'};
  }
  async quotaObservation(){
    await this.start();const revision=this.authRevision,limits=await super.request('account/rateLimits/read');
    if(revision!==this.authRevision||this.authChanged)return null;return this._quotaObservation(limits);
  }
  _beforeDispatch(threadId,clientMessageId,kind){
    const permit=this.dreamGuards.get(threadId);
    if(permit){permit.guard();const q=this.lastQuota;if(!q||q.scope!==permit.scope||q.windowId!==permit.windowId||q.weekBlocked||Date.now()-q.observedAt>30000||
      !Number.isFinite(permit.estimatedPoints)||q.remaining<permit.estimatedPoints+2||permit.mode==='automatic'&&q.remaining<30)throw fail('CHAT_DREAM_QUOTA_CHANGED');}
    return super._beforeDispatch(threadId,clientMessageId,kind);
  }
  get measureInfo(){return MEASURE_INFO;}
  status(){const status=super.status();return {...status,ready:status.ready&&status.connected&&status.accountType==='chatgpt'&&!status.authChanged,runtimeProgress:this.progress,measurement:MEASURE_INFO,model:DEFAULT_MODEL,effort:DEFAULT_EFFORT};}
  async start(){
    if(this.closed)throw fail('CLOSED');
    if(this.ready&&this.child&&this.nativeInfo?.proof?.expiresAt>Date.now())return this.status();
    if(this.ready&&this.child){this._release(this.child,fail('RECONNECT'));this.nativeInfo=null;}
    if(this.runtimeStarting)return this.runtimeStarting;
    const task=(async()=>{
      if(this.nativeInfo&&(this.nativeInfo.proof.expiresAt<=Date.now()||createHash('sha256').update(fs.readFileSync(this.options.codexPath)).digest('hex')!==this.nativeInfo.executableSha256))this.nativeInfo=null;
      if(!this.nativeInfo){this.progress='discovering';this.emit('readiness',{phase:this.progress});
        const executable=await resolveRuntimeExecutable({...this.options,platform:this.platform});
        if(this.closed)throw fail('CLOSED');
        this.nativeInfo=await (this.options.admitNative||admission)(executable,this.cacheRoot,{onProgress:phase=>{this.progress=phase;this.emit('readiness',{phase});}});
        if(this.closed)throw fail('CLOSED');const info=this.nativeInfo,p=info.proof;
        this.options.codexPath=executable;this.options.cliVersion=info.cliVersion;this.options.schemaFingerprint=info.schemaFingerprint;
        this.options.evidence={kind:'native-synthetic',projectRoot:this.root,cliVersion:info.cliVersion,schemaFingerprint:info.schemaFingerprint,executableSha256:info.executableSha256,
          verifiedAt:p.verifiedAt,expiresAt:p.expiresAt,scenarios:{...p.checks}};
        const selected=info.models.find(m=>m.model===DEFAULT_MODEL)||info.models[0];
        this.options.runtimeConfig=policyConfig(info.catalogPath,selected.nominal,selected.model);
      }
      this.progress='connecting';await super.start();await this.models();this.progress=this.account.type==='chatgpt'?'ready':'login-required';return this.status();
    })();this.runtimeStarting=task;try{return await task;}catch(error){this.progress=error.code||'unavailable';throw error;}finally{if(this.runtimeStarting===task)this.runtimeStarting=null;}
  }
  async models(){
    if(!this.ready)await this.start();let cursor=null;const all=[],seen=new Set();
    for(let i=0;i<8;i++){const page=await super.request('model/list',{cursor});all.push(...page.data);if(!page.nextCursor){cursor=null;break;}if(seen.has(page.nextCursor))throw fail('MODEL_CURSOR_LOOP');seen.add(page.nextCursor);cursor=page.nextCursor;}
    if(cursor)throw fail('MODEL_PAGE_LIMIT');
    this.modelChoices=all.filter(m=>!m.hidden&&this.nativeInfo.models.some(p=>p.model===m.model)).map(m=>({...m,efforts:m.supportedReasoningEfforts.map(e=>e.reasoningEffort),window:this.window(m.model)}));
    return this.modelChoices;
  }
  window(model=DEFAULT_MODEL){
    const catalog=this.nativeInfo?.models.find(m=>m.model===model);if(!catalog)return {model,verified:false,effective:null,maxGeneration:null,outputReserve:32768,maintenanceReserve:8192,source:'unavailable'};
    // One conservative client ceiling remains valid when the model is changed
    // in turn/start. A larger catalog maximum is never silently assumed.
    const nominal=Math.min(...this.nativeInfo.models.map(m=>m.nominal)),effective=Math.floor(nominal*catalog.percent/100);
    return {model,verified:this.nativeInfo?.proof?.checks?.effectiveWindow===true,nominal,effective,
      maxGeneration:null,outputReserve:32768,maintenanceReserve:8192,generationHardLimitVerified:false,source:'pinned-bundled-catalog/native-selftest',measurement:MEASURE_INFO.kind};
  }
  selection(model=DEFAULT_MODEL,effort=DEFAULT_EFFORT){
    const selected=this.modelChoices.find(m=>m.model===model);if(!selected)throw fail('MODEL_UNAVAILABLE');if(!selected.efforts.includes(effort))throw fail('EFFORT_UNAVAILABLE');return {model,effort};
  }
  async _allowMutation(){
    if(this.nativeInfo&&!this.options.admitNative){const file=this.nativeInfo.catalogPath,stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>16*1024*1024||createHash('sha256').update(fs.readFileSync(file)).digest('hex')!==this.nativeInfo.catalogSha256)throw fail('MODEL_PIN_INVALID');}
    return super._allowMutation();
  }
  threadConfig(model=DEFAULT_MODEL,effort=DEFAULT_EFFORT){
    const win=this.window(model);if(!win.verified)throw fail('WINDOW_UNVERIFIED');
    return {...policyConfig(this.nativeInfo.catalogPath,win.nominal,model),...super.threadConfig(model,effort)};
  }
  async startThread(options={}){
    await this.start();const selection=this.selection(options.model,options.effort),instructions=options.developerInstructions||'';
    const known=measure(BASE)+measure(instructions)+measure(READ_TOOLS)+8192,win=this.window(selection.model);
    if(known+win.outputReserve+win.maintenanceReserve>=0.9*win.effective)throw fail('CHAT_STARTUP_REPAIR_REQUIRED');
    const result=await super.startThread({...options,...selection,baseInstructions:BASE});
    this.contextBounds.set(result.threadId,{textUpper:known,observedUsed:0,observedWindow:win.effective});this.threadModels.set(result.threadId,selection);this.threadInstructions.set(result.threadId,instructions);return result;
  }
  async resumeThread(threadId,options={}){
    await this.start();const selection=this.selection(options.model,options.effort);
    this._own(threadId);
    if(this.recoveries.has(threadId))throw fail('CHAT_REQUEST_PENDING');
    this._assertCurrentAdmission();
    // Visible history cannot reconstruct hidden instructions/reasoning. Keep
    // the intact conservative bound; authenticate legacy provenance separately.
    const recovered=this._validatedContext(threadId,options.contextMetadata,selection);
    if(options.developerInstructions!==undefined)recovered.textUpper+=measure(options.developerInstructions)+256;
    if(!Number.isSafeInteger(recovered.textUpper)||recovered.textUpper>128*1024*1024)throw fail('CHAT_CONTEXT_METADATA_INVALID');
    const session={usage:[]};this.recoveries.set(threadId,session);
    const matches=head=>(head?.id??null)===options.contextMetadata.turnId&&(head?.status??null)===options.contextMetadata.turnStatus;
    let completed=false;
    try{
      const before=await this._recoveryHead(threadId);
      if(!matches(before))throw fail('CHAT_CONTEXT_RECOVERY_REQUIRED');
      const active=this.active.get(threadId);
      if(active&&!terminal(active.status)&&active.id&&active.id!==before?.id)throw fail('CHAT_EXECUTION_UNKNOWN');
      const result=await super.resumeThread(threadId,{...options,...selection,baseInstructions:BASE});
      const after=await this._recoveryHead(threadId);
      if(!matches(after)||!matches(before))throw fail('CHAT_CONTEXT_RECOVERY_REQUIRED');
      const current=this.active.get(threadId);
      if(current&&!terminal(current.status)&&current.id&&current.id!==after?.id)throw fail('CHAT_EXECUTION_UNKNOWN');
      if(after)this.active.set(threadId,{threadId,...after});else this.active.delete(threadId);
      this.contextBounds.set(threadId,recovered);this.threadModels.set(threadId,selection);
      this.acceptedContextUsage.delete(threadId);
      completed=true;
      return {...result,contextRecoveryRequired:recovered.recoveryPending};
    }finally{
      this.recoveries.delete(threadId);
      if(completed){for(const event of session.usage)if(this._acceptContextUsage(event,{recovery:true}))this.emit('contextUsage',event);}
      else{const state=this.contextBounds.get(threadId);if(state)state.recoveryPending=true;}
    }
  }
  async _recoveryHead(threadId){
    const first=await this.readOwnThread(threadId);
    if(!['idle','notLoaded'].includes(first.status))throw fail('CHAT_EXECUTION_UNKNOWN');
    let cursor=null,last=null,count=0;const seen=new Set(),turns=new Set();
    for(let pageNumber=0;pageNumber<128;pageNumber++){
      const page=await this.readOwnThread(threadId,{kind:'thread/turns/list',cursor,itemsView:'notLoaded'});
      for(const turn of page.data){
        if(turns.has(turn.id)||++count>6400)throw fail('CHAT_HISTORY_BOUND_EXCEEDED');
        turns.add(turn.id);if(!terminal(turn.status))throw fail('CHAT_EXECUTION_UNKNOWN');last={id:turn.id,status:turn.status};
      }
      if(page.nextCursor==null){cursor=null;break;}
      if(seen.has(page.nextCursor))throw fail('CURSOR_LOOP');seen.add(page.nextCursor);cursor=page.nextCursor;
    }
    if(cursor!==null)throw fail('CHAT_HISTORY_BOUND_EXCEEDED');
    const final=await this.readOwnThread(threadId);
    if(!['idle','notLoaded'].includes(final.status))throw fail('CHAT_EXECUTION_UNKNOWN');
    return last;
  }
  contextMetadata(threadId){
    this._own(threadId);const state=this.contextBounds.get(threadId),selection=this.threadModels.get(threadId);
    if(!this.nativeInfo||!state||!selection)throw fail('CHAT_CONTEXT_RECOVERY_REQUIRED');
    const active=this.active.get(threadId);
    const value={schema:CONTEXT_SCHEMA,contextSemantics:CONTEXT_SEMANTICS,threadId,projectRoot:this.root,model:selection.model,effort:selection.effort,
      textUpper:state.textUpper,observedUsed:state.observedUsed??null,observedWindow:state.observedWindow,
      turnId:active?.id??null,turnStatus:active?.status??null,contextReady:state.recoveryPending!==true&&(!active||terminal(active.status)),
      cliVersion:this.nativeInfo.cliVersion,schemaFingerprint:this.nativeInfo.schemaFingerprint,executableSha256:this.nativeInfo.executableSha256,
      catalogSha256:this.nativeInfo.catalogSha256||null,measurement:MEASURE_INFO.kind,capturedAt:Date.now()};
    return {...value,integrity:createHash('sha256').update(JSON.stringify(value)).digest('hex')};
  }
  _validatedContext(threadId,value,selection){
    this._own(threadId);if(!value||typeof value!=='object'||Array.isArray(value))throw fail('CHAT_CONTEXT_RECOVERY_REQUIRED');
    const legacy=value.schema===LEGACY_CONTEXT_SCHEMA;
    const keys=['schema',...(!legacy?['contextSemantics']:[]),'threadId','projectRoot','model','effort','textUpper','observedUsed','observedWindow','turnId','turnStatus','contextReady','cliVersion','schemaFingerprint','executableSha256','catalogSha256','measurement','capturedAt','integrity'];
    if(Object.keys(value).length!==keys.length||keys.some(key=>!Object.hasOwn(value,key)))throw fail('CHAT_CONTEXT_METADATA_INVALID');
    const payload=Object.fromEntries(Object.entries(value).filter(([key])=>key!=='integrity'));
    if(![CONTEXT_SCHEMA,LEGACY_CONTEXT_SCHEMA].includes(value.schema)||!legacy&&value.contextSemantics!==CONTEXT_SEMANTICS||value.threadId!==threadId||!this.sameRoot(value.projectRoot)||value.measurement!==MEASURE_INFO.kind||
      value.integrity!==createHash('sha256').update(JSON.stringify(payload)).digest('hex'))throw fail('CHAT_CONTEXT_METADATA_INVALID');
    const original=this.selection(value.model,value.effort),window=this.window(selection.model);
    if(original.model!==selection.model||original.effort!==selection.effort||!window.verified)throw fail('CHAT_CONTEXT_METADATA_INVALID');
    if(!Number.isSafeInteger(value.textUpper)||value.textUpper<0||value.textUpper>128*1024*1024||
      value.observedUsed!==null&&(!Number.isSafeInteger(value.observedUsed)||value.observedUsed<0||value.observedUsed>value.textUpper)||
      !Number.isSafeInteger(value.observedWindow)||value.observedWindow<1||value.observedWindow>128*1024*1024||
      value.turnId!==null&&(typeof value.turnId!=='string'||!value.turnId||value.turnId.length>256||/[\0\r\n]/.test(value.turnId))||
      ![null,'inProgress','unknown','completed','interrupted','cancelled','failed'].includes(value.turnStatus)||typeof value.contextReady!=='boolean'||
      value.contextReady&&value.turnStatus!==null&&!terminal(value.turnStatus)||
      !Number.isSafeInteger(value.capturedAt)||value.capturedAt<1||value.capturedAt>Date.now()+300000||
      typeof value.cliVersion!=='string'||value.cliVersion.length>128||!value.cliVersion||/[\0\r\n]/.test(value.cliVersion)||
      !/^[a-f0-9]{64}$/.test(value.schemaFingerprint)||!/^[a-f0-9]{64}$/.test(value.executableSha256)||
      value.catalogSha256!==null&&!/^[a-f0-9]{64}$/.test(value.catalogSha256))throw fail('CHAT_CONTEXT_METADATA_INVALID');
    if(legacy){
      const same=value.cliVersion===this.nativeInfo.cliVersion&&value.schemaFingerprint===this.nativeInfo.schemaFingerprint&&
        value.executableSha256===this.nativeInfo.executableSha256&&value.catalogSha256===(this.nativeInfo.catalogSha256||null);
      if(!same)this._validateLegacyProvenance(value);
    }
    return {textUpper:value.textUpper,observedUsed:value.observedUsed,observedWindow:Math.min(value.observedWindow,window.effective),recoveryPending:!value.contextReady};
  }
  _assertCurrentAdmission(){
    const proof=this.nativeInfo?.proof,now=Date.now();
    if(!proof||proof.revision!==REVISION||proof.executableSha256!==this.nativeInfo.executableSha256||proof.schemaFingerprint!==this.nativeInfo.schemaFingerprint||
      proof.catalogSha256!==(this.nativeInfo.catalogSha256||null)||proof.cliVersion!==this.nativeInfo.cliVersion||
      !Number.isSafeInteger(proof.verifiedAt)||proof.verifiedAt>now||!Number.isSafeInteger(proof.expiresAt)||proof.expiresAt<=now||
      ADMISSION_CHECKS.some(check=>proof.checks?.[check]!==true))throw fail('NATIVE_ADMISSION_REQUIRED');
  }
  _validateLegacyProvenance(value){
    if(value.schemaFingerprint!==this.nativeInfo.schemaFingerprint||value.contextReady!==true||value.turnStatus!==null&&!terminal(value.turnStatus))throw fail('CHAT_CONTEXT_METADATA_INVALID');
    const file=path.join(this.cacheRoot,'admission-'+value.executableSha256.slice(0,16)+'.json');let proof;
    try{const stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>65536)throw fail('CHAT_CONTEXT_METADATA_INVALID');proof=JSON.parse(fs.readFileSync(file,'utf8'));}
    catch{throw fail('CHAT_CONTEXT_METADATA_INVALID');}
    // Expiry controls permission to execute that binary now, not the lifetime
    // of its already-measured numeric bound. A long-running old app could
    // legitimately capture after expiry; the new binary still needs fresh
    // admission and both native terminal heads must match before migration.
    if(proof.revision!==10||proof.cliVersion!==value.cliVersion||proof.executableSha256!==value.executableSha256||
      proof.schemaFingerprint!==value.schemaFingerprint||proof.catalogSha256!==value.catalogSha256||
      !Number.isSafeInteger(proof.verifiedAt)||proof.verifiedAt<1||proof.verifiedAt>Date.now()+300000||
      !Number.isSafeInteger(proof.expiresAt)||proof.expiresAt<=proof.verifiedAt||ADMISSION_CHECKS.some(check=>proof.checks?.[check]!==true))throw fail('CHAT_CONTEXT_METADATA_INVALID');
  }
  restoreContextMetadata(threadId,value){
    const selection=this.selection(value?.model,value?.effort),state=this._validatedContext(threadId,value,selection);
    const current=this.active.get(threadId);
    if((current?.id??null)!==value.turnId||(current?.status??null)!==value.turnStatus)state.recoveryPending=true;
    this.contextBounds.set(threadId,state);this.threadModels.set(threadId,selection);return this.contextMetadata(threadId);
  }
  _capacity(threadId,input,model,extra){
    const win=this.window(model),state=this.contextBounds.get(threadId);if(!win.verified||!state)throw fail('WINDOW_UNVERIFIED');
    if(state.recoveryPending)throw fail('CHAT_CONTEXT_RECOVERY_REQUIRED');
    const images=input.filter(p=>p.type==='image'),encoded=measure(input)+measure(extra||'')+images.length*8192+256;
    const used=Math.max(state.textUpper,state.observedUsed||0),effective=Math.min(win.effective,state.observedWindow||win.effective);
    if(used>=0.95*effective||used+encoded+win.outputReserve+win.maintenanceReserve>effective)throw fail('CHAT_HANDOFF_REQUIRED');return {encoded,used,effective};
  }
  async send(threadId,options={}){
    try{return await this._sendWithBudget(threadId,options);}catch(error){if(error.executionState!=='unknown')error.executionState='not-executed';throw error;}
  }
  async _sendWithBudget(threadId,options={}){
    await this.start();const previous=this.threadModels.get(threadId)||{},selection=this.selection(options.model||previous.model,options.effort||previous.effort),input=prepareInput(options);
    const quota=await super.request('account/rateLimits/read');
    this.lastQuota=this._quotaObservation(quota);
    if(!quota.primary||typeof quota.primary.usedPercent!=='number')throw fail('CHAT_QUOTA_UNVERIFIED');
    if(quota.primary.usedPercent>=100||quota.secondary?.usedPercent>=100)throw fail('CHAT_QUOTA_EXHAUSTED');
    const bound=this._capacity(threadId,input,selection.model,{additionalContext:options.additionalContext,outputSchema:options.outputSchema});const state=this.contextBounds.get(threadId);state.textUpper+=bound.encoded;
    // A lost acknowledgement remains charged in memory; it is never replayed.
    this.liveDispatch.add(threadId);
    try{const result=await super.send(threadId,{...options,...selection});state.liveTurnId=result.id;this.threadModels.set(threadId,selection);this._flushContextUsage(threadId);return result;}
    catch(error){if(error.executionState==='not-executed')state.textUpper-=bound.encoded;throw error;}
    finally{this.liveDispatch.delete(threadId);this.pendingContextUsage.delete(threadId);}
  }
  async steer(threadId,options={}){
    let charged,state;
    try{const selection=this.threadModels.get(threadId)||this.selection(),input=prepareInput(options),bound=this._capacity(threadId,input,selection.model,options.additionalContext);
      state=this.contextBounds.get(threadId);charged=bound.encoded;state.textUpper+=charged;return await super.steer(threadId,options);
    }catch(error){if(error.executionState!=='unknown'){error.executionState='not-executed';if(state&&charged)state.textUpper-=charged;}throw error;}
  }
  async refreshConnection(){
    const metadata=this.recoveryMetadata();this._release(this.child,fail('RECONNECT'));this.authChanged=false;this.account={type:null,planType:null};await this.start();
    // Same device/project, new account: memory and owned native IDs are retained.
    return {...this.status(),reconciliationRequired:metadata.turns.some(t=>!terminal(t.status))};
  }
  async generate({projectRoot,purpose='maintenance',model=DEFAULT_MODEL,effort=DEFAULT_EFFORT,instructions='',input='',outputSchema,maxOutputTokens=LIMITS.node,signal,onEvent,timeoutMs=120000,dreamPermit,requestId=randomUUID()}={}){
    if(projectRoot!==undefined&&!this.sameRoot(projectRoot))throw fail('THREAD_SCOPE');
    const dreaming=purpose==='dream'||purpose==='dreaming';
    const developerInstructions=`Maintenance task: ${purpose}. Return only the final requested result. Final visible content must stay within ${maxOutputTokens} UTF-8 bytes.\n${instructions}`;
    if(dreaming){if(!dreamPermit||typeof dreamPermit.guard!=='function'||!/^D-[a-f0-9-]{36}$/.test(dreamPermit.id||'')||dreamPermit.guarantee!==false)throw fail('DREAM_ESTIMATE_PERMIT_REQUIRED');
      if(maxOutputTokens>2000||measure({baseInstructions:BASE,developerInstructions,input,outputSchema})+1024>8000)throw fail('CHAT_DREAM_INPUT_BUDGET');dreamPermit.guard();}
    if(signal?.aborted)throw fail('CANCELLED');if(!Number.isSafeInteger(maxOutputTokens)||maxOutputTokens<1||maxOutputTokens>32768)throw fail('INVALID_OUTPUT_LIMIT');
    await this.start();const selection=this.selection(model,effort);
    if(dreaming)dreamPermit.guard();
    const started=await this.startThread({...selection,allowTools:false,developerInstructions}),threadId=started.threadId;
    onEvent?.({type:'locator',threadId,requestId});if(dreaming)this.dreamGuards.set(threadId,dreamPermit);
    let turnId=null,finalText='',usage=null,timer,abort;const fragments=new Map();let settle;
    const completed=new Promise((resolve,reject)=>{settle={resolve,reject};});
    completed.catch(()=>{}); // A disconnect may reject while turn/start is awaiting its acknowledgement.
    const message=e=>{if(e.threadId!==threadId||e.role!=='assistant'||!e.completed||e.phase!=='final_answer')return;fragments.set(e.id,e.content.map(p=>p.text||'').join(''));finalText=[...fragments.values()].join('\n');onEvent?.({type:'final',text:finalText});};
    const used=e=>{if(e.threadId===threadId){usage=e.last;onEvent?.({type:'usage',threadId,turnId:e.turnId,last:e.last,total:e.total});}};
    const done=e=>{if(e.threadId===threadId&&terminal(e.status)){turnId=e.id;settle.resolve(e.status);}};
    const disconnect=()=>settle.reject(fail('UNKNOWN_EXECUTION','unknown'));
    this.on('message',message);this.on('usage',used);this.on('turn',done);this.on('disconnected',disconnect);
    try{
      timer=setTimeout(()=>{if(turnId)this.interrupt(threadId,turnId).catch(()=>{});settle.reject(fail('GENERATION_TIMEOUT','unknown'));},Math.min(300000,Math.max(1000,timeoutMs)));
      abort=()=>{if(turnId)this.interrupt(threadId,turnId).catch(()=>{});};signal?.addEventListener('abort',abort,{once:true});
      if(signal?.aborted)throw fail('CANCELLED','not-executed');
      const sent=await this.send(threadId,{...selection,text:typeof input==='string'?input:JSON.stringify(input),clientMessageId:requestId,outputSchema});turnId=sent.id;onEvent?.({type:'locator',threadId,requestId,turnId});if(signal?.aborted)abort();if(terminal(sent.status))settle.resolve(sent.status);
      const status=await completed;
      // Tool/stream event ordering is not a source of final-text invention.
      if(status==='completed'&&!finalText){const page=await this.readOwnThread(threadId,{kind:'thread/turns/list'});const turn=page.data.find(t=>t.id===turnId);finalText=turn?.items.filter(i=>i.role==='assistant'&&i.phase==='final_answer').map(i=>i.content.map(p=>p.text||'').join('')).join('\n')||'';}
      if(status==='completed'&&measure(finalText)>maxOutputTokens)throw fail('CHAT_GENERATION_OUTPUT_BUDGET');
      return {status,finalText,usage,requestId,threadId,turnId,measurement:MEASURE_INFO};
    }catch(error){error.locator={threadId,turnId,requestId};throw error;
    }finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);this.dreamGuards.delete(threadId);this.off('message',message);this.off('usage',used);this.off('turn',done);this.off('disconnected',disconnect);}
  }
}
module.exports={ChatRuntime,measure,MEASURE_INFO,DEFAULT_MODEL,DEFAULT_EFFORT,resolveRuntimeExecutable};
