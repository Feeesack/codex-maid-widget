'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const root = path.join(__dirname, '..');
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function fixture(variant, options = {}) {
  const { WindowTopmostController } = require(path.join(variant, 'src/window-topmost.cjs'));
  const calls = [], providers = [], timers = new Map(); let nextTimer = 0, handle = Buffer.from([1, 0, 0, 0]), time = 0;
  const widget = new EventEmitter(); widget.isDestroyed = () => false;
  widget.getNativeWindowHandle = () => handle;
  widget.setAlwaysOnTop = value => calls.push({ kind: 'electron', value });
  const controller = new WindowTopmostController({ widget, platform: options.platform || 'win32',
    now: () => time, schedule(callback, delay) { timers.set(++nextTimer, { callback, delay }); return nextTimer; }, cancel: id => timers.delete(id),
    providerFactory() {
      const index = providers.length;
      const provider = { closed: 0, async setTopmost(value, enabled) {
        calls.push({ kind: 'native', handle: value.toString('hex'), enabled, index });
        return options.answer?.(enabled, index) ?? { known: true, ok: true, topmost: enabled };
      }, close() { this.closed++; } }; providers.push(provider); return provider;
    } });
  return { controller, calls, providers, widget, timers, changeHandle() { handle = Buffer.from([2, 0, 0, 0]); },
    async fireTimer() { const [id, timer] = timers.entries().next().value; timers.delete(id); time += timer.delay; timer.callback(); await flush(); } };
}
for (const variant of [root, path.join(root, 'macos')]) {
  test(path.basename(variant) + ': a newer contained transition drains stale native writes before attachment', async t => {
    const first = deferred(); let count = 0;
    const h = fixture(variant, { answer: enabled => ++count === 1 ? first.promise : { known: true, ok: true, topmost: enabled } }); t.after(() => h.controller.close());
    h.controller.configure({ alwaysOnTop: true }); await flush();
    const barrier = h.controller.configure({ contained: true });
    first.resolve({ known: true, ok: true, topmost: true }); await barrier;
    assert.deepEqual(h.calls.filter(c => c.kind === 'native').map(c => c.enabled), [true, false]);
    assert.deepEqual(h.controller.getState(), { desired: false, verified: true, reason: 'verified' });
    assert.equal(h.providers[0].closed, 1);
    const countBefore = h.calls.length; await h.controller.recover(); h.widget.emit('blur');
    assert.equal(h.calls.length, countBefore); assert.equal(h.timers.size, 0);
    await h.controller.configure({ contained: false, alwaysOnTop: false });
    assert.equal(h.calls.at(-1).enabled, false); assert.equal(h.controller.getState().verified, true);
  });
  test(path.basename(variant) + ': failed native readback remains visible as a failure and an explicit recovery retries', async t => {
    let success = false; const h = fixture(variant, { answer: enabled => ({ known: true, ok: success, topmost: success ? enabled : !enabled }) }); t.after(() => h.controller.close());
    await h.controller.configure({ alwaysOnTop: true });
    assert.deepEqual(h.controller.getState(), { desired: true, verified: false, reason: 'topmost-unavailable' });
    success = true; await h.controller.recover(); assert.equal(h.controller.getState().verified, true);
  });
  test(path.basename(variant) + ': a replacement HWND cannot inherit an old native acknowledgement', async t => {
    const first = deferred(); const h = fixture(variant, { answer: (_enabled, index) => index === 0 ? first.promise : { known: true, ok: true, topmost: true } }); t.after(() => h.controller.close());
    const task = h.controller.configure({ alwaysOnTop: true }); await flush(); h.changeHandle();
    first.resolve({ known: true, ok: true, topmost: true }); await task;
    assert.equal(h.providers.length, 2); assert.equal(h.providers[0].closed, 1);
    assert.deepEqual(h.calls.filter(c => c.kind === 'native').map(c => c.handle), ['01000000', '02000000']);
  });
  test(path.basename(variant) + ': close invalidates an in-flight response and removes event/timer ownership', async () => {
    const first = deferred(), h = fixture(variant, { answer: () => first.promise });
    const pending = h.controller.configure(); await flush(); h.widget.emit('blur');
    assert.equal(h.timers.size, 1); h.controller.close(); first.resolve({ known: true, ok: true, topmost: true }); await pending;
    assert.equal(h.controller.getState().verified, false); assert.equal(h.providers[0].closed, 1);
    assert.equal(h.widget.listenerCount('blur'), 0); assert.equal(h.timers.size, 0);
  });
  test(path.basename(variant) + ': blur storms coalesce and rate limit without any activation or polling', async t => {
    const h = fixture(variant); t.after(() => h.controller.close()); await h.controller.configure();
    for (let i = 0; i < 30; i++) h.widget.emit('blur'); assert.equal(h.timers.size, 1);
    await h.fireTimer(); assert.equal(h.calls.filter(c => c.kind === 'native').length, 2);
    h.widget.emit('blur'); assert.ok([...h.timers.values()][0].delay >= 750);
    await h.controller.configure({ contained: true }); assert.equal(h.timers.size, 0);
  });
  test(path.basename(variant) + ': macOS applies Electron preferences without starting a Windows worker', async t => {
    const h = fixture(variant, { platform: 'darwin' }); t.after(() => h.controller.close());
    await h.controller.configure({ alwaysOnTop: false }); await h.controller.recover();
    assert.equal(h.providers.length, 0); assert.deepEqual(h.calls.map(c => c.value), [false, false]);
  });
}
