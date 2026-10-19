'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
for (const folder of ['', 'macos/']) {
  test(folder + 'SortableJS: official browser build and MIT license match the pinned upstream bytes', () => {
    const directory = path.join(__dirname, '..', folder, 'src/vendor/sortable');
    const proof = JSON.parse(fs.readFileSync(path.join(directory, 'PROVENANCE.json')));
    const script = fs.readFileSync(path.join(directory, 'Sortable-1.15.7.min.js'));
    const license = fs.readFileSync(path.join(directory, 'LICENSE'));
    assert.equal(script.length, 45478);
    assert.equal(sha256(script), 'bf4241bc73fef7f11c59a283a69fe8051cdd31c6d8ff5a2b9ba219e7831fcf76');
    assert.equal(sha256(license), 'e94dfc31e800d169257569db270457c9f028440c9ccae41e7eb78b2db18f1298');
    assert.equal(proof.sha256, sha256(script)); assert.equal(proof.licenseSha256, sha256(license));
    assert.equal(proof.version, '1.15.7'); assert.equal(proof.license, 'MIT');
    assert.equal(proof.commit, '031649b8116565e02419e8aa2d252d7d8c82b9da');
    assert.equal(proof.githubAndNpmBytesMatch, true); assert.equal(proof.upstreamBytesUnmodified, true);
    assert.match(license.toString(), /Permission is hereby granted, free of charge/);
    const Sortable = require(path.join(directory, 'Sortable-1.15.7.min.js'));
    assert.equal(Sortable.version, '1.15.7'); assert.equal(typeof Sortable.create, 'function'); assert.equal(typeof Sortable.get, 'function');
  });
}
test('SortableJS: Windows and macOS use the same official distribution and adapter', () => {
  for (const file of ['settings.js', 'vendor/sortable/Sortable-1.15.7.min.js', 'vendor/sortable/LICENSE', 'vendor/sortable/PROVENANCE.json']) {
    assert.equal(sha256(fs.readFileSync(path.join(__dirname, '../src', file))), sha256(fs.readFileSync(path.join(__dirname, '../macos/src', file))));
  }
});
