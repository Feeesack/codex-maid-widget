'use strict';
const { app, BrowserWindow, ipcMain, screen, Tray, Menu, nativeImage, globalShortcut, dialog } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const os = require('node:os');
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
let widget, settingsWindow, tray, source, timer, controlServer, library, desktopMonitor, stopAuthWatch, authRefreshTimer;
let followRegistered = null, followLaunchGeneration = 0, refreshGeneration = 0;
let followOperation = Promise.resolve();
const followSupported = supportsDesktopFollow({ packaged: app.isPackaged, demo: demoMode });
let followError = '';
let connectingPlugin = false;
let snapshot = { status: 'connecting', buckets: [], today: null, lastTurn: null };
let quitting = false, drag = null, refreshing = null, ownsControl = false;
let windowMode = null;
let widgetManuallyHidden = false;
let lastCorner = null;
let visualMotion = null, poseTimer = null, poseResume = null, poseEpoch = 0;
function save() { writeSettings(settingsFile, settings); }
function state() {
  const characters = library.list();
  const active = characters.find(item => item.id === settings.activeCharacterId && item.available) || characters.find(item => item.id === library.defaultId);
  const dock = cornerDockState();
  return { settings, snapshot, demo: demoMode, version: app.getVersion(), platform: process.platform, characters, followSupported, followError, windowContainment: windowModeState(), cornerDock: dock, visualPose: visualPoseState(dock),
    activeCharacterId: active.id, characterUrl: active.url, characterName: active.name };
}
function broadcast() {
  for (const win of [widget, settingsWindow]) if (win && !win.isDestroyed()) win.webContents.send('state', state());
}
function dimensions() { return widgetDimensions(settings.scale); }
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
  return { offset: visualMotion ? { ...visualMotion.offset } : cornerPeekOffset(dock.peeking ? dock.corner : null, dimensions()), moving: !!visualMotion };
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
  const offset = cornerPeekOffset(settings.peekAtCorners ? bottomCorner({ ...canonical, ...size }, area) : null, size);
  const target = { x: canonical.x + offset.x, y: canonical.y + offset.y };
  if (Math.hypot(target.x - from.x, target.y - from.y) < 0.01) {
    visualMotion = null; setWidgetPosition(canonical.x, canonical.y); broadcast(); return;
  }
  const frame = () => {
    if (epoch !== poseEpoch || quitting || !widget || widget.isDestroyed()) return;
    const liveArea = poseArea(target);
    // Keep the composed child unchanged while its host minimizes or is unknown.
    if (!liveArea) { poseTimer = null; poseResume = frame; return; }
    const position = { x: Math.round(liveArea.x + anchor.x * (liveArea.width - size.width)),
      y: Math.round(liveArea.y + anchor.y * (liveArea.height - size.height)) };
    const inset = cornerPeekOffset(settings.peekAtCorners ? bottomCorner({ ...position, ...size }, liveArea) : null, size);
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
  if (!widget || widget.isDestroyed()) return false;
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
  if (!windowMode && settings.stayInCodexWindow) {
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
  widget.setAlwaysOnTop(settings.stayInCodexWindow ? false : settings.alwaysOnTop, 'floating');
  widget.setOpacity(settings.opacity);
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
  cancelPose(true);
  if (drag?.poseMode) drag = null;
  // File paths and window positions are only set by trusted native actions.
  const { characterPath, activeCharacterId, position, ...safe } = patch || {};
  settings = sanitize({ ...settings, ...safe });
  save(); applyWindowSettings(); schedule(); broadcast();
  return state();
}
function updateTray() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示女仆 · Ctrl+Alt+M', click: show },
    { label: '刷新额度', click: () => refresh() },
    { label: '切换形象', submenu: characterMenuItems() },
    { label: '设置', click: openSettings },
    ...(process.platform === 'darwin' ? [{ label: '连接 Codex 工具…', click: connectCodexPlugin }] : []),
    { type: 'separator' },
    { label: '鼠标穿透 · Ctrl+Alt+Shift+M', type: 'checkbox', checked: settings.clickThrough, click: i => updateSettings({ clickThrough: i.checked }) },
    { label: '始终置顶', type: 'checkbox', checked: settings.alwaysOnTop, click: i => updateSettings({ alwaysOnTop: i.checked }) },
    { label: '仅在 Codex 窗口内显示', type: 'checkbox', checked: settings.stayInCodexWindow, click: i => updateSettings({ stayInCodexWindow: i.checked }) },
    { label: '重置位置', click: resetPosition },
    { label: '隐藏挂件', click: hide },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ]));
}
async function connectCodexPlugin() {
  if (connectingPlugin) return;
  connectingPlugin = true;
  try {
    const connector = path.join(process.resourcesPath, 'integration', 'connect.cjs');
    if (!fs.existsSync(connector)) {
      await dialog.showMessageBox({ type: 'info', message: '连接工具随 Mac 安装包提供。', detail: '请安装完整应用后，从菜单栏选择“连接 Codex 工具”。' });
      return;
    }
    const answer = await dialog.showMessageBox({ type: 'question', message: '将女仆挂件连接到 Codex？',
      detail: '这会在本机注册并安装女仆插件，让 Codex 对话可以读取挂件状态、刷新额度和互动。完成后请重启 Codex 并新建聊天。',
      buttons: ['连接', '取消'], defaultId: 0, cancelId: 1 });
    if (answer.response !== 0) return;
    const result = await new Promise(resolve => {
      execFile(process.execPath, [connector, '--install'], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', CODEX_MAID_HOME: dataDir },
        timeout: 90000, maxBuffer: 256 * 1024, windowsHide: true,
      }, (error, stdout) => {
        try {
          const value = JSON.parse(stdout);
          resolve({ ok: !error && value.ok === true, message: typeof value.message === 'string' ? value.message.slice(0, 2000) : '' });
        } catch { resolve({ ok: false, message: '连接未完成。请确认已安装最新 Codex，然后从菜单栏重试。' }); }
      });
    });
    await dialog.showMessageBox({ type: result.ok ? 'info' : 'error', message: result.ok ? 'Codex 工具已连接' : 'Codex 工具连接未完成', detail: result.message });
  } finally { connectingPlugin = false; }
}
function characterMenuItems() {
  const activeId = state().activeCharacterId;
  return [
    ...library.list().map(item => ({ label: item.name.replace(/&/g,'&&'), type: 'radio', checked: item.id === activeId, enabled: item.available, click: () => selectCharacter(item.id) })),
    { type: 'separator' },
    { label: '管理形象…', click: openSettings },
  ];
}
function selectCharacter(id) {
  const item = library.get(id);
  if (!item || !item.available) throw new Error('该形象不存在或图片已损坏，请重新导入。');
  settings.activeCharacterId = item.id;
  settings.characterPath = '';
  save(); updateTray(); broadcast();
  return state();
}
async function validateBrowserImage(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw new Error('请选择本地图片。');
  const info = fs.statSync(file);
  if (!info.isFile() || info.size > 15 * 1024 * 1024) throw new Error('请选择小于 15 MB 的图片。');
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
  if (!decoded?.width || !decoded?.height) throw new Error('无法读取这张图片，请重新导出后导入。');
  if (decoded.width > 16384 || decoded.height > 16384 || decoded.width * decoded.height > 64000000) throw new Error('图片尺寸过大，请先缩小图片后导入。');
}
async function importCharacterFiles(paths) {
  const result = {imported:[],existing:[],errors:[]};
  for (const file of paths) {
    try {
      await validateBrowserImage(file);
      const next = library.importFiles([file]);
      for (const key of Object.keys(result)) result[key].push(...next[key]);
    } catch(error) {
      result.errors.push({name:typeof file==='string'?path.basename(file):'图片',message:error.code==='ENOENT'?'图片不存在或已移动。':error.message});
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
      snapshot = next.error && !next.clearPrevious && !next.accountChanged && !next.buckets?.length && snapshot.buckets?.length
        ? { ...next, buckets: snapshot.buckets, updatedAt: snapshot.updatedAt, stale: true }
        : next;
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
  settingsWindow = new BrowserWindow({ width: 550, height: 760, minWidth: 470, minHeight: 520,
    icon: windowIcon,
    title: 'Codex 女仆 · 设置', backgroundColor: '#f5faf8', autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  secureWindow(settingsWindow);
  settingsWindow.loadFile(path.join(__dirname, 'settings.html'));
  settingsWindow.on('closed', () => { settingsWindow = null; });
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
    default: throw new Error('未知操作');
  }
}
function setupIpc() {
  const trusted = event => event.sender === widget?.webContents || event.sender === settingsWindow?.webContents;
  const handle = (name, callback) => ipcMain.handle(name, (event, ...args) => {
    if (!trusted(event)) throw new Error('无效窗口');
    return callback(event, ...args);
  });
  handle('state', () => state());
  handle('refresh', () => refresh());
  handle('settings', (event, patch) => {
    if (event.sender !== settingsWindow?.webContents && event.sender !== widget.webContents) throw new Error('无效窗口');
    return updateSettings(patch);
  });
  handle('action', (_event, name) => action(name));
  handle('import-characters', async () => {
    const result = await dialog.showOpenDialog(settingsWindow || widget, { title: '导入形象（可多选，推荐透明 PNG）', properties: ['openFile','multiSelections'], filters: [{ name: '图片', extensions: ['png','webp','jpg','jpeg','gif'] }] });
    if (result.canceled) return { state: state(), importedCount: 0, existingCount: 0, errors: [] };
    const imported = await importCharacterFiles(result.filePaths);
    updateTray(); broadcast();
    return { state: state(), importedCount: imported.imported.length, existingCount: imported.existing.length, errors: imported.errors };
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
      if (!windowMode?.enabled) settings.position = { x: p.x, y: p.y };
      settings.mirror = p.mirror; save();
      settleVisualPose(ended.visual, p, area);
      return;
    }
    const bounds = { ...(windowMode?.enabled ? windowMode.getBounds() : widget.getBounds()), ...dimensions() };
    const area = windowMode?.enabled ? windowMode.getArea() : screen.getDisplayMatching(bounds).workArea;
    if (!area) return;
    const p = snapBounds(bounds, area);
    if (!windowMode?.enabled) settings.position = { x: p.x, y: p.y };
    settings.mirror = p.mirror;
    setWidgetPosition(p.x, p.y); save(); broadcast();
  });
  ipcMain.on('pointer-region', (event, inside) => {
    if (event.sender === widget.webContents && !settings.clickThrough && !drag) widget.setIgnoreMouseEvents(!inside, { forward: true });
  });
}
async function startControl() {
  const token = crypto.randomBytes(32).toString('hex');
  controlServer = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    if (req.headers.origin || req.headers.authorization !== `Bearer ${token}`) { res.writeHead(403); res.end('{"error":"Forbidden"}'); return; }
    if (req.method === 'GET' && req.url === '/status') {
      const character = state();
      res.end(JSON.stringify({ ...snapshot, visible: widget.isVisible(), demo: demoMode, version: app.getVersion(), activeCharacterId: character.activeCharacterId, characterName: character.characterName, characterCount: character.characters.length, followCodex:settings.followCodex, followSupported, followError, stayInCodexWindow:settings.stayInCodexWindow, windowContainment:windowModeState() })); return;
    }
    if (req.method !== 'POST' || req.url !== '/action') { res.writeHead(404); res.end('{}'); return; }
    let body = '';
    for await (const chunk of req) { body += chunk; if (body.length > 2048) { res.writeHead(413); res.end('{}'); return; } }
    try { const input = JSON.parse(body); await action(input.action); res.end(JSON.stringify({ ok: true })); }
    catch { res.writeHead(400); res.end('{"error":"Invalid action"}'); }
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
      if (decoded.isEmpty()) throw new Error('无法读取这张图片，请选择有效的 PNG、WebP、GIF 或 JPEG。');
      const size = decoded.getSize();
      if (size.width > 16384 || size.height > 16384 || size.width * size.height > 64000000) throw new Error('图片尺寸过大，请先缩小图片后导入。');
    } });
    if (!library.get(settings.activeCharacterId)?.available) settings.activeCharacterId = library.defaultId;
    source = new CodexDataSource();
    if (!demoMode) stopAuthWatch = watchAuthChanges(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), authChanged);
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
    tray.setToolTip('Codex 女仆 · 额度与陪伴'); tray.on('click', show); updateTray();
    screen.on('display-removed', () => resetPosition());
    globalShortcut.register('Control+Alt+M', () => widget.isVisible() ? hide() : show());
    globalShortcut.register('Control+Alt+Q', () => action('bounce'));
    globalShortcut.register('Control+Alt+Shift+M', () => updateSettings({ clickThrough: !settings.clickThrough }));
    await startControl(); show(); schedule(); refresh();
  }).catch(error => { dialog.showErrorBox('Codex 女仆启动失败', error.message); app.quit(); });
}
app.on('window-all-closed', () => {});
app.on('activate', () => { if (widget && !widget.isDestroyed()) show(); });
app.on('before-quit', () => {
  cancelPose(true);
  quitting = true; clearInterval(timer); clearTimeout(authRefreshTimer); windowMode?.close(); stopAuthWatch?.(); desktopMonitor?.stop(); globalShortcut.unregisterAll(); source?.close(); controlServer?.close();
  if (ownsControl) try { fs.unlinkSync(path.join(dataDir, 'control.json')); } catch {}
});
