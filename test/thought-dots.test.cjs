'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// The trailing thought-dots and the left-edge controls are positioned in the
// canvas coordinate space, which the bubble scaling moves and grows. They have
// to ride exactly the same map as the bubble, or they drift away from it.
const settings = require('../src/settings.cjs');

const CORNER = { x: 366, y: 254 };          // bubble border-box corner at 100%
const TAIL = { x: 159, y: 244 };            // visual centre of the bubble tail
// The designed offset from the tail, which must survive every scale.
const DESIGN = [{ dx: -32, dy: 16 }, { dx: -6, dy: 43 }];

function rule(css, selector) {
  const match = new RegExp('(?:^|\\n)' + selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\{([^}]*)\\}').exec(css);
  assert.ok(match, 'missing rule ' + selector);
  return match[1];
}
function declaration(body, property) {
  const match = new RegExp('(?:^|;)\\s*' + property + ':([^;]+)').exec(body);
  assert.ok(match, 'missing ' + property + ' in ' + body);
  return match[1].trim();
}
function offsets(bubbleScale) {
  return { x: Math.round(354 * (bubbleScale - 1)), y: Math.round(246 * (bubbleScale - 1)) };
}
// Evaluates the limited calc() subset used here: lengths, +/- and / by a var.
function evaluate(text, bubbleScale, extra) {
  const inner = /^calc\((.*)\)$/.exec(text)?.[1] ?? text;
  const substituted = inner
    .replace(/var\(--bubble-scale,\s*1\)/g, String(bubbleScale))
    .replace(/var\(--bubble-extra-y,\s*0px\)/g, extra.y + 'px')
    .replace(/var\(--bubble-extra,\s*0px\)/g, extra.x + 'px');
  let total = 0, sign = 1;
  for (const chunk of substituted.split(/\s*([+-])\s*/)) {
    if (chunk === '+') { sign = 1; continue; }
    if (chunk === '-') { sign = -1; continue; }
    const parts = chunk.split('/').map(part => Number(part.replace('px', '').trim()));
    total += sign * parts.reduce((value, part) => value / part);
  }
  return total;
}

