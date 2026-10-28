'use strict';
const { app, BrowserWindow, ipcMain, screen, Tray, Menu, nativeImage, globalShortcut, dialog, net } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const os = require('node:os');
const i18n = require('./i18n.js');
const { t } = i18n;
const { execFile } = require('node:child_process');
const { readSettings, writeSettings, sanitize, widgetDimensions, constrainPosition, snapBounds, mirrorForBounds, bottomCorner, cornerPeekOffset, projectVisualBounds } = require('./settings.cjs');
const { CharacterLibrary } = require('./character-library.cjs');
const { CodexDataSource } = require('./codex-data.cjs');
const { CodexDesktopMonitor, buildLaunchArgs } = require('./codex-desktop.cjs');
const { watchAuthChanges } = require('./auth-change-watch.cjs');
const { launchThroughExplorer } = require('./windows-launch.cjs');
const { launchMacWatcher, finalizeMacWatcherRemoval } = require('./macos-launch.cjs');
const { supportsDesktopFollow, configureMacApp, configureWidgetWorkspace, trayImage } = require('./platform.cjs');
const { prepareDataHome } = require('./data-home.cjs');
const { readDesktopObservation, sameExecutable } = require('./desktop-observation.cjs');
app.setName('codex-maid-widget');
const demoMode = process.argv.includes('--demo');
const root = path.join(__dirname, '..');
const windowIcon = process.platform === 'win32' ? path.join(root, 'assets', 'app-icon.ico') : path.join(root, 'assets', 'icons', 'app-256.png');
const dataDir = prepareDataHome({legacyDir:app.getPath('userData')});
process.env.CODEX_MAID_HOME = dataDir;
fs.mkdirSync(dataDir,{recursive:true});
app.setPath('userData',dataDir);
const settingsFile = path.join(dataDir, 'settings.json');
let settings = readSettings(settingsFile);
i18n.setLocale(settings.language);
let settingsRevision = 0;
let accountRegistry, accountAlarm, accountStorageError = false;
function accountManagement() {
  const view = accountRegistry?.snapshot(demoMode ? null : source?.accountIdentity) || { accounts: [], count: 0 };
  return { ...view, storageError: accountStorageError || view.storageError === true };
}
function notifyAccountReset(event) {
  if (quitting) return;
  const account = accountManagement().accounts.find(value => value.id === event.id);
  if (widget && !widget.isDestroyed()) widget.webContents.send('account-reset', {
    id: event.id, label: account ? i18n.accountLabel(account) : event.label, resetsAt: event.resetsAt, estimated: event.estimated,
  });
  broadcast();
}
let widget, settingsWindow, chatWindow, chatService, tray, source, timer, controlServer, library, desktopMonitor, stopAuthWatch, authRefreshTimer;
let resetForecastSource;
let followRegistered = null, followLaunchGeneration = 0, refreshGeneration = 0;
let followOperation = Promise.resolve();
const followSupported = supportsDesktopFollow({ packaged: app.isPackaged, demo: demoMode });
let followError = '';
let connectingPlugin = false;
let snapshot = { status: 'connecting', buckets: [], today: null, lastTurn: null };
let quitting = false, drag = null, refreshing = null, ownsControl = false;
let chatQuitPreparing = false, chatQuitPrepared = false;
let widgetInputSequence = 0;
let windowMode = null;
let widgetManuallyHidden = false;
let lastCorner = null;
let visualMotion = null, poseTimer = null, poseResume = null, poseEpoch = 0;
let cornerPeekPreview = null, appearancePreview = null, appearancePreviewOrigin = null;
function save() { writeSettings(settingsFile, settings); }
function state() {
  const characters = library.list();
  const active = characters.find(item => item.id === settings.activeCharacterId && item.available) || characters.find(item => item.id === library.defaultId);
  const dock = cornerDockState();
  return { settings, settingsRevision, snapshot, resetForecast: resetForecastSource?.snapshot() || { status: 'connecting', source: 'https://codex-reset.com/' }, demo: demoMode, version: app.getVersion(), platform: process.platform, characters, followSupported, followError: t(followError), windowContainment: windowModeState(), cornerDock: dock, visualPose: visualPoseState(dock),
    activeCharacterId: active.id, characterUrl: active.url, characterName: i18n.characterName(active), accountManagement: accountManagement() };
}
function broadcast() {
  for (const win of [widget, settingsWindow, chatWindow]) if (win && !win.isDestroyed()) win.webContents.send('state', state());
}
function broadcastWidgetState() {
  if (widget && !widget.isDestroyed()) widget.webContents.send('state', state());
}
function effectivePeekSettings() {
  return settings.peekAtCorners && cornerPeekPreview ? { ...settings, ...cornerPeekPreview } : settings;
}
function effectiveAppearanceSettings() {
  return appearancePreview ? { ...settings, ...appearancePreview } : settings;
}
function appearanceBounds(origin, size = dimensions()) {
  const area = screen.getDisplayMatching(origin.bounds).workArea;
  const position = origin.corner ? {
    x: origin.corner === 'left' ? area.x : area.x + area.width - size.width,
    y: area.y + area.height - size.height,
  } : origin.bounds;
  return { ...constrainPosition({ ...position, ...size }, area), ...size };
}
function captureAppearanceOrigin() {
  const contained = windowMode?.enabled === true;
  const bounds = { ...(contained ? windowMode.getBounds() : widget.getBounds()), ...dimensions() };
  const area = contained ? windowMode.getArea() : screen.getDisplayMatching(bounds).workArea;
  return { bounds, contained, corner: area ? bottomCorner(bounds, area) : null };
}
function applyAppearanceGeometry(origin, resize = true) {
  if (!widget || widget.isDestroyed()) return;
  widget.setOpacity(effectiveAppearanceSettings().opacity);
  if (!resize) return;
  // Preserve a held world point while the native surface takes its new size.
  // Normal idle resize uses the first real bounds, never a previous preview.
  if (visualMotion?.visual) {
    const area = poseArea(visualMotion.visual);
    if (area) {
      const projected = projectVisualBounds({ ...visualMotion.visual, ...dimensions() }, area);
      visualMotion.offset = projected.offset;
      if (!windowMode?.moveTo(projected.bounds.x, projected.bounds.y)) widget.setBounds(projected.bounds);
    }
  } else if (windowMode?.enabled) {
    // The containment controller already keeps a normalized host anchor and
    // projects preferred DIP dimensions through its native child provider.
    windowMode.refreshSize();
  } else {
    const bounds = appearanceBounds(origin), current = widget.getBounds();
    if (['x', 'y', 'width', 'height'].some(key => current[key] !== bounds[key])) widget.setBounds(bounds);
  }
}
function clearPreviews(notify = true, restore = true) {
  const origin = appearancePreviewOrigin, changed = !!cornerPeekPreview || !!appearancePreview;
  cornerPeekPreview = null; appearancePreview = null; appearancePreviewOrigin = null;
  if (origin && restore) applyAppearanceGeometry(origin);
  if (notify && changed) broadcastWidgetState();
  return origin;
}
function previewAppearance(patch) {
  if (patch === null) { clearPreviews(); return state(); }
  const limits = { scale: [0.6, 1.6], opacity: [0.35, 1] };
  const keys = patch && typeof patch === 'object' && !Array.isArray(patch) ? Reflect.ownKeys(patch) : [];
  if (!keys.length || keys.some(key => !Object.hasOwn(limits, key) || typeof patch[key] !== 'number' ||
    !Number.isFinite(patch[key]) || patch[key] < limits[key][0] || patch[key] > limits[key][1])) {
    throw new TypeError(t('无效的外观预览参数'));
  }
  const before = dimensions();
  if (!appearancePreviewOrigin) appearancePreviewOrigin = captureAppearanceOrigin();
  appearancePreview = { ...appearancePreview, ...patch };
  const after = dimensions(), resized = before.width !== after.width || before.height !== after.height;
  applyAppearanceGeometry(appearancePreviewOrigin, resized);
  broadcastWidgetState(); return state();
}
function previewCornerPeek(patch) {
  if (patch === null) { clearPreviews(); return state(); }
  if (patch !== null) {
    const keys = patch && typeof patch === 'object' && !Array.isArray(patch) ? Reflect.ownKeys(patch) : [];
    if (!keys.length || keys.some(key => !['peekSidePercent', 'peekBottomPercent'].includes(key) ||
      typeof patch[key] !== 'number' || !Number.isFinite(patch[key]) || !Number.isInteger(patch[key]) || patch[key] < 0 || patch[key] > 200)) {
      throw new TypeError(t('无效的底角预览参数'));
    }
  }
  // This synchronous overlay never changes preferences, native bounds or timers.
  // The settings renderer serializes previews before commit/cancel, so a late
  // promise result cannot reapply an earlier draft after this overlay is cleared.
  cornerPeekPreview = settings.peekAtCorners && patch !== null ? { ...cornerPeekPreview, ...patch } : null;
  broadcastWidgetState();
  return state();
}
function saveDraggedPosition(position, area) {
  let saved = position;
  if (appearancePreview) {
    const size = widgetDimensions(settings.scale), corner = bottomCorner({ ...position, ...dimensions() }, area);
    const target = corner ? { x: corner === 'left' ? area.x : area.x + area.width - size.width,
      y: area.y + area.height - size.height } : position;
    saved = snapBounds({ ...target, ...size }, area);
    if (appearancePreviewOrigin && !windowMode?.enabled) {
      // A real drag is user intent. Its saved-size destination supersedes the
      // original preview anchor, without recording temporary preview bounds.
      appearancePreviewOrigin.bounds = { x: saved.x, y: saved.y, ...size };
      appearancePreviewOrigin.corner = bottomCorner(appearancePreviewOrigin.bounds, area);
    }
  }
  if (!windowMode?.enabled) settings.position = { x: saved.x, y: saved.y };
  settings.mirror = saved.mirror; save();
}
function dimensions() { return widgetDimensions(effectiveAppearanceSettings().scale); }
function cornerDockState() {
  if (!widget || widget.isDestroyed()) return { corner: null, peeking: false };
  const contained = windowMode?.enabled;
  const bounds = { ...(contained ? windowMode.getBounds() : widget.getBounds()), ...dimensions() };
  const area = contained ? windowMode.getArea() : screen.getDisplayMatching(bounds).workArea;
  // Minimize keeps the native child composed; retain its parked appearance.
  const corner = area ? bottomCorner(bounds, area) : contained ? lastCorner : null;
  lastCorner = corner;
  return { corner, peeking: !!corner && settings.peekAtCorners && !drag?.moved && !visualMotion };
}
function visualPoseState(dock = cornerDockState()) {
  return { offset: visualMotion ? { ...visualMotion.offset } : cornerPeekOffset(dock.peeking ? dock.corner : null, dimensions(), effectivePeekSettings()), moving: !!visualMotion };
}
function cancelPose(clear = false) {
  poseEpoch++; clearTimeout(poseTimer); poseTimer = null; poseResume = null;
  if (clear) visualMotion = null;
}
function poseArea(visual) {
  return windowMode?.enabled ? windowMode.getArea() : screen.getDisplayMatching({ ...visual, ...dimensions() }).workArea;
}
function applyVisualPose(visual, phase, area = poseArea(visual)) {
  if (!area) return false;
  const projected = projectVisualBounds({ ...visual, ...dimensions() }, area);
  // Native position + visual remainder always equals the pointer's world point.
  visualMotion = { visual: { ...visual }, offset: projected.offset, phase };
  setWidgetPosition(projected.bounds.x, projected.bounds.y);
  broadcast();
  return true;
}
function rebasePoseDrag() {
  if (!drag?.poseMode || !windowMode?.enabled) return;
  const area = windowMode.getArea();
  if (!area || drag.area && ['x', 'y', 'width', 'height'].every(key => area[key] === drag.area[key])) return;
  // Native children move with their host before the next pointer event. Keep
  // that composed position and apply only the next unprocessed mouse delta.
  const bounds = windowMode.getBounds(), offset = visualPoseState().offset;
  const visual = { x: bounds.x + offset.x, y: bounds.y + offset.y };
  drag.visualOrigin = { x: visual.x - (drag.lastCursor.x - drag.cursor.x), y: visual.y - (drag.lastCursor.y - drag.cursor.y) };
  drag.visual = visual; drag.area = { ...area };
  if (visualMotion) visualMotion.visual = { ...visual };
}
function settleVisualPose(from, canonical, area) {
  cancelPose();
  const epoch = poseEpoch, size = dimensions(), started = Date.now();
  const anchor = { x: area.width > size.width ? (canonical.x - area.x) / (area.width - size.width) : 1,
    y: area.height > size.height ? (canonical.y - area.y) / (area.height - size.height) : 1 };
  const offset = cornerPeekOffset(settings.peekAtCorners ? bottomCorner({ ...canonical, ...size }, area) : null, size, effectivePeekSettings());
  const target = { x: canonical.x + offset.x, y: canonical.y + offset.y };
  if (Math.hypot(target.x - from.x, target.y - from.y) < 0.01) {
    visualMotion = null; setWidgetPosition(canonical.x, canonical.y); broadcast(); return;
  }
  const frame = () => {
    if (epoch !== poseEpoch || quitting || !widget || widget.isDestroyed()) return;
    const liveArea = poseArea(target);
    // Keep the composed child unchanged while its host minimizes or is unknown.
    if (!liveArea) { poseTimer = null; poseResume = frame; return; }
    const size = dimensions();
    const position = { x: Math.round(liveArea.x + anchor.x * (liveArea.width - size.width)),
      y: Math.round(liveArea.y + anchor.y * (liveArea.height - size.height)) };
    const inset = cornerPeekOffset(settings.peekAtCorners ? bottomCorner({ ...position, ...size }, liveArea) : null, size, effectivePeekSettings());
    const goal = { x: position.x + inset.x, y: position.y + inset.y };
    const start = { x: from.x + liveArea.x - area.x, y: from.y + liveArea.y - area.y };
    const progress = Math.min(1, Math.max(0, (Date.now() - started) / 180)), eased = 1 - (1 - progress) ** 3;
    applyVisualPose({ x: start.x + (goal.x - start.x) * eased, y: start.y + (goal.y - start.y) * eased }, 'settle', liveArea);
    if (progress < 1) poseTimer = setTimeout(frame, 16);
    else { poseTimer = null; visualMotion = null; setWidgetPosition(position.x, position.y); broadcast(); }
  };
  frame();
}
function windowModeChanged() {
  rebasePoseDrag();
  if (poseResume && windowMode?.getArea()) {
    const resume = poseResume; poseResume = null; poseTimer = setTimeout(resume, 0);
  }
  syncMirror(); broadcast();
}
function syncMirror() {
  if (appearancePreview || !widget || widget.isDestroyed()) return false;
  const contained = windowMode?.enabled;
  const bounds = { ...(contained ? windowMode.getBounds() : widget.getBounds()), ...dimensions() };
  const area = contained ? windowMode.getArea() : screen.getDisplayMatching(bounds).workArea;
  if (!area) return false;
  const mirror = mirrorForBounds(bounds, area);
  if (settings.mirror === mirror) return false;
  settings.mirror = mirror;
  return true;
}
function windowModeState() {
  return windowMode?.getState() || { supported: ['win32', 'darwin'].includes(process.platform), enabled: settings.stayInCodexWindow,
    visible: false, reason: settings.stayInCodexWindow ? 'unknown' : 'disabled' };
}
function syncWindowMode() {
  if (!windowMode) {
    const { CodexWindowMode } = require('./window-mode.cjs');
    windowMode = new CodexWindowMode({ widget, screen, getSize: dimensions, onStatus: windowModeChanged, onRecreate: rebuildWidget });
    if (widgetManuallyHidden) windowMode.hide();
  }
  windowMode?.configure(settings.stayInCodexWindow, { position: settings.position, alwaysOnTop: settings.alwaysOnTop });
}
function setWidgetPosition(x, y) {
  // Position-only native updates can accumulate size rounding at fractional DPI.
  // Always use the preferred DIP size, never a previously rounded window size.
  if (!windowMode?.moveTo(x, y)) widget.setBounds({ x, y, ...dimensions() });
  if (syncMirror()) broadcast();
}
function applyWindowSettings() {
  widget.setOpacity(effectiveAppearanceSettings().opacity);
  widget.setIgnoreMouseEvents(settings.clickThrough, { forward: true });
  syncWindowMode();
  if (windowMode?.enabled) windowMode.refreshSize();
  else {
    const old = widget.getBounds();
    const size = dimensions();
    const area = screen.getDisplayMatching(old).workArea;
    const p = constrainPosition({ ...old, ...size }, area);
    widget.setBounds({ ...p, ...size });
  }
  syncMirror();
  syncDesktopFollow();
  updateTray();
}
function readyWatcherRecord() {
  try {
    const record = JSON.parse(fs.readFileSync(path.join(dataDir,'watcher.json'),'utf8'));
    if (!Number.isInteger(record.pid) || record.pid <= 0 || record.version !== app.getVersion() ||
        !sameExecutable(record.executable, process.execPath) ||
        typeof record.loginStartupEnabled !== 'boolean') return null;
    process.kill(record.pid,0);
    return record;
  } catch { return null; }
}
function dispatchDesktopWatcher(extraArgs = [], enabled = true) {
  const options = { executable:process.execPath, args:[...buildLaunchArgs({packaged:app.isPackaged,appRoot:root,flag:'--watch-codex'}),'--maid-home='+dataDir,...extraArgs], cwd:path.dirname(process.execPath), dataDir };
  return process.platform === 'darwin' ? launchMacWatcher({ ...options, enabled }) : launchThroughExplorer(options);
}
function queueDesktopFollow(generation, operation) {
  if (process.platform !== 'darwin') return operation();
  // A quick off/on must finish removal before the new LaunchAgent is loaded.
  const pending = followOperation.catch(() => {}).then(() => {
    if (!quitting && generation === followLaunchGeneration) return operation();
  });
  followOperation = pending;
  return pending;
}
async function ensureDesktopWatcher(generation) {
  // A detached child can still belong to Codex's Windows Job. Ask the existing
  // Explorer desktop to own this process so closing Codex cannot kill it.
  await dispatchDesktopWatcher();
  const deadline = Date.now()+6000;
  while (!quitting && settings.followCodex && generation === followLaunchGeneration) {
    const record = readyWatcherRecord();
    if (record) return record;
    if (Date.now() >= deadline) throw new Error('watcher-not-ready');
    await new Promise(resolve => setTimeout(resolve,150));
  }
}
async function disableDesktopWatcher(generation) {
  const requestId = crypto.randomUUID();
  await dispatchDesktopWatcher(['--follow-request='+requestId], false);
  const deadline = Date.now()+6000;
  // Once a macOS removal was sent, hold the queue until its receipt arrives.
  // Otherwise an off/on toggle could bootstrap just before the old helper
  // unlinks the plist, leaving a running observer without login persistence.
  while (!quitting && (process.platform === 'darwin' || (!settings.followCodex && generation === followLaunchGeneration))) {
    let record;
    try { record = JSON.parse(fs.readFileSync(path.join(dataDir,'follow-startup.json'),'utf8')); } catch {}
    if (record?.requestId === requestId && record.version === app.getVersion() &&
        sameExecutable(record.executable, process.execPath)) {
      if (process.platform === 'darwin' && record.loginStartupEnabled === true && generation !== followLaunchGeneration && !record.loginStartupError) return;
      if (record.loginStartupEnabled !== false || record.loginStartupError) throw new Error('startup-removal-failed');
      if (process.platform === 'darwin') await finalizeMacWatcherRemoval();
      return;
    }
    if (Date.now() >= deadline) throw new Error('startup-removal-not-confirmed');
    await new Promise(resolve => setTimeout(resolve,150));
  }
}
function syncDesktopFollow() {
  if (!followSupported || followRegistered === settings.followCodex) return;
  const generation = ++followLaunchGeneration;
  try {
    // The Explorer-owned helper registers the real Windows startup entry.
    // Writes from a Codex/MSIX child can land in a private registry view.
    followError = ''; followRegistered = settings.followCodex;
    if (settings.followCodex) {
      void queueDesktopFollow(generation, () => ensureDesktopWatcher(generation)).then(record => {
        if (!record || quitting || !settings.followCodex || generation !== followLaunchGeneration) return;
        followError = record.loginStartupEnabled ? '' : process.platform === 'darwin' ? 'macOS 后台启动助手未启用，请检查系统设置中的登录项与后台活动。' : 'Windows 登录启动项未启用，请在系统启动应用中开启 CodexMaidFollow。';
        broadcast();
      }).catch(() => {
        if (quitting || !settings.followCodex || generation !== followLaunchGeneration) return;
        followError = process.platform === 'darwin' ? '后台启动助手未能就绪，请检查 macOS 登录项与后台活动权限，再重新开启跟随。' : '后台启动助手未能就绪，请重新开启跟随开关；需保持 Windows 资源管理器运行。';
        followRegistered = null; broadcast();
      });
      desktopMonitor?.stop();
      desktopMonitor = new CodexDesktopMonitor({ query: () => readDesktopObservation({ dataDir, executable: process.execPath, version: app.getVersion() }),
        onMissing: () => { if (settings.followCodex && !quitting) app.quit(); } });
      desktopMonitor.start();
    } else {
      desktopMonitor?.stop(); desktopMonitor = null;
      // Dispatch even if the old helper is gone so disabling follow also
      // removes its real login entry outside the MSIX registry view.
      void queueDesktopFollow(generation, () => disableDesktopWatcher(generation)).catch(() => {
        if (quitting || settings.followCodex || generation !== followLaunchGeneration) return;
        followError = '未能移除系统登录启动项，请重新开启再关闭跟随开关。';
        followRegistered = null; broadcast();
      });
    }
  } catch {
    followRegistered = null;
    followError = '未能保存自动跟随设置，请检查系统登录启动项权限后重试。';
  }
}
function updateSettings(patch) {
  const appearanceOrigin = clearPreviews(false, false);
  cancelPose(true);
  if (drag?.poseMode) drag = null;
  // File paths and window positions are only set by trusted native actions.
  const { characterPath, activeCharacterId, position, ...safe } = patch || {};
  const previous = settings, previousRevision = settingsRevision;
  settings = sanitize({ ...settings, ...safe });
  if (appearanceOrigin && !appearanceOrigin.contained && !settings.stayInCodexWindow && Object.hasOwn(safe, 'scale')) {
    const bounds = appearanceBounds(appearanceOrigin, widgetDimensions(settings.scale));
    settings.position = { x: bounds.x, y: bounds.y };
    settings.mirror = mirrorForBounds(bounds, screen.getDisplayMatching(bounds).workArea);
  }
  settingsRevision++;
  try { save(); }
  catch (error) {
    settings = previous; settingsRevision = previousRevision;
    if (appearanceOrigin) applyAppearanceGeometry(appearanceOrigin);
    broadcast(); throw error;
  }
  i18n.setLocale(settings.language);
  if (appearanceOrigin) applyAppearanceGeometry(appearanceOrigin);
  applyWindowSettings(); schedule(); resetForecastSource?.setEnabled(!settings.bubbleHiddenPages?.includes('resetForecast')); broadcast();
  return state();
}
function updateTray() {
  i18n.register?.({'桌宠聊天':'Companion chat'});
  if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.setTitle(t('Codex 女仆 · 设置'));
  if (!tray) return;
  tray.setToolTip(t('Codex 女仆 · 额度与陪伴'));
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: t('显示女仆 · Ctrl+Alt+M'), click: show },
    { label: t('刷新额度'), click: () => refresh() },
    { label: t('桌宠聊天'), click: openChatManager },
    { label: t('切换形象'), submenu: characterMenuItems() },
    { label: t('设置'), click: openSettings },
    ...(process.platform === 'darwin' ? [{ label: t('连接 Codex 工具…'), click: connectCodexPlugin }] : []),
    { type: 'separator' },
    { label: t('鼠标穿透 · Ctrl+Alt+Shift+M'), type: 'checkbox', checked: settings.clickThrough, click: i => updateSettings({ clickThrough: i.checked }) },
    { label: t('始终置顶'), type: 'checkbox', checked: settings.alwaysOnTop, click: i => updateSettings({ alwaysOnTop: i.checked }) },
    { label: t('仅在 Codex 窗口内显示'), type: 'checkbox', checked: settings.stayInCodexWindow, click: i => updateSettings({ stayInCodexWindow: i.checked }) },
    { label: t('重置位置'), click: resetPosition },
    { label: t('隐藏挂件'), click: hide },
    { type: 'separator' },
    { label: t('退出'), click: () => app.quit() },
  ]));
}
async function connectCodexPlugin() {
  if (connectingPlugin) return;
  connectingPlugin = true;
  try {
    const connector = path.join(process.resourcesPath, 'integration', 'connect.cjs');
    if (!fs.existsSync(connector)) {
      await dialog.showMessageBox({ type: 'info', message: t('连接工具随 Mac 安装包提供。'), detail: t('请安装完整应用后，从菜单栏选择“连接 Codex 工具”。') });
      return;
    }
    const answer = await dialog.showMessageBox({ type: 'question', message: t('将女仆挂件连接到 Codex？'),
      detail: t('这会在本机注册并安装女仆插件，让 Codex 对话可以读取挂件状态、刷新额度和互动。完成后请重启 Codex 并新建聊天。'),
      buttons: [t('连接'), t('取消')], defaultId: 0, cancelId: 1 });
    if (answer.response !== 0) return;
    const result = await new Promise(resolve => {
      execFile(process.execPath, [connector, '--install'], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', CODEX_MAID_HOME: dataDir },
        timeout: 90000, maxBuffer: 256 * 1024, windowsHide: true,
      }, (error, stdout) => {
        try {
          const value = JSON.parse(stdout);
          resolve({ ok: !error && value.ok === true, message: typeof value.message === 'string' ? value.message.slice(0, 2000) : '' });
        } catch { resolve({ ok: false, message: t('连接未完成。请确认已安装最新 Codex，然后从菜单栏重试。') }); }
      });
    });
    await dialog.showMessageBox({ type: result.ok ? 'info' : 'error', message: result.ok ? t('Codex 工具已连接') : t('Codex 工具连接未完成'), detail: i18n.connectorMessage(result.message) });
  } finally { connectingPlugin = false; }
}
function characterMenuItems() {
  const activeId = state().activeCharacterId;
  return [
    ...library.list().map(item => ({ label: i18n.characterName(item).replace(/&/g,'&&'), type: 'radio', checked: item.id === activeId, enabled: item.available, click: () => selectCharacter(item.id) })),
    { type: 'separator' },
    { label: t('管理形象…'), click: openSettings },
  ];
}
function selectCharacter(id) {
  const item = library.get(id);
  if (!item || !item.available) throw new Error(t('该形象不存在或图片已损坏，请重新导入。'));
  settings.activeCharacterId = item.id;
  settings.characterPath = '';
  save(); updateTray(); broadcast();
  return state();
}
async function validateBrowserImage(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw new Error(t('请选择本地图片。'));
  const info = fs.statSync(file);
  if (!info.isFile() || info.size > 15 * 1024 * 1024) throw new Error(t('请选择小于 15 MB 的图片。'));
  // Windows nativeImage decodes PNG/JPEG but not GIF/WebP; validate those in Chromium.
  if (!/\.(gif|webp)$/i.test(file)) return;
  const url = require('node:url').pathToFileURL(file).href;
  const decoded = await widget.webContents.executeJavaScript(`new Promise(resolve => {
    const img = new Image(); let finished = false;
    const done = value => { if(finished)return;finished=true;clearTimeout(timer);img.onload=null;img.onerror=null;img.src='';resolve(value); };
    const timer = setTimeout(()=>done(null),5000);
    img.onload = () => done({width:img.naturalWidth,height:img.naturalHeight});
    img.onerror = () => done(null);
    img.src = ${JSON.stringify(url)};
  })`);
  if (!decoded?.width || !decoded?.height) throw new Error(t('无法读取这张图片，请重新导出后导入。'));
  if (decoded.width > 16384 || decoded.height > 16384 || decoded.width * decoded.height > 64000000) throw new Error(t('图片尺寸过大，请先缩小图片后导入。'));
}
async function importCharacterFiles(paths) {
  const result = {imported:[],existing:[],errors:[]};
  for (const file of paths) {
    try {
      await validateBrowserImage(file);
      const next = library.importFiles([file]);
      for (const key of Object.keys(result)) result[key].push(...next[key]);
    } catch(error) {
      result.errors.push({name:typeof file==='string'?path.basename(file):t('图片'),message:error.code==='ENOENT'?t('图片不存在或已移动。'):error.message});
    }
  }
  return result;
}
function show() { widgetManuallyHidden = false; if (windowMode) windowMode.show(); else { widget.show(); widget.moveTop(); } broadcast(); }
function hide() { widgetManuallyHidden = true; if (windowMode) windowMode.hide(); else widget.hide(); broadcast(); }
function resetPosition() {
  cancelPose(true); drag = null;
  if (windowMode?.enabled) {
    const area = windowMode.getArea(), size = dimensions();
    if (area) windowMode.moveTo(area.x + area.width - size.width, area.y + area.height - size.height);
    settings.mirror = false; save(); show(); return;
  }
  const area = screen.getPrimaryDisplay().workArea;
  const size = dimensions();
  settings.position = { x: area.x + area.width - size.width, y: area.y + area.height - size.height };
  settings.mirror = false;
  widget.setBounds({ ...settings.position, ...size });
  save(); show();
}
async function refresh() {
  if (refreshing) return refreshing;
  const generation = refreshGeneration;
  const task = (async () => {
    broadcast();
    try {
      const next = demoMode ? require('./demo.cjs')() : await source.read();
      if (generation !== refreshGeneration || next.invalidated || quitting) return snapshot;
      if (!demoMode && accountRegistry && next.status === 'live' && !next.error && source.accountIdentity) {
        // A fresh quota response may already contain the next window; deliver
        // the previous recorded deadline before replacing that observation.
        const deadlinesPersisted = accountAlarm?.check() !== false;
        try {
          if (deadlinesPersisted) {
            const presentation = source.accountPresentation;
            accountRegistry.observe({ key: source.accountIdentity, planType: next.account?.planType, buckets: next.buckets,
              presentation: presentation?.key === source.accountIdentity && Number.isSafeInteger(presentation.generation) && presentation.generation === next.generation
                ? presentation : null });
            accountStorageError = false;
          } else accountStorageError = true;
        } catch { accountStorageError = true; }
        accountAlarm?.check();
      }
      snapshot = next.error && !next.clearPrevious && !next.accountChanged && !next.buckets?.length && snapshot.buckets?.length
        ? { ...next, buckets: snapshot.buckets, updatedAt: snapshot.updatedAt, stale: true }
        : next;
      chatService?.notifyQuotaChange?.();
    }
    catch { if (generation !== refreshGeneration || quitting) return snapshot; snapshot = { ...snapshot, status: 'offline', account:null, buckets:[], stale:false, error: '暂时无法读取 Codex，请稍后刷新。' }; }
    broadcast();
    return snapshot;
  })().finally(() => { if (refreshing === task) refreshing = null; });
  refreshing = task;
  return task;
}
function authChanged() {
  refreshGeneration++; source?.invalidate(); refreshing = null;
  // Device token totals survive account switches; only account-specific data is cleared.
  snapshot = { ...snapshot, account:null, buckets:[], stale:false, status:'connecting', accountChanged:true, error:null };
  broadcast(); clearTimeout(authRefreshTimer);
  authRefreshTimer = setTimeout(() => { if (!quitting) refresh(); }, 500);
}
function schedule() { clearInterval(timer); timer = setInterval(() => refresh(), settings.refreshSeconds * 1000); }
function openSettings() {
  if (settingsWindow && !settingsWindow.isDestroyed()) { settingsWindow.show(); settingsWindow.focus(); return; }
  const created = new BrowserWindow({ width: 550, height: 760, minWidth: 470, minHeight: 520,
    icon: windowIcon,
    title: t('Codex 女仆 · 设置'), backgroundColor: '#f5faf8', autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  settingsWindow = created;
  secureWindow(created);
  const release = () => {
    if (settingsWindow !== created) return;
    settingsWindow = null;
    clearPreviews();
  };
  created.once('closed', release);
  created.webContents.once('destroyed', release);
  created.loadFile(path.join(__dirname, 'settings.html'));
}
function companionChat() {
  i18n.register(require('./i18n-chat.js'));
  if (!chatService) {
    chatService = new (require('./chat-service.cjs').ChatService)({ dataDir, autoConnect: true, getSettings: () => settings, updateSettings: patch => updateSettings(patch) });
    chatService.on('state', value => {
      for (const win of [widget, chatWindow]) if (win && !win.isDestroyed()) win.webContents.send('chat-state', value);
    });
  }
  return chatService;
}
function openChatManager() {
  i18n.register(require('./i18n-chat.js'));
  if (chatWindow && !chatWindow.isDestroyed()) { chatWindow.show(); chatWindow.focus(); return; }
  const created = new BrowserWindow({ width: 1040, height: 860, minWidth: 640, minHeight: 520, icon: windowIcon,
    title: t('聊天管理'), backgroundColor: '#f5faf8', autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  chatWindow = created; secureWindow(created);
  created.on('close', event => { if (!quitting) { event.preventDefault(); created.hide(); } });
  created.once('closed', () => { if (chatWindow === created) chatWindow = null; });
  created.loadFile(path.join(__dirname, 'chat-page.html'));
}
function rebuildWidget() {
  if (quitting) return;
  cancelPose(true); drag = null;
  if (widget && !widget.isDestroyed()) widget.destroy();
}
async function createWidget() {
  const created = new BrowserWindow({ ...dimensions(), frame: false, transparent: true, resizable: false,
    icon: windowIcon, hasShadow: false, skipTaskbar: true, show: false, backgroundColor: '#00000000',
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
  widget = created;
  secureWindow(created); configureWidgetWorkspace(created);
  created.on('close', event => { if (!quitting) { event.preventDefault(); hide(); } });
  created.on('closed', () => {
    if (quitting || widget !== created) return;
    cancelPose(true);
    // Windows destroys a native child when its host closes. Recreate only our
    // surface; quota source, tray, helper, settings and MCP endpoint stay alive.
    windowMode?.close(); windowMode = null; drag = null;
    void createWidget().catch(() => { if (!quitting) app.quit(); });
  });
  const area = screen.getPrimaryDisplay().workArea;
  const position = settings.position || { x: area.x + area.width - dimensions().width, y: area.y + area.height - dimensions().height };
  setWidgetPosition(position.x, position.y); applyWindowSettings(); save();
  try { await created.loadFile(path.join(__dirname, 'index.html')); }
  catch (error) { if (!created.isDestroyed() || quitting) throw error; }
  if (widget === created && !created.isDestroyed()) {
    if (widgetManuallyHidden) hide(); else show();
    broadcast();
  }
  return created;
}
function secureWindow(win) {
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', event => event.preventDefault());
  win.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
}
function action(name) {
  switch (name) {
    case 'show': show(); break;
    case 'hide': hide(); break;
    case 'refresh': return refresh();
    case 'bounce': widget.webContents.send('bounce'); break;
    case 'settings': openSettings(); break;
    default: throw new Error(t('未知操作'));
  }
}
let conversationServices;
function passiveConversationServices() {
  if (!conversationServices) {
    const { ConversationReader } = require('./conversation-reader.cjs');
    const { ConversationStatus } = require('./conversation-status.cjs');
    const { ActiveConversationDetector } = require('./active-conversation.cjs');
    const { ConversationTarget } = require('./conversation-target.cjs');
    const { ProjectLabels } = require('./project-labels.cjs');
    const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
    const reader = new ConversationReader({
      codexHome,
      selectionFile: path.join(dataDir, 'conversation-selection.json'),
    });
    const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    const logRoots = process.platform === 'darwin' ? [path.join(os.homedir(), 'Library', 'Logs', 'com.openai.codex')]
      : [path.join(local, 'Codex', 'Logs'), path.join(local, 'Packages', 'OpenAI.Codex_2p2nqsd0c76g0', 'LocalCache', 'Local', 'Codex', 'Logs')];
    let fallbackInventory, fallbackObservedAt = 0;
    const detector = new ActiveConversationDetector({ logRoots, getProcesses: async () => {
      let inventory = readDesktopObservation({ dataDir, executable: process.execPath, version: app.getVersion() });
      if (!inventory.known) {
        if (!fallbackInventory?.known || Date.now() - fallbackObservedAt < 0 || Date.now() - fallbackObservedAt > 1500) {
          fallbackInventory = await require('./codex-desktop.cjs').queryCodexDesktop({ timeout: 1000 });
          fallbackObservedAt = Date.now();
        }
        inventory = fallbackInventory;
      }
      if (inventory.known && inventory.roots.some(({ pid }) => { try { process.kill(pid, 0); return false; } catch { return true; } })) {
        return { known: false, roots: [] };
      }
      return inventory;
    } });
    const target = new ConversationTarget({ reader, detector, modeFile: path.join(dataDir, 'conversation-mode.json') });
    const projectLabels = new ProjectLabels({ codexHome });
    conversationServices = { reader, target, status: new ConversationStatus({
      resolveSelected: () => target.resolve(), readContext: selection => reader.readContext(selection),
      readCompactions: selection => reader.readCompactions(selection),
      readProject: (cwd, threadId) => projectLabels.read(cwd, threadId),
    }) };
  }
  return conversationServices;
}
function setupIpc() {
  const trusted = event => event.sender === widget?.webContents || event.sender === settingsWindow?.webContents || event.sender === chatWindow?.webContents;
  const handle = (name, callback) => ipcMain.handle(name, (event, ...args) => {
    if (!trusted(event)) throw new Error(t('无效窗口'));
    const localizedError = error => {
      if (error && typeof error.message === 'string') error.message = t(error.message);
      throw error;
    };
    try {
      const result = callback(event, ...args);
      return result && typeof result.then === 'function' ? result.catch(localizedError) : result;
    } catch (error) { return localizedError(error); }
  });
  handle('state', () => state());
  handle('widget-input-active', async (event, active, source) => {
    if (event.sender !== widget?.webContents || event.senderFrame !== event.sender.mainFrame ||
        typeof active !== 'boolean' || !['pointer', 'focus', 'blur'].includes(source)) throw new Error(t('无效窗口'));
    const win = widget, mode = windowMode, sequence = ++widgetInputSequence;
    const needsActivation = active && (mode?.nativeChild || mode?.inputDetached);
    const ready = await mode?.setInputActive(active);
    if (!active || !needsActivation) return ready !== false;
    if (!ready || sequence !== widgetInputSequence || quitting || widget !== win || win.isDestroyed()) return false;
    const foregroundAllowed = await mode.canActivateInput();
    if (sequence !== widgetInputSequence || quitting || widget !== win || win.isDestroyed()) return false;
    const point = screen.getCursorScreenPoint(), bounds = win.getBounds();
    const pointerInside = point.x >= bounds.x && point.x < bounds.x + bounds.width && point.y >= bounds.y && point.y < bounds.y + bounds.height;
    const anotherWindowFocused = [settingsWindow, chatWindow].some(other => other && !other.isDestroyed() && other.isFocused?.());
    if (!foregroundAllowed || anotherWindowFocused || (!win.isFocused?.() && !pointerInside)) {
      await mode.setInputActive(false); return false;
    }
    if (mode?.nativeChild) { win.webContents.focus(); return true; }
    win.focus(); win.webContents.focus(); return true;
  });
  const chatHandle = (name, callback) => handle(name, (event, ...args) => {
    if (!event.senderFrame || event.senderFrame !== event.sender.mainFrame) throw new Error(t('无效窗口'));
    return callback(event, ...args);
  });
  chatHandle('chat-state', () => companionChat().getState());
  chatHandle('chat-open-manager', () => openChatManager());
  chatHandle('chat-choose-directory', async (_event, input = {}) => {
    const { inputObject, selectProjectDirectory } = require('./chat-service.cjs'); inputObject(input, ['mode']);
    return selectProjectDirectory({ dialog: { showOpenDialog: (win, options) => dialog.showOpenDialog(win, {...options,title:t(options.title)}) },
      window: chatWindow || settingsWindow || widget, mode: input.mode, getService: companionChat,
      defaultParent: () => require('./chat-project.cjs').defaultChatParent() });
  });
  chatHandle('chat-initialize', (_event, input) => companionChat().initialize(input));
  chatHandle('chat-memory', (_event, input) => companionChat().getMemory(input));
  chatHandle('chat-memory-save', (_event, input) => companionChat().saveMemory(input));
  chatHandle('chat-draft', (_event, input) => companionChat().setDraft(input));
  chatHandle('chat-send', (_event, input) => companionChat().send(input));
  chatHandle('chat-models', () => companionChat().listModels());
  chatHandle('chat-configure', (_event, input) => companionChat().configure(input));
  chatHandle('chat-choose-images', () => require('./chat-native-input.cjs').chooseImages({dialog,window:chatWindow || widget,stageImages:input=>companionChat().stageImages(input)}));
  chatHandle('chat-paste-image', () => require('./chat-native-input.cjs').pasteImage({clipboard:require('electron').clipboard,stageImages:input=>companionChat().stageImages(input)}));
  chatHandle('chat-drop-images', (_event, input) => companionChat().dropImages(input));
  chatHandle('chat-steer', (_event, input) => companionChat().steer(input));
  chatHandle('chat-messages', (_event, input) => companionChat().messages(input));
  chatHandle('chat-usage', (_event, input) => companionChat().listUsage(input));
  chatHandle('chat-history-update', (_event, input) => companionChat().updateHistoryMetadata(input));
  chatHandle('chat-history-overview', (_event, input) => companionChat().historyOverview(input));
  chatHandle('chat-history-list', (_event, input) => companionChat().listHistory(input));
  chatHandle('chat-history-read', (_event, input) => companionChat().readHistory(input));
  chatHandle('chat-reference', (_event, input) => companionChat().resolveReference(input));
  chatHandle('chat-memory-history', (_event, input) => companionChat().memoryHistory(input));
  chatHandle('chat-memory-revision', (_event, input) => companionChat().memoryRevision(input));
  chatHandle('chat-memory-restore', (_event, input) => companionChat().restoreMemory(input));
  chatHandle('chat-persona-defaults', (_event, input) => companionChat().restorePersonaDefaults(input));
  chatHandle('chat-maintenance', (_event, input) => companionChat().maintenance(input));
  chatHandle('chat-relocate', (_event, input) => companionChat().relocateProject(input));
  chatHandle('chat-dream-command', (_event, input) => companionChat().dream(input));
  chatHandle('chat-interrupt', () => companionChat().interrupt());
  chatHandle('chat-reconcile', () => companionChat().reconcile());
  chatHandle('chat-dream', () => companionChat().activeDream());
  handle('refresh', () => refresh());
  handle('refresh-reset-forecast', () => resetForecastSource?.refresh());
  handle('open-reset-source', () => require('electron').shell.openExternal('https://codex-reset.com/'));
  handle('list-conversations', () => passiveConversationServices().target.list());
  handle('select-conversation', async (_event, id) => {
    const services = passiveConversationServices();
    services.status.invalidate();
    const result = await services.target.select(id);
    services.status.invalidate();
    return result;
  });
  handle('inspect-conversation', () => passiveConversationServices().status.read());
  handle('list-accounts', () => accountManagement());
  handle('rename-account', (_event, id, label) => {
    if (demoMode || !accountRegistry) return accountManagement();
    accountRegistry.rename(id, label);
    broadcast(); return accountManagement();
  });
  handle('remove-account', (_event, id) => {
    if (demoMode || !accountRegistry) return accountManagement();
    accountRegistry.remove(id);
    accountAlarm?.check(); broadcast(); return accountManagement();
  });
  handle('settings', (event, patch) => {
    if (event.sender !== settingsWindow?.webContents && event.sender !== widget.webContents) throw new Error(t('无效窗口'));
    return updateSettings(patch);
  });
  handle('preview-appearance', (event, patch) => {
    if (!settingsWindow || settingsWindow.isDestroyed() || event.sender !== settingsWindow.webContents ||
      (!event.senderFrame || event.senderFrame !== settingsWindow.webContents.mainFrame)) throw new Error(t('无效窗口'));
    return previewAppearance(patch);
  });
  handle('preview-corner-peek', (event, patch) => {
    if (!settingsWindow || settingsWindow.isDestroyed() || event.sender !== settingsWindow.webContents ||
      (!event.senderFrame || event.senderFrame !== settingsWindow.webContents.mainFrame)) throw new Error(t('无效窗口'));
    return previewCornerPeek(patch);
  });
  handle('action', (_event, name) => action(name));
  handle('import-characters', async () => {
    const result = await dialog.showOpenDialog(settingsWindow || widget, { title: t('导入形象（可多选，推荐透明 PNG）'), properties: ['openFile','multiSelections'], filters: [{ name: t('图片'), extensions: ['png','webp','jpg','jpeg','gif'] }] });
    if (result.canceled) return { state: state(), importedCount: 0, existingCount: 0, errors: [] };
    const imported = await importCharacterFiles(result.filePaths);
    updateTray(); broadcast();
    return { state: state(), importedCount: imported.imported.length, existingCount: imported.existing.length, errors: imported.errors.map(error => ({ ...error, message: t(error.message) })) };
  });
  handle('select-character', (_event,id) => selectCharacter(id));
  handle('rename-character', (_event,id,name) => { library.rename(id,name); updateTray(); broadcast(); return state(); });
  handle('remove-character', (_event,id) => {
    library.remove(id);
    if (settings.activeCharacterId === id) { settings.activeCharacterId = library.defaultId; save(); }
    updateTray(); broadcast(); return state();
  });
  ipcMain.on('drag-start', event => {
    if (event.sender !== widget.webContents || settings.clickThrough) return;
    if (settings.stayInCodexWindow && !windowMode?.getArea()) return;
    const bounds = windowMode?.enabled ? windowMode.getBounds() : widget.getBounds();
    cancelPose();
    const offset = visualPoseState().offset;
    const visual = { x: bounds.x + offset.x, y: bounds.y + offset.y };
    if (visualMotion) visualMotion.phase = 'hold';
    const cursor = screen.getCursorScreenPoint();
    drag = { cursor, lastCursor: { ...cursor }, area: poseArea(visual), origin: [bounds.x, bounds.y], visualOrigin: visual, visual,
      poseMode: settings.peekAtCorners || !!visualMotion, moved: false };
    widget.setIgnoreMouseEvents(false);
  });
  ipcMain.on('drag-move', event => {
    if (event.sender !== widget.webContents || !drag) return;
    const firstMove = !drag.moved; drag.moved = true;
    const cursor = screen.getCursorScreenPoint();
    if (drag.poseMode) {
      rebasePoseDrag();
      drag.visual = { x: drag.visualOrigin.x + cursor.x - drag.cursor.x, y: drag.visualOrigin.y + cursor.y - drag.cursor.y };
      applyVisualPose(drag.visual, 'drag');
      drag.lastCursor = { ...cursor };
      return;
    }
    setWidgetPosition(drag.origin[0] + cursor.x - drag.cursor.x, drag.origin[1] + cursor.y - drag.cursor.y);
    if (firstMove) broadcast();
  });
  ipcMain.on('drag-end', event => {
    if (event.sender !== widget.webContents || !drag) return;
    rebasePoseDrag();
    const ended = drag;
    drag = null;
    if (ended.poseMode) {
      const area = poseArea(ended.visual);
      if (!area) { cancelPose(true); broadcast(); return; }
      const p = snapBounds({ ...ended.visual, ...dimensions() }, area);
      saveDraggedPosition(p, area);
      settleVisualPose(ended.visual, p, area);
      return;
    }
    const bounds = { ...(windowMode?.enabled ? windowMode.getBounds() : widget.getBounds()), ...dimensions() };
    const area = windowMode?.enabled ? windowMode.getArea() : screen.getDisplayMatching(bounds).workArea;
    if (!area) return;
    const p = snapBounds(bounds, area);
    saveDraggedPosition(p, area);
    setWidgetPosition(p.x, p.y); broadcast();
  });
  ipcMain.on('pointer-region', (event, inside) => {
    if (event.sender === widget.webContents && !settings.clickThrough && !drag) widget.setIgnoreMouseEvents(!inside, { forward: true });
  });
}
async function startControl() {
  const token = crypto.randomBytes(32).toString('hex');
  controlServer = http.createServer(async (req, res) => {
    // A disconnected local client must not let an async body-read rejection
    // escape this request listener or write to a response already destroyed.
    res.on('error', () => {});
    const reply = (status, body) => {
      if (res.destroyed || res.writableEnded) return;
      try { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(body); }
      catch { res.destroy(); }
    };
    try {
    if (req.headers.origin || req.headers.authorization !== `Bearer ${token}`) { reply(403, '{"error":"Forbidden"}'); return; }
    if (req.method === 'GET' && req.url === '/status') {
      const character = state();
      reply(200, JSON.stringify({ ...snapshot, resetForecast: resetForecastSource?.snapshot(), visible: widget.isVisible(), demo: demoMode, version: app.getVersion(), activeCharacterId: character.activeCharacterId, characterName: character.characterName, characterCount: character.characters.length, followCodex:settings.followCodex, followSupported, followError, stayInCodexWindow:settings.stayInCodexWindow, windowContainment:windowModeState() })); return;
    }
    if (req.method !== 'POST' || req.url !== '/action') { reply(404, '{}'); return; }
    let body = '';
    for await (const chunk of req) { body += chunk; if (body.length > 2048) { reply(413, '{}'); return; } }
    const input = JSON.parse(body); await action(input.action); reply(200, JSON.stringify({ ok: true }));
    } catch { reply(400, '{"error":"Invalid action"}'); }
  });
  await new Promise((resolve, reject) => { controlServer.once('error', reject); controlServer.listen(0, '127.0.0.1', resolve); });
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'control.json'), JSON.stringify({ port: controlServer.address().port, token, pid: process.pid }), { mode: 0o600 });
  ownsControl = true;
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => widget && show());
  app.whenReady().then(async () => {
    configureMacApp(app);
    library = new CharacterLibrary({ dataDir, assetRoot: path.join(root,'assets'), validateImage: file => {
      if (/\.(gif|webp)$/i.test(file)) return; // Decoded by validateBrowserImage before import/migration.
      const decoded = nativeImage.createFromPath(file);
      if (decoded.isEmpty()) throw new Error(t('无法读取这张图片，请选择有效的 PNG、WebP、GIF 或 JPEG。'));
      const size = decoded.getSize();
      if (size.width > 16384 || size.height > 16384 || size.width * size.height > 64000000) throw new Error(t('图片尺寸过大，请先缩小图片后导入。'));
    } });
    if (!library.get(settings.activeCharacterId)?.available) settings.activeCharacterId = library.defaultId;
    // The user explicitly authorized this local read-only profile lookup.
    // Source/demo runs do not read credentials for nickname metadata.
    source = new CodexDataSource({ profileMetadata: app.isPackaged && !demoMode,
      profileFetch: app.isPackaged && !demoMode ? (url, options) => net.fetch(url, options) : undefined });
    if (!demoMode) {
      const { AccountRegistry } = require('./account-registry.cjs');
      const { AccountAlarm } = require('./account-alarm.cjs');
      accountRegistry = new AccountRegistry({ file: path.join(dataDir, 'account-registry.json') });
      accountAlarm = new AccountAlarm({ registry: accountRegistry, enabled: () => settings.accountResetAlerts !== false,
        notify: notifyAccountReset });
    }
    if (!demoMode) stopAuthWatch = watchAuthChanges(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), authChanged);
    resetForecastSource = new (require('./reset-forecast.cjs').ResetForecast)({
      file: path.join(dataDir, 'reset-forecast-cache.json'), version: app.getVersion(), demo: demoMode,
      fetch: (url, options) => net.fetch(url, options), onChange: () => { if (!quitting) broadcast(); } });
    setupIpc(); await createWidget();
    if (settings.characterPath && fs.existsSync(settings.characterPath)) {
      try {
        await validateBrowserImage(settings.characterPath);
        const legacy = library.migrateLegacy(settings.characterPath);
        if (legacy) { settings.activeCharacterId = legacy.id; settings.characterPath = ''; save(); }
      } catch {
        // Keep the original path for recovery; an invalid old picture must not block startup.
      }
    }
    // On Windows the ICO path lets Electron request an actual DPI-sized HICON.
    // A composed PNG NativeImage uses its 1x bitmap in this Electron version,
    // which Windows then enlarges and blurs on high-DPI displays.
    tray = new Tray(trayImage({ root, nativeImage }));
    tray.setToolTip(t('Codex 女仆 · 额度与陪伴')); tray.on('click', show); updateTray();
    screen.on('display-removed', () => resetPosition());
    globalShortcut.register('Control+Alt+M', () => widget.isVisible() ? hide() : show());
    globalShortcut.register('Control+Alt+Q', () => action('bounce'));
    globalShortcut.register('Control+Alt+Shift+M', () => updateSettings({ clickThrough: !settings.clickThrough }));
    await startControl(); show(); schedule(); refresh(); accountAlarm?.start();
    resetForecastSource.setEnabled(!settings.bubbleHiddenPages?.includes('resetForecast'));
  }).catch(error => { dialog.showErrorBox(t('Codex 女仆启动失败'), t(error.message)); app.quit(); });
}
app.on('window-all-closed', () => {});
app.on('activate', () => { if (widget && !widget.isDestroyed()) show(); });
app.on('before-quit', event => {
  if (chatService?.hasPendingDrafts()) {
    const response = dialog.showMessageBoxSync(chatWindow && !chatWindow.isDestroyed() ? chatWindow : widget, {
      type: 'warning', message: t('有未发送的消息或未保存的编辑。'),
      detail: t('退出会放弃这些运行中草稿；已保存的项目和记忆不受影响。'),
      buttons: [t('返回处理'), t('复制并返回'), t('放弃草稿并退出')], defaultId: 0, cancelId: 0 });
    if (response !== 2) { event.preventDefault(); if (response === 1) require('electron').clipboard.writeText(chatService.copyPendingDrafts()); openChatManager(); return; }
    chatService.discardDrafts();
  }
  if (chatService && !chatQuitPrepared) {
    event.preventDefault();
    if (chatQuitPreparing) return;
    chatQuitPreparing = true;
    const showUnconfirmed = () => {
      dialog.showErrorBox(t('聊天退出核对未完成'), t('上次请求状态尚未确认，已保留定位，下次启动后可继续核对。'));
    };
    Promise.resolve().then(() => chatService.prepareClose()).then(result => {
      if (result?.terminalConfirmed === false) showUnconfirmed();
    }, showUnconfirmed).finally(() => {
      chatQuitPrepared = true; chatQuitPreparing = false; app.quit();
    });
    return;
  }
  try { chatService?.close(); } catch { event.preventDefault(); return; }
  cancelPose(true);
  accountAlarm?.close();
  quitting = true; resetForecastSource?.close(); clearInterval(timer); clearTimeout(authRefreshTimer); windowMode?.close(); stopAuthWatch?.(); desktopMonitor?.stop(); globalShortcut.unregisterAll(); source?.close(); controlServer?.close();
  if (ownsControl) try { fs.unlinkSync(path.join(dataDir, 'control.json')); } catch {}
});
