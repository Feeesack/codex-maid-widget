'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// The ring is the project's own drawing: two arcs on one circle, split at the 2
// o'clock and 10 o'clock junctions with a gap on each. The top third is the
// five-hour window, the bottom two thirds the week. The lit arc is what is left,
// anchored on the split, so it retreats toward the split as quota is spent.
// An SVG dash cannot wrap past the end of its path, so each circle is rotated to
// the start of its own arc and the dash then lives inside [0, span].
const RING_GAP = 10;
const UPPER_SPAN = (120 - 2 * RING_GAP) / 3.6;
const LOWER_SPAN = (240 - 2 * RING_GAP) / 3.6;
const UPPER_ROTATION = 300 + RING_GAP - 90;
const LOWER_ROTATION = 60 + RING_GAP - 90;

function loadRing(folder) {
  const source = fs.readFileSync(path.join(__dirname, '..', folder, 'src/widget.js'), 'utf8');
  const start = source.indexOf('const RING_GAP');
  const end = source.indexOf('function updateAccountTimers(');
  assert.ok(start > 0 && end > start, 'renderAccountRing must stay a standalone slice');
  const context = {};
  vm.runInNewContext(source.slice(start, end) + '\nglobalThis.renderAccountRing = renderAccountRing;', context);
  return { render: context.renderAccountRing, source,
    entry: () => ({ rings: { 'upper-value': { style: {} }, 'lower-value': { style: {} }, 'full-value': { style: {} } } }) };
}
const near = (actual, expected, what = '') =>
  assert.ok(Math.abs(actual - expected) < 0.002, `${what}: expected ~${expected}, got ${actual}`);
const described = value => ({ length: Number(value.style.strokeDasharray.split(' ')[0]),
  offset: Number(value.style.strokeDashoffset) });

