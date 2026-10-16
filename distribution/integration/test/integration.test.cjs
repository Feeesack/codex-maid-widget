'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, spawn } = require('node:child_process');
const readline = require('node:readline');
const { stageIntegration } = require('../prepare-payload.cjs');
const { preparePlugin, connect, disconnect, locateCodex, MARKETPLACE } = require('../connect.cjs');
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

test('explicit disconnection removes only this installed plugin via the CLI and preserves all user files', t => {
  for (const platform of ['win32', 'darwin']) {
    const f = fixture(t, platform);
    const fakeCli = path.join(f.temporary, 'codex.exe'); fs.writeFileSync(fakeCli, 'fixture');
    const profile = path.join(f.temporary, 'isolated-codex'); fs.mkdirSync(profile);
    const config = path.join(profile, 'config.toml');
    fs.writeFileSync(config, '[plugins."unrelated@other-marketplace"]\nenabled = true\n');
    const customHome = path.join(f.temporary, 'widget-data'); fs.mkdirSync(customHome);
    fs.writeFileSync(path.join(customHome, 'settings.json'), '{"character":"keep-me"}');
    fs.writeFileSync(path.join(customHome, 'portrait.png'), 'user-artwork');
    const calls = [];
    const result = disconnect({ payloadRoot: f.destination, homeDir: f.homeDir,
      env: { CODEX_CLI: fakeCli, ELECTRON_RUN_AS_NODE: '1', CODEX_HOME: profile, CODEX_MAID_HOME: customHome },
      run: (executable, args, options) => { calls.push({ executable, args, options }); return { status: 0, stdout: '{}' }; } });
    assert.equal(result.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].executable, fakeCli);
    assert.deepEqual(calls[0].args, ['plugin', 'remove', 'codex-maid-widget@codex-maid-installed', '--json']);
    assert.equal(calls[0].options.env.ELECTRON_RUN_AS_NODE, undefined);
    assert.equal(calls[0].options.env.CODEX_HOME, profile);
    assert.equal(fs.readFileSync(config, 'utf8'), '[plugins."unrelated@other-marketplace"]\nenabled = true\n');
    assert.equal(fs.readFileSync(path.join(customHome, 'settings.json'), 'utf8'), '{"character":"keep-me"}');
    assert.equal(fs.readFileSync(path.join(customHome, 'portrait.png'), 'utf8'), 'user-artwork');
    assert.equal(fs.existsSync(path.join(customHome, 'integration')), false, 'removal must not install or prepare the plugin');
    assert.equal(fs.existsSync(f.homeDir), false, 'removal must not create a default profile');
  }
});

test('disconnection failures disclose neither CLI diagnostics nor private paths and perform no additional operations', t => {
  const f = fixture(t);
  const fakeCli = path.join(f.temporary, 'codex.exe'); fs.writeFileSync(fakeCli, 'fixture');
  for (const result of [
    { status: 2, stderr: 'do-not-publish-secret /private/account/config.toml', stdout: 'private' },
    { status: null, error: { code: 'ETIMEDOUT', message: '/private/account/config.toml' } }
  ]) {
    let calls = 0;
    assert.throws(() => disconnect({ payloadRoot: f.destination, homeDir: f.homeDir, codexCli: fakeCli, env: {},
      run: () => { calls++; return result; } }),
    error => !error.message.includes('do-not-publish-secret') && !error.message.includes('/private/') && error.message.includes('未能断开'));
    assert.equal(calls, 1);
    assert.equal(fs.existsSync(f.homeDir), false);
  }
});

test('a successful official removal is accepted even if the plugin was already absent', t => {
  const f = fixture(t);
  const fakeCli = path.join(f.temporary, 'codex.exe'); fs.writeFileSync(fakeCli, 'fixture');
  // The official CLI returns 0 with this metadata shape for an empty profile.
  const run = () => ({ status: 0, stdout: JSON.stringify({ pluginId: 'codex-maid-widget@codex-maid-installed', name: 'codex-maid-widget', marketplaceName: MARKETPLACE }) });
  for (let count = 0; count < 2; count++) {
    assert.equal(disconnect({ payloadRoot: f.destination, homeDir: f.homeDir, codexCli: fakeCli, env: {}, run }).ok, true);
    assert.equal(fs.existsSync(f.homeDir), false);
  }
});

test('conflicting connection/removal options fail before any side effects, and raw filesystem failures stay private', t => {
  const f = fixture(t);
  const env = { ...process.env, CODEX_HOME: path.join(f.temporary, 'no-config'), CODEX_MAID_HOME: path.join(f.temporary, 'no-data') };
  for (const args of [['--install', '--remove'], ['--prepare-only', '--uninstall']]) {
    const result = spawnSync(process.execPath, [path.join(f.destination, 'connect.cjs'), ...args], { encoding: 'utf8', cwd: f.temporary, env });
    assert.equal(result.status, 1);
    assert.match(JSON.parse(result.stdout).message, /不能同时使用/);
    assert.equal(fs.existsSync(env.CODEX_HOME), false);
    assert.equal(fs.existsSync(env.CODEX_MAID_HOME), false);
  }
  fs.rmSync(path.join(f.destination, 'runtime.json'));
  for (const option of ['--remove', '--uninstall']) {
    const result = spawnSync(process.execPath, [path.join(f.destination, 'connect.cjs'), option], { encoding: 'utf8', cwd: f.temporary, env });
    assert.equal(result.status, 1);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, false);
    assert.ok(!output.message.includes(f.temporary));
    assert.ok(!output.message.includes('runtime.json'));
    assert.equal(fs.existsSync(env.CODEX_HOME), false);
  }
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
