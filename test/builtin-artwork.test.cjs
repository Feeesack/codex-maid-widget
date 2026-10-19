'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { fileURLToPath } = require('node:url');

const artworks = [
  { id: 'frost-glass-idle', name: '小龙娘-端庄', bytes: 1608135, sha256: '090130109d051b1c0fd9e691a0582c309d2df8a1c6d7a00b3c3753c35f42f8ae' },
  { id: 'frost-glass-cheek', name: '小龙娘-托腮', bytes: 1611136, sha256: '63fa79d524ce3dbecafc623804c9bb4c835b67e019783200051adea12c187f36' },
];

for (const variant of ['..', '../macos']) {
  test(`${variant}: bundled Frost Glass images preserve original RGBA bytes and use the protected built-in library`, t => {
    const root = path.resolve(__dirname, variant);
    const { CharacterLibrary } = require(path.join(root, 'src', 'character-library.cjs'));
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maid 内置 图库 '));
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    const options = { dataDir, assetRoot: path.join(root, 'assets') };
    const library = new CharacterLibrary(options);
    assert.equal(library.defaultId, 'frost-glass-cheek');
    for (const artwork of artworks) {
      const entry = library.get(artwork.id);
      assert.equal(entry.name, artwork.name);
      assert.equal(entry.available, true);
      assert.equal(entry.builtIn, true);
      const file = fileURLToPath(entry.url), bytes = fs.readFileSync(file);
      assert.equal(bytes.length, artwork.bytes);
      // The complete source digest also protects the original alpha channel;
      // no decoded/re-encoded image can silently replace this shipped artwork.
      assert.equal(createHash('sha256').update(bytes).digest('hex'), artwork.sha256);
      assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
      assert.equal(bytes.readUInt32BE(16), 1381);
      assert.equal(bytes.readUInt32BE(20), 1139);
      assert.equal(bytes[24], 8);
      assert.equal(bytes[25], 6, 'PNG retains RGB and alpha');
      const duplicate = library.importFiles([file]);
      assert.equal(duplicate.errors.length, 0);
      assert.equal(duplicate.imported.length, 0);
      assert.equal(duplicate.existing[0].id, artwork.id);
      assert.throws(() => library.remove(artwork.id), { code: 'BUILTIN_CHARACTER_PROTECTED' });
      library.rename(artwork.id, artwork.name + '（我的命名）');
      assert.equal(new CharacterLibrary(options).get(artwork.id).name, artwork.name + '（我的命名）');
    }
    assert.equal(library.list().filter(entry => entry.builtIn).length, 4);
    assert.equal(library.list().filter(entry => !entry.builtIn).length, 0);
  });
}
