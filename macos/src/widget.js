'use strict';
const $ = id => document.getElementById(id);
let current, mode = 'quota', hideTimer, noticeTimer, phraseIndex = -1, lastTurnTimestamp, initializedTurn = false;
let displayed = null, animationId;
const modes = ['quota','today','week','lastTurn','phrase'];
const motionPreference = matchMedia('(prefers-reduced-motion: reduce)');
function clearBounce() { $('character').classList.remove('bounce'); $('bubble-motion').classList.remove('bounce'); }
motionPreference.addEventListener('change', event => { if (event.matches) clearBounce(); });
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
  applyTheme(CharacterTheme.builtinTheme('mint-maid'), 'fallback', id);
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
  const fallback = value?.cornerDock?.peeking === true
    ? { x: value.cornerDock.corner === 'left' ? -48 : 48, y: 56 } : { x: 0, y: 0 };
  const pose = value?.visualPose;
  const offset = pose?.offset;
  const x = offset && Number.isFinite(offset.x) ? offset.x / scale : fallback.x;
  const y = offset && Number.isFinite(offset.y) ? offset.y / scale : fallback.y;
  $('widget').style.setProperty('--visual-offset-x', `${x}px`);
  $('widget').style.setProperty('--visual-offset-y', `${y}px`);
  $('widget').classList.toggle('is-moving', pose?.moving === true);
  if (pose?.moving === true) clearBounce();
}
function fit() { $('widget').style.transform = `scale(${innerWidth / 380})`; applyVisualPose(); fitTokenLabels(); fitPhraseText(); }
fit(); window.addEventListener('resize', fit);
const phraseResizeObserver = new ResizeObserver(fitPhraseText);
for (const element of [$('phrase-view'), ...$('phrase-view').children].filter(element => element.id !== 'phrase')) phraseResizeObserver.observe(element);
document.fonts.ready.then(fitPhraseText);
document.fonts.addEventListener('loadingdone', fitPhraseText);
const tokenCompact = new Intl.NumberFormat('zh-CN', { notation: 'compact', minimumSignificantDigits: 5, maximumSignificantDigits: 5 });
const tokenInteger = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 });
function compact(n) { return typeof n === 'number' && Number.isFinite(n) ? (Math.abs(n) >= 10000 ? tokenCompact : tokenInteger).format(n) : '--'; }
function renderTokens(id, value) {
  $(id).textContent = compact(value)+' tokens';
  $(id).title = typeof value === 'number' && Number.isFinite(value) ? tokenInteger.format(value)+' tokens' : '暂未取得用量数据';
}
function windowName(minutes) { return !minutes ? '当前窗口' : minutes >= 10080 ? '周额度' : minutes >= 1440 ? `${Math.round(minutes / 1440)}天额度` : `${minutes / 60}小时额度`; }
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
  $('reset-tag').textContent = secs ? '重置' : '待刷新';
}
function nextPhrase() { const list = current?.settings?.phrases || ['Tibo 义父，reset please……']; phraseIndex = (phraseIndex + 1) % list.length; $('phrase').textContent = list[phraseIndex]; fitPhraseText(); }
function setMode(value, persist = true) {
  mode = modes.includes(value) ? value : 'quota';
  for (const item of modes) $(item+'-view').hidden = mode !== item;
  fitTokenLabels();
  $('bubble-label').textContent = ({quota:'额度',today:'今日',week:'本周',lastTurn:'用量',phrase:'女仆'})[mode];
  if (mode === 'phrase') nextPhrase();
  if (persist) window.maid.setSettings({mode});
  reveal();
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
function notice(message) { clearTimeout(noticeTimer); $('notice').textContent = message; $('notice').hidden = false; noticeTimer = setTimeout(() => $('notice').hidden = true, 5000); }
let audio;
function bounce() {
  clearBounce();
  if (!motionPreference.matches && current?.visualPose?.moving !== true) {
    void $('character').offsetWidth;
    $('character').classList.add('bounce'); $('bubble-motion').classList.add('bounce');
  }
  reveal();
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
  const characterChanged = initial || value.characterUrl !== current.characterUrl;
  const bubbleChanged = initial || value.settings.showBubble !== current.settings.showBubble || value.settings.autoHideSeconds !== current.settings.autoHideSeconds;
  const phrasesChanged = initial || value.settings.phrases.length !== current.settings.phrases.length || value.settings.phrases.some((phrase, index) => phrase !== current.settings.phrases[index]);
  const modeChanged = initial || mode !== value.settings.mode;
  current = value;
  if (characterChanged) void matchCharacterTheme(value);
  if (phrasesChanged) phraseIndex = -1;
  if (modeChanged) setMode(value.settings.mode, false);
  else if (phrasesChanged && mode === 'phrase') nextPhrase();
  if ($('maid-image').src !== value.characterUrl) $('maid-image').src = value.characterUrl;
  $('maid-image').alt = value.characterName || '桌面女仆形象';
  $('widget').classList.toggle('is-mirrored', value.settings.mirror);
  $('widget').classList.toggle('is-corner-peeking', value.cornerDock?.peeking === true);
  applyVisualPose(value);
  $('demo-label').hidden = !value.demo;
  const data = value.snapshot, bucket = selectedBucket(), p = bucket?.primary, s = bucket?.secondary;
  roll(p?.remainingPercent);
  $('primary-bar').style.width = (Number.isFinite(p?.remainingPercent) ? p.remainingPercent : 0)+'%';
  $('primary-label').textContent = windowName(p?.windowDurationMins);
  $('secondary').textContent = s ? `${windowName(s.windowDurationMins)} ${s.remainingPercent ?? '--'}%` : '无第二窗口';
  $('bubble').classList.toggle('warning', Number.isFinite(p?.remainingPercent) && p.remainingPercent < 20);
  const disconnected = !p || !!data.stale || !['live','demo','partial'].includes(data.status);
  $('bubble').classList.toggle('disconnected', disconnected);
  document.querySelector('.headline').classList.toggle('quota-shimmer', Number.isFinite(p?.remainingPercent) && !disconnected);
  $('connection').className = 'connection ' + (['live','demo'].includes(data.status) ? 'live' : 'offline');
  const time = data.updatedAt ? new Date(data.updatedAt).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'}) : '';
  const statusText = value.demo ? '演示数据 · 不代表真实账户' : data.stale ? `连接异常 · 显示 ${time} 的上次额度` : data.error || (data.status === 'connecting' ? '正在连接本机 Codex…' : `每 ${value.settings.refreshSeconds} 秒自动刷新 · ${time} 更新`);
  $('connection').title = statusText;
  $('connection').setAttribute('aria-label',statusText);
  $('bubble').title = statusText + '\n点击刷新，按住拖动；··· 切换内容';
  renderTokens('today-tokens', data.today?.tokens);
  $('today-detail').textContent = data.today ? `本机${data.today.complete === false ? '部分记录' : '日志'} · 含本机各账号` : '暂未取得用量数据';
  renderTokens('week-tokens', data.weekly?.tokens);
  $('week-detail').textContent = data.weekly ? `周一至今 · 本机${data.weekly.complete === false ? '部分' : ''}记录汇总` : '周一至今 · 暂未取得用量数据';
  $('week-view').title = '按本地时间周一零点至今，汇总这台设备上各账号的日志记录；切换账号不清零。';
  renderTokens('last-tokens', data.lastTurn?.tokens);
  fitTokenLabels();
  fitPhraseText();
  $('last-detail').textContent = data.lastTurn ? '本机最近一轮 · 非金额账单' : '完成对话后在这里查看';
  if (data.accountChanged) initializedTurn = false;
  if (initializedTurn && data.lastTurn?.timestamp && data.lastTurn.timestamp !== lastTurnTimestamp) { notice(`最近一轮消耗 ${compact(data.lastTurn.tokens)} tokens`); bounce(); }
  if (data.status !== 'connecting') { lastTurnTimestamp = data.lastTurn?.timestamp || null; initializedTurn = true; }
  countdown(); if (bubbleChanged || characterChanged) reveal();
}
async function doRefresh() { $('refresh').animate([{rotate:'0deg'},{rotate:'360deg'}], {duration:650}); await window.maid.refresh(); if (current?.snapshot.error) notice(current.snapshot.error); else reveal(); }
$('refresh').addEventListener('click', doRefresh);
$('cycle').addEventListener('click', e => { e.stopPropagation(); setMode(modes[(modes.indexOf(mode)+1)%modes.length]); });
$('talk').addEventListener('click', () => { if(mode === 'phrase') nextPhrase(); else setMode('phrase'); bounce(); });
$('settings').addEventListener('click', () => window.maid.action('settings'));
$('hide').addEventListener('click', () => window.maid.action('hide'));
document.addEventListener('contextmenu', e => { e.preventDefault(); window.maid.action('settings'); });
document.addEventListener('keydown', e => { if(e.key.toLowerCase() === 'q' || e.key === ' ') { e.preventDefault(); bounce(); } });
$('character').addEventListener('animationend', event => {
  if (event.target !== $('character') || event.animationName !== 'squish') return;
  clearBounce();
});
for (const target of [$('character'), $('bubble')]) {
  let start, moved = false;
  target.addEventListener('pointerdown', e => { if(e.button !== 0 || e.target.closest('button')) return; clearBounce(); start = {x:e.screenX,y:e.screenY}; moved = false; target.setPointerCapture(e.pointerId); window.maid.drag('start'); });
  target.addEventListener('pointermove', e => { if(!start) return; if(Math.hypot(e.screenX-start.x,e.screenY-start.y)>4) moved=true; if(moved) window.maid.drag('move'); });
  const finish = e => { if(!start) return; window.maid.drag('end'); start=null; if(target.hasPointerCapture(e.pointerId)) target.releasePointerCapture(e.pointerId); if(!moved) { if(target.id === 'bubble') doRefresh(); else { bounce(); if(mode==='phrase') nextPhrase(); } } };
  target.addEventListener('pointerup', finish);
  target.addEventListener('pointercancel', e => { if(start) { window.maid.drag('end'); start=null; if(target.hasPointerCapture(e.pointerId)) target.releasePointerCapture(e.pointerId); } });
}
document.addEventListener('pointermove', e => { const el = document.elementFromPoint(e.clientX,e.clientY); const inside = !!el?.closest('.interactive'); window.maid.pointerRegion(inside); });
document.documentElement.addEventListener('pointerleave', () => window.maid.pointerRegion(false));
$('character').addEventListener('pointerenter', reveal);
const initialState = window.MaidPresence.connect(window.maid);
window.maid.onState(render); window.maid.onBounce(bounce); initialState.then(render);
setInterval(countdown,1000);
