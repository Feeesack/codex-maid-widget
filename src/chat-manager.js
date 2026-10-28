(function(root,factory){
  'use strict';
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  else {root.MaidChatManagement=api;if(root.document&&root.maid)root.MaidChatManager=api.mount(root.document,root.maid,root);}
})(typeof globalThis==='object'?globalThis:this,function(){
  'use strict';
  const categories=['chat','usage','history','memory','maintenance','dream','project'];
  const stages=['archive','memory','tree','handoff','validate','load','switch'];
  const stageNames={archive:'保存原始聊天',memory:'整理记忆档案',tree:'更新归档摘要',handoff:'准备近期交接',validate:'校验整理结果',load:'加载新聊上下文',switch:'切换到新对话'};
  const stageDetails={archive:'保存原文与原图，保留稳定来源编号。',memory:'整理人设、对你的看法与事实约定。',tree:'更新分级摘要，保留既有封存记录。',handoff:'带上必要的近期内容和未完成事项。',validate:'检查来源、版本与容量边界。',load:'向新对话提供有效记忆与交接内容。',switch:'核对新对话后完成切换。'};
  const known=value=>Number.isFinite(value)&&value>=0;
  const number=value=>known(value)?Math.round(value).toLocaleString():'—';
  const compact=value=>known(value)?value>=1000000?(value/1000000).toFixed(2)+'M':value>=1000?(value/1000).toFixed(1)+'K':String(Math.round(value)):'—';
  const percentage=(value,max)=>known(value)&&known(max)&&max>0?Math.min(100,Math.max(0,value/max*100)):null;
  function sessionProgress(state={}){
    const budget=state.budget||{},limits=budget.limits||{},isBytes=budget.bodyMeasurement==='bytes-fallback';
    const body=isBytes?budget.byteCount:budget.bodyUpperBound,bodyLimit=isBytes?limits.bytes??1048576:limits.body??400000;
    return {context:known(budget.used)?budget.used:null,window:known(budget.window)&&budget.window>0?budget.window:null,
      contextPercent:percentage(budget.used,budget.window),body:known(body)?body:null,bodyLimit,bodyPercent:percentage(body,bodyLimit),isBytes,
      turns:known(budget.successfulTurns)?budget.successfulTurns:0,soft:limits.soft??.9,hard:limits.hard??.95,
      phase:state.unknownExecution?'请求状态待核对':state.generating?'正在回答':state.maintenance&&['running','inflight'].includes(state.maintenance.state)?'正在整理换聊':state.ready?'等待下一次交流':!state.initialized?'尚未建立聊天项目':'等待连接恢复',
      reasons:Array.isArray(budget.reasons)?budget.reasons:[],pending:budget.pending===true};
  }
  function maintenanceProgress(value={}){
    const plan=Array.isArray(value.plan)&&value.plan.length?value.plan:stages.map(stage=>({stage,state:value.completed?.[stage]?'completed':stage===value.stage?value.state:'pending'}));
    const completed=stages.filter(stage=>plan.some(item=>item.stage===stage&&item.state==='completed')).length;
    return {completed,total:stages.length,stage:value.stage||null,state:value.state||'idle',plan:stages.map(stage=>({stage,state:plan.find(item=>item.stage===stage)?.state||'pending'}))};
  }
  function localDay(date){const d=date instanceof Date?date:new Date(date);return [d.getFullYear(),String(d.getMonth()+1).padStart(2,'0'),String(d.getDate()).padStart(2,'0')].join('-');}
  function rangeFilter(range,from,to,now=new Date()){
    if(range==='all')return {};
    let first=from,last=to;
    if(range!=='custom'){const end=new Date(now),start=new Date(now);start.setDate(start.getDate()-(range==='today'?0:Number(range)-1));first=localDay(start);last=localDay(end);}
    const start=first?new Date(first+'T00:00:00'):null,end=last?new Date(last+'T00:00:00'):null;
    if(end){end.setDate(end.getDate()+1);end.setMilliseconds(-1);}
    return {...(start?{from:start.toISOString()}:{}),...(end?{to:end.toISOString()}: {})};
  }
  function mount(document,maid,window){
    if(!document.getElementById('manager-panel-chat'))return null;
    const $=id=>document.getElementById(id),t=value=>window.MaidI18n?.t(value)||value;
    const element=(tag,content,className)=>{const node=document.createElement(tag);if(content!==undefined)node.textContent=content;if(className)node.className=className;return node;};
    const set=(id,value)=>{$(id).textContent=value;};
    const kinds={chat:'日常聊天',maintenance:'换聊整理',dream:'做梦维护'};
    let active='chat',state=null,initializedBefore=null,usagePage=1,usageResult=null,usageRequest=0,usageLoaded=false;
    let archiveCursor=null,archiveRows=[],archiveResult=null,archiveRequest=0,selectedArchive=null,archiveOffset=0,archivePages=[],archiveNext=null,readRequest=0,metadataSaving=false;const archiveDrafts=new Map();
    const availableModels=new Set();
    const stamp=value=>{if(!value)return t('尚未知晓');const date=new Date(value);return Number.isFinite(date.getTime())?date.toLocaleString(window.MaidI18n?.getLocale?.()||'zh-CN',{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}):String(value);};
    const duration=value=>!known(value)?'—':value<1000?`${Math.round(value)} ms`:value<60000?`${(value/1000).toFixed(1)} s`:`${Math.floor(value/60000)} m ${Math.round(value%60000/1000)} s`;
    function select(category,focus=false){
      if(!categories.includes(category))category='chat';active=category;
      for(const id of categories){const selected=id===category;const tab=$('manager-tab-'+id);tab.setAttribute('aria-selected',String(selected));tab.tabIndex=selected?0:-1;$('manager-panel-'+id).hidden=!selected;}
      window.scrollTo?.(0,0);if(focus)$('manager-tab-'+category).focus();
      if(category==='usage'&&!usageLoaded)void loadUsage();
      if(category==='history'&&!archiveResult)void loadArchives(true);
    }
    for(const [index,id] of categories.entries()){
      const tab=$('manager-tab-'+id);
      tab.addEventListener('click',event=>{event.preventDefault();select(id);});
      tab.addEventListener('keydown',event=>{const step=['ArrowRight','ArrowDown'].includes(event.key)?1:['ArrowLeft','ArrowUp'].includes(event.key)?-1:0;const next=event.key==='Home'?0:event.key==='End'?categories.length-1:step?(index+step+categories.length)%categories.length:-1;if(next>=0){event.preventDefault();select(categories[next],true);}});
    }
    function drawSession(prefix,value){
      const progress=sessionProgress(value),context=progress.contextPercent;
      set(prefix+'-context-value',context===null?'—':`${Math.round(context)}%`);
      const meter=$(prefix+'-context-meter');meter.value=context??0;meter.classList.toggle('is-warning',context>=progress.soft*100&&context<progress.hard*100);meter.classList.toggle('is-danger',context>=progress.hard*100);
      set(prefix+'-context-note',context===null?t('待取得可信上下文观测'):`${compact(progress.context)} / ${compact(progress.window)} · ${t('保守容量计量')}`);
      set(prefix+'-body-value',progress.body===null?'—':`${compact(progress.body)} / ${compact(progress.bodyLimit)}`);$(prefix+'-body-meter').value=progress.bodyPercent??0;
      set(prefix+'-body-note',t(progress.isBytes?'UTF-8 字节备用进度，非 token 消耗':'新增正文保守计量，非累计消耗'));
      set(prefix+'-turns',number(progress.turns));set(prefix+'-phase',t(progress.phase));
    }
    function renderMaintenance(value={}){
      const view=maintenanceProgress(value),status=window.MaidChatView.statusText(view.state,t);
      set('maintenance-badge',status);$('maintenance-badge').classList.toggle('is-warning',['paused','failed','unknown','repair-required'].includes(view.state));
      set('maintenance-stage-label',view.stage?t(stageNames[view.stage]||view.stage):t('尚无进行中的整理任务'));
      set('maintenance-progress-label',`${view.completed} / ${view.total} · ${t('阶段已完成')}`);$('maintenance-progress').value=view.completed;
      const reasonLabels={'quota-exhausted':'额度不足，等待恢复后继续。','estimated-budget-exhausted':'估算预算已用完，任务已暂停。','foreground-priority':'先处理当前聊天，稍后继续维护。'};
      set('maintenance-status',[status,value.reason?t(reasonLabels[value.reason]||'需要核对维护状态后再继续。'):''].filter(Boolean).join(' · '));
      $('maintenance-stages').replaceChildren(...view.plan.map((item,index)=>{const li=element('li',undefined,item.state==='completed'?'is-completed':item.stage===view.stage?'is-current':'');li.append(element('span',item.state==='completed'?'✓':String(index+1),'stage-number'));const detail=element('div');detail.append(element('strong',t(stageNames[item.stage])),element('small',`${window.MaidChatView.statusText(item.state,t)} · ${t(stageDetails[item.stage])}`));li.append(detail);return li;}));
      const used=value.used||{},limits=value.limits||{},metrics=[['已预留调用',number(used.calls),number(limits.calls)],['已预留输入',compact(used.input),compact(limits.input)],['已预留输出',compact(used.output),compact(limits.output)],['活动时间',duration(used.activeMs),duration(limits.activeMs)]];
      $('maintenance-budget').replaceChildren(...metrics.map(([label,actual,limit])=>{const box=element('article',undefined,'budget-card');box.append(element('span',t(label)),element('strong',`${actual} / ${limit}`));return box;}));
      $('maintenance-stop').disabled=!['running','inflight'].includes(view.state);$('maintenance-resume').disabled=!['paused','failed'].includes(view.state);
      $('maintenance-checkpoint').disabled=!state?.initialized||!!state?.generating||!!state?.unknownExecution||['running','inflight','unknown'].includes(view.state);
    }
    function render(value){
      state=value;if(!value)return;
      if(initializedBefore===null&&!value.initialized)select('project');
      if(initializedBefore===false&&value.initialized)select('chat');
      initializedBefore=!!value.initialized;
      set('manager-project-label',value.project?.petName?`${value.project.petName}\n${value.project.folder||''}`:t('先建立桌宠聊天项目'));
      for(const prefix of ['current-session','maintenance-session'])drawSession(prefix,value);
      const progress=sessionProgress(value),reasons={body:'正文已达到本轮整理阈值',turns:'本轮聊天轮数已达到备用阈值',context:'上下文达到90%换聊阈值',protection:'上下文达到95%发送保护线',capacity:'需要为回答与整理预留空间'};
      set('maintenance-trigger',value.contextRecoveryRequired?t('上下文观测需要恢复；原对话和输入仍然保留。'):progress.reasons.length?progress.reasons.map(reason=>t(reasons[reason]||'需要整理后继续')).join(' · '):t('上下文达到90%或正文达到阈值时触发换聊；95%启用发送保护。'));
      renderMaintenance(value.maintenance||{});
    }
    function drawUsage(result){
      const summary=result.summary||{},tokens=summary.tokens||{};
      for(const [id,value]of [['requests',summary.requests],['input',tokens.inputTokens],['output',tokens.outputTokens],['total',tokens.totalTokens]])set('usage-'+id,number(value));
      set('usage-cache',number(tokens.cachedInputTokens));set('usage-reasoning',number(tokens.reasoningOutputTokens));
      set('usage-complete',`${number(summary.measuredRequests)} / ${number(summary.requests)}`);
      const coverage=result.coverage||{},start=coverage.startedAt||summary.coverageStartedAt;
      set('usage-coverage',[`${t('记录起点')}：${stamp(start)}`,t('旧聊天中未记录的前台用量无法追溯，不补写为零。'),coverage.importedRecords?`${t('已回填辅助任务')}：${number(coverage.importedRecords)}`:'',summary.partialRequests||summary.missingRequests?`${t('缺失或部分计量')}：${number((summary.partialRequests||0)+(summary.missingRequests||0))}`:'',coverage.truncated?t('历史回填尚未完整，当前统计仅覆盖已记录范围。'):''].filter(Boolean).join(' '));
      for(const item of result.byModel||[])if(item.model)availableModels.add(item.model);
      const chosen=$('usage-model').value;const automatic=element('option',t('全部模型'));automatic.value='all';$('usage-model').replaceChildren(automatic,...[...availableModels].sort().map(model=>{const option=element('option',model);option.value=model;return option;}));$('usage-model').value=chosen||'all';
      const days=result.byDay||[],maximum=Math.max(1,...days.map(item=>item.tokens?.totalTokens||0));
      $('usage-daily').replaceChildren(...(days.length?days.map(item=>{const row=element('div',undefined,'day-row');const bar=element('progress');bar.max=maximum;bar.value=item.tokens?.totalTokens||0;bar.setAttribute('aria-label',`${item.day} ${number(item.tokens?.totalTokens)}`);row.append(element('span',item.day?.slice(5)||'—'),bar,element('strong',compact(item.tokens?.totalTokens)));return row;}):[element('p',t('所选范围内尚无用量记录。'),'muted')]));
      const sum=(result.byKind||[]).reduce((total,item)=>total+(item.tokens?.totalTokens||0),0);
      $('usage-kinds').replaceChildren(...(result.byKind||[]).map(item=>{const row=element('div',undefined,'kind-row'),line=element('div'),bar=element('progress');line.append(element('span',t(kinds[item.kind]||item.kind)),element('strong',compact(item.tokens?.totalTokens)));bar.max=Math.max(1,sum);bar.value=item.tokens?.totalTokens||0;row.append(line,bar);return row;}));
      $('usage-models').replaceChildren(...(result.byModel||[]).map(item=>{const row=element('div',undefined,'model-row');row.append(element('span',item.model||t('尚未知晓')),element('strong',`${number(item.requests)} ${t('次请求')} · ${compact(item.tokens?.totalTokens)}`));return row;}));
      const statusNames={running:'运行中',completed:'已完成',failed:'失败',cancelled:'已取消',interrupted:'已停止',unknown:'待核对','not-executed':'未执行'};
      $('usage-records').replaceChildren(...(result.records||[]).map(item=>{const row=element('tr'),token=item.tokens||{};
        const fields=[[stamp(item.startedAt),t(kinds[item.kind]||item.kind)],[item.model||t('尚未知晓'),item.effort||'—'],[number(token.inputTokens),`${t('缓存')} ${number(token.cachedInputTokens)}`],[number(token.outputTokens),`${t('推理')} ${number(token.reasoningOutputTokens)}`],[number(token.totalTokens),duration(item.durationMs)],[t(statusNames[item.status]||'待核对'),t(item.completeness==='complete'?'计量完整':item.completeness==='partial'?'部分计量':'尚无计量')]];
        for(const [main,detail]of fields){const cell=element('td',main);cell.append(element('small',detail));row.append(cell);}return row;}));
      const pages=result.pagination||{};set('usage-page-label',`${pages.page||1} / ${Math.max(1,pages.pages||1)} · ${number(pages.total??summary.requests)} ${t('条记录')}`);
      $('usage-previous').disabled=(pages.page||1)<=1;$('usage-next').disabled=(pages.page||1)>=(pages.pages||1);
      set('usage-status',(result.records||[]).length?'':t('所选范围内尚无用量记录。'));
    }
    async function loadUsage(){
      const generation=++usageRequest;
      if(!state?.initialized){set('usage-status',t('先建立桌宠聊天项目'));return;}
      const range=rangeFilter($('usage-range').value,$('usage-from').value,$('usage-to').value);
      if(range.from&&range.to&&range.from>range.to){set('usage-status',t('开始日期不能晚于结束日期。'));return;}
      set('usage-status',t('正在读取记录…'));$('usage-refresh').disabled=true;
      try {const result=await maid.listChatUsage({...range,kind:$('usage-kind').value,model:$('usage-model').value,page:usagePage,pageSize:20});if(generation!==usageRequest)return;usageResult=result;usageLoaded=true;drawUsage(result);}
      catch(error){if(generation===usageRequest)set('usage-status',t('读取失败，请重试；已有记录仍保留。'));}
      finally{if(generation===usageRequest)$('usage-refresh').disabled=false;}
    }
    $('usage-range').addEventListener('change',()=>{$('usage-custom-dates').hidden=$('usage-range').value!=='custom';});
    $('usage-filters').addEventListener('submit',event=>{event.preventDefault();usagePage=1;void loadUsage();});$('usage-refresh').addEventListener('click',()=>void loadUsage());
    $('usage-previous').addEventListener('click',()=>{if(usagePage>1){usagePage--;void loadUsage();}});$('usage-next').addEventListener('click',()=>{usagePage++;void loadUsage();});
    function archiveFilter(){const scope=$('history-scope').value;return {query:$('history-query').value.trim(),from:$('history-from').value,to:$('history-to').value,favorite:scope==='favorite',hidden:scope==='hidden'?'hidden':scope==='all'?'all':'visible'};}
    function archiveStats(value){const overview=value.overview||value;for(const [id,field]of [['total','total'],['favorite-count','favorites'],['hidden','hidden'],['matches','matching']]){const aliases={favorites:overview.favorite??overview.favoriteCount,hidden:overview.hiddenCount,total:overview.archived??overview.totalConversations,matching:value.total};set('archive-'+id,number(overview[field]??aliases[field]));}}
    function drawArchiveRows(){
      $('history-list').replaceChildren(...archiveRows.map(item=>{const button=element('button',undefined,'archive-card'+(selectedArchive?.conversationId===item.conversationId?' is-selected':''));button.type='button';button.append(element('strong',`${item.favorite?'★ ':''}${item.title||item.conversationId}`),element('small',stamp(item.startedAt)),element('small',`${known(item.messageCount)?number(item.messageCount)+' '+t('条消息'):t('消息数量待核对')}${known(item.attachmentCount)?' · '+number(item.attachmentCount)+' '+t('张附件'):''}`));if(item.tags?.length){const tags=element('span',undefined,'archive-tags');for(const tag of item.tags)tags.append(element('span',tag,'archive-tag'));button.append(tags);}button.addEventListener('click',()=>void openArchive(item));return button;}));
      if(!archiveRows.length)$('history-list').append(element('div',t('没有符合条件的归档。'),'empty-state'));
      $('history-more').disabled=archiveCursor===null;
    }
    async function loadArchives(reset=false){
      const generation=++archiveRequest;
      if(!state?.initialized){set('history-list-status',t('先建立桌宠聊天项目'));return;}
      const filters=archiveFilter();if(filters.from&&filters.to&&filters.from>filters.to){set('history-list-status',t('开始日期不能晚于结束日期。'));return;}
      set('history-list-status',t('正在读取记录…'));$('history-refresh').disabled=true;$('history-more').disabled=true;
      try{const result=await maid.listChatHistory({...filters,cursor:reset?null:archiveCursor,limit:20});if(generation!==archiveRequest)return;archiveResult=result;archiveCursor=result.nextCursor??null;archiveRows=reset?result.conversations||[]:[...archiveRows,...result.conversations||[]];archiveStats(result);drawArchiveRows();set('history-list-status',`${t('已显示')} ${archiveRows.length} / ${number(result.total??archiveRows.length)}`);}
      catch(error){if(generation===archiveRequest)set('history-list-status',t('读取失败，请重试；已有记录仍保留。'));}
      finally{if(generation===archiveRequest){$('history-refresh').disabled=false;$('history-more').disabled=archiveCursor===null;}}
    }
    function captureArchiveDraft(){if(!selectedArchive||$('archive-detail').hidden)return;archiveDrafts.set(selectedArchive.conversationId,{title:$('archive-name').value,tags:$('archive-tags').value});}
    function clearArchiveReader(){ $('history-messages').replaceChildren();set('history-status','');$('history-messages-previous').disabled=true;$('history-messages-more').disabled=true; }
    function fillArchive(item){
      selectedArchive=item;$('archive-empty').hidden=true;$('archive-detail').hidden=false;$('archive-edit').hidden=false;set('archive-title',item.title||item.conversationId);
      set('archive-meta',`${stamp(item.startedAt)} · ${item.conversationId}${item.summaryStatus?' · '+t(item.summaryStatus==='available'?'已有归档摘要':'摘要状态待核对'):''}`);
      const draft=archiveDrafts.get(item.conversationId);$('archive-name').value=draft?.title ?? (item.customTitle||item.title||'');$('archive-tags').value=draft?.tags ?? (item.tags||[]).join(', ');$('archive-favorite').setAttribute('aria-pressed',String(item.favorite===true));set('archive-favorite',t(item.favorite?'已收藏':'收藏'));set('archive-hide',t(item.hidden?'恢复到列表':'从列表隐藏'));set('archive-edit-status','');
      drawArchiveRows();
    }
    async function openArchive(item){captureArchiveDraft();clearArchiveReader();fillArchive(item);archiveOffset=0;archivePages=[];await readArchive();}
    async function readArchive(){
      if(!selectedArchive)return;const generation=++readRequest,id=selectedArchive.conversationId;set('history-status',t('正在读取记录…'));
      try{const result=await maid.readChatHistory({conversationId:id,offset:archiveOffset,limit:50});if(generation!==readRequest||id!==selectedArchive?.conversationId)return;const messages=result.messages||[];window.MaidChatView.renderMessages($('history-messages'),messages,t,{onReference:openReference});archiveOffset=result.offset||0;archiveNext=result.nextOffset??(known(result.total)&&archiveOffset+messages.length<result.total?archiveOffset+messages.length:null);$('history-messages-previous').disabled=archiveOffset===0;$('history-messages-more').disabled=archiveNext===null;set('history-status',`${messages.length?archiveOffset+1:0}–${archiveOffset+messages.length} / ${known(result.total)?number(result.total):'…'} · ${t('条消息')}`);}
      catch(error){if(generation===readRequest)set('history-status',t('读取失败，请重试；已有记录仍保留。'));}
    }
    async function saveArchive(patch){
      if(!selectedArchive||metadataSaving)return;metadataSaving=true;const id=selectedArchive.conversationId;set('archive-edit-status',t('正在保存…'));for(const name of ['archive-save','archive-favorite','archive-hide'])$(name).disabled=true;
      try{const result=await maid.updateChatHistoryMetadata({conversationId:id,baseRevision:selectedArchive.metadataRevision||0,...patch});if(id!==selectedArchive?.conversationId)return;const updated=result.conversation||result.item||result;selectedArchive={...selectedArchive,...updated,...patch,customTitle:patch.title!==undefined?patch.title:updated.customTitle??selectedArchive.customTitle,title:patch.title||updated.title||selectedArchive.title,metadataRevision:updated.metadataRevision??updated.revision??(selectedArchive.metadataRevision||0)+1};if(patch.title!==undefined||patch.tags!==undefined)archiveDrafts.delete(id);set('archive-title',selectedArchive.title||id);set('archive-meta',`${stamp(selectedArchive.startedAt)} · ${id}`);$('archive-favorite').setAttribute('aria-pressed',String(selectedArchive.favorite===true));set('archive-favorite',t(selectedArchive.favorite?'已收藏':'收藏'));set('archive-hide',t(selectedArchive.hidden?'恢复到列表':'从列表隐藏'));set('archive-edit-status',t('整理已保存，归档原文保持不变。'));await loadArchives(true);}
      catch(error){set('archive-edit-status',t(['CHAT_HISTORY_METADATA_CONFLICT','CHAT_HISTORY_METADATA_STALE'].includes(error?.code)?'归档整理已被更新，请刷新后再保存。':'保存失败，编辑内容仍保留。'));}
      finally{metadataSaving=false;for(const name of ['archive-save','archive-favorite','archive-hide'])$(name).disabled=false;}
    }
    async function openReference(reference){
      captureArchiveDraft();const generation=++readRequest;select('history');clearArchiveReader();$('archive-empty').hidden=true;$('archive-detail').hidden=false;selectedArchive=null;set('archive-title',t('来源查阅'));$('archive-edit').hidden=true;set('archive-meta',reference);
      try{const result=await maid.resolveChatReference({reference});if(generation!==readRequest)return;window.MaidChatView.renderMessages($('history-messages'),[{role:'assistant',text:result.text||result.record?.content?.map(part=>part.text||'').join('')||'',content:result.content||result.record?.content||(result.image?[{image:result.image}]:undefined)}],t);set('history-status',result.reference||reference);$('history-messages-previous').disabled=true;$('history-messages-more').disabled=true;}
      catch(error){if(generation===readRequest)set('history-status',t('来源暂不可读，请核对编号后重试。'));}
    }
    $('history-filters').addEventListener('submit',event=>{event.preventDefault();void loadArchives(true);});$('history-refresh').addEventListener('click',()=>void loadArchives(true));$('history-more').addEventListener('click',()=>void loadArchives());
    $('history-messages-previous').addEventListener('click',()=>{archiveOffset=archivePages.pop()??0;void readArchive();});$('history-messages-more').addEventListener('click',()=>{if(archiveNext===null)return;archivePages.push(archiveOffset);archiveOffset=archiveNext;void readArchive();});
    $('archive-name').addEventListener('input',captureArchiveDraft);$('archive-tags').addEventListener('input',captureArchiveDraft);$('archive-edit').addEventListener('submit',event=>{event.preventDefault();void saveArchive({title:$('archive-name').value.trim(),tags:$('archive-tags').value.split(/[,，]/).map(tag=>tag.trim()).filter(Boolean)});});$('archive-favorite').addEventListener('click',()=>void saveArchive({favorite:!selectedArchive?.favorite}));$('archive-hide').addEventListener('click',()=>void saveArchive({hidden:!selectedArchive?.hidden}));
    $('source-open').addEventListener('click',()=>void openReference($('source-reference').value.trim()));
    maid.onChatState(render);maid.onState(()=>{if(state)render(state);if(usageResult)drawUsage(usageResult);if(archiveResult)drawArchiveRows();});
    void maid.getChatState().then(render).catch(()=>{});select('chat');
    window.setInterval?.(()=>{if(active==='usage'&&!document.hidden&&state?.initialized)void loadUsage();},5000);
    return {select,render,renderMaintenance,openReference,loadUsage,loadArchives,get active(){return active;}};
  }
  return {mount,sessionProgress,maintenanceProgress,rangeFilter,number,compact};
});
