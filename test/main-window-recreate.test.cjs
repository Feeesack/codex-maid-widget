'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

const projectRoot = path.join(__dirname, '..');
const variants = [
  { name: 'Windows', root: projectRoot },
  { name: 'macOS', root: path.join(projectRoot, 'macos') },
];
const flush = () => new Promise(resolve => setImmediate(resolve));
const plain = value => JSON.parse(JSON.stringify(value));

// Execute the production surface lifecycle functions, without booting main.cjs.
// There is no filesystem/profile/data-home/native-provider dependency in this VM;
// even an accidental require fails. Renderer promises and OS destruction remain
// independently controllable so a disappearing child can abort its initial load.
function harness(variant, { manuallyHidden = false, deferredLoads = false } = {}) {
  const sourceText = fs.readFileSync(path.join(variant.root, 'src', 'main.cjs'), 'utf8');
  const start = sourceText.indexOf('function rebuildWidget() {');
  const end = sourceText.indexOf('\nfunction action(', start);
  assert.ok(start > 0 && end > start, 'production widget lifecycle functions must be present');
  const show = sourceText.match(/^function show\(\) \{.*\}$/m)?.[0];
  const hide = sourceText.match(/^function hide\(\) \{.*\}$/m)?.[0];
  const poseStart = sourceText.indexOf('function cancelPose('), poseEnd = sourceText.indexOf('\nfunction poseArea(', poseStart);
  assert.ok(poseStart > 0 && poseEnd > poseStart, 'exercise the production pose cancellation function');
  assert.ok(show && hide, 'exercise the production manual visibility functions');
  const windows = [], modes = [], writes = [], broadcasts = [], configured = [];
  let quitCalls = 0, codexDestroyCalls = 0, stalePoseCalls = 0, timerId = 0;
  const poseTimers = new Map();
  const settings = { stayInCodexWindow: true, activeCharacterId: 'imported-character',
    position: { x: 423, y: 217 }, scale: 1, alwaysOnTop: true, opacity: 0.8,
    clickThrough: false, mirror: true, followCodex: false };
  const backend = { marker: 'live quota source', close() { assert.fail('surface recreation must retain the source'); } };
  const tray = { marker: 'existing tray', destroy() { assert.fail('surface recreation must retain the tray'); } };
  const control = { marker: 'existing MCP/control endpoint', close() { assert.fail('surface recreation must retain control'); } };
  const library = { marker: 'existing character library' };
  const settingsWindow = { marker: 'existing settings window', isDestroyed: () => false };
  const host = { destroy() { codexDestroyCalls++; } };
  let context;
  class FakeWindow extends EventEmitter {
    constructor(options) {
      super(); this.options = options; this.destroyed = false; this.visible = false; this.destroyCalls = 0;
      this.bounds = { x: 0, y: 0, width: options.width, height: options.height };
      this.webContents = new EventEmitter();
      this.webContents.setWindowOpenHandler = callback => { this.openHandler = callback; };
      this.webContents.session = { setPermissionRequestHandler: callback => { this.permissionHandler = callback; } };
      this.loadPromise = new Promise((resolve, reject) => { this.resolveLoad = resolve; this.rejectLoad = reject; });
      windows.push(this);
    }
    isDestroyed() { return this.destroyed; }
    isVisible() { return this.visible && !this.destroyed; }
    setBounds(bounds) { assert.equal(this.destroyed, false); this.bounds = { ...bounds }; }
    getBounds() { return { ...this.bounds }; }
    show() { assert.equal(this.destroyed, false); this.visible = true; }
    moveTop() { assert.equal(this.destroyed, false); }
    hide() { assert.equal(this.destroyed, false); this.visible = false; }
    loadFile(file) {
      assert.equal(file, path.join(variant.root, 'src', 'index.html'));
      if (!deferredLoads) this.resolveLoad();
      return this.loadPromise;
    }
    // OS destruction bypasses the preventable 'close' event, as DestroyWindow
    // does for a child when its foreign native parent is destroyed.
    loseHost() {
      if (this.destroyed) return;
      this.destroyed = true; this.visible = false;
      this.rejectLoad(new Error('isolated renderer load aborted by native parent destruction'));
      this.emit('closed');
    }
    destroy() { this.destroyCalls++; this.loseHost(); }
  }
  const globals = {
    module: { exports: {} }, __dirname: path.join(variant.root, 'src'), path,
    require(name) { throw new Error('No runtime dependency is allowed in the isolated lifecycle VM: ' + name); },
    BrowserWindow: FakeWindow,
    app: { quit() { quitCalls++; } }, windowIcon: 'isolated:test-icon',
    screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) },
    widget: null, windowMode: null, drag: null, quitting: false, widgetManuallyHidden: manuallyHidden,
    visualMotion: null, poseTimer: null, poseResume: null, poseEpoch: 0,
    setTimeout(callback) { const id = ++timerId; poseTimers.set(id, callback); return id; },
    clearTimeout(id) { poseTimers.delete(id); },
    settings, source: backend, tray, controlServer: control, library, settingsWindow,
    timer: { marker: 'existing quota refresh timer' }, desktopMonitor: { marker: 'existing desktop monitor' },
    stopAuthWatch: { marker: 'existing watcher cleanup' }, host,
    dimensions: () => ({ width: 228, height: 288 }),
    configureWidgetWorkspace(win) { configured.push(win); },
    setWidgetPosition(x, y) { context.widget.setBounds({ x, y, width: 228, height: 288 }); },
    applyWindowSettings() {
      const win = context.widget;
      const mode = { widget: win, closes: 0, close() { this.closes++; },
        show() { win.show(); }, hide() { win.hide(); } };
      modes.push(mode); context.windowMode = mode;
    },
    save() { writes.push(plain(context.settings)); },
    broadcast() { broadcasts.push(context.widget); },
  };
  context = vm.createContext(globals);
  vm.runInContext(sourceText.slice(poseStart, poseEnd) + '\n' + sourceText.slice(start, end) + '\n' + show + '\n' + hide +
    '\nmodule.exports = { createWidget, rebuildWidget };', context, { filename: path.join(variant.root, 'src', 'main.cjs') });
  const retained = Object.fromEntries(['settings', 'source', 'tray', 'controlServer', 'library', 'settingsWindow',
    'timer', 'desktopMonitor', 'stopAuthWatch', 'host'].map(key => [key, context[key]]));
  return {
    context, windows, modes, writes, broadcasts, configured, retained,
    create: context.module.exports.createWidget, rebuild: context.module.exports.rebuildWidget,
    get quitCalls() { return quitCalls; }, get codexDestroyCalls() { return codexDestroyCalls; },
    get stalePoseCalls() { return stalePoseCalls; },
    armPose() {
      context.visualMotion = { offset: { x: 7, y: 11 }, visual: { x: 430, y: 228 }, phase: 'settle' };
      context.poseResume = () => { stalePoseCalls++; };
      context.poseTimer = globals.setTimeout(() => { stalePoseCalls++; });
    },
    runPoseTimers() { for (const [id, callback] of poseTimers) { poseTimers.delete(id); callback(); } },
    assertRetained() { for (const [key, value] of Object.entries(retained)) assert.equal(context[key], value, key); },
  };
}

