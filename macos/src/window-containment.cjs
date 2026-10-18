'use strict';

// All geometry in this module is in Electron screen DIPs. Native providers must
// convert their client rectangles before passing a snapshot to the controller.
// It deliberately has no fs, Electron, process, timer, or user-data dependency.
function validSize(value) {
  if (!value || !Number.isFinite(value.width) || !Number.isFinite(value.height)) return null;
  const width = Math.round(value.width), height = Math.round(value.height);
  return width > 0 && height > 0 ? { width, height } : null;
}
function innerRectangle(value) {
  if (!value || !['x', 'y', 'width', 'height'].every(key => Number.isFinite(value[key])) || value.width <= 0 || value.height <= 0) return null;
  // Round inward: rounding the origin outward can place part of the transparent
  // widget beyond a fractional client edge on mixed-DPI displays.
  const x = Math.ceil(value.x), y = Math.ceil(value.y);
  const width = Math.floor(value.x + value.width) - x, height = Math.floor(value.y + value.height) - y;
  return width > 0 && height > 0 ? { x, y, width, height } : null;
}
function fits(area, size) { return !!area && !!size && area.width >= size.width && area.height >= size.height; }
function unit(value, fallback = 0.5) { return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : fallback; }
function containBounds(position, area, size) {
  area = innerRectangle(area); size = validSize(size);
  if (!fits(area, size) || !position || !Number.isFinite(position.x) || !Number.isFinite(position.y)) return null;
  return {
    x: Math.max(area.x, Math.min(area.x + area.width - size.width, Math.round(position.x))),
    y: Math.max(area.y, Math.min(area.y + area.height - size.height, Math.round(position.y))),
    ...size,
  };
}
function relativeAnchor(bounds, area, size, fallback = {}) {
  area = innerRectangle(area); size = validSize(size);
  const contained = containBounds(bounds, area, size);
  if (!contained) return null;
  return {
    x: area.width > size.width ? (contained.x - area.x) / (area.width - size.width) : unit(fallback.x),
    y: area.height > size.height ? (contained.y - area.y) / (area.height - size.height) : unit(fallback.y),
  };
}
function anchoredBounds(anchor, area, size) {
  area = innerRectangle(area); size = validSize(size);
  if (!fits(area, size)) return null;
  return containBounds({
    x: area.x + unit(anchor?.x) * (area.width - size.width),
    y: area.y + unit(anchor?.y) * (area.height - size.height),
  }, area, size);
}
function sameBounds(a, b) { return !!a && !!b && ['x', 'y', 'width', 'height'].every(key => a[key] === b[key]); }
function ownerSucceeded(result) { return result !== false && !(result && (result.ok === false || result.known === false)); }

