'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { isRuntimePath, verifyRuntimeArchive } = require('../scripts/build.cjs');

test('runtime packaging excludes private development and build trees', () => {
  for (const file of ['', '/src/main.cjs', '/assets/maid.png', '\\plugins\\codex-maid-widget\\.codex-plugin\\plugin.json', '/licenses/CC-BY-4.0.txt', '/package.json', '/NOTICE']) {
    assert.equal(isRuntimePath(file), true, file);
  }
  for (const file of ['/docs/coordination/CURRENT_STATE.md', '/chat_backup/private.json', '/.agents/local.md', '/macos/src/main.cjs', '/scripts/build.cjs', '/test/fixture.json', '/release/old.exe', '/node_modules/private/index.js', '/package-lock.json', '/src/../docs/private.md']) {
    assert.equal(isRuntimePath(file), false, file);
  }
});

test('archive audit rejects development documents even when all licenses are present', async () => {
  const { createPackage, uncacheAll } = await import('@electron/asar');
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'maid-runtime-boundary-'));
  try {
    const source = path.join(fixture, 'app');
    fs.mkdirSync(source);
    for (const file of ['package.json', 'LICENSE', 'NOTICE', 'ARTWORK_LICENSE.md']) fs.writeFileSync(path.join(source, file), file);
    fs.mkdirSync(path.join(source, 'src'));
    fs.writeFileSync(path.join(source, 'src/entry.cjs'), 'runtime');
    const clean = path.join(fixture, 'clean.asar');
    await createPackage(source, clean);
    await verifyRuntimeArchive(clean);
    fs.mkdirSync(path.join(source, 'docs'));
    fs.writeFileSync(path.join(source, 'docs/private-handoff.md'), 'private development notes');
    const contaminated = path.join(fixture, 'contaminated.asar');
    await createPackage(source, contaminated);
    await assert.rejects(verifyRuntimeArchive(contaminated), /Non-runtime content/);
  } finally {
    uncacheAll();
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});
