'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { checkVersions } = require('../check-versions.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'maid-version-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'macos'));
  fs.mkdirSync(path.join(root, 'distribution'));
  fs.copyFileSync(path.join(__dirname, '../check-versions.cjs'), path.join(root, 'distribution/check-versions.cjs'));
  for (const prefix of ['', 'macos/']) {
    fs.writeFileSync(path.join(root, prefix + 'package.json'), JSON.stringify({ name: 'fixture', version: '0.3.12' }));
    fs.writeFileSync(path.join(root, prefix + 'package-lock.json'), JSON.stringify({ version: '0.3.12', lockfileVersion: 3,
      packages: { '': { version: '0.3.12' }, 'node_modules/unrelated': { version: '0.4.0' } } }));
  }
  for (const prefix of ['', 'macos/']) {
    const directory = path.join(root, prefix, 'plugins/codex-maid-widget/.codex-plugin');
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'plugin.json'), JSON.stringify({ version: '0.3.12' }));
  }
  return root;
}

test('aligned application manifests pass without comparing dependency versions', t => {
  const root = fixture(t);
  assert.equal(checkVersions({ root }), '0.3.12');
  const result = spawnSync(process.execPath, [path.join(root, 'distribution/check-versions.cjs')], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Windows = macOS = 0\.3\.12/);
});

test('a stale app version in any manifest or lockfile stops release validation', t => {
  const variants = [
    ['package.json', 'version'], ['package-lock.json', 'version'], ['package-lock.json', 'root'],
    ['macos/package.json', 'version'], ['macos/package-lock.json', 'version'], ['macos/package-lock.json', 'root'],
    ['plugins/codex-maid-widget/.codex-plugin/plugin.json', 'version'],
    ['macos/plugins/codex-maid-widget/.codex-plugin/plugin.json', 'version'],
  ];
  for (const [relative, field] of variants) {
    const root = fixture(t);
    const file = path.join(root, relative);
    const data = JSON.parse(fs.readFileSync(file));
    if (field === 'root') data.packages[''].version = '0.4.0';
    else data.version = '0.4.0';
    fs.writeFileSync(file, JSON.stringify(data));
    assert.throws(() => checkVersions({ root }), /Application versions must match/);
    const result = spawnSync(process.execPath, [path.join(root, 'distribution/check-versions.cjs')], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /0\.4\.0/);
  }
});
