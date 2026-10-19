'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFile: nativeExecFile } = require('node:child_process');

const DEFAULT_TIMEOUT = 1500;
const DEFAULT_MAX_BUFFER = 4 * 1024 * 1024;
// Git for Windows understands /dev/null; Node's \\.\nul is not a Git config path.
const GIT_NULL = '/dev/null';
const REASONS = Object.freeze({
  workspace: '当前对话工作区不可用',
  missingGit: '未找到 Git',
  notRepository: '当前工作区不是 Git 仓库',
  timeout: 'Git 查询超时，请重试',
  workspaceTimeout: '工作区查询超时，请重试',
  tooLarge: 'Git 变更过多，暂时无法统计',
  failed: '暂时无法读取 Git 状态',
});

function gitEnvironment(source, systemConfig) {
  const env = {};
  // A parent Codex/Git process may carry a different worktree, index or injected
  // config. None of those may redirect this query away from the selected cwd.
  for (const [key, value] of Object.entries(source)) {
    if (!/^GIT_/i.test(key)) env[key] = value;
  }
  Object.assign(env, {
    GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0',
    LC_ALL: 'C', LANG: 'C',
  });
  // Keep normal global/system configuration so core.excludesFile and platform
  // ignores retain the same meaning as the user's git status. Tests inject an
  // isolated system config in addition to their isolated HOME/XDG paths.
  if (typeof systemConfig === 'string') env.GIT_CONFIG_SYSTEM = systemConfig;
  return env;
}

function findGit(env) {
  const candidates = [];
  if (process.platform === 'win32') {
    for (const root of [env.ProgramFiles, env.ProgramW6432, env['ProgramFiles(x86)']]) {
      if (root && path.isAbsolute(root)) candidates.push(path.join(root, 'Git', 'cmd', 'git.exe'));
    }
    if (env.LOCALAPPDATA && path.isAbsolute(env.LOCALAPPDATA)) {
      candidates.push(path.join(env.LOCALAPPDATA, 'Programs', 'Git', 'cmd', 'git.exe'));
    }
  } else {
    candidates.push('/opt/homebrew/bin/git', '/usr/local/bin/git', '/usr/bin/git');
  }
  const searchPath = Object.entries(env).find(([key]) => key.toUpperCase() === 'PATH')?.[1] || '';
  for (const entry of searchPath.split(path.delimiter)) {
    // Never rely on an implicit current directory to resolve an executable
    // named git. execFile always receives an absolute path.
    const directory = entry.replace(/^"(.*)"$/, '$1');
    if (path.isAbsolute(directory)) candidates.push(path.join(directory, process.platform === 'win32' ? 'git.exe' : 'git'));
  }
  for (const candidate of new Set(candidates)) {
    try { if (fs.statSync(candidate).isFile()) return candidate; }
    catch { /* A missing installation candidate is expected. */ }
  }
  return null;
}

function countPorcelain(output) {
  const bytes = Buffer.isBuffer(output) ? output : Buffer.from(output);
  const destinations = new Set();
  let offset = 0;
  while (offset < bytes.length) {
    const end = bytes.indexOf(0, offset);
    if (end < offset + 4 || bytes[offset + 2] !== 32) throw new Error('Invalid porcelain record');
    const status = bytes.toString('ascii', offset, offset + 2);
    if (!/^[ MADRCU?!T]{2}$/.test(status) || status === '  ' || status === '!!') {
      throw new Error('Invalid porcelain status');
    }
    destinations.add(bytes.subarray(offset + 3, end).toString('hex'));
    offset = end + 1;
    // With -z the destination comes first; the source is another NUL-terminated
    // path, without status columns. Both paths belong to one changed file.
    if (/[RC]/.test(status)) {
      const sourceEnd = bytes.indexOf(0, offset);
      if (sourceEnd <= offset) throw new Error('Incomplete rename or copy');
      offset = sourceEnd + 1;
    }
  }
  return destinations.size;
}

async function readGitStatus(cwd, options = {}) {
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd) || cwd.includes('\0')) {
    return { status: 'unavailable', reason: REASONS.workspace };
  }
  // A disconnected network workspace can block a synchronous stat on Windows.
  // Keep it off Electron's main thread and bound the caller's wait separately
  // from the Git subprocess budget.
  let statTimer;
  try {
    const info = await Promise.race([
      Promise.resolve().then(() => (options.stat || fs.promises.stat)(cwd)),
      new Promise((resolve, reject) => {
        statTimer = setTimeout(() => reject(Object.assign(new Error('Workspace stat timed out'), { code: 'ETIMEDOUT' })), 300);
      }),
    ]);
    if (!info.isDirectory()) return { status: 'unavailable', reason: REASONS.workspace };
  } catch (error) {
    return error?.code === 'ETIMEDOUT'
      ? { status: 'timeout', reason: REASONS.workspaceTimeout }
      : { status: 'unavailable', reason: REASONS.workspace };
  } finally { clearTimeout(statTimer); }
  const env = gitEnvironment(options.env || process.env, options.systemConfig);
  const executable = options.gitPath === undefined ? findGit(env) : options.gitPath;
  if (typeof executable !== 'string' || !path.isAbsolute(executable) || executable.includes('\0')) {
    return { status: 'unavailable', reason: REASONS.missingGit };
  }
  const timeout = Number.isFinite(options.timeout) && options.timeout > 0 ? Math.min(options.timeout, 10000) : DEFAULT_TIMEOUT;
  const maxBuffer = Number.isFinite(options.maxBuffer) && options.maxBuffer > 0 ? Math.min(options.maxBuffer, 16 * 1024 * 1024) : DEFAULT_MAX_BUFFER;
  const execFile = options.execFile || nativeExecFile;
  try {
    const output = await new Promise((resolve, reject) => {
      execFile(executable, [
        '--no-optional-locks', '--no-pager',
        '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false',
        '-c', 'core.hooksPath=' + GIT_NULL,
        'status', '--porcelain=v1', '-z', '--untracked-files=all',
      ], { cwd, env, windowsHide: true, shell: false, timeout, maxBuffer, encoding: 'buffer' },
      (error, stdout, stderr) => {
        if (error) {
          // Retain only classification flags, never paths or raw stderr.
          reject({
            missingGit: error.code === 'ENOENT',
            tooLarge: error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
            timedOut: error.killed === true || error.code === 'ETIMEDOUT',
            notRepository: error.code === 128 && /fatal: (?:not a git repository|this operation must be run in a work tree)/i.test(String(stderr || '')),
          });
        } else resolve(stdout);
      });
    });
    return { status: 'ready', count: countPorcelain(output) };
  } catch (error) {
    if (error?.missingGit) return { status: 'unavailable', reason: REASONS.missingGit };
    if (error?.tooLarge) return { status: 'unavailable', reason: REASONS.tooLarge };
    if (error?.timedOut) return { status: 'timeout', reason: REASONS.timeout };
    if (error?.notRepository) return { status: 'not-repository', reason: REASONS.notRepository };
    return { status: 'unavailable', reason: REASONS.failed };
  }
}

module.exports = { readGitStatus };
