'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { desktopRoots, rootKey } = require('./codex-desktop.cjs');

function sameExecutable(a, b, platform = process.platform) {
  if (typeof a !== 'string' || typeof b !== 'string' || /[\0\r\n]/.test(a + b)) return false;
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const left = paths.resolve(a), right = paths.resolve(b);
  return platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}
function processIsAlive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }

// One observer owns platform enumeration. The widget consumes its small, atomic
// snapshot instead of starting a second process inventory every 2.5 seconds.
class DesktopObservationWriter {
  constructor({ dataDir, executable, version, pid = process.pid, now = Date.now, heartbeatMs = 5000 }) {
    this.file = path.join(dataDir, 'desktop-observation.json');
    this.identity = { pid, executable, version };
    this.now = now;
    this.heartbeatMs = heartbeatMs;
    this.lastSignature = null;
    this.lastWrite = 0;
  }
  publish(result) {
    const known = result?.known === true && Array.isArray(result.roots);
    const roots = known ? result.roots : [];
    const signature = JSON.stringify([known, roots.map(rootKey).sort()]);
    const observedAt = this.now();
    if (signature === this.lastSignature && observedAt >= this.lastWrite && observedAt - this.lastWrite < this.heartbeatMs) return;
    const temporary = `${this.file}.${this.identity.pid}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify({ ...this.identity, observedAt, known, roots }));
      fs.renameSync(temporary, this.file);
      this.lastSignature = signature;
      this.lastWrite = observedAt;
    } finally { try { fs.unlinkSync(temporary); } catch {} }
  }
}

function readDesktopObservation({ dataDir, executable, version, now = Date.now, isAlive = processIsAlive, maxAgeMs = 15000, platform = process.platform, uid = process.getuid?.() }) {
  const unknown = { known: false, roots: [], reason: 'observer-unavailable' };
  try {
    const record = JSON.parse(fs.readFileSync(path.join(dataDir, 'desktop-observation.json'), 'utf8'));
    const watcher = JSON.parse(fs.readFileSync(path.join(dataDir, 'watcher.json'), 'utf8'));
    const age = now() - record.observedAt;
    if (!Number.isInteger(record.pid) || record.pid <= 0 || record.pid !== watcher.pid ||
        record.version !== version || watcher.version !== version ||
        !sameExecutable(record.executable, executable, platform) || !sameExecutable(watcher.executable, executable, platform) ||
        !Number.isFinite(age) || age < -1000 || age > maxAgeMs || !isAlive(record.pid) ||
        record.known !== true || !Array.isArray(record.roots)) return unknown;
    const roots = desktopRoots(record.roots, { platform, uid });
    if (roots.length !== record.roots.length) return unknown;
    return { known: true, roots };
  } catch { return unknown; }
}

module.exports = { DesktopObservationWriter, readDesktopObservation, sameExecutable };
