'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, spawn } = require('node:child_process');
const readline = require('node:readline');
const { stageIntegration } = require('../prepare-payload.cjs');
const { preparePlugin, connect, locateCodex, MARKETPLACE } = require('../connect.cjs');
const projectRoot = path.resolve(__dirname, '../../..');

function fixture(t, platform = 'win32') {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'maid-installer-integration-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const destination = path.join(temporary, 'installed resources', 'integration');
  stageIntegration({ root: projectRoot, platform, destination });
  return { temporary, destination, homeDir: path.join(temporary, 'profile'), executable: process.execPath, env: {} };
}

test('installer stages platform plugin only, with no dependency on external Node or source', t => {
  for (const platform of ['win32', 'darwin']) {
    const f = fixture(t, platform);
    const portable = JSON.parse(fs.readFileSync(path.join(f.destination, 'plugins/codex-maid-widget/.mcp.json'))).mcpServers.maid;
    assert.match(portable.command, /^\$\{PLUGIN_ROOT\}\//);
    assert.deepEqual(portable.args, ['${PLUGIN_ROOT}/mcp.cjs']);
    assert.equal(portable.env.ELECTRON_RUN_AS_NODE, '1');
    const original = path.join(projectRoot, ...(platform === 'darwin' ? ['macos'] : []), 'plugins/codex-maid-widget/mcp.cjs');
    assert.deepEqual(fs.readFileSync(path.join(f.destination, 'plugins/codex-maid-widget/mcp.cjs')), fs.readFileSync(original));
    assert.equal(fs.existsSync(path.join(f.destination, 'node_modules')), false);
    assert.equal(fs.readFileSync(path.join(f.destination, 'connect.ps1'))[0], 0xef);
  }
});

test('preparation writes only the mutable profile and binds the installed Electron plus private data directory', t => {
  const f = fixture(t);
  const before = fs.readFileSync(path.join(f.destination, 'plugins/codex-maid-widget/.mcp.json'));
  const customHome = path.join(f.temporary, 'private profile');
  const prepared = preparePlugin({ payloadRoot: f.destination, executable: f.executable, homeDir: f.homeDir, env: { CODEX_MAID_HOME: customHome } });
  const maid = JSON.parse(fs.readFileSync(path.join(prepared.plugin, '.mcp.json'))).mcpServers.maid;
  assert.equal(maid.command, process.execPath);
  assert.deepEqual(maid.args, [path.join(prepared.plugin, 'mcp.cjs')]);
  assert.deepEqual(maid.env, { ELECTRON_RUN_AS_NODE: '1', CODEX_MAID_HOME: customHome });
  assert.equal(fs.existsSync(path.join(f.homeDir, '.codex', 'config.toml')), false);
  assert.deepEqual(fs.readFileSync(path.join(f.destination, 'plugins/codex-maid-widget/.mcp.json')), before);
  const marketplace = JSON.parse(fs.readFileSync(path.join(prepared.integrationRoot, '.agents/plugins/marketplace.json')));
  assert.equal(marketplace.name, MARKETPLACE);
  assert.equal(marketplace.plugins[0].source.path, './plugins/codex-maid-widget');
});

test('connection uses supported sequential CLI operations and never forwards Electron Node mode to Codex', t => {
  const f = fixture(t);
  const fakeCli = path.join(f.temporary, 'codex.exe'); fs.writeFileSync(fakeCli, 'fixture');
  const calls = [];
  const run = (executable, args, options) => {
    if (executable === 'where.exe') return { status: 1, stdout: '' };
    calls.push({ executable, args, options });
    return { status: 0, stdout: '{}' };
  };
  const result = connect({ payloadRoot: f.destination, executable: f.executable, homeDir: f.homeDir,
    env: { CODEX_CLI: fakeCli, ELECTRON_RUN_AS_NODE: '1', CODEX_HOME: path.join(f.temporary, 'isolated-codex') }, run });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].args, ['plugin', 'marketplace', 'add', result.integrationRoot, '--json']);
  assert.deepEqual(calls[1].args, ['plugin', 'add', 'codex-maid-widget@' + MARKETPLACE, '--json']);
  assert.equal(calls[0].options.env.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(calls[0].options.env.CODEX_HOME, path.join(f.temporary, 'isolated-codex'));
});