for (const variant of variants) {
  for (const manuallyHidden of [false, true]) {
    test(`${variant.name}: OS host destruction recreates only the surface and preserves manual visibility ${manuallyHidden}`, async () => {
      const fixture = harness(variant, { manuallyHidden });
      const first = await fixture.create();
      const before = plain(fixture.context.settings), firstMode = fixture.modes[0];
      fixture.context.drag = { cursor: { x: 5, y: 6 }, origin: [423, 217] };
      fixture.armPose();
      first.loseHost(); await flush();
      assert.equal(fixture.windows.length, 2);
      const current = fixture.windows[1];
      assert.equal(fixture.context.widget, current);
      assert.equal(firstMode.closes, 1);
      assert.equal(fixture.context.windowMode, fixture.modes[1]);
      assert.equal(fixture.context.drag, null);
      assert.equal(fixture.context.visualMotion, null);
      assert.equal(fixture.context.poseTimer, null); assert.equal(fixture.context.poseResume, null);
      fixture.runPoseTimers(); assert.equal(fixture.stalePoseCalls, 0, 'closed surfaces cancel their pending pose callback');
      assert.equal(fixture.context.widgetManuallyHidden, manuallyHidden);
      assert.equal(current.isVisible(), !manuallyHidden);
      assert.deepEqual(plain(fixture.context.settings), before);
      assert.deepEqual(fixture.writes, [before, before]);
      fixture.assertRetained();
      assert.equal(fixture.quitCalls, 0); assert.equal(fixture.codexDestroyCalls, 0);
      assert.equal(first.destroyCalls, 0, 'an OS close does not call destroy on any application');
      assert.equal(current.options.webPreferences.sandbox, true);
      assert.equal(current.options.webPreferences.nodeIntegration, false);
      assert.equal(current.options.webPreferences.contextIsolation, true);
      assert.deepEqual(plain(current.openHandler()), { action: 'deny' });
      let allowed; current.permissionHandler(null, 'camera', value => { allowed = value; });
      assert.equal(allowed, false);
      assert.equal(fixture.configured.length, variant.name === 'macOS' ? 2 : 0);
    });
  }

  test(`${variant.name}: explicit recovery destroys only the current pet and ignores stale closed events`, async () => {
    const fixture = harness(variant);
    const first = await fixture.create();
    fixture.armPose();
    fixture.rebuild(); await flush();
    assert.equal(first.destroyCalls, 1); assert.equal(fixture.windows.length, 2);
    const current = fixture.windows[1], currentMode = fixture.modes[1];
    first.emit('closed'); await flush();
    assert.equal(fixture.windows.length, 2);
    assert.equal(current.destroyCalls, 0); assert.equal(currentMode.closes, 0);
    assert.equal(fixture.context.widget, current);
    assert.equal(fixture.context.visualMotion, null); assert.equal(fixture.context.poseResume, null);
    fixture.runPoseTimers(); assert.equal(fixture.stalePoseCalls, 0, 'explicit replacement also cancels the old surface animation');
    fixture.assertRetained(); assert.equal(fixture.quitCalls, 0); assert.equal(fixture.codexDestroyCalls, 0);
  });

  test(`${variant.name}: a parent destroyed during renderer loading does not quit or show the old surface`, async () => {
    const fixture = harness(variant, { deferredLoads: true });
    const loading = fixture.create();
    const first = fixture.windows[0];
    first.loseHost();
    assert.equal(fixture.windows.length, 2);
    fixture.windows[1].resolveLoad();
    assert.equal(await loading, first);
    await flush();
    assert.equal(fixture.context.widget, fixture.windows[1]);
    assert.equal(fixture.windows[1].isVisible(), true);
    assert.equal(fixture.broadcasts.includes(first), false);
    assert.equal(fixture.modes[0].closes, 1);
    assert.equal(fixture.quitCalls, 0); fixture.assertRetained();
  });

  test(`${variant.name}: a preventable pet close hides it while quitting prevents all recovery`, async () => {
    const fixture = harness(variant);
    const first = await fixture.create();
    let prevented = false;
    first.emit('close', { preventDefault() { prevented = true; } });
    assert.equal(prevented, true);
    assert.equal(fixture.context.widgetManuallyHidden, true);
    assert.equal(first.isVisible(), false); assert.equal(fixture.windows.length, 1);
    fixture.context.quitting = true;
    fixture.rebuild();
    assert.equal(first.destroyCalls, 0);
    first.loseHost(); await flush();
    assert.equal(fixture.windows.length, 1); assert.equal(fixture.quitCalls, 0);
    fixture.assertRetained();
  });

  test(`${variant.name}: real replacement renderer load failures retain the existing fatal-error path`, async () => {
    const fixture = harness(variant, { deferredLoads: true });
    const loading = fixture.create(); fixture.windows[0].resolveLoad(); await loading;
    fixture.windows[0].loseHost();
    fixture.windows[1].rejectLoad(new Error('isolated genuine renderer failure'));
    await flush();
    assert.equal(fixture.quitCalls, 1);
    fixture.assertRetained(); assert.equal(fixture.codexDestroyCalls, 0);
  });
}
