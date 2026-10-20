'use strict';
const { spawn: nativeSpawn } = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');
const { createDesktopInventoryQuery } = require('./codex-desktop.cjs');
const { CODEX_BUNDLE_ID } = require('./macos-bundle.cjs');

const MAX_OUTPUT_BYTES = 256 * 1024;
const MAX_WINDOWS = 2048;
const MAX_ROOTS = 1024;

// A single system JXA host answers bounded requests. Calling these metadata
// APIs neither controls another app nor captures its contents. In particular,
// do not unwrap an entire CG dictionary: optional keys can contain private data.
// NSRunningApplication rechecks the bundle ID after the process/path inventory.
// No System Events, Accessibility, screen capture or authorization request APIs
// are used. A bridge/WindowServer failure is unknown, never a desktop fallback.
const WINDOW_WORKER_SCRIPT = String.raw`
ObjC.import('Foundation');
ObjC.import('AppKit');
ObjC.import('CoreGraphics');
ObjC.import('CoreFoundation');
var expectedBundle = ${JSON.stringify(CODEX_BUNDLE_ID)};
function emptyWindowState() {
    return { known: false, windows: [], foregroundWindow: '0', foregroundPid: 0 };
}
// NSString keys also work when CoreGraphics CFString constants are opaque.
function scalar(dictionary, key) {
    var value = dictionary.objectForKey(key);
    return !value || value.isNil() ? undefined : ObjC.unwrap(value);
}
function positiveInteger(value) {
    return typeof value === 'number' && isFinite(value) && Math.floor(value) === value && value > 0;
}
function snapshot(request) {
    var raw;
    try {
        if (!request || request.op !== 'query' || !Array.isArray(request.pids) || request.pids.length > ${MAX_ROOTS}) return emptyWindowState();
        var trackWidget = typeof request.widgetWindowId === 'string' && /^[1-9]\d*$/.test(request.widgetWindowId) && positiveInteger(request.widgetPid);
        // NSRunningApplication's changing properties are cached until the main
        // run loop advances. Drain events between requests before using them.
        $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(0.001));
        var trusted = {};
        for (var i = 0; i < request.pids.length; i++) {
            var pid = request.pids[i];
            if (!positiveInteger(pid)) return emptyWindowState();
            var app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(pid);
            if (app && !app.isNil() && !app.terminated && ObjC.unwrap(app.bundleIdentifier) === expectedBundle) trusted[pid] = true;
        }
        var front = $.NSWorkspace.sharedWorkspace.frontmostApplication;
        var foregroundPid = front && !front.isNil() ? Number(front.processIdentifier) : 0;
        if (!positiveInteger(foregroundPid)) foregroundPid = 0;
        raw = $.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements, $.kCGNullWindowID);
        if (!raw) return emptyWindowState();
        // Older bridges expose a toll-free NSArray directly; newer ones expose
        // an opaque CF reference. Keep the dictionaries native in both cases.
        var list;
        try { if (typeof raw.count === 'number') list = raw; } catch (_) {}
        if (!list) list = ObjC.castRefToObject(raw);
        var count = Number(list.count);
        if (!isFinite(count) || Math.floor(count) !== count || count < 0 || count > 20000) return emptyWindowState();
        var windows = [], foregroundWindow = '0', widgetIndex = -1;
        for (var j = 0; j < count; j++) {
            var info = list.objectAtIndex(j);
            var owner = Number(scalar(info, "kCGWindowOwnerPID"));
            if (trackWidget && owner === request.widgetPid && String(Number(scalar(info, "kCGWindowNumber"))) === request.widgetWindowId && Number(scalar(info, "kCGWindowAlpha")) > 0) widgetIndex = j;
            if (!trusted[owner] || Number(scalar(info, "kCGWindowLayer")) !== 0 || !(Number(scalar(info, "kCGWindowAlpha")) > 0)) continue;
            var onScreen = scalar(info, "kCGWindowIsOnscreen");
            if (onScreen === false || onScreen === 0) continue;
            var id = Number(scalar(info, "kCGWindowNumber"));
            var rect = info.objectForKey("kCGWindowBounds");
            if (!positiveInteger(id) || !rect || rect.isNil()) return emptyWindowState();
            var x = Number(scalar(rect, 'X')), y = Number(scalar(rect, 'Y'));
            var width = Number(scalar(rect, 'Width')), height = Number(scalar(rect, 'Height'));
            if (![x, y, width, height].every(isFinite) || width <= 0 || height <= 0) return emptyWindowState();
            if (width < 320 || height < 200) continue; // Same minimum as the reference CGWindow probe.
            var foreground = owner === foregroundPid && foregroundWindow === '0';
            if (foreground) foregroundWindow = String(id);
            windows.push({ id: String(id), pid: owner, bounds: { x: x, y: y, width: width, height: height }, visible: true, minimized: false, cloaked: false, foreground: foreground, orderIndex: j });
            if (windows.length > ${MAX_WINDOWS}) return emptyWindowState();
        }
        for (var k = 0; k < windows.length; k++) {
            if (trackWidget) windows[k].widgetAboveHost = widgetIndex >= 0 && widgetIndex < windows[k].orderIndex;
            delete windows[k].orderIndex;
        }
        var result = { known: true, windows: windows, foregroundWindow: foregroundWindow, foregroundPid: foregroundPid };
        if (trackWidget) result.widgetVisible = widgetIndex >= 0;
        return result;
    } catch (_) { return emptyWindowState(); }
    // JXA owns the bridged object; CFRelease causes a later double release.
}
function run() {
    var input = $.NSFileHandle.fileHandleWithStandardInput;
    var output = $.NSFileHandle.fileHandleWithStandardOutput;
    var buffer = '';
    while (true) {
        var data = input.availableData;
        if (!data || Number(data.length) === 0) return;
        buffer += ObjC.unwrap($.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding));
        if (buffer.length > 65536) return;
        var newline;
        while ((newline = buffer.indexOf('\n')) >= 0) {
            var line = buffer.slice(0, newline);
            buffer = buffer.slice(newline + 1);
            var result;
            try { result = snapshot(JSON.parse(line)); } catch (_) { result = emptyWindowState(); }
            var encoded = $.NSString.alloc.initWithUTF8String(JSON.stringify(result) + '\n').dataUsingEncoding($.NSUTF8StringEncoding);
            output.writeData(encoded);
        }
    }
}
`;

