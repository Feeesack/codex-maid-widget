'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { MAC_WATCHER_LABEL, launchAgentFile, buildLaunchAgentPlist, launchMacWatcher,
  syncMacFollowStartup, finalizeMacWatcherRemoval } = require('../src/macos-launch.cjs');
const { run, syncFollowStartup } = require('../src/desktop-watcher.cjs');

function fixture(t) {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maid-mac-follow-'));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  return { homeDir, uid: 501, executable: '/Applications/女仆 & Codex.app/Contents/MacOS/Codex Maid', dataDir: path.join(homeDir, '.codex-maid-widget'), env: {} };
}
function fakeLaunchctl({ loaded = false, disabled = false, fail } = {}) {
  const calls = [];
  const execFile = (file, args, options, done) => {
    calls.push(args);
    assert.equal(file, '/bin/launchctl');
    assert.equal(Object.hasOwn(options, 'shell'), false);
    assert.equal(options.env.LC_ALL, 'C');
    assert.ok(options.timeout > 0);
    if (fail?.(args)) { done(Object.assign(new Error('private path /Users/private'), { code: 1 }), '', 'private launchctl output'); return; }
    if (args[0] === 'print' && !loaded || args[0] === 'bootout' && !loaded) {
      done(Object.assign(new Error('not found'), { code: 113 }), '', 'Could not find service "' + MAC_WATCHER_LABEL + '" in domain for user gui: 501'); return;
    }
    if (args[0] === 'bootstrap') loaded = true;
    if (args[0] === 'bootout') loaded = false;
    if (args[0] === 'enable') disabled = false;
    done(null, args[0] === 'print-disabled' ? 'disabled services = {\n "' + MAC_WATCHER_LABEL + '" => ' + disabled + '\n}\n' : 'service = {\n}\n', '');
  };
  return { calls, execFile, get loaded() { return loaded; } };
}
function writePlist(options) {
  const file = launchAgentFile(options.homeDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buildLaunchAgentPlist(options));
  return file;
}