test('failed marketplace registration prevents a subsequent plugin install and failures disclose no CLI output', t => {
  const f = fixture(t);
  const fakeCli = path.join(f.temporary, 'codex.exe'); fs.writeFileSync(fakeCli, 'fixture');
  let mutations = 0;
  assert.throws(() => connect({ payloadRoot: f.destination, executable: f.executable, homeDir: f.homeDir, codexCli: fakeCli, env: {},
    run: (executable) => executable === 'where.exe' ? { status: 1, stdout: '' } : (++mutations, { status: 2, stderr: 'do-not-publish-secret' }) }),
  error => !error.message.includes('do-not-publish-secret') && error.message.includes('退出码 2'));
  assert.equal(mutations, 1);
});

test('prepare-only and default command never invoke Codex or modify Codex settings', t => {
  const f = fixture(t, 'darwin');
  const result = connect({ payloadRoot: f.destination, executable: f.executable, homeDir: f.homeDir, env: {}, prepareOnly: true,
    run: () => { throw new Error('must not invoke any process'); } });
  assert.equal(result.ok, true);
  const readonly = spawnSync(process.execPath, [path.join(f.destination, 'connect.cjs')], { encoding: 'utf8', env: { ...process.env, CODEX_HOME: path.join(f.temporary, 'no-config') } });
  assert.equal(readonly.status, 0);
  assert.equal(JSON.parse(readonly.stdout).ok, true);
  assert.equal(fs.existsSync(path.join(f.temporary, 'no-config')), false);
  const help = spawnSync(process.execPath, [path.join(f.destination, 'connect.cjs'), '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.equal(JSON.parse(help.stdout).ok, true);
});

test('macOS discovers renamed Codex only through its actual bundle identity and declared executable', () => {
  const cli = '/Applications/ChatGPT.app/Contents/Resources/codex';
  const main = '/Applications/ChatGPT.app/Contents/MacOS/ChatGPT';
  const fileSystem = { statSync(file) { if (![cli, main].includes(file)) throw new Error('absent'); return { isFile: () => true }; } };
  const run = () => ({ status: 1, stdout: '' });
  const readBundle = bundle => bundle === '/Applications/ChatGPT.app' ? { CFBundleIdentifier: 'com.openai.codex', CFBundleExecutable: 'ChatGPT' } : null;
  const found = locateCodex({ platform: 'darwin', homeDir: '/Users/test', env: {}, run, fileSystem, readBundle });
  assert.equal(found, path.resolve(cli));
  assert.throws(() => locateCodex({ platform: 'darwin', homeDir: '/Users/test', env: {}, run, fileSystem,
    readBundle: () => ({ CFBundleIdentifier: 'com.openai.chat', CFBundleExecutable: 'ChatGPT' }) }), { code: 'CODEX_CLI_MISSING' });
  assert.throws(() => locateCodex({ platform: 'darwin', homeDir: '/Users/test', env: {}, run, fileSystem,
    readBundle: () => ({ CFBundleIdentifier: 'com.openai.codex', CFBundleExecutable: '../ChatGPT' }) }), { code: 'CODEX_CLI_MISSING' });
});

test('explicit and environment CLI paths work when Codex is outside PATH', t => {
  const f = fixture(t, 'darwin');
  const fakeCli = path.join(f.temporary, 'custom codex'); fs.writeFileSync(fakeCli, 'fixture');
  const run = () => ({ status: 1, stdout: '' });
  assert.equal(locateCodex({ platform: 'darwin', explicit: fakeCli, homeDir: f.homeDir, env: {}, run }), fakeCli);
  assert.equal(locateCodex({ platform: 'win32', homeDir: f.homeDir, env: { CODEX_CLI: fakeCli }, run }), fakeCli);
});

test('installed Windows Electron can handshake with the external MCP server without system Node', { skip: process.platform !== 'win32' }, async t => {
  const executable = path.join(projectRoot, 'release/Codex-Maid-Widget-win32-x64/Codex-Maid-Widget.exe');
  if (!fs.existsSync(executable)) { t.skip('Original portable Electron runtime is not available.'); return; }
  const f = fixture(t);
  const prepared = preparePlugin({ payloadRoot: f.destination, executable, homeDir: f.homeDir, env: {} });
  const maid = JSON.parse(fs.readFileSync(path.join(prepared.plugin, '.mcp.json'))).mcpServers.maid;
  const child = spawn(maid.command, maid.args, { env: { ...process.env, ...maid.env, PATH: '' }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => child.kill());
  const response = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Bundled MCP handshake timed out')), 8000);
    const lines = readline.createInterface({ input: child.stdout });
    lines.on('line', line => { clearTimeout(timer); resolve(JSON.parse(line)); });
    child.on('error', error => { clearTimeout(timer); reject(error); });
  });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }) + '\n');
  const message = await response;
  assert.equal(message.result.serverInfo.name, 'codex-maid-widget');
  assert.equal(message.id, 1);
  child.stdin.end();
});