function unavailable(platform, reason = 'window-query-unavailable') {
  return { known: false, supported: platform === 'darwin', windows: [], foregroundWindow: '0', foregroundPid: 0, coordinateSpace: 'dip', reason };
}
function nativeHandleId(value) {
  try {
    let id;
    if (Buffer.isBuffer(value)) {
      if (value.length === 8) id = value.readBigUInt64LE();
      else if (value.length === 4) id = BigInt(value.readUInt32LE());
      else return '0';
    } else if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) id = BigInt(value);
    else if (typeof value === 'bigint') id = value;
    else if (typeof value === 'string' && /^[1-9]\d*$/.test(value) && value.length <= 20) id = BigInt(value);
    else return '0';
    return id > 0n && id <= 0xffffffffffffffffn ? id.toString() : '0';
  } catch { return '0'; }
}
function validBounds(bounds) {
  return bounds && ['x', 'y', 'width', 'height'].every(key => typeof bounds[key] === 'number' && Number.isFinite(bounds[key]) && Math.abs(bounds[key]) <= 1000000) && bounds.width > 0 && bounds.height > 0;
}
function parseSnapshot(answer, allowedPids) {
  if (!answer || answer.known !== true || !Array.isArray(answer.windows) || answer.windows.length > MAX_WINDOWS ||
      !Number.isSafeInteger(answer.foregroundPid) || answer.foregroundPid < 0 ||
      (answer.foregroundWindow !== '0' && nativeHandleId(answer.foregroundWindow) === '0')) return null;
  if (answer.widgetVisible !== undefined && typeof answer.widgetVisible !== 'boolean') return null;
  const ids = new Set(), windows = [];
  for (const item of answer.windows) {
    if (!item || typeof item.id !== 'string' || nativeHandleId(item.id) !== item.id || ids.has(item.id) ||
        !Number.isSafeInteger(item.pid) || !allowedPids.has(item.pid) || !validBounds(item.bounds) ||
        item.visible !== true || item.minimized !== false || item.cloaked !== false || typeof item.foreground !== 'boolean' ||
        item.foreground !== (item.id === answer.foregroundWindow && item.pid === answer.foregroundPid) ||
        (item.widgetAboveHost !== undefined && typeof item.widgetAboveHost !== 'boolean')) return null;
    ids.add(item.id);
    windows.push({ id: item.id, pid: item.pid, bounds: { x: item.bounds.x, y: item.bounds.y, width: item.bounds.width, height: item.bounds.height },
      visible: true, minimized: false, cloaked: false, foreground: item.foreground,
      ...(item.widgetAboveHost === undefined ? {} : { widgetAboveHost: item.widgetAboveHost }) });
  }
  if (answer.foregroundWindow !== '0' && !windows.some(item => item.foreground)) return null;
  return { known: true, supported: true, windows, foregroundWindow: answer.foregroundWindow, foregroundPid: answer.foregroundPid, coordinateSpace: 'dip', foregroundWindowIsGuess: true,
    ...(answer.widgetVisible === undefined ? {} : { widgetVisible: answer.widgetVisible }) };
}

