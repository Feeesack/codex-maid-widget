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
const primary = { x: 0, y: 0, width: 1920, height: 1080 };
const left = { x: -1280, y: -120, width: 1280, height: 1024 };

// Run the production IPC controller, but keep every data-home/settings/fs
// dependency injected. No runtime module can read the host's user profile.
// The fake window deliberately adds one DIP on position-only updates to model
// the fractional-DPI round-trip feedback; real native verification is separate.
function controller(variant, options = {}) {
  const fakeHome = path.join(projectRoot, 'tmp', 'isolated-main-drag', variant.name);
  const fakeSettingsFile = path.join(fakeHome, 'settings.json');
  const writes = [], calls = [], displayInputs = [], broadcasts = [], timers = new Map();
  let timerId = 0, now = 10000;
  const FakeDate = class extends Date { static now() { return now; } };
  const clock = {
    setTimeout(callback, delay = 0) { const id = ++timerId; timers.set(id, { callback, delay, due: now + delay }); return id; },
    clearTimeout(id) { timers.delete(id); }, setInterval() { return ++timerId; }, clearInterval() {},
  };
  function advance(milliseconds) {
    const until = now + milliseconds;
    for (let steps = 0; steps < 256; steps++) {
      const next = [...timers.entries()].filter(([, value]) => value.delay <= 40 && value.due <= until)
        .sort((a, b) => a[1].due - b[1].due || a[0] - b[0])[0];
      if (!next) { now = until; return; }
      const [id, value] = next; timers.delete(id); now = Math.max(now, value.due); value.callback();
    }
    throw new Error('Short timer failed to settle');
  }
  const noFilesystem = new Proxy({
    mkdirSync(file) { assert.equal(file, fakeHome); },
  }, { get(target, key) {
    if (Object.hasOwn(target, key)) return target[key];
    throw new Error('Unexpected filesystem access: ' + String(key));
  } });
  const i18nContext = {module:{exports:{}}};
  vm.runInNewContext(fs.readFileSync(path.join(variant.root, 'src', 'i18n.js'), 'utf8'), i18nContext);
  const i18n = i18nContext.module.exports;
  const geometryContext = {
    module: { exports: {} },
    require(name) {
      if (name === './i18n.js') return i18n;
      if (name === 'node:fs') return noFilesystem;
      if (name === 'node:path') return path;
      if (name === './interaction-sound-catalog.js') return require(path.join(variant.root, 'src', 'interaction-sound-catalog.js'));
      throw new Error('Unexpected settings module: ' + name);
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(variant.root, 'src', 'settings.cjs'), 'utf8'), geometryContext);
  const geometry = geometryContext.module.exports;
  const initial = geometry.sanitize({ scale: 1, followCodex: false, ...options.settings });
  let bounds = { x: 200, y: 180, ...geometry.widgetDimensions(initial.scale), ...options.bounds };
  let cursor = { x: 400, y: 300 };
  let nativeSizeError = options.nativeSizeError || 0;
  const widget = {
    getNativeWindowHandle: () => '12345', isVisible: () => true, hide() {},
    webContents: { send(name, value) { if (name === 'state') broadcasts.push(JSON.parse(JSON.stringify(value))); } }, isDestroyed: () => false,
    getPosition: () => [bounds.x, bounds.y], getBounds: () => ({ ...bounds }),
    setPosition(x, y) {
      calls.push({ kind: 'position', x, y });
      bounds = { x, y, width: bounds.width + 1, height: bounds.height + 1 };
    },
    setBounds(value) {
      calls.push({ kind: 'bounds', ...value });
      bounds = { ...bounds, ...value };
      if (Object.hasOwn(value, 'width')) bounds.width += nativeSizeError;
      if (Object.hasOwn(value, 'height')) bounds.height += nativeSizeError;
    },
    setIgnoreMouseEvents() {}, setAlwaysOnTop() {}, setOpacity() {}, show() {}, moveTop() {},
  };
  const settingsWindow = { setTitle() {}, webContents: { send() {} }, isDestroyed: () => false };
  const ipcMain = new EventEmitter();
  const handlers = new Map();
  ipcMain.handle = (name, callback) => handlers.set(name, callback);
  const app = new EventEmitter();
  Object.assign(app, { isPackaged: false, setName() {}, setPath() {}, getPath: () => fakeHome,
    getVersion: () => 'test', requestSingleInstanceLock: () => false, quit() {} });
  function isolatedModule(file, dependencies = {}) {
    const loaded = { exports: {} };
    vm.runInNewContext(fs.readFileSync(path.join(variant.root, 'src', file), 'utf8'), {
      module: loaded, Date: FakeDate, ...clock, process: { platform: variant.platform },
      require(name) { if (Object.hasOwn(dependencies, name)) return dependencies[name]; throw new Error('Unexpected isolated window module: ' + name); },
    }, { filename: file }); return loaded.exports;
  }
  const windowModeModule = isolatedModule('window-mode.cjs', {
    './window-containment.cjs': isolatedModule('window-containment.cjs'), './window-visibility.cjs': isolatedModule('window-visibility.cjs'),
    './window-topmost.cjs': isolatedModule('window-topmost.cjs'),
    './codex-window.cjs': { CodexWindowProvider: class { constructor() { throw new Error('Native provider must remain isolated'); } } },
  });
  const modules = {
    electron: { app, ipcMain, screen: {
      getCursorScreenPoint: () => ({ ...cursor }),
      getPrimaryDisplay: () => ({ workArea: primary }),
      getDisplayMatching(value) {
        displayInputs.push({ ...value });
        const overlap = area => Math.max(0, Math.min(value.x + value.width, area.x + area.width) - Math.max(value.x, area.x)) *
          Math.max(0, Math.min(value.y + value.height, area.y + area.height) - Math.max(value.y, area.y));
        return { workArea: overlap(left) > overlap(primary) ? left : primary };
      },
    } },
    'node:fs': noFilesystem,
    'node:path': path,
    'node:http': {}, 'node:crypto': {}, 'node:os': {}, 'node:child_process': {},
    './i18n.js': i18n, './settings.cjs': { ...geometry,
      readSettings(file) { assert.equal(file, fakeSettingsFile); return initial; },
      writeSettings(file, value) { assert.equal(file, fakeSettingsFile); writes.push(JSON.parse(JSON.stringify(value))); },
    },
    './window-mode.cjs': { CodexWindowMode: class extends windowModeModule.CodexWindowMode {
      constructor(value) { super({ ...value, platform: variant.platform, topmostProviderFactory: () => ({
        async setTopmost(_handle, enabled) { return { known: true, ok: true, topmost: enabled }; }, close() {},
      }) }); }
    } },
    './data-home.cjs': { prepareDataHome: () => fakeHome },
    './character-library.cjs': {}, './codex-data.cjs': {}, './codex-desktop.cjs': {},
    './auth-change-watch.cjs': {}, './windows-launch.cjs': {}, './macos-launch.cjs': {},
    './platform.cjs': { supportsDesktopFollow: () => false }, './desktop-observation.cjs': {},
  };
  const context = {
    require(name) {
      if (Object.hasOwn(modules, name)) return modules[name];
      throw new Error('Unexpected controller module: ' + name);
    },
    process: { platform: variant.platform, argv: [], env: {}, execPath: path.join(fakeHome, 'widget') },
    __dirname: path.join(variant.root, 'src'), module: { exports: {} },
    ...clock, Date: FakeDate,
    __widget: widget, __settingsWindow: settingsWindow,
    __library: { defaultId: 'lilac-dragon', list: () => [{ id: 'lilac-dragon', available: true }] },
  };
  const source = fs.readFileSync(path.join(variant.root, 'src', 'main.cjs'), 'utf8');
  vm.runInNewContext(source + '\nwidget = __widget; settingsWindow = __settingsWindow; library = __library; setupIpc();\n' +
    'module.exports = { getSettings() { return settings; }, resetPosition, applyWindowSettings, state };', context, { filename: 'main.cjs' });
  return { calls, writes, displayInputs, broadcasts, advance,
    get bounds() { return { ...bounds }; },
    get settings() { return JSON.parse(JSON.stringify(context.module.exports.getSettings())); },
    state() { return JSON.parse(JSON.stringify(context.module.exports.state())); },
    moveCursor(x, y) { cursor = { x, y }; },
    emit(name, sender = widget.webContents) { ipcMain.emit('drag-' + name, { sender }); },
    patch(value) { return handlers.get('settings')({ sender: settingsWindow.webContents }, value); },
    nativeError(value) { nativeSizeError = value; },
    drift(value) { bounds = { ...bounds, ...value }; },
    reset: context.module.exports.resetPosition,
    apply: context.module.exports.applyWindowSettings,
    settingsSender: settingsWindow.webContents,
  };
}

