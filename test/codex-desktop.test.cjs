'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const { INVENTORY_SCRIPT, isCodexDesktopPath, desktopRoots, queryCodexDesktop, CodexDesktopMonitor, buildLaunchArgs } = require('../src/codex-desktop.cjs');
const { run, DesktopLaunchGate, followsCodex, syncFollowStartup } = require('../src/desktop-watcher.cjs');
const { RULES, classifyCodexDesktop } = require('../src/codex-identity.cjs');

const paths = { localAppData: 'C:\\Users\\test\\AppData\\Local' };
const desktop = 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.1013.3656.0_x64__2p2nqsd0c76g0\\app\\ChatGPT.exe';
function processEntry(pid, parentPid = 1, file = desktop) { return { pid, parentPid, path: file, name: path.win32.basename(file), sessionId: 12,
  officialDesktop: classifyCodexDesktop({ path: file, packageFamilyName: file.includes('WindowsApps') ? RULES.packageFamily : null }, paths) }; }
const roots = [processEntry(100)];

test('desktop identity needs verified package membership or the confirmed unpackaged user layout', () => {
  for (const file of [desktop, desktop.replace('C:\\Program Files', 'D:'), desktop.replace('26.1013.3656.0_x64', '27.2000.0.0_arm64')]) {
    assert.equal(isCodexDesktopPath(file, { ...paths, packageFamilyName: RULES.packageFamily }), true, file);
    assert.equal(isCodexDesktopPath(file, paths), false, 'an unverified path cannot establish identity');
    assert.equal(isCodexDesktopPath(file, { ...paths, packageFamilyName: null }), false, 'a fake package directory cannot establish identity');
  }
  for (const file of ['C:\\Users\\test\\AppData\\Local\\Programs\\OpenAI\\Codex\\ChatGPT.exe',
    'C:\\Users\\test\\AppData\\Local\\Programs\\OpenAI Codex\\Codex.exe']) {
    assert.equal(isCodexDesktopPath(file, { ...paths, packageFamilyName: null }), true, file);
    assert.equal(isCodexDesktopPath(file, { ...paths, packageFamilyName: 'OpenAI.ChatGPT_2p2nqsd0c76g0' }), false, file);
  }
  for (const file of [desktop.replace('\\app\\', '\\bin\\'), desktop + '.bak',
    'C:\\Users\\test\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe', 'C:\\tools\\Codex.exe'])
    assert.equal(isCodexDesktopPath(file, { ...paths, packageFamilyName: null }), false, file);
});

test('desktop inventory removes renderer children and retains multiple desktop roots', () => {
  const inventory = [processEntry(100), processEntry(101, 100), processEntry(102, 101), processEntry(200),
    processEntry(201, 200), processEntry(300, 1, 'C:\\tools\\codex.exe')];
  assert.deepEqual(desktopRoots(inventory, paths).map(item => item.pid), [100, 200]);
});

test('missing or malformed identity classification cannot turn an incompatible helper snapshot into a confirmed absence', () => {
  for (const officialDesktop of [undefined, null, 'true', 1])
    assert.throws(() => desktopRoots([{ ...processEntry(100), officialDesktop }], paths), /Unverified desktop inventory/);
  const relocated = processEntry(100, 1, desktop.replace('C:\\Program Files', 'D:'));
  assert.deepEqual(desktopRoots([relocated], paths).map(({ path: file, officialDesktop }) => [file, officialDesktop]), [[relocated.path, true]]);
});

test('Windows inventory is hidden, session/user scoped and never asks for command lines', async () => {
  assert.match(INVENTORY_SCRIPT, /session != ownSession/);
  assert.match(INVENTORY_SCRIPT, /ownSid/);
  assert.match(INVENTORY_SCRIPT, /GetPackageFamilyName/);
  assert.doesNotMatch(INVENTORY_SCRIPT, /commandline|auth\.json/i);
  const query = await queryCodexDesktop({ platform: 'win32', env: {}, ...paths, execFile: (file, args, options, done) => {
    assert.equal(file, 'powershell.exe');
    assert.equal(options.windowsHide, true);
    assert.ok(args.includes('-NonInteractive'));
    done(null, JSON.stringify({ known: true, processes: [processEntry(100), processEntry(101, 100)] }));
  } });
  assert.equal(query.known, true);
  assert.deepEqual(query.roots.map(item => item.pid), [100]);
});

