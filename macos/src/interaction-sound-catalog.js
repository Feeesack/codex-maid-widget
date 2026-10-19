// Shared, lightweight preset labels. Audio bytes live in interaction-samples.js.
(function (root, factory) {
  'use strict';
  const catalog = factory();
  if (typeof module === 'object' && module.exports) module.exports = catalog;
  else root.MaidInteractionCatalog = catalog;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const presets = [
    { id: 'bubble-pop', label: '气泡轻弹', description: '当前默认：圆润短促的气泡声，轻巧活泼。' },
    { id: 'soft-spring', label: '轻柔弹簧', description: '按下收缩、抬起上扬，柔和衔接。' },
    { id: 'original', label: '经典啾啾', description: '保留最初的上扬短音，按原有音高和包络拆成两段。' },
    { id: 'wood-tap', label: '木质轻敲', description: '温暖干净的木质敲击，按下与抬起各有轻重。' },
    { id: 'dsh-original', label: 'DSH 小黄鸭', description: '原 DSH 小黄鸭按下／抬起音效。', separateBank: true },
  ].map(preset => Object.freeze(preset));
  return Object.freeze({ defaultId: 'bubble-pop', presets: Object.freeze(presets) });
});
