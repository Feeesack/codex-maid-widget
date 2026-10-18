'use strict';
/*
 * Adapted from Codex-Whale-Public, desktop/visibility.cjs:
 * https://github.com/Yang-huai406/Codex-Whale-Public
 *
 * MIT License
 * Copyright (c) 2026 MeteorNOX
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

// A native owner/child can lose its mapped surface while Electron still reports
// it visible. Keep the reference's cancellable 40-ms remap at lifecycle boundaries
// and its settled native watchdog. Ordinary geometry/heartbeat updates are inert.
// The injected state and timers make this independent of Electron and user data.
function createVisibilityController({ getWindow, getState, onShown = () => {}, onVisibility = () => {},
  schedule = setTimeout, cancel = clearTimeout, delayMs = 40, now = Date.now,
  settleMs = 1500, hiddenMs = 250, maxNativeAttempts = 3 } = {}) {
  if (typeof getWindow !== 'function' || typeof getState !== 'function') throw new TypeError('Window and state getters are required');
  let pending = null, generation = 0, disposed = false, desired = null, currentWindow = null;
  let shown = false, recover = false, hostKey = null, revision = null, remaps = 0;
  let shownAt = -Infinity, hiddenSince = null, nativeAttempts = 0, lastFailure = null;
  const wants = state => !state.quitting && state.ready === true && !state.manuallyHidden &&
    (typeof state.desiredVisible === 'boolean' ? state.desiredVisible : state.standalone ||
      (state.host?.hostAlive !== false && state.host?.visible && (state.fixture || state.host?.attached) && !state.host?.modal));
  const key = state => state.standalone ? 'standalone' : String(state.host?.hostPid ?? '') + ':' + String(state.host?.window ?? '');
  const epoch = state => !state.standalone && Number.isSafeInteger(state.host?.visibilityRevision) ? state.host.visibilityRevision : null;
  const alive = window => window && !window.isDestroyed();
  function clear() { generation++; if (pending !== null) cancel(pending); pending = null; }
  function syncVisibility(visible, force = false) {
    if (desired === visible && !force) return;
    desired = visible;
    try { onVisibility(visible); } catch { lastFailure = 'renderer-sync'; }
  }
  function hide(window) {
    try { window.hide(); return true; } catch { lastFailure = 'hide'; return false; }
  }
  function show(window, remap) {
    // Clear before show: its synchronous show event may call update().
    recover = false; shown = true; shownAt = now(); hiddenSince = null;
    try {
      window.showInactive();
      onShown();
      syncVisibility(true, true);
      if (remap) remaps++;
      lastFailure = null;
    } catch {
      recover = true; lastFailure = 'show';
      hide(window);
    }
  }
  function update() {
    if (disposed) return;
    const window = getWindow(), state = getState() || {};
    if (!alive(window)) { clear(); syncVisibility(false); return; }
    if (window !== currentWindow) {
      clear(); currentWindow = window; shown = false; recover = false;
      hostKey = null; revision = null; hiddenSince = null; nativeAttempts = 0;
    }
    const next = !!wants(state), nextKey = key(state), nextRevision = epoch(state);
    const changed = (hostKey !== null && hostKey !== nextKey) ||
      (revision !== null && nextRevision !== null && revision !== nextRevision);
    if (hostKey !== nextKey) { hiddenSince = null; nativeAttempts = 0; }
    hostKey = nextKey; revision = nextRevision;
    if (changed && shown) { recover = true; clear(); }
    if (!next) {
      clear();
      if (desired !== false || window.isVisible()) hide(window);
      if (shown) recover = true;
      syncVisibility(false);
      return;
    }
    if (desired === false && shown) recover = true;
    syncVisibility(true);
    if (pending !== null) return;
    if (shown && !window.isVisible()) recover = true;
    if (recover) {
      hide(window);
      const ticket = ++generation, targetKey = hostKey, targetRevision = revision;
      pending = schedule(() => {
        if (disposed || ticket !== generation) return;
        pending = null;
        if (window !== getWindow() || !alive(window)) { update(); return; }
        const current = getState() || {};
        if (!wants(current) || key(current) !== targetKey || epoch(current) !== targetRevision) { update(); return; }
        show(window, true);
      }, delayMs);
    } else if (!shown || !window.isVisible()) show(window, false);
  }
  function requestRecovery() {
    if (disposed) return;
    // Coalesce explicit requests during a pending remap, including show events.
    recover = true;
    update();
  }
  function observeNativeVisibility() {
    if (disposed) return false;
    const state = getState() || {}, time = now();
    const nativeHidden = state.host?.widgetVisible === false || state.host?.widgetAboveHost === false;
    if (pending !== null || !shown || !desired || !wants(state) || state.standalone ||
        time - shownAt < settleMs || !nativeHidden) {
      hiddenSince = null;
      // An IsWindowVisible=true sample does not prove health when the surface
      // is underneath the host. Only a non-conflicting positive sample resets
      // the bounded retry allowance.
      if (!nativeHidden && (state.host?.widgetVisible === true || state.host?.widgetAboveHost === true)) nativeAttempts = 0;
      return false;
    }
    if (hiddenSince === null) { hiddenSince = time; return false; }
    if (time - hiddenSince < hiddenMs || nativeAttempts >= maxNativeAttempts) return false;
    nativeAttempts++; hiddenSince = null;
    requestRecovery();
    return true;
  }
  function rendererReady() {
    if (disposed) return;
    // Reapply the final, non-animated renderer state even if desired did not
    // change while Chromium reloaded. A visible renderer also gets the same
    // native remap used for explicit show and owner/host lifecycle changes.
    syncVisibility(!!wants(getState() || {}), true);
    requestRecovery();
  }
  return {
    update, requestRecovery, observeNativeVisibility, rendererReady,
    dispose() { disposed = true; clear(); },
    snapshot: () => ({ desired, pending: pending !== null, remaps, nativeAttempts, lastFailure }),
  };
}

module.exports = { createVisibilityController };
