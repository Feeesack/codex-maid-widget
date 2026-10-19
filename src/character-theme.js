(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CharacterTheme = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const FROST_GLASS_THEME = {
    '--theme-outline': '#64618b',
    '--theme-fill-start': '#ffffff',
    '--theme-fill-end': '#f5f5fc',
    '--theme-text': '#303048',
    '--theme-accent': '#514d78',
    '--theme-muted': '#6b6885',
    '--theme-track': '#e6e5f1',
    '--theme-progress-start': '#b3b1de',
    '--theme-progress-end': '#7773ac',
    '--theme-pill': '#ebebf8',
    '--theme-pill-hover': '#ddddf1',
    '--theme-soft': '#fbfbff',
    '--theme-toolbar-border': '#ddddec',
    '--theme-toolbar-text': '#625f86',
    '--theme-notice': '#303046',
    '--theme-quota-base': '#514d7c',
    '--theme-quota-mid': '#8580b8',
    '--theme-quota-deep': '#403c65',
    '--theme-quota-glow': '#d2d0f3',
  };
  const BUILT_INS = {
    'frost-glass-idle': FROST_GLASS_THEME,
    'frost-glass-cheek': FROST_GLASS_THEME,
    'mint-maid': {
      '--theme-outline': '#1d7e74',
      '--theme-fill-start': '#ffffff',
      '--theme-fill-end': '#f4fffb',
      '--theme-text': '#23433f',
      '--theme-accent': '#157469',
      '--theme-muted': '#54796f',
      '--theme-track': '#e3eee9',
      '--theme-progress-start': '#8ad9bf',
      '--theme-progress-end': '#26897a',
      '--theme-pill': '#e4f2ec',
      '--theme-pill-hover': '#cce8dc',
      '--theme-soft': '#f9fffc',
      '--theme-toolbar-border': '#d6e9e0',
      '--theme-toolbar-text': '#418b7b',
      '--theme-notice': '#183f36',
      '--theme-quota-base': '#12675e',
      '--theme-quota-mid': '#2d9e87',
      '--theme-quota-deep': '#0d5b57',
      '--theme-quota-glow': '#97ddbc',
    },
    'lilac-dragon': {
      '--theme-outline': '#7860a6',
      '--theme-fill-start': '#ffffff',
      '--theme-fill-end': '#f8f3ff',
      '--theme-text': '#433457',
      '--theme-accent': '#70529b',
      '--theme-muted': '#76628d',
      '--theme-track': '#eae2f1',
      '--theme-progress-start': '#c1a8e2',
      '--theme-progress-end': '#8a67b8',
      '--theme-pill': '#efe6f8',
      '--theme-pill-hover': '#e3d3f1',
      '--theme-soft': '#fcf9ff',
      '--theme-toolbar-border': '#e4d9ed',
      '--theme-toolbar-text': '#8062a5',
      '--theme-notice': '#352543',
      '--theme-quota-base': '#65428e',
      '--theme-quota-mid': '#9a6cb8',
      '--theme-quota-deep': '#513372',
      '--theme-quota-glow': '#ddc1f1',
    },
  };

  function builtinTheme(id) {
    return Object.prototype.hasOwnProperty.call(BUILT_INS, id) ? { ...BUILT_INS[id] } : null;
  }

  function hsl(hue, saturation, lightness) {
    const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
    const section = hue / 60;
    const second = chroma * (1 - Math.abs(section % 2 - 1));
    const channels = section < 1 ? [chroma, second, 0]
      : section < 2 ? [second, chroma, 0]
        : section < 3 ? [0, chroma, second]
          : section < 4 ? [0, second, chroma]
            : section < 5 ? [second, 0, chroma] : [chroma, 0, second];
    const offset = lightness - chroma / 2;
    return '#' + channels.map(value => Math.round((value + offset) * 255).toString(16).padStart(2, '0')).join('');
  }

  function luminance(hex) {
    const values = [1, 3, 5].map(index => {
      const value = parseInt(hex.slice(index, index + 2), 16) / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * values[0] + 0.7152 * values[1] + 0.0722 * values[2];
  }

  function contrast(first, second) {
    const a = luminance(first);
    const b = luminance(second);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  }

  function paletteForHue(value) {
    const hue = Number.isFinite(value) ? ((value % 360) + 360) % 360 : 170;
    const fill = hsl(hue, 0.55, 0.97);
    const color = (saturation, lightness) => hsl(hue, saturation, lightness);
    // Yellow and cyan need darker text than violet at the same HSL lightness.
    const readable = (saturation, initialLightness, minimum = 4.5) => {
      let lightness = initialLightness;
      let result = color(saturation, lightness);
      while (lightness > 0.08 && contrast(result, fill) < minimum) {
        lightness -= 0.01;
        result = color(saturation, lightness);
      }
      return result;
    };
    return {
      '--theme-outline': readable(0.35, 0.43),
      '--theme-fill-start': color(0.35, 0.995),
      '--theme-fill-end': fill,
      '--theme-text': readable(0.28, 0.24, 7),
      '--theme-accent': readable(0.42, 0.34),
      '--theme-muted': readable(0.20, 0.40),
      '--theme-track': color(0.20, 0.91),
      '--theme-progress-start': color(0.45, 0.70),
      '--theme-progress-end': color(0.42, 0.43),
      '--theme-pill': color(0.34, 0.93),
      '--theme-pill-hover': color(0.36, 0.87),
      '--theme-soft': color(0.50, 0.985),
      '--theme-toolbar-border': color(0.30, 0.88),
      '--theme-toolbar-text': readable(0.34, 0.39),
      '--theme-notice': color(0.32, 0.20),
      '--theme-quota-base': readable(0.46, 0.31),
      '--theme-quota-mid': readable(0.47, 0.43, 3),
      '--theme-quota-deep': readable(0.48, 0.26),
      '--theme-quota-glow': color(0.52, 0.76),
    };
  }

  function themeFromPixels(pixels) {
    if (!pixels || !Number.isFinite(pixels.length) || pixels.length < 4) return builtinTheme('frost-glass-cheek');
    const buckets = new Float64Array(36);
    const candidates = [];
    for (let index = 0; index + 3 < pixels.length; index += 4) {
      const alpha = pixels[index + 3] / 255;
      // Ignore cutout edges, including their sometimes vivid stray pixels.
      if (alpha < 0.82) continue;
      const red = pixels[index] / 255;
      const green = pixels[index + 1] / 255;
      const blue = pixels[index + 2] / 255;
      const max = Math.max(red, green, blue);
      const min = Math.min(red, green, blue);
      const chroma = max - min;
      const saturation = max > 0 ? chroma / max : 0;
      const lightness = (max + min) / 2;
      // White hair, gray clothing and dark outlines do not define the theme.
      if (max < 0.23 || chroma < 0.075 || saturation < 0.16 || lightness > 0.94) continue;
      let hue = max === red ? 60 * (((green - blue) / chroma) % 6)
        : max === green ? 60 * ((blue - red) / chroma + 2) : 60 * ((red - green) / chroma + 4);
      hue = (hue + 360) % 360;
      // Pale warm skin otherwise outweighs eye, ribbon and clothing colors.
      if (hue <= 55 && saturation <= 0.67 && max >= 0.5 && red >= green && green >= blue) continue;
      const weight = chroma ** 0.8 * saturation ** 0.65 * alpha ** 2 * (1 - Math.abs(lightness - 0.55) * 0.6);
      buckets[Math.floor(hue / 10)] += weight;
      candidates.push({ hue, weight });
    }
    if (!candidates.length) return builtinTheme('frost-glass-cheek');

    // Cluster nearby shades rather than averaging unrelated hues into mud.
    let best = 0;
    let bestScore = -1;
    for (let index = 0; index < buckets.length; index++) {
      const at = offset => buckets[(index + offset + buckets.length) % buckets.length];
      const score = at(0) + (at(-1) + at(1)) * 0.85 + (at(-2) + at(2)) * 0.5;
      if (score > bestScore) { best = index; bestScore = score; }
    }
    const center = best * 10 + 5;
    let x = 0;
    let y = 0;
    for (const candidate of candidates) {
      const difference = Math.abs(((candidate.hue - center + 540) % 360) - 180);
      if (difference > 30) continue;
      const angle = candidate.hue * Math.PI / 180;
      x += Math.cos(angle) * candidate.weight;
      y += Math.sin(angle) * candidate.weight;
    }
    return paletteForHue(Math.atan2(y, x) * 180 / Math.PI);
  }

  return { builtinTheme, paletteForHue, themeFromPixels };
});
