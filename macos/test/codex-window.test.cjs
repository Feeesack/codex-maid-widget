'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const vm = require('node:vm');
const { CodexWindowProvider, nativeHandleId } = require('../src/codex-window.cjs');

const host = { id: '41', pid: 100, bounds: { x: -1200, y: 40, width: 1100, height: 800 }, visible: true, minimized: false, cloaked: false, foreground: true };
const answer = { known: true, windows: [host], foregroundWindow: '41', foregroundPid: 100 };
const tick = () => new Promise(resolve => setImmediate(resolve));
function harness(options = {}) {
  const children = [], queries = [];
  const inventory = { async query() { queries.push(true); return { known: true, roots: [{ pid: 100 }] }; }, close() { this.closed = true; } };
  const spawn = (file, args, settings) => {
    assert.equal(file, '/usr/bin/osascript');
    assert.deepEqual(args.slice(0, 3), ['-l', 'JavaScript', '-e']);
    assert.equal(settings.windowsHide, true);
    assert.deepEqual(settings.stdio, ['pipe', 'pipe', 'ignore']);
    assert.equal(Object.hasOwn(settings, 'shell'), false);
    const child = new EventEmitter();
    child.script = args[3]; child.stdin = new EventEmitter(); child.stdout = new EventEmitter();
    child.writes = []; child.kills = 0; child.ends = 0;
    child.stdin.write = (value, done) => { child.writes.push(JSON.parse(value)); done?.(); };
    child.stdin.end = () => child.ends++;
    child.kill = () => { child.kills++; child.emit('exit', 0); };
    child.reply = value => child.stdout.emit('data', Buffer.from(JSON.stringify(value) + '\n'));
    children.push(child);
    return child;
  };
  const provider = new CodexWindowProvider({ platform: 'darwin', inventory, spawn, ...options });
  return { provider, children, inventory, queries };
}
async function request(fixture, value = answer) {
  const pending = fixture.provider.query(); await tick(); fixture.children.at(-1).reply(value); return pending;
}

test('persistent metadata worker shares concurrent queries and only sends trusted root IDs', async t => {
  const fixture = harness(); t.after(() => fixture.provider.close());
  const pending = fixture.provider.query(); assert.equal(fixture.provider.query(), pending);
  await tick(); assert.equal(fixture.children.length, 1);
  assert.deepEqual(fixture.children[0].writes, [{ op: 'query', pids: [100] }]);
  fixture.children[0].reply(answer);
  assert.deepEqual(await pending, { ...answer, supported: true, coordinateSpace: 'dip', foregroundWindowIsGuess: true });
  await request(fixture);
  assert.equal(fixture.children.length, 1);
  assert.equal(fixture.queries.length, 1);
  assert.deepEqual(await fixture.provider.setOwner(), { ok: true });
  assert.deepEqual(await fixture.provider.clearOwner(), { ok: true });
});

test('root identities are revalidated after the cache interval and unknown inventory never reuses old bounds', async t => {
  let time = 100;
  const fixture = harness({ now: () => time }); t.after(() => fixture.provider.close());
  await request(fixture);
  time += 2499; await request(fixture); assert.equal(fixture.queries.length, 1);
  time++;
  fixture.inventory.query = async () => ({ known: false, roots: [] });
  assert.equal((await fixture.provider.query()).known, false);
  assert.equal(fixture.children[0].writes.length, 2);
  fixture.inventory.query = async () => ({ known: true, roots: [] });
  const empty = await fixture.provider.query();
  assert.equal(empty.known, true); assert.deepEqual(empty.windows, []);
  assert.equal(fixture.children[0].writes.length, 2);
});

test('onscreen data retains point coordinates, carries foreground state, and projects only public status fields', async t => {
  const fixture = harness(); t.after(() => fixture.provider.close());
  const result = await request(fixture, { ...answer, extra: 'private', windows: [{ ...host, title: 'private', bounds: { ...host.bounds, extra: 'private' } }] });
  assert.deepEqual(result.windows, [host]);
  assert.equal(JSON.stringify(result).includes('private'), false);
  const inactive = await request(fixture, { known: true, windows: [{ ...host, foreground: false }], foregroundWindow: '0', foregroundPid: 200 });
  assert.equal(inactive.foregroundPid, 200); assert.equal(inactive.windows[0].foreground, false);
  assert.deepEqual((await request(fixture, { known: true, windows: [], foregroundWindow: '0', foregroundPid: 100 })).windows, []);
});

test('widget identity is sent separately and stacking fields remain optional boolean metadata', async t => {
  const fixture = harness({ getWidgetWindowId: () => '55', widgetPid: 200 });
  t.after(() => fixture.provider.close());
  const result = await request(fixture, { ...answer, widgetVisible: true, windows: [{ ...host, widgetAboveHost: false }] });
  assert.deepEqual(fixture.children[0].writes, [{ op: 'query', pids: [100], widgetWindowId: '55', widgetPid: 200 }]);
  assert.equal(result.widgetVisible, true);
  assert.equal(result.windows[0].widgetAboveHost, false);
  for (const extra of [{ widgetVisible: 'true' }, { windows: [{ ...host, widgetAboveHost: 1 }] }]) {
    assert.equal((await request(fixture, { ...answer, ...extra })).known, false);
  }
});

