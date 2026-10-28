(function () {
'use strict';
const $ = id => document.getElementById(id), maid = window.maid, i18n = window.MaidI18n;
const t = value => i18n?.t(value) || value;
let state, selection, moduleName = 'persona', memory, selectedEntry = null, offset = 0, saving = false, edited = false, request = 0, pendingSave, selectedRevision, historyOffset=0, historyRequest=0;
const dirtyForms = new Set(), draftWrites = new Map();
function updateDraft(scope, text) { const pending=maid.setChatDraft({scope,text});draftWrites.set(scope,pending);return pending; }
const kinds = { persona: [['core','核心'],['growth','成长']], userView: [['overall','总体认知'],['impression','印象'],['preference','偏好'],['habit','习惯'],['boundary','相处边界']], facts: [['fact','事实'],['relationship','关系'],['plan','计划'],['agreement','约定']] };
function message(source) { $('manager-status').textContent = t(source); }
function render(value) {
  state = value; message(window.MaidChatView.readinessText(value, t));
  $('project-setup').hidden = value.initialized; $('project-summary').hidden = !value.initialized; $('memory-panel').hidden = !value.initialized;
  $('project-name').textContent = value.project ? `${value.project.petName} · ${value.project.userNickname} · ${value.project.folder}` : '';
  const verified=value.ready||value.connection?.state==='ready';
  const health = [['聊天发送',value.ready],['原生来源恢复',verified],['首次上下文窗口',verified],['套餐登录与计费',verified],['上下文计量',verified],['归档与维护',verified&&value.health?.maintenance!=='repair-required']];
  const rows=health.map(([label,ready])=>[t(label),t(ready?'已就绪':'尚未验证')]);
  const sync=window.MaidChatView.memorySyncPresentation(value,t);rows.push([t('请求记忆同步'),sync.label,'memory-sync-status']);
  rows.push(...window.MaidChatView.searchPresentation(value.health?.search,t));
  $('health-list').replaceChildren(...rows.map(([label,text,id])=>{const li=document.createElement('li'),name=document.createElement('span'),status=document.createElement('strong');name.textContent=label;status.textContent=text;if(id)status.id=id;li.append(name,status);return li;}));
  $('memory-sync-detail').textContent=sync.detail;
  if(memory&&!edited)$('memory-status').textContent=sync.label;
  $('context-measurement').textContent=value.budget?`${t('保守容量上界，不是精确token计数')} · ${value.budget.used??'—'} / ${value.budget.window??'—'}\n${value.budget.bodyMeasurement==='bytes-fallback'?`${t('正文UTF-8字节备用进度')} ${value.budget.byteCount??0} / 1048576`:`${t('新增正文tokens')} ${value.budget.bodyUpperBound??'—'} / 400000`}\n${t('普通回答预留生成空间；这不是服务端总生成硬限。')}`:'';
  if (value.initialized && (!memory || value.memory?.modules?.[moduleName]?.version&&value.memory.modules[moduleName].version!==memory.version)) void loadMemory();
}
async function choose(mode) {
  try {
    const result = await maid.chooseChatDirectory({ mode });
    if (result.cancelled) { message('选择已取消，未创建项目。'); return; }
    selection=result; $('selected-folder').textContent=`${t('已选择')} · ${result.label}`;
    $('initialize-project').disabled=false; $('initialize-project').textContent=t(mode==='resume'?'恢复所选项目':'建立并保存');
    for (const id of ['pet-name','user-nickname','folder-suffix']) $(id).disabled=mode==='resume';
  } catch { message('项目操作未完成，已有资料已保留。'); }
}
$('choose-parent').addEventListener('click',()=>choose('new')); $('choose-resume').addEventListener('click',()=>choose('resume'));
for (const id of ['pet-name','user-nickname','folder-suffix']) $(id).addEventListener('input',()=>{void maid.setChatDraft({scope:'project',text:[$('pet-name').value,$('user-nickname').value,$('folder-suffix').value].join('\n')});});
$('project-form').addEventListener('submit',async event=>{
  event.preventDefault(); if (!selection || saving) return;
  saving=true; $('initialize-project').disabled=true;
  const suffix=$('folder-suffix').value;
  try { render(await maid.initializeChat({selectionId:selection.selectionId,petName:$('pet-name').value,userNickname:$('user-nickname').value,...(suffix?{folderName:`codex-maid-chat-${suffix}`}:{})})); }
  catch { message('项目操作未完成，已有资料已保留。'); }
  finally { saving=false; $('initialize-project').disabled=!selection; }
});
const detailFields={'entry-subject':'subject','entry-conditions':'scope','entry-valid-from':'valid_from','entry-valid-to':'valid_to','entry-event-time':'event_time','entry-event-status':'event_status'};
const entrySignature=()=>JSON.stringify(['memory-content','memory-kind','memory-action','entry-scope','entry-advanced',...Object.keys(detailFields)].map(id=>$(id).value));
function fillEntry(entry={}){for(const [id,key]of Object.entries(detailFields))$(id).value=entry[key]==null?'':typeof entry[key]==='string'?entry[key]:JSON.stringify(entry[key]);$('entry-scope').value='source';const extra=Object.fromEntries(Object.entries(entry).filter(([key])=>['target_date','time_precision','time_expression','followup','importance','object_ids','relations','source_nature','speaker','replacement_refs','corrects','cancels'].includes(key)));$('entry-advanced').value=Object.keys(extra).length?JSON.stringify(extra,null,2):'';$('entry-sources').replaceChildren(...(entry.sources||[]).map(source=>{const p=document.createElement('p');p.textContent=JSON.stringify(source);if(source.type==='chat'&&source.conversationId&&source.messageId){const button=document.createElement('button');button.type='button';button.textContent=t('查看来源');button.addEventListener('click',()=>window.MaidChatWorkspace?.openReference(`${source.conversationId}/${source.messageId}${source.part?'/'+source.part:''}`));p.append(button);}return p;}));}
function clearEditor() {
  selectedEntry=null; dirtyForms.delete('entry');edited=dirtyForms.size>0; $('memory-content').value=''; $('memory-action').value='upsert';
  fillEntry();
  void updateDraft(moduleName,'');
}
function renderMemory(value) {
  memory=value;
  $('memory-status').textContent=edited?t('未保存草稿'):window.MaidChatView.memorySyncPresentation({...state,memory:{...state?.memory,...value}},t).label;
  document.querySelectorAll('[data-module]').forEach(button=>button.classList.toggle('active',button.dataset.module===moduleName));
  $('persona-baseline').hidden=moduleName!=='persona'; $('persona-names').hidden=moduleName!=='persona'; $('formation-controls').hidden=moduleName!=='userView';
  $('persona-defaults').hidden=moduleName!=='persona'; $('persona-defaults-help').hidden=moduleName!=='persona';
  $('baseline-text').textContent=value.baseline ? JSON.stringify(value.baseline,null,2) : '';
  if(!dirtyForms.has('baseline'))$('persona-edit').value=JSON.stringify(Object.fromEntries(['core','preferences','background','examples','boundaries'].map(key=>[key,value.baseline?.[key]||[]])),null,2);
  $('preinput-text').textContent=value.preinput ? JSON.stringify(value.preinput,null,2) : t('实际预输入尚未生成');
  if (!edited) {
    $('memory-kind').replaceChildren(...kinds[moduleName].map(([id,label])=>{const option=document.createElement('option');option.value=id;option.textContent=t(label);return option;}));
    $('edit-pet-name').value=value.names?.pet_name||''; $('edit-user-nickname').value=value.names?.user_nickname||'';
  }
  $('memory-entries').replaceChildren(...value.entries.map(entry=>{const button=document.createElement('button');button.type='button';button.className='memory-entry';button.textContent=`${entry.content}\n${window.MaidChatView.statusText(entry.status,t)} · ${entry.id}@${entry.rev}`;button.addEventListener('click',()=>{if(edited)return message('未保存草稿');selectedEntry=entry;$('memory-content').value=entry.content;$('memory-kind').value=entry.kind;$('memory-action').value='upsert';fillEntry(entry);edited=false;});return button;}));
  if (!value.entries.length) { const p=document.createElement('p');p.textContent=t('尚无条目');$('memory-entries').append(p); }
  $('memory-previous').disabled=value.offset===0; $('memory-next').disabled=value.offset+value.entries.length>=value.total;
}
async function loadMemory() {
  if (!state?.initialized) return;
  const generation=++request;
  try {const value=await maid.getChatMemory({module:moduleName,offset,limit:30});if(generation===request)renderMemory(value);}
  catch {message('聊天资料暂不可用，原文件已保留');}
}
document.querySelectorAll('[data-module]').forEach(button=>button.addEventListener('click',()=>{if(edited||saving)return message('未保存草稿');moduleName=button.dataset.module;offset=0;memory=null;selectedRevision=null;historyOffset=0;historyRequest++;$('memory-restore').disabled=true;$('memory-revision-detail').textContent='';$('memory-history-list').replaceChildren();clearEditor();void loadMemory();}));
$('memory-new').addEventListener('click',()=>{if(edited)return message('未保存草稿');clearEditor();});
$('memory-cancel').addEventListener('click',()=>{clearEditor();void loadMemory();});
$('names-cancel').addEventListener('click',()=>{
  dirtyForms.delete('names');edited=dirtyForms.size>0;void updateDraft('personaNames','');
  $('edit-pet-name').value=memory?.names?.pet_name||'';$('edit-user-nickname').value=memory?.names?.user_nickname||'';
  if(memory)renderMemory(memory);
});
for (const id of ['memory-content','memory-kind','memory-action','entry-scope','entry-advanced',...Object.keys(detailFields)]) $(id).addEventListener('input',()=>{
  dirtyForms.add('entry');edited=true; $('memory-status').textContent=t('未保存草稿');
  void updateDraft(moduleName,entrySignature());
});
for (const id of ['edit-pet-name','edit-user-nickname']) $(id).addEventListener('input',()=>{
  dirtyForms.add('names');edited=true;$('memory-status').textContent=t('未保存草稿');
  void updateDraft('personaNames',[$('edit-pet-name').value,$('edit-user-nickname').value].join('\n'));
});
async function save(action,payload,draftScope=moduleName) {
  if (!memory || saving) return;
  const submittedModule=moduleName,submittedVersion=memory.version;
  saving=true;
  const controls=Array.from($('memory-panel').querySelectorAll('input,select,textarea,button')),disabled=controls.map(node=>node.disabled);
  controls.forEach(node=>{node.disabled=true;});
  const pendingDraft=draftWrites.get(draftScope),form=draftScope===null?null:draftScope==='personaNames'?'names':draftScope==='personaBaseline'?'baseline':'entry';
  const fieldSignature=()=>form===null?null:form==='names'?JSON.stringify([$('edit-pet-name').value,$('edit-user-nickname').value]):form==='baseline'?$('persona-edit').value:entrySignature();
  const submittedSignature=fieldSignature();
  try {
    const signature=JSON.stringify({module:submittedModule,baseVersion:submittedVersion,action,payload});
    if (pendingSave?.signature!==signature) pendingSave={signature,operationId:window.crypto.randomUUID()};
    const draftReceipt=pendingDraft?await pendingDraft:null;
    await maid.saveChatMemory({module:submittedModule,operationId:pendingSave.operationId,baseVersion:submittedVersion,action,payload,
      ...(draftReceipt?{draftScope,draftRevision:draftReceipt.revision}:{})});
    pendingSave=null;
    if(form&&fieldSignature()===submittedSignature){dirtyForms.delete(form);if(form==='entry'){selectedEntry=null;$('memory-content').value='';fillEntry();}}
    edited=dirtyForms.size>0;await loadMemory();render(await maid.getChatState());
  } catch(error) { $('memory-status').textContent=error.message||t('保存失败，草稿和旧版本已保留。'); }
  finally {saving=false;controls.forEach((node,index)=>{node.disabled=disabled[index];});if(memory){$('memory-previous').disabled=memory.offset===0;$('memory-next').disabled=memory.offset+memory.entries.length>=memory.total;}}
}
$('memory-form').addEventListener('submit',event=>{
  event.preventDefault(); const action=$('memory-action').value;
  if (['upsert','correct'].includes(action)) {try{const extra=$('entry-advanced').value.trim()?JSON.parse($('entry-advanced').value):{};if(!extra||Array.isArray(extra)||typeof extra!=='object'||Object.keys(extra).some(key=>!['target_date','time_precision','time_expression','followup','importance','object_ids','relations','source_nature','speaker','replacement_refs','corrects','cancels'].includes(key)))throw new Error(t('高级字段格式无效。'));const fields=Object.fromEntries(Object.entries(detailFields).filter(([id])=>$(id).value||selectedEntry).map(([id,key])=>{const text=$(id).value;let value=text||null;if((key==='subject'||key==='scope')&&/^[{[]/.test(text)){value=JSON.parse(text);}return[key,value];}));return save(action,{entry:{...(selectedEntry?{id:selectedEntry.id}:{}),...extra,...fields,kind:$('memory-kind').value,content:$('memory-content').value,certainty:'explicit'}});}catch(error){$('memory-status').textContent=error.message;return;}}
  if (selectedEntry) return save(action,{id:selectedEntry.id,scope:$('entry-scope').value});
});
$('names-form').addEventListener('submit',event=>{event.preventDefault();void save('upsert',{names:{pet_name:$('edit-pet-name').value,user_nickname:$('edit-user-nickname').value}},'personaNames');});
$('persona-edit').addEventListener('input',()=>{dirtyForms.add('baseline');edited=true;void updateDraft('personaBaseline',$('persona-edit').value);});
$('persona-form').addEventListener('submit',event=>{event.preventDefault();try{const persona=JSON.parse($('persona-edit').value);void save('upsert',{persona},'personaBaseline');}catch(error){$('memory-status').textContent=error.message;}});
$('persona-edit-cancel').addEventListener('click',()=>{dirtyForms.delete('baseline');edited=dirtyForms.size>0;void updateDraft('personaBaseline','');if(memory)renderMemory(memory);});
for (const [id,action] of [['pause-formation','pause-automatic'],['resume-formation','resume-automatic'],['relearn','relearn']]) $(id).addEventListener('click',()=>save(action,{},null));
$('memory-previous').addEventListener('click',()=>{if(edited)return message('未保存草稿');offset=Math.max(0,offset-30);void loadMemory();});
$('memory-next').addEventListener('click',()=>{if(edited)return message('未保存草稿');offset+=30;void loadMemory();});
async function history(more=false){const module=moduleName,generation=++historyRequest;try{const value=await maid.listChatMemoryHistory({module,offset:more?historyOffset:0,limit:30,...(selectedEntry?{entryId:selectedEntry.id}:{})});if(generation!==historyRequest||module!==moduleName)return;const rows=value.revisions||value.items||value.history||[];if(!more)$('memory-history-list').replaceChildren();for(const row of rows){const button=document.createElement('button');button.type='button';button.className='memory-entry';const revision=row.revision??row.version;button.textContent=`${t('修订')} ${revision} · ${row.recordedAt||row.at||row.updatedAt||''}`;button.addEventListener('click',async()=>{if(module!==moduleName)return;try{const detail=await maid.readChatMemoryRevision({module,revision});if(module!==moduleName)return;selectedRevision={module,revision};$('memory-revision-detail').textContent=JSON.stringify({current:memory,selected:detail},null,2);$('memory-restore').disabled=false;}catch(error){$('memory-history-status').textContent=error.message;}});$('memory-history-list').append(button);}historyOffset=value.nextOffset??null;$('memory-history-more').disabled=historyOffset===null;$('memory-history-status').textContent=rows.length?'':t('尚无条目');}catch(error){if(module===moduleName)$('memory-history-status').textContent=error.message;}}
$('memory-history-refresh').addEventListener('click',()=>void history());$('memory-history-more').addEventListener('click',()=>void history(true));
async function restore(defaults){if(saving)return;if(edited)return message('未保存草稿');if(!defaults&&selectedRevision?.module!==moduleName)return;saving=true;try{const input={operationId:window.crypto.randomUUID(),baseVersion:memory.version};await(defaults?maid.restoreChatPersonaDefaults(input):maid.restoreChatMemory({...input,module:moduleName,revision:selectedRevision.revision}));await loadMemory();render(await maid.getChatState());$('memory-history-status').textContent=t('已保存，等待随下次请求同步');}catch(error){$('memory-history-status').textContent=error.message;}finally{saving=false;}}
$('memory-restore').addEventListener('click',()=>void restore(false));$('persona-defaults').addEventListener('click',()=>void restore(true));
maid.onChatState(render);
maid.onState(value=>{i18n?.setLocale(value.settings.language);i18n?.translateDocument(document);if(state)render(state);if(memory)renderMemory(memory);});
void maid.getState().then(value=>{i18n?.setLocale(value.settings.language);i18n?.translateDocument(document);});
void maid.getChatState().then(render).catch(()=>message('聊天资料暂不可用，原文件已保留'));

})();
