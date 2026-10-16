'use strict';
module.exports = function demo() {
  const now = Date.now();
  return {
    status: 'demo', updatedAt: new Date(now).toISOString(), account: { planType: '演示', authMode: 'demo' },
    buckets: [{ id: 'demo', name: '演示额度', primary: { usedPercent: 18, remainingPercent: 82, windowDurationMins: 300, resetsAt: Math.floor(now / 1000) + 5209 }, secondary: { usedPercent: 36, remainingPercent: 64, windowDurationMins: 10080, resetsAt: Math.floor(now / 1000) + 214449 }, credits: null }],
    today: { tokens: 128460, turns: 12, source: 'local', scope: 'device', date: new Date().toLocaleDateString('sv-SE'), complete: true },
    weekly: { tokens: 1268450, turns: 97, source: 'local', scope: 'device', ...require('./codex-data.cjs').weekRange(new Date(now)), complete: true },
    lastTurn: { tokens: 8420, scope: 'device', timestamp: new Date(now - 90000).toISOString() },
  };
};
