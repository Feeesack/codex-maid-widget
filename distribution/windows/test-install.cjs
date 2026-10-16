'use strict';
// Run the exact distributable through install, runtime, upgrade and uninstall.
// TESTMODE suppresses real shortcuts, uninstall registration, Codex connection
// and initial launch. Runtime checks use a separate data and Codex profile.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');
const readline = require('node:readline');
const { inventory } = require('./build.cjs');

const root = path.resolve(__dirname, '../..');
const { checkVersions } = require('../check-versions.cjs');
const version = checkVersions({ root });
const installer = path.join(root, `release/installers/Codex-Maid-Widget-${version}-windows-x64-setup.exe`);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function eventually(fn, label, timeout = 15000) {
  let last;
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    try { const value = await fn(); if (value) return value; } catch (error) { last = error; }
    await pause(150);
  }
  throw new Error(`${label} timed out${last ? ': ' + last.message : ''}`);
}
function ps(script) {
  const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(result.stderr || 'PowerShell failed');
  return result.stdout.trim();
}
function protectedSystemState() {
  // Commands remain in memory and are not printed or saved in the report.
  return ps(`$ErrorActionPreference='Stop'; $out=[ordered]@{}; foreach($key in @('HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run','HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\CodexMaidWidget.Windows_is1','HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\CodexMaidWidget.InstallerTest_is1')) { if(Test-Path -LiteralPath $key) { $value=Get-ItemProperty -LiteralPath $key; $out[$key]=[ordered]@{}; foreach($property in $value.PSObject.Properties | Sort-Object Name) { if($property.Name -notlike 'PS*') {$out[$key][$property.Name]=$property.Value} } } }; $out | ConvertTo-Json -Compress -Depth 8`);
}
function runExecutable(file, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { windowsHide: true, stdio: 'ignore' });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(`${path.basename(file)} exited ${code}`)));
  });
}
function request(control, route, action) {
  return new Promise((resolve, reject) => {
    const body = action ? JSON.stringify({ action }) : undefined;
    const req = http.request({ hostname: '127.0.0.1', port: control.port, path: route, method: body ? 'POST' : 'GET', headers: { Authorization: 'Bearer ' + control.token, ...(body ? { 'Content-Type': 'application/json' } : {}) }, timeout: 5000 }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => { try { assert.equal(res.statusCode, 200); resolve(JSON.parse(data)); } catch (error) { reject(error); } });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Control request timed out')));
    req.end(body);
  });
}
async function verifyMcp(executable, server, env) {
  const child = spawn(executable, [server], { env: { ...env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map(); let id = 0; let errors = '';
  child.stderr.on('data', chunk => { errors += chunk; });
  const lines = readline.createInterface({ input: child.stdout });
  lines.on('line', line => {
    try { const value = JSON.parse(line); pending.get(value.id)?.(value); } catch {}
  });
  function call(method, params) {
    return new Promise((resolve, reject) => {
      const next = ++id;
      const timer = setTimeout(() => { pending.delete(next); reject(new Error(`MCP ${method} timed out: ${errors}`)); }, 5000);
      pending.set(next, value => { clearTimeout(timer); pending.delete(next); resolve(value); });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: next, method, params }) + '\n');
    });
  }
  try {
    const hello = await call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'installed-payload-test', version: '1' } });
    assert.equal(hello.result.serverInfo.name, 'codex-maid-widget');
    assert.equal(hello.result.serverInfo.version, version);
    const tools = await call('tools/list');
    assert.equal(tools.result.tools.length, 2);
    const status = await call('tools/call', { name: 'get_widget_status', arguments: {} });
    assert.equal(status.result.isError, undefined);
    const widget = JSON.parse(status.result.content[0].text);
    assert.equal(widget.version, version);
    assert.equal(widget.demo, true);
    const action = await call('tools/call', { name: 'control_widget', arguments: { action: 'show' } });
    assert.equal(action.result.isError, undefined);
  } finally {
    child.stdin.end();
    await eventually(() => child.exitCode !== null || child.signalCode !== null, 'MCP process exit', 5000).catch(() => child.kill());
  }
}
function findMcp(folder) {
  for (const item of fs.readdirSync(folder, { withFileTypes: true })) {
    const file = path.join(folder, item.name);
    if (item.isDirectory()) { const found = findMcp(file); if (found) return found; }
    else if (item.name === 'mcp.cjs') return file;
  }
}

