'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { AccountAlarm } = require('../src/account-alarm.cjs');

test('account deadlines schedule locally, consume muted events and close cleanly', () => {
  let now = 1000, timer, consumed = false, enabled = false;
  const notifications = [];
  const alarm = new AccountAlarm({ now: () => now, enabled: () => enabled,
    registry: { nextDueAt: () => consumed ? null : 2000,
      due: time => { if (time >= 2000 && !consumed) { consumed = true; return [{ label: '账号1' }]; } return []; } },
    notify: event => notifications.push(event), setTimer: (fn, ms) => (timer = { fn, ms }), clearTimer: () => { timer = null; } });
  alarm.start(); assert.equal(timer.ms, 1000);
  now = 2000; timer.fn(); assert.equal(consumed, true); assert.equal(notifications.length, 0);
  enabled = true; now = 5000; timer.fn(); assert.equal(notifications.length, 0);
  alarm.close(); assert.equal(timer, null); alarm.check(); assert.equal(timer, null);
});
test('a failed durable acknowledgement never sounds, and later retry delivers once', () => {
  let fail = true, consumed = false, callback, count = 0;
  const alarm = new AccountAlarm({ registry: { nextDueAt: () => 0,
    due: () => { if (fail) throw new Error('disk unavailable'); if (consumed) return []; consumed = true; return [{}]; } },
    notify: () => { count++; }, setTimer: fn => { callback = fn; return 1; }, clearTimer() {} });
  alarm.start(); assert.equal(count, 0); fail = false; callback(); assert.equal(count, 1); callback(); assert.equal(count, 1); alarm.close();
});
