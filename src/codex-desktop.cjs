'use strict';
const path = require('node:path');
const { execFile: nativeExecFile } = require('node:child_process');

// Query only the current user's interactive session. Do not request command lines,
// credentials, environment blocks, or any of the desktop's account files.
const INVENTORY_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$session = [System.Diagnostics.Process]::GetCurrentProcess().SessionId
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$unknown = $false
$items = @()
$processes = @(Get-CimInstance -ClassName Win32_Process -Filter "Name='ChatGPT.exe' OR Name='Codex.exe'" -Property ProcessId,ParentProcessId,Name,ExecutablePath,SessionId -ErrorAction Stop)
$byId = @{}
foreach ($entry in $processes) { if ($entry.SessionId -eq $session) { $byId[[int]$entry.ProcessId] = $entry } }
foreach ($entry in $processes) {
  if ($entry.SessionId -ne $session) { continue }
  $parent = $byId[[int]$entry.ParentProcessId]
  if ($null -ne $parent -and $entry.ExecutablePath -and $parent.ExecutablePath -ieq $entry.ExecutablePath) { continue }
  try {
    $owner = Invoke-CimMethod -InputObject $entry -MethodName GetOwner -ErrorAction Stop
    if ($owner.ReturnValue -ne 0) { $unknown = $true; continue }
    if (($owner.Domain + '\' + $owner.User) -ine $identity) { continue }
    if ([string]::IsNullOrWhiteSpace($entry.ExecutablePath)) { $unknown = $true; continue }
    $items += [pscustomobject]@{ pid = [int]$entry.ProcessId; parentPid = [int]$entry.ParentProcessId; name = [string]$entry.Name; path = [string]$entry.ExecutablePath; sessionId = [int]$entry.SessionId }
  } catch { $unknown = $true }
}
[pscustomobject]@{ known = -not $unknown; processes = @($items) } | ConvertTo-Json -Depth 3 -Compress
`;

function normalizeWindowsPath(value) {
  if (typeof value !== 'string' || !path.win32.isAbsolute(value) || value.includes('\0')) return '';
  return path.win32.normalize(value).toLowerCase();
}

function isCodexDesktopPath(value, { programFiles = process.env.ProgramFiles || 'C:\\Program Files', localAppData = process.env.LOCALAPPDATA } = {}) {
  const file = normalizeWindowsPath(value);
  if (!file) return false;
  const packageRoot = normalizeWindowsPath(path.win32.join(programFiles, 'WindowsApps')) + '\\';
  if (file.startsWith(packageRoot)) {
    // The Codex desktop currently uses ChatGPT.exe internally. The package name,
    // publisher and app directory distinguish it from ChatGPT and the Codex CLI.
    const relative = file.slice(packageRoot.length);
    return /^openai\.codex_[a-z0-9._-]+__2p2nqsd0c76g0\\app\\(?:chatgpt|codex)\.exe$/.test(relative);
  }
  if (!localAppData) return false;
  const programs = normalizeWindowsPath(path.win32.join(localAppData, 'Programs')) + '\\';
  if (!file.startsWith(programs)) return false;
  return /^(?:openai\\codex|openai codex|codex)\\(?:app\\)?(?:chatgpt|codex)\.exe$/.test(file.slice(programs.length));
}

function desktopRoots(processes, options = {}) {
  if (!Array.isArray(processes)) throw new TypeError('Invalid desktop inventory');
  const candidates = processes.filter(item => item && Number.isInteger(item.pid) && item.pid > 0 && Number.isInteger(item.parentPid) &&
    /^(chatgpt|codex)\.exe$/i.test(item.name || path.win32.basename(item.path || '')) && isCodexDesktopPath(item.path, options));
  const ids = new Set(candidates.map(item => item.pid));
  return candidates.filter(item => !ids.has(item.parentPid)).map(item => ({
    pid: item.pid, parentPid: item.parentPid, path: item.path, sessionId: item.sessionId,
  })).sort((a, b) => a.pid - b.pid);
}

async function queryCodexDesktop({ execFile = nativeExecFile, platform = process.platform, programFiles, localAppData, timeout = 7000 } = {}) {
  if (platform !== 'win32') return { known: false, roots: [], reason: 'unsupported-platform' };
  try {
    const output = await new Promise((resolve, reject) => {
      execFile('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', INVENTORY_SCRIPT],
        { windowsHide: true, timeout, maxBuffer: 1024 * 1024, encoding: 'utf8' }, (error, stdout) => error ? reject(error) : resolve(stdout));
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
      return { known: true, roots: desktopRoots(result.processes, options) };
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