async function main() {
  if (process.platform !== 'win32') throw new Error('Windows installer test requires Windows.');
  const before = protectedSystemState();
  const base = path.join(root, 'tmp');
  fs.mkdirSync(base, { recursive: true });
  const fixture = fs.mkdtempSync(path.join(base, 'codex-maid-installer-test-'));
  const target = path.join(fixture, 'app with spaces');
  const profile = path.join(fixture, 'widget-profile');
  const codex = path.join(fixture, 'codex-profile');
  fs.mkdirSync(profile); fs.mkdirSync(codex);
  const marker = path.join(profile, 'preserve-after-uninstall.txt');
  fs.writeFileSync(marker, 'This user data must survive upgrade and uninstall.\n');
  const metadata = JSON.parse(fs.readFileSync(installer + '.payload.json', 'utf8'));
  let app;
  try {
    await runExecutable(installer, ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/TESTMODE=1', `/DIR=${target}`, `/LOG=${path.join(fixture, 'install.log')}`]);
    const actual = inventory(target);
    for (const [name, sha] of Object.entries(metadata.installedPayload)) assert.equal(actual[name], sha, `Installed payload differs: ${name}`);
    assert.equal(protectedSystemState(), before, 'Isolated installation changed protected registry state.');
    const executable = path.join(target, 'Codex-Maid-Widget.exe');
    const env = { ...process.env, CODEX_MAID_HOME: profile, CODEX_HOME: codex };
    delete env.ELECTRON_RUN_AS_NODE;
    app = spawn(executable, ['--demo', '--maid-home=' + profile], { env, stdio: 'ignore', windowsHide: true });
    const control = await eventually(() => {
      const value = JSON.parse(fs.readFileSync(path.join(profile, 'control.json'), 'utf8'));
      return value.pid === app.pid && value;
    }, 'Installed application control server');
    const status = await request(control, '/status');
    assert.equal(status.version, version); assert.equal(status.demo, true);
    assert.ok(status.characterCount >= 2, 'Bundled character assets are missing.');
    for (const action of ['hide', 'show', 'refresh', 'bounce', 'settings']) assert.equal((await request(control, '/action', action)).ok, true);
    await verifyMcp(executable, findMcp(path.join(target, 'resources/integration')), env);
    assert.equal(protectedSystemState(), before, 'Demo runtime changed protected registry state.');
    await runExecutable(installer, ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/TESTMODE=1', `/DIR=${target}`, `/LOG=${path.join(fixture, 'upgrade.log')}`]);
    await eventually(() => app.exitCode !== null || app.signalCode !== null, 'Upgrade stops only the installed demo application');
    assert.equal(fs.readFileSync(marker, 'utf8'), 'This user data must survive upgrade and uninstall.\n');
    const upgraded = inventory(target);
    for (const [name, sha] of Object.entries(metadata.installedPayload)) assert.equal(upgraded[name], sha, `Upgrade payload differs: ${name}`);
    await runExecutable(path.join(target, 'uninstall/unins000.exe'), ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', `/LOG=${path.join(fixture, 'uninstall.log')}`]);
    await eventually(() => !fs.existsSync(executable), 'Uninstall removes installed executable');
    assert.ok(fs.existsSync(marker), 'Uninstall removed user data.');
    assert.equal(protectedSystemState(), before, 'Upgrade/uninstall changed protected registry state.');
    const report = { passed: true, fixture, installer, checks: ['full-payload-sha256', 'isolated-install', 'bundled-runtime-launch', 'version-' + version, 'bundled-characters', 'five-desktop-controls', 'bundled-runtime-mcp-initialize-list-status-action', 'upgrade-closes-installed-widget', 'upgrade-preserves-profile', 'uninstall-removes-application', 'uninstall-preserves-profile', 'real-startup-and-uninstall-registry-unchanged'] };
    fs.writeFileSync(path.join(root, 'release/installers/windows-install-test.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report, null, 2));
  } finally {
    if (app && app.exitCode === null && app.signalCode === null) app.kill();
    assert.equal(protectedSystemState(), before, 'Protected registry state differs after test cleanup.');
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
