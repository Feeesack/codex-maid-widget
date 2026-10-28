'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');

const profile = 'R:\\隔离 用户\\Local Data', home = 'R:\\隔离 用户\\Profile', temporary = 'R:\\隔离 用户\\Temporary';
const first = 'S:\\工具 目录\\codex.exe', second = 'T:\\Other CLI\\codex.exe', third = 'U:\\Last CLI\\codex.exe';
const privateError = code => Object.assign(new Error('fixture private path token account@example.test'), { code });
function memoryFiles(files, directories = []) {
  const normalize = file => path.win32.normalize(file).toLowerCase();
  const keys = new Map(files.map(file => [normalize(file), 'file']));
  for (const directory of directories) keys.set(normalize(directory), 'directory');
  const lookup = file => {
    const kind = keys.get(normalize(file));
    if (!kind) throw Object.assign(new Error('fixture missing'), { code: 'ENOENT' });
    return { isFile: () => kind === 'file', isDirectory: () => kind === 'directory', isSymbolicLink: () => false, size: 32, mtimeMs: 1 };
  };
  return { constants: fs.constants, statSync: lookup, lstatSync: lookup, realpathSync(file) { lookup(file); return file; },
    readdirSync(directory) {
      lookup(directory);
      return [...keys].filter(([file]) => path.win32.dirname(file) === normalize(directory)).map(([file, kind]) => ({
        name: path.win32.basename(file), isDirectory: () => kind === 'directory', isSymbolicLink: () => false,
      }));
    },
    accessSync(file) { lookup(file); }, readFileSync() { throw Error('Fixture forbids user-file reads'); },
  };
}

// Isolate OS directory functions and every filesystem dependency as well as
// env. No dependency may fall back to the test runner's real profile or CLI.
function loadVariant(variant, fileSystem, env) {
  const root = path.resolve(__dirname, variant), cache = new Map();
  const context = vm.createContext({ process: { platform: 'win32', env, getuid: () => undefined },
    Buffer, Set, Map, Promise, AbortController, setTimeout, clearTimeout, queueMicrotask });
  function load(filename) {
    filename = path.resolve(filename);
    if (cache.has(filename)) return cache.get(filename).exports;
    const module = { exports: {} }; cache.set(filename, module);
    const actualRequire = createRequire(filename);
    const isolatedRequire = name => {
      if (name === 'node:os') return { homedir: () => home, tmpdir: () => temporary };
      if (name === 'node:fs') return fileSystem;
      if (name === 'node:fs/promises') return new Proxy({}, { get: () => () => { throw Error('Fixture forbids user-file reads'); } });
      if (name === 'node:child_process') return { spawn() { throw Error('Fixture must inject spawn'); } };
      if (name === './macos-bundle.cjs') return { MacBundleReader: class { read() { throw Error('Fixture must inject bundle metadata'); } } };
      if (name.startsWith('./') && name.endsWith('.cjs')) return load(path.resolve(path.dirname(filename), name));
      return actualRequire(name);
    };
    const wrapper = vm.runInContext('(function(require,module,exports,__filename,__dirname){\n' + fs.readFileSync(filename, 'utf8') + '\n})', context, { filename });
    wrapper(isolatedRequire, module, module.exports, filename, path.dirname(filename));
    return module.exports;
  }
  return { ...load(path.join(root, 'src/codex-data.cjs')), load };
}
function childProcess(behavior) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = new EventEmitter();
  child.stdout.setEncoding = () => {};
  child.kills = 0; child.destroys = 0; child.methods = []; child.callbacks = [];
  child.kill = () => { child.kills++; }; child.stdin.destroy = () => { child.destroys++; };
  child.reply = (message, result = {}) => child.stdout.emit('data', JSON.stringify({ id: message.id, result }) + '\n');
  child.rpcError = (message, code = 401, detail = 'unauthorized fixture private token') => child.stdout.emit('data', JSON.stringify({ id: message.id, error: { code, message: detail } }) + '\n');
  child.stdin.write = (value, callback) => {
    const message = JSON.parse(value); child.methods.push(message.method); child.callbacks.push(callback);
    const handled = behavior?.(message, child, callback);
    if (!handled) {
      if (message.method === 'initialize') queueMicrotask(() => child.reply(message));
      else if (message.method === 'account/read') queueMicrotask(() => child.reply(message, { account: { type: 'chatgpt' } }));
      else if (message.method === 'account/rateLimits/read') queueMicrotask(() => child.reply(message, { rateLimits: { primary: { usedPercent: 10 } } }));
    }
    if (handled !== 'hold-write') callback?.();
  };
  return child;
}
function fixture(variant, { files = [first, second], directories = [], options = {}, launch, queryDesktop } = {}) {
  const env = { Path: [first, second, third].map(file => path.win32.dirname(file)).join(';'), LOCALAPPDATA: profile,
    USERPROFILE: home, HOME: home, TEMP: temporary, TMP: temporary, CODEX_HOME: home + '\\Codex', CODEX_MAID_HOME: home + '\\Widget' };
  const fileSystem = memoryFiles(files, directories), api = loadVariant(variant, fileSystem, env), launches = [], children = [];
  const server = new api.ReadOnlyAppServer({ platform: 'win32', env, homedir: home, fileSystem, codexHome: env.CODEX_HOME,
    queryDesktop: queryDesktop || (async () => ({ known: true, roots: [] })), startupTimeoutMs: 2000, ...options,
    spawn(file, args, settings) {
      launches.push(file); assert.equal(settings.cwd, temporary); assert.equal(settings.env.CODEX_HOME, env.CODEX_HOME);
      assert.equal(Object.hasOwn(settings, 'shell'), false);
      assert.equal(args.join(' '), 'app-server --listen stdio:// -c analytics.enabled=false');
      const child = launch?.(launches.length, file) || childProcess(); children.push(child); return child;
    } });
  return { ...api, server, launches, children };
}
async function until(predicate) {
  for (let count = 0; count < 100 && !predicate(); count++) await Promise.resolve();
  assert.ok(predicate(), 'fixture did not reach the awaited phase');
}
function assertReleased(server, children) {
  assert.equal(server.child, null); assert.equal(server.pending.size, 0);
  assert.equal(server.connecting, null); assert.equal(server.discovery, null);
  for (const child of children) { assert.equal(child.kills, 1); assert.equal(child.destroys, 1); }
}

