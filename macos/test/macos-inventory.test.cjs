'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { MacOSInventoryQuery, parseProcessMetadata } = require('../src/macos-inventory.cjs');
const { isCodexDesktopPath, desktopRoots, rootKey, queryCodexDesktop, createDesktopInventoryQuery } = require('../src/codex-desktop.cjs');

const desktop = '/Applications/Codex.app/Contents/MacOS/Codex';
const uid = 501;
const readBundle = () => ({ identifier: 'com.openai.codex', executable: 'Codex' });
const bundleIdentity = { bundleId: 'com.openai.codex', bundleExecutable: 'Codex' };
const metadata = '  501 100 1 Codex\n  501 101 100 Codex\n  501 102 100 Codex Helper\n  501 103 1 codex\n  501 110 1 ps\n';
const textEntry = (pid, file = desktop, owner = uid) => `p${pid}\0u${owner}\0\nftxt\0n${file}\0\nftxt\0n/usr/lib/dyld\0\n`;

test('Mac desktop paths accept the exact main bundle executable and preserve path case', () => {
  const options = { platform: 'darwin' };
  for (const file of [desktop, '/Users/test/Applications/Codex.app/Contents/MacOS/Codex', '/Volumes/Codex Installer/Codex.app/Contents/MacOS/Codex']) {
    assert.equal(isCodexDesktopPath(file, options), true, file);
  }
  for (const file of ['/usr/local/bin/codex', '/Applications/ChatGPT.app/Contents/MacOS/ChatGPT', desktop + ' Helper', desktop.toLowerCase(),
    '/Applications/Codex.app/Contents/Resources/codex', '/Applications/Codex.app/Contents/Frameworks/Codex Helper.app/Contents/MacOS/Codex Helper', 'relative/Codex.app/Contents/MacOS/Codex']) {
    assert.equal(isCodexDesktopPath(file, options), false, file);
  }
  assert.notEqual(rootKey({ pid: 1, path: desktop }), rootKey({ pid: 1, path: desktop.replace('/Applications/', '/applications/') }));
  assert.equal(isCodexDesktopPath('', { platform: 'darwin', bundleId: 'com.openai.codex' }), false);
  assert.equal(isCodexDesktopPath('/Applications/ChatGPT.app/Contents/MacOS/ChatGPT', { platform: 'darwin', bundleId: 'com.openai.chat', bundleExecutable: 'ChatGPT' }), false);
  assert.equal(rootKey({ pid: 1, path: 'C:\\APP\\Codex.exe' }), rootKey({ pid: 1, path: 'c:\\app\\codex.exe' }));
});

test('Mac enumeration asks only for current-user kernel metadata and txt vnode paths in one bounded call', async () => {
  let calls = 0;
  const query = createDesktopInventoryQuery({ platform: 'darwin', uid, readBundle, execFile(file, args, options, done) {
    assert.equal(options.encoding, 'utf8');
    assert.equal(options.windowsHide, true);
    assert.equal(options.maxBuffer, 1024 * 1024);
    if (++calls === 1) {
      assert.equal(file, '/bin/ps');
      assert.deepEqual(args, ['-x', '-U', '501', '-o', 'uid=,pid=,ppid=,ucomm=']);
      done(null, metadata, '');
    } else {
      assert.equal(file, '/usr/sbin/lsof');
      assert.deepEqual(args, ['-nP', '-a', '-u', '501', '-p', '100,101', '-d', 'txt', '-F', 'pufn0']);
      done(null, textEntry(100) + textEntry(101), '');
    }
  } });
  assert.deepEqual(await query.query(), { known: true, roots: [{ pid: 100, parentPid: 1, path: desktop, uid, ...bundleIdentity }] });
  query.close();
  assert.equal((await query.query()).known, false);
  assert.equal(calls, 2);
});

