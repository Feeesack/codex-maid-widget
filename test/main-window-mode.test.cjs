'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

const projectRoot = path.join(__dirname, '..');
const variants = [
  { name: 'Windows', root: projectRoot, platform: 'win32' },
  { name: 'macOS', root: path.join(projectRoot, 'macos'), platform: 'darwin' },
];
const workArea = { x: 0, y: 0, width: 1920, height: 1080 };
const desktopPosition = { x: 1450, y: 650 };
const hostBounds = { x: 100, y: 100, width: 600, height: 500 };
function hostSnapshot(overrides = {}) {
  return { known: true, supported: true, coordinateSpace: 'dip', foregroundWindow: '41', foregroundPid: 100,
    windows: [{ id: '41', pid: 100, bounds: { ...hostBounds }, visible: true, minimized: false, cloaked: false, foreground: true }], ...overrides };
}
const plain = value => JSON.parse(JSON.stringify(value));
const flush = () => new Promise(resolve => setImmediate(resolve));

// All production modules execute in VMs with an explicit in-memory filesystem,
// data-home and native provider. Setting only process.env would not isolate
// transitive data-home imports. No native metadata, profile or network is read.
function controller(variant, options = {}) {
  const fakeHome = path.join(projectRoot, 'tmp', 'isolated-main-window-mode', variant.name);
  const settingsFile = path.join(fakeHome, 'settings.json');
  const controlFile = path.join(fakeHome, 'control.json');
  let persisted = { sizeBaseline: 2, scale: 1, followCodex: false, position: { ...desktopPosition }, ...options.settings };
  let temporary, controlRecord, route, mode, trayTemplate = [], cursor = { x: 400, y: 300 }, visible = true, top;
  let bounds = { ...persisted.position, width: Math.round(228 * persisted.scale), height: Math.round(288 * persisted.scale) };
  const writes = [], calls = [], broadcasts = [], timers = new Map();
  let timerId = 0, now = 10000;
  const FakeDate = class extends Date { static now() { return now; } };
  const clock = {
    setTimeout(callback, delay = 0) { const id = ++timerId; timers.set(id, { callback, delay, due: now + delay }); return id; },
    clearTimeout(id) { timers.delete(id); }, setInterval() { return ++timerId; }, clearInterval() {},
  };
  const isolatedFilesystem = new Proxy({
    mkdirSync(file) { assert.equal(file, fakeHome); },
    readFileSync(file, encoding) { assert.equal(file, settingsFile); assert.equal(encoding, 'utf8'); return JSON.stringify(persisted); },
    writeFileSync(file, value) {
      if (file === controlFile) { controlRecord = JSON.parse(value); return; }
      assert.equal(file, settingsFile + '.tmp'); temporary = JSON.parse(value);
    },
    renameSync(from, to) {
      assert.equal(from, settingsFile + '.tmp'); assert.equal(to, settingsFile);
      persisted = temporary; temporary = undefined; writes.push(plain(persisted));
    },
  }, { get(target, key) {
    if (Object.hasOwn(target, key)) return target[key];
    throw new Error('Unexpected isolated filesystem access: ' + String(key));
  } });
  function loadModule(file, modules = {}) {
    const context = { module: { exports: {} }, __dirname: path.join(variant.root, 'src'),
      process: { platform: variant.platform, pid: 900 }, Date: FakeDate, ...clock,
      require(name) { if (Object.hasOwn(modules, name)) return modules[name]; throw new Error('Unexpected isolated dependency: ' + name); },
    };
    vm.runInNewContext(fs.readFileSync(path.join(variant.root, 'src', file), 'utf8'), context, { filename: file });
    return context.module.exports;
  }
  const geometry = loadModule('settings.cjs', { 'node:fs': isolatedFilesystem, 'node:path': path });
  const containment = loadModule('window-containment.cjs');
  const visibility = loadModule('window-visibility.cjs');
  const provider = { value: hostSnapshot(), queries: 0, closes: 0,
    async query() { this.queries++; return this.value; }, close() { this.closes++; } };
  const windowMode = loadModule('window-mode.cjs', {
    './window-containment.cjs': containment,
    './window-visibility.cjs': visibility,
    './codex-window.cjs': { CodexWindowProvider: class { constructor() { throw new Error('Native provider must stay isolated'); } }, nativeHandleId: () => '0' },
  });
  class IntegratedMode extends windowMode.CodexWindowMode {
    constructor(value) { super({ ...value, platform: variant.platform, providerFactory: () => provider }); mode = this; }
  }
  const widget = {
    webContents: { send(name, value) { if (name === 'state') broadcasts.push(plain(value)); } }, isDestroyed: () => false,
    getPosition: () => [bounds.x, bounds.y], getBounds: () => ({ ...bounds }),
    setBounds(value) { calls.push({ kind: 'bounds', ...plain(value) }); bounds = { ...bounds, ...value }; },
    setPosition() { throw new Error('Position-only updates must not bypass fixed dimensions'); },
    setIgnoreMouseEvents() {}, setOpacity() {},
    setAlwaysOnTop(value) { top = value; calls.push({ kind: 'top', value }); },
    show() { visible = true; calls.push({ kind: 'show' }); },
    showInactive() { visible = true; calls.push({ kind: 'show-inactive' }); },
    hide() { visible = false; calls.push({ kind: 'hide' }); },
    moveAbove(value) { calls.push({ kind: 'above', value }); }, moveTop() { calls.push({ kind: 'move-top' }); },
    isVisible: () => visible,
  };
  const settingsWindow = { webContents: { send() {} }, isDestroyed: () => false, show() {}, focus() {} };
  const tray = { setContextMenu(value) { trayTemplate = value; } };
  const ipcMain = new EventEmitter(), handlers = new Map();
  ipcMain.handle = (name, callback) => handlers.set(name, callback);
  const app = new EventEmitter();
  Object.assign(app, { isPackaged: false, getPath: () => fakeHome, setName() {}, setPath() {},
    getVersion: () => 'isolated-test', requestSingleInstanceLock: () => false, quit() {} });
  const modules = {
    electron: { app, ipcMain, Menu: { buildFromTemplate: value => value }, screen: {
      getCursorScreenPoint: () => ({ ...cursor }), getPrimaryDisplay: () => ({ workArea }),
      getDisplayMatching: () => ({ workArea }), screenToDipRect: (_window, value) => ({ ...value }),
    } },
    'node:fs': isolatedFilesystem, 'node:path': path, 'node:os': {}, 'node:child_process': {},
    'node:crypto': { randomBytes: () => ({ toString: () => 'isolated-synthetic-control-value' }) },
    'node:http': { createServer(callback) {
      route = callback;
      return { once() {}, listen(_port, host, ready) { assert.equal(host, '127.0.0.1'); ready(); }, address: () => ({ port: 12345 }), close() {} };
    } },
    './settings.cjs': geometry, './window-mode.cjs': { CodexWindowMode: IntegratedMode },
    './data-home.cjs': { prepareDataHome: () => fakeHome },
    './character-library.cjs': {}, './codex-data.cjs': {}, './codex-desktop.cjs': {}, './auth-change-watch.cjs': {},
    './windows-launch.cjs': {}, './macos-launch.cjs': {}, './desktop-observation.cjs': {},
    './platform.cjs': { supportsDesktopFollow: () => false },
  };
  const context = { module: { exports: {} }, __dirname: path.join(variant.root, 'src'), Date: FakeDate, ...clock,
    process: { platform: variant.platform, argv: [], env: {}, pid: 900, execPath: path.join(fakeHome, 'widget') },
    require(name) { if (Object.hasOwn(modules, name)) return modules[name]; throw new Error('Unexpected main dependency: ' + name); },
    __widget: widget, __settingsWindow: settingsWindow, __tray: tray,
    __library: { defaultId: 'lilac-dragon', list: () => [{ id: 'lilac-dragon', name: 'Isolated pet', url: 'isolated:pet', available: true }] },
  };
  vm.runInNewContext(fs.readFileSync(path.join(variant.root, 'src', 'main.cjs'), 'utf8') +
    '\nwidget = __widget; settingsWindow = __settingsWindow; tray = __tray; library = __library; setupIpc(); applyWindowSettings();\n' +
    'module.exports = { state, hide, show, action, startControl };', context, { filename: 'main.cjs' });
  const api = context.module.exports;
  function advance(milliseconds) {
    const until = now + milliseconds;
    for (let steps = 0; steps < 256; steps++) {
      // Leave native-provider polls alone; only run renderer remaps and the
      // production 16 ms return animation on this deterministic clock.
      const next = [...timers.entries()].filter(([, value]) => value.delay <= 40 && value.due <= until)
        .sort((a, b) => a[1].due - b[1].due || a[0] - b[0])[0];
      if (!next) { now = until; return; }
      const [id, value] = next; timers.delete(id); now = Math.max(now, value.due); value.callback();
    }
    throw new Error('Short timer failed to settle');
  }
  async function settle() {
    for (let steps = 0; steps < 8; steps++) { await flush(); advance(40); }
  }
  return {
    writes, calls, broadcasts, provider,
    get bounds() { return { ...bounds }; }, get visible() { return visible; }, get top() { return top; },
    get persisted() { return plain(persisted); }, get mode() { return mode; },
    state: () => plain(api.state()),
    patch: value => plain(handlers.get('settings')({ sender: settingsWindow.webContents }, value)),
    foreignPatch(value) { return handlers.get('settings')({ sender: {} }, value); },
    action: name => handlers.get('action')({ sender: widget.webContents }, name),
    hide: api.hide, show: api.show,
    menu(label) { const item = trayTemplate.find(value => value.label === label); assert.ok(item, label); return item; },
    moveCursor(x, y) { cursor = { x, y }; },
    drag(name) { ipcMain.emit('drag-' + name, { sender: widget.webContents }); },
    settle, advance,
    async poll(value = provider.value) { provider.value = value; if (mode?.enabled) await mode.tick(mode.epoch, provider); await settle(); },
    async controlAction(action) {
      if (!route) await api.startControl();
      const request = { method: 'POST', url: '/action', headers: { authorization: 'Bearer ' + controlRecord.token },
        async *[Symbol.asyncIterator]() { yield JSON.stringify({ action }); } };
      let status = 200, body;
      await route(request, { setHeader() {}, writeHead(code) { status = code; }, end(value) { body = value; } });
      return { status, body: JSON.parse(body) };
    },
    close() { mode?.close(); timers.clear(); },
  };
}

