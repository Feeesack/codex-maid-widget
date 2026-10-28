'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const flush = () => new Promise(resolve => setImmediate(resolve));
const projectRoot = path.join(__dirname, '..');
const variants = [
  { name: 'Windows', root: projectRoot },
  { name: 'macOS', root: path.join(projectRoot, 'macos') },
];

// Execute only the production quit listener. No application boot, native process,
// filesystem write, account source, data-home lookup or actual provider exists.
function harness(variant, { service = null, draftResponse = 0 } = {}) {
  const file = path.join(variant.root, 'src', 'main.cjs');
  const source = fs.readFileSync(file, 'utf8');
  const start = source.indexOf("app.on('before-quit', event => {");
  assert.ok(start > 0);
  assert.match(source, /let chatQuitPreparing = false, chatQuitPrepared = false;/);
  const calls = [], notices = [], events = [];
  let listener, quitCalls = 0, openCalls = 0, copied = null;
  const cleanup = name => ({ close() { calls.push(name); } });
  const app = {
    on(name, callback) { assert.equal(name, 'before-quit'); listener = callback; },
    quit() { quitCalls++; emit(); },
  };
  const context = vm.createContext({
    app, chatService: service, chatWindow: null, widget: { marker: 'isolated widget' },
    chatQuitPreparing: false, chatQuitPrepared: false, quitting: false,
    dialog: {
      showMessageBoxSync(_owner, options) { notices.push({ kind: 'draft', options }); return draftResponse; },
      showErrorBox(title, detail) { notices.push({ kind: 'unconfirmed', title, detail }); },
    },
    t: text => text,
    require(name) {
      assert.equal(name, 'electron');
      return { clipboard: { writeText(text) { copied = text; } } };
    },
    openChatManager() { openCalls++; },
    cancelPose() { calls.push('pose'); }, accountAlarm: cleanup('alarm'), resetForecastSource: cleanup('forecast'),
    clearInterval() { calls.push('interval'); }, clearTimeout() { calls.push('timeout'); }, timer: null, authRefreshTimer: null,
    windowMode: cleanup('window'), stopAuthWatch() { calls.push('watch'); }, desktopMonitor: { stop() { calls.push('desktop'); } },
    globalShortcut: { unregisterAll() { calls.push('shortcuts'); } }, source: cleanup('source'), controlServer: cleanup('control'),
    ownsControl: false,
    fs: new Proxy({}, { get() { assert.fail('quit fixture must never access a real filesystem'); } }),
  });
  vm.runInContext(source.slice(start), context, { filename: file });
  function emit() {
    const event = { prevented: false, preventDefault() { this.prevented = true; } };
    events.push(event); listener(event); return event;
  }
  return { emit, calls, notices, events, context, get quitCalls() { return quitCalls; },
    get openCalls() { return openCalls; }, get copied() { return copied; } };
}

function serviceFixture(overrides = {}) {
  const calls = [];
  const service = {
    hasPendingDrafts: () => false,
    async prepareClose() { calls.push('prepare'); return { terminalConfirmed: true }; },
    close() { calls.push('close'); },
    ...overrides,
  };
  return { service, calls };
}

for (const variant of variants) {
  test(`${variant.name}: unopened chat retains synchronous quit without chat initialization`, () => {
    const h = harness(variant);
    assert.equal(h.emit().prevented, false);
    assert.equal(h.context.quitting, true);
    assert.equal(h.quitCalls, 0);
    assert.ok(h.calls.includes('control'));
  });

  for (const response of [0, 1]) {
    test(`${variant.name}: draft response ${response} returns before reconciliation and cleanup`, async () => {
      const s = serviceFixture({ hasPendingDrafts: () => true, copyPendingDrafts: () => 'synthetic unsent draft' });
      const h = harness(variant, { service: s.service, draftResponse: response });
      assert.equal(h.emit().prevented, true); await flush();
      assert.deepEqual(s.calls, []); assert.deepEqual(h.calls, []);
      assert.equal(h.openCalls, 1); assert.equal(h.quitCalls, 0);
      assert.equal(h.copied, response === 1 ? 'synthetic unsent draft' : null);
    });
  }

  test(`${variant.name}: discard is explicit and precedes bounded request reconciliation`, async () => {
    let drafts = true;
    const s = serviceFixture({ hasPendingDrafts: () => drafts,
      discardDrafts() { drafts = false; s.calls.push('discard'); } });
    const h = harness(variant, { service: s.service, draftResponse: 2 });
    assert.equal(h.emit().prevented, true); assert.deepEqual(s.calls, ['discard']);
    await flush();
    assert.deepEqual(s.calls, ['discard', 'prepare', 'close']);
    assert.equal(h.notices.filter(n => n.kind === 'draft').length, 1);
    assert.equal(h.context.quitting, true);
  });

  test(`${variant.name}: repeated quit is deduplicated until reconciliation completes`, async () => {
    let resolvePrepare;
    const s = serviceFixture({ prepareClose() {
      s.calls.push('prepare'); return new Promise(resolve => { resolvePrepare = resolve; });
    } });
    const h = harness(variant, { service: s.service });
    assert.equal(h.emit().prevented, true); await flush();
    assert.equal(h.emit().prevented, true); assert.equal(h.emit().prevented, true);
    assert.deepEqual(s.calls, ['prepare']); assert.deepEqual(h.calls, []);
    assert.equal(h.quitCalls, 0); assert.equal(h.context.quitting, false);
    resolvePrepare({ terminalConfirmed: true }); await flush();
    assert.deepEqual(s.calls, ['prepare', 'close']); assert.equal(h.quitCalls, 1);
    assert.equal(h.events.at(-1).prevented, false); assert.equal(h.context.quitting, true);
  });

  for (const rejected of [false, true]) {
    test(`${variant.name}: ${rejected ? 'failed' : 'unconfirmed'} reconciliation visibly degrades without retrying or archiving`, async () => {
      const s = serviceFixture({ async prepareClose() {
        s.calls.push('prepare'); if (rejected) throw new Error('synthetic provider error must remain private');
        return { terminalConfirmed: false, executionState: 'unknown' };
      } });
      const h = harness(variant, { service: s.service });
      assert.equal(h.emit().prevented, true); await flush();
      assert.deepEqual(s.calls, ['prepare', 'close']); assert.equal(h.quitCalls, 1);
      assert.equal(h.notices.length, 1); assert.equal(h.notices[0].kind, 'unconfirmed');
      assert.match(h.notices[0].detail, /下次启动/);
      assert.doesNotMatch(JSON.stringify(h.notices), /synthetic provider/);
    });
  }

  test(`${variant.name}: metadata failure prevents final exit and cleanup, then can be retried`, async () => {
    let failClose = true;
    const s = serviceFixture({ close() { s.calls.push('close'); if (failClose) throw new Error('synthetic metadata write failure'); } });
    const h = harness(variant, { service: s.service });
    h.emit(); await flush();
    assert.deepEqual(s.calls, ['prepare', 'close']); assert.equal(h.events.at(-1).prevented, true);
    assert.deepEqual(h.calls, []); assert.equal(h.context.quitting, false);
    failClose = false; assert.equal(h.emit().prevented, false);
    assert.deepEqual(s.calls, ['prepare', 'close', 'close']); assert.equal(h.context.quitting, true);
  });
}