test('an inventory without Codex candidates starts no lsof and is a confirmed empty result', async () => {
  let calls = 0;
  const result = await queryCodexDesktop({ platform: 'darwin', uid, readBundle, execFile(file, _args, _options, done) {
    calls++;
    assert.equal(file, '/bin/ps');
    done(null, '501 12 1 ps\n501 13 1 codex\n501 14 1 Codex Helper\n', '');
  } });
  assert.deepEqual(result, { known: true, roots: [] });
  assert.equal(calls, 1);
});

test('missing ownership, permissions, malformed or partial inventories stay unknown', async () => {
  for (const output of ['', 'pid invalid', '502 100 1 Codex\n', '501 100 1 Codex\n501 100 1 Codex\n']) {
    assert.throws(() => parseProcessMetadata(output, uid));
  }
  for (const output of ['', textEntry(100), textEntry(100, desktop, 502) + textEntry(101), 'p100\0ftxt\0n' + desktop + '\0']) {
    const result = await queryCodexDesktop({ platform: 'darwin', uid, readBundle, execFile(file, _args, _options, done) {
      done(null, file === '/bin/ps' ? metadata : output, '');
    } });
    assert.equal(result.known, false);
    assert.deepEqual(result.roots, []);
  }
  for (const kind of ['timeout', 'stderr']) {
    const result = await queryCodexDesktop({ platform: 'darwin', uid, readBundle, execFile(_file, _args, _options, done) {
      done(kind === 'timeout' ? new Error('private error') : null, metadata, kind === 'stderr' ? 'private warning' : '');
    } });
    assert.equal(result.known, false);
    assert.doesNotMatch(JSON.stringify(result), /private/);
  }
});

test('unrelated named processes and helpers do not become desktop roots', async () => {
  const result = await queryCodexDesktop({ platform: 'darwin', uid, readBundle, execFile(file, _args, _options, done) {
    done(null, file === '/bin/ps' ? '501 100 1 Codex\n501 101 1 Codex\n' : textEntry(100, '/usr/local/bin/Codex') + textEntry(101, '/Applications/ChatGPT.app/Contents/MacOS/ChatGPT'), '');
  } });
  assert.deepEqual(result, { known: true, roots: [] });
  assert.deepEqual(desktopRoots([{ pid: 2, parentPid: 1, path: desktop, uid: -1 }], { platform: 'darwin' }), []);
});

test('renamed ChatGPT.app is identified by the Codex bundle ID and its declared main executable', async () => {
  for (const executable of ['Codex', 'ChatGPT', 'DesktopUI']) {
    const file = `/Applications/ChatGPT.app/Contents/MacOS/${executable}`;
    const metadata = `501 100 1 ${executable}\n501 110 1 ps\n`;
    const query = options => queryCodexDesktop({ platform: 'darwin', uid, ...options, execFile(command, _args, _options, done) {
      done(null, command === '/bin/ps' ? metadata : textEntry(100, file), '');
    } });
    const result = await query({ readBundle: () => ({ identifier: 'com.openai.codex', executable }) });
    assert.deepEqual(result, { known: true, roots: [{ pid: 100, parentPid: 1, path: file, uid, bundleId: 'com.openai.codex', bundleExecutable: executable }] });
    const classic = await query({ readBundle: () => ({ identifier: 'com.openai.chat', executable }) });
    assert.deepEqual(classic, { known: true, roots: [] });
    const unavailable = await query({ readBundle: bundle => bundle === '/Applications/ChatGPT.app' ? null : ({ identifier: 'com.openai.codex', executable }) });
    assert.equal(unavailable.known, false);
  }
});

test('concurrent Mac queries share work and close prevents a late snapshot from becoming known', async () => {
  let finish, kills = 0, calls = 0;
  const query = new MacOSInventoryQuery({ platform: 'darwin', uid, execFile(_file, _args, _options, done) {
    calls++;
    finish = done;
    return { kill() { kills++; done(new Error('closed')); } };
  } });
  const first = query.query();
  assert.equal(query.query(), first);
  query.close();
  assert.equal((await first).known, false);
  finish(null, metadata, '');
  assert.equal(kills, 1);
  assert.equal(calls, 1);
  assert.equal((await query.query()).known, false);
});
