'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const root = path.join(__dirname, '..');
const variants = [{ name: 'Windows', platform: 'win32', root }, { name: 'macOS', platform: 'darwin', root: path.join(root, 'macos') }];
const size = { width: 228, height: 288 }, hostBounds = { x: 100, y: 80, width: 1000, height: 800 };
const plain = value => JSON.parse(JSON.stringify(value));
const ok = () => ({ known: true, supported: true, ok: true });
function snapshot(overrides = {}) {
  return { known: true, supported: true, coordinateSpace: 'dip', foregroundWindow: '123', foregroundRoot: '123', foregroundPid: 400,
    windows: [{ id: '123', pid: 400, bounds: { ...hostBounds }, visible: true, minimized: false, cloaked: false,
      foreground: true, widgetParented: true, widgetAboveHost: true, dpi: 144 }], ...overrides };
}
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function flush() { for (let i = 0; i < 40; i++) await Promise.resolve(); }

// Only adapter/controller source runs in the VM. Provider, renderer, native
// window, Date and timers are fixtures: no host profile or real HWND is read.
function harness(variant, options = {}) {
  const calls = [], conversions = [], timers = new Map(), providers = [];
  let time = 0, nextId = 1, statusChanges = 0, visible = false, top = true, recreations = 0;
  let bounds = { x: -700, y: 300, ...size }, raw = snapshot(), rendererPresence = null;
  const schedule = (callback, delay) => { const id = nextId++; timers.set(id, { callback, at: time + Math.max(0, delay) }); return id; };
  const cancel = id => timers.delete(id), FakeDate = class extends Date { static now() { return time; } };
  const webContents = new EventEmitter();
  webContents.send = (channel, value) => { calls.push({ kind: channel, ...plain(value) }); if (channel === 'presence') rendererPresence = value.visible; };
  const widget = { webContents, isDestroyed: () => false,
    getBounds: () => ({ ...bounds }), getNativeWindowHandle: () => Buffer.alloc(8, 1),
    setBounds(value) { bounds = { ...value }; calls.push({ kind: 'bounds', ...value }); },
    setAlwaysOnTop(value) { top = value; calls.push({ kind: 'top', value }); },
    showInactive() { visible = true; calls.push({ kind: 'showInactive' }); },
    show() { visible = true; calls.push({ kind: 'show' }); }, moveTop() { calls.push({ kind: 'moveTop' }); },
    hide() { visible = false; calls.push({ kind: 'hide' }); }, isVisible: () => visible,
    moveAbove(id) { calls.push({ kind: 'moveAbove', id }); options.stack?.(id, calls.filter(call => call.kind === 'moveAbove').length); },
  };
  const factory = () => {
    const index = providers.length, answers = [...(options.answers?.[index] || [])];
    const provider = { queries: 0, closes: 0, attaches: 0, positions: 0, detaches: 0,
      query() { this.queries++; return answers.length ? answers.shift() : Promise.resolve(raw); },
      close() { this.closes++; calls.push({ kind: 'provider-close', index }); },
    };
    if (options.child) Object.assign(provider, {
      attachChild(handle, id) {
        this.attaches++; calls.push({ kind: 'attach', id, index });
        return Promise.resolve(options.attach?.(id, this.attaches, index) ?? ok()).then(value => { calls.push({ kind: 'attach-ack', id, ok: value.ok, index }); return value; });
      },
      positionChild(handle, id, value) {
        this.positions++; calls.push({ kind: 'position', id, bounds: { ...value }, index });
        return Promise.resolve(options.position?.(id, value, this.positions, index) ?? ok()).then(answer => { calls.push({ kind: 'position-ack', id, ok: answer.ok, index }); return answer; });
      },
      detachChild() {
        this.detaches++; calls.push({ kind: 'detach', index });
        return Promise.resolve(options.detach?.(this.detaches, index) ?? ok()).then(value => { calls.push({ kind: 'detach-ack', ok: value.ok, index }); return value; });
      },
    });
    providers.push(provider); return provider;
  };
  const pure = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(variant.root, 'src/window-visibility.cjs'), 'utf8'), {
    module: pure, Date: FakeDate, setTimeout: schedule, clearTimeout: cancel,
  }, { filename: 'isolated-window-visibility.cjs' });
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(variant.root, 'src/window-mode.cjs'), 'utf8'), {
    module, process: { platform: variant.platform, pid: 88 }, Date: FakeDate, setTimeout: schedule, clearTimeout: cancel,
    require(name) {
      if (name === './window-containment.cjs') return require(path.join(variant.root, 'src/window-containment.cjs'));
      if (name === './window-visibility.cjs') return pure.exports;
      if (name === './codex-window.cjs') return { CodexWindowProvider: class { constructor() { throw new Error('Native provider must remain injected'); } }, nativeHandleId: value => String(value) };
      throw new Error('Unexpected adapter dependency: ' + name);
    },
  }, { filename: 'isolated-window-mode.cjs' });
  const mode = new module.exports.CodexWindowMode({ widget, platform: variant.platform,
    screen: {
      screenToDipRect(window, value) {
        conversions.push({ window, value: { ...value } }); if (options.convert) return options.convert(value);
        return { x: value.x / 1.5, y: value.y / 1.5, width: value.width / 1.5, height: value.height / 1.5 };
      },
      dipToScreenRect(_window, value) { return { x: value.x * 1.5, y: value.y * 1.5, width: value.width * 1.5, height: value.height * 1.5 }; },
    }, getSize: () => ({ ...size }), providerFactory: factory, intervalMs: 100, staleAfterMs: 50,
    onStatus() { statusChanges++; }, onRecreate() { recreations++; },
  });
  if (options.rendererReady !== false) { webContents.emit('did-finish-load'); calls.length = 0; }
  return { mode, widget, calls, conversions, timers, providers, normalizedSnapshot: module.exports.normalizedSnapshot,
    setSnapshot: value => { raw = value; }, emitLoaded() { rendererPresence = null; webContents.emit('did-finish-load'); },
    get bounds() { return { ...bounds }; }, get visible() { return visible; }, get top() { return top; },
    get statusChanges() { return statusChanges; }, get recreations() { return recreations; }, get rendererPresence() { return rendererPresence; },
    async advance(milliseconds) {
      const target = time + milliseconds;
      for (let steps = 0; steps < 1000; steps++) {
        const next = [...timers.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) { time = target; await flush(); return; }
        time = next[1].at; timers.delete(next[0]); next[1].callback(); await flush();
      }
      throw new Error('Timer loop did not settle');
    },
    async poll(value) { raw = value; await this.advance(100); },
  };
}
async function start(t, variant, options = {}) { const h = harness(variant, options); t.after(() => h.mode.close()); h.mode.configure(true); await flush(); return h; }