for (const folder of ['', 'macos/']) {
  const label = folder ? 'macos' : 'windows';
  const css = () => fs.readFileSync(path.join(__dirname, '..', folder, 'src/widget.css'), 'utf8');

  test(`${label}: the dots wrapper sits on the bubble's shifted box`, () => {
    const body = rule(css(), '.thought-dots');
    const bubble = rule(css(), '.bubble');
    assert.equal(declaration(body, 'width'), '380px', 'the wrapper must keep the original canvas width');
    assert.equal(declaration(body, 'height'), '480px');
    assert.equal(declaration(body, 'transform-origin'), `${CORNER.x}px ${CORNER.y}px`);
    assert.match(declaration(body, 'transform'), /^scale\(var\(--bubble-scale,1\)\)$/);
    // The wrapper must travel with the bubble; the bubble sits 12px/8px inside.
    assert.equal(declaration(body, 'left'), 'var(--bubble-extra,0px)');
    assert.equal(declaration(body, 'top'), 'var(--bubble-extra-y,0px)');
    assert.equal(declaration(bubble, 'left'), 'calc(12px + var(--bubble-extra,0px))');
    assert.equal(declaration(bubble, 'top'), 'calc(8px + var(--bubble-extra-y,0px))');
    assert.equal(declaration(bubble, 'transform-origin'), '100% 100%');
  });

  test(`${label}: each dot keeps its designed distance from the tail at every size`, () => {
    const body = rule(css(), '.thought-dots');
    const bubble = rule(css(), '.bubble');
    const width = evaluate(declaration(bubble, 'width'), 1, { x: 0, y: 0 });
    const height = evaluate(declaration(bubble, 'height'), 1, { x: 0, y: 0 });
    const dotRules = [rule(css(), '.dot-one'), rule(css(), '.dot-two')];

    for (const bubbleScale of [0.8, 1, 1.2, 1.3, 1.4]) {
      const extra = offsets(bubbleScale);
      const shift = { x: evaluate(declaration(body, 'left'), bubbleScale, extra),
        y: evaluate(declaration(body, 'top'), bubbleScale, extra) };
      const corner = { x: evaluate(declaration(bubble, 'left'), bubbleScale, extra) + width,
        y: evaluate(declaration(bubble, 'top'), bubbleScale, extra) + height };
      assert.equal(shift.x + CORNER.x, corner.x, 'corner x at ' + bubbleScale);
      assert.equal(shift.y + CORNER.y, corner.y, 'corner y at ' + bubbleScale);

      const tail = { x: corner.x + bubbleScale * (TAIL.x - CORNER.x),
        y: corner.y + bubbleScale * (TAIL.y - CORNER.y) };
      for (const [index, design] of DESIGN.entries()) {
        const base = { x: evaluate(declaration(dotRules[index], 'left'), bubbleScale, extra),
          y: evaluate(declaration(dotRules[index], 'top'), bubbleScale, extra) };
        const dot = { x: shift.x + CORNER.x + bubbleScale * (base.x - CORNER.x),
          y: shift.y + CORNER.y + bubbleScale * (base.y - CORNER.y) };
        assert.ok(Math.abs((dot.x - tail.x) - design.dx) < 0.01, `dot ${index} dx at ${bubbleScale}: ${dot.x - tail.x}`);
        assert.ok(Math.abs((dot.y - tail.y) - design.dy) < 0.01, `dot ${index} dy at ${bubbleScale}: ${dot.y - tail.y}`);
      }
    }
  });

  test(`${label}: the mirrored dots keep the same edge offset as the unmirrored ones`, () => {
    const text = css();
    for (const [leftSelector, rightSelector] of [['.dot-one', '.widget.is-mirrored .dot-one'],
      ['.dot-two', '.widget.is-mirrored .dot-two']]) {
      const left = rule(text, leftSelector), right = rule(text, rightSelector);
      for (const bubbleScale of [1, 1.4]) {
        const extra = offsets(bubbleScale);
        // Mirroring swaps the measured edge, so the same offset from `right`
        // reproduces the reflection of the box positioned from `left`.
        assert.ok(Math.abs(evaluate(declaration(right, 'right'), bubbleScale, extra) -
          evaluate(declaration(left, 'left'), bubbleScale, extra)) < 0.01,
        `${leftSelector} must mirror at ${bubbleScale}`);
      }
    }
  });

  test(`${label}: left-edge controls do not follow the widened canvas`, () => {
    const text = css();
    for (const [selector, base] of [['.toolbar', '29px'], ['.notice', '77px'], ['.demo-label', '17px']]) {
      assert.equal(declaration(rule(text, selector), 'left'), `calc(${base} + var(--bubble-extra,0px))`, selector);
    }
    assert.match(text, /\.widget\.is-mirrored \.toolbar\{left:auto;right:29px/);
    const chat = fs.readFileSync(path.join(__dirname, '..', folder, 'src/chat-bubble.css'), 'utf8');
    assert.match(rule(chat, '.chat-compose-panel'), /left:calc\(18px \+ var\(--bubble-extra,0px\)\)/);
  });

  test(`${label}: both dots stay inside the wrapper and keep their own transitions`, () => {
    const html = fs.readFileSync(path.join(__dirname, '..', folder, 'src/index.html'), 'utf8');
    assert.match(html, /<div class="thought-dots">\s*<div class="thought-dot dot-one hidden-dots"><\/div>\s*<div class="thought-dot dot-two hidden-dots"><\/div>\s*<\/div>/);
    const text = css();
    for (const selector of ['.dot-one{', '.dot-two{', '.thought-dot.hidden-dots{']) assert.ok(text.includes('\n' + selector), 'missing ' + selector);
    assert.match(rule(text, '.dot-one'), /transition-delay:\.12s/);
    assert.match(rule(text, '.dot-two'), /transition-delay:0s/);
  });
}