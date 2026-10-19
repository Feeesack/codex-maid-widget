'use strict';
require('./stdio-errors.cjs').installOutputErrorHandlers();

// Run with: npx --no-install electron scripts/capture-release-screenshots.cjs
// Every screenshot uses the shipped sandboxed preload and renderer. All IPC
// data is synthetic; this script never starts the production data readers.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const version = require('../package.json').version;
const outputDirectory = path.resolve(process.env.CODEX_MAID_SCREENSHOTS || path.join(root, 'docs', 'screenshots'));
const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'maid-release-capture-'));
for (const name of ['codex', 'maid', 'appdata', 'localappdata', 'temp']) fs.mkdirSync(path.join(isolatedHome, name));
process.env.CODEX_HOME = path.join(isolatedHome, 'codex');
process.env.CODEX_MAID_HOME = path.join(isolatedHome, 'maid');
process.env.HOME = process.env.USERPROFILE = isolatedHome;
process.env.APPDATA = path.join(isolatedHome, 'appdata');
process.env.LOCALAPPDATA = path.join(isolatedHome, 'localappdata');
process.env.TEMP = process.env.TMP = path.join(isolatedHome, 'temp');

const { app, BrowserWindow, ipcMain } = require('electron');
app.disableHardwareAcceleration();
app.setPath('userData', path.join(isolatedHome, 'maid'));
app.setPath('sessionData', path.join(isolatedHome, 'maid'));
const { sanitize, widgetDimensions } = require('../src/settings.cjs');
const { CharacterLibrary } = require('../src/character-library.cjs');
const library = new CharacterLibrary({ dataDir: path.join(isolatedHome, 'maid'), assetRoot: path.join(root, 'assets') });
let settings = sanitize({ scale: 1.6, sound: false, autoHideSeconds: 0, peekAtCorners: true, peekBottomPercent: 75, peekSidePercent: 110 });
let settingsRevision = 0;
const now = Math.floor(Date.now() / 1000);
const accounts = [
  { id: 'demo-personal', label: '演示账号 A', labelSource: 'manual', userEdited: true, current: true, planType: 'plus', scopeLabel: '个人', resetsAt: now + 5209, remainingPercent: 82, observedAt: now },
  { id: 'demo-studio', label: '演示账号 B', labelSource: 'manual', userEdited: true, current: false, planType: 'pro', scopeLabel: '个人', resetsAt: now - 1, remainingPercent: 36, observedAt: now - 240 },
];
const snapshot = {
  status: 'demo', updatedAt: new Date(now * 1000).toISOString(), account: { planType: '演示', authMode: 'demo' },
  buckets: [{ id: 'demo', name: '演示额度', primary: { usedPercent: 18, remainingPercent: 82, windowDurationMins: 300, resetsAt: now + 5209 }, secondary: { usedPercent: 36, remainingPercent: 64, windowDurationMins: 10080, resetsAt: now + 214449 }, credits: null }],
  today: { tokens: 128460, turns: 12, source: 'local', scope: 'device', date: '2026-10-19', complete: true },
  weekly: { tokens: 1268450, turns: 97, source: 'local', scope: 'device', complete: true },
  lastTurn: { tokens: 8420, scope: 'device', timestamp: new Date((now - 90) * 1000).toISOString() },
  accountManagement: { accounts },
};
const threads = [
  { id: 'demo-ui', title: '设计桌面挂件', workspaceLabel: '示例项目' },
  { id: 'demo-tests', title: '完善交互测试', workspaceLabel: '示例项目' },
];
let selectedId = 'demo-ui';
function state() {
  const active = library.get(settings.activeCharacterId);
  return { settings, settingsRevision, snapshot, cornerDock: { corner: null, peeking: false }, demo: true, version,
    characters: library.list(), activeCharacterId: active.id, characterUrl: active.url, characterName: active.name };
}
let win;
ipcMain.handle('state', () => state());
ipcMain.handle('refresh', () => snapshot);
ipcMain.handle('settings', (_event, patch) => {
  settings = sanitize({ ...settings, ...patch }); settingsRevision++;
  win.webContents.send('state', state()); return state();
});
ipcMain.handle('list-accounts', () => ({ accounts }));
ipcMain.handle('list-conversations', () => ({ threads, selectedId, selectionMode: 'auto' }));
ipcMain.handle('select-conversation', (_event, id) => { if (id) selectedId = id; return { selectedId, selectionMode: id ? 'manual' : 'auto', selectionRevision: 1 }; });
ipcMain.handle('inspect-conversation', () => ({ status: 'ready', selectionMode: 'auto', selectionRevision: 0,
  targetTitle: '设计桌面挂件', targetProject: '示例项目', targetProjectDetail: '示例项目',
  context: { status: 'ready', usedTokens: 51200, windowTokens: 200000, percent: 25.6 },
  git: { status: 'ready', count: 12 }, compaction: { status: 'ready', count: 4, complete: true } }));