test('query failures and inaccessible process ownership are unknown, never an empty success', async () => {
  const badOutputs = ['', 'invalid JSON', JSON.stringify({ known: false, processes: [] }), JSON.stringify({ known: true })];
  for (const output of badOutputs) {
    const result = await queryCodexDesktop({ platform: 'win32', execFile: (_file, _args, _opts, done) => done(null, output) });
    assert.equal(result.known, false);
    assert.deepEqual(result.roots, []);
  }
  const result = await queryCodexDesktop({ platform: 'win32', execFile: (_file, _args, _opts, done) => done(new Error('timeout private path')) });
  assert.equal(result.reason, 'inventory-unavailable');
  assert.equal(JSON.stringify(result).includes('private path'), false);
});

test('monitor requires a continuous confirmed grace period and ignores unknown inventory', async () => {
  let time = 0, current = { known: true, roots }, missing = 0, changed = 0;
  const monitor = new CodexDesktopMonitor({ query: async () => current, graceMs: 5000, now: () => time,
    onChange: () => changed++, onMissing: () => missing++ });
  await monitor.poll();
  current = { known: true, roots: [] }; time = 1000; await monitor.poll();
  time = 5000; await monitor.poll(); assert.equal(missing, 0);
  current = { known: false, roots: [] }; time = 6000; await monitor.poll();
  assert.equal(missing, 0);
  current = { known: true, roots: [] }; time = 10000; await monitor.poll();
  time = 14999; await monitor.poll(); assert.equal(missing, 0);
  time = 15000; await monitor.poll(); assert.equal(missing, 1);
  time = 20000; await monitor.poll(); assert.equal(missing, 1);
  assert.equal(changed, 2);
  current = { known: true, roots: [processEntry(200)] }; await monitor.poll();
  current = { known: true, roots: [] }; time = 21000; await monitor.poll();
  time = 26000; await monitor.poll(); assert.equal(missing, 2);
});

test('monitor query errors preserve a live desktop and concurrent polls share one query', async () => {
  let resolve, calls = 0;
  const monitor = new CodexDesktopMonitor({ query: () => { calls++; return new Promise(done => { resolve = done; }); } });
  const first = monitor.poll(), second = monitor.poll();
  assert.equal(first, second); assert.equal(calls, 1);
  resolve({ known: true, roots }); await first;
  monitor.query = async () => { throw new Error('CIM unavailable'); };
  assert.deepEqual(await monitor.poll(), { known: false, roots });
});

test('stopping a monitor prevents an in-flight empty query from closing the widget', async () => {
  let resolve, missing = 0, changed = 0;
  const monitor = new CodexDesktopMonitor({ query: () => new Promise(done => { resolve = done; }), graceMs: 0,
    onMissing: () => missing++, onChange: () => changed++ });
  const pending = monitor.poll();
  monitor.stop(); resolve({ known: true, roots: [] }); await pending;
  assert.equal(missing, 0); assert.equal(changed, 0);
});

test('launch gate respects manual widget exit during the same desktop lifetime', () => {
  let launches = 0;
  const gate = new DesktopLaunchGate(() => launches++);
  gate.update([]); gate.update(roots); gate.update(roots); gate.update([...roots]);
  assert.equal(launches, 1);
  gate.update([...roots, processEntry(200)]); assert.equal(launches, 2);
  gate.update([processEntry(200)]); assert.equal(launches, 2);
  gate.update([]); gate.update([processEntry(300)]); assert.equal(launches, 3);
});

test('packaged and development launch arguments target the same entry point without a shell', () => {
  assert.deepEqual(buildLaunchArgs({ packaged: true, flag: '--watch-codex' }), ['--watch-codex']);
  assert.deepEqual(buildLaunchArgs({ packaged: false, appRoot: path.resolve('.'), flag: '--follow-codex' }), [path.resolve('.'), '--follow-codex']);
});

