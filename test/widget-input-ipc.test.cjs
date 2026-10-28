'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');

// Execute only the production IPC callback with synthetic windows and mode.
// No application startup or transitive data-directory dependency runs here.
function fixture(directory) {
  const source = fs.readFileSync(path.join(directory, 'src/main.cjs'), 'utf8');
  const start = source.indexOf("  handle('widget-input-active',"), end = source.indexOf('  const chatHandle', start);
  assert.ok(start > 0 && end > start);
  let handler, resolve, focused = false, otherFocused = false, foregroundAllowed = true, cursor = { x: 10, y: 10 }, focusCalls = 0;
  const calls = [], webContents = { mainFrame: {}, focus() { calls.push('web-focus'); } };
  const widget = { webContents, getBounds: () => ({ x: 0, y: 0, width: 100, height: 100 }),
    isDestroyed: () => false, isFocused: () => focused, focus() { focusCalls++; focused = true; } };
  const mode = { nativeChild: true, inputDetached: false,
    async canActivateInput() { return foregroundAllowed; },
    setInputActive(active) { calls.push(active); if (active) return new Promise(done => { resolve = done; }); return Promise.resolve(true); } };
  const context = { widget, windowMode: mode, widgetInputSequence: 0, quitting: false, t: value => value,
    screen: { getCursorScreenPoint: () => cursor },
    settingsWindow: { isDestroyed: () => false, isFocused: () => otherFocused }, chatWindow: null,
    handle(name, callback) { assert.equal(name, 'widget-input-active'); handler = callback; } };
  vm.runInNewContext(source.slice(start, end), context, { filename: 'isolated-widget-input-ipc.cjs' });
  return { calls, get focusCalls() { return focusCalls; }, setCursor: value => { cursor = value; },
    setFocused: value => { focused = value; }, setOtherFocused: value => { otherFocused = value; }, setForegroundAllowed: value => { foregroundAllowed = value; },
    finish: () => resolve(true),
    send: (active, from = 'pointer', event = { sender: webContents, senderFrame: webContents.mainFrame }) => handler(event, active, from) };
}
for (const [name, directory] of [['Windows', path.join(__dirname, '..')], ['macOS', path.join(__dirname, '../macos')]]) {
  test(name + ': native editor focuses the embedded child without a detach or top-level focus', async () => {
    const h = fixture(directory), pending = h.send(true); assert.equal(h.focusCalls, 0);
    h.finish(); assert.equal(await pending, true); assert.equal(h.focusCalls, 0);
    assert.equal(h.calls.at(-1), name === 'Windows' ? true : 'web-focus');
    await h.send(false, 'blur'); assert.equal(h.focusCalls, 0);
  });
  test(name + ': clicking Codex outside the widget while detaching cannot steal focus back', async () => {
    const h = fixture(directory), pending = h.send(true); h.setCursor({ x: 200, y: 200 });
    h.finish(); assert.equal(await pending, false); assert.equal(h.focusCalls, 0); assert.equal(h.calls.at(-1), false);
  });
  test(name + ': Alt+Tab during detach cannot steal focus back even if the pointer remains over the widget', async () => {
    const h = fixture(directory), pending = h.send(true); h.setForegroundAllowed(false);
    h.finish(); assert.equal(await pending, false); assert.equal(h.focusCalls, 0); assert.equal(h.calls.at(-1), false);
  });
  test(name + ': late editor activation is cancelled by blur or a focused settings/manager window', async () => {
    for (const cancel of [h => h.send(false, 'blur'), h => h.setOtherFocused(true)]) {
      const h = fixture(directory), pending = h.send(true); await cancel(h); h.finish();
      assert.equal(await pending, false); assert.equal(h.focusCalls, 0);
    }
  });
  test(name + ': Tab activation survives the child HWND focus flag while the pointer remains inside, and foreign IPC is rejected', async () => {
    const h = fixture(directory); h.setFocused(false);
    const pending = h.send(true, 'focus'); h.finish(); assert.equal(await pending, true); assert.equal(h.focusCalls, 0);
    assert.equal(h.calls.at(-1), name === 'Windows' ? true : 'web-focus');
    await assert.rejects(h.send(true, 'pointer', { sender: {}, senderFrame: {} }), /无效窗口/);
  });
}
