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
function runtimeFor(platform) {
  const source = path.join(projectRoot,...(platform === 'darwin' ? ['macos'] : []),'src');
  return {...require(path.join(source,'codex-data.cjs')),...require(path.join(source,'codex-cli.cjs'))};
}

function fixture(t, platform = 'win32') {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'maid-installer-integration-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const destination = path.join(temporary, 'installed resources', 'integration');
  stageIntegration({ root: projectRoot, platform, destination });
  return { temporary, destination, homeDir: path.join(temporary, 'profile'), executable: process.execPath, env: {}, runtime:runtimeFor(platform) };
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

test('connection uses supported sequential CLI operations and never forwards Electron Node mode to Codex', async t => {
  const f = fixture(t);
  const fakeCli = path.join(f.temporary, 'codex.exe'); fs.writeFileSync(fakeCli, 'fixture');
  const calls = [];
  const run = (executable, args, options) => {
    if (executable === 'where.exe') return { status: 1, stdout: '' };
    calls.push({ executable, args, options });
    return { status: 0, stdout: '{}' };
  };
  const result = await connect({ payloadRoot: f.destination, executable: f.executable, homeDir: f.homeDir, runtime:f.runtime,
    env: { CODEX_CLI: fakeCli, ELECTRON_RUN_AS_NODE: '1', CODEX_HOME: path.join(f.temporary, 'isolated-codex') }, run });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].args, ['plugin', 'marketplace', 'add', result.integrationRoot, '--json']);
  assert.deepEqual(calls[1].args, ['plugin', 'add', 'codex-maid-widget@' + MARKETPLACE, '--json']);
  assert.equal(calls[0].options.env.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(calls[0].options.env.CODEX_HOME, path.join(f.temporary, 'isolated-codex'));
});

test('failed marketplace registration prevents a subsequent plugin install and failures disclose no CLI output', async t => {
  const f = fixture(t);
  const fakeCli = path.join(f.temporary, 'codex.exe'); fs.writeFileSync(fakeCli, 'fixture');
  let mutations = 0;
  await assert.rejects(connect({ payloadRoot: f.destination, executable: f.executable, homeDir: f.homeDir, codexCli: fakeCli, env: {},runtime:f.runtime,
    run: (executable) => executable === 'where.exe' ? { status: 1, stdout: '' } : (++mutations, { status: 2, stderr: 'do-not-publish-secret' }) }),
  error => !error.message.includes('do-not-publish-secret') && error.message.includes('退出码 2'));
  assert.equal(mutations, 1);
});

