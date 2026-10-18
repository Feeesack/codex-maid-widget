'use strict';
const fs = require('node:fs');
const path = require('node:path');
const LEGACY_DEFAULT_PHRASES = ['主人，今天也一起把想法变成代码吧。', '额度我来照看，你只管专心创造。', '写累了记得喝水，休息一下也很好。', '每一个小进展，都值得开心一下。'];
const PREVIOUS_DEFAULT_PHRASES = [
  '先开分支再放大招，勇者翻车也得留个存档点。',
  '测试还红着就别插旗啦，这集还没到庆功宴呢。',
  '上下文别塞成异世界史书，Codex 也得翻目录。',
  'Tibo 重置教父在上……咳，先喝茶，少搞玄学。',
  '又在等 OpenAI 的「soon」？先把这杯茶喝完。',
  '别盯着进度条施法，茶凉了可不算 Codex 的锅。',
  '报错先看第一行，别急着给整座魔王城重装修。',
  '这点小 bug 还轮不到龙息出场，把日志拿来。',
  '不是专门陪你熬夜，刚好这壶茶还没泡完而已。',
  '灵感来了先记两行，别指望明天还能原地读档。',
  '需求又追加？行吧，这次的支线任务得加一块布丁。',
  '别急着重构宇宙，眼前这只史莱姆还卡着编译呢。',
];
const DEFAULTS = Object.freeze({
  sizeBaseline: 2,
  scale: 1, opacity: 1, alwaysOnTop: true, clickThrough: false, sound: true,
  autoStart: false, followCodex: true, stayInCodexWindow: false, peekAtCorners: false, showBubble: true, autoHideSeconds: 5, refreshSeconds: 60,
  bucketId: '', mode: 'quota', characterPath: '', activeCharacterId: 'lilac-dragon', position: null, mirror: false,
  phrases: [
    'Tibo 义父，reset please……',
    '别急着重置嘛，让我再蹬蹬。',
    '蹬个 token 都要拼尽全力？杂鱼～',
    '今日职业：yes 工程师。',
    '说好让 AI 干活，怎么我成监工了。',
    '以前缺 token，现在缺觉……',
    '先别让 Codex 清电脑，我怕它把自己也清了。',
    '下班啦。AI 没跑完，明天再说。',
    '嘘，Codex 会干这活的事，先别告诉老板。',
    '还不睡？睡前还得给 Codex 留作业是吧。',
  ],
});
const MODES = ['quota', 'today', 'week', 'lastTurn', 'phrase'];
function clamp(value, min, max, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
}
function sanitize(input = {}) {
  const s = { ...DEFAULTS };
  for (const key of ['alwaysOnTop','clickThrough','sound','autoStart','followCodex','stayInCodexWindow','peekAtCorners','showBubble','mirror']) {
    if (typeof input[key] === 'boolean') s[key] = input[key];
  }
  s.scale = clamp(input.scale, 0.6, 1.6, DEFAULTS.scale);
  s.opacity = clamp(input.opacity, 0.35, 1, DEFAULTS.opacity);
  s.refreshSeconds = clamp(input.refreshSeconds, 30, 600, DEFAULTS.refreshSeconds);
  s.autoHideSeconds = clamp(input.autoHideSeconds, 0, 300, DEFAULTS.autoHideSeconds);
  if (typeof input.bucketId === 'string') s.bucketId = input.bucketId.slice(0, 100);
  if (MODES.includes(input.mode)) s.mode = input.mode;
  if (typeof input.characterPath === 'string') s.characterPath = input.characterPath;
  if (typeof input.activeCharacterId === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(input.activeCharacterId)) s.activeCharacterId = input.activeCharacterId;
  if (Array.isArray(input.phrases)) {
    const phrases = input.phrases.filter(x => typeof x === 'string').map(x => x.trim().slice(0, 160)).filter(Boolean).slice(0, 50);
    if (phrases.length) s.phrases = phrases;
  }
  if (input.position && Number.isFinite(input.position.x) && Number.isFinite(input.position.y)) {
    s.position = { x: Math.round(input.position.x), y: Math.round(input.position.y) };
  }
  return s;
}
function readSettings(file) {
  try {
    const input = JSON.parse(fs.readFileSync(file, 'utf8'));
    // 100% now means the former 60%. Preserve a saved visual size across upgrades.
    if (input.sizeBaseline !== 2 && typeof input.scale === 'number') input.scale /= 0.6;
    // Replace only untouched shipped presets; keep every custom line and selection.
    if (Array.isArray(input.phrases) && [LEGACY_DEFAULT_PHRASES, PREVIOUS_DEFAULT_PHRASES].some(preset =>
      input.phrases.length === preset.length && input.phrases.every((phrase, index) => phrase === preset[index]))) input.phrases = DEFAULTS.phrases;
    return sanitize(input);
  } catch { return sanitize(); }
}
function widgetDimensions(scale = DEFAULTS.scale) {
  const value = clamp(scale, 0.6, 1.6, DEFAULTS.scale);
  return { width: Math.round(228 * value), height: Math.round(288 * value) };
}
function writeSettings(file, settings) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + '.tmp', JSON.stringify(sanitize(settings), null, 2));
  fs.renameSync(file + '.tmp', file);
}
function constrainPosition(bounds, area) {
  return { x: Math.round(Math.max(area.x, Math.min(bounds.x, area.x + area.width - bounds.width))),
    y: Math.round(Math.max(area.y, Math.min(bounds.y, area.y + area.height - bounds.height))) };
}
function snapBounds(bounds, area, threshold = 32) {
  const p = constrainPosition(bounds, area);
  const left = p.x - area.x, right = area.x + area.width - (p.x + bounds.width);
  if (area.y + area.height - (p.y + bounds.height) < threshold && Math.min(left, right) < threshold) {
    p.x = left < right ? area.x : area.x + area.width - bounds.width;
    p.y = area.y + area.height - bounds.height;
  }
  return { ...p, mirror: mirrorForBounds({ ...bounds, ...p }, area) };
}
function bottomCorner(bounds, area, tolerance = 2) {
  if (Math.abs(area.y + area.height - bounds.y - bounds.height) > tolerance) return null;
  const left = Math.abs(bounds.x - area.x), right = Math.abs(area.x + area.width - bounds.x - bounds.width);
  return left <= tolerance && left < right ? 'left' : right <= tolerance ? 'right' : null;
}
function cornerPeekOffset(corner, size) {
  if (corner !== 'left' && corner !== 'right') return { x: 0, y: 0 };
  const scale = size.width / 380;
  return { x: (corner === 'left' ? -48 : 48) * scale, y: 56 * scale };
}
function projectVisualBounds(visualBounds, area) {
  // Keep the native surface within its host and preserve the exact visual origin
  // with a renderer offset. Its preferred size never comes from rounded HWNDs.
  const bounds = { ...constrainPosition(visualBounds, area), width: visualBounds.width, height: visualBounds.height };
  return { bounds, offset: { x: visualBounds.x - bounds.x, y: visualBounds.y - bounds.y } };
}
function mirrorForBounds(bounds, area) {
  // Use the fixed surface centre, independent of mirrored artwork/bubble layout.
  return bounds.x + bounds.width / 2 < area.x + area.width / 2;
}
module.exports = { DEFAULTS, sanitize, readSettings, writeSettings, widgetDimensions, constrainPosition, snapBounds, mirrorForBounds, bottomCorner, cornerPeekOffset, projectVisualBounds };
