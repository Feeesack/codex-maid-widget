'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { supportsDesktopFollow, configureMacApp, configureWidgetWorkspace, trayImage } = require('../src/platform.cjs');

test('packaged macOS and Windows retain follow while demo/source never register startup', () => {
  for (const platform of ['darwin', 'win32']) {
    assert.equal(supportsDesktopFollow({ platform, packaged: true, demo: false }), true);
    assert.equal(supportsDesktopFollow({ platform, packaged: false, demo: false }), false);
    assert.equal(supportsDesktopFollow({ platform, packaged: true, demo: true }), false);
  }
  assert.equal(supportsDesktopFollow({ platform: 'linux', packaged: true, demo: false }), false);
});

test('macOS widget remains interactive without a Dock icon and follows fullscreen Spaces', () => {
  const calls = [];
  configureMacApp({ setActivationPolicy: value => calls.push(value) }, 'darwin');
  configureWidgetWorkspace({ setVisibleOnAllWorkspaces: (...args) => calls.push(args) }, 'darwin');
  assert.deepEqual(calls, ['accessory', [true, { visibleOnFullScreen: true, skipTransformProcessType: true }]]);
  configureMacApp({}, 'win32');
  configureWidgetWorkspace({}, 'win32');
});

test('macOS tray combines native Retina sizes while Windows keeps its DPI-aware ICO', () => {
  const representations = [];
  let template;
  const result = { addRepresentation: value => representations.push(value), setTemplateImage: value => { template = value; } };
  assert.equal(trayImage({ root: 'root', platform: 'darwin', nativeImage: { createEmpty: () => result }, readFile: file => Buffer.from(file) }), result);
  assert.deepEqual(representations.map(item => item.scaleFactor), [1, 2, 3]);
  for (const [index, value] of representations.entries()) assert.match(value.buffer.toString(), new RegExp(`tray-${16 * (index + 1)}\\.png$`));
  assert.equal(template, false);
  assert.match(trayImage({ root: 'root', platform: 'win32' }), /app-icon\.ico$/);
});
