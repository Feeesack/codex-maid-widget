'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createHash } = require('node:crypto');
const { StringDecoder } = require('node:string_decoder');

const root = path.join(__dirname, '..');
const variants = [
  { name: 'Windows', root, platform: 'win32' },
  { name: 'macOS', root: path.join(root, 'macos'), platform: 'darwin' },
];
const plain = value => JSON.parse(JSON.stringify(value));
const flush = () => new Promise(resolve => setImmediate(resolve));
const accountA = 'a'.repeat(64), accountB = 'b'.repeat(64);
const initialTime = Date.UTC(2026, 9, 19, 1);
const quota = resetsAt => ({ status: 'live', account: { authMode: 'chatgpt', planType: 'plus' },
  buckets: [{ id: 'codex', primary: { windowDurationMins: 300, remainingPercent: 40, resetsAt } }],
  clearPrevious: true, accountChanged: false });

// The real main entry point, settings, ledger and alarm execute in isolated VMs.
// Every data import, including data-home, fs, auth watching and native Electron,
// is explicitly replaced. Only the named production source files are read from disk.
async function harness(variant, options = {}) {
  const dataHome = path.join(root, 'tmp', 'isolated-main-accounts', variant.name);
  const settingsFile = path.join(dataHome, 'settings.json');
  const ledgerFile = path.join(dataHome, 'account-registry.json');
  const controlFile = path.join(dataHome, 'control.json');
  const files = new Map([[settingsFile, JSON.stringify({ sizeBaseline: 2, followCodex: false,
    sound: true, ...options.settings })]]);
  if (options.corruptLedger) files.set(ledgerFile, '{ invalid fixture');
  const writes = [], reads = [], messages = [], dependencies = [], timers = new Map();
  const descriptors = new Map(), windows = [], handlers = new Map();
  let now = initialTime, sequence = 0, route, authCallback, startup, registryWritesToFail = 0;
  const clock = {
    setTimeout(callback, delay = 0) { const id = ++sequence; timers.set(id, { callback, due: now + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    setInterval() { return ++sequence; }, clearInterval() {},
  };
  class FakeDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  function assertDataPath(file) {
    assert.equal(typeof file, 'string');
    const relative = path.relative(dataHome, path.resolve(file));
    assert.ok(relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative)), 'Data access escaped isolated home');
    return file;
  }
  const missing = () => Object.assign(new Error('Synthetic missing file'), { code: 'ENOENT' });
  const isolatedFs = new Proxy({
    mkdirSync(file) { assertDataPath(file); },
    existsSync(file) { assertDataPath(file); return files.has(file); },
    lstatSync(file) {
      assertDataPath(file); reads.push(file);
      if (!files.has(file)) throw missing();
      return { isFile: () => true, size: Buffer.byteLength(files.get(file)) };
    },
    readFileSync(file, encoding) {
      assertDataPath(file); assert.equal(encoding, 'utf8'); reads.push(file);
      if (!files.has(file)) throw missing();
      return files.get(file);
    },
    openSync(file, flags, mode) {
      assertDataPath(file); assert.equal(flags, 'wx'); assert.equal(mode, 0o600);
      assert.equal(files.has(file), false);
      const descriptor = ++sequence; descriptors.set(descriptor, file); files.set(file, ''); return descriptor;
    },
    writeFileSync(file, value) {
      const target = typeof file === 'number' ? descriptors.get(file) : file;
      assertDataPath(target); files.set(target, String(value)); writes.push(target);
    },
    fsyncSync(descriptor) { assert.ok(descriptors.has(descriptor)); },
    closeSync(descriptor) { assert.equal(descriptors.delete(descriptor), true); },
    renameSync(from, to) {
      assertDataPath(from); assertDataPath(to); assert.ok(files.has(from));
      if (to === ledgerFile && registryWritesToFail > 0) {
        registryWritesToFail--; throw new Error('Synthetic transient ledger write failure');
      }
      files.set(to, files.get(from)); files.delete(from);
    },
    unlinkSync(file) { assertDataPath(file); files.delete(file); },
  }, { get(target, key) {
    if (Object.hasOwn(target, key)) return target[key];
    throw new Error('Unexpected isolated filesystem API: ' + String(key));
  } });
  const isolatedProcess = { platform: variant.platform, argv: options.demo ? ['--demo'] : [], pid: 456,
    env: { CODEX_HOME: path.join(dataHome, 'codex') }, execPath: path.join(dataHome, 'synthetic-widget') };
  function load(file, modules) {
    const context = { module: { exports: {} }, __dirname: path.join(variant.root, 'src'),
      Date: FakeDate, Buffer, process: isolatedProcess, ...clock,
      require(name) {
        if (Object.hasOwn(modules, name)) return modules[name];
        throw new Error('Unexpected isolated module import: ' + name);
      } };
    vm.runInNewContext(fs.readFileSync(path.join(variant.root, 'src', file), 'utf8'), context, { filename: file });
    return context.module.exports;
  }
  const i18n = load('i18n.js');
  const settings = load('settings.cjs', { './i18n.js': i18n, 'node:fs': isolatedFs, 'node:path': path,
    './interaction-sound-catalog.js': load('interaction-sound-catalog.js') });
  let registryModule, alarmModule;
  function ledgerModule() {
    registryModule ||= load('account-registry.cjs', { 'node:fs': isolatedFs, 'node:path': path,
      'node:crypto': { randomUUID: () => 'synthetic-' + ++sequence } });
    return registryModule;
  }
  function localAlarmModule() { return alarmModule ||= load('account-alarm.cjs', {}); }
  let source = { accountIdentity: accountA, readCount: 0, invalidations: 0, closed: false,
    response: options.offline ? { status: 'offline', account: null, buckets: [], clearPrevious: true } : quota(initialTime / 1000 + 60),
    async read() { this.readCount++; return typeof this.response === 'function' ? this.response() : this.response; },
    invalidate() { this.invalidations++; this.accountIdentity = null; }, close() { this.closed = true; } };
  let syntheticAccount = { type: 'chatgpt', email: 'same-person@example.test', planType: 'pro', fixtureProfileNickname: '资料测试昵称' };
  let syntheticReset = initialTime / 1000 + 60;
  if (options.realSource) {
    const unavailableAsyncFs = new Proxy({}, { get() { throw new Error('Codex async filesystem must not be read'); } });
    const { CodexDataSource } = load('codex-data.cjs', {
      'node:fs': isolatedFs, 'node:fs/promises': unavailableAsyncFs, 'node:path': path,
      'node:os': { homedir: () => dataHome }, 'node:child_process': {},
      'node:string_decoder': { StringDecoder }, 'node:crypto': { createHash }, '../package.json': { version: '0.3.28' },
      './codex-cli.cjs': load('codex-cli.cjs', { 'node:fs': isolatedFs, 'node:path': path }),
      './macos-bundle.cjs': { CODEX_BUNDLE_ID: 'synthetic.bundle', MacBundleReader: class {}, standardBundles: () => [] },
    });
    source = new CodexDataSource({ codexHome: path.join(dataHome, 'codex'),
      profileReader: { read: async () => ({ profileNickname: syntheticAccount.fixtureProfileNickname || null,
        workspaceName: syntheticAccount.fixtureWorkspaceName || null }), invalidate() {}, close() {} },
      localReader: { read: async () => ({ today: null, weekly: null, lastTurn: null }) },
      server: { async connect() {}, disconnect() {}, close() {}, async request(method, params) {
        if (method === 'account/read') { assert.equal(params.refreshToken, false); return { account: syntheticAccount }; }
        assert.equal(method, 'account/rateLimits/read');
        return { rateLimits: { limitId: 'codex', primary: { usedPercent: 60, windowDurationMins: 300, resetsAt: syntheticReset } } };
      } },
    });
  }
  const character = { id: 'lilac-dragon', name: 'Synthetic pet', url: 'synthetic:pet', available: true };
  class Window extends EventEmitter {
    constructor(options) {
      super(); this.bounds = { x: 400, y: 400, width: options.width, height: options.height }; this.visible = false;
      this.webContents = new EventEmitter();
      Object.assign(this.webContents, { send(name, value) { messages.push({ name, value: plain(value) }); },
        setWindowOpenHandler() {}, session: { setPermissionRequestHandler() {} } });
      windows.push(this);
    }
    isDestroyed() { return this.destroyed === true; } getBounds() { return { ...this.bounds }; }
    setTitle(value) { this.title = value; }
    setBounds(value) { this.bounds = { ...this.bounds, ...value }; }
    setAlwaysOnTop() {} setOpacity() {} setIgnoreMouseEvents() {}
    getNativeWindowHandle() { return Buffer.from([1, 0, 0, 0]); }
    show() { this.visible = true; } hide() { this.visible = false; }
    isVisible() { return this.visible; } moveTop() {} focus() {}
    async loadFile() {}
  }
  const app = new EventEmitter();
  Object.assign(app, { isPackaged: false, getPath: name => { assert.equal(name, 'userData'); return dataHome; },
    setName() {}, setPath(name, value) { assert.equal(name, 'userData'); assert.equal(value, dataHome); },
    getVersion: () => '0.3.28', requestSingleInstanceLock: () => true,
    quit() { throw new Error('Unexpected isolated app quit'); },
    whenReady: () => ({ then(callback) { startup = Promise.resolve().then(callback); return startup; } }) });
  const area = { x: 0, y: 0, width: 1920, height: 1080 }, screen = new EventEmitter();
  Object.assign(screen, { getPrimaryDisplay: () => ({ workArea: area }), getDisplayMatching: () => ({ workArea: area }) });
  const ipcMain = new EventEmitter(); ipcMain.handle = (name, callback) => handlers.set(name, callback);
  const windowModeModule = load('window-mode.cjs', {
    './window-containment.cjs': load('window-containment.cjs'), './window-visibility.cjs': load('window-visibility.cjs'),
    './window-topmost.cjs': load('window-topmost.cjs'),
    './codex-window.cjs': { CodexWindowProvider: class { constructor() { throw new Error('Native provider must remain isolated'); } } },
  });
  const modules = {
    electron: { app, BrowserWindow: Window, ipcMain, screen,
      get Notification() { throw new Error('Account reminders must never access system notifications'); },
      Tray: class extends EventEmitter { setToolTip() {} setContextMenu() {} },
      Menu: { buildFromTemplate: value => value }, nativeImage: {},
      globalShortcut: { register() {}, unregisterAll() {} },
      dialog: { showErrorBox(_title, message) { throw new Error('Isolated startup failed: ' + message); } } },
    'node:fs': isolatedFs, 'node:path': path, 'node:os': { homedir: () => dataHome }, 'node:child_process': {},
    'node:crypto': { randomBytes: () => ({ toString: () => 'synthetic-control-token' }) },
    'node:http': { createServer(callback) {
      route = callback;
      return { once() {}, listen(_port, host, ready) { assert.equal(host, '127.0.0.1'); ready(); },
        address: () => ({ port: 12345 }), close() {} };
    } },
    './settings.cjs': settings, './i18n.js': i18n,
    './window-mode.cjs': { CodexWindowMode: class extends windowModeModule.CodexWindowMode {
      constructor(value) { super({ ...value, platform: variant.platform, topmostProviderFactory: () => ({
        async setTopmost(_handle, enabled) { return { known: true, ok: true, topmost: enabled }; }, close() {},
      }) }); }
    } },
    './data-home.cjs': { prepareDataHome({ legacyDir }) { assert.equal(legacyDir, dataHome); return dataHome; } },
    './character-library.cjs': { CharacterLibrary: class {
      constructor({ dataDir }) { assert.equal(dataDir, dataHome); this.defaultId = character.id; }
      get(id) { return id === character.id ? character : undefined; } list() { return [character]; }
    } },
    './codex-data.cjs': { CodexDataSource: class { constructor() { return source; } } },
    './codex-desktop.cjs': {}, './windows-launch.cjs': {}, './macos-launch.cjs': {}, './desktop-observation.cjs': {},
    './auth-change-watch.cjs': { watchAuthChanges(home, callback) {
      assert.equal(home, path.join(dataHome, 'codex')); authCallback = callback; return () => {};
    } },
    './platform.cjs': { supportsDesktopFollow: () => false, configureMacApp() {}, configureWidgetWorkspace() {}, trayImage: () => null },
    './demo.cjs': () => ({ ...quota(initialTime / 1000 + 60), status: 'demo' }),
  };
  const context = { module: { exports: {} }, __dirname: path.join(variant.root, 'src'),
    Date: FakeDate, process: isolatedProcess, Buffer, ...clock,
    require(name) {
      dependencies.push(name);
      if (name === './account-registry.cjs') return ledgerModule();
      if (name === './account-alarm.cjs') return localAlarmModule();
      if (Object.hasOwn(modules, name)) return modules[name];
      throw new Error('Unexpected isolated main dependency: ' + name);
    } };
  vm.runInNewContext(fs.readFileSync(path.join(variant.root, 'src', 'main.cjs'), 'utf8') +
    '\nmodule.exports = { refresh, state, authChanged, notifyAccountReset, setWidgetForTest: value => { widget = value; } };', context, { filename: 'main.cjs' });
  await startup; await flush();
  const api = context.module.exports;
  return { source, messages, dependencies, reads, writes, files, ledgerFile,
    state: () => plain(api.state()),
    invoke(name, ...args) { return handlers.get(name)({ sender: windows[0].webContents }, ...args); },
    foreign(name, ...args) { return handlers.get(name)({ sender: {} }, ...args); },
    refresh: api.refresh,
    authChanged() { assert.equal(typeof authCallback, 'function'); authCallback(); },
    async signIn(account, reset) {
      assert.equal(options.realSource, true); syntheticAccount = account; syntheticReset = reset;
      authCallback(); await api.refresh();
    },
    setTime(value) { now = value; }, failLedgerWrites(count) { registryWritesToFail = count; },
    removeWidget(destroyed) { if (destroyed) windows[0].destroyed = true; else api.setWidgetForTest(undefined); },
    notify: api.notifyAccountReset,
    fireAlarm() {
      const eligible = [...timers.entries()].filter(([, value]) => value.due <= now)
        .sort((a, b) => a[1].due - b[1].due)[0];
      assert.ok(eligible, 'An account deadline timer must be armed');
      timers.delete(eligible[0]); eligible[1].callback();
    },
    async publicStatus() {
      let status = 200, body;
      await route({ method: 'GET', url: '/status', headers: { authorization: 'Bearer synthetic-control-token' } },
        { setHeader() {}, writeHead(value) { status = value; }, end(value) { body = value; } });
      assert.equal(status, 200); return JSON.parse(body);
    },
    close() { app.emit('before-quit'); assert.equal(source.closed, true); assert.equal(timers.size, 0); },
  };
}

for (const variant of variants) {
  test(`${variant.name}: reset reminders localize generated names while preserving explicit aliases and the stored ledger`, async t => {
    const fixture = await harness(variant, {settings:{language:'en'}}); t.after(() => fixture.close());
    const account = fixture.invoke('list-accounts').accounts[0];
    const event = {id:account.id,label:account.label,resetsAt:initialTime / 1000 + 60,estimated:true};
    const stored = fixture.files.get(fixture.ledgerFile);
    fixture.notify(event);
    assert.equal(fixture.messages.filter(value => value.name === 'account-reset').at(-1).value.label, 'Account 1 · Personal');
    assert.equal(fixture.files.get(fixture.ledgerFile), stored);
    fixture.invoke('settings', {language:'zh-CN'});
    fixture.notify(event);
    assert.equal(fixture.messages.filter(value => value.name === 'account-reset').at(-1).value.label, account.label);
    fixture.invoke('rename-account', account.id, '我的独立别名 <img src=x>');
    fixture.invoke('settings', {language:'en'});
    const renamedStored = fixture.files.get(fixture.ledgerFile);
    fixture.notify(event);
    assert.equal(fixture.messages.filter(value => value.name === 'account-reset').at(-1).value.label, '我的独立别名 <img src=x>');
    assert.equal(fixture.files.get(fixture.ledgerFile), renamedStored);
    assert.deepEqual(Object.keys(fixture.messages.filter(value => value.name === 'account-reset').at(-1).value).sort(), ['estimated','id','label','resetsAt']);
  });
  test(`${variant.name}: account IPC uses the production registry and keeps records out of public status`, async t => {
    const fixture = await harness(variant); t.after(() => fixture.close());
    const initial = plain(fixture.invoke('list-accounts'));
    assert.equal(initial.count, 1); assert.equal(initial.accounts[0].current, true);
    assert.equal(initial.accounts[0].remainingPercent, 40);
    assert.doesNotMatch(JSON.stringify(initial), /[a-f0-9]{64}|synthetic-control-token/);
    assert.throws(() => fixture.foreign('list-accounts'), /无效窗口/);
    assert.throws(() => fixture.foreign('rename-account', initial.accounts[0].id, 'Foreign label'), /无效窗口/);
    const renamed = plain(fixture.invoke('rename-account', initial.accounts[0].id, '工作账号'));
    assert.equal(renamed.accounts[0].label, '工作账号');
    assert.equal(fixture.state().accountManagement.accounts[0].label, '工作账号');
    const status = await fixture.publicStatus();
    assert.equal(status.status, 'live');
    for (const field of ['accountManagement', 'accounts', 'accountRegistry', 'accountIdentity', 'internalKey']) assert.equal(Object.hasOwn(status, field), false);
    assert.doesNotMatch(JSON.stringify(status), /工作账号|[a-f0-9]{64}/);
    const removed = plain(fixture.invoke('remove-account', initial.accounts[0].id));
    assert.equal(removed.count, 0);
  });

  test(`${variant.name}: fresh quota crossing the old deadline delivers one alert before replacing the window`, async t => {
    const fixture = await harness(variant); t.after(() => fixture.close());
    fixture.setTime(initialTime + 61000);
    fixture.source.response = quota(initialTime / 1000 + 18060);
    await fixture.invoke('refresh');
    const events = fixture.messages.filter(item => item.name === 'account-reset');
    assert.equal(events.length, 1);
    assert.deepEqual(Object.keys(events[0].value).sort(), ['estimated', 'id', 'label', 'resetsAt']);
    assert.doesNotMatch(JSON.stringify(events), /[a-f0-9]{64}/);
    await fixture.refresh(); assert.equal(fixture.messages.filter(item => item.name === 'account-reset').length, 1);
    assert.equal(plain(fixture.invoke('list-accounts')).accounts[0].status, 'countdown');
  });

  test(`${variant.name}: a failed deadline acknowledgement cannot be overwritten by a newer quota window`, async t => {
    const fixture = await harness(variant); t.after(() => fixture.close());
    fixture.setTime(initialTime + 61000); fixture.failLedgerWrites(1);
    fixture.source.response = quota(initialTime / 1000 + 18060);
    await fixture.refresh();
    assert.equal(fixture.messages.filter(item => item.name === 'account-reset').length, 1, 'Retry may notify only after its durable acknowledgement succeeds');
    assert.equal(plain(fixture.invoke('list-accounts')).accounts[0].resetsAt, initialTime / 1000 + 60);
    assert.equal(fixture.state().accountManagement.storageError, true);
    await fixture.refresh();
    assert.equal(fixture.messages.filter(item => item.name === 'account-reset').length, 1);
    assert.equal(plain(fixture.invoke('list-accounts')).accounts[0].resetsAt, initialTime / 1000 + 18060);
    assert.equal(fixture.state().accountManagement.storageError, false);
  });

  test(`${variant.name}: a corrupt ledger remains visible as a storage error during offline startup`, async t => {
    const fixture = await harness(variant, { corruptLedger: true, offline: true }); t.after(() => fixture.close());
    assert.equal(plain(fixture.invoke('list-accounts')).storageError, true);
    assert.equal(fixture.files.get(fixture.ledgerFile), '{ invalid fixture');
    assert.equal(fixture.writes.some(file => file.startsWith(fixture.ledgerFile)), false);
  });

  test(`${variant.name}: sound mute preserves widget reminders while disabled reminders never replay`, async t => {
    const fixture = await harness(variant); t.after(() => fixture.close());
    fixture.invoke('settings', { sound: false }); fixture.setTime(initialTime + 61000); fixture.fireAlarm();
    assert.equal(fixture.messages.filter(item => item.name === 'account-reset').length, 1);
    fixture.invoke('settings', { accountResetAlerts: false });
    fixture.source.response = quota(initialTime / 1000 + 120); await fixture.refresh();
    fixture.setTime(initialTime + 121000); fixture.fireAlarm();
    fixture.invoke('settings', { accountResetAlerts: true }); fixture.setTime(initialTime + 151000); fixture.fireAlarm();
    assert.equal(fixture.messages.filter(item => item.name === 'account-reset').length, 1);
  });

  test(`${variant.name}: each account produces one widget reminder and only safe fields are sent`, async t => {
    const fixture = await harness(variant); t.after(() => fixture.close());
    fixture.source.accountIdentity = accountB; fixture.source.response = quota(initialTime / 1000 + 90); await fixture.refresh();
    fixture.setTime(initialTime + 91000); fixture.source.response = quota(initialTime / 1000 + 18090);
    await fixture.refresh(); await fixture.refresh();
    const events = fixture.messages.filter(item => item.name === 'account-reset');
    assert.equal(events.length, 2);
    assert.deepEqual(events.map(item => item.value.id), ['account-1', 'account-2']);
    for (const event of events) assert.deepEqual(Object.keys(event.value).sort(), ['estimated', 'id', 'label', 'resetsAt']);
    assert.doesNotMatch(JSON.stringify(events), /[a-f0-9]{64}/);
  });

  for (const destroyed of [false, true]) {
    test(`${variant.name}: an account deadline safely expires with ${destroyed ? 'a destroyed' : 'no current'} widget`, async t => {
      const fixture = await harness(variant); t.after(() => fixture.close());
      fixture.removeWidget(destroyed); fixture.setTime(initialTime + 61000);
      assert.doesNotThrow(() => fixture.fireAlarm());
      assert.equal(fixture.messages.filter(item => item.name === 'account-reset').length, 0);
      assert.doesNotThrow(() => fixture.notify({ id: 'account-1', label: 'Synthetic', resetsAt: initialTime / 1000 + 60, estimated: true }));
      assert.equal(fixture.messages.filter(item => item.name === 'account-reset').length, 0);
    });
  }

  test(`${variant.name}: an account switch discards a late refresh and never associates it with the new login`, async t => {
    const fixture = await harness(variant); t.after(() => fixture.close());
    let release;
    fixture.source.response = () => new Promise(resolve => { release = resolve; });
    const old = fixture.refresh(); await flush();
    fixture.authChanged(); assert.equal(fixture.source.invalidations, 1);
    fixture.source.accountIdentity = accountB; fixture.source.response = quota(initialTime / 1000 + 600);
    await fixture.refresh();
    release(quota(initialTime / 1000 + 900)); await old;
    const records = plain(fixture.invoke('list-accounts')).accounts;
    assert.equal(records.length, 2); assert.equal(records[0].current, false); assert.equal(records[1].current, true);
    assert.equal(records[0].resetsAt, initialTime / 1000 + 60);
    assert.equal(records[1].resetsAt, initialTime / 1000 + 600);
    fixture.source.response = { ...quota(initialTime / 1000 + 1000), invalidated: true };
    await fixture.refresh(); assert.equal(plain(fixture.invoke('list-accounts')).accounts[1].resetsAt, initialTime / 1000 + 600);
  });

  test(`${variant.name}: demo startup never loads, reads or writes the real account ledger`, async t => {
    const fixture = await harness(variant, { demo: true }); t.after(() => fixture.close());
    assert.equal(fixture.source.readCount, 0);
    assert.equal(fixture.dependencies.includes('./account-registry.cjs'), false);
    assert.equal(fixture.dependencies.includes('./account-alarm.cjs'), false);
    assert.equal(fixture.reads.includes(fixture.ledgerFile), false);
    assert.equal(fixture.writes.some(file => file.startsWith(fixture.ledgerFile)), false);
    assert.equal(plain(fixture.invoke('list-accounts')).count, 0);
    fixture.invoke('rename-account', 'account-1', 'Ignored'); fixture.invoke('remove-account', 'account-1');
    assert.equal(fixture.files.has(fixture.ledgerFile), false);
  });

  test(`${variant.name}: one login with personal and work plans creates distinct local quota records`, async t => {
    const fixture = await harness(variant, { realSource: true }); t.after(() => fixture.close());
    const first = plain(fixture.invoke('list-accounts')).accounts[0];
    assert.equal(first.planType, 'pro'); assert.equal(first.current, true);
    await fixture.signIn({ type: 'chatgpt', email: 'same-person@example.test', planType: 'team' }, initialTime / 1000 + 900);
    const records = plain(fixture.invoke('list-accounts')).accounts;
    assert.equal(records.length, 2);
    assert.deepEqual(records.map(item => item.planType), ['pro', 'team']);
    assert.deepEqual(records.map(item => item.current), [false, true]);
    assert.deepEqual(records.map(item => item.resetsAt), [initialTime / 1000 + 60, initialTime / 1000 + 900]);
    await fixture.signIn({ type: 'chatgpt', email: 'same-person@example.test', planType: 'pro' }, initialTime / 1000 + 60);
    const returned = plain(fixture.invoke('list-accounts')).accounts;
    assert.equal(returned.length, 2); assert.equal(returned[0].id, first.id);
    assert.deepEqual(returned.map(item => item.current), [true, false]);
    assert.match(returned[0].label, /资料测试昵称/);
    assert.doesNotMatch(JSON.stringify(await fixture.publicStatus()), /same-person|example\.test|[a-f0-9]{64}/);
  });

  test(`${variant.name}: account display metadata is local, preserves aliases and rejects a stale generation`, async t => {
    const fixture = await harness(variant, { realSource: true }); t.after(() => fixture.close());
    const initial = plain(fixture.invoke('list-accounts')).accounts[0];
    assert.match(initial.label, /资料测试昵称/);
    fixture.invoke('rename-account', initial.id, '我的主力账号'); await fixture.refresh();
    assert.equal(plain(fixture.invoke('list-accounts')).accounts[0].label, '我的主力账号');
    fixture.invoke('rename-account', initial.id, '');
    assert.match(plain(fixture.invoke('list-accounts')).accounts[0].label, /资料测试昵称/);
    await fixture.signIn({ type:'chatgpt', email:'synthetic-work@example.test', planType:'team', name:'账户资料名', fixtureProfileNickname:'真正昵称', fixtureWorkspaceName:'示例工作空间' }, initialTime / 1000 + 900);
    const current = plain(fixture.invoke('list-accounts')).accounts.find(item => item.current);
    assert.match(current.label, /真正昵称/); assert.match(current.label, /示例工作空间/);
    assert.doesNotMatch(current.label, /账户资料名|synthetic-work/);
    assert.doesNotMatch(JSON.stringify(await fixture.publicStatus()), /same-person|synthetic-work|example\.test|资料测试昵称|真正昵称|示例工作空间|我的主力账号/);
    const presentation = fixture.source.accountPresentation;
    fixture.source.accountPresentation = { ...presentation, generation: presentation.generation - 1, profileNickname:'过期昵称', displayName:'过期名字', email:'stale@example.test', workspaceName:'过期团队' };
    fixture.source.read = async () => ({...quota(initialTime / 1000 + 1000),generation:presentation.generation});
    await fixture.refresh();
    const stillCurrent = plain(fixture.invoke('list-accounts')).accounts.find(item => item.current);
    assert.equal(stillCurrent.label, current.label);
    assert.doesNotMatch(stillCurrent.label, /过期|stale/);
  });
}