test('explicit disconnection removes only this installed plugin via the CLI and preserves all user files', async t => {
  for (const platform of ['win32', 'darwin']) {
    const f = fixture(t, platform);
    const fakeCli = path.join(f.temporary, 'codex.exe'); fs.writeFileSync(fakeCli, 'fixture',{mode:0o700});
    const profile = path.join(f.temporary, 'isolated-codex'); fs.mkdirSync(profile);
    const config = path.join(profile, 'config.toml');
    fs.writeFileSync(config, '[plugins."unrelated@other-marketplace"]\nenabled = true\n');
    const customHome = path.join(f.temporary, 'widget-data'); fs.mkdirSync(customHome);
    fs.writeFileSync(path.join(customHome, 'settings.json'), '{"character":"keep-me"}');
    fs.writeFileSync(path.join(customHome, 'portrait.png'), 'user-artwork');
    const calls = [];
    const result = await disconnect({ payloadRoot: f.destination, homeDir: f.homeDir,runtime:f.runtime,
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

test('disconnection failures disclose neither CLI diagnostics nor private paths and perform no additional operations', async t => {
  const f = fixture(t);
  const fakeCli = path.join(f.temporary, 'codex.exe'); fs.writeFileSync(fakeCli, 'fixture');
  for (const result of [
    { status: 2, stderr: 'do-not-publish-secret /private/account/config.toml', stdout: 'private' },
    { status: null, error: { code: 'ETIMEDOUT', message: '/private/account/config.toml' } }
  ]) {
    let calls = 0;
    await assert.rejects(disconnect({ payloadRoot: f.destination, homeDir: f.homeDir, codexCli: fakeCli, env: {},runtime:f.runtime,
      run: () => { calls++; return result; } }),
    error => !error.message.includes('do-not-publish-secret') && !error.message.includes('/private/') && error.message.includes('未能断开'));
    assert.equal(calls, 1);
    assert.equal(fs.existsSync(f.homeDir), false);
  }
});

test('a successful official removal is accepted even if the plugin was already absent', async t => {
  const f = fixture(t);
  const fakeCli = path.join(f.temporary, 'codex.exe'); fs.writeFileSync(fakeCli, 'fixture');
  // The official CLI returns 0 with this metadata shape for an empty profile.
  const run = () => ({ status: 0, stdout: JSON.stringify({ pluginId: 'codex-maid-widget@codex-maid-installed', name: 'codex-maid-widget', marketplaceName: MARKETPLACE }) });
  for (let count = 0; count < 2; count++) {
    assert.equal((await disconnect({ payloadRoot: f.destination, homeDir: f.homeDir, codexCli: fakeCli, env: {}, run,runtime:f.runtime })).ok, true);
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

test('prepare-only and default command never invoke Codex or modify Codex settings', async t => {
  const f = fixture(t, 'darwin');
  const result = await connect({ payloadRoot: f.destination, executable: f.executable, homeDir: f.homeDir, env: {}, prepareOnly: true,
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

test('macOS discovers renamed Codex only through the shared runtime bundle identity resolver', async () => {
  const cli = '/Applications/ChatGPT.app/Contents/Resources/codex';
  const main = '/Applications/ChatGPT.app/Contents/MacOS/ChatGPT';
  const fileSystem = {statSync(file) {if (![cli,main].includes(file)) throw Error('absent');return {isFile:()=>true};},accessSync() {}};
  const readBundle = bundle => bundle === '/Applications/ChatGPT.app' ? {identifier:'com.openai.codex',executable:'ChatGPT'} : null;
  const options={platform:'darwin',homeDir:'/Users/test',env:{},fileSystem,runtime:runtimeFor('darwin'),queryDesktop:async()=>({known:false,roots:[]})};
  assert.equal(await locateCodex({...options,readBundle}),cli);
  await assert.rejects(locateCodex({...options,readBundle:()=>({identifier:'com.openai.chat',executable:'ChatGPT'})}),{code:'CODEX_CLI_MISSING'});
  await assert.rejects(locateCodex({...options,readBundle:()=>({identifier:'com.openai.codex',executable:'../ChatGPT'})}),{code:'CODEX_CLI_MISSING'});
});

test('explicit and environment CLI paths work when Codex is outside PATH', async t => {
  const f = fixture(t, 'darwin');
  const fakeCli = path.join(f.temporary, 'custom codex'); fs.writeFileSync(fakeCli, 'fixture',{mode:0o700});
  const run = () => ({ status: 1, stdout: '' });
  assert.equal(await locateCodex({platform:'darwin',explicit:fakeCli,homeDir:f.homeDir,env:{},run,runtime:f.runtime}),fakeCli);
  assert.equal(await locateCodex({platform:'win32',homeDir:f.homeDir,env:{CODEX_CLI:fakeCli},run,runtime:runtimeFor('win32')}),fakeCli);
});

test('connector loads the installed read-only runtime beside its payload instead of carrying another discovery policy', async t => {
  const f=fixture(t);
  const fakeCli=path.join(f.temporary,'CLI with 中文.exe');fs.writeFileSync(fakeCli,'fixture');
  const source=path.join(f.destination,'..','app.asar','src');fs.mkdirSync(source,{recursive:true});
  fs.writeFileSync(path.join(source,'codex-data.cjs'),`module.exports.findCodexExecutable = (value, options) => {if(options.env.FIXTURE !== 'isolated') throw Error('wrong env');return value;};`);
  fs.writeFileSync(path.join(source,'codex-cli.cjs'),`module.exports.resolveCodexExecutable = async (value, options) => options.find(value);`);
  assert.equal(await locateCodex({payloadRoot:f.destination,platform:'win32',homeDir:f.homeDir,env:{FIXTURE:'isolated'},explicit:fakeCli}),fakeCli);
});

test('connector finds trusted running desktops across Windows volumes and moved Mac bundles with minimal PATH', async () => {
  const vectors=[
    {platform:'win32',homeDir:'E:\\用户 空间',main:'Z:\\应用卷\\Codex\\app\\ChatGPT.exe',cli:'Z:\\应用卷\\Codex\\app\\resources\\codex.exe',root:{officialDesktop:true}},
    {platform:'darwin',homeDir:'/Users/用户 空间',main:'/Volumes/外接 SSD/开发工具/Codex 新版.app/Contents/MacOS/ChatGPT',cli:'/Volumes/外接 SSD/开发工具/Codex 新版.app/Contents/Resources/codex',root:{uid:501,bundleId:'com.openai.codex',bundleExecutable:'ChatGPT'}},
  ];
  for(const {platform,homeDir,main,cli,root} of vectors){
    const options={platform,homeDir,env:{PATH:'',CODEX_HOME:homeDir+'/isolated-profile'},runtime:runtimeFor(platform),readBundle:()=>null,
      fileSystem:{statSync(file){if(file!==cli)throw Error('absent');return {isFile:()=>true};},accessSync(file){assert.equal(file,cli);}},
      queryDesktop:async()=>({known:true,roots:[{...root,path:main}]})};
    assert.equal(await locateCodex(options),cli);
    await assert.rejects(locateCodex({...options,queryDesktop:async()=>({known:false,roots:[{...root,path:main}]})}),{code:'CODEX_CLI_MISSING'});
    await assert.rejects(locateCodex({...options,queryDesktop:async()=>({known:true,roots:[{...root,path:main,officialDesktop:false,bundleId:'com.openai.chat'}]})}),{code:'CODEX_CLI_MISSING'});
  }
});

test('connector uses the shared safe Windows shim invocation and retains custom profile paths', async t => {
  const f=fixture(t),cli=path.join(f.temporary,'工具 空格 & dev','codex.cmd');
  fs.mkdirSync(path.dirname(cli),{recursive:true});fs.writeFileSync(cli,'fixture');
  const profile=path.join(f.temporary,'隔离 Codex profile'),dataHome=path.join(f.temporary,'用户 & widget');
  const calls=[];
  const result=await connect({payloadRoot:f.destination,executable:f.executable,homeDir:f.homeDir,codexCli:cli,runtime:f.runtime,
    env:{CODEX_HOME:profile,CODEX_MAID_HOME:dataHome,ComSpec:'C:\\Windows\\System32\\cmd.exe',ELECTRON_RUN_AS_NODE:'1'},
    run(file,args,options){calls.push({file,args,options});return {status:0,stdout:'{}'};}});
  assert.equal(result.ok,true);assert.equal(calls.length,2);
  for(const call of calls){assert.equal(call.file,'C:\\Windows\\System32\\cmd.exe');assert.deepEqual(call.args.slice(0,3),['/d','/s','/c']);
    assert.equal(call.options.windowsVerbatimArguments,true);assert.equal(call.options.env.CODEX_HOME,profile);assert.equal(call.options.env.ELECTRON_RUN_AS_NODE,undefined);
    assert.equal(Object.hasOwn(call.options,'shell'),false);assert.ok(call.args[3].includes('"'+cli+'"'));}
  assert.equal(fs.existsSync(profile),false,'only official fixture CLI owns its profile');
});

test('disconnect discovery rejects unavailable and nonexecutable CLIs without preparing any files or invoking mutations', async t => {
  for(const platform of ['win32','darwin']){
    const f=fixture(t,platform);let calls=0;
    const options={payloadRoot:f.destination,homeDir:f.homeDir,env:{},runtime:f.runtime,readBundle:()=>null,
      fileSystem:{statSync(){throw Error('isolated missing');},accessSync(){throw Error('isolated denied');}},
      queryDesktop:async()=>({known:false,roots:[]}),run(){calls++;return {status:0};}};
    await assert.rejects(disconnect(options),{code:'CODEX_CLI_MISSING'});
    assert.equal(calls,0);assert.equal(fs.existsSync(f.homeDir),false);
    await assert.rejects(locateCodex({...options,platform,explicit:'bad\npath'}),{code:'CODEX_CLI_MISSING'});
  }
});

test('installed Windows Electron can handshake with the external MCP server without system Node', { skip: process.platform !== 'win32' }, async t => {
  const executable = path.join(projectRoot, 'release/Codex-Maid-Widget-win32-x64/Codex-Maid-Widget.exe');
  if (!fs.existsSync(executable)) { t.skip('Original portable Electron runtime is not available.'); return; }
  const f = fixture(t);
  const prepared = preparePlugin({ payloadRoot: f.destination, executable, homeDir: f.homeDir, env: {} });
  const maid = JSON.parse(fs.readFileSync(path.join(prepared.plugin, '.mcp.json'))).mcpServers.maid;
  const child = spawn(maid.command, maid.args, { env: { ...process.env, ...maid.env, CODEX_HOME:path.join(f.temporary,'isolated-codex'),HOME:f.homeDir,USERPROFILE:f.homeDir, PATH: '' }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
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
