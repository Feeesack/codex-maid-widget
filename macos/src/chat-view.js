(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MaidChatView = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  function readinessText(state, t = value => value, { includeProjectDirectory = false } = {}) {
    if (!state?.initialized) return t('先建立桌宠聊天项目');
    if (state.storageError) return t('聊天资料需要恢复，原文件已保留');
    if (state.unknownExecution) return t('上次请求状态待核对，请勿重发');
    if (state.reconciling) return t('正在核对聊天状态与上下文容量…');
    if (state.contextRecoveryRequired) return t('当前聊天的上下文容量需要核对，原对话和输入已保留；请先核对恢复，或由你明确选择整理并开启新对话。');
    if (state.desktopProject?.registrationRequired) {
      const notice = t('请先在 Codex 项目栏添加桌宠专用项目目录，再核对连接；原对话和输入已保留。');
      return includeProjectDirectory && typeof state.project?.directory === 'string' ? `${notice}\n${t('项目目录')}：${state.project.directory}` : notice;
    }
    if (state.desktopProject?.reconciliation?.needsReconciliation) return t('部分旧对话尚未归入桌宠项目；请核对项目归属后重试。');
    if (state.connecting||state.connection?.state==='connecting') return t('正在连接聊天服务，请稍候…');
    if (state.error) return state.error.message || String(state.error);
    if (!state.ready) {
      const reason = state.connection?.reason || state.reason;
      const details = {
        THREAD_WRITER_CONFLICT: '当前聊天正被 Codex 客户端占用，请先关闭该聊天后再从桌宠发送。',
        THREAD_NOT_LOADED: '当前聊天尚未恢复，请先重试连接。',
        ACCOUNT_CHANGED: 'Codex 登录状态已失效，请在 Codex 客户端重新登录后重试。',
      };
      return t(details[reason] || reason || '暂不能发送，请查看健康状态');
    }
    return t(state.mode === 'simulation' ? '隔离模拟，非真实聊天' : '可以聊天');
  }
  function imageData(value) { return typeof value==='string'&&/^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(value)?value:null; }
  function memorySyncPresentation(state={},t=value=>value) {
    const sync=state.memory?.sync;
    let status=sync?.state;
    if(status==='failed'&&sync.confirmed!==true)status='checking';
    if(status==='synced'&&state.memory.pendingSync===true)status='pending-next-request';
    if(!['not-connected','checking','pending-next-request','synced','failed'].includes(status)){
      if(!state.initialized||!state.memory)status='not-connected';
      else if(state.connecting||state.connection?.state==='connecting'||state.unknownExecution)status='checking';
      else if(!state.ready&&state.connection?.state!=='ready')status='not-connected';
      else if(state.memory.pendingSync===true)status='pending-next-request';
      else if(state.memory.pendingSync===false)status='synced';
      else status='checking';
    }
    const labels={'not-connected':'未连接',checking:'核对中','pending-next-request':'待随下次消息同步',synced:'已随请求同步',failed:'同步失败'};
    const details={'not-connected':'已保存的记忆仍保留；连接后会核对并在需要时随下一条消息同步。',checking:'正在核对本次会话的记忆同步状态；已保存的资料不会因此丢失。','pending-next-request':'记忆已保存，下次发送消息时会核对并提供给模型。',synced:'已确认随请求提供当前记忆；这不代表模型必然理解或每句遵守。',failed:'本次记忆同步未完成；已保存资料和输入仍保留，请核对后重试。'};
    return {state:status,label:t(labels[status]),detail:t(details[status])};
  }
  function statusText(value,t=value=>value){return t(({active:'有效',tentative:'暂时观察',needs_review:'待复核',withdrawn:'已撤下',suspended:'已暂停',corrected:'已纠正',superseded:'已替代',conflict:'存在冲突',running:'运行中',pending:'待处理',waiting:'等待条件',cancelling:'正在取消',paused:'已暂停',failed:'失败',completed:'已完成',idle:'空闲',unknown:'待核对',cancelled:'已取消',archive:'归档',memory:'记忆',tree:'摘要树',handoff:'近期交接',validate:'校验',load:'加载上下文',switch:'切换对话',candidate:'候选待核验',adopted:'已采用',discarded:'已失效','no-work':'无需处理','no-change':'无需修改','budget-not-ready':'预算暂未就绪','ready-local':'可执行本地检查','local-maintenance':'本地检查','not-ready':'尚未就绪',ready:'已就绪',partial:'部分覆盖',indexing:'正在建立索引',loading:'正在加载',degraded:'词法降级',unavailable:'暂不可用'})[value]||value||'');}
  function dreamPresentation(value={},t=value=>value) {
    const last=value.last||value,job=value.job||last.job||{},budget=value.budget||last.budget||job.budget||{},observation=value.observation||last.observation||job.observation;
    const state=value.state||job.status||last.state||'not-ready',mode=value.settings?.mode||value.mode||job.mode||'automatic';
    const reason=value.reason||value.missing?.[0]||last.reason;
    const reasons={'estimated-budget':'预算按估算值控制，可能超出目标。','quota-unverified':'额度观测暂不可用，稍后核对后继续。','quota-exhausted':'当前额度不足，任务已暂停。','estimated-budget-exhausted':'估算预算不足，本次不再发起请求。','automatic-threshold':'等待满足自动做梦条件。','foreground-priority':'优先处理当前聊天，做梦稍后继续。','no-work':'没有需要整理的已保存资料。','no-committed-maintenance-task':'没有需要整理的已保存资料。','manual-only':'当前仅由你主动启动做梦。','existing-task':'继续查看当前任务，不会重复启动。','source-changed':'来源或记忆已更新，旧候选不再采用。','saved-state-or-source-changed':'来源或记忆已更新，旧候选不再采用。','baseline-changed':'记忆已更新，旧候选不再采用。','quota-hard-bound-unverified':'额度观测暂不可用，仍可执行本地检查。'};
    let detail=reason?(reasons[reason]||(/^[a-zA-Z0-9_-]+$/.test(reason)?'需要核对后再继续。':reason)):'';
    if(state==='unknown')detail='上次做梦请求状态待核对；核对不会重新发送。';
    const metrics=[],points=number=>Number.isFinite(number)?`${Number(number.toFixed(2))} ${t('个百分点')}`:t('尚未知晓');
    const target=budget.targetPoints??job.limit??(mode==='automatic'?5:15);
    metrics.push([t('本任务估算目标'),points(target)]);
    if(Number.isFinite(budget.estimatedPoints??job.estimatedPoints))metrics.push([t('预计消耗'),points(budget.estimatedPoints??job.estimatedPoints)]);
    if(Number.isFinite(budget.reservedPoints??job.reservedPoints))metrics.push([t('已累计估算'),points(budget.reservedPoints??job.reservedPoints)]);
    if(observation)metrics.push([t('同窗总变化'),points(observation.sameWindowChange)]);
    const candidates=(value.candidates||last.candidates||[]).map(item=>{
      const persistent=!!item.jobId||!!job.id,adoption=item.adoption||{},candidateState=adoption.state||item.status,partial=candidateState==='partial',adopted=item.adopted===true||candidateState==='adopted',discarded=['discarded','invalidated','expired'].includes(candidateState);
      const label=partial?'部分采用，其余已失效':adopted?'已采用':discarded?'已失效':persistent&&['candidate','pending'].includes(candidateState)?'等待下次换聊核验':'仅检查结果，尚未形成修订';
      const sources=[...new Set([...(Array.isArray(item.sources)?item.sources:[]).map(source=>typeof source==='string'?source:source?.ref),item.ref].filter(source=>typeof source==='string'))];
      const text=[item.content,item.summary,item.text].find(text=>typeof text==='string')||t('候选整理');
      const scope=item.scope||{},scopeText=Array.isArray(scope.modules)?scope.modules.map(module=>t(({persona:'人设',userView:'对我的看法',facts:'事实与约定'})[module]||'记忆')).join('、'):'';
      const applied=Array.isArray(adoption.applied)?adoption.applied.length:adoption.applied,invalidated=Array.isArray(adoption.invalidated)?adoption.invalidated.length:null;
      const details=[scopeText&&`${t('整理范围')}：${scopeText}`,Number.isSafeInteger(scope.checkpoints)&&`${t('已归档对话来源')}：${scope.checkpoints}`,Number.isSafeInteger(applied)&&`${t('已采用条目')}：${applied}`,Number.isSafeInteger(invalidated)&&invalidated>0&&`${t('失效条目')}：${invalidated}`].filter(Boolean);
      return {text,label:t(label),details,sources,...(sources[0]?{reference:sources[0]}:{})};
    });
    const checkRecord=value.checks||last.checks||last.result,checks=checkRecord?.result||checkRecord,checkLines=[];
    for(const [key,label]of [['duplicates','重复条目'],['invalidReferences','需要核对的来源'],['expired','已到期条目']])if(Array.isArray(checks?.[key]))checkLines.push(`${t(label)}：${checks[key].length}`);
    if(checkLines.length)checkLines.push(t('本地检查结果不会直接修改正式记忆。'));
    if(checkRecord?.target==='index'&&checks?.status)checkLines.push(`${t('索引检查')}：${statusText(checks.status,t)}`);
    const automatic=value.automaticWaiting;
    const automaticText=mode==='automatic'?(automatic?`${t('自动做梦')}：${statusText(automatic.state,t)}${automatic.reason?` · ${t(reasons[automatic.reason]||'等待满足自动做梦条件。')}`:''}`:t('自动模式需新增8次换聊、间隔7天且空闲30分钟；没有维护需要时不会运行。')):'';
    let estimateNote=budget.method==='uncalibrated-small-task-allowance'?t('尚无可比样本，当前采用启动估计。'):budget.method==='shared-window-high-water-plus-margin'?t('参考同条件下的共享额度变化估算，仍存在误差。'):'';
    if(Number.isSafeInteger(budget.sampleCount))estimateNote+=`${estimateNote?' ':''}${t('可比样本')}：${budget.sampleCount}`;
    if(budget.calibration?.attribution==='shared')estimateNote+=`${estimateNote?' ':''}${t('样本来自共享额度观测，无法精确归因本次任务。')}`;
    const catalog=value.catalog||last.catalog,coverage=[];
    if(catalog&&Number.isSafeInteger(catalog.scanned))coverage.push(`${t('已检查保存资料')}：${catalog.scanned}${Number.isSafeInteger(catalog.total)?` / ${catalog.total}`:''}`);
    if(catalog)coverage.push(t(catalog.scanComplete?'本次扫描范围已完成':'仍有资料待检查，当前结果仅覆盖已检查范围。'));
    const benefit=value.benefit||last.benefit||job.benefit,benefits=[];
    if(benefit&&['synthetic','observed'].includes(benefit.sample)){benefits.push(t(benefit.sample==='synthetic'?'以下为合成样本结果':'以下为本地已观测结果'));
      for(const[key,label]of [['modelCalls','已发起模型请求'],['candidates','形成候选任务'],['adopted','已采用任务'],['noChange','无需修改任务'],['unknown','状态待核对任务']])if(Number.isSafeInteger(benefit[key]))benefits.push(`${t(label)}：${benefit[key]}`);
      if(Number.isFinite(benefit.adoptionRate)&&benefit.adoptionRate>=0&&benefit.adoptionRate<=1)benefits.push(`${t('候选采用比例')}：${Number((benefit.adoptionRate*100).toFixed(1))}%`);
      if(Number.isSafeInteger(benefit.beforeDuplicateItems)&&Number.isSafeInteger(benefit.afterDuplicateItems))benefits.push(`${t('重复条目')}：${benefit.beforeDuplicateItems} → ${benefit.afterDuplicateItems}`);
      if(Number.isSafeInteger(benefit.linkedScopes))benefits.push(`${t('关联范围')}：${benefit.linkedScopes}`);
      if(Number.isSafeInteger(benefit.adoptedChanges))benefits.push(`${t('已采用修订')}：${benefit.adoptedChanges}`);
      if(Number.isSafeInteger(benefit.invalidatedChanges)&&benefit.invalidatedChanges>0)benefits.push(`${t('未采用修订')}：${benefit.invalidatedChanges}`);
      benefits.push(t('采用数量仅记录整理结果，不代表回答质量必然改善。'));}
    return {state,status:statusText(state,t),detail:t(detail),metrics,candidates,checks:checkLines,automatic:automaticText,estimateNote,coverage,benefits,
      observation:observation?t('同窗变化可能包含其他活动和观测误差，不能视为本任务的精确消耗。'):'',
      running:['running','pending','cancelling'].includes(state),unknown:state==='unknown'};
  }
  function searchPresentation(search,t=value=>value) {
    const current=typeof search==='object'&&search?search:{lexical:search==='ready'?'ready':'unavailable',semantic:'unavailable',index:search==='ready'?'ready':'partial'};
    const semantic=current.semantic==='ready'&&(current.vectorCoverage==='partial'||current.pendingVectors>0)?'partial':current.semantic==='unavailable'?'degraded':current.semantic||'degraded';
    return [
      [t('词法检索'),statusText(current.lexical||'unavailable',t)],
      [t('语义检索'),statusText(semantic,t)],
      [t('索引覆盖'),statusText(current.index||'partial',t)]
    ];
  }
  function renderMessages(container, messages, t = value => value, {onReference,followEnd=false} = {}) {
    const document = container.ownerDocument;
    const follow=followEnd&&container.scrollHeight-container.scrollTop-container.clientHeight<24;
    const fragment = document.createDocumentFragment();
    for (const message of messages || []) {
      if (!['user', 'assistant'].includes(message.role)) continue;
      const row = document.createElement('article'); row.className = `chat-message chat-${message.role}`;
      const label = document.createElement('small'); label.textContent = t(message.role === 'user' ? '你' : '桌宠');
      row.append(label);
      const parts=Array.isArray(message.content)?message.content:[{text:message.text||''}];
      for(const part of parts){
        if(typeof part.text==='string'){const body=document.createElement('p');body.textContent=part.text;row.append(body);}
        const picture=part.image||part,src=imageData(picture.dataUrl);
        if(src){const img=document.createElement('img');img.className='chat-image';img.src=src;img.alt=picture.name||t('图片');img.loading='lazy';img.addEventListener('click',()=>img.classList.toggle('expanded'));row.append(img);}
      }
      const references=new Set([...(message.references||message.refs||(message.reference?[message.reference]:[])),...String(message.text||parts.filter(part=>typeof part.text==='string').map(part=>part.text).join('')).matchAll(/C-[A-Za-z0-9_-]+\/M\d+(?:\/P\d+)?|L\d+-[A-Za-z0-9_-]+@v\d+(?:#I\d+)?|[PVF]-[A-Za-z0-9_-]+@\d+/g)].map(value=>typeof value==='string'?value:value[0]));
      if(onReference)for(const reference of [...references].slice(0,32)){if(typeof reference!=='string')continue;const button=document.createElement('button');button.type='button';button.textContent=reference;button.className='source-link';button.addEventListener('click',()=>onReference(reference));row.append(button);}
      fragment.append(row);
    }
    container.replaceChildren(fragment);
    if(follow)container.scrollTop=container.scrollHeight;
  }
  function mountModels({document,maid,t=value=>value,prefix='chat-config',onSaved=()=>{}}){
    const model=document.getElementById(`${prefix}-model`),effort=document.getElementById(`${prefix}-effort`),save=document.getElementById(`${prefix}-save`),refresh=document.getElementById(`${prefix}-refresh`),status=document.getElementById(`${prefix}-status`);
    if(!model||!effort||!save||!refresh)return null;
    let models=[],settings={chatModel:'gpt-6.1-sol',chatReasoningEffort:'medium'},dirty=false,busy=false,revision=0;
    const draft=()=>{void maid.setChatDraft?.({scope:'model',text:JSON.stringify({model:model.value,reasoningEffort:effort.value})}).catch(()=>{});};
    function draw(){
      const selected=dirty?model.value:settings.chatModel,selectedEffort=dirty?effort.value:settings.chatReasoningEffort;
      const choices=models.map(item=>({id:item.id||item.model,label:item.displayName||item.id||item.model}));
      if(!choices.some(item=>item.id===selected))choices.unshift({id:selected,label:`${selected} · ${t('尚未核验可用性')}`});
      model.replaceChildren(...choices.map(item=>{const option=document.createElement('option');option.value=item.id;option.textContent=item.label;return option;}));model.value=selected;
      const actual=models.find(item=>(item.id||item.model)===selected),levels=(actual?.reasoningEfforts||actual?.supportedReasoningEfforts||[]).map(item=>typeof item==='string'?item:item.reasoningEffort);
      const allowed=[...new Set([selectedEffort,...levels].filter(Boolean))];
      effort.replaceChildren(...allowed.map(value=>{const option=document.createElement('option');option.value=value;option.textContent=value;option.disabled=levels.length>0&&!levels.includes(value);return option;}));effort.value=selectedEffort;
      model.disabled=busy;effort.disabled=busy;refresh.disabled=busy;save.disabled=busy||!actual||!levels.includes(selectedEffort);
    }
    model.addEventListener('change',()=>{dirty=true;revision++;const previous=effort.value;draw();const actual=models.find(item=>(item.id||item.model)===model.value),levels=(actual?.reasoningEfforts||actual?.supportedReasoningEfforts||[]).map(item=>typeof item==='string'?item:item.reasoningEffort);if(!levels.includes(previous)){effort.value=levels.includes('medium')?'medium':levels[0]||previous;}draw();draft();});
    effort.addEventListener('change',()=>{dirty=true;revision++;draw();draft();});
    async function load(){busy=true;draw();status.textContent=t('正在读取可用模型…');try{const value=await maid.listChatModels();models=value.models||[];status.textContent=t('模型列表已更新；不会自动替换你的选择。');}catch(error){status.textContent=error.message||t('模型列表暂不可用，请重试。');}finally{busy=false;draw();}}
    refresh.addEventListener('click',()=>void load());
    save.addEventListener('click',async()=>{if(save.disabled)return;const at=revision,selection={model:model.value,reasoningEffort:effort.value};busy=true;draw();try{const value=await maid.configureChat(selection);settings={chatModel:selection.model,chatReasoningEffort:selection.reasoningEffort};if(at===revision){dirty=false;void maid.setChatDraft?.({scope:'model',text:''}).catch(()=>{});}status.textContent=t('已保存，从下一次请求生效。');onSaved(value);}catch(error){status.textContent=error.message||t('保存失败，草稿和旧版本已保留。');}finally{busy=false;draw();}});
    return{render(value){settings={...settings,...value};draw();},load};
  }
  function mountMini({ document, maid, t = value => value, onFocus = () => {}, onBlur = () => {} }) {
    const view = document.getElementById('chat-view');
    if (!view || typeof maid?.getChatState !== 'function') return null;
    const status = document.getElementById('chat-mini-status'), messages = document.getElementById('chat-mini-messages');
    const input = document.getElementById('chat-mini-input'), form = document.getElementById('chat-mini-form');
    const send = document.getElementById('chat-mini-send'), manage = document.getElementById('chat-mini-manage');
    const panel=document.getElementById('chat-compose-panel'),slot=document.getElementById('chat-compose-slot'),body=document.getElementById('chat-compose-body');
    const expand=document.getElementById('chat-mini-expand'),close=document.getElementById('chat-compose-close'),hint=document.getElementById('chat-compose-hint');
    let state = null, pending = false, inputDirty = false,expanded=false,composing=false,pendingExpansion=null,failure='';
    const updateSend=()=>{send.disabled=!state?.ready||pending||state.generating||state.unknownExecution||state.reconciling||!input.value.trim();};
    const setExpanded=(value,focus=true)=>{
      if(!panel||!slot||!body)return;
      if(composing){pendingExpansion={value,focus};return;}
      expanded=value===true;const start=input.selectionStart,end=input.selectionEnd,direction=input.selectionDirection;
      (expanded?body:slot).append(form);panel.hidden=!expanded;view.classList.toggle('composer-expanded',expanded);
      expand?.setAttribute('aria-expanded',String(expanded));input.rows=expanded?4:1;
      if(focus){input.focus({preventScroll:true});input.setSelectionRange(start,end,direction);onFocus();}
    };
    const render = value => {
      state = value; status.textContent = failure?t(failure):readinessText(value, t);status.title=status.textContent;
      view.classList.toggle('is-ready',value.ready===true);view.classList.toggle('is-busy',pending||value.generating===true||value.reconciling===true);
      renderMessages(messages, value.messages?.slice(-2), t,{followEnd:true});
      if (!inputDirty && input.value !== value.draft) input.value = value.draft || '';
      updateSend();
      manage.title = t(value.initialized ? '记忆与维护健康' : '建立聊天项目');manage.setAttribute('aria-label',manage.title);
      if(hint)hint.textContent=t('Enter 换行 · Ctrl+Enter 发送');
    };
    input.addEventListener('input', () => { inputDirty=true;failure='';updateSend();onFocus(); void Promise.resolve(maid.setChatDraft({ scope: 'chat', text: input.value })).catch(()=>{failure='草稿暂未同步，请保留当前输入';if(state)render(state);}); });
    input.addEventListener('compositionstart',()=>{composing=true;});input.addEventListener('compositionend',()=>{composing=false;if(pendingExpansion){const next=pendingExpansion;pendingExpansion=null;setExpanded(next.value,next.focus);}});
    input.addEventListener('keydown',event=>{
      if(event.isComposing||composing)return;
      if(event.key==='Enter'&&(event.ctrlKey||event.metaKey)){event.preventDefault();form.requestSubmit();}
      else if(event.key==='Escape'&&expanded){event.preventDefault();setExpanded(false);}
    });
    expand?.addEventListener('click',event=>{event.stopPropagation();setExpanded(!expanded);});
    close?.addEventListener('click',()=>setExpanded(false));
    view.addEventListener('focusin', onFocus); view.addEventListener('focusout', onBlur);
    form.addEventListener('submit', async event => {
      event.preventDefault(); if (!state?.ready || pending ||state.reconciling||state.generating||state.unknownExecution||!input.value.trim()) return;
      failure='';pending = true; send.disabled = true;view.classList.add('is-busy');
      try { const text=input.value,value=await maid.sendChat({text});if(input.value===text)inputDirty=false;render(value); }
      catch (error) { failure=error?.message || '消息仍保留，请在健康面板查看未就绪原因';status.textContent=t(failure); }
      finally { pending = false; if (state) render(state); }
    });
    manage.addEventListener('click', event => { event.stopPropagation(); void maid.openChatManager(); });
    const unsubscribe = maid.onChatState?.(render);
    return { refresh: () => maid.getChatState().then(render).catch(() => { status.textContent = t('聊天资料暂不可用，原文件已保留'); }), render,
      retranslate: () => { if (state) render(state); },setExpanded,setVisible:value=>{if(!value)setExpanded(false,false);},get isExpanded(){return expanded;},
      dispose: () => unsubscribe?.() };
  }
  return { readinessText, renderMessages, mountMini, mountModels, imageData, statusText, dreamPresentation, searchPresentation, memorySyncPresentation };
});