for (const variant of variants) {
  function dragTo(control, x, y, release = true) {
    const before = control.bounds;
    const offset = control.state().visualPose.offset;
    control.moveCursor(before.x + offset.x, before.y + offset.y); control.drag('start');
    control.moveCursor(x, y); control.drag('move');
    if (release) { control.drag('end'); control.advance(200); }
  }

  test(`${variant.name}: corner peeking defaults off and only the two bottom corners magnetize`, t => {
    const control = controller(variant); t.after(() => control.close());
    assert.equal(control.state().settings.peekAtCorners, false);
    const size = { width: control.bounds.width, height: control.bounds.height };
    for (const point of [{ x: 12, y: 400 }, { x: 800, y: 12 }, { x: 800, y: 780 }, { x: 12, y: 12 }, { x: 1680, y: 12 }]) {
      dragTo(control, point.x, point.y);
      assert.deepEqual(control.bounds, { ...point, ...size }, 'other edges remain freely placed');
      assert.equal(control.state().cornerDock.peeking, false);
      assert.equal(control.state().cornerDock.corner, null);
    }
    for (const [point, corner, x] of [[{ x: 12, y: 780 }, 'left', 0], [{ x: 1680, y: 780 }, 'right', 1692]]) {
      dragTo(control, point.x, point.y);
      assert.deepEqual(control.bounds, { x, y: 792, ...size });
      assert.deepEqual(control.state().cornerDock, { corner, peeking: false });
    }
    assert.equal(control.persisted.peekAtCorners, false);
  });

  test(`${variant.name}: enabled corner peek keeps clicks folded and restores the full character during a drag`, t => {
    const control = controller(variant); t.after(() => control.close());
    control.patch({ peekAtCorners: true });
    const size = { width: control.bounds.width, height: control.bounds.height };
    for (const [x, corner] of [[12, 'left'], [1680, 'right']]) {
      dragTo(control, x, 780);
      assert.deepEqual(control.state().cornerDock, { corner, peeking: true });
      assert.deepEqual(control.broadcasts.at(-1).cornerDock, { corner, peeking: true });
      const snapped = control.bounds;
      control.moveCursor(snapped.x, snapped.y); control.drag('start');
      assert.equal(control.state().cornerDock.peeking, true, 'pressing without moving keeps the peek');
      control.drag('end');
      assert.deepEqual(control.bounds, snapped, 'a click does not move the fixed native surface');
      assert.equal(control.state().cornerDock.peeking, true);

      const writesBeforeDrag = control.writes.length;
      dragTo(control, 800, 500, false);
      assert.equal(control.state().cornerDock.peeking, false, 'the character expands before the pointer is released');
      assert.equal(control.broadcasts.at(-1).cornerDock.peeking, false);
      assert.deepEqual({ width: control.bounds.width, height: control.bounds.height }, size, 'peeking never resizes the native window');
      assert.equal(control.writes.length, writesBeforeDrag, 'pointer movement does not persist preferences');
      control.drag('end');
      assert.deepEqual(control.state().cornerDock, { corner: null, peeking: false });
      assert.deepEqual(control.bounds, { x: 800, y: 500, ...size });
    }
    dragTo(control, 800, 780);
    assert.deepEqual(control.state().cornerDock, { corner: null, peeking: false }, 'bottom edge centre stays fully visible');
    assert.deepEqual(control.bounds, { x: 800, y: 780, ...size });
    assert.equal(control.persisted.peekAtCorners, true);
  });

  test(`${variant.name}: window-contained corner peeking uses the host client area and preserves the desktop position`, async t => {
    const control = controller(variant); t.after(() => control.close());
    control.patch({ stayInCodexWindow: true, peekAtCorners: true }); await control.settle();
    const area = control.mode.getArea();
    const size = { width: control.bounds.width, height: control.bounds.height };
    const bottom = area.y + area.height - size.height;
    const right = area.x + area.width - size.width;
    for (const [x, corner] of [[area.x + 12, 'left'], [right - 12, 'right']]) {
      dragTo(control, x, bottom - 12);
      assert.deepEqual(control.state().cornerDock, { corner, peeking: true });
      assert.deepEqual(control.bounds, { x: corner === 'left' ? area.x : right, y: bottom, ...size });
      assert.deepEqual(control.persisted.position, desktopPosition);
      await control.poll(hostSnapshot({ windows: [{ ...hostSnapshot().windows[0], minimized: true }] }));
      assert.deepEqual(control.state().cornerDock, { corner, peeking: true }, 'minimizing retains the parked appearance');
      await control.poll(hostSnapshot());
      assert.deepEqual(control.state().cornerDock, { corner, peeking: true }, 'restoring does not unfold the body');
      const free = { x: area.x + (area.width - size.width) / 2, y: area.y + 50 };
      dragTo(control, free.x, free.y, false);
      assert.equal(control.state().cornerDock.peeking, false);
      control.drag('end');
      assert.deepEqual(control.state().cornerDock, { corner: null, peeking: false });
      assert.deepEqual(control.persisted.position, desktopPosition);
    }
    dragTo(control, area.x + (area.width - size.width) / 2, bottom - 12);
    assert.deepEqual(control.state().cornerDock, { corner: null, peeking: false });
    control.patch({ peekAtCorners: false });
    dragTo(control, area.x + 12, bottom - 12);
    assert.deepEqual(control.state().cornerDock, { corner: 'left', peeking: false });
    assert.deepEqual(control.persisted.position, desktopPosition);
  });

  for (const contained of [false, true]) {
    const modeLabel = contained ? 'inside the host' : 'on the desktop';
    const point = control => {
      const bounds = control.bounds, offset = control.state().visualPose.offset;
      return { x: bounds.x + offset.x, y: bounds.y + offset.y };
    };
    const near = (actual, expected, message) => {
      assert.ok(Math.abs(actual.x - expected.x) < 0.00001 && Math.abs(actual.y - expected.y) < 0.00001,
        `${message}: ${JSON.stringify(actual)} vs ${JSON.stringify(expected)}`);
    };
    test(`${variant.name}: both corner peeks clip the side and lower edge ${modeLabel}`, async t => {
      const control = controller(variant); t.after(() => control.close());
      control.patch({ stayInCodexWindow: contained, peekAtCorners: true }); await control.settle();
      const area = contained ? control.mode.getArea() : workArea;
      const size = { width: control.bounds.width, height: control.bounds.height };
      const bottom = area.y + area.height - size.height, right = area.x + area.width - size.width;
      for (const corner of ['left', 'right']) {
        const x = corner === 'left' ? area.x : right;
        dragTo(control, x + (corner === 'left' ? 12 : -12), bottom - 12);
        assert.deepEqual(control.bounds, { x, y: bottom, ...size });
        assert.deepEqual(control.state().cornerDock, { corner, peeking: true });
        const pose = control.state().visualPose;
        near(pose.offset, { x: (corner === 'left' ? -48 : 48) * size.width / 380, y: 56 * size.width / 380 }, 'two-axis parked offset');
        assert.equal(pose.moving, false);
        const held = point(control), parked = control.bounds;
        control.moveCursor(500, 500); control.drag('start');
        near(point(control), held, 'pointer down preserves the visual origin');
        control.drag('end'); control.advance(200);
        near(point(control), held, 'a click cannot unfold or jump the character');
        assert.deepEqual(control.bounds, parked);
      }
    });

    test(`${variant.name}: a peek follows downward and inward pointer motion continuously ${modeLabel}`, async t => {
      const control = controller(variant); t.after(() => control.close());
      control.patch({ stayInCodexWindow: contained, peekAtCorners: true }); await control.settle();
      const area = contained ? control.mode.getArea() : workArea;
      const size = { width: control.bounds.width, height: control.bounds.height };
      const bottom = area.y + area.height - size.height, right = area.x + area.width - size.width;
      for (const corner of ['left', 'right']) {
        const x = corner === 'left' ? area.x : right;
        dragTo(control, x + (corner === 'left' ? 12 : -12), bottom - 12);
        const from = point(control), beforeWrites = control.writes.length;
        control.moveCursor(500, 500); control.drag('start');
        for (const delta of [{ x: 0, y: 0 }, { x: 0, y: 5 }, { x: 0, y: 20 },
          { x: corner === 'left' ? -20 : 20, y: 40 },
          { x: corner === 'left' ? 130 : -130, y: -100 }]) {
          control.moveCursor(500 + delta.x, 500 + delta.y); control.drag('move');
          near(point(control), { x: from.x + delta.x, y: from.y + delta.y }, 'world origin follows the exact mouse delta');
          assert.equal(control.state().visualPose.moving, true);
          assert.equal(control.state().cornerDock.peeking, false);
          assert.equal(control.writes.length, beforeWrites, 'movement never persists settings');
          assert.deepEqual({ width: control.bounds.width, height: control.bounds.height }, size);
          assert.ok(control.bounds.x >= area.x && control.bounds.x <= right && control.bounds.y >= area.y && control.bounds.y <= bottom);
        }
        assert.ok(Math.abs(control.state().visualPose.offset.x) <= 0.5 && Math.abs(control.state().visualPose.offset.y) <= 0.5,
          'the fully pulled-out character naturally loses its clipping offset');
        control.drag('end');
        assert.equal(control.writes.length, beforeWrites + 1, 'release persists exactly once');
        control.advance(200);
        assert.deepEqual(control.state().cornerDock, { corner: null, peeking: false });
        assert.deepEqual(control.state().visualPose, { offset: { x: 0, y: 0 }, moving: false });
        assert.equal(control.writes.length, beforeWrites + 1, 'return animation does not write settings');
        if (contained) assert.deepEqual(control.persisted.position, desktopPosition);
      }
    });

    test(`${variant.name}: release near a bottom corner returns monotonically and a new drag cancels that return ${modeLabel}`, async t => {
      const control = controller(variant); t.after(() => control.close());
      control.patch({ stayInCodexWindow: contained, peekAtCorners: true }); await control.settle();
      const area = contained ? control.mode.getArea() : workArea;
      const size = { width: control.bounds.width, height: control.bounds.height };
      const bottom = area.y + area.height - size.height;
      const free = { x: area.x + 90, y: bottom - 80 };
      dragTo(control, free.x, free.y);
      control.moveCursor(free.x, free.y); control.drag('start');
      const nearCorner = { x: area.x + 20, y: bottom - 20 };
      control.moveCursor(nearCorner.x, nearCorner.y); control.drag('move');
      const beforeWrites = control.writes.length;
      control.drag('end');
      assert.equal(control.writes.length, beforeWrites + 1);
      near(point(control), nearCorner, 'release begins at the current visual position');
      assert.equal(control.state().visualPose.moving, true);
      let previous = point(control), frames = 0;
      for (let elapsed = 16; elapsed <= 192; elapsed += 16) {
        control.advance(16);
        const current = point(control);
        assert.ok(current.x <= previous.x + 0.00001 && current.y >= previous.y - 0.00001, 'return frames approach the corner without reversing');
        previous = current; frames++;
      }
      assert.ok(frames > 5);
      assert.deepEqual(control.state().cornerDock, { corner: 'left', peeking: true });
      assert.equal(control.state().visualPose.moving, false);
      near(point(control), { x: area.x - 48 * size.width / 380, y: bottom + 56 * size.width / 380 }, 'settled corner position');
      assert.equal(control.writes.length, beforeWrites + 1);

      dragTo(control, free.x, free.y);
      control.moveCursor(free.x, free.y); control.drag('start');
      control.moveCursor(nearCorner.x, nearCorner.y); control.drag('move'); control.drag('end');
      control.advance(64);
      const interrupted = point(control);
      control.moveCursor(900, 800); control.drag('start');
      near(point(control), interrupted, 'interrupting a return does not jump');
      control.advance(240);
      near(point(control), interrupted, 'the old animation remains cancelled while holding');
      control.moveCursor(940, 770); control.drag('move');
      near(point(control), { x: interrupted.x + 40, y: interrupted.y - 30 }, 'the replacement drag starts at the interrupted pose');
      control.drag('end'); control.advance(200);
      assert.deepEqual({ width: control.bounds.width, height: control.bounds.height }, size);
    });

    test(`${variant.name}: the 32 DIP corner zone controls release and settings cancel an older return ${modeLabel}`, async t => {
      const control = controller(variant); t.after(() => control.close());
      control.patch({ stayInCodexWindow: contained, peekAtCorners: true }); await control.settle();
      const area = contained ? control.mode.getArea() : workArea;
      const bottom = area.y + area.height - control.bounds.height;
      for (const [distance, peeking] of [[31, true], [32, false], [80, false]]) {
        const beforeWrites = control.writes.length;
        dragTo(control, area.x + distance, bottom - distance);
        assert.equal(control.state().cornerDock.peeking, peeking);
        assert.equal(control.writes.length, beforeWrites + 1);
        if (!peeking) {
          assert.deepEqual({ x: control.bounds.x, y: control.bounds.y }, { x: area.x + distance, y: bottom - distance });
          assert.deepEqual(control.state().visualPose.offset, { x: 0, y: 0 });
        }
      }
      const origin = point(control);
      control.moveCursor(origin.x, origin.y); control.drag('start');
      control.moveCursor(area.x + 20, bottom - 20); control.drag('move'); control.drag('end');
      control.advance(48);
      assert.equal(control.state().visualPose.moving, true);
      control.patch({ peekAtCorners: false });
      const afterSettings = control.bounds;
      assert.deepEqual(control.state().visualPose, { offset: { x: 0, y: 0 }, moving: false });
      control.advance(240);
      assert.deepEqual(control.bounds, afterSettings, 'cancelled frames cannot move the new settings state');
      assert.equal(control.state().cornerDock.peeking, false);
    });
  }

  for (const [change, updatedBounds] of [
    ['moves', { ...hostBounds, x: hostBounds.x + 100, y: hostBounds.y + 60 }],
    ['shrinks', { ...hostBounds, width: hostBounds.width - 100, height: hostBounds.height - 80 }],
    ['expands', { ...hostBounds, width: hostBounds.width + 100, height: hostBounds.height + 80 }],
  ]) {
    test(`${variant.name}: a held peek rebases after its host ${change} without swallowing the next mouse delta`, async t => {
      const control = controller(variant); t.after(() => control.close());
      control.patch({ stayInCodexWindow: true, peekAtCorners: true }); await control.settle();
      const initialArea = control.mode.getArea();
      const point = () => {
        const offset = control.state().visualPose.offset;
        return { x: control.bounds.x + offset.x, y: control.bounds.y + offset.y };
      };
      dragTo(control, initialArea.x + initialArea.width - control.bounds.width - 12,
        initialArea.y + initialArea.height - control.bounds.height - 12);
      control.moveCursor(500, 500); control.drag('start');
      control.moveCursor(505, 497); control.drag('move');
      const beforeWrites = control.writes.length;
      await control.poll(hostSnapshot({ windows: [{ ...hostSnapshot().windows[0], bounds: updatedBounds }] }));
      const movedWithHost = point();
      control.moveCursor(506, 495); control.drag('move');
      const after = point();
      assert.ok(Math.abs(after.x - movedWithHost.x - 1) < 0.00001 && Math.abs(after.y - movedWithHost.y + 2) < 0.00001,
        'the next pointer event adds its 1,-2 DIP delta to the composed host position');
      assert.equal(control.writes.length, beforeWrites);
      control.drag('end'); control.advance(200);
      assert.deepEqual(control.state().cornerDock, { corner: 'right', peeking: true });
      assert.equal(control.writes.length, beforeWrites + 1);
      assert.deepEqual(control.persisted.position, desktopPosition);
      assert.deepEqual({ width: control.bounds.width, height: control.bounds.height }, { width: 228, height: 288 });

      // With no intervening move, pointer-up also needs the new host geometry;
      // otherwise a click alone unfolds the corner using its old screen point.
      const before = point();
      control.moveCursor(700, 600); control.drag('start');
      const shifted = { ...updatedBounds, x: updatedBounds.x + 75 };
      await control.poll(hostSnapshot({ windows: [{ ...hostSnapshot().windows[0], bounds: shifted }] }));
      const held = point();
      assert.ok(Math.abs(held.x - before.x - 75) < 0.00001);
      control.drag('end'); control.advance(200);
      assert.deepEqual(control.state().cornerDock, { corner: 'right', peeking: true });
      assert.ok(Math.abs(point().x - held.x) < 0.00001 && Math.abs(point().y - held.y) < 0.00001,
        'releasing a stationary hold leaves the moved corner unchanged');
    });
  }

  test(`${variant.name}: minimizing and restoring a held peek preserves its pose and rebases a moved host`, async t => {
    const control = controller(variant); t.after(() => control.close());
    control.patch({ stayInCodexWindow: true, peekAtCorners: true }); await control.settle();
    const area = control.mode.getArea();
    dragTo(control, area.x + 12, area.y + area.height - control.bounds.height - 12);
    const point = () => {
      const offset = control.state().visualPose.offset;
      return { x: control.bounds.x + offset.x, y: control.bounds.y + offset.y };
    };
    const parked = point();
    control.moveCursor(500, 500); control.drag('start');
    await control.poll(hostSnapshot({ windows: [{ ...hostSnapshot().windows[0], minimized: true,
      bounds: { ...hostBounds, x: -32000, y: -32000 } }] }));
    control.advance(250);
    assert.deepEqual(point(), parked, 'minimized coordinates do not change the held pose');
    const restoredBounds = { ...hostBounds, x: hostBounds.x + 100, y: hostBounds.y + 50 };
    await control.poll(hostSnapshot({ windows: [{ ...hostSnapshot().windows[0], bounds: restoredBounds }] }));
    const restored = point();
    assert.ok(Math.abs(restored.x - parked.x - 100) < 0.00001 && Math.abs(restored.y - parked.y - 50) < 0.00001);
    control.moveCursor(502, 501); control.drag('move');
    assert.ok(Math.abs(point().x - restored.x - 2) < 0.00001 && Math.abs(point().y - restored.y - 1) < 0.00001);
    control.drag('end'); control.advance(200);
    assert.deepEqual(control.state().cornerDock, { corner: 'left', peeking: true });
    assert.deepEqual(control.persisted.position, desktopPosition);
  });

  test(`${variant.name}: contained dragging mirrors in the left half before snapping or releasing`, async t => {
    const control = controller(variant); t.after(() => control.close());
    control.patch({ stayInCodexWindow: true }); await control.settle();
    const area = control.mode.getArea();
    const writesBeforeDrag = control.writes.length;
    const dragTo = x => {
      const before = control.bounds;
      control.moveCursor(before.x, before.y); control.drag('start');
      control.moveCursor(x, before.y); control.drag('move');
    };
    dragTo(200);
    assert.ok(control.bounds.x > area.x + 32, 'the left-half position is outside the left snap zone');
    assert.ok(control.bounds.x + control.bounds.width / 2 < area.x + area.width / 2);
    assert.equal(control.state().settings.mirror, true, 'mirror while still dragging');
    assert.equal(control.broadcasts.at(-1).settings.mirror, true, 'renderer sees the orientation immediately');
    assert.equal(control.writes.length, writesBeforeDrag, 'drag moves do not write preferences');
    control.drag('end');
    assert.equal(control.bounds.x, 200, 'orientation does not require a snap to the edge');
    assert.equal(control.persisted.mirror, true);
    assert.deepEqual(control.persisted.position, desktopPosition);

    const writesBeforeReturn = control.writes.length;
    dragTo(350);
    assert.ok(control.bounds.x + control.bounds.width / 2 > area.x + area.width / 2);
    assert.equal(control.state().settings.mirror, false, 'return to the right half while still dragging');
    assert.equal(control.broadcasts.at(-1).settings.mirror, false);
    assert.equal(control.writes.length, writesBeforeReturn);
    control.drag('end');
    assert.equal(control.bounds.x, 350);
    assert.equal(control.persisted.mirror, false);
    assert.deepEqual(control.persisted.position, desktopPosition);
  });

  test(`${variant.name}: contained orientation follows host coordinates across host moves and size changes`, async t => {
    const control = controller(variant); t.after(() => control.close());
    control.patch({ stayInCodexWindow: true }); await control.settle();
    const dragTo = x => {
      const before = control.bounds;
      control.moveCursor(before.x, before.y); control.drag('start');
      control.moveCursor(x, before.y); control.drag('move'); control.drag('end');
    };
    dragTo(200);
    assert.equal(control.state().settings.mirror, true);
    const movedHost = { ...hostSnapshot().windows[0], bounds: { ...hostBounds, x: 1100 } };
    await control.poll(hostSnapshot({ windows: [movedHost] }));
    assert.ok(control.bounds.x > workArea.width / 2, 'host now lies on the desktop right');
    assert.equal(control.state().settings.mirror, true, 'its left half remains mirrored');
    control.patch({ scale: 1.25 }); await control.settle();
    assert.equal(control.bounds.width, 285);
    assert.equal(control.state().settings.mirror, true);

    dragTo(1280);
    assert.equal(control.state().settings.mirror, false);
    const leftHost = { ...movedHost, bounds: { ...hostBounds, x: -800 } };
    await control.poll(hostSnapshot({ windows: [leftHost] }));
    assert.ok(control.bounds.x < 0, 'host moves to a monitor left of the primary display');
    assert.equal(control.state().settings.mirror, false, 'its right half keeps the original orientation');
    control.patch({ scale: 1.5 }); await control.settle();
    assert.equal(control.bounds.width, 342);
    assert.equal(control.state().settings.mirror, false);
    assert.deepEqual(control.persisted.position, desktopPosition);
  });

  test(`${variant.name}: enabling via settings IPC contains drag moves and preserves the independent position`, async t => {
    const control = controller(variant); t.after(() => control.close());
    assert.equal(control.state().windowContainment.enabled, false);
    const enabled = control.patch({ stayInCodexWindow: true });
    assert.equal(enabled.settings.stayInCodexWindow, true);
    assert.equal(enabled.windowContainment.enabled, true);
    assert.equal(control.persisted.stayInCodexWindow, true);
    await flush();
    assert.equal(control.state().windowContainment.reason, 'contained');
    assert.equal(control.visible, true); assert.equal(control.top, false);
    assert.deepEqual(control.bounds, { x: 470, y: 310, width: 228, height: 288 });
    for (const cursor of [{ x: -5000, y: -5000 }, { x: 5000, y: 5000 }]) {
      control.drag('start'); control.moveCursor(cursor.x, cursor.y); control.drag('move'); control.drag('end');
      const bounds = control.bounds;
      assert.ok(bounds.x >= 102 && bounds.y >= 102);
      assert.ok(bounds.x + bounds.width <= 698 && bounds.y + bounds.height <= 598);
      assert.equal(bounds.width, 228); assert.equal(bounds.height, 288);
      assert.deepEqual(control.persisted.position, desktopPosition);
      assert.deepEqual(control.state().settings.position, desktopPosition);
    }
    assert.ok(control.calls.some(value => value.kind === 'above' && value.value === 'window:41:0'));
    assert.ok(control.writes.every(value => value.stayInCodexWindow && value.position.x === desktopPosition.x && value.position.y === desktopPosition.y));
  });

  for (const alwaysOnTop of [true, false]) {
    test(`${variant.name}: disabling restores desktop position and alwaysOnTop=${alwaysOnTop}`, async t => {
      const control = controller(variant, { settings: { alwaysOnTop } }); t.after(() => control.close());
      control.patch({ stayInCodexWindow: true }); await flush();
      control.drag('start'); control.moveCursor(-1000, -1000); control.drag('move'); control.drag('end');
      const disabled = control.patch({ stayInCodexWindow: false }); await flush();
      assert.equal(disabled.windowContainment.enabled, false);
      assert.deepEqual(control.bounds, { ...desktopPosition, width: 228, height: 288 });
      assert.equal(control.top, alwaysOnTop); assert.equal(control.visible, true);
      assert.equal(control.provider.closes, 1);
      assert.deepEqual(control.persisted.position, desktopPosition);
    });
  }

  test(`${variant.name}: explicit hide, IPC/MCP action and tray hide remain hidden during successful polls`, async t => {
    const control = controller(variant); t.after(() => control.close());
    control.patch({ stayInCodexWindow: true }); await flush();
    for (const hide of [() => control.hide(), () => control.action('hide'),
      async () => assert.deepEqual(await control.controlAction('hide'), { status: 200, body: { ok: true } }),
      () => control.menu('隐藏挂件').click()]) {
      await hide();
      assert.equal(control.state().windowContainment.manualHidden, true);
      assert.equal(control.visible, false);
      await control.poll(); await control.poll();
      assert.equal(control.visible, false);
      assert.equal(control.state().windowContainment.reason, 'manual-hidden');
      control.action('show'); await control.settle(); assert.equal(control.visible, true);
    }
    control.action('hide'); control.patch({ stayInCodexWindow: false });
    assert.equal(control.visible, false);
    control.patch({ stayInCodexWindow: true }); await flush();
    assert.equal(control.visible, false, 'mode changes must preserve an explicit hide');
  });

  test(`${variant.name}: first enabling contained mode preserves an earlier standalone hide until explicit show`, async t => {
    const control = controller(variant); t.after(() => control.close());
    assert.equal(control.mode, undefined);
    control.action('hide');
    assert.equal(control.visible, false);
    control.patch({ stayInCodexWindow: true }); await flush();
    assert.equal(control.state().windowContainment.enabled, true);
    assert.equal(control.state().windowContainment.manualHidden, true);
    await control.poll(); await control.poll();
    assert.equal(control.visible, false);
    assert.equal(control.state().windowContainment.reason, 'manual-hidden');
    control.action('show');
    await control.settle();
    assert.equal(control.state().windowContainment.manualHidden, false);
    assert.equal(control.state().windowContainment.reason, 'contained');
    assert.equal(control.visible, true);
    assert.deepEqual(control.persisted.position, desktopPosition);
  });

  test(`${variant.name}: missing, inactive or undersized host cannot escape through dragging or explicit show`, async t => {
    const control = controller(variant); t.after(() => control.close());
    control.patch({ stayInCodexWindow: true }); await flush();
    for (const snapshot of [hostSnapshot({ windows: [], foregroundWindow: '0' }),
      hostSnapshot({ foregroundWindow: '0', foregroundPid: 200, windows: [{ ...hostSnapshot().windows[0], foreground: false }] }),
      hostSnapshot({ windows: [{ ...hostSnapshot().windows[0], bounds: { ...hostBounds, width: 100, height: 100 } }] })]) {
      await control.poll(snapshot); assert.equal(control.visible, false);
      const savedPosition = control.persisted.position;
      control.drag('start'); control.moveCursor(5000, 5000); control.drag('move'); control.drag('end');
      control.action('show');
      assert.equal(control.visible, false); assert.deepEqual(control.persisted.position, savedPosition);
    }
    await control.poll(hostSnapshot()); assert.equal(control.visible, true);
  });

  test(`${variant.name}: older settings default the mode off and preserve other preferences through persistence`, async t => {
    const preferences = { sizeBaseline: 2, scale: 1.2, opacity: 0.7, alwaysOnTop: false, sound: false, showBubble: false,
      mode: 'phrase', phrases: ['isolated custom phrase'], bucketId: 'fixture-bucket', refreshSeconds: 120, activeCharacterId: 'lilac-dragon' };
    const control = controller(variant, { settings: preferences }); t.after(() => control.close());
    assert.equal(control.state().settings.stayInCodexWindow, false);
    assert.equal(control.mode, undefined);
    for (const [key, value] of Object.entries(preferences)) assert.deepEqual(control.state().settings[key], value);
    assert.throws(() => control.foreignPatch({ stayInCodexWindow: true }), /无效窗口/);
    assert.equal(control.writes.length, 0);
    control.menu('仅在 Codex 窗口内显示').click({ checked: true }); await flush();
    for (const [key, value] of Object.entries(preferences)) assert.deepEqual(control.persisted[key], value);
    control.patch({ stayInCodexWindow: false, position: { x: 1, y: 1 }, characterPath: '/untrusted/private' });
    assert.deepEqual(control.persisted.position, desktopPosition);
    assert.equal(control.persisted.characterPath, '');
    assert.deepEqual(control.bounds, { ...desktopPosition, width: 274, height: 346 });
    const reloaded = controller(variant, { settings: control.persisted }); t.after(() => reloaded.close());
    assert.equal(reloaded.state().settings.stayInCodexWindow, false);
    assert.deepEqual(reloaded.state().settings.phrases, preferences.phrases);
    assert.deepEqual(reloaded.state().settings.position, desktopPosition);
  });
}
