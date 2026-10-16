'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { fileURLToPath } = require('node:url');
const { CharacterLibrary, MAX_IMAGE_BYTES } = require('../src/character-library.cjs');

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j1ioAAAAASUVORK5CYII=', 'base64');
// GIF is deliberately a different format/image so built-in duplicate detection
// does not prevent import tests from exercising independent copies.
const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'maid-characters-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dataDir = path.join(root, 'user-data');
  const assetRoot = path.join(root, 'assets');
  const sources = path.join(root, 'source files');
  fs.mkdirSync(path.join(assetRoot, 'characters'), { recursive: true });
  fs.mkdirSync(sources);
  fs.writeFileSync(path.join(assetRoot, 'maid.png'), PNG);
  fs.writeFileSync(path.join(assetRoot, 'characters', 'lilac-dragon.png'), PNG);
  const library = new CharacterLibrary({ dataDir, assetRoot, ...options });
  return {
    root, dataDir, assetRoot, sources, library,
    reopen: () => new CharacterLibrary({ dataDir, assetRoot, ...options }),
    source: (name = '我的形象.gif', bytes = GIF) => { const file = path.join(sources, name); fs.writeFileSync(file, bytes); return file; },
  };
}

test('built-in entries have stable ids and do not need a manifest', t => {
  const { library } = fixture(t);
  assert.equal(library.defaultId, 'lilac-dragon');
  assert.deepEqual(library.list().map(({ id, name, available, builtIn }) => ({ id, name, available, builtIn })), [
    { id: 'mint-maid', name: '薄荷女仆', available: true, builtIn: true },
    { id: 'lilac-dragon', name: '紫晶龙女仆', available: true, builtIn: true },
  ]);
  assert.equal(fs.existsSync(library.manifestPath), false);
  assert.equal(library.get('missing'), null);
});

test('import creates an independent copy and selection ids survive restart and source removal', t => {
  const { library, source, reopen, dataDir } = fixture(t);
  const original = source();
  const imported = library.importFiles([original]);
  assert.equal(imported.errors.length, 0);
  assert.equal(imported.imported.length, 1);
  const entry = imported.imported[0];
  assert.equal(entry.name, '我的形象');
  assert.equal(entry.builtIn, false);
  const copy = fileURLToPath(entry.url);
  assert.equal(path.dirname(copy), path.join(dataDir, 'characters'));
  assert.notEqual(copy, original);
  assert.deepEqual(fs.readFileSync(copy), GIF);
  fs.writeFileSync(original, 'original changed');
  fs.unlinkSync(original);
  assert.deepEqual(fs.readFileSync(copy), GIF);
  assert.deepEqual(reopen().get(entry.id), entry);
  assert.deepEqual(fs.readdirSync(library.directory).sort(), [path.basename(copy), 'library.json'].sort());
});

test('same bytes deduplicate across names, batches, restarts and built-ins', t => {
  const { library, source, reopen, assetRoot } = fixture(t);
  const first = source('first.gif');
  const renamedCopy = source('duplicate.gif');
  const builtinCopy = source('builtin.png', PNG);
  const result = library.importFiles([first, renamedCopy, builtinCopy, path.join(assetRoot, 'maid.png')]);
  assert.equal(result.imported.length, 1);
  assert.deepEqual(result.existing.map(entry => entry.id), [result.imported[0].id, 'mint-maid', 'mint-maid']);
  assert.equal(result.errors.length, 0);
  const restored = reopen();
  const duplicate = restored.importFiles([first]);
  assert.equal(duplicate.imported.length, 0);
  assert.equal(duplicate.existing[0].id, result.imported[0].id);
  assert.equal(restored.list().length, 3);
});

test('each bad image is reported while good files in the same batch are still imported', t => {
  const { library, source } = fixture(t);
  const fake = source('fake.png', Buffer.from('not an image'));
  const renamedFormat = source('renamed.jpg', GIF);
  const unsupported = source('image.svg', Buffer.from('<svg/>'));
  const oversized = path.join(path.dirname(fake), 'oversized.png');
  const fd = fs.openSync(oversized, 'w');
  fs.ftruncateSync(fd, MAX_IMAGE_BYTES + 1);
  fs.closeSync(fd);
  const valid = source('good.gif');
  const result = library.importFiles([fake, renamedFormat, unsupported, oversized, valid]);
  assert.equal(result.imported.length, 1);
  assert.equal(result.imported[0].name, 'good');
  assert.deepEqual(result.errors.map(error => error.name), ['fake.png', 'renamed.jpg', 'image.svg', 'oversized.png']);
  assert.match(result.errors[3].message, /15 MB/);
  assert.equal(library.list().length, 3);
});

test('optional decoder can reject a signed but undecodable image without saving a copy', t => {
  const attempted = [];
  const { library, source } = fixture(t, { validateImage: file => { attempted.push(file); return false; } });
  const input = source();
  const result = library.importFiles([input]);
  assert.equal(result.imported.length, 0);
  assert.equal(result.errors.length, 1);
  assert.deepEqual(attempted, [input]);
  assert.deepEqual(fs.readdirSync(library.directory), []);
});

test('custom and built-in renames persist without overwriting images', t => {
  const { library, source, reopen, assetRoot } = fixture(t);
  const custom = library.importFiles([source()]).imported[0];
  assert.equal(library.rename(custom.id, '  龙女仆  ').name, '龙女仆');
  assert.equal(library.rename('mint-maid', '初代女仆').name, '初代女仆');
  assert.equal(reopen().get(custom.id).name, '龙女仆');
  assert.equal(reopen().get('mint-maid').name, '初代女仆');
  assert.deepEqual(fs.readFileSync(fileURLToPath(custom.url)), GIF);
  assert.deepEqual(fs.readFileSync(path.join(assetRoot, 'maid.png')), PNG);
  assert.throws(() => library.rename(custom.id, '   '), { code: 'INVALID_CHARACTER_NAME' });
  assert.throws(() => library.rename(custom.id, 'name\nline'), { code: 'INVALID_CHARACTER_NAME' });
  assert.throws(() => library.rename('missing', '名字'), { code: 'UNKNOWN_CHARACTER' });
});

