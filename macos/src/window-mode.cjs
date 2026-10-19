'use strict';
const { WindowContainmentController } = require('./window-containment.cjs');
const { CodexWindowProvider, nativeHandleId } = require('./codex-window.cjs');
const { createVisibilityController } = require('./window-visibility.cjs');
const { WindowTopmostController } = require('./window-topmost.cjs');

function normalizedSnapshot(value, { screen, previousHost, widgetPid = process.pid } = {}) {
  if (value?.known !== true || !Array.isArray(value.windows)) return { known: false, supported: value?.supported !== false };
  const windows = value.windows.filter(item => item.mainWindow !== false && !item.toolWindow && !item.ownerId && item.windowClass !== '#32770');
  let host = windows.find(item => item.id === value.foregroundWindow)
    || windows.find(item => item.foreground)
    || windows.find(item => item.id === value.foregroundRoot)
    || windows.find(item => item.id === previousHost)
    || windows.find(item => item.visible && !item.minimized && !item.cloaked)
    || windows.find(item => item.minimized && item.bounds?.width > 0 && item.bounds?.height > 0);
  if (value.foregroundWindowIsGuess && host) {
    // CoreGraphics orders panels and main windows together, unlike HWND's
    // explicit foreground/owner APIs. A nested panel must retain the outer
    // main surface. This uses geometry only, without Accessibility prompts.
    const nested = (a, b) => a.pid === b.pid && a.id !== b.id && a.bounds.x >= b.bounds.x && a.bounds.y >= b.bounds.y &&
      a.bounds.x + a.bounds.width <= b.bounds.x + b.bounds.width && a.bounds.y + a.bounds.height <= b.bounds.y + b.bounds.height &&
      a.bounds.width * a.bounds.height < b.bounds.width * b.bounds.height * 0.9;
    const previous = windows.find(item => item.id === previousHost);
    if (previous && nested(host, previous)) host = previous;
    else host = windows.filter(item => nested(host, item)).sort((a, b) => b.bounds.width * b.bounds.height - a.bounds.width * a.bounds.height)[0] || host;
  }
  if (!host) return { known: true, supported: value.supported !== false, host: null, foreground: 'other' };
  let bounds;
  try {
    bounds = value.coordinateSpace === 'physical-pixels' ? screen.screenToDipRect(null, host.bounds) : { ...host.bounds };
  } catch { return { known: false, supported: value.supported !== false }; }
  // Leave room for native enclosing-rectangle rounding at fractional DPI.
  // The whole transparent widget, including its bubble, remains inside Codex.
  const clientBounds = { x: bounds.x + 2, y: bounds.y + 2, width: bounds.width - 4, height: bounds.height - 4 };
  const foreground = value.foregroundPid === widgetPid ? 'widget'
    : host.foreground || value.foregroundWindow === host.id || value.foregroundRoot === host.id || value.foregroundPid === host.pid ? 'host' : 'other';
  return { known: true, supported: value.supported !== false, foreground,
    host: { id: host.id, pid: host.pid, dpi: host.dpi, widgetParented: host.widgetParented, widgetAboveHost: host.widgetAboveHost, clientBounds, visible: host.visible, minimized: host.minimized,
      cloaked: host.cloaked, modal: host.modal === true, onCurrentDesktop: host.visible && !host.cloaked } };
}

