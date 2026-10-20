'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { CodexWindowMode } = require('../src/window-mode.cjs');
const { WindowTopmostController } = require('../src/window-topmost.cjs');

const flush = () => new Promise(resolve => setImmediate(resolve));
function fixture(t, { screen = {}, queryDelayMs = 0, sampleWindowVisibility = false, autoPolling = false } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const state = { bounds: { x: 100, y: 100, width: 228, height: 288 },
    hostBounds: { x: 100, y: 100, width: 900, height: 700 },
    foreground: true, known: true, visible: false, nativeVisible: true, above: true,
    floating: false, raises: 0, positions: 0, resizes: 0, status: 0, queries: 0,
    shows: 0, hides: 0, recoverNativeOnShow: false };
  function showWindow() {
    state.visible = true; state.shows++;
    if (state.recoverNativeOnShow) state.nativeVisible = true;
  }
  const widget = {
    webContents: { send() {} }, on() {}, removeListener() {}, isDestroyed: () => false,
    getBounds: () => ({ ...state.bounds }),
    setBounds(value) { state.bounds = { ...value }; state.resizes++; },
    setPosition(x, y) { state.bounds = { ...state.bounds, x, y }; state.positions++; },
    getNativeWindowHandle: () => Buffer.from('1000000000000000', 'hex'),
    setAlwaysOnTop(value) { state.floating = value; }, isVisible: () => state.visible,
    show: showWindow, showInactive: showWindow,
    hide() { state.visible = false; state.hides++; }, moveTop() {},
    moveAbove() { state.raises++; state.above = true; },
  };
  const provider = {
    async query() {
      state.queries++;
      const snapshot = { known: state.known, supported: true, coordinateSpace: 'dip',
        foregroundWindow: state.foreground ? '41' : '0', foregroundPid: state.foreground ? 100 : 300,
        widgetVisible: state.nativeVisible && (!sampleWindowVisibility || state.visible),
        windows: [{ id: '41', pid: 100, bounds: { ...state.hostBounds }, visible: true,
          minimized: false, cloaked: false, foreground: state.foreground, widgetAboveHost: state.above }] };
      // Capture native state before delivery: a reply can describe our own
      // previous hide even though the 40-ms remap has already shown the window.
      if (queryDelayMs) await new Promise(resolve => setTimeout(resolve, queryDelayMs));
      return snapshot;
    }, close() {},
  };
  const mode = new CodexWindowMode({ widget, screen, getSize: () => ({ width: 228, height: 288 }),
    platform: 'darwin', providerFactory: () => provider,
    ...(autoPolling ? {} : { intervalMs: 100000, activeIntervalMs: 100000 }),
    onStatus: () => state.status++ });
  t.after(() => mode.close());
  async function settle() { await flush(); await mode.topmost.settled(); clearTimeout(mode.timer); }
  async function refresh() { clearTimeout(mode.timer); await mode.tick(mode.epoch, provider); await settle(); }
  async function start() { mode.configure(true, { alwaysOnTop: true }); await settle(); }
  async function startPolling() { mode.configure(true, { alwaysOnTop: true }); await flush(); }
  async function advance(milliseconds) {
    // Flush each virtual millisecond so asynchronous query replies schedule
    // subsequent default 16/100-ms polls at their actual completion time.
    for (let elapsed = 0; elapsed < milliseconds; elapsed++) { t.mock.timers.tick(1); await flush(); }
  }
  return { state, mode, refresh, settle, start, startPolling, advance };
}

function pollingFixture(t, options = {}) {
  let pointer = 0;
  return fixture(t, { autoPolling: true, sampleWindowVisibility: true,
    screen: { getCursorScreenPoint: () => ({ x: pointer++, y: 0 }) }, ...options });
}

test('late native snapshots of our own hidden window do not restart Mac recovery', async t => {
  const { state, mode, startPolling, advance } = pollingFixture(t, { queryDelayMs: 60 });
  assert.equal(mode.activeIntervalMs, 16);
  assert.equal(mode.intervalMs, 100);
  assert.equal(mode.staleAfterMs, 2500);
  await startPolling();
  await advance(5000);
  assert.equal(state.visible, true);
  assert.equal(state.shows, 1);
  assert.equal(mode.visibility.snapshot().remaps, 0);
  assert.equal(mode.visibility.snapshot().nativeAttempts, 0);

  state.foreground = false;
  await advance(200);
  assert.equal(state.visible, false);
  state.foreground = true;
  await advance(5000);
  assert.equal(state.visible, true);
  assert.equal(state.shows, 2, 'returning to Codex only performs the lifecycle remap');
  assert.equal(mode.visibility.snapshot().remaps, 1);
  assert.equal(mode.visibility.snapshot().nativeAttempts, 0);
});

test('genuinely hidden Mac surfaces recover after the native visibility settle period', async t => {
  const { state, mode, startPolling, advance } = pollingFixture(t, { queryDelayMs: 60 });
  await startPolling();
  await advance(200);
  state.nativeVisible = false;
  state.recoverNativeOnShow = true;
  await advance(1359); // First show was at 1060; the 1500-ms settle period ends at 2560.
  assert.equal(mode.visibility.snapshot().nativeAttempts, 0);
  assert.equal(mode.visibility.snapshot().remaps, 0);
  await advance(500);
  assert.equal(state.nativeVisible, true, 'a real remap restores the native surface');
  assert.equal(state.visible, true);
  assert.equal(mode.visibility.snapshot().remaps, 1);
  await advance(3000);
  assert.equal(state.shows, 2);
  assert.equal(mode.visibility.snapshot().remaps, 1);
});

test('unrecoverable native visibility consumes at most three Mac remap attempts', async t => {
  const { state, mode, startPolling, advance } = pollingFixture(t, { queryDelayMs: 60 });
  await startPolling();
  await advance(200);
  state.nativeVisible = false;
  await advance(10000);
  assert.equal(mode.visibility.snapshot().nativeAttempts, 3);
  assert.equal(mode.visibility.snapshot().remaps, 3);
  assert.equal(state.shows, 4);
  await advance(5000);
  assert.equal(mode.visibility.snapshot().pending, false);
  assert.equal(mode.visibility.snapshot().remaps, 3);
  assert.equal(state.shows, 4);
});

for (const guard of ['manual hide', 'another foreground app']) {
  test(guard + ' cancels a pending Mac native visibility recovery', async t => {
    const { state, mode, startPolling, advance } = pollingFixture(t);
    await startPolling();
    await advance(200);
    state.nativeVisible = false;
    for (let elapsed = 0; elapsed < 2500 && !mode.visibility.snapshot().pending; elapsed++) await advance(1);
    assert.equal(mode.visibility.snapshot().pending, true);
    const shows = state.shows;
    if (guard === 'manual hide') mode.hide();
    else state.foreground = false;
    await advance(5000);
    assert.equal(state.visible, false);
    assert.equal(state.shows, shows);
    assert.equal(mode.visibility.snapshot().pending, false);
    assert.equal(mode.visibility.snapshot().remaps, 0);
  });
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
