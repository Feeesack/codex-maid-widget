(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MaidInputFocus = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  function connect({ window, document, maid }) {
    if (typeof maid?.setWidgetInputActive !== 'function') return { dispose() {} };
    const editable = target => target?.closest?.('textarea,input:not([type=button]):not([type=submit]):not([type=checkbox]):not([type=radio]),[contenteditable="true"]');
    let active = null, pending = false, revision = 0, composing = false, disposed = false, keyboardIntent = false;
    const release = () => {
      if (!active) return;
      active = null; pending = false; composing = false; keyboardIntent = false; revision++;
      void Promise.resolve(maid.setWidgetInputActive(false, 'blur')).catch(() => {});
    };
    const begin = (target, from) => {
      if (disposed || !target) return;
      // The embedded Windows child can receive a renderer-level `blur` while
      // its host remains the foreground window. Keep the lease and reassert
      // the native child focus when the user clicks the editor again.
      if (active && !pending) {
        active = target;
        if (from !== 'pointer' && from !== 'focus') return;
      } else if (active) {
        active = target;
        return;
      } else {
        active = target;
      }
      pending = true;
      const at = ++revision;
      void Promise.resolve(maid.setWidgetInputActive(true, from)).then(ready => {
        if (disposed || revision !== at || !active) return;
        pending = false;
        if (ready === false) { release(); return; }
        // Reassert DOM focus only once, after the native detach. Never reset a
        // selection or interrupt an already-running IME composition.
        if (!composing && document.activeElement !== active) active.focus({ preventScroll: true });
      }, () => { if (revision === at) release(); });
    };
    const pointer = event => { keyboardIntent = false; const target = editable(event.target); if (target) begin(target, 'pointer'); else release(); };
    const key = event => { keyboardIntent = event.key === 'Tab'; };
    const focus = event => { const fromKeyboard = keyboardIntent; keyboardIntent = false; if (fromKeyboard) begin(editable(event.target), 'focus'); };
    const out = event => {
      if (!active) return;
      if (editable(event.relatedTarget)) { active = editable(event.relatedTarget); return; }
      // Native reparenting may emit a transient blur before its acknowledgement.
      // The main process checks native foreground, cursor and other windows.
      if (pending || composing) return;
      release();
    };
    const compositionStart = () => { composing = true; };
    // The embedded child can report document.hasFocus() === false while its
    // Codex host remains the foreground window. A composition ending is not a
    // focus transition; focusout/pointerdown handles the real release.
    const compositionEnd = () => { composing = false; };
    document.addEventListener('pointerdown', pointer, true);
    document.addEventListener('keydown', key, true);
    document.addEventListener('focusin', focus);
    document.addEventListener('focusout', out);
    document.addEventListener('compositionstart', compositionStart);
    document.addEventListener('compositionend', compositionEnd);
    return { dispose() {
      disposed = true; release();
      document.removeEventListener('pointerdown', pointer, true);
      document.removeEventListener('keydown', key, true);
      document.removeEventListener('focusin', focus);
      document.removeEventListener('focusout', out);
      document.removeEventListener('compositionstart', compositionStart);
      document.removeEventListener('compositionend', compositionEnd);
    } };
  }
  return { connect };
});