test('invalid host IDs, forged PIDs, partial foreground and malformed bounds remain unknown', async t => {
  for (const value of [null, { known: false, windows: [] }, { ...answer, foregroundWindow: '42' },
    { ...answer, windows: [{ ...host, pid: 999 }] }, { ...answer, windows: [{ ...host, id: '0' }] },
    { ...answer, windows: [{ ...host, bounds: { ...host.bounds, width: 0 } }] },
    { ...answer, windows: [{ ...host, bounds: { ...host.bounds, x: Infinity } }] },
    { ...answer, windows: [host, host] }, { ...answer, windows: [{ ...host, foreground: false }] }]) {
    const fixture = harness(); t.after(() => fixture.provider.close());
    const result = await request(fixture, value);
    assert.equal(result.known, false); assert.deepEqual(result.windows, []);
    assert.equal(fixture.children[0].kills, 1);
  }
});

test('missing bridge, timeout, worker exit and closed provider are sanitized and release only owned children', async t => {
  const fixture = harness({ timeout: 30 }); t.after(() => fixture.provider.close());
  assert.equal((await fixture.provider.query()).known, false);
  assert.equal(fixture.children[0].kills, 1);
  const pending = fixture.provider.query(); await tick(); fixture.children[1].emit('error', new Error('private diagnostic'));
  assert.equal(JSON.stringify(await pending).includes('private'), false);
  const recovered = await request(fixture); assert.equal(recovered.known, true);
  const last = fixture.provider.query(); fixture.provider.close();
  assert.equal((await last).known, false); assert.equal(fixture.inventory.closed, true);
  assert.equal((await fixture.provider.query()).known, false);
  assert.deepEqual(await fixture.provider.setOwner(), { ok: false });
  assert.equal(fixture.children.length, 3);
});

test('late inventories after close or timeout cannot start a host or settle the next request', async t => {
  let release;
  const fixture = harness({ timeout: 15, queryRoots: () => new Promise(done => { release = done; }) });
  t.after(() => fixture.provider.close());
  const old = fixture.provider.query(); await tick();
  assert.equal((await old).known, false);
  fixture.provider.queryRoots = async () => ({ known: true, roots: [{ pid: 100 }] });
  const current = fixture.provider.query(); await tick();
  release({ known: true, roots: [{ pid: 200 }] }); await tick();
  fixture.children[0].reply(answer);
  assert.equal((await current).known, true);
  assert.equal(fixture.children.length, 1);
  fixture.provider.roots = null;
  fixture.provider.queryRoots = () => new Promise(done => { release = done; });
  const closed = fixture.provider.query(); fixture.provider.close();
  assert.equal((await closed).known, false);
  release({ known: true, roots: [{ pid: 100 }] }); await tick();
  assert.equal(fixture.children.length, 1);
});

test('unsupported platforms spawn nothing and native handle conversion rejects incomplete or unsafe values', async () => {
  const provider = new CodexWindowProvider({ platform: 'linux', spawn() { throw new Error('Must not execute'); } });
  assert.equal((await provider.query()).supported, false); provider.close();
  const handle = Buffer.alloc(8); handle.writeBigUInt64LE(0x100000001n);
  assert.equal(nativeHandleId(handle), '4294967297'); assert.equal(nativeHandleId(Buffer.from([1, 0, 0, 0])), '1');
  assert.equal(nativeHandleId(42), '42'); assert.equal(nativeHandleId('42'), '42');
  for (const value of [undefined, Buffer.alloc(3), -1, 0, Number.MAX_SAFE_INTEGER + 1, {}, '1;command', 1n << 65n]) assert.equal(nativeHandleId(value), '0');
});

