(function () {
  'use strict';
  const $=id=>document.getElementById(id),maid=window.maid,view=window.MaidChatView,t=value=>window.MaidI18n?.t(value)||value;
  const modelControls=view.mountModels({document,maid,t});
  let state=null,parts=[],composerRevision=0,localEdited=false,sending=false,reconciling=false,reconcileMessage='',reconcileReadiness=null,pageOffset=null,pageRequest=0,historyCursor=null,historyConversation=null,historyOffset=0,historyTotal=0,historyNext=null,historyPrevious=[],modelsLoaded=false,dreamEdited=false,dreamPending=false,latestDream=null,lastReadinessNotice='';
  const element=(tag,text)=>{const node=document.createElement(tag);if(text!==undefined)node.textContent=text;return node;};
  const error=(target,value)=>{$(target).textContent=value?.message||t(String(value));};
  const asMessages=value=>Array.isArray(value)?value:value?.messages||[];
  function syncDraft(){localEdited=true;composerRevision++;void maid.setChatDraft({scope:'chat',text:[...parts.map(part=>part.text??`[${t('图片')}：${part.name||''}]`),$('manager-chat-input').value].join('\n')}).catch(value=>error('manager-status',value));}
  function composer(){
    $('composer-parts').replaceChildren(...parts.map((part,index)=>{
      const card=element('div');card.className='composer-part';
      if(part.imageId){const img=element('img');img.src=view.imageData(part.dataUrl)||'';img.alt=part.name||t('图片');card.append(img,element('small',part.name||t('图片')));}
      else {const text=element('textarea');text.value=part.text;text.rows=2;text.addEventListener('input',()=>{part.text=text.value;syncDraft();});card.append(text);}
      const remove=element('button',t('移除'));remove.type='button';remove.addEventListener('click',()=>{parts.splice(index,1);if(part.imageId)void maid.dropChatImages({imageIds:[part.imageId]}).catch(value=>error('manager-status',value));composer();syncDraft();});card.append(remove);return card;
    }));
  }
  async function addImages(paste=false){try{const result=await(paste?maid.pasteChatImage():maid.chooseChatImages());if(!result.images?.length)return;const text=$('manager-chat-input').value;if(text){parts.push({text});$('manager-chat-input').value='';}parts.push(...result.images);composer();syncDraft();}catch(value){error('manager-status',value);}}
  $('choose-chat-images').addEventListener('click',()=>void addImages());$('paste-chat-image').addEventListener('click',()=>void addImages(true));
  $('manager-chat-input').addEventListener('input',syncDraft);
  $('manager-chat-input').addEventListener('paste',event=>{if(Array.from(event.clipboardData?.items||[]).some(item=>item.type.startsWith('image/'))){event.preventDefault();void addImages(true);}});
  function payload(){const content=parts.map(part=>part.imageId?{imageId:part.imageId}:{text:part.text});if($('manager-chat-input').value)content.push({text:$('manager-chat-input').value});return content.length?{content}:null;}
  async function send(kind='send'){
    const input=payload();if(!input||sending||reconciling||state?.reconciling)return;if(!state?.initialized||state.unknownExecution)return;
    const at=composerRevision,submitted=parts.map(part=>({part,content:JSON.stringify(part)}));sending=true;render(state);
    try{const result=await(kind==='steer'?maid.steerChat(input):maid.sendChat({...input,...(kind==='queue'?{queue:true}:{})}));
      if(composerRevision===at){parts=[];$('manager-chat-input').value='';localEdited=false;composer();}else{parts=parts.filter(part=>!submitted.some(item=>item.part===part&&item.content===JSON.stringify(part)));composer();syncDraft();}
      pageOffset=null;render(result?.initialized!==undefined?result:await maid.getChatState());
    }catch(value){error('manager-status',value);}finally{sending=false;if(state)render(state);}
  }
  $('manager-chat-form').addEventListener('submit',event=>{event.preventDefault();void send();});$('chat-append').addEventListener('click',()=>void send('steer'));$('chat-queue').addEventListener('click',()=>void send('queue'));
  async function action(button,method){button.disabled=true;try{const result=await method();render(result?.initialized!==undefined?result:await maid.getChatState());}catch(value){error('manager-status',value);}finally{if(state)render(state);}}
  async function reconcileChat(){
    if(reconciling||state?.reconciling)return;
    reconciling=true;reconcileMessage='';reconcileReadiness=null;render(state);
    try{
      const result=await maid.reconcileChat(),next=result?.initialized!==undefined?result:await maid.getChatState();
      render(next);
      if(next.contextRecoveryRequired)reconcileMessage='仍未能确认当前聊天容量；原对话与输入已保留。请重试核对，或在“换聊与维护”中主动整理并开启新对话。';
      else if(next.unknownExecution||!next.ready)reconcileReadiness=next;
      else reconcileMessage=next.generating?'已核对聊天状态，当前回答仍在进行。':'已核对并恢复聊天，可以继续发送；原对话与输入已保留。';
    }catch(value){reconcileMessage=(value?.message||String(value)).replace(/^Error invoking remote method ['"]chat-reconcile['"]:\s*(?:Error:\s*)?/,'');}
    finally{reconciling=false;render(state);}
  }
  $('chat-interrupt').addEventListener('click',()=>void action($('chat-interrupt'),()=>maid.interruptChat()));$('chat-reconcile').addEventListener('click',()=>void reconcileChat());
  async function loadMessages(offset){const request=++pageRequest;try{const result=await maid.listChatMessages({offset,limit:50});if(request!==pageRequest)return;pageOffset=result.offset;view.renderMessages($('manager-messages'),asMessages(result),t,{onReference:openReference});$('messages-range').textContent=`${result.offset+1}–${Math.min(result.total,result.offset+result.messages.length)} / ${result.total}`;$('messages-previous').disabled=result.offset===0;}catch(value){error('manager-status',value);}}
  $('messages-previous').addEventListener('click',()=>void loadMessages(Math.max(0,(pageOffset??Math.max(0,(state?.messageCount||0)-50))-50)));
  $('messages-latest').addEventListener('click',()=>{pageOffset=null;if(state)render(state);});
  function render(value){
    state=value;if(!value)return;
    if(value.ready&&!modelsLoaded){modelsLoaded=true;void modelControls?.load();}
    const connecting=value.connecting||value.connection?.state==='connecting',checking=reconciling||value.reconciling===true;
    $('connection-label').textContent=t(connecting?'正在连接':value.ready?'可以聊天':'需要处理');
    $('manager-send').disabled=sending||checking||!value.ready||value.generating||value.unknownExecution;
    $('chat-append').disabled=sending||checking||!value.generating||value.unknownExecution||value.contextRecoveryRequired||value.desktopProject?.registrationRequired;$('chat-interrupt').disabled=!value.generating;$('chat-queue').disabled=sending||checking||!value.initialized||value.unknownExecution||value.contextRecoveryRequired||value.desktopProject?.registrationRequired;
    const readinessNotice=value.contextRecoveryRequired||value.desktopProject?.registrationRequired||value.desktopProject?.reconciliation?.needsReconciliation?view.readinessText(value,t,{includeProjectDirectory:true}):'';
    if(readinessNotice||lastReadinessNotice&&$('manager-status').textContent===lastReadinessNotice)$('manager-status').textContent=readinessNotice;
    lastReadinessNotice=readinessNotice;
    $('chat-reconcile').disabled=checking||!!connecting;
    $('chat-reconcile').setAttribute('aria-busy',String(checking));
    $('chat-reconcile').setAttribute('data-i18n',checking?'正在核对…':'核对并恢复聊天');
    $('chat-reconcile').textContent=t(checking?'正在核对…':'核对并恢复聊天');
    const reconcileNotice=checking?t('正在核对聊天状态与上下文容量…'):reconcileReadiness?view.readinessText(reconcileReadiness,t,{includeProjectDirectory:true}):t(reconcileMessage);
    $('chat-reconcile-status').textContent=reconcileNotice;$('chat-reconcile-status').hidden=!reconcileNotice;
    for(const id of ['choose-chat-images','paste-chat-image'])$(id).disabled=!value.initialized;
    if(!localEdited&&!parts.length)$('manager-chat-input').value=value.draft||'';
    if(pageOffset===null){view.renderMessages($('manager-messages'),value.messages||[],t,{onReference:openReference,followEnd:true});const total=value.messageCount??value.messages?.length??0;$('messages-range').textContent=total?`${Math.max(1,total-49)}–${total} / ${total}`:'0 / 0';$('messages-previous').disabled=total<=50;}
    $('queued-messages').replaceChildren(...(Array.isArray(value.queued)?value.queued:[]).map(item=>element('li',item.text||item.content?.map(part=>part.text||`[${t('图片')}]`).join('')||item.id)));
    if(value.maintenance)(window.MaidChatManager?.renderMaintenance||renderMaintenance)(value.maintenance);
    renderDream(value.dream||value.health?.dreaming||{state:'not-ready'});
  }
  async function listHistory(reset=false){try{const result=await maid.listChatHistory({cursor:reset?null:historyCursor,limit:20});if(reset)$('history-list').replaceChildren();for(const item of result.conversations||[]){const button=element('button',`${item.title||item.conversationId} · ${item.startedAt||''}`);button.className='memory-entry';button.type='button';button.addEventListener('click',()=>{historyConversation=item.conversationId;historyOffset=0;historyPrevious=[];void readHistory();});$('history-list').append(button);}historyCursor=result.nextCursor??null;$('history-more').disabled=historyCursor===null;error('history-status',(result.conversations||[]).length?'':'尚无条目');}catch(value){error('history-status',value);}}
  async function readHistory(){if(!historyConversation)return;try{const result=await maid.readChatHistory({conversationId:historyConversation,offset:historyOffset,limit:50});historyOffset=result.offset;historyTotal=result.total;historyNext=result.nextOffset??(historyTotal!==null&&historyOffset+asMessages(result).length<historyTotal?historyOffset+asMessages(result).length:null);view.renderMessages($('history-messages'),asMessages(result),t,{onReference:openReference});$('history-messages-more').disabled=historyNext===null;$('history-messages-previous').disabled=historyOffset===0;$('history-status').textContent=`${result.title||result.conversationId} · ${asMessages(result).length?historyOffset+1:0}–${historyOffset+asMessages(result).length} / ${historyTotal??'…'}`;}catch(value){error('history-status',value);}}
  async function openReference(reference){if(window.MaidChatManager)return window.MaidChatManager.openReference(reference);try{const result=await maid.resolveChatReference({reference});const message={role:'assistant',text:result.text||result.record?.content?.map(part=>part.text||'').join('')||'',content:result.content||result.record?.content||(result.image?[{image:result.image}]:undefined)};view.renderMessages($('history-messages'),[message],t);$('history-status').textContent=result.reference||reference;$('history-messages').scrollIntoView({block:'nearest'});}catch(value){error('history-status',value);}}
  if(!window.MaidChatManager){
  $('history-refresh').addEventListener('click',()=>void listHistory(true));$('history-more').addEventListener('click',()=>void listHistory());$('history-messages-more').addEventListener('click',()=>{if(historyNext===null)return;historyPrevious.push(historyOffset);historyOffset=historyNext;void readHistory();});$('history-messages-previous').addEventListener('click',()=>{historyOffset=historyPrevious.pop()??0;void readHistory();});$('source-open').addEventListener('click',()=>void openReference($('source-reference').value.trim()));
  }
  function renderMaintenance(value){$('maintenance-status').textContent=[view.statusText(value.state||'not-ready',t),view.statusText(value.stage,t),value.reason||''].filter(Boolean).join(' · ');$('maintenance-stages').replaceChildren(...(value.plan||value.stages||[]).map(item=>element('li',`${view.statusText(item.stage||item.name,t)} · ${view.statusText(item.state,t)}`)));const used=value.used||{},limits=value.limits||value.budget||{};$('maintenance-budget').textContent=[['模型调用',used.calls,limits.calls],['输入tokens',used.input,limits.input],['输出tokens',used.output,limits.output],['活动时间（毫秒）',used.activeMs,limits.activeMs]].filter(([,actual,limit])=>actual!==undefined||limit!==undefined).map(([label,actual,limit])=>`${t(label)}：${actual??'—'} / ${limit??'—'}`).join('\n');$('maintenance-stop').disabled=!['running','inflight'].includes(value.state);$('maintenance-resume').disabled=!['paused','failed'].includes(value.state);}
  for(const [id,command]of [['maintenance-checkpoint','checkpoint'],['maintenance-stop','stop'],['maintenance-resume','resume'],['maintenance-repair','repair']])$(id).addEventListener('click',async()=>{try{(window.MaidChatManager?.renderMaintenance||renderMaintenance)(await maid.chatMaintenance({action:command}));render(await maid.getChatState());}catch(value){error('maintenance-status',value);}});
  $('relocate-project').addEventListener('click',async()=>{try{const selection=await maid.chooseChatDirectory({mode:'relocate'});if(selection.cancelled)return;const result=await maid.relocateChatProject({selectionId:selection.selectionId});render(result?.initialized!==undefined?result:await maid.getChatState());error('relocate-status','已复制并核验，现已切换；原目录已保留。');}catch(value){error('relocate-status',value);}});
  function renderDream(value){
    latestDream=value;
    const display=view.dreamPresentation(value,t),last=value.last||value;
    $('dream-status').textContent=[display.status,display.detail].filter(Boolean).join(' · ');
    $('dream-progress').textContent=Number.isFinite(last.progress)?`${t('进度')}：${Math.round(last.progress*100)}%`:last.stage?view.statusText(last.stage,t):'';
    $('dream-budget').replaceChildren(...display.metrics.flatMap(([label,value])=>[element('dt',label),element('dd',value)]));
    $('dream-estimate-method').textContent=display.estimateNote;
    $('dream-observation').textContent=display.observation;
    $('dream-automatic-waiting').textContent=display.automatic;
    $('dream-coverage').replaceChildren(...display.coverage.map(text=>element('p',text)));
    $('dream-benefits').replaceChildren(...display.benefits.map(text=>element('p',text)));
    $('dream-candidates').replaceChildren(...display.candidates.map(item=>{const row=element('article');row.className='dream-candidate';row.append(element('p',item.text),element('strong',item.label));for(const detail of item.details)row.append(element('p',detail));for(const reference of item.sources.slice(0,4)){const source=element('button',t('查看来源'));source.type='button';source.className='source-link';source.addEventListener('click',()=>void openReference(reference));row.append(source);}if(item.sources.length>4)row.append(element('small',`${t('来源总数')}：${item.sources.length}`));return row;}));
    $('dream-checks').replaceChildren(...display.checks.map(text=>element('p',text)));
    $('dream-cancel').disabled=!display.running;
    $('dream-now').disabled=dreamPending||display.running||display.unknown||!state?.initialized;
    $('dream-check').disabled=dreamPending||display.running||!state?.initialized;
    $('dream-reconcile').hidden=!display.unknown;
    $('dream-reconcile').disabled=dreamPending;
    $('dream-configure').disabled=dreamPending||display.running;
    if(!dreamEdited){if(value.mode||value.settings?.mode)$('dream-mode').value=value.mode||value.settings.mode;if(value.settings?.target)$('dream-target').value=value.settings.target;}
  }
  for(const id of ['dream-mode','dream-target'])$(id).addEventListener('input',()=>{dreamEdited=true;void maid.setChatDraft({scope:'dream',text:JSON.stringify({mode:$('dream-mode').value,target:$('dream-target').value})}).catch(value=>error('dream-status',value));});
  async function dream(action){
    const waits=['run','check','reconcile'].includes(action);let failure;if(waits&&dreamPending)return;
    if(waits){dreamPending=true;if(latestDream)renderDream(latestDream);}
    try{const value=await maid.chatDream({action,...(action==='configure'?{mode:$('dream-mode').value,target:$('dream-target').value}:{}),...(['run','check'].includes(action)?{target:$('dream-target').value}: {})});if(action==='configure'){dreamEdited=false;void maid.setChatDraft({scope:'dream',text:''});}renderDream(value);}
    catch(value){failure=value;}
    finally{if(waits){dreamPending=false;if(latestDream)renderDream(latestDream);}if(failure)error('dream-status',failure);}
  }
  $('dream-now').addEventListener('click',()=>void dream('run'));$('dream-check').addEventListener('click',()=>void dream('check'));$('dream-reconcile').addEventListener('click',()=>void dream('reconcile'));$('dream-configure').addEventListener('click',()=>void dream('configure'));$('dream-cancel').addEventListener('click',()=>void dream('cancel'));
  maid.onChatState(render);maid.onState(value=>{modelControls?.render(value.settings);if(state)render(state);});
  void maid.getState().then(value=>modelControls?.render(value.settings));void maid.getChatState().then(render).catch(value=>error('manager-status',value));
  window.MaidChatWorkspace={render,openReference};
})();
