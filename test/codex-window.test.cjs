'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { gunzipSync } = require('node:zlib');
const { CodexWindowProvider, WINDOW_WORKER_SCRIPT, nativeHandleId } = require('../src/codex-window.cjs');
const { MAX_OUTPUT_BYTES } = require('../src/windows-inventory.cjs');

// This suite does not read a profile, Codex data directory or actual window.
// The only operating-system boundary is replaced with this private pipe harness.
const windowItem = { id: '12345', pid: 123, bounds: { x: -1920, y: 37, width: 1920, height: 1043 },
  visible: true, minimized: false, cloaked: false, foreground: true };
const snapshot = { known: true, supported: true, coordinateSpace: 'physical-pixels', windows: [windowItem],
  foregroundWindow: '12345', foregroundRoot: '12345', foregroundPid: 123 };
const turn = () => new Promise(resolve => setImmediate(resolve));
test('native modal and main-window flags survive transport and malformed modal metadata fails closed', async t => {
  const { provider, children } = harness(); t.after(() => provider.close());
  const pending = provider.query(); await turn();
  const item = { ...windowItem, modal: true, mainWindow: true };
  children[0].reply({ ...snapshot, windows: [item] });
  assert.deepEqual((await pending).windows, [item]);
  const corrupt = provider.query(); await turn();
  children[0].reply({ ...snapshot, windows: [{ ...item, modal: 'true' }] });
  assert.equal((await corrupt).known, false);
});
function harness(options = {}) {
  const children = [], scripts = [];
  const spawn = (file, args, settings) => {
    assert.equal(file, 'powershell.exe');
    for (const flag of ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand']) assert.ok(args.includes(flag));
    assert.equal(settings.windowsHide, true);
    assert.deepEqual(settings.stdio, ['pipe', 'pipe', 'ignore']);
    assert.equal(Object.hasOwn(settings, 'shell'), false);
    assert.ok(args.join(' ').length < 30000, 'must fit CreateProcess command-line limit');
    const bootstrap = Buffer.from(args[args.indexOf('-EncodedCommand') + 1], 'base64').toString('utf16le');
    const compressed = bootstrap.match(/FromBase64String\('([A-Za-z0-9+/=]+)'\)/)[1];
    scripts.push(gunzipSync(Buffer.from(compressed, 'base64')).toString('utf8'));
    const child = new EventEmitter();
    child.stdin = new EventEmitter(); child.stdout = new EventEmitter();
    child.writes = []; child.ends = 0; child.kills = 0;
    child.stdin.write = (value, done) => { child.writes.push(value); done?.(); };
    child.stdin.end = () => child.ends++;
    child.kill = () => { child.kills++; child.emit('exit', 0); };
    child.reply = value => child.stdout.emit('data', Buffer.from(JSON.stringify(value) + '\n'));
    children.push(child);
    return child;
  };
  const provider = new CodexWindowProvider({ platform: 'win32', widgetPid: 456, spawn, ...options });
  return { provider, children, scripts };
}

test('native handles retain 64-bit precision and reject invalid or injectable identifiers', () => {
  const handle = Buffer.alloc(8); handle.writeBigUInt64LE(9007199254740993n);
  assert.equal(nativeHandleId(handle), '9007199254740993');
  assert.equal(nativeHandleId(Buffer.from([255, 255, 255, 127])), '2147483647');
  assert.equal(nativeHandleId(12345), '12345');
  assert.equal(nativeHandleId('12345'), '12345');
  for (const value of ['', '0', '01', '-2', '1\nquery', '1;exit', '9223372036854775808', 0, -1,
    Number.MAX_SAFE_INTEGER + 1, Buffer.alloc(0), Buffer.alloc(8), null, {}]) assert.equal(nativeHandleId(value), '');
});

test('one native host limits inventory to validated desktop roots and never reads captions', () => {
  assert.equal((WINDOW_WORKER_SCRIPT.match(/Add-Type/g) || []).length, 1);
  for (const marker of ['MaidWindowsInventory.Query()', 'OfficialPath', 'ownSession', 'ownSid', 'SetThreadDpiAwarenessContext',
    'GetClientRect', 'ClientToScreen', 'DwmGetWindowAttribute', 'GetForegroundWindow', 'foregroundPid',
    'Pid(widget) != widgetPid', 'roots.Contains(Pid(owner))', 'GetWindowLongPtr64(widget, -8)', 'physical-pixels']) assert.ok(WINDOW_WORKER_SCRIPT.includes(marker), marker);
  assert.doesNotMatch(WINDOW_WORKER_SCRIPT, /GetWindowText|WM_GETTEXT|SendMessage|auth\.json|Get-CimInstance|commandline/i);
  assert.match(WINDOW_WORKER_SCRIPT, /if \(owner != IntPtr.Zero\) \{\s+var roots = ValidatedRoots\(true\);/,
    'removing an owner must not depend on Codex still existing');
});

test('native child attachment guards ownership and exact DPI context before reparenting', () => {
  const attach = WINDOW_WORKER_SCRIPT.slice(WINDOW_WORKER_SCRIPT.indexOf('public static object AttachChild('),
    WINDOW_WORKER_SCRIPT.indexOf('public static object PositionChild('));
  const mutate = attach.indexOf('SetParent(widget, host)');
  for (const guard of ['OwnWidget(widget, widgetPid)', 'TrustedHost(host, roots)',
    'AreDpiAwarenessContextsEqual(widgetContext, hostContext)']) {
    assert.ok(attach.indexOf(guard) >= 0 && attach.indexOf(guard) < mutate, guard);
  }
  assert.match(attach, /Style = GetLong\(widget, -16\), ExStyle = GetLong\(widget, -20\)/);
  assert.match(WINDOW_WORKER_SCRIPT, /SetParent\(widget, IntPtr.Zero\);[\s\S]*SetLong\(widget, -16, binding.Style\);[\s\S]*SetLong\(widget, -20, binding.ExStyle\)/);
  assert.match(WINDOW_WORKER_SCRIPT, /Math\.Min\(\(long\)availableWidth - width, \(long\)x - origin.X\)/);
});

test('explicit widget handle adds validated native visibility metadata and strips other fields', async t => {
  const { provider, children, scripts } = harness({ widgetHandle: '23456' }); t.after(() => provider.close());
  const pending = provider.query(); await turn();
  assert.match(scripts[0], /::Query\(23456, 456\)/);
  assert.doesNotMatch(scripts[0], /__WIDGET_PID__|__WIDGET_HWND__/);
  const item = { ...windowItem, dpi: 144, widgetParented: true, widgetAboveHost: true };
  const metadata = { widgetVisible: true, widgetParented: true, widgetParentId: '12345', widgetDpi: 144, widgetStyleCached: true };
  children[0].reply({ ...snapshot, ...metadata, windows: [{ ...item, caption: 'discard' }], private: 'discard' });
  assert.deepEqual(await pending, { ...snapshot, ...metadata, windows: [item] });
  const invalid = provider.query(); await turn();
  children[0].reply({ ...snapshot, widgetParentId: '1\ndetach 2' });
  assert.equal((await invalid).known, false);
  assert.throws(() => new CodexWindowProvider({ widgetHandle: '2;exit' }), TypeError);
});

test('child requests serialize, coalesce queued pointer positions, and preserve detach ordering', async t => {
  const { provider, children } = harness(); t.after(() => provider.close());
  const attach = provider.attachChild('23456', '12345'); await turn();
  const first = provider.positionChild('23456', '12345', { x: -1900, y: 100, width: 342, height: 432 });
  const latest = provider.positionChild('23456', '12345', { x: -1800, y: 200, width: 342, height: 432 });
  assert.equal(first, latest);
  assert.deepEqual(children[0].writes, ['attach 23456 12345\n']);
  children[0].reply({ known: true, supported: true, ok: true, parented: true });
  assert.deepEqual(await attach, { known: true, supported: true, ok: true, parented: true }); await turn();
  assert.equal(children[0].writes.at(-1), 'position 23456 12345 -1800 200 342 432\n');
  const second = provider.positionChild('23456', '12345', { x: -1700, y: 300, width: 342, height: 432 });
  const detach = provider.detachChild('23456');
  const third = provider.positionChild('23456', '12345', { x: -1600, y: 400, width: 342, height: 432 });
  assert.notEqual(second, third);
  children[0].reply({ known: true, supported: true, ok: true, parented: true }); await first; await turn();
  assert.equal(children[0].writes.at(-1), 'position 23456 12345 -1700 300 342 432\n');
  children[0].reply({ known: true, supported: true, ok: true, parented: true }); await second; await turn();
  assert.equal(children[0].writes.at(-1), 'detach 23456\n');
  children[0].reply({ known: true, supported: true, ok: true, parented: false }); await detach; await turn();
  assert.equal(children[0].writes.at(-1), 'position 23456 12345 -1600 400 342 432\n');
  children[0].reply({ known: true, supported: true, ok: false, parented: false });
  assert.deepEqual(await third, { known: true, supported: true, ok: false, parented: false });
});

test('child methods reject invalid geometry and native acknowledgement before any follow-up state is trusted', async t => {
  const { provider, children } = harness(); t.after(() => provider.close());
  for (const operation of [() => provider.attachChild('0', '12345'), () => provider.detachChild('2\nquery'),
    () => provider.positionChild('23456', '12345', { x: 0.5, y: 0, width: 228, height: 288 }),
    () => provider.positionChild('23456', '12345', { x: 0, y: 0, width: 0, height: 288 }),
    () => provider.positionChild('23456', '12345', { x: 100000001, y: 0, width: 228, height: 288 })]) {
    assert.equal((await operation()).known, false);
  }
  assert.equal(children.length, 0);
  const attach = provider.attachChild('23456', '12345'); await turn();
  children[0].reply({ known: true, supported: true, ok: true, parented: 'true' });
  assert.equal((await attach).known, false);
  assert.equal(children[0].kills, 1);
});

test('lost native style cache requests widget recreation using a finite, safe reason', async t => {
  const { provider, children } = harness(); t.after(() => provider.close());
  const attach = provider.attachChild('23456', '12345'); await turn();
  children[0].reply({ known: true, supported: true, ok: false, parented: true, reason: 'child-style-unavailable' });
  assert.deepEqual(await attach, { known: true, supported: true, ok: false, parented: true, reason: 'child-style-unavailable' });
  const detach = provider.detachChild('23456'); await turn();
  children[0].reply({ known: true, supported: true, ok: false, parented: true, reason: 'private native exception' });
  assert.equal((await detach).known, false);
  assert.equal(children[0].kills, 1);
});

test('query reuses one hidden host, preserves physical coordinates and strips accidental extra data', async t => {
  const { provider, children, scripts } = harness(); t.after(() => provider.close());
  const first = provider.query(), same = provider.query();
  assert.equal(first, same); await turn();
  assert.equal(children.length, 1); assert.deepEqual(children[0].writes, ['query\n']);
  assert.ok(scripts[0].includes('SetOwner([long]$Matches[1], [long]$Matches[2], 456)'));
  assert.equal(scripts[0].includes('__WIDGET_PID__'), false);
  children[0].reply({ ...snapshot, private: 'discard', windows: [{ ...windowItem, caption: 'discard' }] });
  assert.deepEqual(await first, snapshot);
  const next = provider.query(); await turn(); children[0].reply({ ...snapshot, windows: [] });
  assert.deepEqual(await next, { ...snapshot, windows: [] });
  assert.equal(children.length, 1);
});

test('owner binding and removal serialize behind pending queries and distinguish native acknowledgements', async t => {
  const { provider, children } = harness(); t.after(() => provider.close());
  const query = provider.query(); await turn();
  const bind = provider.setOwner('23456', '12345');
  const clear = provider.clearOwner('23456');
  assert.deepEqual(children[0].writes, ['query\n']);
  children[0].reply(snapshot); await query; await turn();
  assert.deepEqual(children[0].writes, ['query\n', 'owner 23456 12345\n']);
  children[0].reply({ known: true, supported: true, ok: true });
  assert.deepEqual(await bind, { known: true, supported: true, ok: true }); await turn();
  assert.deepEqual(children[0].writes, ['query\n', 'owner 23456 12345\n', 'owner 23456 0\n']);
  children[0].reply({ known: true, supported: true, ok: false });
  assert.deepEqual(await clear, { known: true, supported: true, ok: false });
});

test('invalid native handle requests cannot enter PowerShell', async t => {
  const { provider, children } = harness(); t.after(() => provider.close());
  for (const operation of [() => provider.setOwner('1;exit', '12345'), () => provider.setOwner('23456', '0'),
    () => provider.setOwner('12345', '12345'), () => provider.clearOwner(Buffer.alloc(8))]) {
    assert.equal((await operation()).reason, 'invalid-window-handle');
  }
  assert.equal(children.length, 0);
  assert.throws(() => new CodexWindowProvider({ widgetPid: -1 }), TypeError);
});

test('unknown snapshots fail closed and retain a healthy host for later recovery', async t => {
  const { provider, children } = harness(); t.after(() => provider.close());
  const first = provider.query(); await turn(); children[0].reply({ known: false, supported: true });
  assert.deepEqual(await first, { known: false, supported: true, coordinateSpace: 'physical-pixels', windows: [], reason: 'window-unavailable' });
  const second = provider.query(); await turn(); children[0].reply(snapshot);
  assert.deepEqual(await second, snapshot); assert.equal(children.length, 1); assert.equal(children[0].kills, 0);
});

test('corrupt or oversized geometry and mismatched replies terminate only the owned worker', async t => {
  const bad = [Buffer.from('bad JSON\n'), Buffer.alloc(MAX_OUTPUT_BYTES + 1, 120),
    Buffer.from(JSON.stringify({ ...snapshot, coordinateSpace: 'dip' }) + '\n'),
    Buffer.from(JSON.stringify({ ...snapshot, foregroundPid: -1 }) + '\n'),
    Buffer.from(JSON.stringify({ ...snapshot, windows: [{ ...windowItem, id: '1\nowner 2 3' }] }) + '\n'),
    Buffer.from(JSON.stringify({ ...snapshot, windows: [{ ...windowItem, bounds: { ...windowItem.bounds, width: -1 } }] }) + '\n'),
    Buffer.from(JSON.stringify({ known: true, supported: true, ok: true }) + '\n')];
  for (const output of bad) {
    const { provider, children } = harness(); t.after(() => provider.close());
    const pending = provider.query(); await turn(); children[0].stdout.emit('data', output);
    assert.equal((await pending).known, false); assert.equal(children[0].kills, 1); assert.equal(children[0].ends, 1);
    const next = provider.query(); await turn(); assert.equal(children.length, 2);
    children[1].reply(snapshot); assert.deepEqual(await next, snapshot);
  }
});

test('timeout, exit and close settle queued operations without stale window state', async t => {
  const { provider, children } = harness({ timeout: 15 }); t.after(() => provider.close());
  assert.equal((await provider.query()).known, false); assert.equal(children[0].kills, 1);
  const next = provider.query(); await turn();
  children[1].emit('error', new Error('private failure'));
  const unavailable = await next; assert.equal(unavailable.known, false); assert.doesNotMatch(JSON.stringify(unavailable), /private/);
  const query = provider.query(), queued = provider.setOwner('23456', '12345'); await turn();
  provider.close();
  assert.equal((await query).known, false); assert.equal((await queued).known, false);
  assert.equal(children.length, 3); assert.equal(children[2].kills, 1);
  assert.equal((await provider.query()).known, false); assert.equal(children.length, 3);
});

test('unsupported platforms are explicit and never start an OS process', async () => {
  const { provider, children } = harness({ platform: 'darwin' });
  assert.deepEqual(await provider.query(), { known: false, supported: false, coordinateSpace: 'physical-pixels', windows: [], reason: 'unsupported-platform' });
  assert.equal((await provider.setOwner('23456', '12345')).supported, false);
  assert.equal(children.length, 0); provider.close();
});
