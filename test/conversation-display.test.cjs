'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

for (const variant of ['', 'macos/']) {
  const filename = path.join(__dirname, '..', variant, 'src/conversation-display.cjs');
  const source = fs.readFileSync(filename, 'utf8');
  const imports = [];
  const sandbox = { module: { exports: {} }, require(id) {
    imports.push(id);
    assert.equal(id, 'node:path', 'pure display helpers must not load filesystem, process or profile dependencies');
    return require(id);
  }, setTimeout() { throw Error('display helpers must not schedule work'); }, setInterval() { throw Error('display helpers must not schedule work'); } };
  vm.runInNewContext(source, sandbox, { filename });
  const { displayText, workspaceDisplay } = sandbox.module.exports;
  const name = variant ? 'macOS' : 'Windows';
  const display = cwd => JSON.parse(JSON.stringify(workspaceDisplay(cwd)));

  test(`${name}: display metadata is pure, bounded and strips controls and bidi formatting`, () => {
    assert.deepEqual(imports, ['node:path']);
    assert.equal(displayText(' \u0000\tA\u007fB\u202a\u202b\u202c\u202d\u202eC\u2066\u2067\u2068\u2069 '), 'A B     C');
    for (const value of [null, undefined, 42, {}, [], { toString() { throw Error('must not coerce'); } }]) assert.equal(displayText(value), '');
    assert.equal(displayText('x'.repeat(1000)).length, 160);
    assert.equal(displayText('x'.repeat(4000), 2048).length, 2048);
    assert.doesNotMatch(displayText('title\u0001\u202e\u2066end'), /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/);
  });
  test(`${name}: Windows drive and UNC paths retain their native path form without IO`, () => {
    for (const [cwd, label, detail] of [
      ['C:\\work\\Project', 'Project', 'C:\\work\\Project'],
      ['C:\\work\\team\\..\\Project\\', 'Project', 'C:\\work\\Project\\'],
      ['\\\\server\\share\\Project', 'Project', '\\\\server\\share\\Project'],
      ['\\\\server\\share\\', 'share', '\\\\server\\share\\'],
    ]) assert.deepEqual(display(cwd), { label, detail });
    assert.deepEqual(imports, ['node:path']);
  });
  test(`${name}: macOS and POSIX paths including the filesystem root retain slashes without IO`, () => {
    for (const [cwd, label, detail] of [
      ['/Users/fixture/Project', 'Project', '/Users/fixture/Project'],
      ['/Users/fixture/开发/Project/', 'Project', '/Users/fixture/开发/Project/'],
      ['/work/team/../Project', 'Project', '/work/Project'],
      ['/', '/', '/'],
    ]) assert.deepEqual(display(cwd), { label, detail });
    assert.deepEqual(imports, ['node:path']);
  });
  test(`${name}: missing, relative and NUL-bearing workspaces never become guessed project paths`, () => {
    for (const cwd of [null, undefined, '', '.', '..', 'relative/project', 'C:relative', 'C:', 0, [], {}, '/valid\0invalid']) {
      assert.deepEqual(display(cwd), {}, String(cwd));
    }
    assert.deepEqual(imports, ['node:path']);
  });
  test(`${name}: workspace labels and details use strict string bounds and remove control characters`, () => {
    const result = display('/isolated/' + 'p'.repeat(5000));
    assert.equal(result.label.length, 160); assert.equal(result.detail.length, 2048);
    assert.doesNotMatch(JSON.stringify(display('/isolated/\u0001project\u202e\u2069')), /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/);
    assert.deepEqual(imports, ['node:path']);
  });
}

test('conversation display helpers are mirrored byte for byte', () => {
  assert.equal(fs.readFileSync(path.join(__dirname, '../src/conversation-display.cjs'), 'utf8'),
    fs.readFileSync(path.join(__dirname, '../macos/src/conversation-display.cjs'), 'utf8'));
});
