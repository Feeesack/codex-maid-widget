'use strict';
const assert = require('node:assert/strict');

// Read the real offscreen paint output rather than issuing a second compositor
// readback (capturePage can fail while a resized surface is being replaced).
// No cached image or previous-size frame can satisfy a new capture request.
function captureOffscreenFrame(win, { timeoutMs = 5000 } = {}) {
  const contents = win.webContents;
  assert.equal(contents.isOffscreen(), true, 'Frame capture requires an offscreen window');
  assert.ok(Number.isFinite(timeoutMs) && timeoutMs > 0);
  const target = win.getContentSize();
  assert.ok(target.every(value => Number.isInteger(value) && value > 0));
  return new Promise((resolve, reject) => {
    let done = false, checking = false, expected = null, paintSequence = 0, readyAfter = 0, lastFrame = null;
    const finish = (error, image) => {
      if (done) return;
      done = true; clearTimeout(timer);
      contents.removeListener('paint', painted);
      contents.removeListener('destroyed', destroyed);
      contents.removeListener('render-process-gone', rendererGone);
      contents.removeListener('did-start-navigation', navigated);
      win.removeListener('closed', destroyed);
      if (error) reject(error); else resolve(image);
    };
    const unchangedSize = () => {
      const current = win.getContentSize();
      if (current[0] !== target[0] || current[1] !== target[1]) {
        finish(new Error('Offscreen window resized during frame capture')); return false;
      }
      return true;
    };
    const invalidate = () => {
      if (done) return;
      try { contents.invalidate(); } catch (error) { finish(error); }
    };
    const checkViewport = async () => {
      if (done || checking) return;
      checking = true;
      try {
        const viewport = await contents.executeJavaScript('({width:innerWidth,height:innerHeight,pixelRatio:devicePixelRatio})');
        if (done || !unchangedSize()) return;
        const zoom = contents.getZoomFactor();
        if (![viewport.width, viewport.height, viewport.pixelRatio, zoom].every(value => Number.isFinite(value) && value > 0)) {
          throw new Error('Invalid offscreen viewport dimensions');
        }
        if (Math.abs(viewport.width * zoom - target[0]) <= 1 && Math.abs(viewport.height * zoom - target[1]) <= 1) {
          expected = { width: Math.round(target[0] * viewport.pixelRatio / zoom), height: Math.round(target[1] * viewport.pixelRatio / zoom) };
          readyAfter = paintSequence;
        }
        invalidate();
      } catch (error) { finish(error); }
      finally { checking = false; }
    };
    const painted = (_event, _dirty, image) => {
      paintSequence++;
      if (done || !unchangedSize()) return;
      if (!expected) { void checkViewport(); return; }
      if (paintSequence <= readyAfter) return;
      try {
        lastFrame = image && !image.isEmpty() ? image.getSize() : null;
        if (!lastFrame || lastFrame.width !== expected.width || lastFrame.height !== expected.height) {
          invalidate(); return;
        }
        finish(null, image);
      } catch (error) { finish(error); }
    };
    const destroyed = () => finish(new Error('Offscreen window closed before a matching frame was painted'));
    const rendererGone = () => finish(new Error('Offscreen renderer exited before a matching frame was painted'));
    const navigated = (_event, details) => { if (details?.isMainFrame !== false) finish(new Error('Offscreen page navigated during frame capture')); };
    const timer = setTimeout(() => finish(new Error(`No matching offscreen paint within ${timeoutMs}ms: ${JSON.stringify({ target, expected, lastFrame, paintSequence })}`)), timeoutMs);
    contents.on('paint', painted);
    contents.once('destroyed', destroyed);
    contents.once('render-process-gone', rendererGone);
    contents.on('did-start-navigation', navigated);
    win.once('closed', destroyed);
    void checkViewport();
  });
}

module.exports = { captureOffscreenFrame };
