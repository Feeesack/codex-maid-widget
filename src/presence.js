'use strict';
// This layer only synchronizes final visibility; the host animates its child.
window.MaidPresence = {
  connect(maid, onVisibilityChange) {
    let revision = 0;
    function apply({ visible } = {}) {
      document.body.classList.toggle('presence-hidden', visible === false);
      document.body.inert = visible === false;
      if (visible === false) maid.pointerRegion(false);
      onVisibilityChange?.(visible !== false);
    }
    maid.onPresence?.(value => { revision++; apply(value); });
    return maid.getState().then(value => {
      const state = value.windowContainment;
      if (revision === 0) apply({ visible: !state?.enabled || state.visible, animate: false });
      return value;
    });
  },
};
