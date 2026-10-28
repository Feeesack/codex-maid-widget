'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto'),{EventEmitter}=require('node:events');

const {RECOVERY_SCENARIOS}=require('../../src/chat-transport.cjs');
function fixture(t,{accountType='chatgpt',bootstrapNotice=false,noticeDuringAccountRead=false,nativeModels,modelPages,folder='src',onRpc}={}){
  const {ChatRuntime}=require('../../'+folder+'/chat-runtime.cjs');
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
        if(onRpc){const replacement=onRpc(m,{emit,runtime,result});if(replacement!==undefined)result=replacement;}
        if(m.id!==undefined)queueMicrotask(()=>{emit({id:m.id,result});if(m.method==='initialize'&&bootstrapNotice)emit({method:'account/updated',params:{}});if(m.method==='account/read'&&noticeDuringAccountRead){noticeDuringAccountRead=false;emit({method:'account/updated',params:{}});}});return true;};return child;}});
  t.after(()=>{runtime.close();fs.rmSync(base,{recursive:true,force:true});});return {runtime,root,base,data,exe,written,emit,get admissions(){return admissions;},set accountType(value){accountType=value;}};
}

module.exports={fixture};
