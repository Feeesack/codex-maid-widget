'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

for (const variant of ['..', '../macos']) {
  const { resolveCodexExecutable } = require(variant + '/src/codex-cli.cjs');
  const missing = () => { throw Object.assign(new Error('fixture: missing'), { code: 'CLI_MISSING' }); };
  function fixture(roots, files = [], known = true) {
    let queries = 0;
    return {
      find: missing, platform: 'win32',
      queryDesktop: async () => { queries++; return { known, roots }; },
      fileSystem: { statSync(file) { if (!files.includes(file)) throw Error('fixture: absent'); return { isFile: () => true }; } },
      get queries() { return queries; },
    };
  }
  test(`${variant}: explicit CLI and PATH resolution precede desktop discovery`, async () => {
    const options = fixture([]);
    assert.equal(await resolveCodexExecutable('E:\\tools\\codex.exe', { ...options, find: value => value }), 'E:\\tools\\codex.exe');
    assert.equal(await resolveCodexExecutable(null, { ...options, find: () => 'F:\\npm\\codex.cmd' }), 'F:\\npm\\codex.cmd');
    assert.equal(options.queries, 0);
    await assert.rejects(resolveCodexExecutable('bad\npath', options), { code: 'CLI_MISSING' });
    assert.equal(options.queries, 0);
  });
  test(`${variant}: package CLI discovery is independent of volume, username and version`, async () => {
    for (const folder of ['C:\\Program Files\\WindowsApps', 'D:\\WindowsApps', 'Z:\\应用卷\\Apps', '\\\\?\\Volume{01234567-0123-0123-0123-0123456789ab}\\Apps']) {
      const executable = path.win32.join(folder, 'OpenAI.Codex_99.2.3.0_arm64__2p2nqsd0c76g0', 'app', 'ChatGPT.exe');
      const cli = path.win32.join(path.win32.dirname(executable), 'resources', 'codex.exe');
      const options = fixture([{ officialDesktop: true, path: executable }], [cli]);
      assert.equal(await resolveCodexExecutable(null, options), cli);
      assert.equal(options.queries, 1);
    }
  });
  test(`${variant}: unverified, missing and unknown inventories never select an executable`, async () => {
    const executable = 'D:\\WindowsApps\\OpenAI.Codex_1__2p2nqsd0c76g0\\app\\ChatGPT.exe';
    const cli = path.win32.join(path.win32.dirname(executable), 'resources', 'codex.exe');
    for (const root of [{ path: executable }, { officialDesktop: false, path: executable }, { officialDesktop: true, path: 'relative\\ChatGPT.exe' }]) {
      await assert.rejects(resolveCodexExecutable(null, fixture([root], [cli])), { code: 'CLI_MISSING' });
    }
    await assert.rejects(resolveCodexExecutable(null, fixture([{ officialDesktop: true, path: executable }], [cli], false)), { code: 'CLI_MISSING' });
    await assert.rejects(resolveCodexExecutable(null, fixture([{ officialDesktop: true, path: executable }], [])), { code: 'CLI_MISSING' });
    await assert.rejects(resolveCodexExecutable(null, { ...fixture([]), queryDesktop: async () => { throw Error('fixture: unavailable'); } }), { code: 'CLI_MISSING' });
  });
  test(`${variant}: macOS discovery requires a verified same-user main bundle executable and executable CLI`, async () => {
    const executable = '/Volumes/Fixture Disk/Renamed.app/Contents/MacOS/Main';
    const cli = '/Volumes/Fixture Disk/Renamed.app/Contents/Resources/bin/codex';
    const good = { uid: 501, bundleId: 'com.openai.codex', bundleExecutable: 'Main', path: executable };
    const options = fixture([good], [cli]); let access = 0;
    options.fileSystem.accessSync = file => { assert.equal(file, cli); access++; };
    assert.equal(await resolveCodexExecutable(null, { ...options, platform: 'darwin', uid: 501 }), cli);
    assert.equal(access, 1);
    for (const patch of [{ uid: 502 }, { bundleId: 'com.openai.chat' }, { bundleExecutable: 'Helper' },
      { path: '/tmp/app/../Renamed.app/Contents/MacOS/Main' }, { bundleId: undefined }])
      await assert.rejects(resolveCodexExecutable(null, { ...options, platform: 'darwin', uid: 501,
        queryDesktop: async () => ({ known: true, roots: [{ ...good, ...patch }] }) }), { code: 'CLI_MISSING' });
    options.fileSystem.accessSync = () => { throw Error('fixture: not executable'); };
    await assert.rejects(resolveCodexExecutable(null, { ...options, platform: 'darwin', uid: 501 }), { code: 'CLI_MISSING' });
  });
  test(`${variant}: closing during CLI discovery cannot start an app-server`, async () => {
    const { ReadOnlyAppServer } = require(variant + '/src/codex-data.cjs');
    let answer, spawned = 0;
    const discovery = new Promise(resolve => { answer = resolve; });
    const server = new ReadOnlyAppServer({ platform: 'win32', env: { PATH: '' },
      fileSystem: { statSync: () => ({ isFile: () => true }) }, queryDesktop: () => discovery,
      spawn: () => { spawned++; throw Error('fixture: must not spawn'); } });
    const connecting = server.connect();
    server.close();
    answer({ known: true, roots: [{ officialDesktop: true, path: 'D:\\WindowsApps\\Codex\\app\\ChatGPT.exe' }] });
    await assert.rejects(connecting, { code: 'CLOSED' });
    assert.equal(spawned, 0);
  });
  test(`${variant}: invalidation supersedes pending CLI discovery without clearing a newer connection`, async () => {
    const { ReadOnlyAppServer } = require(variant + '/src/codex-data.cjs');
    const answers = [];
    let spawned = 0;
    const server = new ReadOnlyAppServer({ platform: 'win32', env: { PATH: '' },
      fileSystem: { statSync: () => ({ isFile: () => true }) },
      queryDesktop: () => new Promise(resolve => answers.push(resolve)),
      spawn: () => { spawned++; throw Error('fixture: must not spawn'); } });
    const older = server.connect();
    server.disconnect(Object.assign(new Error('fixture: invalidated'), { code: 'INVALIDATED' }));
    const newer = server.connect();
    const active = server.connecting;
    const reply = { known: true, roots: [{ officialDesktop: true, path: 'E:\\Package\\app\\ChatGPT.exe' }] };
    answers[0](reply);
    await assert.rejects(older, { code: 'INVALIDATED' });
    assert.equal(server.connecting, active);
    assert.equal(spawned, 0);
    server.close(); answers[1](reply);
    await assert.rejects(newer, { code: 'CLOSED' });
    assert.equal(spawned, 0);
  });
}
