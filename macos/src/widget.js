'use strict';
const i18n = window.MaidI18n;
const t = (source, params = {}) => i18n?.t(source, params) ?? source.replace(/\{(\w+)\}/g, (match, key) => Object.prototype.hasOwnProperty.call(params, key) ? String(params[key]) : match);
const locale = () => i18n?.getLocale() || 'zh-CN';
const $ = id => document.getElementById(id);
const mirrorFlip = window.MaidMirrorFlip?.create({ image: $('maid-image') });
let current, mode = 'quota', hideTimer, noticeTimer, phraseIndex = -1, lastTurnTimestamp, initializedTurn = false;
let displayed = null, animationId;
const modes = ['quota','conversation','accounts','today','week','lastTurn','phrase'];
let conversationVisible = false, conversationRequest = 0, conversationPending = false;
let conversationSelectionMode = 'auto';
let lastConversationResult = null, lastConversationLoading = false, lastConversationChoices = null;
let modeWriteGeneration = 0, modeWritePending = 0, lastSettingsRevision = -1;
const accountCards = new Map(), accountResetEvents = new Map();
let accountRequest = 0, accountFeedbackTimer;
let accountFeedbackSource = '本机记录推算 · 历史账号需登录确认';
function clearBounceMotion(keepPressed = false) { for (const id of ['character', 'bubble-motion']) { $(id).classList.remove('bounce', 'account-alarm-bounce'); if (!keepPressed) $(id).classList.remove('interaction-pressed'); } if (!keepPressed) $('widget').classList.remove('drag-interaction'); }
function clearBounce() { interactionHeld = false; interactionSound?.stop(); clearBounceMotion(); }
const themeCache = new Map();
let themeRequest = 0;
function applyTheme(palette, source, characterId) {
  for (const [key, color] of Object.entries(palette)) $('widget').style.setProperty(key, color);
  $('widget').dataset.themeSource = source;
  $('widget').dataset.themeCharacter = characterId;
}
async function matchCharacterTheme(value) {
  const request = ++themeRequest, id = value.activeCharacterId || '', url = value.characterUrl;
  const preset = CharacterTheme.builtinTheme(id);
  if (preset) { applyTheme(preset, 'builtin', id); return; }
  if (themeCache.has(url)) { applyTheme(themeCache.get(url), 'image', id); return; }
  applyTheme(CharacterTheme.builtinTheme('frost-glass-cheek'), 'fallback', id);
  try {
    const image = new Image(); image.decoding = 'async'; image.src = url;
    await image.decode();
    if (request !== themeRequest) return;
    // Sample a small thumbnail once per saved image; transparent pixels and skin
    // are filtered by the palette helper so hair/accessories determine the theme.
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 48;
    const context = canvas.getContext('2d', {willReadFrequently:true});
    context.drawImage(image, 0, 0, 48, 48);
    const palette = CharacterTheme.themeFromPixels(context.getImageData(0, 0, 48, 48).data);
    if (request !== themeRequest) return;
    themeCache.set(url, palette); applyTheme(palette, 'image', id);
  } catch { /* A missing or undecodable image keeps the readable fallback palette. */ }
}
function fitTokenLabels() {
  for (const id of ['today-tokens','week-tokens','last-tokens']) {
    const label = $(id);
    if (label.parentElement.hidden) continue;
    label.style.fontSize = '';
    const available = label.parentElement.clientWidth - 2;
    if (available > 0 && label.scrollWidth > available) label.style.fontSize = `${36 * available / label.scrollWidth}px`;
  }
}
function fitPhraseText() {
  const view = $('phrase-view'), label = $('phrase');
  if (view.hidden || !label.textContent || !view.clientWidth || !view.clientHeight) return;
  const style = getComputedStyle(view), gap = parseFloat(style.rowGap) || 0;
  const fixedHeight = [...view.children].filter(child => child !== label).reduce((height, child) => height + child.offsetHeight, 0);
  const availableHeight = view.clientHeight - fixedHeight - gap * (view.children.length - 1) - (parseFloat(style.paddingTop) || 0) - (parseFloat(style.paddingBottom) || 0);
  if (availableHeight <= 0) return;
  const maxHeight = parseFloat(getComputedStyle(label).maxHeight);
  const heightLimit = Number.isFinite(maxHeight) ? Math.min(maxHeight, availableHeight) : availableHeight;
  const fits = size => {
    label.style.fontSize = `${size}px`;
    // A glyph can extend past its rounded natural line box at some display
    // scales. Compare with the space reserved for the whole paragraph instead.
    return label.scrollHeight <= Math.ceil(heightLimit) && label.scrollWidth <= label.clientWidth;
  };
  // Always start at the large reading size, including after a longer line. Use
  // layout measurements so CJK, mixed text and unbroken words share one rule.
  if (fits(24)) return;
  let low = 0, high = 24;
  for (let attempt = 0; attempt < 10; attempt++) {
    const size = (low + high) / 2;
    if (fits(size)) low = size; else high = size;
  }
  label.style.fontSize = `${Math.floor(low * 10) / 10}px`;
}
function applyVisualPose(value = current) {
  const scale = innerWidth / 380 || 1;
  const percentage = (key, fallback) => {
    const amount = value?.settings?.[key];
    return typeof amount === 'number' && Number.isFinite(amount) ? Math.round(Math.max(0, Math.min(200, amount))) / 100 : fallback / 100;
  };
  const side = percentage('peekSidePercent', 100), bottom = percentage('peekBottomPercent', 50);
  const corner = value?.cornerDock?.peeking === true ? value.cornerDock.corner : null;
  const fallback = corner === 'left' || corner === 'right'
    ? { x: side === 0 ? 0 : (corner === 'left' ? -48 : 48) * side, y: 56 * bottom } : { x: 0, y: 0 };
  const pose = value?.visualPose;
  const offset = pose?.offset;
  const x = offset && Number.isFinite(offset.x) ? offset.x / scale : fallback.x;
  const y = offset && Number.isFinite(offset.y) ? offset.y / scale : fallback.y;
  $('widget').style.setProperty('--visual-offset-x', `${x}px`);
  $('widget').style.setProperty('--visual-offset-y', `${y}px`);
  $('widget').classList.toggle('is-moving', pose?.moving === true);
  if (pose?.moving === true) clearBounceMotion(true);
}
function fit() { $('widget').style.transform = `scale(${innerWidth / 380})`; applyVisualPose(); fitTokenLabels(); fitPhraseText(); }
fit(); window.addEventListener('resize', fit);
const phraseResizeObserver = new ResizeObserver(fitPhraseText);
for (const element of [$('phrase-view'), ...$('phrase-view').children].filter(element => element.id !== 'phrase')) phraseResizeObserver.observe(element);
document.fonts.ready.then(fitPhraseText);
document.fonts.addEventListener('loadingdone', fitPhraseText);
let tokenCompact = new Intl.NumberFormat('zh-CN', { notation: 'compact', minimumSignificantDigits: 5, maximumSignificantDigits: 5 });
let tokenInteger = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 });
function compact(n) { return typeof n === 'number' && Number.isFinite(n) ? (Math.abs(n) >= (locale() === 'en' ? 1000 : 10000) ? tokenCompact : tokenInteger).format(n) : '--'; }
function renderTokens(id, value) {
  $(id).textContent = compact(value)+' tokens';
  $(id).title = typeof value === 'number' && Number.isFinite(value) ? tokenInteger.format(value)+' tokens' : t('暂未取得用量数据');
}
function windowName(minutes) { return !minutes ? t('当前窗口') : minutes >= 10080 ? t('周额度') : minutes >= 1440 ? t('{days}天额度', {days:Math.round(minutes / 1440)}) : t('{hours}小时额度', {hours:minutes / 60}); }
function selectedBucket() { return current?.snapshot?.buckets?.find(b => b.id === current.settings.bucketId) || current?.snapshot?.buckets?.[0]; }
function roll(value) {
  cancelAnimationFrame(animationId);
  if (!Number.isFinite(value)) { $('remaining').textContent = '--'; displayed = null; return; }
  const from = displayed ?? value, start = performance.now();
  const step = time => { const p = Math.min(1, (time-start)/650); displayed = from+(value-from)*(1-Math.pow(1-p,3)); $('remaining').textContent = Number(displayed.toFixed(1)).toString(); if (p < 1) animationId = requestAnimationFrame(step); };
  animationId = requestAnimationFrame(step);
}
function countdown() {
  const p = selectedBucket()?.primary;
  if (!Number.isFinite(p?.resetsAt)) { $('countdown').textContent = '--:--:--'; return; }
  const secs = Math.max(0, Math.ceil(p.resetsAt - Date.now()/1000));
  const h = Math.floor(secs/3600), m = Math.floor(secs%3600/60), s = secs%60;
  $('countdown').textContent = `${h.toString().padStart(2,'0')}:${m.toString().padStart(2,'0')}:${s.toString().padStart(2,'0')}`;
  $('reset-tag').textContent = t(secs ? '重置' : '待刷新');
}
function renderPhrase() {
  const list = current?.settings?.phrases || ['Tibo 义父，reset please……'];
  const source = list[Math.max(0, phraseIndex)] || '';
  // A custom phrase remains user content, even if one line matches a stock phrase.
  $('phrase').textContent = i18n?.isDefaultPhrases?.(list) ? t(source) : source;
  fitPhraseText();
}
function nextPhrase() { const list = current?.settings?.phrases || ['Tibo 义父，reset please……']; phraseIndex = (phraseIndex + 1) % list.length; renderPhrase(); }
function visibleBubblePages(settings = current?.settings || {}) {
  const order = [...new Set([...(Array.isArray(settings.bubblePageOrder) ? settings.bubblePageOrder : []),...modes])].filter(id => modes.includes(id));
  const visible = order.filter(id => !settings.bubbleHiddenPages?.includes(id));
  return visible.length ? visible : ['quota'];
}
function defaultBubblePage(settings = current?.settings || {}) {
  const visible = visibleBubblePages(settings), selected = settings.defaultBubblePage || settings.mode;
  return visible.includes(selected) ? selected : visible[0];
}
function bubblePageName(id) {
  return t(({quota:'额度',conversation:'对话状态',accounts:'账号管理',today:'今日',week:'本周',lastTurn:'用量',phrase:'女仆'})[id] || '内容');
}
function updatePageNavigation() {
  const visible = visibleBubblePages(), index = visible.indexOf(mode), disabled = visible.length < 2;
  for (const [id, direction, label] of [['previous-page', -1, '上一页'], ['next-page', 1, '下一页']]) {
    const button = $(id), target = visible[((index < 0 ? 0 : index) + direction + visible.length) % visible.length];
    button.disabled = disabled;
    button.setAttribute('aria-disabled', String(disabled));
    button.title = disabled ? t('{page}（仅一页）', {page:t(label)}) : t('{page}：{target}', {page:t(label), target:bubblePageName(target)});
    button.setAttribute('aria-label', button.title);
  }
}
function navigateBubblePage(direction) {
  const visible = visibleBubblePages();
  if (visible.length < 2) return;
  const index = visible.indexOf(mode);
  setMode(index < 0 ? defaultBubblePage() : visible[(index + direction + visible.length) % visible.length]);
}
function setMode(value, persist = true) {
  conversationRequest++; conversationPending = false;
  mode = visibleBubblePages().includes(value) ? value : defaultBubblePage();
  conversationVisible = mode === 'conversation';
  $('conversation-view').setAttribute('aria-busy', 'false');
  for (const item of modes) $(item+'-view').hidden = mode !== item;
  fitTokenLabels();
  $('bubble-label').textContent = bubblePageName(mode);
  $('bubble').setAttribute('aria-label', t('Codex {page}气泡', {page:$('bubble-label').textContent}));
  updatePageNavigation();
  if (mode === 'phrase') nextPhrase();
  if (conversationVisible) {
    renderConversation(null);
    $('conversation-feedback').textContent = t('点击气泡读取或刷新');
    $('bubble').title = t('点击气泡刷新对话状态；使用左右箭头翻页');
  }
  if (persist) {
    const generation = ++modeWriteGeneration;
    modeWritePending = generation;
    Promise.resolve(window.maid.setSettings({mode})).then(value => {
      if (generation !== modeWriteGeneration) return;
      if (Number.isSafeInteger(value?.settingsRevision)) lastSettingsRevision = Math.max(lastSettingsRevision, value.settingsRevision);
      modeWritePending = 0;
    }).catch(() => { if (generation === modeWriteGeneration) { modeWritePending = 0; notice('页面偏好暂未保存，请重试'); } });
  }
  reveal();
  // Reading is an explicit page-entry action. Restoring a default page or
  // applying an ordinary state update must never start a background query.
  if (conversationVisible && persist) void inspectConversation();
  if (mode === 'accounts') {
    $('bubble').title = t('本机历史账号 · 五小时周期推算；点击刷新，使用左右箭头翻页');
    updateAccountTimers();
    if (persist) void refreshAccounts();
  }
}
function renderConversation(result, loading = false) {
  lastConversationResult = result; lastConversationLoading = loading;
  if (result?.selectionMode === 'auto' || result?.selectionMode === 'manual') conversationSelectionMode = result.selectionMode;
  const automatic = conversationSelectionMode === 'auto', unknown = automatic && result?.status !== 'ready';
  const heading = t(automatic ? unknown ? '对话状态' : '当前对话' : '所选对话');
  $('bubble-label').textContent = heading;
  $('bubble').setAttribute('aria-label', t('Codex {page}气泡', {page:heading}));
  $('context-track').setAttribute('aria-label', t('{heading}上下文使用进度', {heading}));
  const targetReady = !loading && !unknown && result?.status === 'ready';
  const targetTitle = targetReady && typeof result.targetTitle === 'string' ? result.targetTitle.trim() : '';
  const targetProject = targetReady && typeof result.targetProject === 'string' ? result.targetProject.trim() : '';
  const targetProjectDetail = targetReady && typeof result.targetProjectDetail === 'string' ? result.targetProjectDetail.trim() : '';
  const select = $('conversation-select'), automaticOption = select.querySelector('option[value="@auto"]');
  if (automaticOption) automaticOption.textContent = automatic && targetReady && targetTitle ? t('自动识别当前对话（{title}）', {title:targetTitle}) : t('自动识别当前对话');
  const project = $('conversation-project');
  project.textContent = loading ? t('项目：读取中…') : targetReady ? t('项目：{project}', {project:targetProject || t('暂无本地项目')}) : t('项目：未识别');
  project.title = targetReady ? [targetProject, targetProjectDetail].filter(Boolean).join('\n') : '';
  select.title = targetReady ? [targetTitle, targetProject ? t('项目：{project}', {project:targetProject}) : t('暂无本地项目'), targetProjectDetail].filter(Boolean).join('\n') : t('选择要查看的对话');
  const context = result?.context, git = result?.git, compaction = result?.compaction;
  const contextReady = !unknown && context?.status === 'ready' && Number.isFinite(context.percent) && context.percent >= 0 && Number.isFinite(context.usedTokens) && context.usedTokens >= 0 && Number.isFinite(context.windowTokens) && context.windowTokens > 0;
  const gitReady = !unknown && git?.status === 'ready' && Number.isSafeInteger(git.count) && git.count >= 0;
  const contextLabel = $('context-progress'), gitLabel = $('git-count'), track = $('context-track');
  contextLabel.textContent = loading ? '--' : contextReady ? `${Number(context.percent.toFixed(1))}%` : t('暂无数据');
  contextLabel.classList.toggle('unavailable', !contextReady);
  contextLabel.title = !loading && contextReady ? `${tokenInteger.format(context.usedTokens)} / ${tokenInteger.format(context.windowTokens)} tokens` : '';
  const percent = !loading && contextReady ? Math.min(100, context.percent) : 0;
  $('context-bar').style.width = `${percent}%`;
  if (!loading && contextReady) track.setAttribute('aria-valuenow', String(percent)); else track.removeAttribute('aria-valuenow');
  track.setAttribute('aria-valuetext', loading ? t('读取中') : contextReady ? t('{percent}，{tokens}', {percent:contextLabel.textContent, tokens:contextLabel.title}) : t('暂无上下文数据'));
  gitLabel.textContent = loading ? '--' : gitReady ? compact(git.count) : t(!unknown && git?.status === 'not-repository' ? '非 Git 工作区' : !unknown && git?.status === 'timeout' ? '读取超时' : '暂无数据');
  gitLabel.classList.toggle('unavailable', !gitReady);
  gitLabel.title = !loading && gitReady ? t('{count} 个未提交文件', {count:tokenInteger.format(git.count)}) : '';
  const compactionReady = !unknown && compaction?.status === 'ready' && Number.isSafeInteger(compaction.count) && compaction.count >= 0 && typeof compaction.complete === 'boolean';
  const compactionLabel = $('compaction-count');
  compactionLabel.textContent = loading ? '--' : compactionReady ? t('{count} 次', {count:`${compaction.complete ? '' : '≥'}${tokenInteger.format(compaction.count)}`}) : t('暂无数据');
  compactionLabel.classList.toggle('unavailable', !compactionReady);
  compactionLabel.title = t('当前对话本地记录；自动与手动压缩合计') + (!loading && compactionReady && !compaction.complete
    ? compaction.incompleteReason === 'legacy-records' ? '\n' + t('部分旧记录无法确认，仅显示已确认次数')
      : '\n' + t('已发现至少{count}次，历史记录尚未统计完，点击继续读取', {count:tokenInteger.format(compaction.count)}) : '');
  $('conversation-feedback').textContent = t(loading ? '读取中…' : unknown ? '未识别当前对话，可手动选择' : contextReady && (gitReady || git?.status === 'not-repository') ? '点击气泡刷新' : '暂无数据，可点击气泡重试');
  // Backend reasons are deliberately not rendered: they may contain local paths.
}
function populateConversationChoices(list) {
  lastConversationChoices = list;
  const select = $('conversation-select');
  const threads = Array.isArray(list?.threads) ? list.threads.filter(thread => typeof thread?.id === 'string' && thread.id).slice(0, 30) : [];
  const titles = threads.map(thread => typeof thread.title === 'string' && thread.title.trim() ? thread.title.trim() : t('未命名对话'));
  select.replaceChildren();
  const automatic = document.createElement('option'); automatic.value = '@auto'; automatic.textContent = t('自动识别当前对话'); select.append(automatic);
  const prompt = document.createElement('option'); prompt.value = ''; prompt.disabled = true; prompt.textContent = t(threads.length ? '请选择对话' : '暂无本地对话'); select.append(prompt);
  for (const [index, thread] of threads.entries()) {
    const option = document.createElement('option'); option.value = thread.id;
    const title = titles[index];
    const project = typeof thread.workspaceLabel === 'string' && thread.workspaceLabel.trim() ? thread.workspaceLabel.trim() : t('暂无本地项目');
    option.textContent = `${title} · ${project}`;
    option.title = option.textContent;
    select.append(option);
  }
  conversationSelectionMode = list?.selectionMode === 'manual' ? 'manual' : 'auto';
  select.value = conversationSelectionMode === 'auto' ? '@auto' : threads.some(thread => thread.id === list?.selectedId) ? list.selectedId : '';
  return select.value;
}
async function inspectConversation(selectedId) {
  if (!conversationVisible || conversationPending) return;
  reveal();
  const request = ++conversationRequest;
  conversationPending = true;
  if (selectedId === null) conversationSelectionMode = 'auto';
  else if (typeof selectedId === 'string' && selectedId) conversationSelectionMode = 'manual';
  $('bubble').title = t('点击气泡刷新对话状态；使用左右箭头翻页');
  const view = $('conversation-view');
  const select = $('conversation-select');
  view.setAttribute('aria-busy', 'true');
  select.disabled = true;
  renderConversation(null, true);
  try {
    if (selectedId === null || typeof selectedId === 'string' && selectedId) {
      await window.maid.selectConversation(selectedId);
    } else {
      const list = await window.maid.listConversations();
      if (request !== conversationRequest || !conversationVisible) return;
      selectedId = populateConversationChoices(list);
      renderConversation(null, true);
    }
    if (request !== conversationRequest || !conversationVisible) return;
    if (conversationSelectionMode === 'manual' && !selectedId) {
      renderConversation(null);
      $('conversation-feedback').textContent = t(select.options.length > 2 ? '请选择要查看的对话' : '暂无本地对话');
      return;
    }
    const result = await window.maid.inspectConversation();
    if (request === conversationRequest && conversationVisible) renderConversation(result);
  } catch {
    if (request === conversationRequest && conversationVisible) renderConversation(null);
  } finally {
    if (request === conversationRequest) {
      conversationPending = false; view.setAttribute('aria-busy', 'false'); select.disabled = false;
      if (conversationVisible) reveal();
    }
  }
}
function accountElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) { element.textContent = t(text); element.dataset.i18n = text; }
  return element;
}
function accountDisplayLabel(account, automatic = false) {
  const supplied = automatic ? account.autoLabel : account.label;
  const text = typeof supplied === 'string' ? supplied.trim() : '';
  if (!automatic && (account.userEdited === true || account.labelSource === 'manual') && text) return text;
  const nickname = typeof account.profileNickname === 'string' ? account.profileNickname.trim() : '';
  const workspace = typeof account.workspaceName === 'string' ? account.workspaceName.trim() : '';
  const scope = ['个人','工作空间'].includes(account.scopeLabel) ? account.scopeLabel : '';
  if (locale() === 'en') {
    const ordinal = /^昵称未读取 (\d+)/.exec(text)?.[1];
    const automaticName = nickname || (ordinal ? t('昵称未读取 {number}', {number:ordinal}) : t('昵称未读取'));
    return [automaticName, workspace || t(scope)].filter(Boolean).join(' · ');
  }
  if (nickname) return text === nickname || text.startsWith(nickname + ' · ') ? text : [nickname, workspace || scope].filter(Boolean).join(' · ');
  if (text.startsWith('昵称未读取') && (account.labelSource === 'fallback' || automatic)) return text;
  return ['昵称未读取', workspace || scope].filter(Boolean).join(' · ');
}
function accountFeedback(message) {
  clearTimeout(accountFeedbackTimer);
  accountFeedbackSource = message;
  $('accounts-feedback').textContent = t(message);
  accountFeedbackTimer = setTimeout(() => { accountFeedbackSource = '本机记录推算 · 历史账号需登录确认'; $('accounts-feedback').textContent = t(accountFeedbackSource); }, 6000);
}
function closeAccountEditor(entry) {
  entry.editor.hidden = true; entry.confirm.hidden = true; entry.actions.hidden = false;
}
async function accountAction(entry, action) {
  if (entry.busy) return false;
  entry.busy = true;
  for (const button of entry.card.querySelectorAll('button')) button.disabled = true;
  const request = ++accountRequest;
  try {
    const result = await action();
    if (request === accountRequest) renderAccounts(result?.accountManagement || result);
    return true;
  } catch {
    accountFeedback('操作未完成，请重试。');
    return false;
  } finally {
    entry.busy = false;
    for (const button of entry.card.querySelectorAll('button')) button.disabled = false;
  }
}
function createAccountCard(account) {
  const card = accountElement('article', 'account-card');
  const heading = accountElement('div', 'account-heading');
  const name = accountElement('strong', 'account-name');
  const badge = accountElement('span', 'account-badge');
  const actions = accountElement('span', 'account-actions');
  const rename = accountElement('button', '', '改名'), remove = accountElement('button', '', '移除');
  rename.type = remove.type = 'button'; actions.append(rename, remove); heading.append(name, badge, actions);
  const plan = accountElement('div', 'account-plan');
  const track = accountElement('div', 'account-track'), bar = accountElement('span');
  track.setAttribute('role', 'progressbar'); track.setAttribute('aria-valuemin', '0'); track.setAttribute('aria-valuemax', '100'); track.append(bar);
  const countdown = accountElement('div', 'account-countdown');
  const reset = accountElement('div', 'account-detail'), remaining = accountElement('div', 'account-detail');
  const editor = accountElement('form', 'account-editor'); editor.hidden = true;
  const input = accountElement('input'); input.type = 'text'; input.maxLength = 64; input.dataset.i18nAriaLabel = '本机账号别名'; input.dataset.i18nTitle = '本机别名最多 32 字；清空后保存可恢复自动名称。'; input.setAttribute('aria-label', t('本机账号别名')); input.title = t('本机别名最多 32 字；清空后保存可恢复自动名称。');
  const save = accountElement('button', '', '保存'), cancel = accountElement('button', '', '取消'); save.type = 'submit'; cancel.type = 'button';
  editor.append(input, save, cancel, accountElement('small', 'account-editor-hint', '清空后保存，恢复自动名称'));
  const confirm = accountElement('div', 'account-confirm'); confirm.hidden = true;
  const confirmRemove = accountElement('button', '', '确认移除'), cancelRemove = accountElement('button', '', '取消');
  confirmRemove.type = cancelRemove.type = 'button';
  confirm.append(accountElement('span', '', '下次登录会再次记录'), confirmRemove, cancelRemove);
  card.append(heading, plan, editor, confirm, track, countdown, reset, remaining);
  const entry = {card, name, badge, plan, actions, track, bar, countdown, reset, remaining, editor, input, confirm, account, busy: false};
  rename.addEventListener('click', () => {
    closeAccountEditor(entry); actions.hidden = true; editor.hidden = false;
    input.value = entry.account.userEdited === true || entry.account.labelSource === 'manual' ? entry.account.label : '';
    input.placeholder = accountDisplayLabel(entry.account, true);
    input.focus(); input.select(); clearTimeout(hideTimer);
  });
  cancel.addEventListener('click', () => { closeAccountEditor(entry); rename.focus(); reveal(); });
  editor.addEventListener('submit', async event => {
    event.preventDefault();
    const label = input.value.trim();
    if (await accountAction(entry, () => window.maid.renameAccount(entry.account.id, label))) {
      closeAccountEditor(entry); rename.focus(); accountFeedback(label ? '本机账号别名已保存。' : '已恢复自动名称。'); reveal();
    }
  });
  input.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !entry.busy) { closeAccountEditor(entry); rename.focus(); reveal(); }
  });
  remove.addEventListener('click', () => {
    closeAccountEditor(entry); actions.hidden = true; confirm.hidden = false; cancelRemove.focus(); clearTimeout(hideTimer);
  });
  cancelRemove.addEventListener('click', () => { closeAccountEditor(entry); remove.focus(); reveal(); });
  confirmRemove.addEventListener('click', async () => {
    if (await accountAction(entry, () => window.maid.removeAccount(entry.account.id))) {
      accountFeedback('已移除本机记录，下次登录会再次记录。'); $('account-list').focus(); reveal();
    }
  });
  return entry;
}
function renderAccounts(value) {
  if (!Array.isArray(value?.accounts)) return;
  ++accountRequest;
  const accounts = value.accounts.filter(account => typeof account?.id === 'string' && account.id).slice(0, 100);
  const ids = new Set(accounts.map(account => account.id));
  for (const [id, entry] of accountCards) {
    if (!ids.has(id)) { entry.card.remove(); accountCards.delete(id); }
  }
  for (const [index, account] of accounts.entries()) {
    let entry = accountCards.get(account.id);
    if (!entry) { entry = createAccountCard(account); accountCards.set(account.id, entry); }
    entry.account = account;
    // Updating the automatic hint must never replace an in-progress user edit.
    entry.input.placeholder = accountDisplayLabel(account, true);
    entry.name.textContent = accountDisplayLabel(account);
    entry.badge.textContent = t(account.current ? '当前' : '历史');
    const planLabel = t(account.planLabel || ({free:'Free',go:'Go',plus:'Plus',pro:'Pro',team:'Team',business:'Business',enterprise:'Enterprise',edu:'Education',education:'Education'})[account.planType] || '未知套餐');
    const scopeLabel = t(account.scopeLabel || '未知范围');
    const displayName = typeof account.displayName === 'string' ? account.displayName.trim() : '';
    const profileNickname = typeof account.profileNickname === 'string' ? account.profileNickname.trim() : '';
    const email = typeof account.email === 'string' ? account.email.trim() : '';
    const workspaceName = typeof account.workspaceName === 'string' ? account.workspaceName.trim() : '';
    entry.plan.textContent = `${planLabel} · ${scopeLabel}${workspaceName ? ` · ${workspaceName}` : ''}`;
    const workspaceDetail = workspaceName ? t('工作空间名称：{name}', {name:workspaceName}) : account.scopeLabel === '工作空间' ? t('工作空间名称：未读取') : '';
    entry.name.title = [entry.name.textContent, t('资料昵称：{name}', {name:profileNickname || t('未读取')}), displayName ? t('账户资料名称：{name}', {name:displayName}) : '', email ? t('邮箱：{email}', {email}) : '', `${planLabel} · ${scopeLabel}`, workspaceDetail].filter(Boolean).join('\n');
    entry.plan.title = entry.name.title;
    entry.card.classList.toggle('current-account', account.current === true);
    entry.track.setAttribute('aria-label', t('{name}五小时周期进度', {name:entry.name.textContent}));
    const node = $('account-list').children[index];
    if (node !== entry.card) $('account-list').insertBefore(entry.card, node || null);
  }
  $('accounts-empty').hidden = accounts.length > 0;
  $('accounts-empty').textContent = t(value.storageError ? '本机账号记录暂不可用，原文件已保留。' : '登录账号并读取额度后，自动记录在这里。');
  $('account-list').hidden = !accounts.length;
  updateAccountTimers();
}
function updateAccountTimers() {
  const now = Date.now() / 1000;
  for (const entry of accountCards.values()) {
    const account = entry.account, known = Number.isFinite(account.resetsAt) && account.resetsAt > 0;
    const seconds = known ? Math.max(0, Math.ceil(account.resetsAt - now)) : null;
    const progress = known ? Math.max(0, Math.min(100, (now - (account.resetsAt - 18000)) / 180)) : 0;
    entry.bar.style.width = `${progress}%`;
    if (known) entry.track.setAttribute('aria-valuenow', String(Math.round(progress))); else entry.track.removeAttribute('aria-valuenow');
    entry.track.setAttribute('aria-valuetext', known ? t('五小时周期已过 {percent}%', {percent:Math.round(progress)}) : t('重置时间未知'));
    entry.countdown.textContent = !known ? t('五小时重置时间未知') : seconds === 0 ? t('预计已重置，待登录确认')
      : t('距重置 {time}', {time:`${Math.floor(seconds / 3600).toString().padStart(2, '0')}:${Math.floor(seconds % 3600 / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`});
    entry.reset.textContent = known ? t('预计 {time} 重置', {time:new Date(account.resetsAt * 1000).toLocaleString(locale(), {month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false})}) : t('读取此账号额度后才能推算');
    const remaining = Number.isFinite(account.remainingPercent) ? `${Number(account.remainingPercent.toFixed(1))}%` : '--';
    entry.remaining.textContent = t('上次剩余 {remaining} · {window}', {remaining, window:t(known ? '五小时周期' : '暂无五小时记录')});
    entry.remaining.title = Number.isFinite(account.observedAt) ? t('最近观察：{time}', {time:new Date(account.observedAt * 1000).toLocaleString(locale())}) : t('尚无额度观察记录');
  }
}
async function refreshAccounts() {
  const request = ++accountRequest;
  try {
    const result = await window.maid.listAccounts();
    if (request === accountRequest) renderAccounts(result?.accountManagement || result);
  } catch { if (request === accountRequest) accountFeedback('本机账号记录读取失败，请刷新重试。'); }
}
function handleAccountReset(value) {
  if (!value || typeof value.id !== 'string' || current?.settings.accountResetAlerts === false) return;
  const key = `${value.id}:${Number.isFinite(value.resetsAt) ? value.resetsAt : Math.floor(Date.now() / 60000)}`;
  if (accountResetEvents.has(key)) return;
  accountResetEvents.set(key, true);
  if (accountResetEvents.size > 200) accountResetEvents.delete(accountResetEvents.keys().next().value);
  const name = Array.from(typeof value.label === 'string' && value.label.trim() ? value.label.trim() : t('账号'));
  const shortName = name.length > 48 ? name.slice(0, 47).join('') + '…' : name.join('');
  notice(t('{name}的五小时额度预计已重置，请登录确认。', {name:shortName}));
  accountAlarmBounce();
  updateAccountTimers();
}
function reveal() {
  clearTimeout(hideTimer);
  const enabled = current?.settings.showBubble !== false;
  setBubbleVisible(enabled);
  if (enabled && current?.settings.autoHideSeconds) hideTimer = setTimeout(() => setBubbleVisible(false), current.settings.autoHideSeconds * 1000);
}
function setBubbleVisible(visible) {
  $('bubble').classList.toggle('hidden-bubble', !visible);
  $('bubble').inert = !visible;
  $('bubble').setAttribute('aria-hidden', String(!visible));
  document.querySelectorAll('.thought-dot').forEach(el => el.classList.toggle('hidden-dots', !visible));
}
function notice(message) { clearTimeout(noticeTimer); $('notice').textContent = t(message); $('notice').hidden = false; noticeTimer = setTimeout(() => $('notice').hidden = true, 5000); }
let audio;
let interactionHeld = false, interactionPressedAt = 0, interactionWasMoving = false;
const interactionSound = window.MaidInteractionAudio.create({ samples: window.MaidInteractionAudio.withLocalSamples(window.MaidInteractionSamples, window.MaidLocalInteractionSamples), enabled: () => current?.settings.sound === true, preset: () => current?.settings.interactionSound || window.MaidInteractionSamples.defaultId });
function pressInteraction(withSound = true) {
  if (interactionHeld) return false;
  interactionHeld = true; interactionPressedAt = performance.now();
  interactionWasMoving = [$('character'), $('bubble-motion')].some(element => element.getAnimations().some(animation => animation.transitionProperty === 'transform'));
  // Transitions retarget the currently displayed pose. Never clear to the rest
  // pose on pointerdown; that used to cut every rapid click short.
  for (const id of ['character', 'bubble-motion']) $(id).classList.remove('account-alarm-bounce');
  if (current?.visualPose?.moving !== true) {
    for (const id of ['character', 'bubble-motion']) $(id).classList.add('interaction-pressed');
    void $('character').offsetWidth; void $('bubble-motion').offsetWidth;
  }
  if (withSound) interactionSound.press();
  reveal();
  return true;
}
function releaseInteraction(withSound = true) {
  if (!interactionHeld) return;
  interactionHeld = false;
  const elements = [$('character'), $('bubble-motion')];
  // Like DSH, commit a same-frame tap before returning to rest. During an
  // existing rebound retain its displayed pose instead of snapping to squish.
  if (!interactionWasMoving && performance.now() - interactionPressedAt < 32 && current?.visualPose?.moving !== true) {
    for (const element of elements) element.style.transition = 'none';
    for (const element of elements) void element.offsetWidth;
    for (const element of elements) element.style.transition = '';
    for (const element of elements) void element.offsetWidth;
  }
  for (const element of elements) element.classList.remove('interaction-pressed');
  if (withSound) interactionSound.release();
}
function startBounce(className) {
  clearBounce();
  if (current?.visualPose?.moving !== true) {
    void $('character').offsetWidth;
    $('character').classList.add(className); $('bubble-motion').classList.add(className);
  }
  reveal();
}
function bounce(withSound = true) { if (interactionHeld) { reveal(); return; } pressInteraction(withSound); releaseInteraction(withSound); }
function accountAlarmBounce() { startBounce('account-alarm-bounce'); playBounceSound(); }
function playBounceSound() {
  if (current?.settings.sound) {
    try {
      audio ||= new AudioContext(); audio.resume();
      const oscillator = audio.createOscillator(), gain = audio.createGain(), now = audio.currentTime;
      oscillator.connect(gain); gain.connect(audio.destination);
      oscillator.frequency.setValueAtTime(730,now);
      oscillator.frequency.exponentialRampToValueAtTime(1050,now+.1);
      gain.gain.setValueAtTime(.001,now);
      gain.gain.exponentialRampToValueAtTime(.18,now+.012);
      gain.gain.exponentialRampToValueAtTime(.001,now+.20);
      oscillator.start(); oscillator.stop(now+.22);
    } catch {}
  }
}
function render(value) {
  const initial = !current;
  const revision = Number.isSafeInteger(value.settingsRevision) ? value.settingsRevision : null;
  const olderSettings = revision !== null && revision < lastSettingsRevision;
  if (olderSettings && current) value = { ...value, settings: current.settings };
  if (revision !== null) lastSettingsRevision = Math.max(lastSettingsRevision, revision);
  const characterChanged = initial || value.characterUrl !== current.characterUrl;
  const bubbleChanged = initial || value.settings.showBubble !== current.settings.showBubble || value.settings.autoHideSeconds !== current.settings.autoHideSeconds;
  const phrasesChanged = initial || value.settings.phrases.length !== current.settings.phrases.length || value.settings.phrases.some((phrase, index) => phrase !== current.settings.phrases[index]);
  const modeChanged = initial || (!modeWritePending && !olderSettings && current.settings.mode !== value.settings.mode);
  const soundChanged = initial || value.settings.interactionSound !== current.settings.interactionSound;
  const languageChanged = initial || i18n?.normalizeLocale(value.settings.language) !== locale();
  if (languageChanged) {
    i18n?.setLocale(value.settings.language);
    tokenCompact = new Intl.NumberFormat(locale(), { notation:'compact', minimumSignificantDigits:5, maximumSignificantDigits:5 });
    tokenInteger = new Intl.NumberFormat(locale(), { maximumFractionDigits:0 });
    $('accounts-feedback').textContent = t(accountFeedbackSource);
    if (!Array.isArray(value.accountManagement?.accounts)) $('accounts-empty').textContent = t('登录账号并读取额度后，自动记录在这里。');
  }
  current = value;
  if (soundChanged) interactionSound.stop();
  if (!value.settings.sound) interactionSound.stop();
  else if (soundChanged) interactionSound.prepare();
  if (characterChanged) void matchCharacterTheme(value);
  if (phrasesChanged) phraseIndex = -1;
  if (modeChanged) setMode(initial ? defaultBubblePage(value.settings) : value.settings.mode, false);
  else if (!visibleBubblePages().includes(mode)) setMode(defaultBubblePage(), false);
  else if (phrasesChanged && mode === 'phrase') nextPhrase();
  if (languageChanged && !modeChanged) {
    $('bubble-label').textContent = bubblePageName(mode);
    $('bubble').setAttribute('aria-label', t('Codex {page}气泡', {page:$('bubble-label').textContent}));
    if (mode === 'phrase') renderPhrase();
    if (conversationVisible) {
      if (lastConversationChoices) {
        const selected = $('conversation-select').value, selectionMode = conversationSelectionMode;
        populateConversationChoices(lastConversationChoices);
        $('conversation-select').value = selected; conversationSelectionMode = selectionMode;
      }
      renderConversation(lastConversationResult, lastConversationLoading);
      $('bubble').title = t('点击气泡刷新对话状态；使用左右箭头翻页');
    }
    if (mode === 'accounts') $('bubble').title = t('本机历史账号 · 五小时周期推算；点击刷新，使用左右箭头翻页');
  }
  updatePageNavigation();
  if ($('maid-image').src !== value.characterUrl) $('maid-image').src = value.characterUrl;
  $('maid-image').alt = value.characterName || t('桌面女仆形象');
  $('widget').classList.toggle('is-mirrored', value.settings.mirror);
  mirrorFlip?.setMirrored(value.settings.mirror, { initial });
  $('widget').classList.toggle('is-corner-peeking', value.cornerDock?.peeking === true);
  applyVisualPose(value);
  $('demo-label').hidden = !value.demo;
  const data = value.snapshot, bucket = selectedBucket(), p = bucket?.primary, s = bucket?.secondary;
  roll(p?.remainingPercent);
  $('primary-bar').style.width = (Number.isFinite(p?.remainingPercent) ? p.remainingPercent : 0)+'%';
  $('primary-label').textContent = windowName(p?.windowDurationMins);
  $('secondary').textContent = s ? `${windowName(s.windowDurationMins)} ${s.remainingPercent ?? '--'}%` : t('无第二窗口');
  $('bubble').classList.toggle('warning', Number.isFinite(p?.remainingPercent) && p.remainingPercent < 20);
  const disconnected = !p || !!data.stale || !['live','demo','partial'].includes(data.status);
  $('bubble').classList.toggle('disconnected', disconnected);
  document.querySelector('.headline').classList.toggle('quota-shimmer', Number.isFinite(p?.remainingPercent) && !disconnected);
  $('connection').className = 'connection ' + (['live','demo'].includes(data.status) ? 'live' : 'offline');
  const time = data.updatedAt ? new Date(data.updatedAt).toLocaleTimeString(locale(),{hour:'2-digit',minute:'2-digit'}) : '';
  const statusText = value.demo ? t('演示数据 · 不代表真实账户') : data.stale ? t('连接异常 · 显示 {time} 的上次额度', {time}) : t(data.error || (data.status === 'connecting' ? '正在连接本机 Codex…' : t('每 {seconds} 秒自动刷新 · {time} 更新', {seconds:value.settings.refreshSeconds, time})));
  $('connection').title = statusText;
  $('connection').setAttribute('aria-label',statusText);
  if (!conversationVisible && mode !== 'accounts') $('bubble').title = statusText + '\n' + t('点击刷新，按住拖动；使用左右箭头切换内容');
  renderAccounts(value.accountManagement);
  renderTokens('today-tokens', data.today?.tokens);
  $('today-detail').textContent = t(data.today ? data.today.complete === false ? '本机部分记录 · 含本机各账号' : '本机日志 · 含本机各账号' : '暂未取得用量数据');
  renderTokens('week-tokens', data.weekly?.tokens);
  $('week-detail').textContent = t(data.weekly ? data.weekly.complete === false ? '周一至今 · 本机部分记录汇总' : '周一至今 · 本机记录汇总' : '周一至今 · 暂未取得用量数据');
  $('week-view').title = t('按本地时间周一零点至今，汇总这台设备上各账号的日志记录；切换账号不清零。');
  renderTokens('last-tokens', data.lastTurn?.tokens);
  fitTokenLabels();
  fitPhraseText();
  $('last-detail').textContent = t(data.lastTurn ? '本机最近一轮 · 非金额账单' : '完成对话后在这里查看');
  if (data.accountChanged) initializedTurn = false;
  if (initializedTurn && data.lastTurn?.timestamp && data.lastTurn.timestamp !== lastTurnTimestamp) { notice(t('最近一轮消耗 {tokens} tokens', {tokens:compact(data.lastTurn.tokens)})); bounce(); }
  if (data.status !== 'connecting') { lastTurnTimestamp = data.lastTurn?.timestamp || null; initializedTurn = true; }
  countdown(); if (bubbleChanged || characterChanged) reveal();
}
async function doRefresh() { $('refresh').animate([{rotate:'0deg'},{rotate:'360deg'}], {duration:650}); await window.maid.refresh(); if (current?.snapshot.error) notice(current.snapshot.error); else reveal(); }
$('refresh').addEventListener('click', doRefresh);
$('conversation-select').addEventListener('change', () => inspectConversation($('conversation-select').value === '@auto' ? null : $('conversation-select').value));
$('conversation-select').addEventListener('focus', () => clearTimeout(hideTimer));
$('conversation-select').addEventListener('blur', reveal);
$('account-list').addEventListener('focusin', () => clearTimeout(hideTimer));
$('account-list').addEventListener('focusout', event => { if (!$('account-list').contains(event.relatedTarget)) reveal(); });
$('account-list').addEventListener('pointerenter', () => clearTimeout(hideTimer));
$('account-list').addEventListener('pointerleave', () => { if (!$('account-list').contains(document.activeElement)) reveal(); });
for (const [id, direction] of [['previous-page', -1], ['next-page', 1]]) {
  $(id).addEventListener('click', event => { event.stopPropagation(); navigateBubblePage(direction); });
}
let talkPointer = null;
$('talk').addEventListener('pointerdown', event => { if (event.button === 0 && talkPointer === null && pressInteraction()) { talkPointer = event.pointerId; $('talk').setPointerCapture(event.pointerId); } });
$('talk').addEventListener('pointerup', event => { if (event.button === 0 && talkPointer === event.pointerId) { talkPointer = null; releaseInteraction(); } });
function cancelTalkPointer() { if (talkPointer !== null) { talkPointer = null; releaseInteraction(); clearBounceMotion(); } }
$('talk').addEventListener('pointercancel', cancelTalkPointer);
$('talk').addEventListener('lostpointercapture', cancelTalkPointer);
window.addEventListener('blur', cancelTalkPointer);
$('talk').addEventListener('click', event => { if(!visibleBubblePages().includes('phrase')) notice('台词页已隐藏，可在设置中开启'); else if(mode === 'phrase' && !conversationVisible) nextPhrase(); else setMode('phrase'); if (event.detail === 0) bounce(); });
$('settings').addEventListener('click', () => window.maid.action('settings'));
$('hide').addEventListener('click', () => window.maid.action('hide'));
document.addEventListener('contextmenu', e => { e.preventDefault(); window.maid.action('settings'); });
let interactionKey = null;
document.addEventListener('keydown', e => { if(e.target.closest('select,input,textarea,button')) return; if(e.key.toLowerCase() === 'q' || e.key === ' ' || (e.key === 'Enter' && e.target === $('character'))) { e.preventDefault(); if (!e.repeat && interactionKey === null && pressInteraction()) interactionKey = e.key.toLowerCase(); } });
document.addEventListener('keyup', e => { if (interactionKey !== null && e.key.toLowerCase() === interactionKey) { e.preventDefault(); interactionKey = null; releaseInteraction(); } });
window.addEventListener('blur', () => { interactionKey = null; releaseInteraction(); clearBounceMotion(); });
document.addEventListener('visibilitychange', () => { if (document.hidden) { interactionKey = null; clearBounce(); } });
$('character').addEventListener('animationend', event => {
  if (event.target !== $('character') || event.animationName !== 'accountAlarmCharacter') return;
  clearBounce();
});
$('character').addEventListener('transitionend', event => {
  if (event.target === $('character') && event.propertyName === 'transform' && !interactionHeld) $('widget').classList.remove('drag-interaction');
});
for (const target of [$('character'), $('bubble')]) {
  let start, moved = false;
  target.addEventListener('pointerdown', e => { if(e.button !== 0 || start || e.target.closest('button,select,option,input,form,.account-list')) return; start = {x:e.screenX,y:e.screenY,pointerId:e.pointerId,interaction:target.id === 'character' && pressInteraction()}; moved = false; target.setPointerCapture(e.pointerId); window.maid.drag('start'); });
  target.addEventListener('pointermove', e => { if(!start || start.pointerId !== e.pointerId) return; if(e.buttons === 0) { cancel(e); return; } if(Math.hypot(e.screenX-start.x,e.screenY-start.y)>4) { if(!moved) { if(start.interaction && interactionHeld) { $('widget').classList.add('drag-interaction'); for(const id of ['character','bubble-motion']) $(id).classList.add('interaction-pressed'); } clearBounceMotion(true); } moved=true; } if(moved) window.maid.drag('move'); });
  const finish = e => { if(!start || start.pointerId !== e.pointerId || e.button !== 0) return; const active=start; window.maid.drag('end'); start=null; if(active.interaction) releaseInteraction(); if(target.hasPointerCapture(e.pointerId)) target.releasePointerCapture(e.pointerId); if(!moved) { if(target.id === 'bubble') { if(conversationVisible) void inspectConversation(); else void doRefresh(); } else if(mode==='phrase') nextPhrase(); } };
  const cancel = e => { if(start && start.pointerId === e.pointerId) { const active=start; window.maid.drag('end'); start=null; if(active.interaction) releaseInteraction(); clearBounceMotion(); if(target.hasPointerCapture(e.pointerId)) target.releasePointerCapture(e.pointerId); } };
  target.addEventListener('pointerup', finish);
  target.addEventListener('pointercancel', cancel);
  target.addEventListener('lostpointercapture', cancel);
  window.addEventListener('blur', () => { if (start) cancel({pointerId:start.pointerId}); });
  document.addEventListener('visibilitychange', () => { if (document.hidden && start) cancel({pointerId:start.pointerId}); });
}
let toolbarHideTimer;
function updateToolbarPointer(inside) {
  if (inside) {
    clearTimeout(toolbarHideTimer); toolbarHideTimer = null;
    $('widget').classList.add('toolbar-open');
  } else if (!toolbarHideTimer && $('widget').classList.contains('toolbar-open')) {
    // Repeated movement outside must not postpone dismissal indefinitely.
    toolbarHideTimer = setTimeout(() => {
      toolbarHideTimer = null; $('widget').classList.remove('toolbar-open');
    }, 600);
  }
}
document.addEventListener('pointermove', e => {
  const el = document.elementFromPoint(e.clientX,e.clientY), inside = !!el?.closest('.interactive');
  updateToolbarPointer(inside); window.maid.pointerRegion(inside);
});
document.documentElement.addEventListener('pointerleave', () => { updateToolbarPointer(false); window.maid.pointerRegion(false); });
$('character').addEventListener('pointerenter', reveal);
const initialState = window.MaidPresence.connect(window.maid);
window.maid.onState(render); window.maid.onBounce(bounce); window.maid.onAccountReset?.(handleAccountReset); initialState.then(render);
setInterval(() => { countdown(); if (mode === 'accounts') updateAccountTimers(); },1000);
