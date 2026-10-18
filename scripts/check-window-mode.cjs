'use strict';
// Launch only the window adapter with a new profile and self-owned native host.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');
function option(name, fallback) {
  const at = process.argv.indexOf('--' + name);
  if (at < 0) return fallback;
  assert.ok(process.argv[at + 1] && !process.argv[at + 1].startsWith('--'), 'Missing --' + name);
  return process.argv[at + 1];
}
async function run() {
  assert.equal(process.platform, 'win32', 'This native window check currently requires Windows.');
  const output = path.resolve(option('output', path.join(root, 'tmp', 'window-mode-check')));
  fs.mkdirSync(output, { recursive: true });
  const runDir = fs.mkdtempSync(path.join(output, 'run-'));
  const factors = [...new Set(option('dpi', '1,1.5').split(',').map(Number))];
  assert.ok(factors.length && factors.every(value => Number.isFinite(value) && value >= 1 && value <= 3), 'Invalid --dpi');
  const reports = [];
  const executable = path.resolve(option('electron', require('electron')));
  assert.ok(fs.existsSync(executable), 'Electron executable not found.');
  for (const factor of factors) {
    const profile = path.join(runDir, 'dpi-' + factor);
    for (const child of ['', 'codex', 'appdata', 'localappdata', 'userData', 'sessionData', 'crashDumps', 'widget',
      'Desktop', 'Documents', 'Downloads', 'Pictures', 'Music', 'Videos', 'Favorites', 'Links', 'Recent']) fs.mkdirSync(path.join(profile, child), { recursive: true });
    const configFile = path.join(profile, 'check-config.json'), reportFile = path.join(profile, 'report.json');
    fs.writeFileSync(configFile, JSON.stringify({ profile, reportFile, factor, probeCodex: process.argv.includes('--probe-codex') }));
    const env = { ...process.env, CODEX_MAID_WINDOW_CHECK: configFile, CODEX_HOME: path.join(profile, 'codex'),
      CODEX_MAID_HOME: path.join(profile, 'widget'), HOME: profile, USERPROFILE: profile,
      APPDATA: path.join(profile, 'appdata'), LOCALAPPDATA: path.join(profile, 'localappdata') };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(executable, [path.join(__dirname, 'window-mode-check.cjs'), '--force-device-scale-factor=' + factor],
      { cwd: root, env, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore'] });
    const exit = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { child.kill(); reject(new Error('Native window mode check timed out.')); }, 120000);
      child.once('error', () => { clearTimeout(timeout); reject(new Error('Could not launch isolated Electron.')); });
      child.once('exit', code => { clearTimeout(timeout); resolve(code); });
    });
    const report = fs.existsSync(reportFile) ? JSON.parse(fs.readFileSync(reportFile, 'utf8')) : null;
    assert.ok(report, 'Electron exited without a window mode report.');
    reports.push(report);
    fs.writeFileSync(path.join(runDir, 'summary.json'), JSON.stringify({ ok: reports.every(item => item.ok), reports }, null, 2));
    assert.equal(exit, 0, report.error || 'Isolated Electron failed.');
    assert.equal(report.ok, true, report.error);
    console.log(JSON.stringify({ dpi: factor, cases: report.cases.length, realNativeChild: report.realNativeChild, realProductionProvider: report.realProductionProvider,
      optionalCodexProbe: report.codexProbe?.known, report: path.relative(root, reportFile) }));
  }
  console.log('PASS: isolated native Codex window mode adapter. Evidence: ' + path.join(runDir, 'summary.json'));
}
run().catch(error => { console.error(error.message); process.exitCode = 1; });
