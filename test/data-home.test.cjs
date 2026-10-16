'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { prepareDataHome } = require('../src/data-home.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'maid-data-home-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, '用户');
  const legacyDir = path.join(root, 'Roaming', 'codex-maid-widget');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(legacyDir, { recursive: true });
  return { root, home, legacyDir, destination: path.join(home, '.codex-maid-widget') };
}

test('default data home is under the user home and independent of APPDATA virtualization', t => {
  const f = fixture(t);
  const destination = prepareDataHome({ env: { APPDATA: path.join(f.root, 'virtual-roaming') }, home: f.home, legacyDir: f.legacyDir });
  assert.equal(destination, f.destination);
  assert.ok(fs.statSync(destination).isDirectory());
});

test('explicit data home resolves exactly as provided and does not import legacy preferences', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.legacyDir, 'settings.json'), '{"followCodex":false}');
  const override = path.join(f.root, '  custom profile  ');
  assert.equal(prepareDataHome({ env: { CODEX_MAID_HOME: override }, home: f.home, legacyDir: f.legacyDir }), path.resolve(override));
  assert.equal(fs.existsSync(override), false);
  assert.equal(fs.existsSync(f.destination), false);
  assert.throws(() => prepareDataHome({ env: { CODEX_MAID_HOME: 'bad\0path' }, home: f.home }), TypeError);
});

test('first migration copies settings and all character bytes atomically while excluding runtime files', t => {
  const f = fixture(t);
  const settings = Buffer.from('{"activeCharacterId":"lilac-dragon","followCodex":true,"customNote":"自定义台词"}');
  const index = Buffer.from('{"characters":[{"id":"custom","file":"dragon.png"}]}');
  const picture = Buffer.from([137, 80, 78, 71, 0, 255, 14]);
  fs.writeFileSync(path.join(f.legacyDir, 'settings.json'), settings);
  fs.mkdirSync(path.join(f.legacyDir, 'characters', 'images'), { recursive: true });
  fs.writeFileSync(path.join(f.legacyDir, 'characters', 'index.json'), index);
  fs.writeFileSync(path.join(f.legacyDir, 'characters', 'images', 'dragon.png'), picture);
  for (const file of ['control.json', 'watcher.json', 'auth.json', 'browser-cache']) fs.writeFileSync(path.join(f.legacyDir, file), 'runtime');
  const result = prepareDataHome({ env: {}, home: f.home, legacyDir: f.legacyDir });
  assert.equal(result, f.destination);
  assert.deepEqual(fs.readFileSync(path.join(result, 'settings.json')), settings);
  assert.deepEqual(fs.readFileSync(path.join(result, 'characters', 'index.json')), index);
  assert.deepEqual(fs.readFileSync(path.join(result, 'characters', 'images', 'dragon.png')), picture);
  assert.deepEqual(fs.readdirSync(result).sort(), ['characters', 'settings.json']);
  assert.deepEqual(fs.readFileSync(path.join(f.legacyDir, 'settings.json')), settings);
  assert.deepEqual(fs.readFileSync(path.join(f.legacyDir, 'characters', 'images', 'dragon.png')), picture);
  assert.equal(fs.readdirSync(f.home).some(name => name.includes('migrating-')), false);
});

test('existing new preferences take precedence and are never overwritten by legacy values', t => {
  const f = fixture(t);
  fs.mkdirSync(f.destination);
  fs.writeFileSync(path.join(f.destination, 'settings.json'), '{"customNote":"新的偏好"}');
  fs.writeFileSync(path.join(f.legacyDir, 'settings.json'), '{"customNote":"旧的偏好"}');
  const result = prepareDataHome({ env: {}, home: f.home, legacyDir: f.legacyDir });
  assert.equal(fs.readFileSync(path.join(result, 'settings.json'), 'utf8'), '{"customNote":"新的偏好"}');
  assert.equal(fs.readFileSync(path.join(f.legacyDir, 'settings.json'), 'utf8'), '{"customNote":"旧的偏好"}');
});

test('copy failures keep legacy and staging data without publishing a partial formal directory', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.legacyDir, 'settings.json'), '{"customNote":"保留我"}');
  fs.mkdirSync(path.join(f.legacyDir, 'characters'));
  fs.writeFileSync(path.join(f.legacyDir, 'characters', 'index.json'), 'original-index');
  const io = { ...fs, cpSync: (_source, target) => {
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'partial-image.png'), 'partially-copied');
    throw Object.assign(new Error('injected copy failure'), { code: 'EIO' });
  } };
  assert.throws(() => prepareDataHome({ env: {}, home: f.home, legacyDir: f.legacyDir, fs: io }), error => {
    assert.equal(error.code, 'DATA_HOME_MIGRATION_FAILED');
    assert.equal(error.cause.code, 'EIO');
    assert.equal(fs.readFileSync(path.join(error.stagingDir, 'settings.json'), 'utf8'), '{"customNote":"保留我"}');
    assert.ok(fs.existsSync(path.join(error.stagingDir, 'characters', 'partial-image.png')));
    return true;
  });
  assert.equal(fs.existsSync(f.destination), false);
  assert.equal(fs.readFileSync(path.join(f.legacyDir, 'settings.json'), 'utf8'), '{"customNote":"保留我"}');
  assert.equal(fs.readFileSync(path.join(f.legacyDir, 'characters', 'index.json'), 'utf8'), 'original-index');
});

test('an existing empty destination can be migrated, while incomplete user assets are preserved', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.legacyDir, 'settings.json'), '{"scale":1}');
  fs.mkdirSync(f.destination);
  assert.equal(prepareDataHome({ env: {}, home: f.home, legacyDir: f.legacyDir }), f.destination);
  fs.unlinkSync(path.join(f.destination, 'settings.json'));
  fs.writeFileSync(path.join(f.destination, 'recovered.png'), 'precious');
  assert.throws(() => prepareDataHome({ env: {}, home: f.home, legacyDir: f.legacyDir }), /已保留新旧目录/);
  assert.equal(fs.readFileSync(path.join(f.destination, 'recovered.png'), 'utf8'), 'precious');
});
