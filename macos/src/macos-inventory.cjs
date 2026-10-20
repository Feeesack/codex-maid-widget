'use strict';
const { execFile: nativeExecFile } = require('node:child_process');
const path = require('node:path');
const { CODEX_BUNDLE_ID, MacBundleReader, bundleForExecutable, standardBundles } = require('./macos-bundle.cjs');

const MAX_OUTPUT_BYTES = 1024 * 1024;
const unavailable = () => ({ known: false, processes: [], reason: 'inventory-unavailable' });

function parseProcessMetadata(output, uid, names = new Set(['Codex', 'ChatGPT'])) {
  const candidates = [];
  const ids = new Set();
  for (const line of output.split('\n').filter(line => line.trim())) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (!match) throw new Error('Invalid process metadata');
    const [, owner, id, parent, name] = match;
    // ps may include a privileged helper whose effective UID differs.
    // Ignore other owners while retaining identity validation for this user.
    if (Number(owner) !== uid) continue;
    const pid = Number(id), parentPid = Number(parent);
    if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(parentPid) || ids.has(pid)) throw new Error('Invalid process identity');
    ids.add(pid);
    if (names.has(name)) candidates.push({ uid, pid, parentPid, name });
  }
  if (!ids.size) throw new Error('Empty process metadata');
  return candidates;
}

function parseTextPaths(output, candidates, uid) {
  const byId = new Map(candidates.map(item => [item.pid, { ...item, paths: [], owner: null }]));
  let current = null, descriptor = '';
  for (const raw of output.split('\0')) {
    const field = raw.replace(/^\n+/, '');
    if (!field) continue;
    const type = field[0], value = field.slice(1);
    if (type === 'p') {
      current = byId.get(Number(value));
      if (!current || !/^\d+$/.test(value)) throw new Error('Unexpected process');
      descriptor = '';
    } else if (type === 'u') {
      if (!current || !/^\d+$/.test(value) || Number(value) !== uid) throw new Error('Invalid owner');
      current.owner = uid;
    } else if (type === 'f') {
      if (!current || value !== 'txt') throw new Error('Unexpected descriptor');
      descriptor = value;
    } else if (type === 'n') {
      if (!current || descriptor !== 'txt' || !value.startsWith('/') || /[\0\r\n]/.test(value)) throw new Error('Invalid text path');
      current.paths.push(value);
    } else throw new Error('Unexpected field');
  }
  const processes = [];
  for (const item of byId.values()) {
    if (item.owner !== uid || !item.paths.length) throw new Error('Incomplete process metadata');
    // Darwin lsof reports the executable and mapped libraries as txt vnodes.
    // Only the exact app main executable can count as a desktop root.
    const executable = item.paths.find(file => bundleForExecutable(file)?.executable === item.name);
    if (executable) processes.push({ uid, pid: item.pid, parentPid: item.parentPid, name: item.name, path: executable });
  }
  return processes;
}

class MacOSInventoryQuery {
  constructor({ execFile = nativeExecFile, platform = process.platform, uid = process.getuid?.(), timeout = 7000, readBundle, homedir } = {}) {
    this.execFile = execFile;
    this.platform = platform;
    this.uid = uid;
    this.timeout = timeout;
    this.pending = null;
    this.children = new Set();
    this.closed = false;
    const bundleReader = new MacBundleReader();
    this.readBundle = readBundle || (bundle => bundleReader.read(bundle));
    this.bundles = standardBundles(homedir);
  }
  execute(file, args) {
    return new Promise((resolve, reject) => {
      let child;
      child = this.execFile(file, args, { windowsHide: true, timeout: this.timeout, maxBuffer: MAX_OUTPUT_BYTES, encoding: 'utf8' }, (error, stdout, stderr) => {
        this.children.delete(child);
        if (error || stderr?.trim()) reject(new Error('Process metadata unavailable'));
        else resolve(stdout);
      });
      if (child) this.children.add(child);
    });
  }
  query() {
    if (this.pending) return this.pending;
    if (this.closed) return Promise.resolve(unavailable());
    if (this.platform !== 'darwin') return Promise.resolve({ ...unavailable(), reason: 'unsupported-platform' });
    if (!Number.isSafeInteger(this.uid) || this.uid < 0) return Promise.resolve(unavailable());
    this.pending = this.read().catch(() => unavailable()).finally(() => { this.pending = null; });
    return this.pending;
  }
  async read() {
    // ucomm is p_comm from kernel process metadata. Unlike comm/command, it
    // never asks ps to read KERN_PROCARGS2 (argv/environment). -x includes GUI
    // apps without a terminal; -U and uid validation scope this to our user.
    const metadata = await this.execute('/bin/ps', ['-x', '-U', String(this.uid), '-o', 'uid=,pid=,ppid=,ucomm=']);
    if (this.closed) return unavailable();
    const names = new Set(['Codex', 'ChatGPT']);
    for (const bundle of this.bundles) {
      const info = this.readBundle(bundle);
      if (info?.identifier === CODEX_BUNDLE_ID) names.add(info.executable);
    }
    const candidates = parseProcessMetadata(metadata, this.uid, names);
    if (!candidates.length) return { known: true, processes: [] };
    const text = await this.execute('/usr/sbin/lsof', ['-nP', '-a', '-u', String(this.uid), '-p', candidates.map(item => item.pid).join(','), '-d', 'txt', '-F', 'pufn0']);
    if (this.closed) return unavailable();
    const processes = [];
    for (const item of parseTextPaths(text, candidates, this.uid)) {
      const bundle = bundleForExecutable(item.path);
      const info = this.readBundle(bundle.bundlePath);
      if (!info) throw new Error('Bundle metadata unavailable');
      if (info.identifier !== CODEX_BUNDLE_ID || info.executable !== path.posix.basename(item.path)) continue;
      processes.push({ ...item, bundleId: info.identifier, bundleExecutable: info.executable });
    }
    return { known: true, processes };
  }
  close() {
    this.closed = true;
    for (const child of this.children) { try { child.kill(); } catch {} }
    this.children.clear();
  }
}

module.exports = { MacOSInventoryQuery, parseProcessMetadata, parseTextPaths };