test('delete removes only the imported copy and protects both built-ins', t => {
  const { library, source, reopen, assetRoot } = fixture(t);
  const original = source();
  const entry = library.importFiles([original]).imported[0];
  assert.equal(library.remove(entry.id), true);
  assert.equal(library.get(entry.id), null);
  assert.equal(reopen().get(entry.id), null);
  assert.equal(fs.existsSync(fileURLToPath(entry.url)), false);
  assert.deepEqual(fs.readFileSync(original), GIF);
  assert.equal(library.remove(entry.id), false);
  assert.throws(() => library.remove('mint-maid'), { code: 'BUILTIN_CHARACTER_PROTECTED' });
  assert.throws(() => library.remove('lilac-dragon'), { code: 'BUILTIN_CHARACTER_PROTECTED' });
  assert.equal(fs.existsSync(path.join(assetRoot, 'maid.png')), true);
});

test('missing custom files remain visible as unavailable and can be removed safely', t => {
  const { library, source, reopen } = fixture(t);
  const entry = library.importFiles([source()]).imported[0];
  fs.unlinkSync(fileURLToPath(entry.url));
  const restored = reopen();
  assert.equal(restored.get(entry.id).available, false);
  assert.equal(restored.remove(entry.id), true);
  assert.equal(restored.list().length, 2);
});

test('legacy images migrate once, preserve their originals and recognize the old built-in path', t => {
  const { library, source, reopen, assetRoot } = fixture(t);
  const original = source('legacy.gif');
  const migrated = library.migrateLegacy(original);
  assert.equal(migrated.builtIn, false);
  assert.deepEqual(fs.readFileSync(original), GIF);
  assert.equal(reopen().migrateLegacy(original).id, migrated.id);
  assert.equal(library.migrateLegacy(path.join(assetRoot, 'maid.png')).id, 'mint-maid');
  assert.equal(library.migrateLegacy(''), null);
  assert.throws(() => library.migrateLegacy(path.join(assetRoot, 'missing.png')), { code: 'LEGACY_CHARACTER_IMPORT_FAILED' });
  assert.equal(library.list().length, 3);
});

test('malformed and traversal manifests are preserved byte-for-byte with recoverable images', t => {
  const { library, source, reopen } = fixture(t);
  const entry = library.importFiles([source()]).imported[0];
  const good = JSON.parse(fs.readFileSync(library.manifestPath, 'utf8'));
  const malformed = '{ damaged json';
  const traversal = JSON.stringify({ ...good, characters: [{ ...good.characters[0], file: '../outside.gif' }] });
  const invalidId = JSON.stringify({ ...good, characters: [{ ...good.characters[0], id: '../../bad' }] });
  for (const invalid of [malformed, traversal, invalidId]) {
    fs.writeFileSync(library.manifestPath, invalid);
    assert.throws(() => reopen(), { code: 'CHARACTER_LIBRARY_CORRUPT' });
    assert.equal(fs.readFileSync(library.manifestPath, 'utf8'), invalid);
    assert.deepEqual(fs.readFileSync(fileURLToPath(entry.url)), GIF);
  }
  fs.writeFileSync(library.manifestPath, JSON.stringify(good));
  assert.equal(reopen().get(entry.id).available, true);
});

test('failed atomic commits retain the previous library and remove partial imports', t => {
  const { library, source, reopen } = fixture(t);
  library.rename('mint-maid', '已保存名称');
  const before = fs.readFileSync(library.manifestPath);
  const originalRename = fs.renameSync;
  fs.renameSync = function(from, to) {
    if (to === library.manifestPath) {
      const error = new Error('Simulated disk commit failure');
      error.code = 'EIO';
      throw error;
    }
    return originalRename.apply(this, arguments);
  };
  try {
    const result = library.importFiles([source()]);
    assert.equal(result.errors.length, 1);
    assert.equal(result.imported.length, 0);
    assert.throws(() => library.rename('mint-maid', '未提交名称'), /Simulated disk commit failure/);
    assert.equal(library.get('mint-maid').name, '已保存名称');
  } finally { fs.renameSync = originalRename; }
  assert.deepEqual(fs.readFileSync(library.manifestPath), before);
  assert.deepEqual(fs.readdirSync(library.directory), ['library.json']);
  assert.equal(reopen().list().length, 2);
});

test('failed delete commit restores both the record and the image copy', t => {
  const { library, source, reopen } = fixture(t);
  const entry = library.importFiles([source()]).imported[0];
  const before = fs.readFileSync(library.manifestPath);
  const originalRename = fs.renameSync;
  fs.renameSync = function(from, to) {
    if (to === library.manifestPath) throw new Error('Simulated commit failure');
    return originalRename.apply(this, arguments);
  };
  try { assert.throws(() => library.remove(entry.id), /Simulated commit failure/); }
  finally { fs.renameSync = originalRename; }
  assert.deepEqual(fs.readFileSync(library.manifestPath), before);
  assert.deepEqual(library.get(entry.id), entry);
  assert.deepEqual(reopen().get(entry.id), entry);
  assert.deepEqual(fs.readFileSync(fileURLToPath(entry.url)), GIF);
});
