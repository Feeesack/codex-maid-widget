'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile: nativeExecFile, spawn: nativeSpawn } = require('node:child_process');

const MAC_WATCHER_LABEL = 'com.codex-maid-widget.follow';
const LAUNCH_ERROR = '无法通过 macOS 登录启动助手。';
const REMOVAL_ERROR = '无法移除 macOS 登录启动助手。';

function checkedString(value, name, { empty = false } = {}) {
  // XML 1.0 cannot represent these controls; paths and arguments never become
  // shell source, even if they contain quotes, newlines or XML metacharacters.
  if (typeof value !== 'string' || (!empty && !value.length) || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/u.test(value)) {
    throw new TypeError(`Invalid ${name}`);
  }
  return value;
}
function xmlString(value) {
  return checkedString(value, 'property list string', { empty: true })
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
function launchAgentFile(homeDir = os.homedir()) {
  checkedString(homeDir, 'home directory');
  return path.join(homeDir, 'Library', 'LaunchAgents', MAC_WATCHER_LABEL + '.plist');
}
function serviceTarget(uid = process.getuid?.()) {
  if (!Number.isInteger(uid) || uid < 0) throw new TypeError('Invalid user ID');
  return { domain: 'gui/' + uid, service: 'gui/' + uid + '/' + MAC_WATCHER_LABEL };
}
function buildLaunchAgentPlist({ executable, dataDir, cwd = path.dirname(executable || '') } = {}) {
  checkedString(executable, 'executable');
  checkedString(dataDir, 'data directory');
  checkedString(cwd, 'working directory');
  const args = [executable, '--watch-codex', '--maid-home=' + dataDir];
  // RunAtLoad starts the observer at login. KeepAlive is intentionally absent:
  // disabling follow must let the helper finish its receipt and exit normally.
  return '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
    '<plist version="1.0">\n<dict>\n' +
    '  <key>Label</key><string>' + MAC_WATCHER_LABEL + '</string>\n' +
    '  <key>ProgramArguments</key>\n  <array>\n' + args.map(value => '    <string>' + xmlString(value) + '</string>\n').join('') + '  </array>\n' +
    '  <key>WorkingDirectory</key><string>' + xmlString(cwd) + '</string>\n' +
    '  <key>LimitLoadToSessionType</key><string>Aqua</string>\n' +
    '  <key>RunAtLoad</key><true/>\n' +
    '  <key>ProcessType</key><string>Background</string>\n' +
    '</dict>\n</plist>\n';
}
function launchctl(args, { execFile = nativeExecFile, timeout = 5000 } = {}) {
  return new Promise(resolve => {
    try {
      execFile('/bin/launchctl', args, { timeout, maxBuffer: 128 * 1024, encoding: 'utf8', windowsHide: true,
        env: { ...process.env, LC_ALL: 'C' } }, (error, stdout, stderr) => {
        const missing = !!error && [3, 113].includes(error.code) &&
          /could not find (?:specified )?service|service could not be found|no such process/i.test(String(stderr || ''));
        resolve({ ok: !error, missing, stdout: typeof stdout === 'string' ? stdout : '' });
      });
    } catch { resolve({ ok: false, missing: false, stdout: '' }); }
  });
}
function writeAgent(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = file + '.' + process.pid + '.tmp';
  try {
    fs.writeFileSync(temporary, contents, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally { try { fs.unlinkSync(temporary); } catch {} }
}
function readAgent(file) {
  try { return fs.readFileSync(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function disabledStatus(output) {
  if (!/disabled services\s*=\s*\{[\s\S]*\}/.test(output)) return null;
  const label = MAC_WATCHER_LABEL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = output.match(new RegExp('"' + label + '"\\s*=>\\s*(true|false)'));
  return match ? match[1] === 'true' : false;
}

async function launchMacWatcher({ executable, args = [], cwd = path.dirname(executable || ''), dataDir, enabled = true,
  homeDir = os.homedir(), uid = process.getuid?.(), execFile = nativeExecFile, spawn = nativeSpawn, timeout = 5000 } = {}) {
  const plist = buildLaunchAgentPlist({ executable, dataDir, cwd });
  if (!Array.isArray(args)) throw new TypeError('Invalid arguments');
  args.forEach(value => checkedString(value, 'argument', { empty: true }));
  if (!enabled) {
    // A transient invocation delivers Electron's second-instance event, or
    // starts a helper if none remains. It never creates a login item. The
    // helper removes its plist before acknowledging and quitting; bootout is
    // performed by the main process only after that acknowledgement.
    try {
      await new Promise((resolve, reject) => {
        const child = spawn(executable, args, { cwd, detached: true, stdio: 'ignore', windowsHide: true });
        child.once('error', reject);
        child.once('spawn', () => { child.unref(); resolve(); });
      });
      return { launched: true };
    } catch { throw new Error(LAUNCH_ERROR); }
  }
  const { domain, service } = serviceTarget(uid);
  const file = launchAgentFile(homeDir);
  const options = { execFile, timeout };
  try {
    const previous = readAgent(file);
    const loaded = await launchctl(['print', service], options);
    if (!loaded.ok && !loaded.missing) throw new Error(LAUNCH_ERROR);
    if (loaded.ok && previous !== plist) {
      // A moved/replaced app must not leave launchd using the old executable.
      const unloaded = await launchctl(['bootout', service], options);
      if (!unloaded.ok && !unloaded.missing) throw new Error(LAUNCH_ERROR);
    }
    if (previous !== plist) writeAgent(file, plist);
    if (!(await launchctl(['enable', service], options)).ok) throw new Error(LAUNCH_ERROR);
    if (!loaded.ok || previous !== plist) {
      if (!(await launchctl(['bootstrap', domain, file], options)).ok) throw new Error(LAUNCH_ERROR);
    }
    // Without -k this is a no-op for a running helper, preserving its launch
    // gate (manual widget exit stays closed for the current Codex session).
    if (!(await launchctl(['kickstart', service], options)).ok) throw new Error(LAUNCH_ERROR);
    if (!(await launchctl(['print', service], options)).ok) throw new Error(LAUNCH_ERROR);
    return { launched: true };
  } catch { throw new Error(LAUNCH_ERROR); }
}

async function syncMacFollowStartup({ enabled, executable, dataDir, cwd = path.dirname(executable || ''),
  homeDir = os.homedir(), uid = process.getuid?.(), execFile = nativeExecFile, timeout = 5000 } = {}) {
  try {
    const file = launchAgentFile(homeDir);
    if (!enabled) {
      try { fs.unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (readAgent(file) !== null) throw new Error(REMOVAL_ERROR);
      return { loginStartupEnabled: false, loginStartupError: '' };
    }
    const expected = buildLaunchAgentPlist({ executable, dataDir, cwd });
    if (readAgent(file) !== expected) return { loginStartupEnabled: false, loginStartupError: 'startup-disabled' };
    const { domain, service } = serviceTarget(uid);
    const options = { execFile, timeout };
    const [loaded, disabled] = await Promise.all([launchctl(['print', service], options), launchctl(['print-disabled', domain], options)]);
    const isDisabled = disabled.ok ? disabledStatus(disabled.stdout) : null;
    if (isDisabled === null || (!loaded.ok && !loaded.missing)) throw new Error(LAUNCH_ERROR);
    const actual = loaded.ok && !isDisabled;
    return { loginStartupEnabled: actual, loginStartupError: actual ? '' : 'startup-disabled' };
  } catch {
    return { loginStartupEnabled: false, loginStartupError: enabled ? 'startup-registration-failed' : 'startup-removal-failed' };
  }
}

async function finalizeMacWatcherRemoval({ homeDir = os.homedir(), uid = process.getuid?.(), execFile = nativeExecFile, timeout = 5000,
  wait = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  try {
    // Refuse to report success if the helper failed to remove its login item,
    // or another invocation has already re-enabled it while awaiting receipt.
    if (readAgent(launchAgentFile(homeDir)) !== null) throw new Error(REMOVAL_ERROR);
    const { service } = serviceTarget(uid);
    const options = { execFile, timeout };
    const unloaded = await launchctl(['bootout', service], options);
    if (!unloaded.ok && !unloaded.missing) throw new Error(REMOVAL_ERROR);
    // launchd can acknowledge bootout before its service record disappears.
    // Confirm the actual removal, while refusing a concurrent re-enable or
    // unknown launchctl failure instead of silently claiming success.
    const attempts = Math.max(1, Math.ceil(timeout / 100));
    const deadline = Date.now() + timeout;
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (readAgent(launchAgentFile(homeDir)) !== null) throw new Error(REMOVAL_ERROR);
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(REMOVAL_ERROR);
      const loaded = await launchctl(['print', service], { ...options, timeout: remaining });
      if (loaded.missing) return { removed: true };
      if (!loaded.ok || attempt + 1 === attempts) throw new Error(REMOVAL_ERROR);
      await wait(100);
    }
  } catch { throw new Error(REMOVAL_ERROR); }
}

module.exports = { MAC_WATCHER_LABEL, launchAgentFile, buildLaunchAgentPlist, launchMacWatcher, syncMacFollowStartup, finalizeMacWatcherRemoval };
