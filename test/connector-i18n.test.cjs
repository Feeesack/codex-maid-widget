'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

const root = path.join(__dirname, '..');
const success = 'Codex 女仆挂件插件已连接。请重启 Codex 并新建聊天，使工具生效；桌面挂件须保持运行。真实额度需要 Codex 已登录的账号。无需 Node.js 或项目源码。';
const missing = '未找到可运行的 Codex 命令行程序。请先打开已安装的 Codex 桌面版再重试；自定义位置可通过 CODEX_CLI 或 CODEX_MAID_CODEX_PATH 指定，无需安装 Node.js。';
const generic = '插件操作未完成。请检查安装文件及 Codex 版本后重试。';
const registerFailure = '注册本地插件来源失败。请更新 Codex 后重新连接；也可在 Codex 的插件目录中安装“Codex 女仆挂件 · 安装版”。';
const installFailure = '安装本地挂件插件失败。请更新 Codex 后重新连接；也可在 Codex 的插件目录中安装“Codex 女仆挂件 · 安装版”。';
const hasHan = value => /\p{Script=Han}/u.test(value);

function translations(directory) {
  const context = { module: { exports: {} } };
  vm.runInNewContext(fs.readFileSync(path.join(root, directory, 'i18n.js'), 'utf8'), context);
  return context.module.exports;
}

for (const directory of ['src', 'macos/src']) {
  test(directory + ': connector result translations retain all user actions and technical identifiers', () => {
    const i18n = translations(directory); i18n.setLocale('en');
    const connected = i18n.connectorMessage(success);
    assert.equal(hasHan(connected), false);
    for (const required of ['Restart Codex', 'start a new chat', 'companion running', 'account signed in', 'Node.js', 'project source']) assert.ok(connected.includes(required));
    const unavailable = i18n.connectorMessage(missing);
    assert.equal(hasHan(unavailable), false);
    for (const required of ['Codex CLI', 'desktop app', 'CODEX_CLI', 'CODEX_MAID_CODEX_PATH', 'Node.js']) assert.ok(unavailable.includes(required));
    assert.match(i18n.connectorMessage(generic), /Check the app installation and Codex version/);
    assert.match(i18n.connectorMessage('连接文件已准备，尚未修改 Codex 设置。'), /settings have not been changed/);
  });

  test(directory + ': connector failures retain safe error codes and distinguish registration from installation', () => {
    const i18n = translations(directory); i18n.setLocale('en');
    const registering = i18n.connectorMessage(registerFailure + '（ENOENT）');
    assert.match(registering, /^Could not register the local plugin source\./);
    assert.ok(registering.endsWith('(ENOENT)'));
    assert.ok(registering.includes('codex-maid-widget@codex-maid-installed'));
    for (const code of ['2', '-1', 'null']) {
      const installing = i18n.connectorMessage(installFailure + '（退出码 ' + code + '）');
      assert.match(installing, /^Could not install the local widget plugin\./);
      assert.ok(installing.endsWith('(Exit code ' + code + ')'));
      assert.equal(hasHan(installing), false);
    }
    assert.ok(i18n.connectorMessage(installFailure + '（ETIMEDOUT）').endsWith('(ETIMEDOUT)'));
  });

  test(directory + ': Chinese connector messages round-trip exactly and unknown external diagnostics remain literal', () => {
    const i18n = translations(directory);
    const messages = [success, missing, generic, registerFailure + '（ENOENT）', installFailure + '（退出码 2）',
      'Unrecognized connector result: fixture only', '  未知消息保留空格  ', registerFailure + '（unsafe/path）'];
    for (const message of messages) assert.equal(i18n.connectorMessage(message), message);
    i18n.setLocale('en');
    for (const message of messages.slice(5)) assert.equal(i18n.connectorMessage(message), message);
    i18n.setLocale('zh-CN');
    for (const message of messages) assert.equal(i18n.connectorMessage(message), message);
  });
}

function macController(language) {
  // Execute the real menu action. All filesystem, Electron, data-home and
  // child-process dependencies are injected; no user data or connector runs.
  const i18n = translations('macos/src'), dialogs = [], invocations = [];
  let result;
  const app = new EventEmitter();
  Object.assign(app, { isPackaged: true, setName() {}, setPath() {}, getPath: () => '/isolated-widget-data',
    requestSingleInstanceLock: () => false, quit() {} });
  const modules = {
    electron: { app, dialog: { async showMessageBox(options) { dialogs.push(options); return { response: 0 }; } } },
    'node:fs': { mkdirSync() {}, existsSync: () => true },
    'node:child_process': { execFile(file, args, options, callback) { invocations.push({ file, args, options }); callback(null, JSON.stringify(result)); } },
    './i18n.js': i18n,
    './settings.cjs': { readSettings: () => ({ language, followCodex: false }) },
    './data-home.cjs': { prepareDataHome: () => '/isolated-widget-data' },
    './platform.cjs': { supportsDesktopFollow: () => false },
  };
  const context = { module: { exports: {} }, __dirname: path.join(root, 'macos', 'src'),
    process: { platform: 'darwin', argv: [], env: {}, execPath: '/isolated-app/Contents/MacOS/Codex Maid', resourcesPath: '/isolated-app/Contents/Resources' },
    require(name) {
      if (Object.hasOwn(modules, name)) return modules[name];
      if (name.startsWith('./')) return {};
      if (name.startsWith('node:')) return require(name);
      throw new Error('Unexpected module: ' + name);
    }, setTimeout, clearTimeout, setInterval, clearInterval };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'macos', 'src', 'main.cjs'), 'utf8') + '\nmodule.exports = { connectCodexPlugin };', context);
  return { i18n, dialogs, invocations, async connect(value) { result = value; await context.module.exports.connectCodexPlugin(); return dialogs.at(-1); } };
}

for (const language of ['en', 'zh-CN']) {
  test('macOS native connector result body follows ' + language + ' without changing the external command', async () => {
    const h = macController(language);
    for (const result of [{ ok: true, message: success }, { ok: false, code: 'CODEX_CLI_MISSING', message: missing },
      { ok: false, message: generic }, { ok: false, message: registerFailure + '（ENOENT）' },
      { ok: false, message: installFailure + '（退出码 2）' }]) {
      const dialog = await h.connect(result);
      assert.equal(dialog.type, result.ok ? 'info' : 'error');
      assert.equal(dialog.detail, h.i18n.connectorMessage(result.message));
      if (language === 'en') assert.equal(hasHan(dialog.detail), false);
      else assert.equal(dialog.detail, result.message);
      assert.deepEqual(Array.from(h.invocations.at(-1).args).slice(1), ['--install']);
    }
    assert.equal(h.invocations.length, 5);
  });
}
