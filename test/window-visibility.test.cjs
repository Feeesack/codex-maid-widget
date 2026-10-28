'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// Only the dependency-free controller is loaded. All state, native effects,
// clocks and timers are fixtures; no profile, Codex data or real HWND is read.
const variants = [
  ['Windows', path.join(__dirname, '../src/window-visibility.cjs')],
  ['macOS', path.join(__dirname, '../macos/src/window-visibility.cjs')],
];
function fixture(modulePath, overrides = {}) {
  const { createVisibilityController } = require(modulePath);
  const calls = [], timers = new Map();
  let time = 0, nextTimer = 1, windowSerial = 1, syncShow = null;
  const state = { ready: true, quitting: false, manuallyHidden: false, standalone: false,
    host: { hostAlive: true, visible: true, attached: true, embedded: true, modal: false,
      hostPid: 10, window: '123', visibilityRevision: 1, widgetVisible: true, widgetAboveHost: true }, ...overrides };
  const makeWindow = () => ({
    id: windowSerial++, visible: false, destroyed: false, failShow: false,
    isDestroyed() { return this.destroyed; }, isVisible() { return this.visible; },
    hide() { this.visible = false; calls.push({ kind: 'hide', window: this.id }); },
    showInactive() {
      calls.push({ kind: 'show', window: this.id });
      if (this.failShow) throw new Error('injected native failure');
      this.visible = true;
      syncShow?.();
    },
  });
  let window = makeWindow();
  const controller = createVisibilityController({ getWindow: () => window, getState: () => state,
    onShown: () => calls.push({ kind: 'shown' }), onVisibility: visible => calls.push({ kind: 'renderer', visible }),
    schedule(callback, delay) { const id = nextTimer++; timers.set(id, { callback, at: time + delay }); return id; },
    cancel: id => timers.delete(id), now: () => time,
  });
  return { controller, calls, state, timers, get window() { return window; },
    setSyncShow: callback => { syncShow = callback; },
    replaceWindow() { const old = window; window = makeWindow(); return old; },
    advance(ms) {
      const end = time + ms;
      for (let i = 0; i < 1000; i++) {
        const next = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) { time = end; return; }
        time = next[1].at; timers.delete(next[0]); next[1].callback();
      }
      throw new Error('Fixture timer loop');
    },
  };
}