for (const variant of ['..', '../macos']) {
  test(variant + ': denied first CLI falls back to a versioned per-user CLI with isolated paths', async t => {
    const root = path.win32.join(profile, 'OpenAI', 'Codex'), bin = path.win32.join(root, 'bin');
    const directory = path.win32.join(bin, 'opaque-build_2026'), versioned = path.win32.join(directory, 'codex.exe');
    const h = fixture(variant, { files: [first, versioned], directories: [root, bin, directory],
      launch(number) { if (number === 1) throw privateError('EACCES'); } });
    t.after(() => h.server.close()); await h.server.connect();
    assert.equal(h.launches.join('|'), [first, versioned].join('|'));
    assert.equal(h.server.generation, 0); assert.equal(h.server.pending.size, 0);
    await h.server.request('account/read');
    assert.ok(h.children.every(child => child.methods.every(method => ['initialize', 'initialized', 'account/read'].includes(method))));
  });
  for (const failure of ['error', 'exit', 'timeout', 'pipe']) {
    test(variant + ': ' + failure + ' during initialization retries and releases the failed process', async t => {
      const h = fixture(variant, { options: { timeoutMs: failure === 'timeout' ? 12 : 1000 },
        launch(number) {
          if (number !== 1) return;
          return childProcess((message, child) => {
            if (message.method !== 'initialize') return;
            if (failure === 'error') queueMicrotask(() => child.emit('error', privateError('EACCES')));
            if (failure === 'exit') queueMicrotask(() => child.emit('exit', 1));
            if (failure === 'pipe') queueMicrotask(() => child.stdin.emit('error', privateError('EPIPE')));
            return true;
          });
        } });
      t.after(() => h.server.close()); await Promise.all([h.server.connect(), h.server.connect()]);
      assert.equal(h.launches.join('|'), [first, second].join('|'));
      assert.equal(h.children[0].kills, 1); assert.equal(h.children[0].destroys, 1);
      assert.equal(h.children[1].kills, 0); assert.equal(h.server.pending.size, 0);
      h.children[0].emit('error', privateError('EPERM')); h.children[0].emit('exit', 1);
      h.children[0].stdin.emit('error', privateError('EPIPE')); h.children[0].stdout.emit('data', 'null\n');
      h.children[0].callbacks[0]?.(privateError('EPIPE'));
      assert.equal(h.children[1].kills, 0); await h.server.request('account/read');
    });
  }
  for (const failure of ['notification-pipe', 'notification-timeout', 'notification-exit-after-write', -32601, -32602]) {
    test(variant + ': initialization compatibility/write failure ' + failure + ' falls back before account RPCs', async t => {
      const h = fixture(variant, { options: { timeoutMs: failure === 'notification-timeout' ? 12 : 1000 },
        launch(number) {
          if (number !== 1) return;
          return childProcess((message, child, callback) => {
            if (typeof failure === 'number' && message.method === 'initialize') {
              queueMicrotask(() => child.rpcError(message, failure, 'unsupported fixture private token')); return true;
            }
            if (typeof failure === 'string' && message.method === 'initialized') {
              if (failure === 'notification-pipe') queueMicrotask(() => callback(privateError('EPIPE')));
              if (failure === 'notification-exit-after-write') { callback(); child.emit('exit', 1); }
              return 'hold-write';
            }
          });
        } });
      t.after(() => h.server.close()); await h.server.connect();
      assert.equal(h.launches.join('|'), [first, second].join('|'));
      assert.equal(h.children[0].kills, 1); assert.equal(h.server.pending.size, 0);
      assert.equal(h.children[0].methods.includes('account/read'), false);
      await h.server.request('account/read');
    });
  }
  test(variant + ': explicit CLI failures never substitute another installation', async () => {
    for (const mode of ['synchronous', 'timeout']) {
      const h = fixture(variant, { options: { codexPath: first, timeoutMs: 12 },
        launch() { if (mode === 'synchronous') throw privateError('EACCES'); return childProcess(message => message.method === 'initialize'); } });
      await assert.rejects(h.server.connect(), { code: mode === 'synchronous' ? 'EACCES' : 'TIMEOUT' });
      assert.equal(h.launches.join('|'), first); assertReleased(h.server, h.children); h.server.close();
    }
  });
  test(variant + ': final failure preserves the launch reason and exposes only translated public diagnostics', async () => {
    const h = fixture(variant, { files: [first], launch() { throw privateError('EPERM'); } }); let failure;
    await assert.rejects(h.server.connect(), error => { failure = error; return error.code === 'EPERM'; });
    const message = h.friendlyError(failure);
    assert.match(message, /系统拒绝/); assert.doesNotMatch(message, /private|token|account@example|R:\\|S:\\/);
    assert.match(h.friendlyError(privateError('EXIT')), /未能正常启动/);
    const i18n = h.load(path.resolve(__dirname, variant, 'src/i18n.js')); i18n.setLocale('en');
    assert.match(i18n.t(message), /system refused/);
    assert.match(i18n.t(h.friendlyError(privateError('EXIT'))), /could not start the quota service/);
    assertReleased(h.server, h.children); h.server.close();
  });
  for (const phase of ['initialize', 'account/read', 'account/rateLimits/read']) {
    test(variant + ': authentication failure at ' + phase + ' never falls back to another CLI', async () => {
      const h = fixture(variant, { launch() {
        return childProcess((message, child) => {
          if (message.method !== phase) return;
          queueMicrotask(() => child.rpcError(message)); return true;
        });
      } });
      const source = new h.CodexDataSource({ server: h.server, localReader: { read: async () => ({}) },
        codexHome: home + '\\Codex', now: () => new Date('2026-10-23T00:00:00Z') });
      const snapshot = await source.read();
      assert.equal(h.launches.join('|'), first);
      assert.match(snapshot.error, /尚未登录|登录已过期/); assert.doesNotMatch(JSON.stringify(snapshot), /private|token|account@example/);
      assertReleased(h.server, h.children); source.close();
    });
  }
  test(variant + ': unsupported authentication with a compatibility error code does not select another CLI', async () => {
    const h = fixture(variant, { launch() { return childProcess((message, child) => {
      if (message.method !== 'initialize') return;
      queueMicrotask(() => child.rpcError(message, -32602, 'unsupported auth fixture private token')); return true;
    }); } });
    const source = new h.CodexDataSource({ server: h.server, localReader: { read: async () => ({}) }, codexHome: home + '\\Codex' });
    const snapshot = await source.read();
    assert.equal(h.launches.length, 1); assert.match(snapshot.error, /当前登录方式/);
    assert.doesNotMatch(snapshot.error, /private|token/); assertReleased(h.server, h.children); source.close();
  });
  test(variant + ': close cancels a shared initializing connection without launching the fallback', async () => {
    const h = fixture(variant, { launch() { return childProcess(message => message.method === 'initialize'); } });
    const firstRead = h.server.connect(), sharedRead = h.server.connect();
    const rejected = Promise.all([assert.rejects(firstRead, { code: 'CLOSED' }), assert.rejects(sharedRead, { code: 'CLOSED' })]);
    await until(() => h.children.length === 1 && h.server.pending.size === 1); h.server.close(); await rejected;
    assert.equal(h.launches.length, 1); assertReleased(h.server, h.children);
  });
  test(variant + ': close cancels an initialized pipe acknowledgement and ignores its late callback', async () => {
    let acknowledgement;
    const h = fixture(variant, { launch() { return childProcess((message, child, callback) => {
      if (message.method === 'initialized') { acknowledgement = callback; return 'hold-write'; }
    }); } });
    const connecting = h.server.connect(), rejected = assert.rejects(connecting, { code: 'CLOSED' });
    await until(() => !!acknowledgement); h.server.close(); await rejected;
    acknowledgement(privateError('EPIPE'));
    assert.equal(h.launches.length, 1); assertReleased(h.server, h.children);
  });
  test(variant + ': invalidating initialization leaves a newer transaction and its late events intact', async () => {
    let newInitialize;
    const h = fixture(variant, { launch(number) {
      return childProcess((message, child) => {
        if (message.method !== 'initialize') return;
        if (number === 2) newInitialize = () => child.reply(message);
        return true;
      });
    } });
    const old = h.server.connect(), oldRejected = assert.rejects(old, { code: 'INVALIDATED' });
    await until(() => h.server.pending.size === 1); h.server.disconnect(privateError('INVALIDATED'));
    const current = h.server.connect(), transaction = h.server.connecting;
    await oldRejected; await until(() => !!newInitialize); assert.equal(h.server.connecting, transaction);
    h.children[0].emit('error', privateError('EACCES')); h.children[0].emit('exit', 1);
    assert.equal(h.children[1].kills, 0); newInitialize(); await current;
    assert.equal(h.launches.join('|'), [first, first].join('|')); h.server.close(); assertReleased(h.server, h.children);
  });
  test(variant + ': attempt and overall startup budgets stop retrying and clean up', async () => {
    const attempts = fixture(variant, { files: [first, second, third], options: { maxStartupAttempts: 2 },
      launch() { throw privateError('EACCES'); } });
    await assert.rejects(attempts.server.connect(), { code: 'EACCES' });
    assert.equal(attempts.launches.length, 2); assertReleased(attempts.server, attempts.children); attempts.server.close();
    const timeout = fixture(variant, { options: { startupTimeoutMs: 15, timeoutMs: 1000 },
      launch() { return childProcess(message => message.method === 'initialize'); } });
    await assert.rejects(timeout.server.connect(), { code: 'TIMEOUT' });
    assert.equal(timeout.launches.length, 1); assertReleased(timeout.server, timeout.children); timeout.server.close();
    let signal;
    const discovery = fixture(variant, { files: [], options: { startupTimeoutMs: 15 },
      queryDesktop(options) { signal = options.signal; return new Promise(() => {}); } });
    await assert.rejects(discovery.server.connect(), { code: 'TIMEOUT' });
    assert.equal(signal.aborted, true); assert.equal(discovery.launches.length, 0);
    assertReleased(discovery.server, discovery.children); discovery.server.close();
  });
}
