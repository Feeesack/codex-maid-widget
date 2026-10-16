'use strict';
// Used only by check-launch-job.ps1, with a unique temporary directory and token.
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const [role, home, marker] = process.argv.slice(2);
if (!['launcher', 'direct', 'explorer'].includes(role) || !home || !/^[a-f0-9]{32}$/.test(marker || '')) {
  throw new Error('This isolated probe requires its test role, directory and token.');
}
function write(name, value) {
  const target = path.join(home, name + '.json');
  fs.writeFileSync(target + '.tmp', JSON.stringify({ marker, ...value }));
  fs.renameSync(target + '.tmp', target);
}
const powershell = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const sessionId = Number(execFileSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
  `[Diagnostics.Process]::GetProcessById(${process.pid}).SessionId`], { windowsHide: true, encoding: 'utf8' }).trim());
write(role, { role, pid: process.pid, parentPid: process.ppid, executable: process.execPath, sessionId, startedAt: Date.now() });
// Every probe self-expires even if its supervising test is unexpectedly stopped.
let heartbeat = 0;
const timer = setInterval(() => write(role + '-heartbeat', { role, pid: process.pid, heartbeat: ++heartbeat, at: Date.now() }), 200);
setTimeout(() => { clearInterval(timer); process.exit(0); }, 30000);
if (role === 'launcher') {
  (async () => {
    const direct = spawn(process.execPath, [__filename, 'direct', home, marker], {
      windowsHide: true, detached: true, stdio: 'ignore',
    });
    direct.on('error', error => write('launcher-error', { message: error.message }));
    direct.unref();
    const { launchThroughExplorer } = require('../src/windows-launch.cjs');
    await launchThroughExplorer({ executable: process.execPath, args: [__filename, 'explorer', home, marker], cwd: path.dirname(__dirname) });
    write('launch-ready', { pid: process.pid, directPid: direct.pid });
  })().catch(error => { write('launcher-error', { message: error.message }); process.exitCode = 1; });
}