for (const folder of ['', 'macos/']) {
  const label = folder ? 'macos' : 'windows';

  test(`${label}: a full ring covers both segments exactly`, () => {
    const { render, entry } = loadRing(folder);
    const value = entry();
    render(value, 1, 1);
    near(described(value.rings['upper-value']).length, UPPER_SPAN, 'upper span');
    near(described(value.rings['lower-value']).length, LOWER_SPAN, 'lower span');
    near(UPPER_SPAN + LOWER_SPAN, 100 - (4 * RING_GAP) / 3.6, 'a gap sits on both junctions');
    // Full arcs start at their own path origin, which is what the stylesheet draws.
    near(described(value.rings['lower-value']).offset, 0, 'lower starts at its anchor');
    near(described(value.rings['upper-value']).offset, 0, 'a full upper arc starts at its origin');
  });

  test(`${label}: a single-window plan fills one closed loop`, () => {
    const { render, entry } = loadRing(folder);
    const value = entry();
    // Pro, and sometimes a Plus account, only gets the weekly window: there is
    // no junction to split on, so the whole circle is the week.
    render(value, null, 0.77, true);
    near(described(value.rings['full-value']).length, 77, 'the loop is the weekly remainder');
    near(described(value.rings['full-value']).offset, 0, 'fills from the element origin');
    assert.equal(value.rings['upper-value'].style.strokeDasharray, undefined, 'split arcs stay untouched');
    render(value, null, 0, true);
    near(described(value.rings['full-value']).length, 0, 'an expired week leaves an empty loop');
    render(value, null, null, true);
    assert.equal(value.rings['full-value'].style.strokeDasharray, '0 100', 'an unobserved week draws nothing');
  });

  test(`${label}: the lit arc shrinks toward the split and never overruns its span`, () => {
    const { render, entry } = loadRing(folder);
    for (const fraction of [1, 0.75, 0.5, 0.23, 0]) {
      const value = entry();
      render(value, fraction, fraction);
      const upper = described(value.rings['upper-value']);
      const lower = described(value.rings['lower-value']);
      near(upper.length, UPPER_SPAN * fraction, 'upper length at ' + fraction);
      near(lower.length, LOWER_SPAN * fraction, 'lower length at ' + fraction);
      // Both lit arcs are anchored on the LEFT end of their segment: the upper
      // one starts at its origin, the lower one ends at the end of its span.
      near(upper.offset, 0, 'upper stays anchored at its left end');
      near(-lower.offset + lower.length, LOWER_SPAN, 'lower stays anchored at its left end');
    }
    const over = entry();
    render(over, 1.4, 1.4);
    near(described(over.rings['upper-value']).length, UPPER_SPAN, 'clamped at the full span');
    const negative = entry();
    render(negative, -0.2, -0.2);
    assert.equal(described(negative.rings['upper-value']).length, 0);
  });

  test(`${label}: quota is spent from the right, so the lit arc keeps its left end`, () => {
    const { render, entry } = loadRing(folder);
    let previous = null;
    for (const fraction of [1, 0.8, 0.6, 0.4, 0.2]) {
      const value = entry();
      render(value, fraction, fraction);
      const upper = described(value.rings['upper-value']);
      const lower = described(value.rings['lower-value']);
      // The pale empty slot grows in from the right end of each segment, so the
      // lit part's left edge never moves and only its right edge retreats.
      near(upper.offset, 0, 'upper left edge at ' + fraction);
      near(-lower.offset + lower.length, LOWER_SPAN, 'lower left edge at ' + fraction);
      if (previous) {
        assert.ok(upper.length <= previous.upperLength + 0.002, 'upper only shrinks');
        assert.ok(lower.length <= previous.lowerLength + 0.002, 'lower only shrinks');
      }
      previous = { upperLength: upper.length, lowerLength: lower.length };
    }
  });

  test(`${label}: a missing observation empties its arc instead of inventing one`, () => {
    const { render, entry } = loadRing(folder);
    const value = entry();
    render(value, null, 0.4);
    assert.equal(value.rings['upper-value'].style.strokeDasharray, '0 100', 'unknown five-hour quota draws nothing');
    assert.ok(described(value.rings['lower-value']).length > 20, 'the weekly arc is unaffected');
    const both = entry();
    render(both, undefined, undefined);
    assert.equal(both.rings['upper-value'].style.strokeDasharray, '0 100');
    assert.equal(both.rings['lower-value'].style.strokeDasharray, '0 100');
  });

  test(`${label}: the arcs are rotated to their own start so no dash wraps`, () => {
    const { source } = loadRing(folder);
    // The rotation is what keeps a dash inside [0, span]; without it the arc
    // stops at the end of the circle path instead of continuing past twelve.
    assert.match(source, /300 \+ RING_GAP - 90/);
    assert.match(source, /60 \+ RING_GAP - 90/);
    assert.match(source, /rotate\(\$\{ringRotation\[/);
    for (const [angle, expected] of [[UPPER_ROTATION, 220], [LOWER_ROTATION, -20]]) {
      assert.equal(angle, expected, 'rotation for ' + expected);
    }
  });

  test(`${label}: the stylesheet draws the same segments as the renderer`, () => {
    const css = fs.readFileSync(path.join(__dirname, '..', folder, 'src/widget.css'), 'utf8');
    const rule = selector => new RegExp('(?:^|\\n)' + selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\{([^}]*)\\}').exec(css)?.[1];
    const upper = rule('.account-ring-upper-track'), lower = rule('.account-ring-lower-track');
    near(Number(/stroke-dasharray:([\d.]+) 100/.exec(upper)[1]), UPPER_SPAN, 'upper track length');
    near(Number(/stroke-dasharray:([\d.]+) 100/.exec(lower)[1]), LOWER_SPAN, 'lower track length');
    assert.doesNotMatch(upper, /stroke-dashoffset/, 'the track starts at its rotated origin');
    assert.doesNotMatch(lower, /stroke-dashoffset/);
    assert.doesNotMatch(css, /account-track svg\{[^}]*rotate:-90deg/, 'the whole drawing must not rotate');
    assert.match(rule('.account-ring-upper-value,.account-ring-lower-value'), /stroke:var\(--account-remaining\)/);
    assert.match(upper, /stroke:var\(--account-spent\)/);
    assert.match(css, /--account-spent:color-mix\(in srgb,var\(--theme-progress-end\) 15%,var\(--theme-track\)\)/);
    // The hollow refill marker: the pale slot is outlined on both edges and the
    // two ends are closed with radial caps, all in the remaining colour.
    const ghost = rule('.account-ring-ghost');
    assert.match(ghost, /stroke:var\(--account-remaining\)/);
    assert.match(ghost, /stroke-width:1\.15/);
    assert.match(ghost, /stroke-linecap:butt/);
    const source = loadRing(folder).source;
    assert.match(source, /\['upper', 'cap',/);
    assert.match(source, /\['lower', 'cap',/);
    // A cap connects the outer and inner rims at the same angle.
    const cap = /'M5\.36 7\.39 L7\.66 9\.32 M30\.64 7\.39 L28\.34 9\.32'/.test(source);
    assert.ok(cap, 'the upper caps must close the outline at both ends');
    assert.match(css, /\.account-cycle-pending \.account-ring-ghost-upper,\.account-weekly-pending \.account-ring-ghost-lower\{display:block\}/);
    assert.doesNotMatch(css, /account-ring-upper-ghost/, 'the dotted ghost must be gone');
    assert.match(rule('.account-core'), /rotate:45deg/);
    assert.match(css, /--account-core:#bfb8cf/);
  });
}
