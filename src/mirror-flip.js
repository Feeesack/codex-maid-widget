(function (root, factory) {
  'use strict';
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MaidMirrorFlip = api;
})(typeof globalThis === 'object' ? globalThis : this, function (root) {
  'use strict';
  const controllers = new WeakMap();

  function create({ image, animate = root.Motion?.animate } = {}) {
    if (!image?.parentNode || !image.ownerDocument) throw new TypeError('A mounted character image is required');
    if (controllers.has(image)) return controllers.get(image);
    if (typeof animate !== 'function') throw new TypeError('Motion animate must be loaded before the mirror adapter');
    const character = image.parentNode;
    const plane = image.ownerDocument.createElement('div');
    plane.className = 'character-mirror-plane';
    plane.style.transform = 'scaleX(1)';
    character.insertBefore(plane, image);
    plane.appendChild(image);
    character.classList.add('mirror-flip-enabled');
    let mirrored = null, disposed = false, animation;
    const controller = {
      setMirrored(value, { initial = false } = {}) {
        if (disposed) return;
        const next = value === true;
        if (mirrored === next && !initial) return;
        const instant = mirrored === null || initial;
        mirrored = next;
        // Motion's documented stop() commits the current displayed WAAPI pose.
        // The next animate() starts there; the library owns all interpolation,
        // easing, cancellation and cleanup, without a second CSS transition.
        animation?.stop();
        animation = undefined;
        const transform = `scaleX(${next ? -1 : 1})`;
        if (instant) {
          plane.style.transform = transform;
        } else animation = animate(plane, { transform }, { duration: 0.22, ease: 'easeInOut' });
      },
      dispose() {
        if (disposed) return;
        disposed = true;
        animation?.stop();
        if (image.parentNode === plane && plane.parentNode) plane.parentNode.insertBefore(image, plane);
        plane.remove();
        character.classList.remove('mirror-flip-enabled');
        controllers.delete(image);
      },
    };
    controllers.set(image, controller);
    return controller;
  }
  return { create };
});
