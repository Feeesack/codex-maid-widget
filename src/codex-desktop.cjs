'use strict';
const path = require('node:path');
const { execFile: nativeExecFile } = require('node:child_process');
const { classifyCodexDesktop } = require('./codex-identity.cjs');
const { INVENTORY_WORKER_SCRIPT } = require('./windows-inventory.cjs');
const { powershellExecutable } = require('./windows-system.cjs');

// Query only the current user's interactive session. Do not request command lines,
// credentials, environment blocks, or any of the desktop's account files.
const INVENTORY_SCRIPT = INVENTORY_WORKER_SCRIPT.slice(0, INVENTORY_WORKER_SCRIPT.indexOf('while ($null -ne ($request'))
  + '\nConvertTo-Json -InputObject ([MaidWindowsInventory]::Query()) -Depth 5 -Compress\n';

function normalizeWindowsPath(value) {
  if (typeof value !== 'string' || !path.win32.isAbsolute(value) || value.includes('\0')) return '';
  return path.win32.normalize(value).toLowerCase();
}

function isCodexDesktopPath(value, options = {}) {
  return classifyCodexDesktop({ path: value, packageFamilyName: options.packageFamilyName }, options) === true;
}

function desktopRoots(processes, options = {}) {
  if (!Array.isArray(processes)) throw new TypeError('Invalid desktop inventory');
  if (processes.some(item => !item || typeof item.officialDesktop !== 'boolean')) throw new TypeError('Unverified desktop inventory');
  const candidates = processes.filter(item => item && Number.isInteger(item.pid) && item.pid > 0 && Number.isInteger(item.parentPid) &&
    /^(chatgpt|codex)\.exe$/i.test(item.name || path.win32.basename(item.path || '')) && item.officialDesktop);
  const ids = new Set(candidates.map(item => item.pid));
  return candidates.filter(item => !ids.has(item.parentPid)).map(item => ({
    pid: item.pid, parentPid: item.parentPid, path: item.path, sessionId: item.sessionId, officialDesktop: true,
  })).sort((a, b) => a.pid - b.pid);
}

async function queryCodexDesktop({ execFile = nativeExecFile, platform = process.platform, programFiles, localAppData, timeout = 7000, env = process.env } = {}) {
  if (platform !== 'win32') return { known: false, roots: [], reason: 'unsupported-platform' };
  try {
    const output = await new Promise((resolve, reject) => {
      execFile(powershellExecutable(env), ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', INVENTORY_SCRIPT],
        { windowsHide: true, timeout, maxBuffer: 1024 * 1024, encoding: 'utf8', env }, (error, stdout) => error ? reject(error) : resolve(stdout));
    });
    const inventory = JSON.parse(output.replace(/^\uFEFF/, '').trim());
    if (inventory.known !== true || !Array.isArray(inventory.processes)) return { known: false, roots: [], reason: 'inventory-unavailable' };
    return { known: true, roots: desktopRoots(inventory.processes, { programFiles, localAppData }) };
  } catch {
    return { known: false, roots: [], reason: 'inventory-unavailable' };
  }
}

function createDesktopInventoryQuery(options = {}) {
  const { WindowsInventoryWorker } = require('./windows-inventory.cjs');
  const worker = new WindowsInventoryWorker(options);
  return {
    async query() {
      const result = await worker.query();
      if (result?.known !== true || !Array.isArray(result.processes)) return { known: false, roots: [], reason: 'inventory-unavailable' };
      try { return { known: true, roots: desktopRoots(result.processes, options) }; }
      catch { return { known: false, roots: [], reason: 'inventory-unavailable' }; }
    },
    close() { worker.close(); },
  };
}

function rootKey(item) { return `${item.pid}:${normalizeWindowsPath(item.path)}`; }
function rootSignature(items) { return items.map(rootKey).sort().join('|'); }

class CodexDesktopMonitor {
  constructor({ query = queryCodexDesktop, intervalMs = 2500, graceMs = 5000, onChange = () => {}, onMissing = () => {}, onError = () => {}, now = Date.now } = {}) {
    this.query = query;
    this.intervalMs = intervalMs;
    this.graceMs = graceMs;
    this.onChange = onChange;
    this.onMissing = onMissing;
    this.onError = onError;
    this.now = now;
    this.roots = [];
    this.known = false;
    this.missingSince = null;
    this.missingNotified = false;
    this.running = false;
    this.timer = null;
    this.pending = null;
    this.generation = 0;
  }
  start() {
    if (this.running) return this;
    this.running = true;
    const tick = async () => {
      const startedAt = Date.now();
      try { await this.poll(); }
      finally { if (this.running) this.timer = setTimeout(tick, Math.max(100, this.intervalMs - (Date.now() - startedAt))); }
    };
    void tick();
    return this;
  }
  stop() {
    this.generation++;
    this.running = false;
    clearTimeout(this.timer);
    this.timer = null;
  }
  poll() {
    if (this.pending) return this.pending;
    const generation = this.generation;
    this.pending = (async () => {
      let result;
      try { result = await this.query(); }
      catch { result = { known: false, roots: [], reason: 'inventory-unavailable' }; }
      if (generation !== this.generation) return { known: false, roots: this.roots };
      if (result?.known !== true || !Array.isArray(result.roots)) {
        // An unavailable query is not proof the desktop exited. Require a fresh
        // continuous grace period after the next successful empty inventory.
        this.missingSince = null;
        this.onError(result?.reason || 'inventory-unavailable');
        return { known: false, roots: this.roots };
      }
      const previous = this.roots;
      const changed = !this.known || rootSignature(previous) !== rootSignature(result.roots);
      this.roots = result.roots;
      this.known = true;
      if (result.roots.length) {
        this.missingSince = null;
        this.missingNotified = false;
      } else if (this.missingSince === null) {
        this.missingSince = this.now();
      }
      if (changed) this.onChange(result.roots, previous);
      if (!result.roots.length && !this.missingNotified && this.now() - this.missingSince >= this.graceMs) {
        this.missingNotified = true;
        this.onMissing();
      }
      return result;
    })().finally(() => { this.pending = null; });
    return this.pending;
  }
}

function buildLaunchArgs({ packaged, appRoot, flag }) {
  return packaged ? [flag] : [path.resolve(appRoot), flag];
}

module.exports = { INVENTORY_SCRIPT, isCodexDesktopPath, desktopRoots, queryCodexDesktop, createDesktopInventoryQuery, CodexDesktopMonitor, buildLaunchArgs, rootKey };
