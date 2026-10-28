'use strict';
const $ = id => document.getElementById(id);
const i18n = window.MaidI18n;
const t = (source, params = {}) => i18n ? i18n.t(source, params) : String(source ?? '').replace(/\{(\w+)\}/g, (match, key) => Object.hasOwn(params, key) ? params[key] : match);
const messageText = value => typeof value === 'function' ? value() : t(value);
const characterName = character => i18n?.characterName ? i18n.characterName(character) : character?.name || t('默认形象');
let renderedLanguage, languageSaving = false, pendingLanguage = null, languageMessage = '', languageError = false;
let refreshing = false, importing = false, phrasesMessage = '', characterFeedbackState = null;
const settingsCategories = ['general', 'appearance', 'display', 'chat', 'interaction'];
let activeSettingsCategory = 'general';
function selectSettingsCategory(category, focus = false) {
  if (!settingsCategories.includes(category)) category = 'general';
  const changed = category !== activeSettingsCategory;
  const navigation = $('settings-tabs');
  const wasPinned = changed && navigation?.getBoundingClientRect?.().top <= 10;
  if (changed && activeSettingsCategory === 'appearance') void cancelRangePreviews();
  activeSettingsCategory = category;
  for (const id of settingsCategories) {
    const tab = $('settings-tab-' + id), panel = $('settings-panel-' + id), selected = id === category;
    if (tab) {
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
      tab.classList.toggle('is-active', selected);
    }
    if (panel) {
      panel.hidden = !selected;
      panel.setAttribute('aria-hidden', String(!selected));
    }
  }
  // Switching from a scrolled panel should reveal the next panel's beginning.
  if (wasPinned) {
    const panel = $('settings-panel-' + category);
    const top = panel.getBoundingClientRect().top + window.scrollY - navigation.getBoundingClientRect().height - 22;
    window.scrollTo({ top: Math.max(0, top), behavior: 'instant' });
  }
  if (focus) $('settings-tab-' + category)?.focus?.();
}
function setupSettingsCategories() {
  for (const [index, id] of settingsCategories.entries()) {
    const tab = $('settings-tab-' + id);
    if (!tab) continue;
    tab.addEventListener('click', () => selectSettingsCategory(id));
    tab.addEventListener('keydown', event => {
      const direction = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0;
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? settingsCategories.length - 1 : direction ? (index + direction + settingsCategories.length) % settingsCategories.length : -1;
      if (next < 0) return;
      event.preventDefault(); selectSettingsCategory(settingsCategories[next], true);
    });
  }
  selectSettingsCategory(activeSettingsCategory);
}
function translatedText(node, source) {
  node.setAttribute('data-i18n', source);
  node.textContent = t(source);
}
function renderLanguage(settings) {
  const language = pendingLanguage || settings.language || 'zh-CN';
  if (language !== renderedLanguage) {
    renderedLanguage = language;
    i18n?.setLocale(language);
    i18n?.translateDocument(document);
    if (characterFeedbackState) drawCharacterFeedback();
  }
  $('refresh').textContent = t(refreshing ? '刷新中…' : '刷新 ↻');
  $('import-characters').textContent = t(importing ? '正在导入…' : '＋ 导入形象');
  $('saved').textContent = t(phrasesMessage);
  if ($('language')) {
    $('language').value = language;
    $('language').disabled = languageSaving;
  }
  if ($('language-feedback')) {
    $('language-feedback').textContent = t(languageMessage);
    $('language-feedback').hidden = !languageMessage;
    $('language-feedback').classList.toggle('has-error', languageError);
  }
}
const booleans = ['showBubble','alwaysOnTop','clickThrough','sound','accountResetAlerts','followCodex','stayInCodexWindow','peekAtCorners'];
const numbers = ['scale','opacity','refreshSeconds','autoHideSeconds'];
const peekPercentages = ['peekBottomPercent','peekSidePercent'];
let current, phrasesEdited = false;
const chatModels = window.MaidChatView?.mountModels({document,maid:window.maid,t});
const characterCards = new Map();
const interactionCatalog = window.MaidInteractionCatalog;
let soundSaving = false, soundToggleSaving = false, soundPreviewing = false, soundPreviewBlocked = false;
let pendingInteractionSound = null, failedInteractionSound = null, soundFeedbackMessage = '', soundFeedbackError = false;
function interactionSoundAvailable(preset) {
  return !!preset && (!preset.separateBank || !!window.MaidLocalInteractionSamples?.presets?.[preset.id]);
}
function renderInteractionSounds() {
  const select = $('interactionSound');
  const id = soundSaving ? pendingInteractionSound : (failedInteractionSound ?? current?.settings.interactionSound ?? interactionCatalog.defaultId);
  select.value = id;
  const preset = interactionCatalog.presets.find(preset => preset.id === id);
  const available = interactionSoundAvailable(preset);
  $('interaction-sound-description').textContent = t(available ? (preset.description || '') : '此音效尚未在本机安装。');
  for (const option of select.children) {
    const item = interactionCatalog.presets.find(preset => preset.id === option.value);
    if (item) option.textContent = t(item.label);
  }
  const busy = soundSaving || soundToggleSaving || soundPreviewing;
  select.disabled = busy;
  $('sound').disabled = busy;
  const enabled = current?.settings.sound === true && $('sound').checked;
  $('preview-interaction-sound').disabled = busy || !enabled || !available || soundPreviewBlocked;
  $('interaction-sound-note').textContent = t(enabled
    ? '按下与抬起分别发声；试听会让挂件弹跳。挂件隐藏时请先手动显示。'
    : '弹跳音效已关闭；开启后可试听。所选音色仍会保留。');
  const feedback = $('interaction-sound-feedback');
  feedback.textContent = t(soundFeedbackMessage);
  feedback.hidden = !soundFeedbackMessage;
  feedback.classList.toggle('has-error', soundFeedbackError);
}
function setupInteractionSounds() {
  for (const preset of interactionCatalog.presets) {
    const option = element('option', '', preset.label);
    option.value = preset.id;
    option.disabled = !interactionSoundAvailable(preset);
    $('interactionSound').append(option);
  }
  $('interactionSound').addEventListener('change', async () => {
    if (soundSaving || soundToggleSaving || soundPreviewing || !current) return;
    const next = $('interactionSound').value;
    if (!interactionCatalog.presets.some(preset => preset.id === next && interactionSoundAvailable(preset))) {
      renderInteractionSounds(); return;
    }
    const previous = current.settings.interactionSound || interactionCatalog.defaultId;
    soundSaving = true; pendingInteractionSound = next; failedInteractionSound = null; soundPreviewBlocked = true;
    soundFeedbackMessage = '正在保存…'; soundFeedbackError = false;
    renderInteractionSounds();
    try {
      const value = await window.maid.setSettings({interactionSound: next});
      if (value?.settings?.interactionSound !== next) throw new Error('音色未保存');
      render(value);
      soundPreviewBlocked = false; soundFeedbackMessage = '音色已保存，立即生效。';
    } catch {
      failedInteractionSound = previous;
      soundFeedbackMessage = '未能保存，请重新选择音色后重试。'; soundFeedbackError = true;
    } finally {
      soundSaving = false; pendingInteractionSound = null; renderInteractionSounds();
    }
  });
  $('sound').addEventListener('change', async () => {
    if (soundSaving || soundToggleSaving || soundPreviewing || !current) return;
    soundToggleSaving = true; soundFeedbackMessage = ''; soundFeedbackError = false;
    const enabled = $('sound').checked;
    renderInteractionSounds();
    try { render(await window.maid.setSettings({sound: enabled})); }
    catch {
      $('sound').checked = current.settings.sound;
      soundFeedbackMessage = '未能保存音效开关，请重试。'; soundFeedbackError = true;
    } finally { soundToggleSaving = false; renderInteractionSounds(); }
  });
  $('preview-interaction-sound').addEventListener('click', async () => {
    if ($('preview-interaction-sound').disabled || !current?.settings.sound || !$('sound').checked) return;
    soundPreviewing = true; soundFeedbackMessage = ''; soundFeedbackError = false;
    renderInteractionSounds();
    try {
      await window.maid.action('bounce');
      soundFeedbackMessage = '已发送试听；若挂件已隐藏，请先手动显示再试听。';
    } catch {
      soundFeedbackMessage = '试听未完成，请确认挂件仍在运行后重试。'; soundFeedbackError = true;
    } finally { soundPreviewing = false; renderInteractionSounds(); }
  });
  renderInteractionSounds();
}

