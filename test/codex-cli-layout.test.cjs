'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// All installation metadata and filesystem operations are in-memory fixtures.
// No process inventory, real profile, authentication file or executable is used.
function memoryFiles() {
  const nodes = new Map(), directories = new Map(), aliases = new Map(), probes = [];
  const key = value => path.win32.normalize(value).toLowerCase();
  let reads = 0, closes = 0;
  const stat = value => {
    probes.push(value);
    const item = nodes.get(key(value));
    if (!item || item.error) throw Error('fixture: unavailable');
    return { isDirectory: () => item.type === 'directory', isFile: () => item.type === 'file',
      isSymbolicLink: () => !!item.link, size: item.size ?? 1024, mtimeMs: item.modified ?? 0 };
  };
  const entry = (name, type = 'directory', link = false) => ({ name,
    isDirectory: () => type === 'directory', isSymbolicLink: () => link });
  const put = (file, options = {}) => nodes.set(key(file), { type: 'file', ...options });
  const install = (root, versions) => {
    const bin = path.win32.join(root, 'bin'); put(root, { type: 'directory' }); put(bin, { type: 'directory' });
    directories.set(key(bin), versions.map(item => entry(item.name, item.type, item.link)));
    for (const item of versions) {
      const directory = path.win32.join(bin, item.name);
      put(directory, { type: item.type || 'directory', link: item.link, modified: item.modified });
      if (!item.missing) put(path.win32.join(directory, 'codex.exe'), item.file);
    }
  };
  const fileSystem = {
    statSync: stat, lstatSync: stat,
    realpathSync(value) { if (!nodes.has(key(value))) throw Error('fixture: absent'); return aliases.get(key(value)) || value; },
    opendirSync(value) {
      const values = directories.get(key(value)); if (!values) throw Error('fixture: absent'); let index = 0;
      return { readSync() { reads++; return values[index++] || null; }, closeSync() { closes++; } };
    },
    readdirSync(value) { const values = directories.get(key(value)); if (!values) throw Error('fixture: absent'); return values; },
  };
  return { fileSystem, install, put, entry, probes, directories, nodes, aliases, key,
    get reads() { return reads; }, get closes() { return closes; } };
}

