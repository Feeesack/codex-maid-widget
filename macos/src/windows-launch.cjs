'use strict';
const path = require('node:path');
const { execFile: nativeExecFile } = require('node:child_process');
const { runtimeEnvironmentArguments } = require('./runtime-environment.cjs');
const { powershellExecutable } = require('./windows-system.cjs');

const LAUNCH_ERROR = '无法通过 Windows 桌面启动助手。';

function checkedString(value, name, { empty = true } = {}) {
  if (typeof value !== 'string' || value.includes('\0') || (!empty && !value.length)) {
    throw new TypeError(`Invalid ${name}`);
  }
  return value;
}

// ShellExecute accepts one Windows command line rather than an argv array.
// Double backslashes before quotes and the closing quote so they survive the
// CommandLineToArgvW/CRT rules used by Electron's executable.
function quoteWindowsArgument(value) {
  checkedString(value, 'argument');
  return '"' + value.replace(/(\\*)"/g, (_match, slashes) => slashes + slashes + '\\"')
    .replace(/(\\+)$/g, '$1$1') + '"';
}

function buildExplorerLaunchScript({ executable, args = [], cwd = path.dirname(executable) } = {}) {
  checkedString(executable, 'executable', { empty: false });
  checkedString(cwd, 'working directory', { empty: false });
  if (!Array.isArray(args)) throw new TypeError('Invalid arguments');
  const payload = Buffer.from(JSON.stringify({ executable, argLine: args.map(quoteWindowsArgument).join(' '), cwd }), 'utf8').toString('base64');
  // Only a base64 alphabet is interpolated into this script. None of the file
  // paths or arguments can become PowerShell source, even with quotes/newlines.
  return `
$ErrorActionPreference = 'Stop'
try {
  $payload = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}')) | ConvertFrom-Json
  $shell = New-Object -ComObject Shell.Application
  $desktopHwnd = 0
  $desktop = $shell.Windows().FindWindowSW(0, 0, 8, [ref]$desktopHwnd, 1)
  if ($null -eq $desktop) { throw 'Desktop unavailable' }
  $desktop.Document.Application.ShellExecute([string]$payload.executable, [string]$payload.argLine, [string]$payload.cwd, '', 0)
  @{ launched = $true } | ConvertTo-Json -Compress
} catch { exit 1 }
`;
}

async function launchThroughExplorer({ executable, args = [], cwd = path.dirname(executable), env = process.env, execFile = nativeExecFile, timeout = 7000 } = {}) {
  const script = buildExplorerLaunchScript({ executable, args: runtimeEnvironmentArguments(args, env), cwd });
  const command = Buffer.from(script, 'utf16le').toString('base64');
  let output;
  try {
    output = await new Promise((resolve, reject) => {
      execFile(powershellExecutable(env), ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', command],
        { windowsHide: true, timeout, maxBuffer: 64 * 1024, encoding: 'utf8' },
        (error, stdout) => error ? reject(error) : resolve(stdout));
    });
    const result = JSON.parse(typeof output === 'string' ? output.replace(/^\uFEFF/, '').trim() : '');
    if (result?.launched !== true) throw new Error(LAUNCH_ERROR);
  } catch {
    throw new Error(LAUNCH_ERROR);
  }
  // ShellExecute does not return a child PID. The caller must separately wait
  // for the assistant's ready record before treating dispatch as startup.
  return { launched: true };
}

function isFollowStartupEnabled(settings,executable) {
  // Electron's openAtLogin can be false for a correctly enabled named entry
  // with quoted arguments. Inspect that exact registered item instead.
  const expected=path.win32.normalize(executable).toLowerCase();
  return settings?.executableWillLaunchAtLogin===true && Array.isArray(settings.launchItems) &&
    settings.launchItems.some(item=>item.name==='CodexMaidFollow' && item.enabled===true &&
      typeof item.path==='string' && path.win32.normalize(item.path).toLowerCase()===expected);
}

module.exports = { launchThroughExplorer, buildExplorerLaunchScript, quoteWindowsArgument, isFollowStartupEnabled };
