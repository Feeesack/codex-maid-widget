'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { CodexWindowMode } = require('../src/window-mode.cjs');
const { WindowTopmostController } = require('../src/window-topmost.cjs');

const flush = () => new Promise(resolve => setImmediate(resolve));
function fixture(t, { screen = {} } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const state = { bounds: { x: 100, y: 100, width: 228, height: 288 },
    hostBounds: { x: 100, y: 100, width: 900, height: 700 },
    foreground: true, known: true, visible: false, nativeVisible: true, above: true,
    floating: false, raises: 0, positions: 0, resizes: 0, status: 0, queries: 0 };
  const widget = {
    webContents: { send() {} }, on() {}, removeListener() {}, isDestroyed: () => false,
    getBounds: () => ({ ...state.bounds }),
    setBounds(value) { state.bounds = { ...value }; state.resizes++; },
    setPosition(x, y) { state.bounds = { ...state.bounds, x, y }; state.positions++; },
    getNativeWindowHandle: () => Buffer.from('1000000000000000', 'hex'),
    setAlwaysOnTop(value) { state.floating = value; }, isVisible: () => state.visible,
    show() { state.visible = true; }, showInactive() { state.visible = true; },
    hide() { state.visible = false; }, moveTop() {},
    moveAbove() { state.raises++; state.above = true; },
  };
  const provider = {
    async query() {
      state.queries++;
      return { known: state.known, supported: true, coordinateSpace: 'dip',
        foregroundWindow: state.foreground ? '41' : '0', foregroundPid: state.foreground ? 100 : 300,
        widgetVisible: state.nativeVisible,
        windows: [{ id: '41', pid: 100, bounds: { ...state.hostBounds }, visible: true,
          minimized: false, cloaked: false, foreground: state.foreground, widgetAboveHost: state.above }] };
    }, close() {},
  };
  const mode = new CodexWindowMode({ widget, screen, getSize: () => ({ width: 228, height: 288 }),
    platform: 'darwin', providerFactory: () => provider, intervalMs: 100000, activeIntervalMs: 100000,
    onStatus: () => state.status++ });
  t.after(() => mode.close());
  async function settle() { await flush(); await mode.topmost.settled(); clearTimeout(mode.timer); }
  async function refresh() { clearTimeout(mode.timer); await mode.tick(mode.epoch, provider); await settle(); }
  async function start() { mode.configure(true, { alwaysOnTop: true }); await settle(); }
  return { state, mode, refresh, settle, start };
}

test('click recovery raises a visible Mac companion and movement does not resize or republish the renderer', async t => {
  const { state, mode, refresh, start } = fixture(t);
  await start();
  assert.equal(state.visible, true);
  assert.equal(state.floating, true);
  state.above = false; state.raises = 0;
  await refresh();
  assert.equal(state.visible, true);
  assert.equal(state.raises, 1, 'a host click can cover a window without changing isVisible()');

  const before = { ...state, bounds: { ...state.bounds } };
  state.hostBounds = { ...state.hostBounds, x: 20, y: 140 };
  await refresh();
  assert.equal(state.bounds.x - before.bounds.x, -80);
  assert.equal(state.bounds.y - before.bounds.y, 40);
  assert.equal(state.positions, before.positions + 1);
  assert.equal(state.resizes, before.resizes);
  assert.equal(state.status, before.status, 'geometry-only changes do not refresh the character UI');
  assert.deepEqual(mode.getArea(), { x: 28, y: 148, width: 884, height: 684 });
  assert.equal(Object.hasOwn(mode.getState(), 'bounds'), false, 'native geometry is not added to public status');
});

test('Mac containment hides and drops floating level for another app, manual hide and unknown snapshots', async t => {
  const { state, mode, refresh, start, settle } = fixture(t);
  await start();
  state.foreground = false;
  await refresh();
  assert.equal(state.visible, false);
  assert.equal(state.floating, false);
  state.foreground = true;
  await refresh();
  t.mock.timers.tick(40); await settle();
  assert.equal(state.visible, true);
  assert.equal(state.floating, true);
  mode.hide(); await refresh();
  assert.equal(state.visible, false);
  assert.equal(state.floating, false);
  mode.show(); await refresh();
  t.mock.timers.tick(40); await settle();
  assert.equal(state.visible, true);
  state.known = false;
  await refresh();
  assert.equal(state.visible, false);
  assert.equal(state.floating, false);
});

test('stationary pointer bounds native polling while pointer movement starts a short tracking burst', async t => {
  let pointer = { x: 0, y: 0 };
  const { state, refresh, start } = fixture(t, { screen: { getCursorScreenPoint: () => pointer } });
  await start();
  await refresh(); // Establish the first cursor sample after entering containment.
  const initial = state.queries;
  t.mock.timers.tick(16); await refresh();
  assert.equal(state.queries, initial);
  pointer = { x: 1, y: 0 };
  state.hostBounds.x += 30;
  t.mock.timers.tick(16); await refresh();
  assert.equal(state.queries, initial + 1);
  t.mock.timers.tick(16); await refresh();
  assert.equal(state.queries, initial + 2, 'continue tracking even if the cursor pauses briefly during a drag');
  t.mock.timers.tick(260); await refresh();
  const settled = state.queries;
  t.mock.timers.tick(16); await refresh();
  assert.equal(state.queries, settled);
  t.mock.timers.tick(120); await refresh();
  assert.equal(state.queries, settled + 1, 'foreground and host metadata are still periodically rechecked');
});

test('Windows contained surfaces remain non-topmost even when given the Mac visibility hint', async t => {
  const writes = [], native = [];
  const controller = new WindowTopmostController({ platform: 'win32',
    widget: { on() {}, removeListener() {}, getNativeWindowHandle: () => Buffer.from([1, 0, 0, 0]),
      setAlwaysOnTop: value => writes.push(value) },
    providerFactory: () => ({ async setTopmost(_handle, value) { native.push(value); return { known: true, ok: true, topmost: value }; }, close() {} }) });
  t.after(() => controller.close());
  await controller.configure({ contained: true, containedVisible: true });
  assert.deepEqual(writes, [false]);
  assert.deepEqual(native, [false]);
  await controller.configure({ contained: false, alwaysOnTop: true });
  assert.deepEqual(writes, [false, true]);
});