test('watcher uses an independent lock and hidden child, and disabling follow only stops its watcher', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maid-watcher-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, JSON.stringify({ followCodex: true }));
  const app = new EventEmitter();
  let userData, quitCount = 0, launches = 0, startupEnabled = false;
  const startupEntries = [];
  Object.assign(app, { setPath: (name, value) => { assert.equal(name, 'userData'); userData = value; },
    disableHardwareAcceleration: () => {}, requestSingleInstanceLock: () => true,
    setLoginItemSettings: options => { startupEntries.push(options); if (options.name === 'CodexMaidFollow') startupEnabled = options.openAtLogin; },
    getLoginItemSettings: options => ({ executableWillLaunchAtLogin: startupEnabled,
      launchItems: [{ name: 'CodexMaidFollow', path: options.path, enabled: startupEnabled }] }),
    whenReady: async () => {}, quit: () => { quitCount++; app.emit('before-quit'); }, getVersion: () => 'test' });
  const watcher = run({ app, dataDir: dir, settingsFile: file, appRoot: dir, executable: 'widget.exe', packaged: true, platform: 'win32',
    query: async () => ({ known: true, roots }), intervalMs: 60000,
    spawn: (file, args, options) => {
      assert.equal(file, 'widget.exe'); assert.deepEqual(args, ['--follow-codex']);
      assert.equal(options.windowsHide, true); assert.equal(options.detached, true); assert.equal(options.stdio, 'ignore');
      assert.equal(Object.hasOwn(options, 'shell'), false);
      launches++;
      const child = new EventEmitter(); child.unref = () => {};
      return child;
    } });
  t.after(() => watcher.stop());
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(userData, path.join(dir, 'watcher')); assert.equal(launches, 1);
  const record = JSON.parse(fs.readFileSync(path.join(dir, 'watcher.json'), 'utf8'));
  assert.equal(record.pid, process.pid);
  assert.equal(record.loginStartupEnabled, true);
  assert.equal(record.loginStartupError, '');
  assert.deepEqual(startupEntries.find(item => item.name === 'CodexMaidFollow').args, ['--watch-codex', '--maid-home=' + dir]);
  app.emit('second-instance', {}, ['widget.exe', '--follow-request=request-second-instance']);
  assert.equal(startupEntries.filter(item => item.name === 'CodexMaidFollow' && item.openAtLogin).length, 2);
  const acknowledgement = JSON.parse(fs.readFileSync(path.join(dir, 'follow-startup.json'), 'utf8'));
  assert.equal(acknowledgement.requestId, 'request-second-instance');
  assert.equal(acknowledgement.loginStartupEnabled, true);
  assert.equal(acknowledgement.loginStartupError, '');
  await watcher.monitor.poll(); assert.equal(launches, 1);
  fs.writeFileSync(file, JSON.stringify({ followCodex: false }));
  await watcher.monitor.poll();
  assert.equal(quitCount, 1); assert.equal(launches, 1);
  assert.equal(startupEnabled, false);
  assert.ok(startupEntries.some(item => item.name === 'CodexMaidFollow' && item.openAtLogin === false));
  assert.equal(fs.existsSync(path.join(dir, 'watcher.json')), false);
});

test('startup registration is verified and failures are sanitized without modifying source/development startup entries', () => {
  const options = { executable: 'C:\\Maid\\widget.exe', dataDir: 'C:\\Users\\test\\.codex-maid-widget', packaged: true, platform: 'win32', enabled: true };
  let writes = 0;
  const app = { setLoginItemSettings: () => { writes++; }, getLoginItemSettings: () => ({ executableWillLaunchAtLogin: false, launchItems: [] }) };
  assert.deepEqual(syncFollowStartup({ ...options, app }), { loginStartupEnabled: false, loginStartupError: 'startup-disabled' });
  assert.equal(writes, 2);
  for (const patch of [{ platform: 'linux' }, { packaged: false }]) {
    writes = 0;
    assert.equal(syncFollowStartup({ ...options, ...patch, app }).loginStartupError, 'unsupported-platform');
    assert.equal(writes, 0);
  }
  app.setLoginItemSettings = () => { throw new Error('private registry details'); };
  assert.deepEqual(syncFollowStartup({ ...options, app }), { loginStartupEnabled: false, loginStartupError: 'startup-registration-failed' });
});