let rangeSaving = false, rangeFrame = null, rangeQueued = null, rangeBusy = false, rangeEpoch = 0;
let rangeTask = Promise.resolve();
const rangeControllers = [];
function stopRangePreviews() {
  rangeEpoch++;
  if (rangeFrame !== null) window.cancelAnimationFrame(rangeFrame);
  rangeFrame = null; rangeQueued = null;
  return rangeTask;
}
function renderRangePreviews() { for (const controller of rangeControllers) controller.render(); if(current)renderBubblePages(); }
function scheduleRangePreview() {
  if (rangeFrame !== null || rangeBusy || !rangeQueued || rangeSaving) return;
  rangeFrame = window.requestAnimationFrame(() => {
    rangeFrame = null;
    const request = rangeQueued; rangeQueued = null;
    if (!request || request.epoch !== rangeEpoch || rangeSaving || !request.owner.enabled()) return;
    rangeBusy = true;
    rangeTask = Promise.resolve().then(() => request.owner.preview(request.patch)).catch(async () => {
      if (request.epoch !== rangeEpoch) return;
      rangeEpoch++; rangeQueued = null;
      for (const controller of rangeControllers) { controller.drafts.clear(); controller.canceled = true; }
      request.owner.message = '预览未完成，请重新调整后重试。'; request.owner.error = true;
      renderRangePreviews();
      await Promise.allSettled(rangeControllers.map(controller => controller.preview(null)));
    }).finally(() => { rangeBusy = false; scheduleRangePreview(); });
  });
}
async function cancelRangePreviews() {
  if (rangeSaving || (!rangeControllers.some(controller => controller.drafts.size) && !rangeQueued && !rangeBusy && rangeFrame === null)) return;
  const pending = stopRangePreviews(), epoch = rangeEpoch;
  for (const controller of rangeControllers) { controller.drafts.clear(); controller.canceled = true; controller.message = ''; controller.error = false; }
  renderRangePreviews(); await pending;
  if (epoch !== rangeEpoch || rangeSaving) return;
  const replies = await Promise.allSettled(rangeControllers.map(controller => controller.preview(null)));
  if (epoch === rangeEpoch && replies.some(reply => reply.status === 'rejected')) {
    for (const controller of rangeControllers) { controller.message = '未能还原预览，请关闭设置页后重试。'; controller.error = true; }
    renderRangePreviews();
  }
}
function createRangePreview(ids, defaults, feedbackId, api, toggleId) {
  const controller = { ids, defaults, drafts: new Map(), pending: null, canceled: false, message: '', error: false,
    preview: patch => window.maid[api](patch),
    enabled() { return !toggleId || (this.pending?.id === toggleId ? this.pending.value : current?.settings[toggleId] === true); },
    saved(id) { return current?.settings[id] ?? defaults[id]; },
    label(id,value) { $(id+'-value').textContent = (toggleId ? value : Math.round(value*100))+'%'; },
    render() {
      const enabled = this.enabled();
      if (toggleId) { $(toggleId).checked = enabled; $(toggleId).disabled = rangeSaving; $('corner-peek-controls').hidden = !enabled; }
      for (const id of ids) {
        const value = this.drafts.get(id) ?? (this.pending?.id === id ? this.pending.value : this.saved(id));
        $(id).value = value; this.label(id,value); $(id).disabled = rangeSaving || !enabled;
      }
      const feedback = $(feedbackId); feedback.textContent = t(this.message); feedback.hidden = !this.message; feedback.classList.toggle('has-error',this.error);
    },
    async save(id,next) {
      if (rangeSaving || !current) return;
      rangeSaving = true; this.pending = {id,value:next};
      const pending = stopRangePreviews(); this.message = '正在保存…'; this.error = false; renderRangePreviews();
      try {
        await pending;
        const value = await window.maid.setSettings({[id]:next});
        if (value?.settings?.[id] !== next) throw new Error('设置未保存');
        render(value); if(current.settings[id] !== next)throw new Error('设置已更新');
        this.message = '已保存，立即生效。';
      } catch {
        await Promise.allSettled(rangeControllers.map(item => item.preview(null)));
        this.message = '未能保存，请重新调整后重试。'; this.error = true;
      } finally {
        rangeSaving = false; this.pending = null;
        for (const item of rangeControllers) item.drafts.clear();
        renderRangePreviews();
      }
    },
    setup() {
      if(toggleId) $(toggleId).addEventListener('change',() => { if(!$(toggleId).disabled)return this.save(toggleId,$(toggleId).checked); });
      for(const id of ids) {
        $(id).addEventListener('input',() => {
          if($(id).disabled)return;
          this.canceled = false; this.drafts.set(id,Number($(id).value));this.label(id,Number($(id).value));
          rangeQueued = {owner:this,epoch:++rangeEpoch,patch:Object.fromEntries(ids.map(key=>[key,this.drafts.get(key)??this.saved(key)]))};
          scheduleRangePreview();
        });
        $(id).addEventListener('change',() => { if(this.canceled){this.render();return;}if(!$(id).disabled)return this.save(id,Number($(id).value)); });
        $(id).addEventListener('pointercancel',cancelRangePreviews);
        $(id).addEventListener('keydown',event => { if(event.key==='Escape'){event.preventDefault();return cancelRangePreviews();} });
      }
      this.render();
    },
  };
  rangeControllers.push(controller);return controller;
}
const cornerRange = createRangePreview(peekPercentages,{peekBottomPercent:50,peekSidePercent:100},'corner-peek-feedback','previewCornerPeek','peekAtCorners');
const appearanceRange = createRangePreview(['scale','opacity'],{scale:1,opacity:1},'appearance-feedback','previewAppearance');
function renderCornerPeek() { renderRangePreviews(); }
function setupCornerPeek() {
  for(const controller of rangeControllers)controller.setup();
  window.addEventListener('blur',cancelRangePreviews);window.addEventListener('pagehide',cancelRangePreviews);
}