for (const variant of ['..', '../macos']) {
  const { findCodexCandidate, resolveCodexExecutable } = require(variant + '/src/codex-cli.cjs');
  const local = 'E:\\测试 用户\\Local Data';
  const roots = [path.win32.join(local, 'Programs', 'OpenAI', 'Codex'), path.win32.join(local, 'OpenAI', 'Codex')];
  const options = fixture => ({ platform: 'win32', env: { Path: '', LocalAppData: local }, fileSystem: fixture.fileSystem });

  test(`${variant}: opaque desktop build directories work under both declared user installation roots`, () => {
    for (const root of roots) for (const name of ['ab38d442', 'build_Channel-Alpha.2', '26.1018.9_abc123']) {
      const fixture = memoryFiles(); fixture.install(root, [{ name }]);
      const expected = path.win32.join(root, 'bin', name, 'codex.exe');
      assert.equal(findCodexCandidate(null, options(fixture)), expected);
      assert.ok(fixture.probes.every(file => !file.includes('C:\\Users\\')));
    }
  });

  test(`${variant}: explicit paths, PATH and old flat layouts keep priority and exclusions advance deterministically`, () => {
    const fixture = memoryFiles(), settings = options(fixture), old = path.win32.join(roots[0], 'bin', 'codex.exe');
    fixture.install(roots[0], [{ name: 'new-build', modified: 20 }]); fixture.put(old);
    const shim = 'F:\\工具 空格\\codex.cmd'; fixture.put(shim); settings.env.Path = 'F:\\工具 空格';
    assert.equal(findCodexCandidate('Z:\\explicit\\codex.exe', settings), 'Z:\\explicit\\codex.exe');
    assert.equal(findCodexCandidate(null, settings), shim);
    const excludedPaths = new Set(['f:/工具 空格/CODEX.CMD']);
    assert.equal(findCodexCandidate(null, { ...settings, excludedPaths }), old);
    excludedPaths.add(old.toUpperCase());
    const dynamic = path.win32.join(roots[0], 'bin', 'new-build', 'codex.exe');
    assert.equal(findCodexCandidate(null, { ...settings, excludedPaths }), dynamic);
    excludedPaths.add(dynamic);
    assert.throws(() => findCodexCandidate(null, { ...settings, excludedPaths }), { code: 'CLI_MISSING' });
    assert.throws(() => findCodexCandidate(shim, { ...settings, excludedPaths }), { code: 'CLI_MISSING' });
    assert.throws(() => findCodexCandidate('bad\npath', settings), { code: 'CLI_MISSING' });
  });

  test(`${variant}: latest build mtime wins and equal mtimes use stable names, without interpreting a hash as a version`, () => {
    const fixture = memoryFiles(), root = roots[1];
    fixture.install(root, [{ name: 'fffffff', modified: 10 }, { name: 'release_b', modified: 20 },
      { name: 'release_a', modified: 20 }, { name: 'newest', modified: 30 }]);
    const excludedPaths = [];
    for (const name of ['newest', 'release_a', 'release_b', 'fffffff']) {
      const candidate = path.win32.join(root, 'bin', name, 'codex.exe');
      assert.equal(findCodexCandidate(null, { ...options(fixture), excludedPaths }), candidate);
      excludedPaths.push(candidate);
    }
    assert.throws(() => findCodexCandidate(null, { ...options(fixture), excludedPaths }), { code: 'CLI_MISSING' });
  });

  test(`${variant}: discovery refuses malformed names, links, escaped real paths, damaged or oversized files`, () => {
    const fixture = memoryFiles(), root = roots[0], bin = path.win32.join(root, 'bin');
    fixture.install(root, [{ name: '..\\outside' }, { name: '.', missing: true }, { name: '..', missing: true }, { name: 'bad/name' },
      { name: 'bad\nname' }, { name: 'a'.repeat(129) }, { name: 'trailing.' },
      { name: 'linked-directory', link: true }, { name: 'not-directory', type: 'file' },
      { name: 'linked-executable', file: { link: true } }, { name: 'empty', file: { size: 0 } },
      { name: 'oversized', file: { size: 512 * 1024 * 1024 + 1 } }, { name: 'directory-executable', file: { type: 'directory' } },
      { name: 'partial-install', missing: true }, { name: 'denied', file: { error: true } },
      { name: 'escaped-directory' }, { name: 'escaped-executable' }, { name: 'valid', modified: -1 }]);
    fixture.aliases.set(fixture.key(path.win32.join(bin, 'escaped-directory')), 'Z:\\external');
    fixture.aliases.set(fixture.key(path.win32.join(bin, 'escaped-executable', 'codex.exe')), 'Z:\\external\\codex.exe');
    assert.equal(findCodexCandidate(null, options(fixture)), path.win32.join(bin, 'valid', 'codex.exe'));
    assert.ok(!fixture.probes.some(file => file === path.win32.join(root, 'outside', 'codex.exe')));
    fixture.put(bin, { type: 'directory', link: true });
    assert.throws(() => findCodexCandidate(null, options(fixture)), { code: 'CLI_MISSING' });
  });

  test(`${variant}: dynamic enumeration has a hard limit, closes its handle and never recurses`, () => {
    const fixture = memoryFiles(), root = roots[1];
    fixture.install(root, Array.from({ length: 129 }, (_, i) => ({ name: 'build-' + i })));
    assert.throws(() => findCodexCandidate(null, options(fixture)), { code: 'CLI_MISSING' });
    assert.equal(fixture.reads, 129); assert.equal(fixture.closes, 1);
    assert.equal(fixture.probes.some(file => /build-\d+\\codex\.exe$/.test(file)), false);
    delete fixture.fileSystem.opendirSync;
    assert.throws(() => findCodexCandidate(null, options(fixture)), { code: 'CLI_MISSING' });
    fixture.directories.set(fixture.key(path.win32.join(root, 'bin')), []);
    assert.throws(() => findCodexCandidate(null, options(fixture)), { code: 'CLI_MISSING' });
  });

  test(`${variant}: old injected filesystems without lstat preserve flat discovery and skip dynamic discovery`, () => {
    const fixture = memoryFiles(), root = roots[0], old = path.win32.join(root, 'bin', 'codex.exe');
    fixture.install(root, [{ name: 'build' }]); delete fixture.fileSystem.lstatSync;
    assert.throws(() => findCodexCandidate(null, options(fixture)), { code: 'CLI_MISSING' });
    fixture.put(old); assert.equal(findCodexCandidate(null, options(fixture)), old);
    assert.throws(() => findCodexCandidate(null, { ...options(fixture), env: { PATH: '', LOCALAPPDATA: '..\\not-absolute' } }), { code: 'CLI_MISSING' });
  });

  test(`${variant}: verified desktop discovery supports moved volumes and versioned CLI layouts, while preserving resources/bin priority`, async () => {
    for (const root of ['Z:\\应用 卷\\Codex', '\\\\fixture-server\\应用 卷\\Codex',
      '\\\\?\\Volume{01234567-0123-0123-0123-0123456789ab}\\Codex']) {
      const fixture = memoryFiles(), executable = path.win32.join(root, 'Codex.exe');
      fixture.install(root, [{ name: 'opaque-new-build', modified: 2 }, { name: 'opaque-old-build', modified: 1 }]);
      const resources = path.win32.join(root, 'resources', 'codex.exe'), flat = path.win32.join(root, 'bin', 'codex.exe');
      fixture.put(resources); fixture.put(flat);
      let queries = 0; const excludedPaths = new Set();
      const settings = { ...options(fixture), env: { Path: '' }, excludedPaths,
        find: (_explicit, overrides) => { assert.equal(overrides.excludedPaths, excludedPaths); throw Object.assign(Error('fixture: missing'), { code: 'CLI_MISSING' }); },
        queryDesktop: async () => { queries++; return { known: true, roots: [{ officialDesktop: true, path: executable }] }; } };
      for (const candidate of [resources, flat, path.win32.join(root, 'bin', 'opaque-new-build', 'codex.exe'), path.win32.join(root, 'bin', 'opaque-old-build', 'codex.exe')]) {
        assert.equal(await resolveCodexExecutable(null, settings), candidate); excludedPaths.add(candidate.toUpperCase());
      }
      await assert.rejects(resolveCodexExecutable(null, settings), { code: 'CLI_MISSING' });
      assert.equal(queries, 5);
      await assert.rejects(resolveCodexExecutable(null, { ...settings,
        queryDesktop: async () => ({ known: true, roots: [{ officialDesktop: false, path: executable }] }) }), { code: 'CLI_MISSING' });
    }
  });

  test(`${variant}: exclusions treat Windows extended drive aliases as the same candidate and never silently replace an explicit CLI`, async () => {
    const fixture = memoryFiles(), root = roots[0], candidate = path.win32.join(root, 'bin', 'codex.exe'); fixture.put(candidate);
    const excludedPaths = new Set(['\\\\?\\' + candidate.toUpperCase()]);
    let queried = false;
    const settings = { ...options(fixture), excludedPaths, find: value => value,
      queryDesktop: async () => { queried = true; throw Error('fixture: must not query'); } };
    await assert.rejects(resolveCodexExecutable(candidate, settings), { code: 'CLI_MISSING' });
    assert.equal(queried, false);
    assert.throws(() => findCodexCandidate(candidate, settings), { code: 'CLI_MISSING' });
  });

  test(`${variant}: injected macOS bundle metadata and executable checks retain all old discovery fallbacks and exclusions`, () => {
    const home = '/Volumes/用户 Disk/Fixture', bundle = home + '/Applications/Codex.app';
    const main = bundle + '/Contents/MacOS/Main', first = bundle + '/Contents/Resources/codex', second = bundle + '/Contents/Resources/bin/codex';
    const files = new Set([main, first, second, '/opt/homebrew/bin/codex', home + '/.local/bin/codex']);
    const checked = [], settings = { platform: 'darwin', env: { PATH: '' }, homedir: home,
      readBundle: value => value === bundle ? { identifier: 'com.openai.codex', executable: 'Main' } : null,
      fileSystem: { statSync(file) { if (!files.has(file)) throw Error('fixture: absent'); return { isFile: () => true }; }, accessSync(file) { checked.push(file); } } };
    const excludedPaths = [];
    for (const candidate of [first, second, '/opt/homebrew/bin/codex', home + '/.local/bin/codex']) {
      assert.equal(findCodexCandidate(null, { ...settings, excludedPaths }), candidate); excludedPaths.push(candidate);
    }
    assert.throws(() => findCodexCandidate(null, { ...settings, excludedPaths }), { code: 'CLI_MISSING' });
    assert.ok(checked.includes(main));
    assert.equal(findCodexCandidate(null, { ...settings, readBundle: () => ({ identifier: 'wrong.bundle', executable: 'Main' }) }), '/opt/homebrew/bin/codex');
    assert.throws(() => findCodexCandidate(null, { ...settings, fileSystem: { ...settings.fileSystem, accessSync() { throw Error('fixture: denied'); } } }), { code: 'CLI_MISSING' });
  });
}
