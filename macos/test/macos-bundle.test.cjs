'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { MacBundleReader, bundleForExecutable } = require('../src/macos-bundle.cjs');

test('application metadata is read with plutil and cached until the plist metadata changes', () => {
  let stamp = 1, reads = 0;
  const reader = new MacBundleReader({ fileSystem: { statSync: () => ({ isFile: () => true, dev: 1, ino: 2, size: 300, mtimeMs: stamp, ctimeMs: stamp }) },
    execute(command, args, options) {
      reads++;
      assert.equal(command, '/usr/bin/plutil');
      assert.deepEqual(args, ['-convert', 'json', '-o', '-', '/Applications/ChatGPT.app/Contents/Info.plist']);
      assert.equal(options.timeout, 3000);
      assert.equal(options.maxBuffer, 1024 * 1024);
      assert.equal(Object.hasOwn(options, 'shell'), false);
      return JSON.stringify({ CFBundleIdentifier: 'com.openai.codex', CFBundleExecutable: reads === 1 ? 'Codex' : 'ChatGPT' });
    } });
  assert.deepEqual(reader.read('/Applications/ChatGPT.app'), { identifier: 'com.openai.codex', executable: 'Codex' });
  assert.deepEqual(reader.read('/Applications/ChatGPT.app'), { identifier: 'com.openai.codex', executable: 'Codex' });
  assert.equal(reads, 1);
  stamp++;
  assert.deepEqual(reader.read('/Applications/ChatGPT.app'), { identifier: 'com.openai.codex', executable: 'ChatGPT' });
  assert.equal(reads, 2);
});

test('missing bundles are absent while unreadable or malformed metadata remains an error', () => {
  const absent = new MacBundleReader({ fileSystem: { statSync() { throw Object.assign(new Error('absent'), { code: 'ENOENT' }); } } });
  assert.equal(absent.read('/Applications/Codex.app'), null);
  const denied = new MacBundleReader({ fileSystem: { statSync() { throw Object.assign(new Error('denied'), { code: 'EACCES' }); } } });
  assert.throws(() => denied.read('/Applications/Codex.app'));
  for (const data of ['invalid', '{}', '{"CFBundleIdentifier":"com.openai.codex","CFBundleExecutable":"../Codex"}']) {
    const reader = new MacBundleReader({ fileSystem: { statSync: () => ({ isFile: () => true }) }, execute: () => data });
    assert.throws(() => reader.read('/Applications/Codex.app'));
  }
  assert.deepEqual(bundleForExecutable('/Applications/Codex 2.app/Contents/MacOS/Codex'), { bundlePath: '/Applications/Codex 2.app', executable: 'Codex' });
  assert.equal(bundleForExecutable('/Applications/Codex.app/Contents/Resources/codex'), null);
});
