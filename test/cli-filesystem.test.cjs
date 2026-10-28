'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('Windows versioned CLI discovery works with native Dirents, Chinese/spaced paths and junction rejection',
  { skip: process.platform !== 'win32' }, t => {
    const parent = path.resolve(os.tmpdir());
    const temporary = fs.mkdtempSync(path.join(parent, 'CLI 安装目录 隔离 '));
    t.after(() => {
      const relative = path.relative(parent, path.resolve(temporary));
      assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
      assert.ok(path.basename(temporary).startsWith('CLI 安装目录 隔离 '));
      fs.rmSync(temporary, { recursive: true, force: true });
    });
    const local = path.join(temporary, '自定义 用户资料');
    const bin = path.join(local, 'OpenAI', 'Codex', 'bin');
    for (const [name, modified] of [['old-build', 100], ['new-build', 200]]) {
      const directory = path.join(bin, name);
      fs.mkdirSync(directory, { recursive: true });
      // Discovery only: these synthetic bytes are never executed.
      fs.writeFileSync(path.join(directory, 'codex.exe'), Buffer.alloc(512));
      fs.utimesSync(directory, modified, modified);
    }
    const outside = path.join(temporary, 'outside-bin');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'codex.exe'), Buffer.alloc(512));
    fs.symlinkSync(outside, path.join(bin, 'linked-new-build'), 'junction');
    for (const variant of ['..', '../macos']) {
      const { findCodexCandidate } = require(variant + '/src/codex-cli.cjs');
      const options = { platform: 'win32', env: { Path: '', LocalAppData: local }, fileSystem: fs };
      const latest = path.join(bin, 'new-build', 'codex.exe'), older = path.join(bin, 'old-build', 'codex.exe');
      assert.equal(findCodexCandidate(null, options), latest);
      assert.equal(findCodexCandidate(null, { ...options, excludedPaths: [latest] }), older);
      assert.throws(() => findCodexCandidate(null, { ...options, excludedPaths: [latest, older] }), { code: 'CLI_MISSING' });
    }
  });