for (const variant of variants) {
  test(variant.name + ': default-off starts no provider, query, timer or native effect', () => {
    const h = harness(variant); h.mode.configure(false, { position: { x: -700, y: 300 }, alwaysOnTop: true }); h.mode.refreshSize();
    assert.equal(h.mode.moveTo(100, 100), false); assert.equal(h.providers.length, 0); assert.equal(h.timers.size, 0); assert.deepEqual(h.calls, []); h.mode.close();
  });
  test(variant.name + ': independent fallback waits for query and stacks without activation', async t => {
    const pending = deferred(), h = await start(t, variant, { answers: [[pending.promise]] });
    assert.equal(h.visible, false); assert.equal(h.top, false); pending.resolve(snapshot()); await flush();
    assert.equal(h.visible, true); assert.equal(h.mode.getState().reason, 'contained');
    assert.ok(h.calls.some(c => c.kind === 'showInactive')); assert.ok(h.calls.some(c => c.kind === 'moveAbove' && c.id === 'window:123:0'));
    assert.equal(h.calls.some(c => c.kind === 'show' || c.kind === 'moveTop'), false);
    assert.deepEqual(plain(h.mode.getArea()), { x: 102, y: 82, width: 996, height: 796 });
  });
  test(variant.name + ': physical rectangles convert before inset and preserve fixed preferred dimensions', async t => {
    const value = snapshot({ coordinateSpace: 'physical-pixels', windows: [{ ...snapshot().windows[0], bounds: { x: -1500, y: 150, width: 1500, height: 1200 } }] });
    const h = await start(t, variant, { answers: [[Promise.resolve(value)]] }); assert.deepEqual(h.conversions, [{ window: null, value: value.windows[0].bounds }]);
    assert.deepEqual(plain(h.mode.getArea()), { x: -998, y: 102, width: 996, height: 796 }); assert.equal(h.bounds.width, 228); assert.equal(h.bounds.height, 288);
  });
  test(variant.name + ': dialogs/tool windows cannot replace main host and hidden zero-size helpers are unavailable', () => {
    const h = harness(variant), main = { ...snapshot().windows[0], foreground: false };
    for (const marker of [{ windowClass: '#32770' }, { toolWindow: true }, { ownerId: '123' }, { mainWindow: false }]) {
      const popup = { ...main, ...marker, id: '456', foreground: true, bounds: { x: 300, y: 200, width: 500, height: 350 } };
      const value = h.normalizedSnapshot(snapshot({ windows: [popup, main], foregroundWindow: '456', foregroundRoot: '456' }), { previousHost: '123' });
      assert.equal(value.host.id, '123'); assert.deepEqual(plain(value.host.clientBounds), { x: 102, y: 82, width: 996, height: 796 });
    }
    assert.equal(h.normalizedSnapshot(snapshot({ windows: [{ ...main, visible: false, bounds: { x: 0, y: 0, width: 0, height: 0 } }], foregroundWindow: '999', foregroundRoot: '999' })).host, null); h.mode.close();
  });
  test(variant.name + ': CG nested panels retain outer main; exact foreground main wins over root-owner', () => {
    const h = harness(variant), main = { ...snapshot().windows[0], foreground: false }, popup = { ...main, id: '456', foreground: true, bounds: { x: 300, y: 200, width: 500, height: 350 } };
    const raw = snapshot({ windows: [popup, main], foregroundWindow: '456', foregroundWindowIsGuess: true });
    for (const previousHost of [undefined, '123']) assert.equal(h.normalizedSnapshot(raw, { previousHost }).host.id, '123');
    assert.equal(h.normalizedSnapshot(snapshot({ windows: [main, popup], foregroundWindow: '456', foregroundRoot: '123' }), { previousHost: '123' }).host.id, '456');
    const own = h.normalizedSnapshot(snapshot({ windows: [main, { ...popup, foreground: false }], foregroundWindow: '999', foregroundRoot: '999', foregroundPid: 88 }), { previousHost: '456', widgetPid: 88 });
    assert.equal(own.host.id, '456'); assert.equal(own.foreground, 'widget'); h.mode.close();
  });
  test(variant.name + ': healthy unchanged observations do not remap or restack', async t => {
    const h = await start(t, variant), counts = { calls: h.calls.length, status: h.statusChanges }; await h.advance(1000);
    assert.equal(h.providers[0].queries, 11); assert.equal(h.calls.length, counts.calls); assert.equal(h.statusChanges, counts.status);
  });
  test(variant.name + ': manual hide survives observations; explicit 40-ms show is cancellable', async t => {
    const h = await start(t, variant); h.mode.hide(); assert.equal(h.visible, false); await h.advance(500); assert.equal(h.visible, false);
    h.mode.show(); await h.advance(39); assert.equal(h.visible, false); await h.advance(1); assert.equal(h.visible, true);
    h.mode.show(); h.mode.hide(); await h.advance(100); assert.equal(h.visible, false);
  });
  test(variant.name + ': renderer readiness/reload synchronizes final presence without fake CSS motion', async t => {
    const h = await start(t, variant, { rendererReady: false }); assert.equal(h.visible, false);
    h.emitLoaded(); await h.advance(40); assert.equal(h.visible, true); assert.equal(h.rendererPresence, true);
    h.emitLoaded(); assert.equal(h.rendererPresence, true); await h.advance(40); assert.equal(h.visible, true);
    h.mode.hide(); h.emitLoaded(); await h.advance(100); assert.equal(h.rendererPresence, false); assert.equal(h.visible, false);
    assert.equal(h.calls.some(c => c.kind === 'presence' && c.animate !== false), false);
  });
  test(variant.name + ': independent minimize/modal/foreign foreground hide immediately and later recover', async t => {
    for (const value of [snapshot({ windows: [{ ...snapshot().windows[0], minimized: true }] }), snapshot({ windows: [{ ...snapshot().windows[0], modal: true }] }),
      snapshot({ foregroundWindow: '999', foregroundRoot: '999', foregroundPid: 999, windows: [{ ...snapshot().windows[0], foreground: false }] })]) {
      const h = await start(t, variant); await h.poll(value); assert.equal(h.visible, false);
      assert.equal(h.calls.some(c => c.kind === 'presence' && c.animate !== false), false); await h.poll(snapshot()); await h.advance(40); assert.equal(h.visible, true); h.mode.close();
    }
  });
  test(variant.name + ': disabling drops pending observations and restores standalone position/top', async t => {
    const pending = deferred(), h = harness(variant, { answers: [[pending.promise]] }); t.after(() => h.mode.close());
    h.mode.configure(true, { position: { x: -900, y: 450 }, alwaysOnTop: true }); h.mode.configure(false, { alwaysOnTop: true });
    assert.equal(h.providers[0].closes, 1); assert.equal(h.timers.size, 0); assert.deepEqual(h.bounds, { x: -900, y: 450, ...size }); assert.equal(h.visible, true); assert.equal(h.top, true);
    const count = h.calls.length; pending.resolve(snapshot()); await flush(); assert.equal(h.calls.length, count); assert.equal(h.timers.size, 0);
  });
  test(variant.name + ': stale query from previous enable cannot replace the new host', async t => {
    const old = deferred(), current = deferred(), h = harness(variant, { answers: [[old.promise], [current.promise]] }); t.after(() => h.mode.close());
    h.mode.configure(true); h.mode.configure(false); h.mode.configure(true);
    current.resolve(snapshot({ windows: [{ ...snapshot().windows[0], id: '456' }], foregroundWindow: '456', foregroundRoot: '456' })); await flush(); await h.advance(40); assert.equal(h.visible, true);
    const area = plain(h.mode.getArea()), count = h.calls.length; old.resolve(snapshot()); await flush(); assert.deepEqual(plain(h.mode.getArea()), area); assert.equal(h.calls.length, count); assert.equal(h.providers[1].closes, 0);
  });
  test(variant.name + ': normal-mode hide/show preserves subsequent ordinary desktop drag', async t => {
    const h = await start(t, variant); h.mode.configure(false); h.widget.setBounds({ x: -1300, y: -100, ...size }); h.mode.hide(); h.mode.show(); h.mode.refreshSize();
    assert.deepEqual(h.bounds, { x: -1300, y: -100, ...size }); assert.equal(h.visible, true);
  });
  test(variant.name + ': stalled query hides safely; fresh data recovers after remap', async t => {
    const blocked = deferred(), h = await start(t, variant, { answers: [[Promise.resolve(snapshot()), blocked.promise]] });
    await h.advance(100); assert.equal(h.visible, true); await h.advance(49); assert.equal(h.visible, true); await h.advance(1); assert.equal(h.visible, false); assert.equal(h.mode.getState().reason, 'unknown');
    blocked.resolve(snapshot()); await flush(); await h.advance(40); assert.equal(h.visible, true);
  });
  test(variant.name + ': rejected query or conversion fails closed and can subsequently recover', async t => {
    const rejected = deferred(), h = await start(t, variant, { answers: [[rejected.promise]] }); rejected.reject(new Error('fixture query failure')); await flush();
    assert.equal(h.visible, false); assert.equal(h.mode.getState().reason, 'unknown'); await h.advance(140); assert.equal(h.visible, true);
    assert.equal(h.normalizedSnapshot(snapshot({ coordinateSpace: 'physical-pixels' }), { screen: { screenToDipRect() { throw new Error('removed display'); } } }).known, false);
  });
  test(variant.name + ': failed native stacking cannot be reported visible and can retry', async t => {
    const h = await start(t, variant, { stack(_id, count) { if (count === 2) throw new Error('fixture stack failure'); } });
    assert.equal(h.visible, false); assert.equal(h.mode.getState().visible, false); await h.advance(140); assert.equal(h.visible, true); assert.equal(h.mode.getState().visible, true);
  });
  test(variant.name + ': close clears timers and ignores late query results', async () => {
    const pending = deferred(), h = harness(variant, { answers: [[pending.promise]] }); h.mode.configure(true); h.mode.close(); assert.equal(h.providers[0].closes, 1); assert.equal(h.timers.size, 0);
    const count = h.calls.length; pending.resolve(snapshot()); await flush(); await h.advance(1000); assert.equal(h.calls.length, count); assert.equal(h.timers.size, 0); h.mode.configure(true); assert.equal(h.providers.length, 1);
  });
}

