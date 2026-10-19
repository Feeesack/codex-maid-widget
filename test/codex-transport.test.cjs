'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

for (const variant of ['..', '../macos']) {
  const { ReadOnlyAppServer, findCodexExecutable } = require(variant + '/src/codex-data.cjs');
  const { environmentValue, codexCommandInvocation, desktopInventory } = require(variant + '/src/codex-cli.cjs');
  function fixture(options = {}) {
    let spawned = 0, launch;
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = new EventEmitter();
    child.stdout.setEncoding = () => {};
    child.stdin.destroy = () => { child.destroyed = true; };
    child.kill = () => { child.killed = true; };
    child.stdin.write = (value, callback) => {
      if (options.write) return options.write(value, callback, child);
      const message = JSON.parse(value);
      if (message.method === 'initialize' && options.initialize !== false)
        queueMicrotask(() => child.stdout.emit('data', JSON.stringify({ id: message.id, result: {} }) + '\n'));
      callback?.();
    };
    const server = new ReadOnlyAppServer({ platform: 'win32', codexPath: 'E:\\fixture\\codex.exe',
      env: { Path: '', LOCALAPPDATA: 'E:\\fixture-profile' }, ...options.server,
      spawn(file, args, settings) { spawned++; launch = { file, args, settings }; return child; } });
    return { server, child, get spawned() { return spawned; }, get launch() { return launch; } };
  }

  test(`${variant}: Windows PATH and explicit overrides use case-insensitive environment keys without host fallbacks`, () => {
    const found = 'E:\\fixtures\\npm\\codex.cmd', probes = [];
    const fileSystem = { statSync(file) { probes.push(file); if (file !== found) throw Error('fixture missing'); return { isFile: () => true }; } };
    assert.equal(findCodexExecutable(null, { platform: 'win32', env: { Path: 'E:\\fixtures\\npm' }, fileSystem }), found);
    assert.deepEqual(probes, ['E:\\fixtures\\npm\\codex.exe', found]);
    assert.equal(environmentValue({ PATH: 'first', Path: 'second' }, 'path', 'win32'), 'first');
    assert.equal(environmentValue({ Path: 'windows-only' }, 'PATH', 'darwin'), undefined);
    const server = new ReadOnlyAppServer({ platform: 'win32', env: { codex_maid_codex_path: found } });
    assert.equal(server.options.codexPath, found); server.close();
  });

  test(`${variant}: resolved executable and app-server inherit the same supplied environment and explicit home`, async t => {
    const h = fixture({ server: { env: { Path: 'E:\\fixture-bin', CoDeX_HoMe: 'old-fixture', marker: 'kept' }, codexHome: 'E:\\isolated-codex' } });
    t.after(() => h.server.close()); await h.server.connect();
    assert.deepEqual(h.launch.settings.env, { Path: 'E:\\fixture-bin', marker: 'kept', CODEX_HOME: 'E:\\isolated-codex' });
    assert.equal(h.spawned, 1);
  });

  test(`${variant}: cmd shims use the supplied command processor and safely quote spaces, Unicode and ampersands`, () => {
    const executable = 'E:\\Fixture & 用户\\codex.cmd', args = ['plugin', 'marketplace', 'add', 'F:\\插件 & Data', '--json'];
    const value = codexCommandInvocation(executable, args, { platform: 'win32', env: { comspec: 'D:\\Windows\\System32\\cmd.exe' } });
    assert.equal(value.file, 'D:\\Windows\\System32\\cmd.exe'); assert.equal(value.windowsVerbatimArguments, true);
    assert.deepEqual(value.args.slice(0, 3), ['/d', '/s', '/c']);
    assert.equal(value.args[3], '""E:\\Fixture & 用户\\codex.cmd" "plugin" "marketplace" "add" "F:\\插件 & Data" "--json""');
    for (const argument of ['%PATH%', '!expansion!', 'bad"quote', 'line\nbreak'])
      assert.throws(() => codexCommandInvocation(executable, [argument], { platform: 'win32', env: {} }), { code: 'CLI_MISSING' });
    assert.deepEqual(codexCommandInvocation('/fixture/codex', ['x'], { platform: 'darwin' }), { file: '/fixture/codex', args: ['x'] });
  });

  test(`${variant}: cancelling default desktop discovery immediately closes only its owned inventory`, async () => {
    const controller = new AbortController(); let finish, closed = 0;
    const pending = desktopInventory({ platform: 'win32', signal: controller.signal,
      createInventory: () => ({ query: () => new Promise(resolve => { finish = resolve; }), close() { closed++; finish({ known: false, roots: [] }); } }) });
    controller.abort(); await pending; assert.equal(closed, 1);
  });

  test(`${variant}: connection close cancels a pending discovery without waiting for its provider`, async () => {
    let signal;
    const server = new ReadOnlyAppServer({ platform: 'win32', env: { Path: '' }, fileSystem: { statSync() { throw Error('absent'); } },
      queryDesktop: options => { signal = options.signal; return new Promise(() => {}); }, spawn: () => { throw Error('must not spawn'); } });
    const pending = server.connect(); server.close();
    await assert.rejects(pending, { code: 'CLOSED' }); assert.equal(signal.aborted, true);
  });

  test(`${variant}: non-object JSON protocol messages reject initialization and release owned resources`, async () => {
    for (const message of [null, [], 42, 'text']) {
      const h = fixture({ initialize: false }), connecting = h.server.connect();
      // Allow asynchronous executable discovery to create the injected child.
      for (let i = 0; i < 12 && !h.server.child; i++) await Promise.resolve();
      h.child.stdout.emit('data', JSON.stringify(message) + '\n');
      await assert.rejects(connecting, { code: 'PROTOCOL' });
      assert.equal(h.child.killed, true); assert.equal(h.child.destroyed, true); assert.equal(h.server.pending.size, 0); h.server.close();
    }
  });

  test(`${variant}: synchronous writes and pipe errors reject all pending reads immediately`, async () => {
    const h = fixture(); await h.server.connect();
    h.child.stdin.write = () => { throw Object.assign(Error('fixture write failed'), { code: 'EPIPE' }); };
    await assert.rejects(h.server.request('account/read'), { code: 'EPIPE' });
    assert.equal(h.server.pending.size, 0); assert.equal(h.child.killed, true); h.server.close();
    for (const stream of ['stdin', 'stdout']) {
      const f = fixture(); await f.server.connect(); const pending = f.server.request('account/read');
      f.child[stream].emit('error', Object.assign(Error('fixture pipe failed'), { code: 'EPIPE' }));
      await assert.rejects(pending, { code: 'EPIPE' }); assert.equal(f.server.pending.size, 0); assert.equal(f.child.killed, true); f.server.close();
    }
  });
}