test('a newly dispatched watcher removes startup and acknowledges a disable request queued before ready', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maid-watcher-disabled-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const settingsFile = path.join(dir, 'settings.json');
  const entries = [];
  fs.writeFileSync(settingsFile, JSON.stringify({ followCodex: false }));
  const app = new EventEmitter();
  let quits = 0, finishReady;
  Object.assign(app, { setPath: () => {}, disableHardwareAcceleration: () => {}, requestSingleInstanceLock: () => true,
    whenReady: () => new Promise(resolve => { finishReady = resolve; }), getVersion: () => 'test', quit: () => { quits++; app.emit('before-quit'); },
    setLoginItemSettings: options => entries.push(options), getLoginItemSettings: () => ({ executableWillLaunchAtLogin: false, launchItems: [] }) });
  const watcher = run({ app, dataDir: dir, settingsFile, executable: 'C:\\Maid\\widget.exe', packaged: true, platform: 'win32', argv: ['widget.exe'],
    query: () => { throw new Error('Must not poll when disabled'); }, spawn: () => { throw new Error('Must not launch when disabled'); } });
  app.emit('second-instance', {}, ['widget.exe', '--follow-request=request-disabled']);
  finishReady();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(quits, 1);
  assert.equal(watcher.monitor, undefined);
  assert.ok(entries.some(item => item.name === 'CodexMaidFollow' && item.openAtLogin === false));
  assert.equal(fs.existsSync(path.join(dir, 'watcher.json')), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'follow-startup.json'), 'utf8')), {
    requestId: 'request-disabled', pid: process.pid, version: 'test', executable: 'C:\\Maid\\widget.exe', loginStartupEnabled: false, loginStartupError: '',
  });
});

test('an unavailable config never changes startup and registration errors still publish a live watcher record', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maid-watcher-startup-error-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const settingsFile = path.join(dir, 'settings.json');
  function fakeApp() {
    const app = new EventEmitter();
    app.writes = 0;
    Object.assign(app, { setPath: () => {}, disableHardwareAcceleration: () => {}, requestSingleInstanceLock: () => true,
      whenReady: async () => {}, getVersion: () => 'test', quit: () => app.emit('before-quit'),
      setLoginItemSettings: () => { app.writes++; throw new Error('private failure'); } });
    return app;
  }
  const unavailable = fakeApp();
  run({ app: unavailable, dataDir: dir, settingsFile, executable: 'widget.exe', packaged: true, platform: 'win32' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(unavailable.writes, 0);
  fs.writeFileSync(settingsFile, '{"followCodex":true}');
  const app = fakeApp();
  const watcher = run({ app, dataDir: dir, settingsFile, executable: 'widget.exe', packaged: true, platform: 'win32', argv: ['widget.exe', '--follow-request=request-failed'],
    query: async () => ({ known: true, roots: [] }), intervalMs: 60000 });
  t.after(() => watcher.stop());
  await new Promise(resolve => setImmediate(resolve));
  const record = JSON.parse(fs.readFileSync(path.join(dir, 'watcher.json'), 'utf8'));
  assert.equal(record.loginStartupEnabled, false);
  assert.equal(record.loginStartupError, 'startup-registration-failed');
  assert.ok(watcher.monitor);
  assert.equal(JSON.stringify(record).includes('private failure'), false);
  const acknowledgement = JSON.parse(fs.readFileSync(path.join(dir, 'follow-startup.json'), 'utf8'));
  assert.equal(acknowledgement.requestId, 'request-failed');
  assert.equal(acknowledgement.loginStartupEnabled, false);
  assert.equal(acknowledgement.loginStartupError, 'startup-registration-failed');
  assert.equal(JSON.stringify(acknowledgement).includes('private failure'), false);
});

test('a missing or unreadable config does not start a widget or alter the user desktop', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maid-watcher-setting-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'settings.json');
  assert.equal(followsCodex(file), false);
  fs.writeFileSync(file, '{broken'); assert.equal(followsCodex(file), false);
  for (const value of [null, false, 'text', [], { followCodex: 'yes' }]) {
    fs.writeFileSync(file, JSON.stringify(value)); assert.equal(followsCodex(file), false);
  }
});