ipcMain.handle('preview-corner-peek', () => state());
ipcMain.handle('preview-appearance', () => state());
ipcMain.handle('action', () => {});
ipcMain.handle('select-character', (_event, id) => { settings = sanitize({ ...settings, activeCharacterId: id }); settingsRevision++; win.webContents.send('state', state()); return state(); });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const evaluate = expression => win.webContents.executeJavaScript(expression);
const errors = [];
const captures = [];
const watchdog = setTimeout(() => { console.error('Screenshot capture timed out'); app.exit(1); }, 90000);
async function waitFor(expression) {
  for (let attempt = 0; attempt < 100; attempt++) {
    win.webContents.invalidate();
    if (await evaluate(expression)) return;
    await pause(30);
  }
  throw new Error('Screenshot renderer did not become ready');
}
function pngChunks(png) {
  const chunks = [];
  for (let offset = 8; offset + 12 <= png.length;) {
    const length = png.readUInt32BE(offset), type = png.toString('ascii', offset + 4, offset + 8);
    chunks.push(type); offset += length + 12;
  }
  return chunks;
}
async function capture(name, rect) {
  await pause(400);
  const image = await win.webContents.capturePage(rect);
  const png = image.toPNG();
  const chunks = pngChunks(png);
  assert.ok(!chunks.some(chunk => ['eXIf', 'tEXt', 'zTXt', 'iTXt'].includes(chunk)), 'Screenshots must not contain metadata text or EXIF');
  const file = `release-${version}-${name}.png`;
  fs.writeFileSync(path.join(outputDirectory, file), png);
  captures.push({ file, ...image.getSize(), bytes: png.length, sha256: crypto.createHash('sha256').update(png).digest('hex'), chunks });
  console.log(`Captured ${file}`);
}
async function captureSettingsSection(name, selector) {
  const bounds = await evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});el.scrollIntoView({block:'start'});window.scrollBy(0,-14);const r=el.getBoundingClientRect();return {x:Math.floor(r.x-10),y:Math.floor(r.y-8),width:Math.ceil(r.width+20),height:Math.ceil(r.height+16)};})()`);
  assert.ok(bounds.x >= 0 && bounds.y >= 0 && bounds.y + bounds.height <= 1100, 'Settings section must fit in the captured viewport');
  await capture(name, bounds);
}
app.whenReady().then(async () => {
  fs.mkdirSync(outputDirectory, { recursive: true });
  win = new BrowserWindow({ ...widgetDimensions(settings.scale), frame: false, show: false, transparent: true, backgroundColor: '#00000000',
    webPreferences: { preload: path.join(root, 'src', 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false } });
  win.webContents.on('console-message', (_event, details) => { if (details.level === 'error') errors.push(details.message); });
  win.webContents.on('preload-error', (_event, _file, error) => errors.push(error.message));
  await win.loadFile(path.join(root, 'src', 'index.html'));
  await waitFor(`typeof current==='object'&&current!==null&&document.getElementById('maid-image').naturalWidth>0&&document.getElementById('remaining').textContent==='82'`);
  await evaluate(`reveal()`);
  await pause(800);
  assert.equal(await evaluate(`typeof process==='undefined'&&typeof require==='undefined'&&!document.getElementById('demo-label').hidden`), true);
  await capture('quota');
  await evaluate(`document.getElementById('next-page').click()`);
  await waitFor(`document.getElementById('context-progress').textContent==='25.6%'&&document.getElementById('git-count').textContent==='12'`);
  await capture('conversation');
  await evaluate(`document.getElementById('next-page').click()`);
  await waitFor(`document.querySelectorAll('.account-card').length===2`);
  win.webContents.send('account-reset', { id: 'demo-studio', label: '演示账号 B', resetsAt: now - 1 });
  await pause(1100);
  assert.equal(await evaluate(`document.getElementById('notice').textContent.includes('演示账号 B')&&!document.getElementById('notice').hidden`), true);
  await capture('accounts');
  // Enable the switch for the settings illustration without playing a sample.
  settings = sanitize({ ...settings, sound: true }); settingsRevision++;
  win.setSize(660, 1100);
  await win.loadFile(path.join(root, 'src', 'settings.html'));
  await waitFor(`document.querySelectorAll('.character-card').length===4&&document.getElementById('version').textContent.includes(${JSON.stringify(version)})`);
  await evaluate(`Promise.all([...document.images].map(image=>image.decode().catch(()=>{})))`);
  await captureSettingsSection('characters', '#characters-section');
  // Change only the isolated fixture settings through the shipped UI controls.
  await evaluate(`document.getElementById('page-visible-lastTurn').click()`);
  await waitFor(`!document.getElementById('page-visible-lastTurn').checked&&!document.getElementById('page-default-conversation').disabled`);
  await evaluate(`document.getElementById('page-default-conversation').click()`);
  await waitFor(`document.getElementById('page-default-conversation').checked&&!document.getElementById('page-handle-conversation').disabled`);
  await evaluate(`document.getElementById('page-handle-conversation').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowUp',altKey:true,bubbles:true}))`);
  await pause(250);
  await captureSettingsSection('pages', 'main>section:nth-child(3)');
  // The full appearance section includes both edge widths and the sound preset.
  await captureSettingsSection('appearance', 'main>section:nth-child(4)');
  assert.deepEqual(errors, []);
  assert.equal(captures.length, 6);
  const report = { ok: true, version, syntheticDataOnly: true, productionRenderer: true, sandbox: true,
    explicitCharacterDataDirectory: true, noProductionDataReader: true, noUserSettingsWrites: true,
    accountAlarmFixture: true,
    sourceHashes: Object.fromEntries(['scripts/capture-release-screenshots.cjs', 'src/index.html', 'src/widget.js', 'src/widget.css', 'src/settings.html', 'src/settings.js', 'src/settings.css', 'src/preload.cjs'].map(file =>
      [file, crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')])), captures };
  if (process.env.CODEX_MAID_SCREENSHOT_REPORT) {
    const reportPath = path.resolve(process.env.CODEX_MAID_SCREENSHOT_REPORT);
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
  }
  console.log(`PASS: ${captures.length} capture records; synthetic data only; PNG metadata checked`);
  clearTimeout(watchdog); win.destroy(); app.exit(0);
}).catch(error => { console.error(error); clearTimeout(watchdog); app.exit(1); });
