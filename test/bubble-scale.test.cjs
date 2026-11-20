'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const paths = ['../src/settings.cjs', '../macos/src/settings.cjs'];

for (const modulePath of paths) {
  const label = modulePath.includes('macos') ? 'macos' : 'windows';
  const settings = require(modulePath);

  test(`${label}: the bubble keeps its own size independent of the companion`, () => {
    assert.equal(settings.DEFAULTS.bubbleScale, 1);
    assert.deepEqual(settings.widgetDimensions(1, 1), { width: 228, height: 288 }, 'the default geometry must not move');
    for (const value of [0.8, 1, 1.2, 1.4]) {
      const size = settings.widgetDimensions(1, value);
      assert.equal(size.height, Math.round(settings.bubbleCanvasHeight(value) * 0.6), 'the surface grows above the bubble');
    }
    assert.equal(settings.widgetDimensions(1, 1.2).height, 317);
    assert.equal(settings.widgetDimensions(1, 1.2).width, 271);
    assert.equal(settings.widgetDimensions(1, 1.4).width, 313);
    assert.equal(settings.widgetDimensions(0.6, 1.4).width, Math.round(522 * 0.6 * 0.6));
    assert.equal(settings.bubbleCanvasWidth(1.2), 451);
    assert.equal(settings.bubbleCanvasHeight(1.2), 529);
  });

  test(`${label}: bubble size is clamped and never discards the rest of the settings`, () => {
    for (const [input, expected] of [[0.5, 0.8], [1.2, 1.2], [2, 1.4], ['1.2', 1], [null, 1], [Infinity, 1]]) {
      const value = settings.sanitize({ bubbleScale: input, scale: 1.25, opacity: 0.8 });
      assert.equal(value.bubbleScale, expected);
      assert.equal(value.scale, 1.25);
      assert.equal(value.opacity, 0.8);
    }
  });

  test(`${label}: corner peeking follows the widened canvas instead of assuming 380`, () => {
    const base = settings.cornerPeekOffset('left', { width: 228, height: 288 }, { peekSidePercent: 100, peekBottomPercent: 50 });
    const wide = settings.cornerPeekOffset('left', { width: 271, height: 288 }, { peekSidePercent: 100, peekBottomPercent: 50, bubbleScale: 1.2 });
    const narrow = settings.cornerPeekOffset('left', { width: 271, height: 288 }, { peekSidePercent: 100, peekBottomPercent: 50 });
    assert.ok(Math.abs(base.x + 28.8) < 0.001);
    assert.ok(Math.abs(wide.x - base.x) < 0.2, 'a wider window is not a bigger companion');
    assert.ok(narrow.x < base.x, 'without the matching setting the window width would deepen the peek');
  });
}
