'use strict';
// Test-only bootstrap: exercise the production entry in real Electron processes,
// while keeping process inventory, accounts and Windows startup entries isolated.
const { app, dialog, globalShortcut } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');
const home = process.env.CODEX_MAID_HOME;
if (!home || process.env.CODEX_MAID_FOLLOW_CHECK !== '1') throw new Error('Use check-follow.cjs with its isolated temporary profile.');
app.setName('codex-maid-widget');
app.setPath('userData', home);
Object.defineProperty(app, 'isPackaged', { get: () => true });
app.getVersion = () => require('../package.json').version;
function log(file, value) { fs.appendFileSync(path.join(home, file), JSON.stringify(value) + '\n'); }
let followStartupEnabled=false;
app.setLoginItemSettings = options => {
  log('startup-entries.jsonl', { pid: process.pid, ...options });
  if(options.name==='CodexMaidFollow') followStartupEnabled=options.openAtLogin;
};
app.getLoginItemSettings = options => ({openAtLogin:followStartupEnabled,executableWillLaunchAtLogin:followStartupEnabled,
  launchItems:[{name:'CodexMaidFollow',path:options.path,enabled:followStartupEnabled}]});
globalShortcut.register = () => true;
globalShortcut.unregisterAll = () => {};
dialog.showErrorBox = (_title, message) => { log('errors.jsonl', { pid: process.pid, message }); app.quit(); };
const isWatcher = process.argv.includes('--watch-codex');
log('processes.jsonl', { pid: process.pid, role: isWatcher ? 'watcher' : 'widget' });
const spawn = childProcess.spawn;
childProcess.spawn = function (file, args, options) {
  if (file === process.execPath && args?.some(value => ['--watch-codex', '--follow-codex'].includes(value))) {
    const flags = args.filter(value => value === '--watch-codex' || value === '--follow-codex' || value.startsWith('--follow-request=') || value.startsWith('--maid-home='));
    const child = spawn(file, [__filename, ...flags], options);
    log('launches.jsonl', { parentPid: process.pid, pid: child.pid, args: flags, hidden: options.windowsHide === true });
    return child;
  }
  return spawn(file, args, options);
};
// Keep the real Explorer and user profile out of this simulated lifecycle test.
require('../src/windows-launch.cjs').launchThroughExplorer = ({executable,args,cwd}) => new Promise((resolve,reject) => {
  const child=childProcess.spawn(executable,args,{cwd,windowsHide:true,detached:true,stdio:'ignore'});
  child.once('spawn',resolve);child.once('error',reject);child.unref();
});
const lifecycle = require('../src/codex-desktop.cjs');
const query = async () => {
  try { return JSON.parse(fs.readFileSync(path.join(home, 'desktop-state.json'), 'utf8')); }
  catch { return { known: false, roots: [], reason: 'fixture-unavailable' }; }
};
const Monitor = lifecycle.CodexDesktopMonitor;
lifecycle.queryCodexDesktop = query;
lifecycle.createDesktopInventoryQuery = () => ({ query, close() {} });
lifecycle.CodexDesktopMonitor = class FixtureDesktopMonitor extends Monitor {
  constructor(options = {}) { super({ ...options, query: options.query || query, intervalMs: 80, graceMs: 150 }); }
};
const data = require('../src/codex-data.cjs');
data.CodexDataSource = class FixtureDataSource {
  async read() { return { ...require('../src/demo.cjs')(), status: 'live' }; }
  invalidate() {}
  close() {}
};
const authHome = path.join(home, 'auth-fixture');
fs.mkdirSync(authHome, { recursive: true });
process.env.CODEX_HOME = authHome;
let widget;
app.on('browser-window-created', (_event, win) => {
  win.on('show', () => win.hide());
  win.webContents.on('did-finish-load', () => {
    if (win.webContents.getURL().endsWith('/index.html')) widget = win;
  });
});
let requestBusy = false;
const commandTimer = setInterval(async () => {
  if (isWatcher) return;
  let request;
  try { request = JSON.parse(fs.readFileSync(path.join(home, 'widget-command.json'), 'utf8')); }
  catch { return; }
  if (request.pid !== process.pid) return;
  if (request.action === 'quit') { app.quit(); return; }
  if (requestBusy) return;
  if (request.action === 'disable-follow' && widget && !widget.isDestroyed()) {
    requestBusy = true;
    try {
      await widget.webContents.executeJavaScript('window.maid.setSettings({followCodex:false})');
      fs.writeFileSync(path.join(home, 'disabled-follow.json'), JSON.stringify({ pid: process.pid, ok: true }));
    } catch { log('errors.jsonl', { pid: process.pid, message: 'Could not disable follow through production IPC' }); }
  }
}, 80);
app.on('before-quit', () => clearInterval(commandTimer));
require('../src/entry.cjs');
