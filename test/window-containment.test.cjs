'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { innerRectangle, containBounds, relativeAnchor, anchoredBounds, WindowContainmentController } = require('../src/window-containment.cjs');

// These tests have no native-window, filesystem, settings, environment, or
// data-home dependency. Every effect is injected; no user data can be accessed.
const preferred = { width: 228, height: 288 };
const client = { x: 100, y: 80, width: 1000, height: 800 };
function sample(overrides = {}) {
  return { known: true, supported: true, foreground: 'host',
    host: { id: '123', clientBounds: { ...client }, visible: true, minimized: false, onCurrentDesktop: true }, ...overrides };
}
function harness(options = {}) {
  let bounds = { x: 700, y: 500, ...preferred, ...options.bounds };
  let size = { ...preferred }, visible = options.visible !== false, top = true;
  const calls = [];
  const controller = new WindowContainmentController({
    getBounds: () => ({ ...bounds }), getSize: () => ({ ...size }),
    setBounds(value) { calls.push({ kind: 'bounds', ...value }); bounds = { ...value, width: value.width + (options.nativeError || 0), height: value.height + (options.nativeError || 0) }; },
    show() { visible = true; calls.push({ kind: 'show' }); return options.show?.(); },
    hide() { visible = false; calls.push({ kind: 'hide' }); return options.hide?.(); },
    setAlwaysOnTop(value) { top = value; calls.push({ kind: 'top', value }); },
    ...(options.onHostChanged ? { onHostChanged: host => { calls.push({ kind: 'owner', id: host?.id || null }); return options.onHostChanged(host); } } : {}),
  });
  return { controller, calls,
    get bounds() { return { ...bounds }; }, get visible() { return visible; }, get top() { return top; },
    resize(value) { size = { ...value }; controller.refreshSize(); },
    moveStandalone(x, y) { bounds = { ...bounds, x, y }; },
  };
}
function assertInside(bounds, area = client) {
  assert.ok(bounds.x >= area.x && bounds.y >= area.y);
  assert.ok(bounds.x + bounds.width <= area.x + area.width);
  assert.ok(bounds.y + bounds.height <= area.y + area.height);
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const settle = () => new Promise(resolve => setImmediate(resolve));
test('a modal disables presence without switching the host or overwriting its anchor', () => {
  const h = harness(); h.controller.setEnabled(true); h.controller.update(sample());
  h.controller.moveTo(850, 550); const before = h.controller.getState().anchor, bounds = h.bounds;
  h.controller.update(sample({ host: { ...sample().host, modal: true } }));
  assert.equal(h.visible, false); assert.equal(h.controller.getState().reason, 'host-modal');
  assert.deepEqual(h.controller.getState().anchor, before); assert.deepEqual(h.bounds, bounds);
  h.controller.update(sample()); assert.equal(h.visible, true); assert.deepEqual(h.bounds, bounds);
});

test('client geometry rounds fractional and negative edges inward', () => {
  assert.deepEqual(innerRectangle({ x: -100.7, y: 20.2, width: 900.2, height: 700.1 }), { x: -100, y: 21, width: 899, height: 699 });
  assert.deepEqual(containBounds({ x: -9999, y: 9999 }, { x: -100.7, y: 20.2, width: 900.2, height: 700.1 }, preferred), { x: -100, y: 432, ...preferred });
});
test('invalid, empty, and too-small rectangles never produce a widget rectangle', () => {
  for (const area of [null, {}, { ...client, x: NaN }, { ...client, width: Infinity }, { ...client, height: -1 }, { ...client, width: 227 }, { ...client, height: 287 }]) {
    assert.equal(containBounds({ x: 0, y: 0 }, area, preferred), null);
    assert.equal(anchoredBounds({ x: 1, y: 1 }, area, preferred), null);
  }
  assert.equal(containBounds({ x: NaN, y: 10 }, client, preferred), null);
  assert.equal(containBounds({ x: 1, y: 10 }, client, { width: 0, height: 5 }), null);
});
test('normalized anchors follow moves/resizes and preserve edge affinity', () => {
  const start = { x: client.x + client.width - preferred.width, y: client.y + client.height - preferred.height };
  const anchor = relativeAnchor(start, client, preferred);
  assert.deepEqual(anchor, { x: 1, y: 1 });
  const next = { x: -1400, y: -100, width: 1300, height: 1000 };
  assert.deepEqual(anchoredBounds(anchor, next, preferred), { x: -328, y: 612, ...preferred });
  assert.deepEqual(anchoredBounds({ x: -3, y: 4 }, client, preferred), { x: client.x, y: 592, ...preferred });
});
test('an exact-size host is allowed and does not divide by zero', () => {
  const area = { x: -40, y: 30, ...preferred };
  const anchor = relativeAnchor({ x: 700, y: 800 }, area, preferred, { x: 1, y: 0 });
  assert.deepEqual(anchor, { x: 1, y: 0 });
  assert.deepEqual(anchoredBounds(anchor, area, preferred), area);
});
test('controller starts disabled without changing standalone visibility or position', () => {
  const h = harness();
  assert.equal(h.controller.getState().enabled, false);
  assert.equal(h.controller.moveTo(1, 2), false);
  h.controller.update(sample());
  assert.deepEqual(h.calls, []);
});
test('enabling hides immediately and awaits a fresh host observation before showing', () => {
  const h = harness();
  h.controller.setEnabled(true, { alwaysOnTop: true });
  assert.equal(h.visible, false); assert.equal(h.top, false);
  assert.equal(h.controller.getState().reason, 'unknown');
  h.controller.update(sample());
  assert.equal(h.visible, true); assert.equal(h.top, false);
  assert.equal(h.controller.getState().reason, 'contained');
  assertInside(h.bounds);
});
test('drag clamps the complete widget and remains handled while host is missing', () => {
  const h = harness(); h.controller.setEnabled(true);
  assert.equal(h.controller.moveTo(-999, 999), true);
  assert.equal(h.calls.filter(call => call.kind === 'bounds').length, 0);
  h.controller.update(sample());
  assert.equal(h.controller.moveTo(-999, 999), true);
  assert.deepEqual(h.bounds, { x: 100, y: 592, ...preferred });
  assert.deepEqual(h.controller.getState().anchor, { x: 0, y: 1 });
});
test('host movement and resize use the drag anchor without writing settings', () => {
  const h = harness(); h.controller.setEnabled(true); h.controller.update(sample());
  h.controller.moveTo(872, 592);
  const area = { x: -1300, y: -200, width: 1200, height: 900 };
  h.controller.update(sample({ host: { ...sample().host, clientBounds: area } }));
  assert.deepEqual(h.bounds, { x: -328, y: 412, ...preferred });
  assertInside(h.bounds, area);
});
test('too-small hosts hide instead of scaling and restore the anchor when enlarged', () => {
  const h = harness(); h.controller.setEnabled(true); h.controller.update(sample()); h.controller.moveTo(872, 592);
  h.controller.update(sample({ host: { ...sample().host, clientBounds: { ...client, width: 200 } } }));
  assert.equal(h.visible, false); assert.equal(h.controller.getState().reason, 'host-too-small');
  h.controller.update(sample());
  assert.equal(h.visible, true); assert.deepEqual(h.bounds, { x: 872, y: 592, ...preferred });
});
test('unknown, unavailable, minimized, hidden and other-desktop hosts fail closed', () => {
  const h = harness(); h.controller.setEnabled(true);
  const snapshots = [
    { known: false }, { known: true, host: null },
    sample({ host: { ...sample().host, visible: false } }),
    sample({ host: { ...sample().host, minimized: true } }),
    sample({ host: { ...sample().host, onCurrentDesktop: false } }),
    sample({ host: { ...sample().host, cloaked: true } }),
    sample({ host: { ...sample().host, clientBounds: { ...client, width: NaN } } }),
  ];
  for (const value of snapshots) {
    h.controller.update(sample()); assert.equal(h.visible, true);
    h.controller.update(value); assert.equal(h.visible, false);
  }
});
test('untrusted foreground hides; widget and settings foreground retain control', () => {
  const h = harness(); h.controller.setEnabled(true);
  for (const foreground of ['host', 'widget', 'settings']) {
    h.controller.update(sample({ foreground })); assert.equal(h.visible, true);
  }
  for (const foreground of ['other', 'unknown', undefined]) {
    h.controller.update(sample({ foreground })); assert.equal(h.visible, false);
    assert.equal(h.controller.getState().reason, 'other-foreground');
  }
});
test('manual hide survives polling, host changes, size changes, and mode toggles', () => {
  const h = harness(); h.controller.setEnabled(true); h.controller.update(sample());
  h.controller.setManualHidden(true);
  h.controller.update(sample({ host: { ...sample().host, id: '456' } }));
  h.resize({ width: 260, height: 320 });
  assert.equal(h.visible, false); assert.equal(h.controller.getState().reason, 'manual-hidden');
  h.controller.setEnabled(false); assert.equal(h.visible, false);
  h.controller.setEnabled(true); h.controller.update(sample()); assert.equal(h.visible, false);
  h.controller.setManualHidden(false); assert.equal(h.visible, true);
});
test('an explicit show cannot reveal the widget outside a currently available host', () => {
  const h = harness(); h.controller.setEnabled(true); h.controller.setManualHidden(true);
  h.controller.setManualHidden(false); assert.equal(h.visible, false);
  h.controller.update(sample({ foreground: 'other' }));
  h.controller.setManualHidden(false); assert.equal(h.visible, false);
  h.controller.update(sample()); assert.equal(h.visible, true);
});
test('disabling restores the saved standalone position and latest top preference', () => {
  const h = harness();
  const original = { x: -1100, y: -200 };
  h.controller.setEnabled(true, { position: original, alwaysOnTop: true });
  h.controller.update(sample()); h.controller.moveTo(100, 80);
  h.controller.setEnabled(true, { position: { x: 999, y: 999 }, alwaysOnTop: false });
  h.resize({ width: 300, height: 360 });
  h.controller.setEnabled(false);
  assert.deepEqual(h.bounds, { ...original, width: 300, height: 360 });
  assert.equal(h.top, false); assert.equal(h.visible, true);
});
test('without a saved position disabling restores the actual position at enable time', () => {
  const h = harness({ bounds: { x: 999, y: -320 } });
  h.controller.setEnabled(true, { alwaysOnTop: true }); h.controller.update(sample());
  h.controller.setEnabled(false);
  assert.deepEqual(h.bounds, { x: 999, y: -320, ...preferred }); assert.equal(h.top, true);
  const count = h.calls.length;
  h.controller.setEnabled(false); assert.equal(h.calls.length, count);
});
test('a new enable requires a new snapshot instead of reusing the old host', () => {
  const h = harness(); h.controller.setEnabled(true); h.controller.update(sample());
  h.controller.setEnabled(false); h.controller.setEnabled(true);
  assert.equal(h.visible, false); assert.equal(h.controller.getArea(), null);
  h.controller.update(sample()); assert.equal(h.visible, true);
});
test('later standalone drags are not rewound by an explicit hide/show or refresh', () => {
  const h = harness(); h.controller.setEnabled(true); h.controller.update(sample());
  h.controller.setEnabled(false); h.moveStandalone(-800, 250);
  h.controller.setManualHidden(true); h.controller.setManualHidden(false); h.controller.refreshSize();
  assert.deepEqual(h.bounds, { x: -800, y: 250, ...preferred }); assert.equal(h.visible, true);
});
test('explicit standalone hide/show works before containment has ever been enabled', () => {
  const h = harness(); h.controller.setManualHidden(true); assert.equal(h.visible, false);
  h.controller.setManualHidden(false); assert.equal(h.visible, true);
  assert.equal(h.calls.some(call => call.kind === 'bounds'), false);
});
test('preferred width and height remain fixed through 420 fractional-DPI drags', () => {
  const h = harness({ nativeError: 1 }); h.controller.setEnabled(true); h.controller.update(sample());
  for (let i = 0; i < 420; i++) h.controller.moveTo(100 + i, 100 + i / 3);
  for (const call of h.calls.filter(value => value.kind === 'bounds')) {
    assert.equal(call.width, preferred.width); assert.equal(call.height, preferred.height);
  }
  assert.equal(h.bounds.width, 229); assert.equal(h.bounds.height, 289);
});
test('unchanged polls do not repeatedly move, show, or bind the window', () => {
  const h = harness({ onHostChanged() {} }); h.controller.setEnabled(true); h.controller.update(sample());
  const count = h.calls.length;
  for (let i = 0; i < 100; i++) h.controller.update(sample());
  assert.equal(h.calls.length, count);
});
test('snapshot and diagnostic geometry cannot be mutated by callers', () => {
  const h = harness(); h.controller.setEnabled(true);
  const snapshot = sample(); h.controller.update(snapshot);
  snapshot.host.clientBounds.x = 90000;
  const area = h.controller.getArea(); area.x = -90000;
  const state = h.controller.getState(); state.anchor.x = 100;
  assert.deepEqual(h.controller.getHostBounds(), client);
  assert.ok(h.controller.getState().anchor.x <= 1);
});
test('asynchronous owner binding hides until successful completion', async () => {
  const bind = deferred(), h = harness({ onHostChanged: () => bind.promise });
  h.controller.setEnabled(true); h.controller.update(sample());
  assert.equal(h.visible, false); assert.equal(h.controller.getState().reason, 'owner-pending');
  assert.equal(h.calls.some(call => call.kind === 'show'), false);
  bind.resolve({ ok: true }); await settle();
  assert.equal(h.visible, true); assert.equal(h.controller.getState().reason, 'contained');
});
test('unknown observations and explicit hides cannot be undone by a pending owner callback', async () => {
  for (const cause of ['unknown', 'manual']) {
    const bind = deferred(), h = harness({ onHostChanged: () => bind.promise });
    h.controller.setEnabled(true); h.controller.update(sample());
    if (cause === 'unknown') h.controller.update({ known: false });
    else h.controller.setManualHidden(true);
    bind.resolve({ ok: true }); await settle();
    assert.equal(h.visible, false);
  }
});
test('out-of-order owner completions cannot reveal a replaced host', async () => {
  const first = deferred(), second = deferred();
  const h = harness({ onHostChanged: host => host?.id === '123' ? first.promise : second.promise });
  h.controller.setEnabled(true); h.controller.update(sample());
  h.controller.update(sample({ host: { ...sample().host, id: '456' } }));
  first.resolve({ ok: true }); await settle();
  assert.equal(h.visible, false); assert.equal(h.controller.getState().hostId, '456');
  second.resolve({ ok: true }); await settle(); assert.equal(h.visible, true);
});
test('disabling waits for owner removal and ignores stale bind completion', async () => {
  const bind = deferred(), clear = deferred();
  const h = harness({ onHostChanged: host => host ? bind.promise : clear.promise });
  h.controller.setEnabled(true); h.controller.update(sample()); h.controller.setEnabled(false);
  bind.resolve({ ok: true }); await settle(); assert.equal(h.visible, false);
  clear.resolve({ ok: true }); await settle();
  assert.equal(h.visible, true); assert.deepEqual(h.bounds, { x: 700, y: 500, ...preferred }); assert.equal(h.top, true);
});
test('failed owner bind remains hidden and a subsequent valid observation can retry', async () => {
  let attempts = 0;
  const h = harness({ onHostChanged: async () => { if (++attempts === 1) throw new Error('denied'); return { ok: true }; } });
  h.controller.setEnabled(true); h.controller.update(sample()); await settle();
  assert.equal(h.visible, false); assert.equal(h.controller.getState().reason, 'owner-unavailable');
  h.controller.update(sample()); await settle(); assert.equal(h.visible, true);
});
test('unsupported providers are visible in diagnostics and remain hidden', () => {
  const h = harness(); h.controller.setEnabled(true);
  h.controller.update({ known: false, supported: false });
  assert.equal(h.controller.getState().supported, false);
  assert.equal(h.controller.getState().reason, 'unsupported'); assert.equal(h.visible, false);
});
test('a show/stacking failure hides the native window, reports failure, and retries', () => {
  for (const failure of ['throw', 'false']) {
    let attempts = 0;
    const h = harness({ show() { if (++attempts === 1) { if (failure === 'throw') throw new Error('native stacking failed'); return false; } return true; } });
    h.controller.setEnabled(true);
    assert.doesNotThrow(() => h.controller.update(sample()));
    assert.equal(h.controller.getState().visible, false);
    assert.equal(h.controller.getState().reason, 'placement-unavailable'); assert.equal(h.visible, false);
    h.controller.update(sample());
    assert.equal(h.visible, true); assert.equal(h.controller.getState().reason, 'contained');
  }
});
test('hide failures never escape the monitor and are marked for a subsequent retry', () => {
  let fail = false;
  const h = harness({ hide() { if (fail) throw new Error('native hide failed'); } });
  h.controller.setEnabled(true); h.controller.update(sample()); fail = true;
  assert.doesNotThrow(() => h.controller.update(sample({ foreground: 'other' })));
  assert.equal(h.controller.getState().visible, false); assert.equal(h.controller.getState().reason, 'hide-unavailable');
  fail = false;
  h.controller.update(sample({ foreground: 'other' }));
  assert.equal(h.controller.getState().visible, false);
  h.controller.update(sample()); assert.equal(h.controller.getState().reason, 'contained'); assert.equal(h.visible, true);
});