const windows = variants[0];
test('Windows child: first position ACK is required before native show', async t => {
  const attached = deferred(), positioned = deferred(), h = await start(t, windows, { child: true, attach: () => attached.promise, position: (_id, _bounds, n) => n === 1 ? positioned.promise : ok() });
  assert.equal(h.mode.getState().embedded, true); assert.equal(h.visible, false); assert.equal(h.providers[0].positions, 0);
  attached.resolve(ok()); await flush(); assert.equal(h.providers[0].positions, 1); assert.equal(h.visible, false); assert.equal(h.mode.getState().visible, false);
  positioned.resolve(ok()); await flush(); await h.advance(40); assert.equal(h.visible, true); assert.equal(h.mode.getState().visible, true);
  assert.ok(h.calls.findIndex(c => c.kind === 'position-ack') < h.calls.findIndex(c => c.kind === 'showInactive'));
  const bounds = h.calls.find(c => c.kind === 'position').bounds; assert.deepEqual({ width: bounds.width, height: bounds.height }, { width: 342, height: 432 });
  assert.equal(h.calls.some(c => c.kind === 'moveAbove' || c.kind === 'bounds'), false);
});
test('Windows child: minimize retains visibility style and previous geometry for parent OS animation', async t => {
  const h = await start(t, windows, { child: true }), before = plain(h.mode.getBounds()); h.calls.length = 0;
  await h.poll(snapshot({ windows: [{ ...snapshot().windows[0], minimized: true, bounds: { x: -32000, y: -32000, width: 1000, height: 800 } }] }));
  assert.equal(h.visible, true); assert.equal(h.mode.getState().visible, false); assert.equal(h.mode.getState().reason, 'host-hidden'); assert.deepEqual(plain(h.mode.getBounds()), before);
  assert.equal(h.calls.some(c => ['hide', 'position', 'bounds'].includes(c.kind)), false); await h.poll(snapshot()); assert.equal(h.visible, true); assert.deepEqual(plain(h.mode.getBounds()), before);
  assert.equal(h.calls.some(c => c.kind === 'presence' && c.animate !== false), false);
});
test('Windows child: modal or foreign foreground never explicitly hides or detaches embedded surface', async t => {
  const h = await start(t, windows, { child: true }); h.calls.length = 0;
  await h.poll(snapshot({ windows: [{ ...snapshot().windows[0], modal: true }] }));
  await h.poll(snapshot({ foregroundWindow: '999', foregroundRoot: '999', foregroundPid: 999, windows: [{ ...snapshot().windows[0], foreground: false }] }));
  assert.equal(h.visible, true); assert.equal(h.mode.getState().reason, 'contained'); assert.equal(h.calls.some(c => ['hide', 'detach', 'moveAbove'].includes(c.kind)), false); assert.equal(h.providers[0].attaches, 1);
});
test('Windows child: manual hide survives renderer reload, then explicit show uses cancellable remap', async t => {
  const h = await start(t, windows, { child: true }); h.mode.hide(); assert.equal(h.visible, false); h.emitLoaded(); await h.advance(500); assert.equal(h.visible, false); assert.equal(h.rendererPresence, false);
  h.mode.show(); await h.advance(39); assert.equal(h.visible, false); await h.advance(1); assert.equal(h.visible, true); h.emitLoaded(); assert.equal(h.rendererPresence, true); await h.advance(40); assert.equal(h.visible, true);
});
test('Windows child: standalone restoration and provider close wait for serialized native detach ACK', async t => {
  const detached = deferred(), h = await start(t, windows, { child: true, detach: () => detached.promise }); h.calls.length = 0;
  h.mode.configure(false, { alwaysOnTop: true }); await flush(); assert.equal(h.visible, false); assert.equal(h.providers[0].closes, 0); assert.equal(h.providers[0].detaches, 1); assert.equal(h.calls.some(c => c.kind === 'bounds'), false);
  detached.resolve(ok()); await flush(); assert.equal(h.mode.getState().embedded, false); assert.equal(h.visible, true); assert.equal(h.top, true); assert.deepEqual(h.bounds, { x: -700, y: 300, ...size }); assert.equal(h.providers[0].closes, 1);
  assert.ok(h.calls.findIndex(c => c.kind === 'detach-ack') < h.calls.findIndex(c => c.kind === 'bounds'));
});
test('Windows child: quick disable/re-enable ignores the old detach completion while the new query waits', async t => {
  const detached = deferred(), nextQuery = deferred();
  const h = await start(t, windows, { child: true, detach: () => detached.promise,
    answers: [[Promise.resolve(snapshot())], [nextQuery.promise]] });
  h.mode.configure(false); await flush();
  assert.equal(h.providers[0].detaches, 1);
  h.mode.configure(true); await flush();
  assert.equal(h.providers.length, 2); assert.equal(h.mode.getState().embedded, true);
  h.calls.length = 0; detached.resolve(ok()); await flush();
  assert.equal(h.mode.enabled, true); assert.equal(h.mode.getState().embedded, true);
  assert.equal(h.mode.geometryReady, false); assert.equal(h.visible, false);
  assert.equal(h.providers[0].closes, 1); assert.equal(h.providers[1].closes, 0);
  assert.equal(h.calls.some(c => ['moveAbove', 'bounds', 'show', 'showInactive'].includes(c.kind)), false);
  nextQuery.resolve(snapshot()); await flush(); await h.advance(40);
  assert.equal(h.providers[1].attaches, 1); assert.ok(h.providers[1].positions > 0);
  assert.equal(h.mode.getState().embedded, true); assert.equal(h.visible, true);
  assert.equal(h.calls.some(c => c.kind === 'moveAbove'), false);
});
test('Windows child: switching main hosts waits for new attach ACK before position/show', async t => {
  const second = deferred(), h = await start(t, windows, { child: true, attach: id => id === '456' ? second.promise : ok() }); h.calls.length = 0;
  await h.poll(snapshot({ foregroundWindow: '456', foregroundRoot: '456', windows: [{ ...snapshot().windows[0], id: '456', bounds: { ...hostBounds, x: 1400 } }] }));
  assert.equal(h.visible, false); assert.equal(h.calls.some(c => c.kind === 'position'), false); second.resolve(ok()); await flush(); await h.advance(40); assert.equal(h.visible, true); assert.ok(h.mode.getBounds().x >= 1402);
  assert.equal(h.calls.filter(c => c.kind === 'position').every(c => c.id === '456'), true);
});
test('Windows child: wrong native z-order reasserts child position without unrelated movement or CSS', async t => {
  const h = await start(t, windows, { child: true }), before = plain(h.mode.getBounds()); h.calls.length = 0;
  await h.poll(snapshot({ windows: [{ ...snapshot().windows[0], widgetAboveHost: false }] }));
  assert.ok(h.calls.some(c => c.kind === 'position' && c.id === '123')); assert.deepEqual(plain(h.mode.getBounds()), before); assert.equal(h.visible, true); assert.equal(h.calls.some(c => ['hide', 'bounds', 'moveAbove'].includes(c.kind)), false);
});
test('Windows child: unknown observation or destroyed parent hides safely then fresh metadata recovers', async t => {
  for (const raw of [{ known: false }, snapshot({ windows: [] })]) { const h = await start(t, windows, { child: true }); await h.poll(raw); assert.equal(h.visible, false); await h.poll(snapshot()); await h.advance(40); assert.equal(h.visible, true); h.mode.close(); }
});
test('Windows child: unrecoverable native style invokes onRecreate once and never exposes stale HWND', async t => {
  const failure = { known: false, ok: false, reason: 'child-style-unavailable' };
  for (const options of [{ attach: () => failure }, { position: () => failure }]) { const h = await start(t, windows, { child: true, ...options }); await h.advance(500); assert.equal(h.recreations, 1); assert.equal(h.visible, false); assert.equal(h.mode.getState().visible, false); h.mode.close(); }
});
test('Windows child: a late first-position ACK cannot resurrect a manually hidden surface', async t => {
  const positioned = deferred(), h = await start(t, windows, { child: true, position: () => positioned.promise });
  assert.equal(h.visible, false); h.mode.hide(); positioned.resolve(ok()); await flush(); await h.advance(140);
  assert.equal(h.visible, false); assert.equal(h.rendererPresence, false); assert.equal(h.calls.some(c => c.kind === 'showInactive'), false);
});
test('Windows child: disabling during attach serializes detach before restoring standalone styles', async t => {
  const attached = deferred(), detached = deferred(), h = await start(t, windows, { child: true, attach: () => attached.promise, detach: () => detached.promise });
  h.mode.configure(false); await flush(); assert.equal(h.providers[0].detaches, 0); assert.equal(h.providers[0].closes, 0); assert.equal(h.visible, false);
  attached.resolve(ok()); await flush(); assert.equal(h.providers[0].detaches, 1); assert.equal(h.visible, false); assert.equal(h.providers[0].positions, 0);
  detached.resolve(ok()); await flush(); assert.equal(h.visible, true); assert.equal(h.providers[0].closes, 1); assert.deepEqual(h.bounds, { x: -700, y: 300, ...size });
});
test('Windows child: closing during attach still detaches the late native child before closing provider', async () => {
  const attached = deferred(), detached = deferred(), h = harness(windows, { child: true, attach: () => attached.promise, detach: () => detached.promise });
  h.mode.configure(true); await flush(); h.mode.close(); assert.equal(h.providers[0].detaches, 0); assert.equal(h.providers[0].closes, 0);
  attached.resolve(ok()); await flush(); assert.equal(h.providers[0].detaches, 1); assert.equal(h.providers[0].closes, 0);
  detached.resolve(ok()); await flush(); await h.advance(1000); assert.equal(h.providers[0].closes, 1); assert.equal(h.visible, false); assert.equal(h.calls.some(c => c.kind === 'showInactive'), false);
});
