'use strict';
// Run native Electron geometry checks without loading a user's widget profile.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');
function option(name, fallback) {
  const at = process.argv.indexOf('--' + name);
  if (at < 0) return fallback;
  assert.ok(process.argv[at + 1] && !process.argv[at + 1].startsWith('--'), 'Missing --' + name + ' value');
  return process.argv[at + 1];
}
function numbers(name, fallback, min, max) {
  const result = option(name, fallback).split(',').map(Number);
  assert.ok(result.length && result.every(value => Number.isFinite(value) && value >= min && value <= max), 'Invalid --' + name);
  return [...new Set(result)];
}
async function run() {
  const output = path.resolve(option('output', path.join(root, 'tmp', 'drag-dpi-check')));
  fs.mkdirSync(output, { recursive: true });
  // A fresh run directory prevents previous evidence from satisfying this run.
  const runDir = fs.mkdtempSync(path.join(output, 'run-'));
  const factors = numbers('dpi', '1,1.25,1.5,1.75,2', 1, 3);
  const scales = numbers('scales', '0.6,1,1.4', 0.6, 1.6);
  const moves = Number(option('moves', '420'));
  assert.ok(Number.isInteger(moves) && moves >= 300 && moves <= 3000, '--moves must be 300..3000');
  const main = path.resolve(option('main', path.join(root, 'src', 'main.cjs')));
  const baselineOption = option('baseline-main', '');
  const baselineMain = baselineOption ? path.resolve(baselineOption) : null;
  for (const file of [main, baselineMain].filter(Boolean)) assert.ok(fs.statSync(file).isFile(), 'Missing main source');
  const reports = [];
  for (const factor of factors) {
    const profile = path.join(runDir, 'dpi-' + factor);
    for (const child of ['', 'codex', 'appdata', 'localappdata', 'userData', 'sessionData', 'crashDumps', 'widget']) fs.mkdirSync(path.join(profile, child), { recursive: true });
    const configFile = path.join(profile, 'check-config.json');
    const reportFile = path.join(profile, 'report.json');
    fs.writeFileSync(configFile, JSON.stringify({ profile, reportFile, factor, scales, moves, main, baselineMain }));
    const env = { ...process.env, CODEX_MAID_DRAG_CHECK: configFile,
      CODEX_MAID_HOME: path.join(profile, 'widget'), CODEX_HOME: path.join(profile, 'codex'),
      HOME: profile, USERPROFILE: profile, APPDATA: path.join(profile, 'appdata'), LOCALAPPDATA: path.join(profile, 'localappdata') };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(require('electron'), [path.join(__dirname, 'drag-dpi-check.cjs'), '--force-device-scale-factor=' + factor], {
      cwd: root, env, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore'],
    });
    const exit = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { child.kill(); reject(new Error('Native DPI check timed out at ' + factor)); }, 90000);
      child.once('error', error => { clearTimeout(timeout); reject(error); });
      child.once('exit', code => { clearTimeout(timeout); resolve(code); });
    });
    const report = fs.existsSync(reportFile) ? JSON.parse(fs.readFileSync(reportFile, 'utf8')) : null;
    assert.ok(report, 'Electron exited without a report at DPI ' + factor);
    reports.push(report);
    fs.writeFileSync(path.join(runDir, 'summary.json'), JSON.stringify({ ok: reports.every(item => item.ok), reports }, null, 2));
    assert.equal(exit, 0, report.error || 'Electron failed');
    assert.equal(report.ok, true, report.error);
    const legacy = report.cases.filter(item => item.variant === 'baseline');
    const fixed = report.cases.filter(item => item.variant === 'fixed');
    assert.equal(report.corners.length, scales.length * 2, 'Both corners must be exercised at every size.');
    console.log(JSON.stringify({ dpi: factor, fixedCases: fixed.length, cornerCases: report.corners.length, baselineReproduced: legacy.some(item => item.sizeDrifted),
      baselineWidthRanges: legacy.map(item => ({ scale: item.scale, min: item.minWidth, max: item.maxWidth })), report: path.relative(root, reportFile) }));
  }
  console.log('PASS: native production drag handlers keep preferred DIP size; both corner peeks follow the pointer in both axes, unfold continuously and settle only at bottom corners. Evidence: ' + path.join(runDir, 'summary.json'));
}
run().catch(error => { console.error(error.message); process.exitCode = 1; });
