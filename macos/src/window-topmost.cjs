'use strict';

// One surface owns one queue. Native writes finish before a child attachment is
// allowed; old acknowledgements cannot certify a newer preference or HWND.
class WindowTopmostController {
  constructor({ widget, platform = process.platform, providerFactory, onStatus = () => {},
    now = () => Date.now(), schedule = setTimeout, cancel = clearTimeout } = {}) {
    Object.assign(this, { widget, platform, providerFactory, onStatus, now, schedule, cancel });
    this.closed = false; this.contained = false; this.preference = true;
    this.containedVisible = false;
    this.revision = 0; this.completed = 0; this.provider = null; this.providerHandle = null;
    this.work = Promise.resolve();
    this.state = { desired: true, verified: false, reason: 'pending' };
    this.blurTimer = null; this.lastBlurRecovery = -Infinity;
    this.blurred = () => {
      if (this.closed || this.contained || this.blurTimer !== null) return;
      this.blurTimer = this.schedule(() => {
        this.blurTimer = null;
        if (this.closed || this.contained) return;
        this.lastBlurRecovery = this.now(); this.recover();
      }, Math.max(120, 750 - (this.now() - this.lastBlurRecovery)));
    };
    widget.on?.('blur', this.blurred);
  }
  getState() { return { ...this.state }; }
  handle() { try { return this.widget.getNativeWindowHandle?.().toString('hex') || ''; } catch { return ''; } }
  configure({ contained = this.contained, alwaysOnTop = this.preference, containedVisible = this.containedVisible } = {}) {
    const wasContained = this.contained;
    const wasVisible = this.containedVisible;
    this.contained = contained === true; this.preference = alwaysOnTop !== false;
    this.containedVisible = this.platform === 'darwin' && this.contained && containedVisible === true;
    if (this.contained && this.blurTimer !== null) { this.cancel(this.blurTimer); this.blurTimer = null; }
    // No standalone topmost command is ever issued to an attached child.
    if (this.contained && wasContained && wasVisible === this.containedVisible && this.state.reason !== 'topmost-unavailable') return this.work;
    return this.request();
  }
  desired() {
    // macOS has a separate companion window rather than a cross-process child.
    // Float it only while the foreground/containment policy permits showing it.
    return this.contained ? this.platform === 'darwin' && this.containedVisible : this.preference;
  }
  recover() {
    // A failed entry barrier has never allowed a child attach. Only an explicit
    // user action retries it; successful embedded surfaces never write here.
    return this.closed || this.contained && this.state.reason !== 'topmost-unavailable' ? this.work : this.request();
  }
  request() {
    if (this.closed) return this.work;
    this.revision++;
    this.state = { desired: this.desired(), verified: false, reason: 'pending' };
    this.work = this.work.catch(() => {}).then(() => this.drain());
    try { this.onStatus(); } catch {}
    return this.work;
  }
  settled() { return this.work; }
  async drain() {
    while (!this.closed && this.completed !== this.revision) {
      const revision = this.revision, desired = this.desired(), handle = this.handle();
      let verified = false;
      try {
        if (this.widget.isDestroyed?.()) break;
        this.widget.setAlwaysOnTop(desired, 'floating');
        if (this.platform === 'win32') {
          if (!handle) throw new Error('missing native handle');
          if (!this.provider || this.providerHandle !== handle) {
            this.provider?.close(); this.provider = null; this.providerHandle = null;
            this.provider = this.providerFactory(); this.providerHandle = handle;
          }
          const result = await this.provider.setTopmost(this.widget.getNativeWindowHandle(), desired);
          verified = result?.known === true && result.ok === true && result.topmost === desired;
        } else verified = true;
      } catch {}
      this.completed = revision;
      if (this.closed) return;
      if (this.widget.isDestroyed?.()) return;
      if (handle !== this.handle()) { this.revision++; continue; }
      if (revision !== this.revision) continue;
      this.state = { desired, verified, reason: verified ? 'verified' : 'topmost-unavailable' };
      // Embedded mode has its own native host. A standalone worker must never
      // retain a pending write or process after this barrier releases.
      if (this.contained) { this.provider?.close(); this.provider = null; this.providerHandle = null; }
      try { this.onStatus(); } catch {}
    }
  }
  close() {
    if (this.closed) return;
    this.closed = true; this.revision++;
    if (this.blurTimer !== null) this.cancel(this.blurTimer);
    this.blurTimer = null; this.widget.removeListener?.('blur', this.blurred);
    this.provider?.close(); this.provider = null; this.providerHandle = null;
  }
}

module.exports = { WindowTopmostController };