for (const variant of variants) {
  for (const scale of [0.6, 1, 1.6]) {
    test(`${variant.name}: 600 drag moves keep preferred dimensions at scale ${scale}`, () => {
      const control = controller(variant, { settings: { scale } });
      const expected = { width: Math.round(228 * scale), height: Math.round(288 * scale) };
      control.emit('start');
      for (let index = 0; index < 600; index++) {
        const dx = index % 173, dy = index % 97;
        control.moveCursor(400 + dx, 300 + dy);
        control.emit('move');
        assert.deepEqual(control.bounds, { x: 200 + dx, y: 180 + dy, ...expected });
      }
      control.emit('end');
      assert.equal(control.calls.filter(call => call.kind === 'position').length, 0);
      assert.equal(control.writes.length, 1);
      assert.deepEqual(control.writes[0].position, { x: control.bounds.x, y: control.bounds.y });
      assert.equal(control.writes[0].scale, scale);
      const stopped = control.bounds;
      control.moveCursor(800, 700); control.emit('move'); control.emit('end');
      assert.deepEqual(control.bounds, stopped, 'ended drags must not accept further movement');
      assert.equal(control.writes.length, 1);
    });

    test(`${variant.name}: clipped corner drag conserves the pointer world point with native rounding at scale ${scale}`, () => {
      const width = Math.round(228 * scale), height = Math.round(288 * scale);
      for (const corner of ['left', 'right']) {
        const parked = { x: corner === 'left' ? 0 : primary.width - width, y: primary.height - height };
        const control = controller(variant, { settings: { scale, peekAtCorners: true }, bounds: parked, nativeSizeError: 1 });
        const world = () => {
          const pose = control.state().visualPose.offset;
          return { x: control.bounds.x + pose.x, y: control.bounds.y + pose.y };
        };
        const origin = world();
        assert.ok(corner === 'left' ? origin.x < parked.x : origin.x > parked.x, 'the side is clipped while parked');
        assert.ok(origin.y > parked.y, 'the lower body is clipped while parked');
        control.emit('start');
        assert.deepEqual(world(), origin, 'pressing does not pre-emptively unfold');
        const direction = corner === 'left' ? 1 : -1;
        for (let index = 0; index < 100; index++) {
          // Include dragging down farther behind the edge before pulling back
          // inside; the native surface clamps but the visual origin must not.
          const dx = index < 30 ? -direction * index / 3 : direction * (index - 30) * 2;
          const dy = index < 30 ? index * 2 : 60 - (index - 30) * 3;
          control.moveCursor(400 + dx, 300 + dy); control.emit('move');
          const actual = world();
          assert.ok(Math.abs(actual.x - origin.x - dx) < 0.00001 && Math.abs(actual.y - origin.y - dy) < 0.00001,
            'native position plus visual offset follows the cursor without a release jump');
          assert.equal(control.writes.length, 0);
          const last = control.calls.at(-1);
          assert.equal(last.width, width, 'preferred width is independent of native rounded width');
          assert.equal(last.height, height, 'preferred height is independent of native rounded height');
        }
        control.emit('end');
        assert.equal(control.writes.length, 1);
        control.advance(200);
        assert.equal(control.state().visualPose.moving, false);
        assert.deepEqual(control.state().visualPose.offset, { x: 0, y: 0 });
        assert.equal(control.state().cornerDock.peeking, false, 'release away from a bottom corner keeps the full body');
        assert.equal(control.writes.length, 1, 'return frames must not add disk writes');
        assert.ok(control.calls.every(call => call.kind === 'bounds' && call.width === width && call.height === height));
      }
    });
  }

  test(`${variant.name}: end-of-drag snapping ignores native size rounding`, () => {
    const control = controller(variant, { bounds: { x: 1680, y: 780 }, nativeSizeError: 1 });
    control.emit('start');
    control.emit('move');
    assert.deepEqual(control.bounds, { x: 1680, y: 780, width: 229, height: 289 });
    control.emit('end');
    assert.ok(control.displayInputs.some(value => value.x === 1680 && value.y === 780 && value.width === 228 && value.height === 288));
    assert.deepEqual(control.displayInputs.at(-1), { x: 1692, y: 792, width: 228, height: 288 });
    assert.deepEqual(control.calls.at(-1), { kind: 'bounds', x: 1692, y: 792, width: 228, height: 288 });
    assert.deepEqual(control.settings.position, { x: 1692, y: 792 });
    assert.equal(control.settings.mirror, false);
  });

  test(`${variant.name}: drag-end recovers an already enlarged native window`, () => {
    const control = controller(variant, { bounds: { x: 1680, y: 780, width: 550, height: 650 } });
    control.emit('start'); control.emit('end');
    assert.deepEqual(control.bounds, { x: 1692, y: 792, width: 228, height: 288 });
    assert.deepEqual(control.writes[0].position, { x: 1692, y: 792 });
    assert.equal(control.writes[0].scale, 1);
  });

  test(`${variant.name}: left-half mirroring on a negative-coordinate display does not magnetize the top edge`, () => {
    const control = controller(variant);
    control.emit('start');
    control.moveCursor(-1060, 15); control.emit('move');
    assert.deepEqual(control.bounds, { x: -1260, y: -105, width: 228, height: 288 });
    control.emit('end');
    assert.deepEqual(control.bounds, { x: -1260, y: -105, width: 228, height: 288 });
    assert.equal(control.settings.mirror, true);
    assert.deepEqual(control.settings.position, { x: -1260, y: -105 });
  });

  test(`${variant.name}: crossing the screen centre flips during dragging without edge snapping or extra saves`, () => {
    const control = controller(variant, { bounds: { x: 1100, y: 180 } });
    control.emit('start');
    control.moveCursor(-300, 300); control.emit('move');
    assert.equal(control.bounds.x, 400);
    assert.equal(control.settings.mirror, true);
    assert.equal(control.writes.length, 0);
    control.moveCursor(600, 300); control.emit('move');
    assert.equal(control.bounds.x, 1300);
    assert.equal(control.settings.mirror, false);
    control.moveCursor(-100, 300); control.emit('move'); control.emit('end');
    assert.equal(control.bounds.x, 600);
    assert.equal(control.settings.mirror, true);
    assert.equal(control.writes.length, 1);
    assert.equal(control.writes[0].mirror, true);
    assert.equal(control.bounds.width, 228);
  });

  test(`${variant.name}: left/right halves use the current negative-coordinate monitor`, () => {
    const control = controller(variant, { bounds: { x: -1100, y: 180 } });
    control.emit('start'); control.emit('move');
    assert.equal(control.settings.mirror, true);
    control.moveCursor(1100, 300); control.emit('move');
    assert.equal(control.bounds.x, -400);
    assert.equal(control.settings.mirror, false);
  });

  test(`${variant.name}: a scale change is honored by the next drag update`, () => {
    const control = controller(variant);
    control.emit('start');
    control.moveCursor(440, 330); control.emit('move');
    control.patch({ scale: 1.35 });
    control.moveCursor(500, 400); control.emit('move'); control.emit('end');
    assert.deepEqual(control.bounds, { x: 300, y: 280, width: 308, height: 389 });
    assert.equal(control.settings.scale, 1.35);
    assert.deepEqual(control.writes.at(-1).position, { x: 300, y: 280 });
    control.drift({ width: 550, height: 650 }); control.apply();
    assert.equal(control.bounds.width, 308);
    assert.equal(control.bounds.height, 389);
    control.reset();
    assert.deepEqual(control.bounds, { x: 1612, y: 691, width: 308, height: 389 });
  });

  test(`${variant.name}: only the widget can start, move or end a drag`, () => {
    const control = controller(variant);
    for (const sender of [{}, control.settingsSender]) {
      control.emit('start', sender); control.moveCursor(600, 500);
      control.emit('move', sender); control.emit('end', sender);
    }
    control.emit('move'); control.emit('end');
    assert.equal(control.calls.length, 0);
    assert.equal(control.writes.length, 0);
    control.emit('start');
    control.moveCursor(640, 520);
    control.emit('move', {}); control.emit('end', control.settingsSender);
    assert.equal(control.calls.length, 0);
    control.emit('move'); control.emit('end');
    assert.deepEqual(control.bounds, { x: 240, y: 200, width: 228, height: 288 });
    assert.equal(control.writes.length, 1, 'foreign drag-end must not clear the real drag');
  });

  test(`${variant.name}: click-through blocks starting a drag`, () => {
    const control = controller(variant, { settings: { clickThrough: true } });
    control.emit('start'); control.moveCursor(800, 700); control.emit('move'); control.emit('end');
    assert.deepEqual(control.bounds, { x: 200, y: 180, width: 228, height: 288 });
    assert.equal(control.calls.length, 0);
    assert.equal(control.writes.length, 0);
  });
}
