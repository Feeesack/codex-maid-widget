'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { isRuntimePath, verifyRuntimeArchive, verifyRuntimeLicenses } = require('../scripts/verify-package.cjs');

test('Mac runtime allowlist accepts both path separators and rejects development trees', () => {
  for (const file of ['', '/src/main.cjs', '\\src\\main.cjs', '/assets/maid.png', '\\plugins\\maid\\.mcp.json', '/licenses/CC-BY-4.0.txt', '/package.json', '/LICENSE', '/NOTICE', '/ARTWORK_LICENSE.md']) {
    assert.equal(isRuntimePath(file), true, file);
  }
  for (const file of ['/README.md', '\\README.zh-CN.md', '/docs/coordination/CURRENT_STATE.md', '\\docs\\history.md', '/scripts/build.cjs', '/test/example.json', '/package-lock.json', '/release/old.pkg', '/tmp/settings.json', '/.git/config', '/node_modules/private/index.js', '/auth.json', '/src/../docs/private.md', '\\src\\..\\docs\\private.md']) {
    assert.equal(isRuntimePath(file), false, file);
  }
});

test('Mac ASAR audit accepts current runtime files and rejects embedded README', async () => {
  const { createPackage, uncacheAll } = await import('@electron/asar');
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'maid-mac-runtime-'));
  try {
    const source = path.join(fixture, 'app');
    fs.mkdirSync(path.join(source, 'src'), { recursive: true });
    fs.mkdirSync(path.join(source, 'licenses'));
    for (const file of ['package.json', 'LICENSE', 'NOTICE', 'ARTWORK_LICENSE.md', 'licenses/CC-BY-4.0.txt', 'src/entry.cjs']) fs.writeFileSync(path.join(source, file), file);
    const clean = path.join(fixture, 'clean.asar');
    await createPackage(source, clean);
    await verifyRuntimeArchive(clean);
    fs.writeFileSync(path.join(source, 'README.md'), 'build history must not be installed');
    const contaminated = path.join(fixture, 'contaminated.asar');
    await createPackage(source, contaminated);
    await assert.rejects(verifyRuntimeArchive(contaminated), /Non-runtime content/);
  } finally {
    uncacheAll();
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test('Mac ASAR audit rejects links without following their targets', async () => {
  const { createPackageFromStreams, uncacheAll } = await import('@electron/asar');
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'maid-mac-asar-link-'));
  try {
    const archive = path.join(fixture, 'linked.asar');
    const streams = ['package.json', 'LICENSE', 'NOTICE', 'ARTWORK_LICENSE.md', 'licenses/CC-BY-4.0.txt', 'src/entry.cjs'].map(file => {
      const content = Buffer.from(file);
      return { type: 'file', path: file, unpacked: false, stat: { size: content.length, mode: 0o100644 }, streamGenerator: () => Readable.from([content]) };
    });
    // This creates an actual ASAR link record without requiring the host's
    // native symbolic-link privilege or touching files outside the fixture.
    streams.push({ type: 'link', path: 'src/alias.cjs', symlink: 'entry.cjs', unpacked: false, stat: { mode: 0o120777 }, streamGenerator: () => Readable.from([]) });
    await createPackageFromStreams(archive, streams);
    await assert.rejects(verifyRuntimeArchive(archive), /Link in application archive/);
  } finally {
    uncacheAll();
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test('Mac package verification requires full Electron and Chromium license files', () => {
  const resources = fs.mkdtempSync(path.join(os.tmpdir(), 'maid-mac-runtime-licenses-'));
  try {
    const directory = path.join(resources, 'electron-licenses');
    fs.mkdirSync(directory);
    assert.throws(() => verifyRuntimeLicenses(resources), /Missing bundled runtime license: LICENSE/);
    const electron = path.join(directory, 'LICENSE');
    const chromium = path.join(directory, 'LICENSES.chromium.html');
    // Purpose-built text fixtures exercise the verifier without substituting a
    // different platform's actual notices into a distributable application.
    fs.writeFileSync(electron, 'Copyright (c) Electron contributors\n' + 'License terms.\n'.repeat(80));
    assert.throws(() => verifyRuntimeLicenses(resources), /Missing bundled runtime license: LICENSES.chromium.html/);
    fs.writeFileSync(chromium, '<!doctype html><html>Chromium software</html>');
    assert.throws(() => verifyRuntimeLicenses(resources), /Missing complete Chromium third-party notices/);
    fs.writeFileSync(chromium, '<!doctype html><html>Chromium software\n' + 'Third-party license terms.\n'.repeat(45_000) + '</html>');
    verifyRuntimeLicenses(resources);
    fs.writeFileSync(electron, 'Application MIT license without runtime notices.\n'.repeat(30));
    assert.throws(() => verifyRuntimeLicenses(resources), /Missing Electron copyright and license text/);
  } finally {
    fs.rmSync(resources, { recursive: true, force: true });
  }
});
