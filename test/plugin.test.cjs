'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { spawn } = require('node:child_process');
const readline = require('node:readline');
const { dispatch, TOOLS, safeValue } = require('../plugins/codex-maid-widget/mcp.cjs');
const serverFile = path.resolve(__dirname, '../plugins/codex-maid-widget/mcp.cjs');
const { CharacterLibrary } = require('../src/character-library.cjs');

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

test('MCP hides imported filenames while the local character library keeps its names', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'maid-mcp-names-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const assetRoot = path.join(root, 'assets');
  fs.mkdirSync(assetRoot);
  const filename = 'synthetic-client-private-draft';
  const source = path.join(root, filename + '.gif');
  fs.writeFileSync(source, Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'));
  const options = { dataDir: path.join(root, 'profile'), assetRoot };
  const library = new CharacterLibrary(options);
  const imported = library.importFiles([source]).imported[0];
  assert.equal(imported.name, filename);
  const localStatus = { characterName: imported.name, activeCharacterId: imported.id, characterCount: 3 };
  const result = safeValue(localStatus);
  assert.deepEqual(result, { characterName: '自定义形象', activeCharacterId: imported.id, characterCount: 3 });
  assert.equal(JSON.stringify(result).includes(filename), false);
  assert.equal(localStatus.characterName, filename);
  assert.equal(new CharacterLibrary(options).get(imported.id).name, filename);

  for (const [id, expected] of [['mint-maid', '薄荷女仆'], ['lilac-dragon', '紫晶龙女仆'], ['frost-glass-idle', '小龙娘-端庄'], ['frost-glass-cheek', '小龙娘-托腮']]) {
    library.rename(id, 'synthetic-private-label');
    assert.equal(library.get(id).name, 'synthetic-private-label');
    assert.deepEqual(safeValue({ activeCharacterId: id, characterName: library.get(id).name }), { activeCharacterId: id, characterName: expected });
  }
  assert.deepEqual(safeValue({ nested: [{ characterName: filename }] }), { nested: [{ characterName: '自定义形象' }] });
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
      res.end(JSON.stringify(req.url === '/status' ? { running: true, quota: { remainingPercent: 72 }, token: 'must-not-escape', activeCharacterId: 'custom-test', characterName: 'synthetic-private-file-name' } : { ok: true, action: JSON.parse(body).action, activeCharacterId: 'mint-maid', characterName: 'synthetic-private-label' }));
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
  assert.deepEqual(JSON.parse(status.result.content[0].text), { running: true, quota: { remainingPercent: 72 }, activeCharacterId: 'custom-test', characterName: '自定义形象' });
  const action = await call('tools/call', { name: 'control_widget', arguments: { action: 'show' } });
  assert.deepEqual(JSON.parse(action.result.content[0].text), { ok: true, action: 'show', activeCharacterId: 'mint-maid', characterName: '薄荷女仆' });
  assert.deepEqual(requests, [
    { method: 'GET', url: '/status', auth: `Bearer ${token}`, body: '' },
    { method: 'POST', url: '/action', auth: `Bearer ${token}`, body: '{"action":"show"}' }
  ]);
  fs.unlinkSync(path.join(home, 'control.json'));
  const stopped = await call('tools/call', { name: 'get_widget_status' });
  assert.equal(stopped.result.isError, true);
  assert.match(stopped.result.content[0].text, /start\.cmd/);
});