test('macOS property list preserves literal paths and configures one GUI-session watcher at login', () => {
  const executable = '/Applications/女仆 <&> "quoted" $(launch)\' .app/Contents/MacOS/Maid';
  const dataDir = '/Users/test/图案 & 中文';
  const output = buildLaunchAgentPlist({ executable, dataDir, env: {} });
  assert.match(output, /<key>RunAtLoad<\/key><true\/>/);
  assert.match(output, /<key>LimitLoadToSessionType<\/key><string>Aqua<\/string>/);
  assert.doesNotMatch(output, /KeepAlive|sh -c|osascript|--follow-request|openAtLogin/);
  assert.match(output, /&lt;&amp;&gt; &quot;quoted&quot; \$\(launch\)&apos;/);
  const strings = [...output.matchAll(/<string>([\s\S]*?)<\/string>/g)].map(match => match[1]
    .replace(/&apos;/g, "'").replace(/&quot;/g, '"').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&'));
  assert.deepEqual(strings.slice(0, 4), [MAC_WATCHER_LABEL, executable, '--watch-codex', '--maid-home=' + dataDir]);
});

test('macOS login and transient requests preserve only explicit profile and CLI path overrides', async t => {
  const options = fixture(t);
  const codexHome = path.join(options.homeDir,'中文 profile & data');
  const cli = path.join(options.homeDir,'tools','Codex 自定义');
  const env = {CODEX_HOME:codexHome,CODEX_MAID_CODEX_PATH:cli,PATH:'/private-do-not-persist',TOKEN:'do-not-persist'};
  const plist = buildLaunchAgentPlist({...options,env});
  assert.ok(plist.includes('--codex-home=' + codexHome.replaceAll('&','&amp;')));
  assert.ok(plist.includes('--codex-cli=' + cli));
  assert.doesNotMatch(plist,/TOKEN|private-do-not-persist|do-not-persist|EnvironmentVariables/);
  const ctl = fakeLaunchctl();
  await launchMacWatcher({...options,env,execFile:ctl.execFile});
  assert.equal(fs.readFileSync(launchAgentFile(options.homeDir),'utf8'),plist);
  assert.deepEqual(await syncMacFollowStartup({...options,env,enabled:true,execFile:ctl.execFile}),{loginStartupEnabled:true,loginStartupError:''});
  assert.deepEqual(await syncMacFollowStartup({...options,env:{},enabled:true,execFile:ctl.execFile}),{loginStartupEnabled:false,loginStartupError:'startup-disabled'});
  let transient;
  await launchMacWatcher({...options,env,enabled:false,args:['--watch-codex','--maid-home='+options.dataDir],
    spawn(_file,args) {transient=args;const child=new EventEmitter();child.unref=()=>{};queueMicrotask(()=>child.emit('spawn'));return child;}});
  assert.deepEqual(transient,['--watch-codex','--maid-home='+options.dataDir,'--codex-home='+codexHome,'--codex-cli='+cli]);
});

test('macOS dispatch validates property list values before touching launchctl or files', async t => {
  const options = fixture(t);
  let calls = 0;
  for (const patch of [{ executable: 'bad\0path' }, { dataDir: '' }, { cwd: 'bad\x01cwd' }, { args: [42] }, { args: 'text' }, { uid: NaN }]) {
    await assert.rejects(launchMacWatcher({ ...options, ...patch, execFile: () => { calls++; } }), TypeError);
  }
  assert.equal(calls, 0);
  assert.equal(fs.existsSync(launchAgentFile(options.homeDir)), false);
});

test('macOS dispatch is launchd-owned and repeated requests preserve the live launch gate', async t => {
  const options = fixture(t);
  const ctl = fakeLaunchctl();
  assert.deepEqual(await launchMacWatcher({ ...options, execFile: ctl.execFile }), { launched: true });
  assert.equal(fs.readFileSync(launchAgentFile(options.homeDir), 'utf8'), buildLaunchAgentPlist(options));
  assert.deepEqual(ctl.calls.filter(args => args[0] === 'bootstrap'), [['bootstrap', 'gui/501', launchAgentFile(options.homeDir)]]);
  assert.deepEqual(await launchMacWatcher({ ...options, execFile: ctl.execFile }), { launched: true });
  assert.equal(ctl.calls.filter(args => args[0] === 'bootstrap').length, 1);
  assert.equal(ctl.calls.filter(args => args[0] === 'bootout').length, 0);
  assert.equal(ctl.calls.filter(args => args[0] === 'kickstart').length, 2);
  assert.equal(ctl.calls.some(args => args.includes('-k')), false);
  assert.ok(ctl.calls.every(args => !args.includes(options.executable)));
});

test('moving the macOS application replaces launchd executable arguments before dispatch', async t => {
  const options = fixture(t);
  const ctl = fakeLaunchctl({ loaded: true });
  writePlist({ ...options, executable: '/Old/Widget.app/Contents/MacOS/Maid' });
  await launchMacWatcher({ ...options, execFile: ctl.execFile });
  const actions = ctl.calls.map(args => args[0]);
  assert.ok(actions.indexOf('bootout') < actions.indexOf('bootstrap'));
  assert.equal(fs.readFileSync(launchAgentFile(options.homeDir), 'utf8'), buildLaunchAgentPlist(options));
});

test('macOS startup verification checks the exact persisted arguments and launchd disable policy', async t => {
  const options = fixture(t);
  writePlist(options);
  for (const disabled of [false, true]) {
    const ctl = fakeLaunchctl({ loaded: true, disabled });
    const actual = await syncMacFollowStartup({ ...options, enabled: true, execFile: ctl.execFile });
    assert.deepEqual(actual, { loginStartupEnabled: !disabled, loginStartupError: disabled ? 'startup-disabled' : '' });
    assert.ok(ctl.calls.every(args => ['print', 'print-disabled'].includes(args[0])));
  }
  fs.writeFileSync(launchAgentFile(options.homeDir), '<outdated/>');
  assert.deepEqual(await syncMacFollowStartup({ ...options, enabled: true, execFile: () => assert.fail('wrong plist must not be considered registered') }),
    { loginStartupEnabled: false, loginStartupError: 'startup-disabled' });
});

test('macOS launch and status failures are sanitized and unsupported development startup is untouched', async t => {
  const options = fixture(t);
  const ctl = fakeLaunchctl({ fail: args => args[0] === 'bootstrap' });
  await assert.rejects(launchMacWatcher({ ...options, execFile: ctl.execFile }), { message: '无法通过 macOS 登录启动助手。' });
  const bad = fakeLaunchctl({ loaded: true, fail: args => args[0] === 'print-disabled' });
  assert.deepEqual(await syncMacFollowStartup({ ...options, enabled: true, execFile: bad.execFile }),
    { loginStartupEnabled: false, loginStartupError: 'startup-registration-failed' });
  assert.deepEqual(syncFollowStartup({ ...options, app: {}, enabled: true, platform: 'darwin', packaged: false }),
    { loginStartupEnabled: false, loginStartupError: 'unsupported-platform' });
});

test('disabled macOS dispatch delivers the request without registering or booting out a service', async t => {
  const options = fixture(t);
  const args = ['--watch-codex', '--maid-home=' + options.dataDir, '--follow-request=safe-$()'];
  let unrefs = 0;
  const result = await launchMacWatcher({ ...options, enabled: false, args,
    execFile: () => assert.fail('disabling dispatch must not call launchctl before receipt'),
    spawn: (file, actual, settings) => {
      assert.equal(file, options.executable); assert.deepEqual(actual, args);
      assert.equal(settings.detached, true); assert.equal(settings.stdio, 'ignore');
      assert.equal(Object.hasOwn(settings, 'shell'), false);
      const child = new EventEmitter(); child.unref = () => unrefs++;
      queueMicrotask(() => child.emit('spawn')); return child;
    } });
  assert.deepEqual(result, { launched: true }); assert.equal(unrefs, 1);
  assert.equal(fs.existsSync(launchAgentFile(options.homeDir)), false);
});

test('macOS removal confirms no remaining plist and service, and refuses to conceal cleanup failure', async t => {
  const options = fixture(t);
  const file = writePlist(options);
  const ctl = fakeLaunchctl({ loaded: true });
  await assert.rejects(finalizeMacWatcherRemoval({ ...options, execFile: ctl.execFile }), { message: '无法移除 macOS 登录启动助手。' });
  assert.equal(ctl.calls.length, 0);
  const startup = await syncMacFollowStartup({ ...options, enabled: false, execFile: () => assert.fail('helper must not bootout itself') });
  assert.deepEqual(startup, { loginStartupEnabled: false, loginStartupError: '' });
  assert.equal(fs.existsSync(file), false);
  assert.deepEqual(await finalizeMacWatcherRemoval({ ...options, execFile: ctl.execFile }), { removed: true });
  assert.deepEqual(ctl.calls.map(args => args[0]), ['bootout', 'print']);
  const bad = fakeLaunchctl({ loaded: true, fail: args => args[0] === 'bootout' });
  await assert.rejects(finalizeMacWatcherRemoval({ ...options, execFile: bad.execFile }), { message: '无法移除 macOS 登录启动助手。' });
  fs.mkdirSync(file);
  assert.deepEqual(await syncMacFollowStartup({ ...options, enabled: false }), { loginStartupEnabled: false, loginStartupError: 'startup-removal-failed' });
});

test('macOS removal waits for launchd to release a booted-out service', async t => {
  const options = fixture(t);
  let prints = 0, waits = 0;
  const execFile = (_file, args, _options, done) => {
    if(args[0] === 'print' && ++prints > 2) {
      done(Object.assign(new Error('missing'), { code: 113 }), '', 'Could not find specified service');
    } else done(null, 'service = {}', '');
  };
  assert.deepEqual(await finalizeMacWatcherRemoval({ ...options, execFile, wait: async ms => { assert.equal(ms, 100); waits++; } }), { removed: true });
  assert.equal(prints, 3);assert.equal(waits, 2);
});

test('macOS removal rejects a stuck service, unknown query error or concurrent re-enable', async t => {
  const options = fixture(t);
  let prints = 0;
  await assert.rejects(finalizeMacWatcherRemoval({ ...options, timeout: 200, wait: async () => {},
    execFile: (_file, args, _options, done) => { if(args[0] === 'print')prints++;done(null, 'service = {}', ''); } }), { message: '无法移除 macOS 登录启动助手。' });
  assert.equal(prints, 2, 'a persistent service must fail within the bounded poll');
  const bad = fakeLaunchctl({ loaded: true, fail: args => args[0] === 'print' });
  await assert.rejects(finalizeMacWatcherRemoval({ ...options, execFile: bad.execFile, wait: () => assert.fail('unknown failures must not be retried') }),
    { message: '无法移除 macOS 登录启动助手。' });
  prints = 0;
  await assert.rejects(finalizeMacWatcherRemoval({ ...options,
    execFile: (_file, args, _options, done) => { if(args[0] === 'print')prints++;done(null, 'service = {}', ''); },
    wait: async () => writePlist(options) }), { message: '无法移除 macOS 登录启动助手。' });
  assert.equal(prints, 1, 're-enabling during removal must not be reported as removed');
});

test('macOS watcher removes persistence and writes the correlated receipt before its own exit', async t => {
  const options = fixture(t);
  fs.mkdirSync(options.dataDir, { recursive: true });
  writePlist(options);
  const settingsFile = path.join(options.dataDir, 'settings.json');
  fs.writeFileSync(settingsFile, '{"followCodex":false}');
  const app = new EventEmitter();
  let quits = 0, activationPolicy;
  Object.assign(app, { setPath() {}, disableHardwareAcceleration() {}, requestSingleInstanceLock: () => true,
    whenReady: async () => {}, getVersion: () => 'mac-test', setActivationPolicy: value => { activationPolicy = value; },
    setLoginItemSettings: () => assert.fail('macOS cannot use Windows-only login arguments'),
    quit: () => {
      quits++;
      assert.equal(fs.existsSync(launchAgentFile(options.homeDir)), false);
      const receipt = JSON.parse(fs.readFileSync(path.join(options.dataDir, 'follow-startup.json'), 'utf8'));
      assert.equal(receipt.requestId, 'request-before-quit');
      assert.equal(receipt.loginStartupError, ''); assert.equal(receipt.loginStartupEnabled, false);
      app.emit('before-quit');
    } });
  const watcher = run({ ...options, app, settingsFile, platform: 'darwin', packaged: true,
    startupOptions: { homeDir: options.homeDir, uid: options.uid, execFile: () => assert.fail('must not kill the watcher before writing the receipt') },
    argv: [options.executable, '--watch-codex', '--follow-request=request-before-quit'],
    query: () => assert.fail('a disabled watcher must not poll'), spawn: () => assert.fail('a disabled watcher must not launch a widget') });
  t.after(() => watcher.stop());
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(activationPolicy, 'accessory'); assert.equal(quits, 1);
  assert.equal(watcher.monitor, undefined);
  assert.equal(fs.existsSync(path.join(options.dataDir, 'watcher.json')), false);
});
