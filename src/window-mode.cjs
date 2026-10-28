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
    allowNativeChild = true,
    providerFactory = () => new CodexWindowProvider({ widgetHandle: widget.getNativeWindowHandle() }),
    topmostProviderFactory = () => new CodexWindowProvider({ widgetHandle: widget.getNativeWindowHandle() }),
    intervalMs = platform === 'darwin' ? 500 : 100, staleAfterMs = platform === 'darwin' ? 2500 : 1800 } = {}) {
    Object.assign(this, { widget, screen, getSize, platform, allowNativeChild, providerFactory, intervalMs, staleAfterMs, onStatus, onRecreate });
    this.provider = null; this.timer = null; this.staleTimers = new Set(); this.epoch = 0;
    this.hostId = null; this.statusKey = ''; this.closed = false; this.embedded = false; this.ownedLayerMode = false;
    this.geometryReady = true; this.rendererLoaded = !widget.webContents?.on;
    this.nativeShown = false; this.lastProjected = null; this.raw = null; this.host = null;
    this.lastKnownAt = null;
    this.binding = Promise.resolve(); this.bindingRevision = 0; this.recreating = false;
    this.layerRequest = null;
    this.inputDetached = false; this.inputRequested = false; this.inputRevision = 0; this.inputTransition = false;
    this.inputFocusTimer = null; this.inputFocusBusy = false;
    this.preferences = {};
    this.topmost = new WindowTopmostController({ widget, platform, providerFactory: topmostProviderFactory, onStatus: () => this.publish() });
    this.surface = {
      isDestroyed: () => widget.isDestroyed?.() === true,
      isVisible: () => this.nativeChild ? this.nativeShown : widget.isVisible(),
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
        if (this.nativeChild) { if (this.lastProjected) this.project(this.lastProjected); }
        else if (!this.ownedLayerMode && typeof this.provider?.stackAbove !== 'function') widget.moveAbove('window:' + this.hostId + ':0');
      },
    });
    this.visibility = this.createVisibility();
    this.controller = new WindowContainmentController({
      // A top-level follow window remains part of its host's visual scene
      // even when another application receives focus. Foreground only gates
      // z-order writes, never visibility of the entire pet.
      visibilityFollowsHost: platform === 'win32' && allowNativeChild === false,
      getBounds: () => this.nativeChild && this.lastProjected ? { ...this.lastProjected } : widget.getBounds(), getSize,
      setBounds: bounds => {
        if (this.nativeChild) this.project(bounds); else widget.setBounds(bounds);
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
  get nativeChild() { return this.embedded && !this.inputDetached; }
  visibilityState() {
    const state = this.controller?.getState();
    const host = this.host;
    const effective = host?.visible && !host.minimized && !host.cloaked;
    return { ready: this.rendererLoaded && this.geometryReady, quitting: this.closed,
      manuallyHidden: state?.manualHidden === true, standalone: !state?.enabled,
      // A child retains its visible style throughout the parent's OS animation.
      desiredVisible: this.controller?.visible === true,
      host: { window: this.hostId, hostPid: host?.pid, hostAlive: !!host, embedded: this.nativeChild, visible: effective,
        attached: this.controller?.ownerReady === true,
        // A top-level widget repairs z-order directly in tick(). Sending its
        // layering state to the remap watchdog would hide the entire surface
        // whenever activating Codex moves the host in front of it.
        widgetVisible: effective ? this.raw?.widgetVisible : undefined,
        widgetAboveHost: this.nativeChild && effective ? host?.widgetAboveHost : undefined } };
  }
  getState() {
    const { enabled, manualHidden, visible, reason, supported } = this.controller.getState();
    const failed = enabled && this.visibility.snapshot().lastFailure === 'show';
    const topmost = this.topmost.getState();
    const focusRoot = this.raw?.keyboardFocusRoot;
    const keyboardOwner = !focusRoot || focusRoot === '0' ? 'unknown' : focusRoot === this.hostId ? 'host'
      : !this.widget.isDestroyed?.() && focusRoot === nativeHandleId(this.widget.getNativeWindowHandle()) ? 'widget' : 'other';
    return { supported: ['win32', 'darwin'].includes(this.platform) && supported, enabled, manualHidden,
      visible: visible && reason !== 'host-hidden' && this.geometryReady && !failed,
      reason: failed ? 'placement-unavailable' : !enabled && topmost.reason === 'topmost-unavailable' ? topmost.reason : reason,
      embedded: enabled && this.nativeChild,
      owned: enabled && this.ownedLayerMode && this.raw?.widgetOwnedByHost === true && this.raw?.ownedHostId === this.hostId,
      keyboardOwner, topmost };
  }
  presence(visible) { this.widget.webContents?.send?.('presence', { visible, animate: false }); }
  publish() {
    if (this.enabled && !this.inputTransition) { this.visibility.update(); this.visibility.observeNativeVisibility(); }
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
    if (!provider || !id || !this.nativeChild || this.inputTransition) return;
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
  trackHostLayer() {
    const provider = this.provider, id = this.hostId, revision = this.bindingRevision, epoch = this.epoch;
    if (this.closed || !this.enabled || this.nativeChild || !id || typeof provider?.trackLayer !== 'function' ||
        this.widget.isDestroyed?.()) return Promise.resolve(false);
    if (this.layerRequest?.provider === provider && this.layerRequest.id === id) return this.layerRequest.promise;
    const handle = this.widget.getNativeWindowHandle();
    const slot = { provider, id, promise: null };
    const task = this.binding.catch(() => {}).then(async () => {
      await this.topmost.settled();
      if (this.closed || !this.enabled || this.nativeChild || this.widget.isDestroyed?.() ||
          provider !== this.provider || id !== this.hostId || revision !== this.bindingRevision || epoch !== this.epoch ||
          !this.topmost.getState().verified) return false;
      const result = await provider.trackLayer(handle, id);
      return result?.known === true && result.ok === true;
    });
    this.binding = task.catch(() => {});
    slot.promise = task.catch(() => false).finally(() => { if (this.layerRequest === slot) this.layerRequest = null; });
    this.layerRequest = slot;
    return slot.promise;
  }
  bindOwnedLayer(id, revision) {
    const provider = this.provider, epoch = this.epoch;
    if (!provider || this.widget.isDestroyed?.()) return Promise.resolve(false);
    const handle = this.widget.getNativeWindowHandle();
    const task = this.binding.catch(() => {}).then(async () => {
      if (id) {
        await this.topmost.settled();
        if (this.closed || !this.enabled || provider !== this.provider || revision !== this.bindingRevision ||
            epoch !== this.epoch || id !== this.hostId || !this.topmost.getState().verified) return false;
      }
      const result = await provider.bindLayer(handle, id);
      const ok = result?.known === true && result.ok === true;
      if (!this.closed && provider === this.provider && revision === this.bindingRevision && epoch === this.epoch) {
        if (!id && ok && !this.enabled) {
          this.ownedLayerMode = false;
          this.topmost.configure({ contained: false, ...this.preferences });
        }
        if (!ok && result?.reason === 'owner-cache-lost') this.recreate();
      }
      return ok;
    }).catch(() => false);
    this.binding = task;
    return task;
  }
  changeHost(host) {
    const id = host?.id || null, revision = ++this.bindingRevision;
    this.hostId = id;
    this.controller.lastBounds = null;
    const provider = this.provider;
    // An owned popup remains a real top-level window with its own activation
    // root. Windows keeps it above its owner atomically when either activates;
    // there is no foreground callback or late z-order repair in this mode.
    if (this.ownedLayerMode) return this.bindOwnedLayer(id, revision);
    if (!this.nativeChild) {
      if (typeof provider?.trackLayer === 'function' && !this.widget.isDestroyed?.()) {
        if (host) void this.trackHostLayer();
        else {
          const handle = this.widget.getNativeWindowHandle();
          this.binding = this.binding.catch(() => {}).then(() => provider.trackLayer(handle, null)).catch(() => {});
        }
      }
      if (host && typeof provider?.stackAbove !== 'function') this.widget.moveAbove('window:' + id + ':0');
      if (!this.enabled && this.inputDetached) {
        this.inputDetached = false; this.embedded = false;
        this.topmost.configure({ contained: false, ...this.preferences });
      }
      return true;
    }
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
      this.topmost.configure({ contained: enabled || this.embedded || this.ownedLayerMode, ...this.preferences });
      this.controller.setEnabled(enabled, preferences); this.controller.refreshSize(); this.publish(); return;
    }
    const epoch = ++this.epoch;
    this.inputRequested = false; this.inputRevision++; this.inputTransition = false; this.clearInputFocusTimer();
    this.lastKnownAt = null;
    // An older detach still completes, but cannot change a newly enabled mode.
    this.bindingRevision++;
    clearTimeout(this.timer); this.timer = null;
    for (const timer of this.staleTimers) clearTimeout(timer); this.staleTimers.clear();
    if (enabled) {
      this.topmost.configure({ contained: true, ...this.preferences });
      this.visibility.dispose(); this.visibility = this.createVisibility();
      try { this.provider = this.providerFactory(); }
      catch { this.controller.setEnabled(true, preferences); this.controller.update({ known: false }); this.publish(); return; }
      // The production Windows path deliberately keeps a normal top-level
      // surface. Cross-process Chromium HWND parenting can show a DOM caret
      // while the host editor still owns the Windows keyboard queue; a
      // contained, host-ordered window preserves follow geometry without that
      // ambiguity. Tests and controlled embedders can opt into the native
      // child protocol explicitly.
      this.embedded = this.allowNativeChild && this.platform === 'win32' && typeof this.provider.attachChild === 'function';
      this.ownedLayerMode = this.platform === 'win32' && this.allowNativeChild === false &&
        this.provider.ownedLayerSupported === true && typeof this.provider.bindLayer === 'function';
      this.inputDetached = false;
      this.geometryReady = !this.embedded; this.lastProjected = null;
      this.controller.setEnabled(true, preferences);
      void this.tick(epoch, this.provider);
    } else {
      this.visibility.dispose();
      const provider = this.provider;
      this.controller.setEnabled(false, preferences);
      if (!this.embedded && !this.ownedLayerMode) this.topmost.configure({ contained: false, ...this.preferences });
      if (this.embedded) {
        const handle = this.widget.getNativeWindowHandle(), focusHost = this.hostId;
        this.binding = this.binding.then(async () => {
          try { if (focusHost && typeof provider?.releaseChildFocus === 'function') await provider.releaseChildFocus(handle, focusHost); } catch {}
          return provider?.detachChild(handle);
        }).catch(() => {}).finally(() => { provider?.close(); if (this.provider === provider) this.provider = null; });
      }
      else {
        // changeHost(null) has queued the hook removal. Drain it before ending
        // this provider; a quick re-enable can already own a new provider.
        this.binding.finally(() => { provider?.close(); if (this.provider === provider) this.provider = null; });
      }
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
      if (this.ownedLayerMode) {
        // A fresh provider must not mistake the preceding provider's queued
        // owner restoration for a lost cache during rapid mode changes.
        await this.binding;
        if (this.closed || !this.enabled || epoch !== this.epoch || provider !== this.provider) return;
      }
      let value; try { value = await provider.query(); } catch { value = { known: false }; }
      // A slow layering write is not a stale host observation and must never
      // run the hide path after a good query has already completed.
      clearTimeout(stale); this.staleTimers.delete(stale);
      if (this.closed || !this.enabled || epoch !== this.epoch || provider !== this.provider) return;
      if (this.inputTransition) return;
      // A restarted native worker no longer owns the original top-level
      // styles. Recreate our surface instead of guessing them on detach.
      if (this.nativeChild && value?.known === true && value.widgetParented === true && value.widgetStyleCached === false) {
        this.recreate(); return;
      }
      if (this.ownedLayerMode && value?.known === true && value.widgetOwnedByHost === true && value.ownerBindingCached === false) {
        this.recreate(); return;
      }
      const snapshot = normalizedSnapshot(value, { screen: this.screen, previousHost: this.controller.getState().hostId });
      const now = Date.now();
      if (snapshot.known) this.lastKnownAt = now;
      else if (this.controller.visibilityFollowsHost && this.lastKnownAt !== null &&
          now >= this.lastKnownAt && now - this.lastKnownAt < this.staleAfterMs) {
        // One unqueryable observation during activation must not unmap a
        // healthy surface. Known host loss still hides immediately, and the
        // existing finite stale deadline bounds this last-known-state lease.
        return;
      }
      this.raw = value;
      if (this.host?.dpi !== snapshot.host?.dpi) this.controller.lastBounds = null;
      this.host = snapshot.host || null;
      snapshot.embedded = this.nativeChild;
      this.controller.update(snapshot); this.publish();
      if (!this.nativeChild && !this.ownedLayerMode && snapshot.host && value?.layerTracking === false) void this.trackHostLayer();
      if (this.inputDetached && !this.inputRequested && this.hostId) void this.setInputActive(false);
      if (this.nativeChild && this.geometryReady && this.nativeShown && this.host?.visible &&
          !this.host.minimized && !this.host.cloaked && this.host.widgetAboveHost === false && this.lastProjected) this.project(this.lastProjected);
      if (!this.nativeChild && !this.ownedLayerMode && this.platform === 'win32' && this.controller.getState().reason === 'contained' &&
          snapshot.foreground === 'host' && !this.host?.modal && this.host?.widgetAboveHost === false &&
          typeof provider.stackAbove === 'function') {
        // Activating Codex raises it over an unrelated top-level widget. Fix
        // only z-order; hide/show would discard editing focus and the native
        // write checks the current foreground again before it can reorder.
        try { await provider.stackAbove(this.widget.getNativeWindowHandle(), this.hostId); } catch {}
      }
    } catch {
      if (!this.closed && this.enabled && epoch === this.epoch && provider === this.provider) { this.controller.update({ known: false }); this.publish(); }
    } finally {
      clearTimeout(stale); this.staleTimers.delete(stale);
      if (!this.closed && this.enabled && epoch === this.epoch && provider === this.provider) this.timer = setTimeout(() => { void this.tick(epoch, provider); }, Math.max(20, this.intervalMs - (Date.now() - started)));
    }
  }
  getArea() { return this.controller.getArea(); }
  getBounds() { return this.nativeChild && this.lastProjected ? { ...this.lastProjected } : this.widget.getBounds(); }
  async canActivateInput() {
    const provider = this.provider, id = this.hostId, epoch = this.epoch, owner = this.bindingRevision;
    if (!provider || !id || this.closed || this.widget.isDestroyed?.() || !this.enabled || !this.inputRequested) return false;
    let value; try { value = await provider.query(); } catch { return false; }
    if (this.closed || this.widget.isDestroyed?.() || !this.enabled || !this.inputRequested || provider !== this.provider ||
        epoch !== this.epoch || owner !== this.bindingRevision || id !== this.hostId || value?.known !== true) return false;
    if (value.windows?.find(host => host.id === id)?.modal === true) return false;
    const widgetId = nativeHandleId(this.widget.getNativeWindowHandle());
    // The pointer can remain stationary while Alt+Tab changes applications.
    // Only this surface or its original verified host may yield activation.
    return value.foregroundWindow === widgetId || value.foregroundWindow === id || value.foregroundRoot === id;
  }
  clearInputFocusTimer() {
    if (this.inputFocusTimer) clearTimeout(this.inputFocusTimer);
    this.inputFocusTimer = null;
  }
  scheduleInputFocus(revision) {
    this.clearInputFocusTimer();
    if (this.closed || !this.inputRequested || revision !== this.inputRevision) return;
    this.inputFocusTimer = setTimeout(async () => {
      this.inputFocusTimer = null;
      if (this.closed || !this.inputRequested || revision !== this.inputRevision || !this.enabled || !this.nativeChild) return;
      if (this.inputFocusBusy) { this.scheduleInputFocus(revision); return; }
      const provider = this.provider, id = this.hostId, handle = this.widget.getNativeWindowHandle();
      if (!provider || !id || typeof provider.focusChild !== 'function') return;
      this.inputFocusBusy = true;
      try {
        const task = this.binding.then(async () => {
          if (this.closed || !this.inputRequested || revision !== this.inputRevision || provider !== this.provider || id !== this.hostId) return false;
          if (!await this.canActivateInput()) return true;
          const result = await provider.focusChild(handle, id);
          return result?.known === true && result.ok === true && result.parented === true;
        });
        this.binding = task.catch(() => {});
        await task;
      } catch {}
      finally {
        this.inputFocusBusy = false;
        if (!this.closed && this.inputRequested && revision === this.inputRevision) this.scheduleInputFocus(revision);
      }
    }, 50);
  }
  setInputActive(active) {
    this.inputRequested = active === true;
    const revision = ++this.inputRevision;
    if (!this.enabled || !this.embedded || this.closed) { if (!active) this.clearInputFocusTimer(); return Promise.resolve(true); }
    const provider = this.provider;
    // Production Windows providers can focus the existing child HWND through
    // the host input queue. Keep the child attached: reparenting on every
    // focus transition makes Chromium report a transient hide/show and lets
    // the host restore its own editor focus.
    if (typeof provider?.focusChild === 'function') {
      if (!active) {
        this.clearInputFocusTimer();
        const id = this.hostId, handle = this.widget.getNativeWindowHandle();
        const task = this.binding.then(async () => {
          if (!id || typeof provider.releaseChildFocus !== 'function') return true;
          try { await provider.releaseChildFocus(handle, id); } catch {}
          return true;
        });
        this.binding = task.catch(() => {});
        return task.finally(() => { if (revision === this.inputRevision && !this.closed) this.inputTransition = false; });
      }
      this.inputTransition = true;
      const task = this.binding.then(async () => {
        if (this.closed || !this.enabled || revision !== this.inputRevision || provider !== this.provider) return false;
        const id = this.hostId, epoch = this.epoch, owner = this.bindingRevision;
        if (!id || !this.nativeChild || this.widget.isDestroyed?.()) return false;
        const result = await provider.focusChild(this.widget.getNativeWindowHandle(), id);
        if (this.closed || !this.enabled || revision !== this.inputRevision || provider !== this.provider ||
            epoch !== this.epoch || owner !== this.bindingRevision || id !== this.hostId) return false;
        const ok = result?.known === true && result.ok === true && result.parented === true;
        if (ok) this.scheduleInputFocus(revision);
        return ok;
      });
      this.binding = task.catch(() => {});
      return task.finally(() => {
        if (revision === this.inputRevision && !this.closed) this.inputTransition = false;
      });
    }
    this.inputTransition = true;
    const task = this.binding.then(async () => {
      if (this.closed || !this.enabled || revision !== this.inputRevision) return false;
      const detached = this.inputRequested, provider = this.provider, id = this.hostId, epoch = this.epoch, owner = this.bindingRevision;
      if (detached === this.inputDetached) return true;
      if (!provider || !id || this.widget.isDestroyed?.()) return false;
      const handle = this.widget.getNativeWindowHandle();
      // A cross-process WS_CHILD shares its host's native input chain. Give
      // editing a top-level surface while keeping the same containment and
      // host polling. Neither native transition nor any poll activates it.
      const result = await (detached ? provider.detachChild(handle) : provider.attachChild(handle, id));
      if (result?.known !== true || result.ok !== true) return false;
      if (this.closed || this.widget.isDestroyed?.() || !this.enabled || provider !== this.provider ||
          epoch !== this.epoch || owner !== this.bindingRevision || id !== this.hostId) return false;
      this.inputDetached = detached;
      this.geometryReady = true; this.controller.lastBounds = null;
      if (this.controller.snapshot) this.controller.snapshot.embedded = this.nativeChild;
      if (detached && this.lastProjected) this.widget.setBounds({ ...this.lastProjected });
      return revision === this.inputRevision;
    });
    this.binding = task.catch(() => {});
    return task.finally(() => {
      if (revision !== this.inputRevision || this.closed) return;
      this.inputTransition = false;
      this.controller.refreshSize(); this.publish();
    });
  }
  moveTo(x, y) { return this.controller.moveTo(x, y); }
  refreshSize() { this.controller.refreshSize(); this.publish(); }
  show() { this.controller.setManualHidden(false); this.topmost.recover(); if (this.enabled) this.visibility.requestRecovery(); this.publish(); }
  hide() { this.controller.setManualHidden(true); this.publish(); }
  close() {
    if (this.closed) return;
    this.closed = true; this.epoch++; this.bindingRevision++; this.inputRevision++;
    this.inputRequested = false; this.clearInputFocusTimer();
    this.controller.close();
    this.topmost.close();
    this.visibility.dispose();
    try { this.widget.webContents?.removeListener?.('did-finish-load', this.loaded); } catch {}
    clearTimeout(this.timer); for (const timer of this.staleTimers) clearTimeout(timer); this.staleTimers.clear();
    const provider = this.provider; this.provider = null;
    if (this.embedded && provider && !this.widget.isDestroyed?.()) {
      const handle = this.widget.getNativeWindowHandle();
      const focusHost = this.hostId;
      this.binding.then(async () => {
        try { if (focusHost && typeof provider.releaseChildFocus === 'function') await provider.releaseChildFocus(handle, focusHost); } catch {}
        return provider.detachChild(handle);
      }).finally(() => provider.close());
    } else if (this.ownedLayerMode && provider && !this.widget.isDestroyed?.()) {
      const handle = this.widget.getNativeWindowHandle();
      this.binding.catch(() => {}).then(() => provider.bindLayer(handle, null)).catch(() => {}).finally(() => provider.close());
    } else if (provider && typeof provider.trackLayer === 'function' && !this.widget.isDestroyed?.()) {
      const handle = this.widget.getNativeWindowHandle();
      this.binding.catch(() => {}).then(() => provider.trackLayer(handle, null)).catch(() => {}).finally(() => provider.close());
    } else provider?.close();
  }
}

module.exports = { CodexWindowMode, normalizedSnapshot, nativeHandleId };