const bubblePageIds = ['quota','conversation','accounts','today','week','lastTurn','phrase','resetForecast'];
const bubblePageNames = {quota:'额度',conversation:'对话状态',accounts:'账号管理',today:'今日用量',week:'本周用量',lastTurn:'最近一轮',phrase:'女仆台词',resetForecast:'重置预测'};
let bubblePagePending = null, bubblePageSaving = false, bubblePageMessage = '', bubblePageError = false, draggingBubblePage = null, bubblePageSortable;
function bubblePageConfig(settings = current?.settings || {}) {
  const order = [...new Set([...(Array.isArray(settings.bubblePageOrder)?settings.bubblePageOrder:[]),...bubblePageIds])].filter(id=>bubblePageIds.includes(id));
  const hidden = order.filter(id=>settings.bubbleHiddenPages?.includes(id));
  return {bubblePageOrder:order,bubbleHiddenPages:hidden,defaultBubblePage:settings.defaultBubblePage||settings.mode||'quota'};
}
function renderBubblePages() {
  const config = bubblePagePending || bubblePageConfig();
  const container = $('bubble-pages'), saving = bubblePageSaving || rangeSaving, busy = saving || !!draggingBubblePage;
  // Sortable owns the live DOM order until drop. Status broadcasts may refresh
  // values, but must never reinsert a row or reset the library's drag geometry.
  container.classList.toggle('page-sort-active', draggingBubblePage?.started === true);
  bubblePageSortable?.option('disabled', saving || !current);
  for(const [index,id] of config.bubblePageOrder.entries()) {
    const row = $('page-'+id), hidden = config.bubbleHiddenPages.includes(id);
    if(!draggingBubblePage && container.children[index]!==row)container.insertBefore(row,container.children[index]||null);
    row.classList.toggle('is-hidden',hidden);row.classList.toggle('is-default',config.defaultBubblePage===id);
    $('page-visible-'+id).checked=!hidden;$('page-visible-'+id).disabled=busy;
    $('page-default-'+id).checked=config.defaultBubblePage===id;$('page-default-'+id).disabled=busy||hidden;
    $('page-handle-'+id).disabled=saving || (!!draggingBubblePage && draggingBubblePage.id!==id);
  }
  $('reset-page-order').disabled=busy;
  const feedback=$('bubble-pages-feedback');feedback.textContent=messageText(bubblePageMessage);feedback.hidden=!bubblePageMessage;feedback.classList.toggle('has-error',bubblePageError);
}
async function saveBubblePages(config,message='气泡页面已保存。',orderOnly=false) {
  if(bubblePageSaving||rangeSaving||draggingBubblePage){renderBubblePages();return false;}
  bubblePageSaving=true;rangeSaving=true;bubblePagePending=config;bubblePageMessage='正在保存…';bubblePageError=false;
  const pending=stopRangePreviews();renderRangePreviews();renderBubblePages();
  try {
    await pending;
    const value=await window.maid.setSettings(orderOnly?{bubblePageOrder:config.bubblePageOrder}:config);
    if(!value?.settings||JSON.stringify(bubblePageConfig(value.settings))!==JSON.stringify(config))throw new Error('页面设置未保存');
    render(value);
    if(JSON.stringify(bubblePageConfig())!==JSON.stringify(config))throw new Error('页面设置已更新');
    bubblePageMessage=message;return true;
  } catch {
    await Promise.allSettled(rangeControllers.map(controller=>controller.preview(null)));
    bubblePageMessage='未能保存页面设置，请重试。';bubblePageError=true;return false;
  } finally {
    bubblePageSaving=false;rangeSaving=false;bubblePagePending=null;
    for(const controller of rangeControllers)controller.drafts.clear();
    renderRangePreviews();renderBubblePages();
  }
}
async function moveBubblePage(id,target) {
  if(bubblePageSaving||rangeSaving||draggingBubblePage)return;
  const config=bubblePageConfig(),from=config.bubblePageOrder.indexOf(id);
  if(from<0||target<0||target>=config.bubblePageOrder.length)return;
  config.bubblePageOrder.splice(from,1);config.bubblePageOrder.splice(target,0,id);
  config.bubbleHiddenPages=config.bubblePageOrder.filter(page=>config.bubbleHiddenPages.includes(page));
  if(await saveBubblePages(config,'气泡页面已保存。',true))$('page-handle-'+id).focus();
}
function setupBubblePages() {
  for(const id of bubblePageIds) {
    $('page-visible-'+id).addEventListener('change',() => {
      if(bubblePageSaving||rangeSaving||draggingBubblePage){renderBubblePages();return;}
      const config=bubblePageConfig(),hidden=new Set(config.bubbleHiddenPages),show=$('page-visible-'+id).checked;
      if(show)hidden.delete(id);else hidden.add(id);
      if(hidden.size===bubblePageIds.length){bubblePageMessage='至少保留一个可见页面。';bubblePageError=true;renderBubblePages();return;}
      config.bubbleHiddenPages=config.bubblePageOrder.filter(page=>hidden.has(page));
      let message='气泡页面已保存。';
      if(hidden.has(config.defaultBubblePage)){config.defaultBubblePage=config.bubblePageOrder.find(page=>!hidden.has(page));message=()=>t('原默认页已隐藏，启动默认页改为「{name}」。',{name:t(bubblePageNames[config.defaultBubblePage])});}
      return saveBubblePages(config,message);
    });
    $('page-default-'+id).addEventListener('change',() => {
      if(bubblePageSaving||rangeSaving||draggingBubblePage){renderBubblePages();return;}
      const config=bubblePageConfig();
      if(config.bubbleHiddenPages.includes(id)){renderBubblePages();return;}
      config.defaultBubblePage=id;return saveBubblePages(config,()=>t('启动默认页已设为「{name}」。',{name:t(bubblePageNames[id])}));
    });
    const handle=$('page-handle-'+id);
    handle.addEventListener('keydown',event=>{if(event.altKey&&['ArrowUp','ArrowDown'].includes(event.key)){event.preventDefault();return moveBubblePage(id,bubblePageConfig().bubblePageOrder.indexOf(id)+(event.key==='ArrowUp'?-1:1));}});
  }
  // Official SortableJS handles pointer tracking, item displacement, easing,
  // fallback clone placement and auto-scroll. Only the completed order is saved.
  bubblePageSortable=window.Sortable.create($('bubble-pages'),{
    draggable:'.bubble-page-card',handle:'.page-drag-handle',dataIdAttr:'data-page-id',
    direction:'vertical',animation:180,easing:'cubic-bezier(0.2, 0, 0, 1)',
    forceFallback:true,fallbackOnBody:true,fallbackTolerance:4,
    ghostClass:'page-sort-ghost',chosenClass:'page-sort-chosen',dragClass:'page-sort-drag',fallbackClass:'page-sort-fallback',
    scroll:true,scrollSensitivity:48,scrollSpeed:8,bubbleScroll:true,
    disabled:true,
    onChoose(event){
      draggingBubblePage={id:event.item.dataset.pageId,started:false,order:bubblePageConfig().bubblePageOrder};
      renderBubblePages();
    },
    onStart(){if(draggingBubblePage)draggingBubblePage.started=true;renderBubblePages();},
    onUnchoose(){
      // A handle click can choose without starting a drag. For a real drag,
      // Sortable emits unchoose before end; leave its DOM untouched until end.
      if(draggingBubblePage&&!draggingBubblePage.started){draggingBubblePage=null;renderBubblePages();}
    },
    onEnd(event){
      const drag=draggingBubblePage,order=bubblePageSortable.toArray();
      draggingBubblePage=null;
      if(!drag?.started||order.length!==bubblePageIds.length||new Set(order).size!==bubblePageIds.length||order.some(id=>!bubblePageIds.includes(id))||order.every((id,index)=>id===drag.order[index])){renderBubblePages();return;}
      const config=bubblePageConfig();
      config.bubblePageOrder=order;config.bubbleHiddenPages=order.filter(id=>config.bubbleHiddenPages.includes(id));
      return saveBubblePages(config,'页面顺序已保存。',true).then(saved=>{if(saved)$('page-handle-'+event.item.dataset.pageId).focus();});
    },
  });
  $('reset-page-order').addEventListener('click',()=>{if(bubblePageSaving||rangeSaving||draggingBubblePage)return;const config=bubblePageConfig();config.bubblePageOrder=[...bubblePageIds];config.bubbleHiddenPages=bubblePageIds.filter(id=>config.bubbleHiddenPages.includes(id));return saveBubblePages(config,'已恢复默认排序，显隐和默认页保持。',true);});
  renderBubblePages();
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function translatedElement(tag, className, source) {
  const node = element(tag, className, t(source));
  node.setAttribute('data-i18n', source);
  return node;
}
function characterFeedback(message, errors = []) {
  characterFeedbackState = {message, errors};
  drawCharacterFeedback();
}
function drawCharacterFeedback() {
  const {message, errors} = characterFeedbackState;
  const container = $('character-feedback');
  container.replaceChildren();
  container.classList.toggle('has-error', errors.length > 0);
  container.hidden = !message && !errors.length;
  if (message) container.append(element('p', '', messageText(message)));
  if (errors.length) {
    const list = element('ul');
    for (const error of errors) list.append(element('li', '', t('{name}：{message}', {name:error.name || t('图片'), message:t(error.message || '导入失败')})));
    container.append(list);
  }
}
function setCharacterBusy(entry, busy) {
  entry.busy = busy;
  for (const button of entry.card.querySelectorAll('button')) button.disabled = busy;
  entry.select.disabled = busy || !entry.character.available;
  entry.input.disabled = busy;
}
async function characterAction(entry, action) {
  if (entry.busy) return false;
  entry.error.hidden = true;
  setCharacterBusy(entry, true);
  try {
    const state = await action();
    if (state) render(state);
    return true;
  } catch (error) {
    translatedText(entry.error, error?.message || '操作未完成，请再试一次。');
    entry.error.hidden = false;
    return false;
  } finally {
    setCharacterBusy(entry, false);
  }
}
function closeCharacterEditor(entry) {
  entry.renameForm.hidden = true;
  entry.removeConfirm.hidden = true;
  entry.actions.hidden = false;
  entry.error.hidden = true;
}
function createCharacterCard(character) {
  const card = element('article', 'character-card');
  card.dataset.characterId = character.id;
  const select = element('button', 'character-select');
  select.type = 'button';
  select.dataset.action = 'select';
  const imageFrame = element('span', 'character-image-frame');
  const image = element('img', 'character-image');
  image.alt = '';
  const missing = translatedElement('span', 'character-missing', '图片无法读取');
  missing.hidden = true;
  imageFrame.append(image, missing);
  const caption = element('span', 'character-caption');
  const name = element('strong', 'character-name');
  const badge = element('span', 'character-badge');
  caption.append(name, badge);
  select.append(imageFrame, caption);
  const meta = element('div', 'character-meta');
  const kind = element('span', 'character-kind');
  const availability = translatedElement('span', 'character-availability', '文件损坏或丢失');
  availability.hidden = true;
  meta.append(kind, availability);
  const actions = element('div', 'character-actions');
  const rename = translatedElement('button', 'secondary', '重命名');
  rename.type = 'button'; rename.dataset.action = 'rename';
  const remove = translatedElement('button', 'character-remove', '删除');
  remove.type = 'button'; remove.dataset.action = 'remove';
  actions.append(rename, remove);
  const renameForm = element('form', 'character-rename-form');
  renameForm.hidden = true;
  const label = element('label');
  label.append(translatedElement('span', '', '形象名称'));
  const input = element('input', 'character-name-input');
  input.type = 'text'; input.maxLength = 40; input.required = true;
  label.append(input);
  const renameActions = element('div', 'character-editor-actions');
  const save = translatedElement('button', '', '保存');
  save.type = 'submit'; save.dataset.action = 'save-name';
  const cancelRename = translatedElement('button', 'secondary', '取消');
  cancelRename.type = 'button'; cancelRename.dataset.action = 'cancel-rename';
  renameActions.append(save, cancelRename);
  renameForm.append(label, renameActions);
  const removeConfirm = element('div', 'character-remove-confirm');
  removeConfirm.hidden = true;
  const removeMessage = element('p');
  const confirmActions = element('div', 'character-editor-actions');
  const confirmRemove = translatedElement('button', 'danger', '确认删除');
  confirmRemove.type = 'button'; confirmRemove.dataset.action = 'confirm-remove';
  const cancelRemove = translatedElement('button', 'secondary', '取消');
  cancelRemove.type = 'button'; cancelRemove.dataset.action = 'cancel-remove';
  confirmActions.append(confirmRemove, cancelRemove);
  removeConfirm.append(removeMessage, confirmActions);
  const error = element('p', 'character-card-error');
  error.hidden = true; error.setAttribute('role', 'alert');
  card.append(select, meta, actions, renameForm, removeConfirm, error);
  const entry = {card, select, image, missing, name, badge, kind, availability, actions, renameForm, input, removeConfirm, removeMessage, remove, error, character, busy: false};
  select.addEventListener('click', () => {
    if (entry.character.available) characterAction(entry, () => window.maid.selectCharacter(entry.character.id));
  });
  // Only update this keyed card during data refreshes, so editing a name retains its caret and selection.
  rename.addEventListener('click', () => {
    closeCharacterEditor(entry);
    actions.hidden = true;
    renameForm.hidden = false;
    input.value = entry.character.name;
    input.focus(); input.select();
  });
  cancelRename.addEventListener('click', () => { closeCharacterEditor(entry); rename.focus(); });
  renameForm.addEventListener('submit', async event => {
    event.preventDefault();
    const nextName = input.value.trim();
    if (!nextName) {
      translatedText(error, '请填写形象名称。'); error.hidden = false; input.focus(); return;
    }
    if (await characterAction(entry, () => window.maid.renameCharacter(entry.character.id, nextName))) {
      closeCharacterEditor(entry); rename.focus();
    }
  });
  input.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !entry.busy) { closeCharacterEditor(entry); rename.focus(); }
  });
  remove.addEventListener('click', () => {
    closeCharacterEditor(entry);
    actions.hidden = true;
    removeConfirm.hidden = false;
    removeMessage.textContent = t('删除「{name}」？已保存的图片也会一并删除。', {name:characterName(entry.character)});
    cancelRemove.focus();
  });
  cancelRemove.addEventListener('click', () => { closeCharacterEditor(entry); remove.focus(); });
  confirmRemove.addEventListener('click', async () => {
    if (await characterAction(entry, () => window.maid.removeCharacter(entry.character.id))) {
      characterFeedback('形象已删除。');
      $('import-characters').focus();
    }
  });
  image.addEventListener('error', () => { image.hidden = true; missing.hidden = false; });
  image.addEventListener('load', () => { image.hidden = false; missing.hidden = true; });
  return entry;
}
function renderCharacters(value) {
  const characters = value.characters || [];
  const active = characters.find(character => character.id === value.activeCharacterId);
  const activeName = active ? characterName(active) : value.characterName || t('默认形象');
  if ($('preview').getAttribute('src') !== value.characterUrl) $('preview').src = value.characterUrl;
  $('preview').alt = t('当前使用：{name}', {name:activeName});
  $('current-character-name').textContent = activeName;
  $('character-count').textContent = t('已保存 {n} 个形象', {n:characters.length});
  const ids = new Set(characters.map(character => character.id));
  for (const [id, entry] of characterCards) {
    if (!ids.has(id)) { entry.card.remove(); characterCards.delete(id); }
  }
  for (const [index, character] of characters.entries()) {
    let entry = characterCards.get(character.id);
    if (!entry) { entry = createCharacterCard(character); characterCards.set(character.id, entry); }
    entry.character = character;
    const selected = character.id === value.activeCharacterId;
    entry.card.classList.toggle('selected', selected);
    entry.card.classList.toggle('unavailable', !character.available);
    entry.select.setAttribute('aria-pressed', String(selected));
    entry.select.setAttribute('aria-label', t(selected ? '当前使用：{name}' : '选用 {name}', {name:characterName(character)}));
    entry.select.disabled = entry.busy || !character.available;
    entry.name.textContent = characterName(character);
    entry.name.title = characterName(character);
    entry.badge.textContent = t(selected ? '使用中 ✓' : '选用');
    entry.kind.textContent = t(character.builtIn ? '内置形象' : '已保存到本机');
    entry.remove.hidden = character.builtIn;
    entry.availability.hidden = character.available;
    if (entry.image.getAttribute('src') !== character.url) {
      if (character.url) entry.image.src = character.url;
      else entry.image.removeAttribute('src');
    }
    if (!character.available) { entry.image.hidden = true; entry.missing.hidden = false; }
    if (!entry.removeConfirm.hidden) entry.removeMessage.textContent = t('删除「{name}」？已保存的图片也会一并删除。', {name:characterName(character)});
    // Do not detach/reappend an unchanged card: that would disturb focused inputs in Chromium.
    const currentNode = $('character-grid').children[index];
    if (currentNode !== entry.card) $('character-grid').insertBefore(entry.card, currentNode || null);
  }
}
function render(value) {
  if (Number.isFinite(value.settingsRevision) && Number.isFinite(current?.settingsRevision) && value.settingsRevision < current.settingsRevision) return;
  current=value;
  renderLanguage(value.settings);
  chatModels?.render(value.settings);
  if ($('chatPageEnabled')) $('chatPageEnabled').checked = value.settings.chatPageEnabled === true;
  if (!value.settings.peekAtCorners && cornerRange.drafts.size) void cancelRangePreviews();
  $('version').textContent = 'v'+value.version;
  for(const id of booleans) $(id).checked = value.settings[id];
  renderCornerPeek();
  renderInteractionSounds();
  $('alwaysOnTop').disabled = value.settings.stayInCodexWindow === true;
  const windowMode = value.windowContainment;
  const topmost = windowMode?.topmost;
  $('topmost-note').textContent = t(value.settings.stayInCodexWindow ? '窗口内模式不使用全局置顶。'
    : topmost?.reason === 'pending' ? '正在应用置顶设置…'
      : topmost?.reason === 'topmost-unavailable' ? '暂时无法确认置顶状态，可重新显示挂件重试。'
        : topmost?.verified ? (topmost.desired ? '已启用置顶。' : '已关闭置顶。') : '独立显示时按此开关控制置顶。');
  $('stayInCodexWindow').disabled = windowMode?.supported === false && !value.settings.stayInCodexWindow;
  $('window-mode-note').textContent = t(!value.settings.stayInCodexWindow ? '默认关闭；开启后人物固定在窗口内部，随窗口移动、收起和展开。'
    : ({ contained: '已限制在 Codex 窗口内；关闭后恢复独立位置和置顶设置。', 'host-too-small': 'Codex 窗口空间不足，已暂时隐藏；可放大窗口或调小挂件。',
      'manual-hidden': '已手动隐藏；可从托盘或快捷键恢复。', 'other-foreground': '切换到了其他应用，挂件暂时隐藏。', 'host-hidden': 'Codex 窗口已最小化或隐藏，挂件随之隐藏。' })[windowMode?.reason]
      || '正在等待可见的 Codex 窗口；窗口内模式不使用全局置顶。');
  for(const id of numbers.filter(id=>!['scale','opacity'].includes(id))) $(id).value = value.settings[id];
  renderBubblePages();
  $('bucketId').replaceChildren();
  for(const item of [{id:'',name:t('自动选择')},...(value.snapshot.buckets || [])]) { const option=document.createElement('option'); option.value=item.id; option.textContent=item.id==='demo'&&item.name==='演示额度'?t('演示额度'):item.name||item.id; $('bucketId').append(option); }
  $('bucketId').value=value.settings.bucketId;
  if(!phrasesEdited) $('phrases').value=(i18n?.isDefaultPhrases?.(value.settings.phrases) ? value.settings.phrases.map(phrase=>t(phrase)) : value.settings.phrases).join('\n');
  renderCharacters(value);
  const status=value.snapshot.status;
  $('status-dot').classList.toggle('live',['live','demo'].includes(status));
  $('status-text').textContent=t(({live:'已连接本机 Codex',partial:'部分数据可用',offline:'暂时无法连接 Codex',connecting:'正在连接 Codex',demo:'正在预览演示数据'})[status]||status);
  $('error').textContent=t(value.snapshot.error||''); $('error').hidden=!value.snapshot.error;
  $('data-detail').textContent=value.snapshot.account?.planType ? t('当前套餐：{plan} · 额度来自 Codex app-server', {plan:t(value.snapshot.account.planType)}) : t('额度来自本机 Codex app-server；不需要填写密钥。');
  $('demo-note').textContent=value.demo?t('· 当前为演示模式'):'';
  $('autostart-note').textContent=t(value.followError || (value.followSupported === false ? 'Windows 可携版支持自动跟随，演示或源码模式不修改系统启动项。' : '打开客户端时启动，退出客户端后自动退出；启动助手在后台等待下次打开。'));
}
if ($('language')) $('language').addEventListener('change', async () => {
  if (!current || languageSaving) return;
  const previous = current.settings.language || 'zh-CN', next = $('language').value;
  if (!['zh-CN', 'en'].includes(next)) return;
  languageSaving = true; pendingLanguage = next; languageMessage = '正在保存…'; languageError = false;
  render(current);
  try {
    const value = await window.maid.setSettings({language:next});
    if (value?.settings?.language !== next) throw new Error('语言未能保存，请重试。');
    render(value); languageMessage = '语言已保存。';
  } catch {
    languageMessage = '语言未能保存，请重试。'; languageError = true;
    current = {...current, settings:{...current.settings, language:previous}};
  } finally {
    languageSaving = false; pendingLanguage = null; render(current);
  }
});
for(const id of booleans.filter(id => id !== 'sound' && id !== 'peekAtCorners')) $(id).addEventListener('change',()=>window.maid.setSettings({[id]:$(id).checked}));
if ($('chatPageEnabled')) $('chatPageEnabled').addEventListener('change', () => window.maid.setSettings({chatPageEnabled:$('chatPageEnabled').checked}));
if ($('open-chat-manager')) $('open-chat-manager').addEventListener('click', () => window.maid.openChatManager());
for(const id of [...numbers.filter(id=>!['scale','opacity'].includes(id)),'bucketId']) {
  $(id).addEventListener('change',()=>window.maid.setSettings({[id]:numbers.includes(id)?Number($(id).value):$(id).value}));
}
$('phrases').addEventListener('input',()=>{phrasesEdited=true;phrasesMessage='';$('saved').textContent='';});
$('save-phrases').addEventListener('click',async()=>{const phrases=!phrasesEdited&&i18n?.isDefaultPhrases?.(current?.settings.phrases)?current.settings.phrases:$('phrases').value.split('\n').map(x=>x.trim()).filter(Boolean);if(!phrases.length){phrasesMessage='请至少写一句台词';$('saved').textContent=t(phrasesMessage);return;}await window.maid.setSettings({phrases});phrasesEdited=false;phrasesMessage='已保存';$('saved').textContent=t(phrasesMessage);});
$('refresh').addEventListener('click',async()=>{refreshing=true;$('refresh').disabled=true;$('refresh').textContent=t('刷新中…');try{await window.maid.refresh();}finally{refreshing=false;$('refresh').disabled=false;$('refresh').textContent=t('刷新 ↻');}});
$('import-characters').addEventListener('click', async () => {
  const button = $('import-characters');
  importing = true; button.disabled = true; button.textContent = t('正在导入…');
  try {
    const result = await window.maid.importCharacters();
    if (result.state) render(result.state);
    const imported = result.importedCount || 0, existing = result.existingCount || 0, errors = result.errors || [];
    if (imported || existing || errors.length) characterFeedback(() => {
      const messages = [];
      if (imported) messages.push(t('已导入 {n} 个形象', {n:imported}));
      if (existing) messages.push(t('{n} 张图片已在形象库中', {n:existing}));
      if (errors.length) messages.push(t('{n} 张未能导入', {n:errors.length}));
      return messages.join(t('，')) + t('。');
    }, errors);
  } catch (error) {
    characterFeedback('导入未完成。', [{message: error?.message || '请重新选择本地图片。'}]);
  } finally {
    importing = false; button.disabled = false; button.textContent = t('＋ 导入形象');
  }
});
setupInteractionSounds();
setupCornerPeek();
setupBubblePages();
setupSettingsCategories();
window.maid.onState(render);window.maid.getState().then(render);