for (const [name, modulePath] of variants) {
  test(name + ': readiness and manual guards prevent initial show and renderer exposure', () => {
    for (const overrides of [{ ready: false }, { quitting: true }, { manuallyHidden: true }]) {
      const h = fixture(modulePath, overrides);
      h.controller.update(); h.controller.requestRecovery(); h.advance(100);
      assert.equal(h.window.visible, false);
      assert.equal(h.calls.some(c => c.kind === 'show'), false);
      assert.equal(h.controller.snapshot().desired, false);
      assert.equal(h.calls.filter(c => c.kind === 'renderer').at(-1).visible, false);
    }
  });
  test(name + ': first show is immediate; normal heartbeats and geometry changes do nothing native', () => {
    const h = fixture(modulePath); h.controller.update();
    assert.equal(h.window.visible, true);
    const count = h.calls.length;
    for (let i = 0; i < 30; i++) {
      h.state.host.bounds = { x: i, y: i, width: 1000, height: 800 };
      h.advance(100); h.controller.update(); h.controller.observeNativeVisibility();
    }
    assert.equal(h.calls.length, count); assert.equal(h.timers.size, 0);
    assert.equal(h.controller.snapshot().remaps, 0);
  });
  test(name + ': a native hide while logical desired remains true is remapped after 40 ms', () => {
    const h = fixture(modulePath); h.controller.update(); h.window.visible = false;
    h.controller.update();
    assert.equal(h.controller.snapshot().desired, true); assert.equal(h.controller.snapshot().pending, true);
    h.advance(39); assert.equal(h.window.visible, false);
    h.advance(1); assert.equal(h.window.visible, true); assert.equal(h.controller.snapshot().remaps, 1);
  });
  test(name + ': explicit recovery coalesces requests while waiting for the native remap', () => {
    const h = fixture(modulePath); h.controller.update(); h.calls.length = 0;
    h.controller.requestRecovery(); h.advance(20);
    for (let i = 0; i < 10; i++) h.controller.requestRecovery();
    assert.equal(h.timers.size, 1); assert.equal(h.calls.filter(c => c.kind === 'hide').length, 1);
    h.advance(20); assert.equal(h.window.visible, true); assert.equal(h.controller.snapshot().remaps, 1);
  });
  test(name + ': host foreground lifecycle revision reasserts an unchanged logical visible state', () => {
    const h = fixture(modulePath); h.controller.update();
    h.state.host.visibilityRevision++; h.controller.update();
    assert.equal(h.window.visible, false); assert.equal(h.controller.snapshot().desired, true);
    h.advance(40); assert.equal(h.window.visible, true); assert.equal(h.controller.snapshot().remaps, 1);
  });
  test(name + ': a later lifecycle boundary cancels the old delayed show', () => {
    const h = fixture(modulePath); h.controller.update();
    h.state.host.visibilityRevision++; h.controller.update(); h.advance(20);
    h.state.host.visibilityRevision++; h.controller.update();
    h.advance(20); assert.equal(h.window.visible, false); assert.equal(h.controller.snapshot().remaps, 0);
    h.advance(20); assert.equal(h.window.visible, true); assert.equal(h.controller.snapshot().remaps, 1);
  });
  test(name + ': manual hide or an opened modal invalidates a pending show even without another heartbeat', () => {
    for (const guard of [state => { state.manuallyHidden = true; }, state => { state.host.modal = true; },
      state => { state.host.visible = false; }, state => { state.quitting = true; }, state => { state.ready = false; }]) {
      const h = fixture(modulePath); h.controller.update(); h.controller.requestRecovery(); h.advance(20);
      guard(h.state); h.advance(20);
      assert.equal(h.window.visible, false); assert.equal(h.controller.snapshot().desired, false);
      assert.equal(h.controller.snapshot().pending, false);
      assert.equal(h.calls.filter(c => c.kind === 'show').length, 1);
    }
  });
  test(name + ': minimize/modal close restores using the reference remap and preserves hide guards', () => {
    const h = fixture(modulePath); h.controller.update(); h.state.host.modal = true; h.controller.update();
    assert.equal(h.window.visible, false);
    h.state.host.modal = false; h.controller.update();
    assert.equal(h.window.visible, false); h.advance(40); assert.equal(h.window.visible, true);
  });
  test(name + ': changing the actual widget window cancels the old window timer', () => {
    const h = fixture(modulePath); h.controller.update(); h.controller.requestRecovery();
    const old = h.replaceWindow(); h.advance(40);
    assert.equal(old.visible, false); assert.equal(h.window.visible, true);
    assert.equal(h.calls.filter(c => c.kind === 'show' && c.window === old.id).length, 1);
  });
  test(name + ': renderer readiness resynchronizes final visible state and remaps a stale native surface', () => {
    const h = fixture(modulePath); h.controller.update(); h.calls.length = 0;
    h.controller.rendererReady();
    assert.deepEqual(h.calls[0], { kind: 'renderer', visible: true });
    assert.equal(h.window.visible, false); h.advance(40); assert.equal(h.window.visible, true);
    assert.deepEqual(h.calls.at(-1), { kind: 'renderer', visible: true });
    assert.equal(h.controller.snapshot().remaps, 1);
  });
  test(name + ': renderer readiness while intentionally hidden sends final hidden state and cannot expose the window', () => {
    const h = fixture(modulePath); h.controller.update(); h.state.manuallyHidden = true; h.controller.update();
    h.calls.length = 0; h.controller.rendererReady(); h.advance(100);
    assert.deepEqual(h.calls[0], { kind: 'renderer', visible: false });
    assert.equal(h.calls.some(c => c.kind === 'show'), false); assert.equal(h.window.visible, false);
  });
  test(name + ': watchdog waits for settled and persistent native evidence despite Electron cached visible=true', () => {
    const h = fixture(modulePath); h.controller.update(); h.state.host.widgetVisible = false;
    h.advance(1499); assert.equal(h.controller.observeNativeVisibility(), false);
    h.advance(1); assert.equal(h.controller.observeNativeVisibility(), false);
    h.advance(249); assert.equal(h.controller.observeNativeVisibility(), false);
    h.advance(1); assert.equal(h.controller.observeNativeVisibility(), true);
    assert.equal(h.window.visible, false); h.advance(40); assert.equal(h.window.visible, true);
    assert.equal(h.controller.snapshot().nativeAttempts, 1);
  });
  test(name + ': watchdog repairs the surface under its host but caps retries until positive evidence', () => {
    const h = fixture(modulePath); h.controller.update(); h.state.host.widgetAboveHost = false;
    for (let i = 1; i <= 3; i++) {
      h.advance(1500); h.controller.observeNativeVisibility(); h.advance(250);
      assert.equal(h.controller.observeNativeVisibility(), true);
      h.advance(40); assert.equal(h.controller.snapshot().nativeAttempts, i);
    }
    h.advance(1500); h.controller.observeNativeVisibility(); h.advance(250);
    assert.equal(h.controller.observeNativeVisibility(), false);
    assert.equal(h.controller.snapshot().remaps, 3);
    h.state.host.widgetAboveHost = true; h.controller.observeNativeVisibility();
    assert.equal(h.controller.snapshot().nativeAttempts, 0);
    h.state.host.widgetAboveHost = false; h.controller.observeNativeVisibility(); h.advance(250);
    assert.equal(h.controller.observeNativeVisibility(), true);
  });
  test(name + ': transient stale native samples and standalone mode do not start remaps', () => {
    const h = fixture(modulePath); h.controller.update(); h.advance(1500);
    h.state.host.widgetVisible = false; h.controller.observeNativeVisibility(); h.advance(200);
    h.state.host.widgetVisible = true; h.controller.observeNativeVisibility(); h.advance(500);
    assert.equal(h.controller.snapshot().pending, false); assert.equal(h.controller.snapshot().remaps, 0);
    h.state.standalone = true; h.controller.update(); h.advance(40);
    const remaps = h.controller.snapshot().remaps;
    h.state.host.widgetVisible = false; h.advance(2000); h.controller.observeNativeVisibility(); h.advance(300);
    assert.equal(h.controller.observeNativeVisibility(), false); assert.equal(h.controller.snapshot().remaps, remaps);
  });
  test(name + ': resolved desiredVisible state integrates with existing containment while retaining readiness/manual guards', () => {
    const h = fixture(modulePath, { desiredVisible: true }); h.state.host.attached = false;
    h.controller.update(); assert.equal(h.window.visible, true);
    h.state.desiredVisible = false; h.controller.update(); assert.equal(h.window.visible, false);
    h.state.desiredVisible = true; h.state.manuallyHidden = true; h.controller.update(); h.advance(100);
    assert.equal(h.window.visible, false);
  });
  test(name + ': a synchronous native show event does not start recursive remaps', () => {
    const h = fixture(modulePath); h.setSyncShow(() => h.controller.update());
    h.controller.update(); h.controller.requestRecovery(); h.advance(40);
    assert.equal(h.window.visible, true); assert.equal(h.controller.snapshot().remaps, 1); assert.equal(h.timers.size, 0);
  });
  test(name + ': a failed show is contained and can recover on the next observation', () => {
    const h = fixture(modulePath); h.window.failShow = true; h.controller.update();
    assert.equal(h.window.visible, false); assert.equal(h.controller.snapshot().lastFailure, 'show');
    h.window.failShow = false; h.controller.update(); h.advance(40);
    assert.equal(h.window.visible, true); assert.equal(h.controller.snapshot().lastFailure, null);
  });
  test(name + ': disposal invalidates pending timers and renderer/native requests', () => {
    const h = fixture(modulePath); h.controller.update(); h.controller.requestRecovery(); h.controller.dispose();
    const count = h.calls.length; h.controller.rendererReady(); h.controller.update(); h.controller.requestRecovery(); h.advance(100);
    assert.equal(h.calls.length, count); assert.equal(h.timers.size, 0); assert.equal(h.window.visible, false);
  });
}
