'use strict';

// This timer only checks persisted deadlines. It never reads Codex or a login.
class AccountAlarm {
  constructor({ registry, enabled = () => true, notify, now = Date.now,
    setTimer = setTimeout, clearTimer = clearTimeout }) {
    this.registry = registry; this.enabled = enabled; this.notify = notify;
    this.now = now; this.setTimer = setTimer; this.clearTimer = clearTimer;
    this.timer = null; this.closed = false;
  }
  start() { this.check(); }
  check() {
    if (this.closed) return true;
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
    let persisted = true;
    try {
      // due() persists its acknowledgements before any notification. Consume
      // muted events too, so enabling reminders later never replays them.
      const events = this.registry.due(this.now());
      if (this.enabled()) for (const event of events) {
        try { this.notify(event); } catch { /* OS notifications are best effort. */ }
      }
    } catch { persisted = false; /* Keep the record for a later retry if the atomic write failed. */ }
    let delay = 30000;
    try {
      const deadline = this.registry.nextDueAt();
      if (Number.isFinite(deadline)) delay = Math.min(delay, Math.max(1000, deadline - this.now()));
    } catch {}
    this.timer = this.setTimer(() => this.check(), delay);
    this.timer?.unref?.();
    return persisted;
  }
  close() { this.closed = true; if (this.timer !== null) this.clearTimer(this.timer); this.timer = null; }
}
module.exports = { AccountAlarm };