class WindowContainmentController {
  constructor({ getBounds, getSize, setBounds, show, hide, setAlwaysOnTop, onHostChanged, onVisibilityChanged } = {}) {
    for (const [name, callback] of Object.entries({ getBounds, getSize, setBounds, show, hide })) {
      if (typeof callback !== 'function') throw new TypeError(name + ' must be a function');
    }
    this.callbacks = { getBounds, getSize, setBounds, show, hide, setAlwaysOnTop, onHostChanged, onVisibilityChanged };
    this.enabled = false;
    this.manualHidden = false;
    this.visible = null;
    this.snapshot = null;
    this.anchor = null;
    this.standalone = null;
    this.restorePending = false;
    this.lastBounds = null;
    this.top = null;
    this.ownerId = null;
    this.ownerReady = true;
    this.ownerError = false;
    this.placementError = false;
    this.hideError = false;
    this.ownerGeneration = 0;
    this.reason = 'disabled';
  }
  setEnabled(enabled, { position, alwaysOnTop } = {}) {
    enabled = enabled === true;
    if (this.standalone && typeof alwaysOnTop === 'boolean') this.standalone.alwaysOnTop = alwaysOnTop;
    if (this.enabled === enabled) return this.getState();
    this.enabled = enabled;
    this.lastBounds = null;
    this.snapshot = null; // A previous mode's successful query is never fresh.
    if (enabled) {
      const bounds = this.callbacks.getBounds();
      const saved = position && Number.isFinite(position.x) && Number.isFinite(position.y) ? position : bounds;
      this.standalone = { position: { x: Math.round(saved.x), y: Math.round(saved.y) }, alwaysOnTop: alwaysOnTop !== false };
      this.anchor = null;
      this.restorePending = false;
      this.setTop(false);
      this.setVisible(false);
    } else {
      this.restorePending = true;
      this.setVisible(false);
      this.changeOwner(null);
    }
    this.render();
    return this.getState();
  }
  setManualHidden(hidden) {
    this.manualHidden = hidden === true;
    this.render();
    if (!this.enabled && this.ownerReady) this.setVisible(!this.manualHidden);
    return this.getState();
  }
  update(snapshot) {
    if (!this.enabled) return this.getState();
    // Retain only necessary non-sensitive fields and copy geometry. A provider
    // mutating its result later cannot silently mutate this controller's state.
    const known = snapshot?.known === true || (snapshot?.known === undefined && snapshot?.status === 'known');
    const host = snapshot?.host;
    this.snapshot = {
      known, supported: snapshot?.supported !== false, foreground: snapshot?.foreground, embedded: snapshot?.embedded === true,
      host: host && (typeof host.id === 'string' || typeof host.id === 'number') && String(host.id).length ? {
        id: String(host.id), clientBounds: innerRectangle(host.clientBounds),
        visible: host.visible === true, minimized: host.minimized !== false,
        onCurrentDesktop: host.onCurrentDesktop === true, cloaked: host.cloaked === true, modal: host.modal === true,
      } : null,
    };
    if (known) this.changeOwner(this.snapshot.host);
    this.render();
    return this.getState();
  }
  // Enabled mode always handles a move, even when no host is available. Falling
  // through to the standalone drag path could otherwise reveal an uncontained
  // window or overwrite the user's original desktop position.
  moveTo(x, y) {
    if (!this.enabled) return false;
    const area = this.getArea(), size = validSize(this.callbacks.getSize());
    const bounds = containBounds({ x, y }, area, size);
    if (bounds) {
      this.anchor = relativeAnchor(bounds, area, size, this.anchor || {});
      this.render();
    }
    return true;
  }
  refreshSize() { this.render(); return this.getState(); }
  getArea() {
    const host = this.snapshot?.host;
    if (!this.enabled || !this.snapshot?.known || !host?.visible || host.minimized || !host.onCurrentDesktop || host.cloaked) return null;
    return host.clientBounds ? { ...host.clientBounds } : null;
  }
  getHostBounds() { return this.getArea(); }
  getState() {
    return {
      enabled: this.enabled, manualHidden: this.manualHidden, visible: this.visible === true,
      supported: this.snapshot?.supported !== false, hostId: this.enabled ? this.snapshot?.host?.id || null : null,
      reason: this.reason, ownerPending: !this.ownerReady && !this.ownerError,
      anchor: this.anchor ? { ...this.anchor } : null,
    };
  }
  setVisible(visible) {
    if (this.visible === visible && !(!visible && this.hideError)) return;
    try {
      if (this.callbacks[visible ? 'show' : 'hide']() === false) throw new Error('window-visibility-unavailable');
      this.visible = visible;
      this.callbacks.onVisibilityChanged?.(visible);
      this.hideError = false;
      if (visible) this.placementError = false;
    } catch {
      // showInactive may succeed before native stacking fails. Always attempt
      // hiding again, and let the next known snapshot retry host placement.
      this.visible = false;
      this.ownerError = true;
      if (visible) {
        this.placementError = true;
        try { this.hideError = this.callbacks.hide() === false; } catch { this.hideError = true; }
      } else this.hideError = true;
      this.reason = this.hideError ? 'hide-unavailable' : 'placement-unavailable';
    }
  }
  setTop(value) {
    if (this.top === value) return;
    this.top = value;
    this.callbacks.setAlwaysOnTop?.(value);
  }
  changeOwner(host) {
    const id = host?.id || null;
    if (id === this.ownerId && !this.ownerError) return;
    this.ownerId = id;
    this.ownerError = false;
    this.placementError = false;
    this.ownerReady = false;
    this.setVisible(false);
    const generation = ++this.ownerGeneration;
    const complete = result => {
      if (generation !== this.ownerGeneration) return;
      this.ownerReady = ownerSucceeded(result);
      this.ownerError = !this.ownerReady;
      this.render();
    };
    let result;
    try { result = this.callbacks.onHostChanged?.(host ? { ...host, clientBounds: host.clientBounds && { ...host.clientBounds } } : null); }
    catch { complete(false); return; }
    if (result && typeof result.then === 'function') Promise.resolve(result).then(complete, () => complete(false));
    else complete(result);
  }
  applyBounds(bounds) {
    if (sameBounds(this.lastBounds, bounds)) return;
    // Always provide preferred dimensions, never the native width read back
    // from a fractional-DPI move. This retains the 0.3.14 drift fix.
    this.callbacks.setBounds({ ...bounds });
    this.lastBounds = { ...bounds };
  }
  render() {
    if (!this.enabled) {
      this.reason = this.hideError ? 'hide-unavailable' : this.placementError ? 'placement-unavailable'
        : this.manualHidden ? 'manual-hidden' : this.ownerError ? 'owner-unavailable' : !this.ownerReady ? 'owner-pending' : 'disabled';
      if (!this.ownerReady) { this.setVisible(false); return; }
      if (this.standalone) {
        // Restore once on a mode transition. Later standalone drags and native
        // positioning belong to main.cjs; an explicit show must not rewind them.
        if (this.restorePending) {
          this.setTop(this.standalone.alwaysOnTop);
          const size = validSize(this.callbacks.getSize());
          if (size) this.applyBounds({ ...this.standalone.position, ...size });
          this.restorePending = false;
        }
        this.setVisible(!this.manualHidden);
      } else if (this.manualHidden) this.setVisible(false);
      return;
    }
    this.setTop(false);
    const snapshot = this.snapshot, host = snapshot?.host;
    const area = this.getArea(), size = validSize(this.callbacks.getSize());
    // A real child participates in its parent's compositor image. Preserve its
    // WS_VISIBLE state through minimize/hide so Windows can animate the whole
    // image. In particular, never feed minimized -32000 coordinates back into
    // the saved relative anchor. Explicit hide/unknown/destroy still fail closed.
    if (snapshot?.embedded && snapshot.known && host && !this.manualHidden &&
        (!host.visible || host.minimized || !host.onCurrentDesktop || host.cloaked)) {
      this.reason = 'host-hidden';
      return;
    }
    this.reason = this.hideError ? 'hide-unavailable' : this.placementError ? 'placement-unavailable'
      : this.manualHidden ? 'manual-hidden'
      : snapshot?.supported === false ? 'unsupported'
      : !snapshot?.known ? 'unknown'
      : !host ? 'host-unavailable'
      : !host.visible || host.minimized || !host.onCurrentDesktop || host.cloaked ? 'host-hidden'
      : host.modal && !snapshot.embedded ? 'host-modal'
      : !fits(area, size) ? 'host-too-small'
      : !snapshot.embedded && !['host', 'widget', 'settings'].includes(snapshot.foreground) ? 'other-foreground'
      : this.ownerError ? 'owner-unavailable'
      : !this.ownerReady ? 'owner-pending' : 'contained';
    if (this.reason !== 'contained') { this.setVisible(false); return; }
    if (!this.anchor) this.anchor = relativeAnchor(this.callbacks.getBounds(), area, size);
    const bounds = anchoredBounds(this.anchor, area, size);
    this.applyBounds(bounds);
    this.setVisible(true);
  }
}

module.exports = { innerRectangle, containBounds, relativeAnchor, anchoredBounds, WindowContainmentController };
