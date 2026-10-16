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

function locateCodex({ platform = process.platform, homeDir = os.homedir(), env = process.env, explicit, run = spawnSync, fileSystem = fs, readBundle } = {}) {
  const candidates = [explicit, env.CODEX_CLI];
  const isFile = file => { try { return !!file && fileSystem.statSync(file).isFile(); } catch { return false; } };
  for (const candidate of candidates) if (isFile(candidate)) return path.resolve(candidate);
  if (platform === 'win32') {
    if (env.LOCALAPPDATA) candidates.push(path.join(env.LOCALAPPDATA, 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe'));
    const found = run('where.exe', ['codex.exe'], { encoding: 'utf8', windowsHide: true, timeout: 5000, env });
    if (found.status === 0) candidates.push(...found.stdout.trim().split(/\r?\n/));
  } else {
    const bundleMetadata = readBundle || (bundle => {
      const info = path.posix.join(bundle, 'Contents', 'Info.plist');
      if (!isFile(info)) return null;
      const result = run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', info], { encoding: 'utf8', timeout: 5000, env });
      if (result.status !== 0) return null;
      try { return JSON.parse(result.stdout); } catch { return null; }
    });
    // Newer Codex distributions may be named ChatGPT.app. Names alone are
    // ambiguous; inspect only signed application metadata, never user data.
    for (const directory of ['/Applications', path.posix.join(homeDir, 'Applications')]) {
      for (const name of ['Codex.app', 'ChatGPT.app']) {
        const base = path.posix.join(directory, name);
        let info;
        try { info = bundleMetadata(base); } catch { continue; }
        if (info?.CFBundleIdentifier !== 'com.openai.codex' || typeof info.CFBundleExecutable !== 'string' ||
            !info.CFBundleExecutable || /[\\/\0\r\n]/.test(info.CFBundleExecutable) ||
            !isFile(path.posix.join(base, 'Contents', 'MacOS', info.CFBundleExecutable))) continue;
        candidates.push(path.posix.join(base, 'Contents', 'Resources', 'codex'), path.posix.join(base, 'Contents', 'Resources', 'bin', 'codex'));
      }
    }
    candidates.push('/opt/homebrew/bin/codex', '/usr/local/bin/codex', path.join(homeDir, '.local', 'bin', 'codex'));
    const found = run('/usr/bin/which', ['codex'], { encoding: 'utf8', timeout: 5000, env });
    if (found.status === 0) candidates.push(found.stdout.trim());
  }
  for (const candidate of candidates) {
    if (isFile(candidate)) return path.resolve(candidate);
  }
  throw publicError('未找到 Codex 的命令行程序。请先安装或更新 Codex 桌面版，再运行插件连接或断开工具。自定义位置可通过 CODEX_CLI 指定，无需安装 Node.js。', 'CODEX_CLI_MISSING');
}

function connect({ payloadRoot = __dirname, executable = process.execPath, homeDir = os.homedir(), env = process.env, codexCli, run = spawnSync, prepareOnly = false } = {}) {
  const prepared = preparePlugin({ payloadRoot, executable, homeDir, env });
  if (prepareOnly) return { ok: true, message: '连接文件已准备，尚未修改 Codex 设置。', integrationRoot: prepared.integrationRoot };
  const cli = locateCodex({ platform: prepared.platform, homeDir, env, explicit: codexCli, run });
  const cliEnv = { ...env }; delete cliEnv.ELECTRON_RUN_AS_NODE;
  const commands = [
    { args: ['plugin', 'marketplace', 'add', prepared.integrationRoot, '--json'], label: '注册本地插件来源' },
    { args: ['plugin', 'add', PLUGIN + '@' + MARKETPLACE, '--json'], label: '安装本地挂件插件' }
  ];
  for (const command of commands) {
    const result = run(cli, command.args, { env: cliEnv, encoding: 'utf8', timeout: 120000, maxBuffer: 2 * 1024 * 1024, windowsHide: true });
    if (result.error || result.status !== 0) {
      throw publicError(command.label + '失败。请更新 Codex 后重新连接；也可在 Codex 的插件目录中安装“Codex 女仆挂件 · 安装版”。' +
        (result.error?.code ? '（' + result.error.code + '）' : '（退出码 ' + result.status + '）'));
    }
  }
  return { ok: true, marketplace: MARKETPLACE, integrationRoot: prepared.integrationRoot,
    message: 'Codex 女仆挂件插件已连接。请重启 Codex 并新建聊天，使工具生效；桌面挂件须保持运行。真实额度需要 Codex 已登录的账号。无需 Node.js 或项目源码。' };
}

function disconnect({ payloadRoot = __dirname, homeDir = os.homedir(), env = process.env, codexCli, run = spawnSync } = {}) {
  // Removal must never prepare/copy a plugin or enumerate the user's config.
  // The official CLI owns its configuration and removes only this selector.
  const runtime = JSON.parse(fs.readFileSync(path.join(payloadRoot, 'runtime.json'), 'utf8'));
  if (!['win32', 'darwin'].includes(runtime.platform)) throw publicError('安装包的系统信息无效，请重新安装挂件。');
  const cli = locateCodex({ platform: runtime.platform, homeDir, env, explicit: codexCli, run });
  const cliEnv = { ...env }; delete cliEnv.ELECTRON_RUN_AS_NODE;
  const result = run(cli, ['plugin', 'remove', PLUGIN + '@' + MARKETPLACE, '--json'],
    { env: cliEnv, encoding: 'utf8', timeout: 120000, maxBuffer: 2 * 1024 * 1024, windowsHide: true });
  if (result.error || result.status !== 0) {
    throw publicError('未能断开本地挂件插件，尚未删除挂件文件。请更新 Codex 后重试；也可在 Codex 中手动卸载 codex-maid-widget@codex-maid-installed。' +
      (result.error?.code && /^[A-Z0-9_]+$/.test(result.error.code) ? '（' + result.error.code + '）' : '（退出码 ' + result.status + '）'));
  }
  return { ok: true, marketplace: MARKETPLACE, message: 'Codex 女仆挂件的本地插件已断开。请重启 Codex 并新建聊天。其他插件、挂件设置和导入形象均保留；现在可以卸载挂件。' };
}

function main(argv = process.argv.slice(2)) {
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
    const result = remove ? disconnect({ codexCli: values['codex-cli'] }) : connect({ codexCli: values['codex-cli'], prepareOnly: values['prepare-only'] });
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
