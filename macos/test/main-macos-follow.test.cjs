'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

// Execute the actual main controller with its UI startup branch disabled. All
// file, app and launchd operations below stay inside the VM's injected fakes.
// This catches races across production queue/dispatch/receipt code without
// copying its implementation into the test or requiring a running macOS app.
function controller(t) {
  const executable = '/Applications/Codex Maid.app/Contents/MacOS/Codex Maid';
  const files = new Map();
  const events = [];
  const app = new EventEmitter();
  Object.assign(app, { isPackaged: true, setName() {}, setPath() {}, getPath: () => '/fake-home',
    getVersion: () => 'test', requestSingleInstanceLock: () => false, quit() {} });
  let finishFinalizer;
  const finalizer = new Promise(resolve => { finishFinalizer = resolve; });
  const modules = {
    electron: { app },
    'node:fs': {
      mkdirSync() {},
      readFileSync(file) {
        const value = files.get(path.basename(file));
        if (value === undefined) throw Object.assign(new Error('absent fake file'), { code: 'ENOENT' });
        return JSON.stringify(value);
      },
    },
    './settings.cjs': { readSettings: () => ({ followCodex: false }) },
    './character-library.cjs': {},
    './codex-data.cjs': {},
    './codex-desktop.cjs': { buildLaunchArgs: ({ flag }) => [flag], CodexDesktopMonitor: class { start() {} stop() {} } },
    './auth-change-watch.cjs': {},
    './windows-launch.cjs': {},
    './macos-launch.cjs': {
      launchMacWatcher: async options => { events.push({ action: 'dispatch', ...options }); },
      finalizeMacWatcherRemoval: async () => { events.push({ action: 'finalize' }); await finalizer; events.push({ action: 'finalized' }); },
    },
    './platform.cjs': { supportsDesktopFollow: () => true },
    './data-home.cjs': { prepareDataHome: () => '/fake-home' },
    './desktop-observation.cjs': { sameExecutable: (a, b) => a === b },
  };
  const context = {
    require(name) {
      if (Object.hasOwn(modules, name)) return modules[name];
      if (name.startsWith('node:')) return require(name);
      throw new Error('Unexpected module: ' + name);
    },
    process: { platform: 'darwin', argv: [], execPath: executable, env: {}, kill() {} },
    __dirname: path.join(__dirname, '..', 'src'),
    module: { exports: {} }, setTimeout, clearTimeout, setInterval, clearInterval,
  };
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.cjs'), 'utf8');
  vm.runInNewContext(source + '\nmodule.exports = {\n' +
    'setFollow(value) { settings.followCodex = value; syncDesktopFollow(); return followOperation; },\n' +
    'getError() { return followError; }, stop() { quitting = true; return followOperation.catch(() => {}); }\n' +
    '};', context, { filename: 'main.cjs' });
  const api = context.module.exports;
  t.after(() => { finishFinalizer(); return api.stop(); });
  files.set('watcher.json', { pid: 123, executable, version: 'test', loginStartupEnabled: true, loginStartupError: '' });
  return { api, events, finishFinalizer,
    receipt(enabled) {
      const request = events.find(event => event.action === 'dispatch' && event.enabled === false);
      assert.ok(request, 'disable must dispatch before a receipt can exist');
      const id = request.args.find(value => value.startsWith('--follow-request=')).slice('--follow-request='.length);
      files.set('follow-startup.json', { requestId: id, executable, version: 'test', loginStartupEnabled: enabled, loginStartupError: '' });
    } };
}

function nextTurn() { return new Promise(resolve => setImmediate(resolve)); }
async function until(predicate) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail('controller did not reach the expected state');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

test('a quick macOS off/on waits for the disabled receipt and completed bootout before re-enabling', async t => {
  const { api, events, receipt, finishFinalizer } = controller(t);
  const disabling = api.setFollow(false);
  await nextTurn();
  assert.equal(events.length, 1);
  assert.equal(events[0].enabled, false);
  const enabling = api.setFollow(true);
  await new Promise(resolve => setTimeout(resolve, 180));
  assert.equal(events.length, 1, 'a new generation must not cancel the pending receipt wait');
  receipt(false);
  await until(() => events.some(event => event.action === 'finalize'));
  assert.equal(events.some(event => event.action === 'dispatch' && event.enabled), false, 'bootout must complete before bootstrap');
  finishFinalizer();
  await Promise.all([disabling, enabling]);
  assert.deepEqual(events.map(event => event.action === 'dispatch' ? 'dispatch:' + event.enabled : event.action),
    ['dispatch:false', 'finalize', 'finalized', 'dispatch:true']);
  assert.equal(api.getError(), '');
});

test('a quick macOS off/on accepts a correlated enabled receipt without booting out the active helper', async t => {
  const { api, events, receipt } = controller(t);
  const disabling = api.setFollow(false);
  await nextTurn();
  const enabling = api.setFollow(true);
  await new Promise(resolve => setTimeout(resolve, 180));
  assert.equal(events.length, 1, 're-enabling must wait until the helper reports which setting it observed');
  receipt(true);
  await Promise.all([disabling, enabling]);
  assert.deepEqual(events.map(event => event.action === 'dispatch' ? 'dispatch:' + event.enabled : event.action),
    ['dispatch:false', 'dispatch:true']);
  assert.equal(api.getError(), '');
});
