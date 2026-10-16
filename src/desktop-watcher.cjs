'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn: nativeSpawn } = require('node:child_process');
const { CodexDesktopMonitor, createDesktopInventoryQuery, buildLaunchArgs, rootKey } = require('./codex-desktop.cjs');
const { isFollowStartupEnabled } = require('./windows-launch.cjs');
const { DesktopObservationWriter } = require('./desktop-observation.cjs');

function followPreference(settingsFile) {
  try {
    const value = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    if (value.followCodex === undefined || value.followCodex === true) return true;
    return value.followCodex === false ? false : null;
  }
  catch { return null; }
}
function followsCodex(settingsFile) { return followPreference(settingsFile) === true; }
function startupRequestId(args) {
  const flag = Array.isArray(args) && args.find(value => typeof value === 'string' && value.startsWith('--follow-request='));
  return flag ? flag.slice('--follow-request='.length) : '';
}

function syncFollowStartup({ app, enabled, executable, dataDir, packaged, platform = process.platform }) {
  if (platform !== 'win32' || !packaged) return { loginStartupEnabled: false, loginStartupError: 'unsupported-platform' };
  try {
    // This helper is owned by Explorer, so these writes affect the real user
    // startup registry rather than a launching Store app's virtual registry.
    app.setLoginItemSettings({ openAtLogin: false, path: executable });
    const args = ['--watch-codex', '--maid-home=' + dataDir];
    app.setLoginItemSettings({ openAtLogin: enabled, enabled, name: 'CodexMaidFollow', path: executable, args });
    const startup = app.getLoginItemSettings({ path: executable, args });
    const actual = isFollowStartupEnabled(startup, executable);
    return { loginStartupEnabled: actual, loginStartupError: actual === enabled ? '' : enabled ? 'startup-disabled' : 'startup-removal-failed' };
  } catch {
    return { loginStartupEnabled: false, loginStartupError: 'startup-registration-failed' };
  }
}

// Track desktop processes instead of the widget process. A manual tray exit or
// widget crash therefore stays closed until a new Codex desktop session starts.
class DesktopLaunchGate {
  constructor(launch) { this.launch = launch; this.seen = new Set(); }
  update(roots) {
    if (!roots.length) { this.seen.clear(); return false; }
    const next = new Set(roots.map(rootKey));
    const added = [...next].some(key => !this.seen.has(key));
    this.seen = next;
    if (added) this.launch();
    return added;
  }
}

function writeWatcherRecord(file, record) {
  const temporary = `${file}.${record.pid}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    fs.writeFileSync(temporary, JSON.stringify(record));
    fs.renameSync(temporary, file);
  } finally {
    try { fs.unlinkSync(temporary); } catch {}
  }
}

function run({ app, dataDir, settingsFile, executable = process.execPath, appRoot, packaged = true, platform = process.platform, argv = process.argv, query, spawn = nativeSpawn, intervalMs = 2500 } = {}) {
  const watcherDir = path.join(dataDir, 'watcher');
  const recordFile = path.join(dataDir, 'watcher.json');
  fs.mkdirSync(watcherDir, { recursive: true });
  app.setPath('userData', watcherDir);
  app.disableHardwareAcceleration();
  if (!app.requestSingleInstanceLock()) { app.quit(); return null; }
  const inventory = query ? { query, close() {} } : createDesktopInventoryQuery({ platform });
  const observations = new DesktopObservationWriter({ dataDir, executable, version: app.getVersion() });
  let stopped = false;
  let ready = false;
  let pendingRequestId = startupRequestId(argv);
  let monitor;
  const startedAt = new Date().toISOString();
  const stop = () => {
    stopped = true;
    monitor?.stop();
    inventory.close();
    try {
      const record = JSON.parse(fs.readFileSync(recordFile, 'utf8'));
      if (record.pid === process.pid) fs.unlinkSync(recordFile);
    } catch {}
  };
  app.on('before-quit', stop);
  const synchronize = (requestId = '') => {
    if (stopped) return false;
    const enabled = followPreference(settingsFile);
    // A broken/unavailable config is not an explicit request to change the
    // user's startup entries. Stop safely without modifying those entries.
    if (enabled === null) { app.quit(); return false; }
    const startup = syncFollowStartup({ app, enabled, executable, dataDir, packaged, platform });
    writeWatcherRecord(recordFile, { pid: process.pid, executable, startedAt, version: app.getVersion(), ...startup });
    if (requestId) {
      // Keep this acknowledgement after a disabled helper exits. It proves the
      // requested change reached the real registry, rather than just Explorer.
      writeWatcherRecord(path.join(dataDir, 'follow-startup.json'), { requestId, pid: process.pid, version: app.getVersion(), executable, ...startup });
    }
    if (!enabled) { app.quit(); return false; }
    return true;
  };
  app.on('second-instance', (_event, commandLine) => {
    if (stopped) return;
    const requestId = startupRequestId(commandLine);
    if (!ready) { if (requestId) pendingRequestId = requestId; return; }
    try { synchronize(requestId); } catch { app.quit(); }
  });
  const gate = new DesktopLaunchGate(() => {
    if (stopped || !followsCodex(settingsFile)) return;
    try {
      const child = spawn(executable, buildLaunchArgs({ packaged, appRoot, flag: '--follow-codex' }), {
        cwd: packaged ? path.dirname(executable) : appRoot,
        detached: true, windowsHide: true, stdio: 'ignore',
      });
      child.once('error', () => {});
      child.unref();
    } catch {}
  });
  app.whenReady().then(() => {
    ready = true;
    if (!synchronize(pendingRequestId)) return;
    monitor = new CodexDesktopMonitor({ intervalMs, query: async () => {
      if (!followsCodex(settingsFile)) {
        synchronize();
        return { known: false, roots: [], reason: 'disabled' };
      }
      const result = await inventory.query();
      if (!stopped) observations.publish(result);
      return result;
    }, onChange: roots => { if (!stopped) gate.update(roots); } });
    monitor.start();
  }).catch(() => app.quit());
  return { stop, get monitor() { return monitor; } };
}

module.exports = { run, DesktopLaunchGate, followsCodex, writeWatcherRecord, syncFollowStartup };
