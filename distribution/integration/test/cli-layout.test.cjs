'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { locateCodex } = require('../connect.cjs');

// No profile files, actual installations or child processes are used here.
function inventory(root, identifier) {
  const win = path.win32, bin = win.join(root, 'bin'), directory = win.join(bin, identifier);
  const cli = win.join(directory, 'codex.exe');
  const folders = new Set([root, bin, directory]);
  const stat = file => {
    if (!folders.has(file) && file !== cli) throw Object.assign(new Error('Synthetic missing file'), { code: 'ENOENT' });
    return { isDirectory: () => folders.has(file), isFile: () => file === cli,
      isSymbolicLink: () => false, size: file === cli ? 1024 : 0, mtimeMs: 100 };
  };
  return { cli, fileSystem: { statSync: stat, lstatSync: stat,
    realpathSync(file) { stat(file); return file; },
    readdirSync(file) {
      assert.equal(file, bin);
      return [{ name: identifier, isDirectory: () => true, isSymbolicLink: () => false }];
    } } };
}

for (const variant of ['', 'macos/']) {
  const source = path.resolve(__dirname, '../../..', variant, 'src');
  const runtime = { ...require(path.join(source, 'codex-data.cjs')), ...require(path.join(source, 'codex-cli.cjs')) };
  test(`${variant || 'Windows/'} connector reuses versioned CLI discovery in an isolated custom user location`, async () => {
    const local = 'Q:\\隔离 用户 & 空格\\Local';
    const fixture = inventory(path.win32.join(local, 'OpenAI', 'Codex'), 'desktop-next_42.a1');
    assert.equal(await locateCodex({ platform: 'win32', homeDir: 'Q:\\隔离 用户',
      env: { Path: '', LocalAppData: local }, runtime, fileSystem: fixture.fileSystem,
      queryDesktop: async () => ({ known: true, roots: [] }) }), fixture.cli);
  });

  test(`${variant || 'Windows/'} connector reuses versioned discovery beside a verified desktop on another drive`, async () => {
    const root = 'Z:\\应用 空间\\Codex';
    const fixture = inventory(root, 'opaque-release-id');
    const options = { platform: 'win32', homeDir: 'Q:\\隔离 用户', env: { Path: '' }, runtime,
      fileSystem: fixture.fileSystem, queryDesktop: async () => ({ known: true,
        roots: [{ officialDesktop: true, path: path.win32.join(root, 'Codex.exe') }] }) };
    assert.equal(await locateCodex(options), fixture.cli);
    await assert.rejects(locateCodex({ ...options, queryDesktop: async () => ({ known: true,
      roots: [{ officialDesktop: false, path: path.win32.join(root, 'Codex.exe') }] }) }), { code: 'CODEX_CLI_MISSING' });
  });
}
