'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const MAX_BIN_ENTRIES = 128;
const MAX_CLI_BYTES = 512 * 1024 * 1024;
const missingCli = () => Object.assign(new Error('Codex CLI not found'), { code: 'CLI_MISSING' });

function candidateKey(value, platform) {
  if (typeof value !== 'string') return '';
  if (platform !== 'win32') return path.posix.normalize(value);
  let file = value.replaceAll('/', '\\');
  if (/^\\\\\?\\UNC\\/i.test(file)) file = '\\\\' + file.slice(8);
  else if (/^\\\\\?\\[a-z]:\\/i.test(file)) file = file.slice(4);
  return path.win32.normalize(file).toLowerCase();
}

function exclusions(excludedPaths, platform) {
  const values = excludedPaths instanceof Set || Array.isArray(excludedPaths) ? [...excludedPaths] : [];
  const keys = new Set(values.filter(value => typeof value === 'string').map(value => candidateKey(value, platform)));
  return candidate => keys.has(candidateKey(candidate, platform));
}

function executableFile(candidate, { platform, fileSystem, excluded }) {
  if (excluded(candidate)) return false;
  try {
    if (!fileSystem.statSync(candidate).isFile()) return false;
    if (platform !== 'win32') fileSystem.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch { return false; }
}

function safeWindowsRoot(root) {
  return typeof root === 'string' && /^(?:[a-z]:[\\/]|\\\\[^\\]+\\[^\\]+\\)/i.test(root)
    && path.win32.isAbsolute(root) && !/[\r\n\0]/.test(root)
    && !/(?:^|[\\/])\.{1,2}(?:[\\/]|$)/.test(root);
}

// Only inspect one level in a declared installation's bin folder. Do not treat
// the identifier as a version number: desktop updates may use opaque hashes.
// Refuse links, oversized inventories and files; never recurse or scan drives.
function versionedWindowsCandidates(root, fileSystem, excluded) {
  if (!safeWindowsRoot(root) || typeof fileSystem.lstatSync !== 'function'
    || typeof fileSystem.realpathSync !== 'function') return [];
  const bin = path.win32.join(root, 'bin');
  try {
    const plainDirectory = directory => {
      const stat = fileSystem.lstatSync(directory);
      return stat.isDirectory() && !stat.isSymbolicLink();
    };
    if (!plainDirectory(root) || !plainDirectory(bin)) return [];
    const realRoot = candidateKey(fileSystem.realpathSync(root), 'win32');
    const realBin = candidateKey(fileSystem.realpathSync(bin), 'win32');
    const within = (parent, child) => {
      const relative = path.win32.relative(parent, child);
      return !!relative && !path.win32.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..\\');
    };
    if (!within(realRoot, realBin)) return [];
    let entries;
    if (typeof fileSystem.opendirSync === 'function') {
      const directory = fileSystem.opendirSync(bin); entries = [];
      try {
        let entry;
        while ((entry = directory.readSync()) !== null) {
          if (entries.length === MAX_BIN_ENTRIES) return [];
          entries.push(entry);
        }
      } finally { directory.closeSync(); }
    } else {
      entries = fileSystem.readdirSync(bin, { withFileTypes: true });
      if (!Array.isArray(entries) || entries.length > MAX_BIN_ENTRIES) return [];
    }
    const candidates = [];
    for (const entry of entries) {
      const name = entry?.name;
      if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(name)
        || name.endsWith('.') || !entry.isDirectory() || entry.isSymbolicLink()) continue;
      const directory = path.win32.join(bin, name), candidate = path.win32.join(directory, 'codex.exe');
      if (excluded(candidate)) continue;
      try {
        if (!plainDirectory(directory)) continue;
        const stat = fileSystem.lstatSync(candidate);
        if (!stat.isFile() || stat.isSymbolicLink() || !Number.isFinite(stat.size)
          || stat.size <= 0 || stat.size > MAX_CLI_BYTES) continue;
        const realDirectory = candidateKey(fileSystem.realpathSync(directory), 'win32');
        const realCandidate = candidateKey(fileSystem.realpathSync(candidate), 'win32');
        if (!within(realBin, realDirectory) || !within(realDirectory, realCandidate)) continue;
        const modified = fileSystem.lstatSync(directory).mtimeMs;
        candidates.push({ candidate, modified: Number.isFinite(modified) ? modified : 0, name });
      } catch { /* an incomplete update or inaccessible candidate is skipped */ }
    }
    candidates.sort((a, b) => b.modified - a.modified ||
      (a.name.toLowerCase() < b.name.toLowerCase() ? -1 : a.name.toLowerCase() > b.name.toLowerCase() ? 1 : 0) ||
      (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return candidates.map(item => item.candidate);
  } catch { return []; }
}

function findCodexCandidate(explicitPath, { platform = process.platform, env = process.env,
  fileSystem = fs, excludedPaths, homedir, readBundle } = {}) {
  const excluded = exclusions(excludedPaths, platform);
  if (explicitPath) {
    if (typeof explicitPath !== 'string' || /[\r\n\0]/.test(explicitPath) || excluded(explicitPath)) throw missingCli();
    return explicitPath;
  }
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const usable = candidate => executableFile(candidate, { platform, fileSystem, excluded });
  const names = platform === 'win32' ? ['codex.exe', 'codex.cmd', 'codex.bat'] : ['codex'];
  for (const directory of (environmentValue(env, 'PATH', platform) || '').split(platform === 'win32' ? ';' : ':').filter(Boolean)) {
    for (const name of names) {
      const candidate = paths.join(directory.replace(/^"|"$/g, ''), name);
      if (usable(candidate)) return candidate;
    }
  }
  const localAppData = environmentValue(env, 'LOCALAPPDATA', platform);
  if (platform === 'win32' && safeWindowsRoot(localAppData)) {
    const roots = [paths.join(localAppData, 'Programs', 'OpenAI', 'Codex'), paths.join(localAppData, 'OpenAI', 'Codex')];
    // Keep established direct layouts ahead of newly discovered installations.
    for (const root of roots) {
      const candidate = paths.join(root, 'bin', 'codex.exe');
      if (usable(candidate)) return candidate;
    }
    for (const root of roots) {
      const candidates = versionedWindowsCandidates(root, fileSystem, excluded);
      if (candidates.length) return candidates[0];
    }
  }
  if (platform === 'darwin') {
    const home = homedir ?? os.homedir();
    // Load bundle metadata only on macOS and only when PATH did not resolve it.
    let reader;
    const read = readBundle || (bundle => {
      reader ||= new (require('./macos-bundle.cjs').MacBundleReader)({ fileSystem });
      return reader.read(bundle);
    });
    for (const directory of ['/Applications', paths.join(home, 'Applications')]) {
      for (const name of ['Codex.app', 'ChatGPT.app']) {
        const bundle = paths.join(directory, name);
        try {
          const info = read(bundle);
          if (info?.identifier !== 'com.openai.codex' || typeof info.executable !== 'string'
            || !info.executable || /[\\/\0\r\n]/.test(info.executable) || ['.', '..'].includes(info.executable)
            || !usable(paths.join(bundle, 'Contents', 'MacOS', info.executable))) continue;
          for (const relative of ['codex', 'bin/codex']) {
            const candidate = paths.join(bundle, 'Contents', 'Resources', relative);
            if (usable(candidate)) return candidate;
          }
        } catch { /* next installation */ }
      }
    }
    for (const candidate of ['/opt/homebrew/bin/codex', '/usr/local/bin/codex', paths.join(home, '.local', 'bin', 'codex')]) {
      if (usable(candidate)) return candidate;
    }
  }
  throw missingCli();
}

function environmentValue(env, name, platform = process.platform) {
  const key = platform === 'win32' ? Object.keys(env).sort().find(key => key.toLowerCase() === name.toLowerCase()) : name;
  return key === undefined ? undefined : env[key];
}

function codexCommandInvocation(executable, args, { platform = process.platform, env = process.env } = {}) {
  if (platform !== 'win32' || !/\.(cmd|bat)$/i.test(executable)) return { file: executable, args };
  // A cmd script needs the command processor. Refuse expansion/quoting syntax
  // in all tokens, including user-selected plugin paths passed by the connector.
  if ([executable, ...args].some(value => typeof value !== 'string' || /["\r\n\0%^!]/.test(value)))
    throw Object.assign(new Error('Unsupported shim argument'), { code: 'CLI_MISSING' });
  const command = [executable, ...args].map(value => `"${value}"`).join(' ');
  return { file: environmentValue(env, 'ComSpec', platform) || 'cmd.exe',
    args: ['/d', '/s', '/c', `"${command}"`], windowsVerbatimArguments: true };
}

function aborted() { return Object.assign(new Error('CLI discovery cancelled'), { code: 'ABORT_ERR' }); }
async function withAbort(operation, signal) {
  if (!signal) return operation();
  if (signal.aborted) throw aborted();
  let listener;
  const cancelled = new Promise((_, reject) => { listener = () => reject(aborted()); signal.addEventListener('abort', listener, { once: true }); });
  try { return await Promise.race([operation(), cancelled]); }
  finally { signal.removeEventListener('abort', listener); }
}

async function desktopInventory({ signal, createInventory = options => require('./codex-desktop.cjs').createDesktopInventoryQuery(options), ...options } = {}) {
  if (signal?.aborted) throw aborted();
  const query = createInventory(options); let stopped = false;
  const stop = () => { if (!stopped) { stopped = true; query.close(); } };
  signal?.addEventListener('abort', stop, { once: true });
  try { return await query.query(); }
  finally { signal?.removeEventListener('abort', stop); stop(); }
}

// Explorer and login items need not inherit a terminal's PATH. Discover only
// the CLI bundled beside an identity-verified desktop, without a shell, a disk
// scan, authentication reads, or assumptions about the WindowsApps volume.
async function resolveCodexExecutable(explicitPath, { find, platform = process.platform,
  queryDesktop = desktopInventory, fileSystem = fs, signal, uid = process.getuid?.(), excludedPaths, ...inventoryOptions } = {}) {
  if (signal?.aborted) throw aborted();
  const excluded = exclusions(excludedPaths, platform);
  let missing;
  try {
    const candidate = find(explicitPath, { excludedPaths });
    if (excluded(candidate)) throw missingCli();
    return candidate;
  }
  catch (error) {
    if (error?.code !== 'CLI_MISSING' || explicitPath || !['win32', 'darwin'].includes(platform)) throw error;
    missing = error;
  }
  let observation;
  try { observation = await withAbort(() => queryDesktop({ ...inventoryOptions, platform, signal, uid }), signal); }
  catch (error) { if (error?.code === 'ABORT_ERR') throw error; throw missing; }
  if (observation?.known !== true || !Array.isArray(observation.roots)) throw missing;
  for (const root of observation.roots) {
    if (platform === 'darwin') {
      if (root?.bundleId !== 'com.openai.codex' || typeof root.path !== 'string' || /[\r\n\0]/.test(root.path)
        || !Number.isInteger(root.uid) || root.uid < 0 || uid !== undefined && root.uid !== uid) continue;
      const match = /^(\/.*\.app)\/Contents\/MacOS\/([^/]+)$/.exec(root.path);
      if (!match || match[2] !== root.bundleExecutable || path.posix.normalize(root.path) !== root.path) continue;
      for (const relative of ['codex', 'bin/codex']) {
        const candidate = path.posix.join(match[1], 'Contents', 'Resources', relative);
        if (executableFile(candidate, { platform, fileSystem, excluded })) return candidate;
      }
      continue;
    }
    if (root?.officialDesktop !== true || typeof root.path !== 'string'
      || !safeWindowsRoot(root.path)) continue;
    const directory = path.win32.dirname(root.path);
    for (const relative of ['resources\\codex.exe', 'bin\\codex.exe']) {
      const candidate = path.win32.join(directory, relative);
      if (executableFile(candidate, { platform, fileSystem, excluded })) return candidate;
    }
    const candidates = versionedWindowsCandidates(directory, fileSystem, excluded);
    if (candidates.length) return candidates[0];
  }
  throw missing;
}

module.exports = { findCodexCandidate, resolveCodexExecutable, environmentValue, desktopInventory, codexCommandInvocation };
