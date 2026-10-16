'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function statIfPresent(io, file) {
  try { return io.statSync(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function prepareDataHome({ env = process.env, home = os.homedir(), legacyDir, fs: io = fs } = {}) {
  if (env.CODEX_MAID_HOME !== undefined && env.CODEX_MAID_HOME !== '') {
    if (typeof env.CODEX_MAID_HOME !== 'string' || env.CODEX_MAID_HOME.includes('\0')) throw new TypeError('Invalid CODEX_MAID_HOME');
    // An explicit profile is already the user's chosen destination. In
    // particular, isolated test profiles must never import real preferences.
    return path.resolve(env.CODEX_MAID_HOME);
  }
  const destination = path.resolve(home, '.codex-maid-widget');
  const settingsFile = path.join(destination, 'settings.json');
  const currentSettings = statIfPresent(io, settingsFile);
  if (currentSettings) {
    if (!currentSettings.isFile()) throw new Error('新设置路径不是文件，已保留原数据。');
    return destination;
  }

  const legacy = legacyDir ? path.resolve(legacyDir) : null;
  const oldSettings = legacy && path.join(legacy, 'settings.json');
  const oldCharacters = legacy && path.join(legacy, 'characters');
  const settingsInfo = oldSettings && statIfPresent(io, oldSettings);
  const charactersInfo = oldCharacters && statIfPresent(io, oldCharacters);
  if (settingsInfo && !settingsInfo.isFile()) throw new Error('旧设置路径不是文件，已保留原数据。');
  if (charactersInfo && !charactersInfo.isDirectory()) throw new Error('旧形象库路径不是目录，已保留原数据。');
  if (!settingsInfo && !charactersInfo) {
    io.mkdirSync(destination, { recursive: true });
    return destination;
  }

  const destinationInfo = statIfPresent(io, destination);
  // Never discard an incomplete destination that may contain recovered user
  // assets. A normal first migration has no destination (or an empty folder).
  if (destinationInfo && (!destinationInfo.isDirectory() || io.readdirSync(destination).length)) {
    throw new Error('新数据目录已有未完成的数据，已保留新旧目录，请先检查数据迁移。');
  }
  io.mkdirSync(path.dirname(destination), { recursive: true });
  const staging = io.mkdtempSync(path.join(path.dirname(destination), '.codex-maid-widget.migrating-'));
  try {
    if (settingsInfo) io.copyFileSync(oldSettings, path.join(staging, 'settings.json'), fs.constants.COPYFILE_EXCL);
    if (charactersInfo) io.cpSync(oldCharacters, path.join(staging, 'characters'), { recursive: true, errorOnExist: true, force: false });
    // Only complete, persistent preferences are published. Runtime control
    // records, helper records, authentication and browser caches stay behind.
    if (destinationInfo) io.rmdirSync(destination);
    io.renameSync(staging, destination);
  } catch (error) {
    // Another process may have finished the same first-run migration. Its
    // existing preferences take precedence, and our complete staging remains
    // available for inspection rather than being destructively cleaned up.
    if (statIfPresent(io, settingsFile)?.isFile()) return destination;
    const failure = new Error(`数据迁移未完成，旧目录及暂存目录均已保留：${staging}`, { cause: error });
    failure.code = 'DATA_HOME_MIGRATION_FAILED';
    failure.stagingDir = staging;
    throw failure;
  }
  return destination;
}

module.exports = { prepareDataHome };
