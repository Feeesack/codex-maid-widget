'use strict';
const fs = require('node:fs');
const path = require('node:path');

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
  queryDesktop = desktopInventory, fileSystem = fs, signal, uid = process.getuid?.(), ...inventoryOptions } = {}) {
  if (signal?.aborted) throw aborted();
  let missing;
  try { return find(explicitPath); }
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
        try {
          if (!fileSystem.statSync(candidate).isFile()) continue;
          fileSystem.accessSync(candidate, fs.constants.X_OK);
          return candidate;
        } catch { /* next declared layout */ }
      }
      continue;
    }
    if (root?.officialDesktop !== true || typeof root.path !== 'string'
      || !path.win32.isAbsolute(root.path) || /[\r\n\0]/.test(root.path)) continue;
    const directory = path.win32.dirname(root.path);
    for (const relative of ['resources\\codex.exe', 'bin\\codex.exe']) {
      const candidate = path.win32.join(directory, relative);
      try { if (fileSystem.statSync(candidate).isFile()) return candidate; } catch { /* next declared layout */ }
    }
  }
  throw missing;
}

module.exports = { resolveCodexExecutable, environmentValue, desktopInventory, codexCommandInvocation };