// Execute the actual JXA source against an isolated bridge model. The native
// dictionaries throw if any field outside the geometry/status allowlist is
// requested. This verifies projection and protocol, not macOS native behavior.
function runJxa(script, { windows = [], applications = {}, frontPid = 100, opaque = true, fail = false, request = { op: 'query', pids: [100] } } = {}) {
  const output = [], requested = [], released = [], input = [JSON.stringify(request) + '\n'];
  let advancedRunLoop = false;
  const box = value => ({ isNil: () => value === undefined, value });
  const dictionary = (value, allowed) => ({ isNil: () => false, objectForKey(key) {
    assert.ok(allowed.includes(key), `Unexpected native dictionary key ${key}`); requested.push(key);
    return key === 'kCGWindowBounds' && value[key] ? dictionary(value[key], ['X', 'Y', 'Width', 'Height']) : box(value[key]);
  } });
  const list = { count: windows.length, objectAtIndex: index => dictionary(windows[index], ['kCGWindowOwnerPID', 'kCGWindowLayer', 'kCGWindowAlpha', 'kCGWindowIsOnscreen', 'kCGWindowNumber', 'kCGWindowBounds']) };
  const ref = opaque ? {} : list;
  const $ = { NSUTF8StringEncoding: 4, kCGWindowListOptionOnScreenOnly: 1, kCGWindowListExcludeDesktopElements: 16, kCGNullWindowID: 0,
    NSRunLoop: { currentRunLoop: { runUntilDate() { advancedRunLoop = true; } } }, NSDate: { dateWithTimeIntervalSinceNow: () => ({}) },
    NSRunningApplication: { runningApplicationWithProcessIdentifier(pid) { assert.equal(advancedRunLoop, true); const app = applications[pid]; return { isNil: () => !app, terminated: app?.terminated || false, bundleIdentifier: box(app?.bundleId) }; } },
    NSWorkspace: { sharedWorkspace: { frontmostApplication: { isNil: () => false, processIdentifier: frontPid } } },
    NSFileHandle: { fileHandleWithStandardInput: { get availableData() { const value = input.shift() || ''; return { length: value.length, value }; } }, fileHandleWithStandardOutput: { writeData: value => output.push(value) } },
    NSString: { alloc: { initWithDataEncoding: data => box(data.value), initWithUTF8String: value => ({ dataUsingEncoding: () => value }) } },
    CGWindowListCopyWindowInfo(option, relative) { assert.equal(option, 17); assert.equal(relative, 0); if (fail) throw new Error('private failure'); return ref; },
    CFRelease(value) { released.push(value); },
  };
  // On recent JXA bridges the CFString constants are opaque references, not
  // usable NSString dictionary keys. The allowlist above accepts string keys.
  for (const name of ['kCGWindowOwnerPID', 'kCGWindowLayer', 'kCGWindowAlpha', 'kCGWindowIsOnscreen', 'kCGWindowNumber', 'kCGWindowBounds']) $[name] = {};
  const context = { $, ObjC: { import() {}, unwrap: value => value.value, castRefToObject(value) { assert.equal(value, ref); return list; } } };
  vm.runInNewContext(script, context); context.run();
  return { result: JSON.parse(output[0]), requested, released };
}

test('JXA reads geometry only, rechecks Codex bundle, filters offscreen/overlay windows and supports both CF bridges', async t => {
  const fixture = harness(); t.after(() => fixture.provider.close());
  await request(fixture);
  const script = fixture.children[0].script;
  assert.doesNotMatch(script, /kCGWindowName|kCGWindowOwnerName|CGWindowListCreateImage|CGRequest|AXUI|System Events|Application\(/);
  const native = { kCGWindowOwnerPID: 100, kCGWindowNumber: 41, kCGWindowLayer: 0, kCGWindowAlpha: 1, kCGWindowIsOnscreen: true,
    kCGWindowBounds: { X: -1200, Y: 40, Width: 1100, Height: 800 } };
  for (const opaque of [true, false]) {
    const { result, released } = runJxa(script, { opaque, applications: { 100: { bundleId: 'com.openai.codex' } }, windows: [
      { ...native, kCGWindowOwnerPID: 200 }, { ...native, kCGWindowLayer: 20 }, { ...native, kCGWindowIsOnscreen: false }, native,
    ] });
    assert.deepEqual(result, answer); assert.equal(released.length, 0, 'the bridge owns the converted object');
  }
  for (const bundleId of ['com.openai.chat', undefined]) {
    assert.deepEqual(runJxa(script, { applications: { 100: { bundleId } }, windows: [native] }).result.windows, []);
  }
  assert.equal(runJxa(script, { fail: true }).result.known, false);
});

test('JXA compares widget order only after matching both its window ID and PID', async t => {
  const fixture = harness(); t.after(() => fixture.provider.close());
  await request(fixture);
  const script = fixture.children[0].script;
  const native = { kCGWindowOwnerPID: 100, kCGWindowNumber: 41, kCGWindowLayer: 0, kCGWindowAlpha: 1, kCGWindowIsOnscreen: true,
    kCGWindowBounds: { X: 100, Y: 100, Width: 900, Height: 700 } };
  const widget = { kCGWindowOwnerPID: 200, kCGWindowNumber: 55, kCGWindowAlpha: 1 };
  const query = windows => runJxa(script, { windows, applications: { 100: { bundleId: 'com.openai.codex' } },
    request: { op: 'query', pids: [100], widgetWindowId: '55', widgetPid: 200 } }).result;
  assert.equal(query([widget, native]).windows[0].widgetAboveHost, true);
  assert.equal(query([native, widget]).windows[0].widgetAboveHost, false);
  for (const value of [{ ...widget, kCGWindowOwnerPID: 300 }, { ...widget, kCGWindowNumber: 56 }, { ...widget, kCGWindowAlpha: 0 }]) {
    const result = query([value, native]);
    assert.equal(result.widgetVisible, false);
    assert.equal(result.windows[0].widgetAboveHost, false);
  }
  assert.equal(query([native]).widgetVisible, false);
});