class CodexWindowProvider {
  constructor({ platform = process.platform, spawn = nativeSpawn, execFile, inventory, queryRoots, timeout = 4000, rootCacheMs = 2500, now = Date.now, uid, readBundle, homedir, getWidgetWindowId, widgetPid = process.pid } = {}) {
    this.platform = platform;
    this.spawn = spawn;
    this.timeout = timeout;
    this.rootCacheMs = rootCacheMs;
    this.now = now;
    this.getWidgetWindowId = getWidgetWindowId;
    this.widgetPid = widgetPid;
    this.inventory = inventory || (!queryRoots && platform === 'darwin' ? createDesktopInventoryQuery({ platform, execFile, uid, readBundle, homedir }) : null);
    this.queryRoots = queryRoots || (() => this.inventory.query());
    this.roots = null;
    this.rootsAt = -Infinity;
    this.worker = null;
    this.workerPending = null;
    this.pending = null;
    this.closed = false;
  }
  query() {
    if (this.pending) return this.pending.promise;
    if (this.closed) return Promise.resolve(unavailable(this.platform));
    if (this.platform !== 'darwin') return Promise.resolve(unavailable(this.platform, 'unsupported-platform'));
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    const pending = { promise, resolve, timer: setTimeout(() => {
      if (this.pending !== pending) return;
      this.disposeWorker(); this.settle(pending, unavailable(this.platform));
    }, this.timeout) };
    this.pending = pending;
    this.read(pending).then(value => this.settle(pending, value), () => this.settle(pending, unavailable(this.platform)));
    return promise;
  }
  async read(request) {
    const time = this.now();
    if (!this.roots || time - this.rootsAt >= this.rootCacheMs || time < this.rootsAt) {
      const inventory = await this.queryRoots();
      if (this.closed || this.pending !== request) return unavailable(this.platform);
      this.roots = null;
      if (!inventory || inventory.known !== true || !Array.isArray(inventory.roots) || inventory.roots.length > MAX_ROOTS ||
          !inventory.roots.every(item => item && Number.isSafeInteger(item.pid) && item.pid > 0)) return unavailable(this.platform);
      this.roots = [...new Set(inventory.roots.map(item => item.pid))];
      this.rootsAt = this.now();
    }
    if (!this.roots.length) return { known: true, supported: true, windows: [], foregroundWindow: '0', foregroundPid: 0, coordinateSpace: 'dip' };
    if (this.closed || this.pending !== request) return unavailable(this.platform);
    return new Promise(resolve => {
      this.workerPending = { resolve, allowedPids: new Set(this.roots) };
      try {
        if (!this.worker) this.startWorker();
        const worker = this.worker;
        const widgetWindowId = this.getWidgetWindowId?.();
        worker.child.stdin.write(JSON.stringify({ op: 'query', pids: this.roots, widgetWindowId, widgetPid: widgetWindowId ? this.widgetPid : undefined }) + '\n', error => {
          if (error && this.worker === worker) this.disposeWorker();
        });
      } catch { this.disposeWorker(); }
    });
  }
  startWorker() {
    const child = this.spawn('/usr/bin/osascript', ['-l', 'JavaScript', '-e', WINDOW_WORKER_SCRIPT], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    const worker = { child, decoder: new StringDecoder('utf8'), output: '', bytes: 0 };
    this.worker = worker;
    const fail = () => { if (this.worker === worker) this.disposeWorker(); };
    child.on('error', fail); child.on('exit', fail);
    child.stdin.on('error', fail); child.stdout.on('error', fail); child.stdout.on('end', fail);
    child.stdout.on('data', chunk => this.receive(worker, chunk));
  }
  receive(worker, chunk) {
    if (this.worker !== worker) return;
    worker.bytes += Buffer.byteLength(chunk);
    if (worker.bytes > MAX_OUTPUT_BYTES) { this.disposeWorker(); return; }
    worker.output += worker.decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const newline = worker.output.indexOf('\n');
    if (newline < 0) return;
    const line = worker.output.slice(0, newline).replace(/^\uFEFF/, '').trim();
    worker.output = worker.output.slice(newline + 1);
    worker.bytes = Buffer.byteLength(worker.output);
    if (!this.workerPending || !line || worker.output.trim()) { this.disposeWorker(); return; }
    let value;
    try { value = parseSnapshot(JSON.parse(line), this.workerPending.allowedPids); } catch { value = null; }
    if (!value) { this.disposeWorker(); return; }
    const pending = this.workerPending;
    this.workerPending = null;
    pending.resolve(value);
  }
  settle(pending, value) {
    if (this.pending !== pending) return;
    this.pending = null;
    clearTimeout(pending.timer);
    pending.resolve(this.closed ? unavailable(this.platform) : value);
  }
  disposeWorker() {
    const worker = this.worker, pending = this.workerPending;
    this.worker = null;
    this.workerPending = null;
    if (worker) {
      try { worker.child.stdin.end(); } catch {}
      try { worker.child.kill(); } catch {}
    }
    if (pending) pending.resolve(unavailable(this.platform));
  }
  // macOS cannot adopt another process's NSWindow. The main process limits
  // visibility to the foreground Codex app and applies the host bounds instead.
  async setOwner() { return { ok: !this.closed && this.platform === 'darwin' }; }
  async clearOwner() { return { ok: !this.closed && this.platform === 'darwin' }; }
  close() {
    this.closed = true;
    this.disposeWorker();
    this.inventory?.close?.();
    if (this.pending) this.settle(this.pending, unavailable(this.platform));
  }
}

module.exports = { CodexWindowProvider, nativeHandleId };