class CodexWindowMode {
  constructor({ widget, screen, getSize, onStatus = () => {}, onRecreate = () => {}, platform = process.platform,
    providerFactory = () => new CodexWindowProvider({ widgetHandle: widget.getNativeWindowHandle() }),
    topmostProviderFactory = () => new CodexWindowProvider({ widgetHandle: widget.getNativeWindowHandle() }),
    intervalMs = platform === 'darwin' ? 500 : 100, staleAfterMs = platform === 'darwin' ? 2500 : 1800 } = {}) {
    Object.assign(this, { widget, screen, getSize, platform, providerFactory, intervalMs, staleAfterMs, onStatus, onRecreate });
    this.provider = null; this.timer = null; this.staleTimers = new Set(); this.epoch = 0;
    this.hostId = null; this.statusKey = ''; this.closed = false; this.embedded = false;
    this.geometryReady = true; this.rendererLoaded = !widget.webContents?.on;
    this.nativeShown = false; this.lastProjected = null; this.raw = null; this.host = null;
    this.binding = Promise.resolve(); this.bindingRevision = 0; this.recreating = false;
    this.preferences = {};
    this.topmost = new WindowTopmostController({ widget, platform, providerFactory: topmostProviderFactory, onStatus: () => this.publish() });
    this.surface = {
      isDestroyed: () => widget.isDestroyed?.() === true,
      isVisible: () => this.embedded ? this.nativeShown : widget.isVisible(),
      hide: () => { widget.hide(); this.nativeShown = false; },
      showInactive: () => {
        if (this.enabled) widget.showInactive(); else { widget.show(); widget.moveTop(); }
        this.nativeShown = true;
      },
    };
    this.createVisibility = () => createVisibilityController({
      getWindow: () => this.surface,
      getState: () => this.visibilityState(),
      onVisibility: visible => this.presence(visible),
      onShown: () => {
        if (!this.enabled) return;
        if (this.embedded) { if (this.lastProjected) this.project(this.lastProjected); }
        else widget.moveAbove('window:' + this.hostId + ':0');
      },
    });
    this.visibility = this.createVisibility();
    this.controller = new WindowContainmentController({
      getBounds: () => this.embedded && this.lastProjected ? { ...this.lastProjected } : widget.getBounds(), getSize,
      setBounds: bounds => {
        if (this.embedded) this.project(bounds); else widget.setBounds(bounds);
      },
      show: () => {
        if (this.enabled) this.visibility.update();
        else { this.presence(true); widget.show(); widget.moveTop(); this.nativeShown = true; }
      },
      hide: () => {
        if (this.enabled) this.visibility.update();
        else { this.presence(false); widget.hide(); this.nativeShown = false; }
      },
      onVisibilityChanged: () => this.publish(),
      // The mode owns the native barrier. The containment state only describes
      // geometry/visibility and cannot issue independent topmost writes.
      setAlwaysOnTop: () => {},
      onHostChanged: host => this.changeHost(host),
    });
    this.loaded = () => {
      if (this.closed) return;
      this.rendererLoaded = true; this.controller.refreshSize();
      if (this.enabled) this.visibility.rendererReady();
      else this.presence(!this.controller.manualHidden);
      this.publish();
    };
    widget.webContents?.on?.('did-finish-load', this.loaded);
  }
  get enabled() { return this.controller.enabled; }
  visibilityState() {
    const state = this.controller?.getState();
    const host = this.host;
    const effective = host?.visible && !host.minimized && !host.cloaked;
    return { ready: this.rendererLoaded && this.geometryReady, quitting: this.closed,
      manuallyHidden: state?.manualHidden === true, standalone: !state?.enabled,
      // A child retains its visible style throughout the parent's OS animation.
      desiredVisible: this.controller?.visible === true,
      host: { window: this.hostId, hostPid: host?.pid, hostAlive: !!host, visible: effective,
        attached: this.controller?.ownerReady === true,
        widgetVisible: effective ? this.raw?.widgetVisible : undefined,
        widgetAboveHost: effective ? host?.widgetAboveHost : undefined } };
  }
  getState() {
    const { enabled, manualHidden, visible, reason, supported } = this.controller.getState();
    const failed = enabled && this.visibility.snapshot().lastFailure === 'show';
    const topmost = this.topmost.getState();
    return { supported: ['win32', 'darwin'].includes(this.platform) && supported, enabled, manualHidden,
      visible: visible && reason !== 'host-hidden' && this.geometryReady && !failed,
      reason: failed ? 'placement-unavailable' : !enabled && topmost.reason === 'topmost-unavailable' ? topmost.reason : reason,
      embedded: enabled && this.embedded, topmost };
  }
  presence(visible) { this.widget.webContents?.send?.('presence', { visible, animate: false }); }
  publish() {
    if (this.enabled) { this.visibility.update(); this.visibility.observeNativeVisibility(); }
    const key = JSON.stringify(this.getState());
    if (key !== this.statusKey) { this.statusKey = key; this.onStatus(); }
  }
  recreate() {
    if (this.closed || this.recreating) return;
    this.recreating = true; this.geometryReady = false;
    try { this.onRecreate(); } catch {}
  }
  project(bounds) {
    this.lastProjected = { ...bounds };
    const provider = this.provider, id = this.hostId, revision = this.bindingRevision;
    if (!provider || !id || !this.embedded) return;
    let physical;
    try { physical = this.screen.dipToScreenRect(null, bounds); }
    catch { this.geometryReady = false; this.controller.ownerError = true; this.publish(); return; }
    Promise.resolve(provider.positionChild(this.widget.getNativeWindowHandle(), id, physical)).then(result => {
      if (this.closed || revision !== this.bindingRevision || id !== this.hostId) return;
      if (result?.known === true && result.ok === true) {
        if (!this.geometryReady) { this.geometryReady = true; this.publish(); }
      } else {
        this.geometryReady = false; this.controller.ownerError = true; this.publish();
        if (result?.reason === 'child-style-unavailable') this.recreate();
      }
    }, () => { if (!this.closed && revision === this.bindingRevision) { this.geometryReady = false; this.controller.ownerError = true; this.publish(); } });
  }
  changeHost(host) {
    const id = host?.id || null, revision = ++this.bindingRevision;
    this.hostId = id;
    this.controller.lastBounds = null;
    const provider = this.provider;
    if (!this.embedded) { if (host) this.widget.moveAbove('window:' + id + ':0'); return true; }
    this.geometryReady = false;
    if (this.widget.isDestroyed?.()) return false;
    const handle = this.widget.getNativeWindowHandle();
    const task = this.binding.then(async () => {
      if (id) {
        await this.topmost.settled();
        if (this.closed || revision !== this.bindingRevision || !this.topmost.getState().verified) return { known: true, ok: false };
      }
      return id ? provider.attachChild(handle, id) : provider.detachChild(handle);
    });
    this.binding = task.catch(() => {});
    return task.then(result => {
      const ok = result?.known === true && result.ok === true;
      if (revision === this.bindingRevision && !this.closed) {
        if (!id && ok) {
          // Losing a host while the option stays enabled is a temporary
          // detach, not a transition to a globally topmost desktop surface.
          this.embedded = this.enabled;
          this.geometryReady = true; this.lastProjected = null;
          // The cached native ExStyle has now been restored. Reassert both
          // Electron intent and native topmost only after its detach ACK.
          if (!this.enabled) this.topmost.configure({ contained: false, ...this.preferences });
        }
        if (!ok && (!id || result?.reason === 'child-style-unavailable')) this.recreate();
      }
      return ok;
    }, () => false);
  }
  configure(enabled, preferences) {
    enabled = enabled === true && !this.closed;
    this.preferences = { ...this.preferences, ...preferences };
    if (enabled === this.enabled) {
      this.topmost.configure({ contained: enabled || this.embedded, ...this.preferences });
      this.controller.setEnabled(enabled, preferences); this.controller.refreshSize(); this.publish(); return;
    }
    const epoch = ++this.epoch;
    // An older detach still completes, but cannot change a newly enabled mode.
    this.bindingRevision++;
    clearTimeout(this.timer); this.timer = null;
    for (const timer of this.staleTimers) clearTimeout(timer); this.staleTimers.clear();
    if (enabled) {
      this.topmost.configure({ contained: true, ...this.preferences });
      this.visibility.dispose(); this.visibility = this.createVisibility();
      try { this.provider = this.providerFactory(); }
      catch { this.controller.setEnabled(true, preferences); this.controller.update({ known: false }); this.publish(); return; }
      this.embedded = this.platform === 'win32' && typeof this.provider.attachChild === 'function';
      this.geometryReady = !this.embedded; this.lastProjected = null;
      this.controller.setEnabled(true, preferences);
      void this.tick(epoch, this.provider);
    } else {
      this.visibility.dispose();
      const provider = this.provider;
      this.controller.setEnabled(false, preferences);
      if (!this.embedded) this.topmost.configure({ contained: false, ...this.preferences });
      if (this.embedded) this.binding.finally(() => { provider?.close(); if (this.provider === provider) this.provider = null; });
      else { provider?.close(); if (this.provider === provider) this.provider = null; }
    }
    this.publish();
  }
  async tick(epoch, provider) {
    const started = Date.now();
    const stale = setTimeout(() => {
      if (!this.closed && this.enabled && epoch === this.epoch && provider === this.provider) {
        this.controller.update({ known: false }); this.publish();
      }
    }, this.staleAfterMs);
    this.staleTimers.add(stale);
    try {
      let value; try { value = await provider.query(); } catch { value = { known: false }; }
      if (this.closed || !this.enabled || epoch !== this.epoch || provider !== this.provider) return;
      this.raw = value;
      // A restarted native worker no longer owns the original top-level
      // styles. Recreate our surface instead of guessing them on detach.
      if (this.embedded && value?.known === true && value.widgetParented === true && value.widgetStyleCached === false) {
        this.recreate(); return;
      }
      const snapshot = normalizedSnapshot(value, { screen: this.screen, previousHost: this.controller.getState().hostId });
      if (this.host?.dpi !== snapshot.host?.dpi) this.controller.lastBounds = null;
      this.host = snapshot.host || null;
      snapshot.embedded = this.embedded;
      this.controller.update(snapshot); this.publish();
      if (this.embedded && this.geometryReady && this.nativeShown && this.host?.visible &&
          !this.host.minimized && !this.host.cloaked && this.host.widgetAboveHost === false && this.lastProjected) this.project(this.lastProjected);
    } catch {
      if (!this.closed && this.enabled && epoch === this.epoch && provider === this.provider) { this.controller.update({ known: false }); this.publish(); }
    } finally {
      clearTimeout(stale); this.staleTimers.delete(stale);
      if (!this.closed && this.enabled && epoch === this.epoch && provider === this.provider) this.timer = setTimeout(() => { void this.tick(epoch, provider); }, Math.max(20, this.intervalMs - (Date.now() - started)));
    }
  }
  getArea() { return this.controller.getArea(); }
  getBounds() { return this.embedded && this.lastProjected ? { ...this.lastProjected } : this.widget.getBounds(); }
  moveTo(x, y) { return this.controller.moveTo(x, y); }
  refreshSize() { this.controller.refreshSize(); this.publish(); }
  show() { this.controller.setManualHidden(false); this.topmost.recover(); if (this.enabled) this.visibility.requestRecovery(); this.publish(); }
  hide() { this.controller.setManualHidden(true); this.publish(); }
  close() {
    if (this.closed) return;
    this.closed = true; this.epoch++; this.bindingRevision++;
    this.controller.close();
    this.topmost.close();
    this.visibility.dispose();
    try { this.widget.webContents?.removeListener?.('did-finish-load', this.loaded); } catch {}
    clearTimeout(this.timer); for (const timer of this.staleTimers) clearTimeout(timer); this.staleTimers.clear();
    const provider = this.provider; this.provider = null;
    if (this.embedded && provider && !this.widget.isDestroyed?.()) {
      const handle = this.widget.getNativeWindowHandle();
      this.binding.then(() => provider.detachChild(handle)).finally(() => provider.close());
    } else provider?.close();
  }
}

module.exports = { CodexWindowMode, normalizedSnapshot, nativeHandleId };
