'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { parseArgs } = require('node:util');
const MARKETPLACE = 'codex-maid-installed';
const PLUGIN = 'codex-maid-widget';

function publicError(message, code) {
  const error = new Error(message);
  error.publicMessage = message;
  if (code) error.code = code;
  return error;
}

function preparePlugin({ payloadRoot = __dirname, executable = process.execPath, homeDir = os.homedir(), env = process.env } = {}) {
  payloadRoot = path.resolve(payloadRoot); executable = path.resolve(executable);
  const runtime = JSON.parse(fs.readFileSync(path.join(payloadRoot, 'runtime.json'), 'utf8'));
  if (!['win32', 'darwin'].includes(runtime.platform)) throw new Error('安装包的系统信息无效，请重新安装挂件。');
  if (!fs.statSync(executable).isFile()) throw new Error('未找到安装包附带的运行程序，请重新安装挂件。');
  const dataHome = path.resolve(env.CODEX_MAID_HOME || path.join(homeDir, '.codex-maid-widget'));
  const integrationRoot = path.join(dataHome, 'integration', runtime.platform);
  const plugin = path.join(integrationRoot, 'plugins', PLUGIN);
  fs.mkdirSync(path.join(plugin, '.codex-plugin'), { recursive: true });
  // Never write inside a signed .app or Program Files. These original files
  // remain external to ASAR and are copied to a durable per-user marketplace.
  for (const file of ['mcp.cjs', '.codex-plugin/plugin.json']) {
    fs.copyFileSync(path.join(payloadRoot, 'plugins', PLUGIN, file), path.join(plugin, file));
  }
  const maid = { command: executable, args: [path.join(plugin, 'mcp.cjs')],
    env: { ELECTRON_RUN_AS_NODE: '1', CODEX_MAID_HOME: dataHome } };
  fs.writeFileSync(path.join(plugin, '.mcp.json'), JSON.stringify({ mcpServers: { maid } }, null, 2) + '\n');
  const marketplaceDir = path.join(integrationRoot, '.agents', 'plugins');
  fs.mkdirSync(marketplaceDir, { recursive: true });
  fs.writeFileSync(path.join(marketplaceDir, 'marketplace.json'), JSON.stringify({
    name: MARKETPLACE, interface: { displayName: 'Codex 女仆挂件 · 安装版' },
    plugins: [{ name: PLUGIN, source: { source: 'local', path: './plugins/' + PLUGIN },
      policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' }, category: 'Productivity' }]
  }, null, 2) + '\n');
  return { integrationRoot, plugin, dataHome, platform: runtime.platform };
}

function runtimeModules(payloadRoot) {
  // Connectors ship beside app.asar and run with its Electron runtime. Import
  // only the same read-only resolver used by the widget, never the app entry
  // point or a copied WindowsApps / Applications directory policy.
  const source = path.join(path.resolve(payloadRoot), '..', 'app.asar', 'src');
  return { ...require(path.join(source, 'codex-data.cjs')), ...require(path.join(source, 'codex-cli.cjs')) };
}
async function locateCodex({ payloadRoot = __dirname, platform = process.platform, homeDir = os.homedir(), env = process.env, explicit,
  fileSystem = fs, readBundle, queryDesktop, runtime } = {}) {
  const modules = runtime || runtimeModules(payloadRoot);
  const selected = explicit || env.CODEX_CLI || env.CODEX_MAID_CODEX_PATH;
  const options = {platform,env,homedir:homeDir,fileSystem,...(readBundle ? {readBundle} : {}),...(queryDesktop ? {queryDesktop} : {})};
  try {
    const cli = await modules.resolveCodexExecutable(selected, {...options,find: value => modules.findCodexExecutable(value,options)});
    if (typeof cli !== 'string' || !cli || /[\0\r\n]/.test(cli) || !fileSystem.statSync(cli).isFile()) throw new Error('Unavailable CLI');
    if (platform !== 'win32') fileSystem.accessSync(cli,fs.constants.X_OK);
    return cli;
  } catch {
    throw publicError('未找到可运行的 Codex 命令行程序。请先打开已安装的 Codex 桌面版再重试；自定义位置可通过 CODEX_CLI 或 CODEX_MAID_CODEX_PATH 指定，无需安装 Node.js。', 'CODEX_CLI_MISSING');
  }
}
function runCodex(cli, args, {platform,env,run,runtime}) {
  const invocation = runtime.codexCommandInvocation(cli,args,{platform,env});
  return run(invocation.file,invocation.args,{env,encoding:'utf8',timeout:120000,maxBuffer:2*1024*1024,windowsHide:true,
    ...(invocation.windowsVerbatimArguments ? {windowsVerbatimArguments:true} : {})});
}
async function connect({ payloadRoot = __dirname, executable = process.execPath, homeDir = os.homedir(), env = process.env, codexCli, run = spawnSync, prepareOnly = false,
  runtime, fileSystem = fs, queryDesktop, readBundle } = {}) {
  const prepared = preparePlugin({ payloadRoot, executable, homeDir, env });
  if (prepareOnly) return { ok: true, message: '连接文件已准备，尚未修改 Codex 设置。', integrationRoot: prepared.integrationRoot };
  const modules = runtime || runtimeModules(payloadRoot);
  const cli = await locateCodex({payloadRoot,platform:prepared.platform,homeDir,env,explicit:codexCli,runtime:modules,fileSystem,queryDesktop,readBundle});
  const cliEnv = { ...env }; delete cliEnv.ELECTRON_RUN_AS_NODE;
  const commands = [
    { args: ['plugin', 'marketplace', 'add', prepared.integrationRoot, '--json'], label: '注册本地插件来源' },
    { args: ['plugin', 'add', PLUGIN + '@' + MARKETPLACE, '--json'], label: '安装本地挂件插件' }
  ];
  for (const command of commands) {
    const result = runCodex(cli,command.args,{platform:prepared.platform,env:cliEnv,run,runtime:modules});
    if (result.error || result.status !== 0) {
      throw publicError(command.label + '失败。请更新 Codex 后重新连接；也可在 Codex 的插件目录中安装“Codex 女仆挂件 · 安装版”。' +
        (result.error?.code && /^[A-Z0-9_]+$/.test(result.error.code) ? '（' + result.error.code + '）' : '（退出码 ' + result.status + '）'));
    }
  }
  return { ok: true, marketplace: MARKETPLACE, integrationRoot: prepared.integrationRoot,
    message: 'Codex 女仆挂件插件已连接。请重启 Codex 并新建聊天，使工具生效；桌面挂件须保持运行。真实额度需要 Codex 已登录的账号。无需 Node.js 或项目源码。' };
}

async function disconnect({ payloadRoot = __dirname, homeDir = os.homedir(), env = process.env, codexCli, run = spawnSync,
  runtime: modules, fileSystem = fs, queryDesktop, readBundle } = {}) {
  // Removal must never prepare/copy a plugin or enumerate the user's config.
  // The official CLI owns its configuration and removes only this selector.
  const runtime = JSON.parse(fs.readFileSync(path.join(payloadRoot, 'runtime.json'), 'utf8'));
  if (!['win32', 'darwin'].includes(runtime.platform)) throw publicError('安装包的系统信息无效，请重新安装挂件。');
  modules ||= runtimeModules(payloadRoot);
  const cli = await locateCodex({payloadRoot,platform:runtime.platform,homeDir,env,explicit:codexCli,runtime:modules,fileSystem,queryDesktop,readBundle});
  const cliEnv = { ...env }; delete cliEnv.ELECTRON_RUN_AS_NODE;
  const result = runCodex(cli,['plugin','remove',PLUGIN+'@'+MARKETPLACE,'--json'],{platform:runtime.platform,env:cliEnv,run,runtime:modules});
  if (result.error || result.status !== 0) {
    throw publicError('未能断开本地挂件插件，尚未删除挂件文件。请更新 Codex 后重试；也可在 Codex 中手动卸载 codex-maid-widget@codex-maid-installed。' +
      (result.error?.code && /^[A-Z0-9_]+$/.test(result.error.code) ? '（' + result.error.code + '）' : '（退出码 ' + result.status + '）'));
  }
  return { ok: true, marketplace: MARKETPLACE, message: 'Codex 女仆挂件的本地插件已断开。请重启 Codex 并新建聊天。其他插件、挂件设置和导入形象均保留；现在可以卸载挂件。' };
}

async function main(argv = process.argv.slice(2)) {
  let resultFile;
  try {
    const { values } = parseArgs({ args: argv, options: { help: { type: 'boolean', short: 'h' }, install: { type: 'boolean' }, remove: { type: 'boolean' }, uninstall: { type: 'boolean' }, 'prepare-only': { type: 'boolean' },
      'result-file': { type: 'string' }, 'codex-cli': { type: 'string' } } });
    resultFile = values['result-file'];
    const remove = values.remove || values.uninstall;
    if (remove && (values.install || values['prepare-only'])) throw publicError('连接、准备和断开选项不能同时使用。未执行任何变更。');
    if (values.help || (!values.install && !values['prepare-only'] && !remove)) {
      process.stdout.write(JSON.stringify({ ok: true, message: '使用 --install 连接 Codex 本地插件；使用 --remove（或 --uninstall）通过官方 CLI 断开本项目插件。默认不执行任何变更。' }) + '\n');
      return;
    }
    const result = await (remove ? disconnect({ codexCli: values['codex-cli'] }) : connect({ codexCli: values['codex-cli'], prepareOnly: values['prepare-only'] }));
    if (resultFile) fs.writeFileSync(resultFile, JSON.stringify(result) + '\n');
    process.stdout.write(JSON.stringify(result) + '\n');
  } catch (error) {
    const result = { ok: false, message: error.publicMessage || '插件操作未完成。请检查安装文件及 Codex 版本后重试。', ...(error.code === 'CODEX_CLI_MISSING' ? { code: error.code } : {}) };
    if (resultFile) { try { fs.writeFileSync(resultFile, JSON.stringify(result) + '\n'); } catch { /* stdout also carries the result. */ } }
    process.stdout.write(JSON.stringify(result) + '\n');
    process.exitCode = 1;
  }
}
if (require.main === module) main();
module.exports = { MARKETPLACE, PLUGIN, preparePlugin, locateCodex, connect, disconnect, main };
