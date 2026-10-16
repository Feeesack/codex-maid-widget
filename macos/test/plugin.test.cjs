'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { spawn } = require('node:child_process');
const readline = require('node:readline');
const { dispatch, TOOLS, safeValue, dataHome } = require('../plugins/codex-maid-widget/mcp.cjs');
const serverFile = path.resolve(__dirname, '../plugins/codex-maid-widget/mcp.cjs');

test('macOS MCP shares the desktop data home even before the first app launch', () => {
  assert.equal(dataHome({}, 'darwin'), path.join(os.homedir(), '.codex-maid-widget'));
  assert.equal(dataHome({ CODEX_MAID_HOME: '/chosen/profile' }, 'darwin'), '/chosen/profile');
});

test('MCP advertises read-only status and bounded controls without quit', async () => {
  const response = await dispatch({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  assert.equal(response.result.protocolVersion, '2025-06-18');
  assert.equal(TOOLS.find(tool => tool.name === 'get_widget_status').annotations.readOnlyHint, true);
  const actions = TOOLS.find(tool => tool.name === 'control_widget').inputSchema.properties.action.enum;
  assert.deepEqual(actions, ['show', 'hide', 'refresh', 'bounce', 'settings']);
  const rejected = await dispatch({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'control_widget', arguments: { action: 'quit' } } });
  assert.equal(rejected.error.code, -32602);
  assert.equal(await dispatch({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  assert.equal((await dispatch({ jsonrpc: '2.0', id: 3, method: 'unknown' })).error.code, -32601);
});

test('status output removes local credentials defensively', () => {
  assert.deepEqual(safeValue({ token: 'local-secret', quota: { remainingPercent: 80, api_key: 'hidden' } }), { quota: { remainingPercent: 80 } });
});

test('stdio MCP authenticates loopback requests and reports a stopped desktop', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'maid-mcp-test-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const requests = [];
  const httpServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(req.url === '/status' ? { running: true, quota: { remainingPercent: 72 }, token: 'must-not-escape' } : { ok: true, action: JSON.parse(body).action }));
    });
  });
  await new Promise(resolve => httpServer.listen(0, '127.0.0.1', resolve));
  t.after(() => { httpServer.closeAllConnections(); httpServer.close(); });
  const token = 'test-control-token-123456';
  fs.writeFileSync(path.join(home, 'control.json'), JSON.stringify({ port: httpServer.address().port, token, pid: process.pid }));
  const child = spawn(process.execPath, [serverFile], { env: { ...process.env, CODEX_MAID_HOME: home }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  t.after(() => child.kill());
  let nextId = 0;
  const pending = new Map();
  const lines = readline.createInterface({ input: child.stdout });
  lines.on('line', line => {
    const message = JSON.parse(line);
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  });
  const call = (method, params) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('MCP test timed out')); }, 3000);
    pending.set(id, value => { clearTimeout(timer); resolve(value); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const handshake = await call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.equal(handshake.result.serverInfo.name, 'codex-maid-widget');
  assert.equal(handshake.result.serverInfo.version, require('../package.json').version);
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const listed = await call('tools/list');
  assert.equal(listed.result.tools.length, 2);
  const status = await call('tools/call', { name: 'get_widget_status', arguments: {} });
  assert.deepEqual(JSON.parse(status.result.content[0].text), { running: true, quota: { remainingPercent: 72 } });
  const action = await call('tools/call', { name: 'control_widget', arguments: { action: 'show' } });
  assert.deepEqual(JSON.parse(action.result.content[0].text), { ok: true, action: 'show' });
  assert.deepEqual(requests, [
    { method: 'GET', url: '/status', auth: `Bearer ${token}`, body: '' },
    { method: 'POST', url: '/action', auth: `Bearer ${token}`, body: '{"action":"show"}' }
  ]);
  fs.unlinkSync(path.join(home, 'control.json'));
  const stopped = await call('tools/call', { name: 'get_widget_status' });
  assert.equal(stopped.result.isError, true);
  assert.match(stopped.result.content[0].text, /start\.cmd/);
});
