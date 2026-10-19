'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const variants = [
  ['Windows', require('../scripts/offscreen-frame.cjs')],
  ['macOS', require('../macos/scripts/offscreen-frame.cjs')],
];
const flush = () => new Promise(resolve => setImmediate(resolve));
function fixture({ ratio = 1, zoom = 1, viewport = [228 / zoom, 288 / zoom] } = {}) {
  const contents = new EventEmitter(), win = new EventEmitter();
  let size = [228, 288], invalidations = 0;
  Object.assign(contents, {
    isOffscreen: () => true, getZoomFactor: () => zoom,
    executeJavaScript: async () => ({ width: viewport[0], height: viewport[1], pixelRatio: ratio }),
    invalidate: () => { invalidations++; },
  });
  Object.assign(win, { webContents: contents, getContentSize: () => size });
  const image = (width, height, empty = false) => ({ isEmpty: () => empty, getSize: () => ({ width, height }) });
  return { win, contents, image,
    paint: value => contents.emit('paint', {}, {}, value),
    resize: value => { size = value; },
    get invalidations() { return invalidations; },
    assertClean() {
      for (const event of ['paint', 'destroyed', 'render-process-gone', 'did-start-navigation']) assert.equal(contents.listenerCount(event), 0, event);
      assert.equal(win.listenerCount('closed'), 0);
    },
  };
}
for (const [name, { captureOffscreenFrame }] of variants) {
  test(name + ': fresh paint rejects empty and previous-size frames after viewport readiness', async () => {
    const f = fixture();
    const pending = captureOffscreenFrame(f.win);
    await flush();
    let settled = false; pending.then(() => { settled = true; });
    f.paint(f.image(365, 461)); f.paint(f.image(228, 288, true));
    await flush(); assert.equal(settled, false);
    const correct = f.image(228, 288); f.paint(correct);
    assert.equal(await pending, correct); assert.ok(f.invalidations >= 3); f.assertClean();
  });
  test(name + ': Retina pixels and page zoom are derived from renderer metrics', async () => {
    for (const [ratio, zoom] of [[2, 1], [3, 1.5]]) {
      const f = fixture({ ratio, zoom });
      const pending = captureOffscreenFrame(f.win);
      await flush();
      const frame = f.image(456, 576); f.paint(frame);
      assert.equal(await pending, frame); f.assertClean();
    }
  });
  test(name + ': correct-size frame before viewport resize acknowledgement cannot satisfy capture', async () => {
    const f = fixture(); let acknowledge;
    f.contents.executeJavaScript = () => new Promise(resolve => { acknowledge = resolve; });
    const pending = captureOffscreenFrame(f.win);
    const premature = f.image(228, 288); f.paint(premature);
    acknowledge({ width: 228, height: 288, pixelRatio: 1 }); await flush();
    const next = f.image(228, 288); f.paint(next);
    assert.equal(await pending, next); f.assertClean();
  });
  test(name + ': outdated renderer viewport waits for the applied resize', async () => {
    const f = fixture({ viewport: [365, 461] });
    const pending = captureOffscreenFrame(f.win); await flush();
    f.contents.executeJavaScript = async () => ({ width: 228, height: 288, pixelRatio: 1 });
    f.paint(f.image(365, 461)); await flush();
    const next = f.image(228, 288); f.paint(next);
    assert.equal(await pending, next); f.assertClean();
  });
  test(name + ': timeout and window/renderer failures reject without a cached screenshot', async () => {
    for (const failure of ['timeout', 'closed', 'renderer', 'resize', 'navigation', 'metrics']) {
      const f = fixture();
      if (failure === 'metrics') f.contents.executeJavaScript = async () => { throw new Error('renderer evaluation failed'); };
      const pending = captureOffscreenFrame(f.win, { timeoutMs: 20 });
      const rejection = assert.rejects(pending, /matching offscreen paint|closed before|renderer exited|resized during|navigated during|renderer evaluation failed/);
      await flush();
      if (failure === 'closed') f.win.emit('closed');
      if (failure === 'renderer') f.contents.emit('render-process-gone', {}, { reason: 'crashed' });
      if (failure === 'resize') { f.resize([550, 760]); f.paint(f.image(228, 288)); }
      if (failure === 'navigation') f.contents.emit('did-start-navigation', {}, { isMainFrame: true });
      await rejection; f.assertClean();
    }
  });
}
test('offscreen capture helper is identical in both platform source trees', () => {
  assert.deepEqual(fs.readFileSync(path.join(__dirname, '../scripts/offscreen-frame.cjs')),
    fs.readFileSync(path.join(__dirname, '../macos/scripts/offscreen-frame.cjs')));
});
