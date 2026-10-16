'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-maid-follow-'));
const control = path.join(home, 'control.json');
const settingsFile = path.join(home, 'settings.json');
const fixtureFile = path.join(home, 'desktop-state.json');
const settings = { sizeBaseline: 2, followCodex: true, refreshSeconds: 600, sound: false, showBubble: false };
fs.writeFileSync(settingsFile, JSON.stringify(settings));
function fixture(roots, known = true) { fs.writeFileSync(fixtureFile, JSON.stringify({ known, roots })); }
fixture([]);
function desktop(pid) { return { pid, parentPid: 1, sessionId: 999, path: 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_99.0.0.0_x64__2p2nqsd0c76g0\\app\\ChatGPT.exe' }; }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function read(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
function lines(file) { try { return fs.readFileSync(path.join(home, file), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); } catch { return []; } }
function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
async function until(check, description, ms = 14000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (await check()) return; await sleep(80); }
  throw new Error('Follow check timed out: ' + description);
}
async function status() {
  const target = read(control);
  if (!target) return null;
  try { return await (await fetch(`http://127.0.0.1:${target.port}/status`, { headers: { Authorization: 'Bearer ' + target.token } })).json(); }
  catch { return null; }
}

(async () => {
  if (process.platform !== 'win32') throw new Error('This verification targets Windows Electron.');
  let watcher, watcherExited = false, errors = '';
  try {
    watcher = spawn(require('electron'), [path.join(__dirname, 'follow-check-bootstrap.cjs'), '--watch-codex'], {
      cwd: root, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'],
      env: { ...process.env, CODEX_MAID_HOME: home, CODEX_MAID_FOLLOW_CHECK: '1' },
    });
    watcher.stderr.on('data', data => { errors += data; });
    watcher.once('exit', () => { watcherExited = true; });
    await until(() => read(path.join(home, 'watcher.json')), 'watcher ready');
    assert.equal(read(path.join(home, 'watcher.json')).loginStartupEnabled, true);
    assert.equal(read(path.join(home, 'watcher.json')).loginStartupError, '');
    await sleep(300);
    assert.equal(fs.existsSync(control), false, 'No widget while Codex desktop is absent');
    assert.equal(watcherExited, false);

    fixture([desktop(100)]);
    await until(async () => (await status())?.status === 'live', 'first automatic widget launch');
    const first = read(control).pid;
    const firstStatus = await status();
    assert.equal(firstStatus.version, require('../package.json').version);
    assert.equal(firstStatus.followCodex, true);
    assert.equal(firstStatus.followSupported, true);
    await until(async () => (await status())?.followError === '', 'verified helper startup status reaches widget');
    fixture([], false);
    await sleep(500);
    assert.equal(read(control)?.pid, first, 'Unknown inventory must preserve widget');
    assert.equal(alive(first), true);

    fixture([]);
    await until(() => !fs.existsSync(control) && !alive(first), 'widget exits after desktop exit');
    assert.equal(watcherExited, false, 'Silent watcher survives the desktop closing');
    fixture([desktop(200)]);
    await until(async () => (await status())?.status === 'live', 'second desktop automatically relaunches widget');
    const second = read(control).pid;
    assert.notEqual(second, first);

    fs.writeFileSync(path.join(home, 'widget-command.json'), JSON.stringify({ pid: second, action: 'quit' }));
    await until(() => !fs.existsSync(control) && !alive(second), 'manual widget exit');
    await sleep(600);
    assert.equal(fs.existsSync(control), false, 'Manual tray exit stays closed during the same desktop lifetime');
    fixture([]); await sleep(250); fixture([desktop(300)]);
    await until(async () => (await status())?.status === 'live', 'third desktop relaunches after manual widget exit');
    const third = read(control).pid;
    assert.notEqual(third, second);
    fs.writeFileSync(path.join(home, 'widget-command.json'), JSON.stringify({ pid: third, action: 'disable-follow' }));
    await until(() => read(path.join(home, 'disabled-follow.json'))?.ok && watcherExited, 'disable-follow IPC stops watcher');
    await until(() => {
      const acknowledgement = read(path.join(home, 'follow-startup.json'));
      return acknowledgement?.requestId && acknowledgement.version === require('../package.json').version &&
        acknowledgement.loginStartupEnabled === false && acknowledgement.loginStartupError === '';
    }, 'disabled login entry is confirmed by the independent helper');
    assert.equal(read(settingsFile).followCodex, false);
    fixture([]); await sleep(500);
    assert.equal(read(control)?.pid, third, 'Turning follow off restores independent widget lifetime');
    assert.equal(alive(third), true);
    const entries = lines('startup-entries.jsonl');
    assert.ok(entries.some(item => item.name === 'CodexMaidFollow' && item.openAtLogin === true && item.args?.[0] === '--watch-codex'));
    assert.ok(entries.some(item => item.name === 'CodexMaidFollow' && item.openAtLogin === false));
    const watcherPids = new Set(lines('processes.jsonl').filter(item => item.role === 'watcher').map(item => item.pid));
    assert.ok(entries.filter(item => item.name === 'CodexMaidFollow').every(item => watcherPids.has(item.pid)), 'Only the independent helper writes the named Windows startup entry');
    const launches = lines('launches.jsonl');
    assert.ok(launches.some(item => item.args[0] === '--follow-codex'));
    assert.ok(launches.some(item => item.args[0] === '--watch-codex'));
    assert.ok(launches.every(item => item.hidden));
    assert.deepEqual(lines('errors.jsonl'), []);
    fs.writeFileSync(path.join(home, 'widget-command.json'), JSON.stringify({ pid: third, action: 'quit' }));
    await until(() => !fs.existsSync(control) && !alive(third), 'last test widget cleanup');
    console.log('PASS: isolated production watcher -> widget, unknown inventory safety, desktop exit -> widget exit, desktop reopen -> relaunch, manual exit stays closed, disable-follow IPC, hidden helper launch and mocked startup registration.');
  } finally {
    // Every PID here was recorded by the bootstrap under this test's private
    // temporary directory. Never enumerate, close or signal the user's Codex.
    const owned = new Set(lines('processes.jsonl').map(item => item.pid));
    for (const item of lines('launches.jsonl')) if (Number.isInteger(item.pid)) owned.add(item.pid);
    if (watcher?.pid) owned.add(watcher.pid);
    for (const pid of owned) if (alive(pid)) { try { process.kill(pid); } catch {} }
    if (lines('errors.jsonl').length) console.error('Isolated Electron reported startup errors.');
    await sleep(400);
    if (home.startsWith(path.resolve(os.tmpdir()) + path.sep)) {
      try { fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
      catch { /* Chromium can keep cache handles briefly; preserve the test error. */ }
    }
    void errors;
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
