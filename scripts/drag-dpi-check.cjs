'use strict';
// Bootstrap only the production function definitions, not app startup, source
// readers, authentication watchers, local control, tray or follow helper.
const { app, BrowserWindow, screen } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
if (!process.env.CODEX_MAID_DRAG_CHECK) throw new Error('Use scripts/check-drag-dpi.cjs with an isolated profile.');
const config = JSON.parse(fs.readFileSync(process.env.CODEX_MAID_DRAG_CHECK, 'utf8'));
const profile = path.resolve(config.profile);
assert.equal(path.resolve(process.env.CODEX_MAID_HOME), path.join(profile, 'widget'));
assert.equal(path.resolve(process.env.CODEX_HOME), path.join(profile, 'codex'));
assert.equal(path.resolve(process.env.USERPROFILE), profile);
for (const name of ['userData', 'sessionData', 'crashDumps']) app.setPath(name, path.join(profile, name));
const settingsModule = require('../src/settings.cjs');
const wait = () => new Promise(resolve => setTimeout(resolve, 0));
function definitions(source) {
  const marker = 'if (!app.requestSingleInstanceLock())';
  const at = source.indexOf(marker);
  assert.ok(at > 0, 'Production startup boundary changed; review this harness.');
  return source.slice(0, at);
}
function legacyVersion(source) {
  // This is the 0.3.13 handler behavior. A saved --baseline-main can be used
  // instead for release evidence; no baseline source is needed in public CI.
  const changes = [
    ['setWidgetPosition(drag.origin[0] + cursor.x - drag.cursor.x, drag.origin[1] + cursor.y - drag.cursor.y);',
      'widget.setPosition(drag.origin[0] + cursor.x - drag.cursor.x, drag.origin[1] + cursor.y - drag.cursor.y);'],
    ['const bounds = { ...(windowMode?.enabled ? windowMode.getBounds() : widget.getBounds()), ...dimensions() };', 'const bounds = widget.getBounds();'],
    ['setWidgetPosition(p.x, p.y); save(); broadcast();', 'widget.setPosition(p.x, p.y); save(); broadcast();'],
  ];
  for (const [before, after] of changes) {
    assert.ok(source.includes(before), 'Cannot derive the previous drag handler; pass --baseline-main.');
    source = source.replace(before, after);
  }
  return source;
}
function harness(source, file, win, scale, dataDir, display, position, peekAtCorners = false) {
  const events = new EventEmitter();
  events.handle = () => {};
  let cursor = { x: 0, y: 0 };
  // Dependency isolation is explicit: data-home never executes the real host
  // module, os.homedir cannot reach the host, and no other project dependency
  // is imported. Only pure settings helpers and this profile's save are used.
  const isolatedSettings = { ...settingsModule, readSettings: () => settingsModule.sanitize({ sizeBaseline: 2, scale, followCodex: false, peekAtCorners }) };
  const isolatedApp = { isPackaged: false, setName() {}, setPath() {}, getPath: () => dataDir };
  const imports = {
    electron: { app: isolatedApp, ipcMain: events, screen: { getCursorScreenPoint: () => cursor, getDisplayMatching: () => display } },
    'node:fs': { mkdirSync(dir, options) { assert.equal(path.resolve(dir), path.resolve(dataDir)); return fs.mkdirSync(dir, options); } },
    'node:path': path, 'node:http': {}, 'node:crypto': {}, 'node:os': { homedir: () => profile },
    './settings.cjs': isolatedSettings, './data-home.cjs': { prepareDataHome: () => dataDir },
    './character-library.cjs': {}, './codex-data.cjs': {}, './codex-desktop.cjs': {}, './auth-change-watch.cjs': {},
    './windows-launch.cjs': {}, './desktop-observation.cjs': {},
  };
  const context = vm.createContext({
    require(name) { assert.ok(Object.hasOwn(imports, name), 'Unreviewed production dependency: ' + name); return imports[name]; },
    __dirname: path.dirname(file), process: { platform: process.platform, argv: [], env: { CODEX_HOME: process.env.CODEX_HOME, CODEX_MAID_HOME: dataDir } },
    module: { exports: {} }, setTimeout, clearTimeout, setInterval, clearInterval,
  });
  vm.runInContext(definitions(source) + `
module.exports = {
  initialize(win, position) {
    widget = win; broadcast = () => {}; setupIpc();
    if (typeof setWidgetPosition === 'function') setWidgetPosition(position.x, position.y);
    else widget.setPosition(position.x, position.y);
    applyWindowSettings();
  },
  settings() { return settings; },
  pose() { return visualPoseState(); },
  dock() { return cornerDockState(); },
  hold() { return drag ? { visualOrigin: drag.visualOrigin && { ...drag.visualOrigin }, visual: drag.visual && { ...drag.visual }, moved: drag.moved, poseMode: drag.poseMode } : null; }
};`, context, { filename: file });
  context.module.exports.initialize(win, position);
  const event = { sender: win.webContents };
  return { cursor(point) { cursor = point; }, emit(name) { events.emit(name, event); }, settings: context.module.exports.settings,
    pose: context.module.exports.pose, dock: context.module.exports.dock, hold: context.module.exports.hold };
}
async function checkCase(variant, source, file, scale, display) {
  const preferred = settingsModule.widgetDimensions(scale);
  const area = display.workArea;
  const center = { x: area.x + Math.round((area.width - preferred.width) / 2), y: area.y + Math.round((area.height - preferred.height) / 2) };
  const win = new BrowserWindow({ ...center, ...preferred, frame: false, transparent: true, resizable: false,
    hasShadow: false, skipTaskbar: true, show: false, backgroundColor: '#00000000',
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  const dataDir = path.join(profile, 'widget', variant + '-' + scale);
  const createdBounds = win.getBounds();
  const api = harness(source, file, win, scale, dataDir, display, center);
  // Electron converts enclosing rectangles in both directions. With a DIP
  // size that lands on a fractional physical pixel, the absolute result can
  // be up to two DIP larger at 125%; variation through moves must still stay
  // within one DIP. Integral physical sizes (228 at 150%) allow only one.
  const absoluteTolerance = dimension => Number.isInteger(dimension * config.factor) ? 1 : Math.ceil(2 / config.factor);
  const report = { variant, scale, preferred, absoluteRoundingTolerance: { width: absoluteTolerance(preferred.width), height: absoluteTolerance(preferred.height) },
    moves: config.moves, minWidth: Infinity, maxWidth: 0, minHeight: Infinity, maxHeight: 0, mirrorDirections: [], samples: [], snaps: [] };
  try {
    await win.loadURL('data:text/html;charset=utf-8,<!doctype html><meta charset="utf-8"><title>Isolated drag DPI check</title><style>html,body{margin:0;width:100%;height:100%}</style>');
    // initialize() mirrors each production startup, including its position
    // helper and applyWindowSettings(). Constructor-only rounding is recorded
    // separately because it precedes this normalization (e.g. at 125%).
    report.createdBounds = createdBounds;
    function sample(phase, step) {
      const bounds = win.getBounds(), content = win.getContentBounds(), zoom = win.webContents.getZoomFactor();
      report.minWidth = Math.min(report.minWidth, bounds.width); report.maxWidth = Math.max(report.maxWidth, bounds.width);
      report.minHeight = Math.min(report.minHeight, bounds.height); report.maxHeight = Math.max(report.maxHeight, bounds.height);
      assert.equal(zoom, 1, 'Page zoom changed');
      if (variant === 'fixed') {
        const mirror = api.settings().mirror;
        assert.equal(mirror, settingsModule.mirrorForBounds({ ...bounds, ...preferred }, area), 'Mirror must update before drag-end');
        if (phase === 'move' && !report.mirrorDirections.includes(mirror)) report.mirrorDirections.push(mirror);
        for (const measured of [bounds, content]) {
          assert.ok(Math.abs(measured.width - preferred.width) <= absoluteTolerance(preferred.width), 'DIP width drift: ' + JSON.stringify({ phase, step, measured, preferred }));
          assert.ok(Math.abs(measured.height - preferred.height) <= absoluteTolerance(preferred.height), 'DIP height drift: ' + JSON.stringify({ phase, step, measured, preferred }));
        }
      }
      if (step % 30 === 0 || phase !== 'move') report.samples.push({ phase, step, bounds, content, zoom });
      return bounds;
    }
    report.initial = sample('initial', 0);
    api.cursor({ x: center.x + 15, y: center.y + 15 }); api.emit('drag-start');
    for (let index = 0; index < config.moves; index++) {
      // Odd DIP offsets traverse all physical-pixel rounding residues at 150%.
      api.cursor({ x: center.x + 15 + (index % 71) - 35, y: center.y + 15 + (index % 53) - 26 });
      api.emit('drag-move'); sample('move', index);
      if (index % 20 === 19) await wait();
    }
    api.emit('drag-end'); report.afterDragEnd = sample('drag-end', config.moves);
    for (const [name, x, y] of [
      ['top-left', area.x + 4, area.y + 4],
      ['top-right', area.x + area.width - preferred.width - 4, area.y + 4],
      ['bottom-right', area.x + area.width - preferred.width - 4, area.y + area.height - preferred.height - 4],
      ['bottom-left', area.x + 4, area.y + area.height - preferred.height - 4],
    ]) {
      // Reset only between separate drags so an expanding old baseline does
      // not conceal the fixed handler's ability to snap from a known start.
      win.setBounds({ ...center, ...preferred });
      api.cursor({ x: center.x + 15, y: center.y + 15 }); api.emit('drag-start');
      api.cursor({ x: x + 15, y: y + 15 }); api.emit('drag-move');
      api.emit('drag-end');
      const bounds = sample('snap-' + name, config.moves);
      const expected = settingsModule.snapBounds({ x, y, ...preferred }, area);
      if (variant === 'fixed') {
        assert.ok(Math.abs(bounds.x - expected.x) <= 1 && Math.abs(bounds.y - expected.y) <= 1, 'Edge snap position drift');
        const saved = api.settings();
        assert.equal(saved.position.x, expected.x); assert.equal(saved.position.y, expected.y); assert.equal(saved.mirror, expected.mirror);
      }
      report.snaps.push({ name, expected: { x: expected.x, y: expected.y }, bounds });
    }
    if (variant === 'fixed') {
      assert.equal(report.mirrorDirections.length, 2, 'Dragging across the centre must render both orientations');
      assert.ok(report.maxWidth - report.minWidth <= 1, 'DIP width range grew');
      assert.ok(report.maxHeight - report.minHeight <= 1, 'DIP height range grew');
    }
    report.sizeDrifted = report.maxWidth - report.minWidth > 1 || report.maxHeight - report.minHeight > 1;
    return report;
  } catch (error) {
    error.caseReport = report;
    throw error;
  } finally { win.destroy(); }
}
async function checkCornerCase(source, file, scale, display, corner) {
  const preferred = settingsModule.widgetDimensions(scale), area = display.workArea;
  const canonical = { x: corner === 'left' ? area.x : area.x + area.width - preferred.width,
    y: area.y + area.height - preferred.height };
  const expectedPeek = settingsModule.cornerPeekOffset(corner, preferred);
  const win = new BrowserWindow({ ...canonical, ...preferred, frame: false, transparent: true, resizable: false,
    hasShadow: false, skipTaskbar: true, show: false, backgroundColor: '#00000000',
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  const dataDir = path.join(profile, 'widget', 'corner-' + corner + '-' + scale);
  const api = harness(source, file, win, scale, dataDir, display, canonical, true);
  const absoluteTolerance = dimension => Number.isInteger(dimension * config.factor) ? 1 : Math.ceil(2 / config.factor);
  const positionTolerance = Math.ceil(2 / config.factor);
  const report = { corner, scale, preferred, expectedPeek, nativeMoves: 0, minWidth: Infinity, maxWidth: 0,
    minHeight: Infinity, maxHeight: 0, samples: [], maxPointerError: { x: 0, y: 0 } };
  let pointer = { x: canonical.x + preferred.width / 2, y: canonical.y + preferred.height / 2 };
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  try {
    await win.loadURL('data:text/html;charset=utf-8,<!doctype html><meta charset="utf-8"><title>Isolated corner drag DPI check</title>');
    assert.equal(api.settings().peekAtCorners, true, 'Corner coverage must opt in explicitly');
    assert.equal(api.settings().stayInCodexWindow, false, 'This native DPI check must stay in its isolated standalone profile');
    function sample(phase) {
      const bounds = win.getBounds(), content = win.getContentBounds(), pose = api.pose(), hold = api.hold();
      const world = { x: bounds.x + pose.offset.x, y: bounds.y + pose.offset.y };
      report.minWidth = Math.min(report.minWidth, bounds.width); report.maxWidth = Math.max(report.maxWidth, bounds.width);
      report.minHeight = Math.min(report.minHeight, bounds.height); report.maxHeight = Math.max(report.maxHeight, bounds.height);
      assert.equal(win.webContents.getZoomFactor(), 1);
      for (const measured of [bounds, content]) {
        assert.ok(Math.abs(measured.width - preferred.width) <= absoluteTolerance(preferred.width), 'Corner DIP width drift');
        assert.ok(Math.abs(measured.height - preferred.height) <= absoluteTolerance(preferred.height), 'Corner DIP height drift');
      }
      const result = { phase, bounds, content, offset: { ...pose.offset }, moving: pose.moving,
        world, hold: hold && { ...hold, visualOrigin: { ...hold.visualOrigin }, visual: { ...hold.visual } } };
      report.samples.push(result);
      return result;
    }
    function start(phase) {
      const origin = sample(phase + '-before');
      api.cursor(pointer); api.emit('drag-start');
      const held = api.hold();
      assert.equal(held.poseMode, true);
      assert.ok(Math.abs(held.visualOrigin.x - origin.world.x) < 1e-9 && Math.abs(held.visualOrigin.y - origin.world.y) < 1e-9,
        'Pressing a peeking character must retain its visible world point');
      return { pointer: { ...pointer }, world: { ...origin.world } };
    }
    async function move(origin, dx, dy, phase) {
      pointer = { x: origin.pointer.x + dx, y: origin.pointer.y + dy };
      api.cursor(pointer); api.emit('drag-move'); report.nativeMoves++;
      const value = sample(phase), expected = { x: origin.world.x + dx, y: origin.world.y + dy };
      const error = { x: Math.abs(value.world.x - expected.x), y: Math.abs(value.world.y - expected.y) };
      report.maxPointerError.x = Math.max(report.maxPointerError.x, error.x);
      report.maxPointerError.y = Math.max(report.maxPointerError.y, error.y);
      assert.ok(error.x <= positionTolerance && error.y <= positionTolerance,
        'Corner drag must follow the pointer without an upward pop: ' + JSON.stringify({ corner, phase, expected, value }));
      assert.ok(Math.abs(value.hold.visual.x - expected.x) < 1e-9 && Math.abs(value.hold.visual.y - expected.y) < 1e-9);
      assert.equal(value.hold.moved, true);
      await wait();
      return value;
    }
    async function release(phase, expectedCorner) {
      api.emit('drag-end');
      assert.equal(api.hold(), null);
      await pause(220);
      const settled = sample(phase), dock = api.dock();
      assert.equal(settled.moving, false, 'Release animation must complete');
      assert.equal(dock.corner, expectedCorner);
      assert.equal(dock.peeking, !!expectedCorner);
      const inset = settingsModule.cornerPeekOffset(expectedCorner, preferred);
      assert.ok(Math.abs(settled.offset.x - inset.x) < 1e-9 && Math.abs(settled.offset.y - inset.y) < 1e-9);
      assert.ok(Math.abs(settled.bounds.x - api.settings().position.x) <= positionTolerance);
      assert.ok(Math.abs(settled.bounds.y - api.settings().position.y) <= positionTolerance);
      return settled;
    }
    const initial = sample('initial');
    assert.ok(Math.abs(initial.offset.x - expectedPeek.x) < 1e-9 && Math.abs(initial.offset.y - expectedPeek.y) < 1e-9);
    const down = start('down');
    let prior = down.world;
    const outward = corner === 'left' ? -1 : 1;
    for (let step = 1; step <= 24; step++) {
      const current = await move(down, outward * step * 0.75, step * 1.5, 'down-' + step);
      assert.ok(current.world.y >= prior.y - positionTolerance, 'Dragging down cannot jump upward');
      prior = current.world;
    }
    await release('down-release', corner);
    // Pull inward in one continuous gesture. The same world-space origin must
    // cover both the clipped pose and the unshifted full-character pose.
    const inward = start('inward');
    const target = { x: area.x + (area.width - preferred.width) * (corner === 'left' ? 0.32 : 0.68),
      y: area.y + (area.height - preferred.height) * 0.55 };
    let full;
    for (let step = 1; step <= 32; step++) full = await move(inward,
      (target.x - inward.world.x) * step / 32, (target.y - inward.world.y) * step / 32, 'inward-' + step);
    assert.ok(Math.abs(full.offset.x) <= 0.5 && Math.abs(full.offset.y) <= 0.5, 'Dragging into the host must reveal the complete character');
    await release('inward-release', null);
    const returnToCorner = start('return');
    const parkedVisual = { x: canonical.x + expectedPeek.x, y: canonical.y + expectedPeek.y };
    for (let step = 1; step <= 24; step++) await move(returnToCorner,
      (parkedVisual.x - returnToCorner.world.x) * step / 24, (parkedVisual.y - returnToCorner.world.y) * step / 24, 'return-' + step);
    await release('corner-release', corner);
    assert.ok(report.maxWidth - report.minWidth <= 1, 'Corner dragging grew the native width');
    assert.ok(report.maxHeight - report.minHeight <= 1, 'Corner dragging grew the native height');
    report.ok = true;
    return report;
  } catch (error) { error.caseReport = report; throw error; }
  finally { win.destroy(); }
}
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  const report = { ok: false, platform: process.platform, electron: process.versions.electron,
    forcedDeviceScaleFactor: config.factor, maximumSizeVariationDIP: 1, cases: [], corners: [] };
  try {
    const source = fs.readFileSync(config.main, 'utf8');
    const baseline = config.baselineMain ? fs.readFileSync(config.baselineMain, 'utf8') : legacyVersion(source);
    report.sourceSha256 = crypto.createHash('sha256').update(source).digest('hex');
    report.baselineSha256 = crypto.createHash('sha256').update(baseline).digest('hex');
    report.baselineKind = config.baselineMain ? 'saved-production-source' : 'previous-handler-derived-from-current-source';
    const display = screen.getPrimaryDisplay();
    report.display = { scaleFactor: display.scaleFactor, bounds: display.bounds, workArea: display.workArea };
    assert.ok(Math.abs(display.scaleFactor - config.factor) < 0.01, 'Requested DPI factor is not active');
    for (const scale of config.scales) {
      report.cases.push(await checkCase('baseline', baseline, config.baselineMain || config.main, scale, display));
      report.cases.push(await checkCase('fixed', source, config.main, scale, display));
      for (const corner of ['left', 'right']) report.corners.push(await checkCornerCase(source, config.main, scale, display, corner));
    }
    report.ok = true;
  } catch (error) { report.error = error.message; if (error.caseReport) report.partialCase = error.caseReport; }
  fs.writeFileSync(config.reportFile, JSON.stringify(report, null, 2));
  app.exit(report.ok ? 0 : 1);
}).catch(error => { fs.writeFileSync(config.reportFile, JSON.stringify({ ok: false, error: error.message })); app.exit(1); });
