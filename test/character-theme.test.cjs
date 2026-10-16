'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { builtinTheme, paletteForHue, themeFromPixels } = require('../src/character-theme.js');

function pixels(...groups) {
  return Uint8ClampedArray.from(groups.flatMap(([rgba, count]) => Array.from({ length: count }, () => rgba).flat()));
}

function rgb(hex) {
  return [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16));
}

function contrast(first, second) {
  const luminance = hex => rgb(hex).map(value => {
    const channel = value / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  }).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
  const values = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

test('curated themes are distinct, complete and safe to customize independently', () => {
  const mint = builtinTheme('mint-maid');
  const lilac = builtinTheme('lilac-dragon');
  assert.equal(mint['--theme-outline'], '#1d7e74');
  assert.equal(lilac['--theme-outline'], '#7860a6');
  assert.deepEqual(Object.keys(mint), Object.keys(lilac));
  assert.equal(Object.keys(mint).length, 19);
  for (const theme of [mint, lilac]) {
    for (const value of Object.values(theme)) assert.match(value, /^#[0-9a-f]{6}$/);
    for (const key of ['--theme-text', '--theme-accent', '--theme-muted']) {
      assert.ok(contrast(theme[key], theme['--theme-fill-end']) >= 4.5, `${key} stays readable`);
    }
  }
  mint['--theme-outline'] = '#000000';
  assert.equal(builtinTheme('mint-maid')['--theme-outline'], '#1d7e74');
  assert.equal(builtinTheme('unknown'), null);
  assert.equal(builtinTheme('__proto__'), null);
});

test('pale skin, white hair, gray outlines and transparent artifacts do not overpower lavender details', () => {
  const theme = themeFromPixels(pixels(
    [[246, 199, 177, 255], 3000],
    [[245, 244, 246, 255], 3000],
    [[42, 41, 43, 255], 1000],
    [[255, 0, 150, 0], 3000],
    [[0, 255, 255, 160], 3000],
    [[150, 105, 205, 255], 200],
    [[178, 136, 221, 255], 200],
  ));
  const [red, green, blue] = rgb(theme['--theme-outline']);
  assert.ok(blue > red && red > green, 'the detected theme is violet');
});

test('nearby blue shades form one dominant cluster instead of averaging with a red accent', () => {
  const theme = themeFromPixels(pixels(
    [[35, 100, 225, 255], 80],
    [[55, 75, 200, 255], 80],
    [[40, 120, 205, 255], 80],
    [[240, 20, 35, 255], 120],
  ));
  const [red, green, blue] = rgb(theme['--theme-outline']);
  assert.ok(blue > red * 1.5 && blue > green, 'the larger family of blue shades wins');
});

test('red hues on both sides of zero stay red rather than turning cyan', () => {
  const theme = themeFromPixels(pixels([[230, 15, 30, 255], 50], [[230, 30, 15, 255], 50]));
  const [red, green, blue] = rgb(theme['--theme-outline']);
  assert.ok(red > green * 1.5 && red > blue * 1.5);
});

test('neutral or empty images fall back to mint without throwing', () => {
  const mint = builtinTheme('mint-maid');
  assert.deepEqual(themeFromPixels(pixels([[255, 255, 255, 255], 10], [[25, 25, 25, 255], 10])), mint);
  assert.deepEqual(themeFromPixels(new Uint8ClampedArray()), mint);
  assert.deepEqual(themeFromPixels(null), mint);
  assert.deepEqual(themeFromPixels([255, 0, 100]), mint);
});

test('generated themes retain readable labels across the full hue wheel, including yellow', () => {
  for (let hue = 0; hue < 360; hue += 5) {
    const theme = paletteForHue(hue);
    assert.deepEqual(Object.keys(theme), Object.keys(builtinTheme('mint-maid')));
    for (const value of Object.values(theme)) assert.match(value, /^#[0-9a-f]{6}$/);
    for (const key of ['--theme-text', '--theme-accent', '--theme-muted', '--theme-toolbar-text']) {
      assert.ok(contrast(theme[key], theme['--theme-fill-end']) >= 4.5, `${key}, hue ${hue}`);
    }
  }
  assert.deepEqual(paletteForHue(-10), paletteForHue(350));
  assert.deepEqual(paletteForHue(720), paletteForHue(0));
});

test('the same helper loads as a standalone browser global without Node APIs', () => {
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/character-theme.js'), 'utf8'), context);
  assert.equal(typeof context.CharacterTheme.themeFromPixels, 'function');
  assert.equal(context.CharacterTheme.builtinTheme('lilac-dragon')['--theme-accent'], '#70529b');
});
