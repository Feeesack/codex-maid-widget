'use strict';
// This separate-process host is exclusively for the isolated native check.
const { app, BrowserWindow, dialog } = require('electron');
const fs = require('node:fs'), path = require('node:path');
const config = JSON.parse(fs.readFileSync(process.env.CODEX_MAID_TEST_HOST, 'utf8'));
const profile = path.resolve(config.profile);
for (const name of ['userData', 'sessionData', 'crashDumps']) {
  const directory = path.join(profile, name); fs.mkdirSync(directory, { recursive: true }); app.setPath(name, directory);
}
for (const name of ['desktop', 'documents', 'downloads', 'pictures', 'music', 'videos']) {
  const directory = path.join(profile, name[0].toUpperCase() + name.slice(1)); fs.mkdirSync(directory, { recursive: true }); app.setPath(name, directory);
}
const pickerDirectory = path.join(profile, 'picker-fixture'); fs.mkdirSync(pickerDirectory, { recursive: true });
app.disableHardwareAcceleration(); app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  const host = new BrowserWindow({ ...config.bounds, show: false, backgroundColor: '#00b4f0',
    webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true, backgroundThrottling: false } });
  host.removeMenu();
  await host.loadURL('data:text/html,' + encodeURIComponent('<style>body{margin:0;background:#00b4f0;color:#123}h1{margin:24px}</style><h1>Isolated window mode test host</h1><textarea id="host-editor" aria-label="Synthetic host input"></textarea>'));
  if (config.focus) host.show(); else host.showInactive();
  fs.writeFileSync(config.readyFile, JSON.stringify({ pid: process.pid, id: host.getNativeWindowHandle().readBigUInt64LE().toString() }));
  let previous = 0;
  // Windows Electron does not reliably deliver process.stdin data events.
  setInterval(() => {
    let r; try { r = JSON.parse(fs.readFileSync(config.commandFile, 'utf8')); } catch { return; }
    if (!Number.isSafeInteger(r.id) || r.id <= previous) return; previous = r.id;
    try {
      if (r.action === 'bounds') host.setBounds(r.bounds);
      if (r.action === 'minimize') host.minimize();
      if (r.action === 'restore') { host.restore(); host.showInactive(); }
      if (r.action === 'hide') host.hide();
      if (r.action === 'show') host.showInactive();
      if (r.action === 'focus') { host.show(); host.focus(); }
      if (r.action === 'editor-focus-loop') void host.webContents.executeJavaScript('document.getElementById("host-editor").focus();window.editorFocusTimer=setInterval(()=>document.getElementById("host-editor").focus(),25)');
      if (r.action === 'editor-focus-stop') void host.webContents.executeJavaScript('clearInterval(window.editorFocusTimer)');
      if (r.action === 'picker') void dialog.showOpenDialog(host, { defaultPath: pickerDirectory, properties: ['openFile'] });
      if (r.action === 'close') host.destroy();
      fs.writeFileSync(config.responseFile, JSON.stringify({ id: r.id, ok: true, alive: !host.isDestroyed() }));
    } catch { fs.writeFileSync(config.responseFile, JSON.stringify({ id: r.id, ok: false })); }
  }, 25);
}).catch(() => app.exit(1));
