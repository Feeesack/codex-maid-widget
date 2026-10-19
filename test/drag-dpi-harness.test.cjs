'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const root = path.resolve(__dirname, '..');
const mainFile = path.join(root, 'src/main.cjs');
const source = fs.readFileSync(mainFile, 'utf8');
const script = fs.readFileSync(path.join(root, 'scripts/drag-dpi-check.cjs'), 'utf8');
const first = script.indexOf('function definitions('), last = script.indexOf('async function checkCase(');
assert.ok(first > 0 && last > first, 'Review the native DPI harness definition boundary');

function fixture() {
  // No directory is created. Even transitive settings writes use this in-memory
  // boundary; data-home and native Codex providers remain harness stubs.
  const profile = path.join(os.tmpdir(), 'maid-dpi-unit-中文 sandbox');
  const dataDir = path.join(profile, 'widget', 'case');
  const file = path.join(dataDir, 'settings.json'), writes = [];
  const settingsModule = { ...require('../src/settings.cjs'), writeSettings(target, value) {
    assert.equal(target, file); writes.push(structuredClone(value));
  } };
  const context = vm.createContext({ assert, path, vm, EventEmitter, profile, settingsModule,
    fs: { mkdirSync(target) { assert.equal(target, dataDir); } },
    process: { platform: 'win32', env: { CODEX_HOME: path.join(profile, 'codex') } },
    setTimeout, clearTimeout, setInterval, clearInterval,
  });
  vm.runInContext(script.slice(first, last) + '\nthis.api = { legacyVersion, harness };', context);
  const display = { workArea: { x: -200, y: 0, width: 2400, height: 1600 } };
  const position = { x: 800, y: 600 };
  function window() {
    let bounds = { ...position, ...settingsModule.widgetDimensions(0.6) };
    return {
      webContents: { send() {} }, isDestroyed: () => false,
      getBounds: () => ({ ...bounds }), getPosition: () => [bounds.x, bounds.y],
      // Model the native enclosing-rectangle feedback being tested. It affects
      // position-only updates; an explicit preferred size clears the rounding.
      setPosition(x, y) { bounds = { x, y, width: bounds.width + 1, height: bounds.height + 1 }; },
      setBounds(next) { bounds = { ...bounds, ...next }; },
      setOpacity() {}, setIgnoreMouseEvents() {},
    };
  }
  return { ...context.api, dataDir, display, position, window, writes, file };
}

test('derived legacy handlers reproduce position-only feedback while current handlers retain preferred size', () => {
  const f = fixture();
  const baseline = f.legacyVersion(source);
  assert.notEqual(baseline, source);
  for (const [variant, input] of [['baseline', baseline], ['fixed', source]]) {
    const win = f.window();
    const api = f.harness(input, mainFile, win, 0.6, f.dataDir, f.display, f.position);
    const start = win.getBounds();
    api.cursor({ x: 815, y: 615 }); api.emit('drag-start');
    for (let step = 0; step < 300; step++) {
      api.cursor({ x: 815 + step % 71 - 35, y: 615 + step % 53 - 26 }); api.emit('drag-move');
    }
    const moved = win.getBounds();
    if (variant === 'baseline') {
      assert.equal(moved.width - start.width, 300);
      assert.equal(moved.height - start.height, 300);
    } else {
      assert.equal(moved.width, 137); assert.equal(moved.height, 173);
    }
    api.emit('drag-end');
  }
  assert.equal(fs.readFileSync(mainFile, 'utf8'), source, 'Deriving a baseline never writes production source');
  assert.equal(f.writes.length, 2, 'Both handlers save only through the isolated settings boundary');
});

test('legacy derivation recognizes earlier drag-end saving without discarding it', () => {
  const f = fixture();
  const earlier = source.replace('setWidgetPosition(p.x, p.y); broadcast();', 'setWidgetPosition(p.x, p.y); save(); broadcast();');
  const baseline = f.legacyVersion(earlier);
  assert.ok(baseline.includes('widget.setPosition(p.x, p.y); save(); broadcast();'));
  assert.ok(baseline.includes('widget.setPosition(drag.origin[0] + cursor.x - drag.cursor.x, drag.origin[1] + cursor.y - drag.cursor.y);'));
});

test('unknown or ambiguous baseline anchors fail before exercising native windows', () => {
  const f = fixture();
  const currentEnd = 'setWidgetPosition(p.x, p.y); broadcast();';
  assert.throws(() => f.legacyVersion(source.replace(currentEnd, 'setWidgetPosition(p.x, p.y); changedBroadcast();')), /Cannot uniquely derive/);
  assert.throws(() => f.legacyVersion(source + '\n' + currentEnd), /Cannot uniquely derive/);
  assert.throws(() => f.legacyVersion(source + '\nsetWidgetPosition(p.x, p.y); save(); broadcast();'), /Cannot uniquely derive/);
});

test('harness refuses unreviewed modules, containment activation and foreign settings paths', () => {
  const f = fixture();
  const run = input => f.harness(input, mainFile, f.window(), 0.6, f.dataDir, f.display, f.position);
  assert.throws(() => run("require('./unreviewed-profile.cjs');\n" + source), /Unreviewed production dependency/);
  assert.throws(() => run(source.replace('syncWindowMode();', 'syncWindowMode(); windowMode.configure(true);')), /must not enable Codex window containment/);
  assert.throws(() => run(source.replace('let settings = readSettings(settingsFile);', "let settings = readSettings(path.join(dataDir, '..', 'foreign-settings.json'));")), { code: 'ERR_ASSERTION' });
  assert.throws(() => run(source.replace('let settings = readSettings(settingsFile);', "let settings = readSettings(settingsFile); writeSettings(path.join(dataDir, '..', 'foreign-settings.json'), settings);")), { code: 'ERR_ASSERTION' });
});
