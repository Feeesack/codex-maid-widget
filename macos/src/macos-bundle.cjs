'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const CODEX_BUNDLE_ID = 'com.openai.codex';

function bundleForExecutable(file) {
  if (typeof file !== 'string' || /[\0\r\n]/.test(file) || !path.posix.isAbsolute(file)) return null;
  const match = /^(.*\.app)\/Contents\/MacOS\/([^/]+)$/.exec(path.posix.normalize(file));
  return match ? { bundlePath: match[1], executable: match[2] } : null;
}

function standardBundles(homedir = os.homedir()) {
  return ['/Applications', path.posix.join(homedir, 'Applications')].flatMap(directory => ['Codex.app', 'ChatGPT.app'].map(name => path.posix.join(directory, name)));
}

class MacBundleReader {
  constructor({ fileSystem = fs, execute = execFileSync, timeout = 3000 } = {}) {
    this.fileSystem = fileSystem;
    this.execute = execute;
    this.timeout = timeout;
    this.cache = new Map();
  }
  read(bundlePath) {
    if (typeof bundlePath !== 'string' || !path.posix.isAbsolute(bundlePath) || /[\0\r\n]/.test(bundlePath)) throw new Error('Invalid bundle path');
    const info = path.posix.join(bundlePath, 'Contents', 'Info.plist');
    let stat;
    try { stat = this.fileSystem.statSync(info); }
    catch (error) {
      this.cache.delete(info);
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
      throw error;
    }
    if (!stat.isFile()) return null;
    const signature = [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');
    const cached = this.cache.get(info);
    if (cached?.signature === signature) return cached.metadata;
    // This reads application metadata only. No user preferences, credentials,
    // process arguments or environment blocks are opened.
    const value = JSON.parse(this.execute('/usr/bin/plutil', ['-convert', 'json', '-o', '-', info], {
      encoding: 'utf8', timeout: this.timeout, maxBuffer: 1024 * 1024, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
    }));
    const identifier = value?.CFBundleIdentifier, executable = value?.CFBundleExecutable;
    if (typeof identifier !== 'string' || typeof executable !== 'string' || !executable || /[\\/\0\r\n]/.test(executable)) throw new Error('Invalid bundle metadata');
    const metadata = { identifier, executable };
    this.cache.set(info, { signature, metadata });
    return metadata;
  }
}

module.exports = { CODEX_BUNDLE_ID, MacBundleReader, bundleForExecutable, standardBundles };
