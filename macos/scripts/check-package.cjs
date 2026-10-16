'use strict';
// Real packaged .app, isolated profile, demo data, and following disabled.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { parseArgs } = require('node:util');
const readline = require('node:readline');
const { packageDirectory } = require('./build-config.cjs');
const { verifyPackage } = require('./verify-package.cjs');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function checkBundledMcp(packed, home) {
  const server = path.join(packed.resources, 'integration', 'plugins', 'codex-maid-widget', 'mcp.cjs');
  const child = spawn(packed.executable, [server], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', CODEX_MAID_HOME: home }, stdio: ['pipe', 'pipe', 'pipe'] });
  const lines = readline.createInterface({ input: child.stdout });
  const pending = new Map(); let nextId = 0, errors = '';
  child.stderr.on('data', data => { errors += data; });
  child.on('error', error => { for (const request of pending.values()) request.reject(error); });
  child.on('exit', code => { for (const request of pending.values()) request.reject(new Error(`Bundled MCP exited early (${code}): ${errors}`)); });
  lines.on('line', line => {
    try {
      const message = JSON.parse(line); pending.get(message.id)?.resolve(message); pending.delete(message.id);
    } catch (error) { for (const request of pending.values()) request.reject(error); }
  });
  const call = (method, params) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('Bundled MCP timed out: ' + errors)); }, 10000);
    pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  try {
    const handshake = await call('initialize', { protocolVersion: '2025-06-18' });
    assert.equal(handshake.result.serverInfo.name, 'codex-maid-widget');
    const result = await call('tools/call', { name: 'get_widget_status', arguments: {} });
    assert.equal(result.result.isError, undefined); assert.equal(JSON.parse(result.result.content[0].text).status, 'demo');
    const action = await call('tools/call', { name: 'control_widget', arguments: { action: 'show' } });
    assert.equal(action.result.isError, undefined); assert.equal(JSON.parse(action.result.content[0].text).ok, true);
  } finally { lines.close(); child.kill(); }
}
async function main() {
  if (process.platform !== 'darwin') throw new Error('运行 .app 验证需要真实 macOS；当前仅能执行 npm test。');
  const { values } = parseArgs({ options: { directory: { type: 'string' } } });
  const root = path.resolve(__dirname, '..');
  const directory = values.directory || packageDirectory(root, process.arch);
  const packed = await verifyPackage({ directory, arch: process.arch });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'maid-packaged-check-'));
  fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ sizeBaseline: 2, followCodex: false, sound: false }));
  const child = spawn(packed.executable, ['--demo', `--maid-home=${home}`], { cwd: directory, stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, CODEX_MAID_HOME: home } });
  let launchError, errors = '', exited = false;
  child.on('error', error => { launchError = error; }); child.once('exit', () => { exited = true; });
  child.stderr.on('data', data => { errors += data; });
  try {
    let target; const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      if (launchError) throw launchError;
      if (exited) throw new Error('Packaged app exited before startup: ' + errors);
      try { target = JSON.parse(fs.readFileSync(path.join(home, 'control.json'), 'utf8')); break; } catch {}
      await sleep(100);
    }
    assert.ok(target?.port && target.token, 'Packaged app did not start within 20 seconds: ' + errors);
    const url = `http://127.0.0.1:${target.port}`;
    const headers = { Authorization: 'Bearer ' + target.token, 'Content-Type': 'application/json' };
    assert.equal((await fetch(url + '/status')).status, 403);
    let status;
    while (Date.now() < deadline) {
      status = await (await fetch(url + '/status', { headers })).json();
      if (status.status === 'demo') break;
      await sleep(100);
    }
    assert.equal(status.status, 'demo'); assert.equal(status.version, packed.version);
    assert.equal(status.followCodex, false); assert.equal(status.characterCount, 2);
    for (const action of ['hide', 'show', 'bounce', 'refresh']) assert.equal((await fetch(url + '/action', { method: 'POST', headers, body: JSON.stringify({ action }) })).status, 200);
    assert.equal(fs.existsSync(path.join(home, 'watcher.json')), false, 'Verification must not start a login helper');
    await checkBundledMcp(packed, home);
    console.log('PASS: real packaged macOS app startup, demo, gallery metadata, authenticated controls, isolated profile and MCP using only the installed Electron runtime.');
  } finally {
    if (!exited) child.kill(); const deadline = Date.now() + 5000;
    while (!exited && Date.now() < deadline) await sleep(50);
    if (!exited) child.kill('SIGKILL');
  }
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
