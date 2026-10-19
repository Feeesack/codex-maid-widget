'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { readLocalInteractionOverlay } = require('../scripts/build.cjs');
const { withLocalSamples } = require('../src/interaction-audio.js');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

test('bundled duck bank retains original MP3 bytes, default and matching platform copies', () => {
  const publicBank = require('../src/interaction-samples.js');
  const local = require('../src/local-interaction-samples.js');
  assert.deepEqual(Object.keys(local.presets), ['dsh-original']);
  assert.equal(hash(Buffer.from(local.presets['dsh-original'].press, 'base64')), '0ad8f934ae5fa3cbd42745e086a56aa6532766618c6a620b860a795bdc7689f9');
  assert.equal(hash(Buffer.from(local.presets['dsh-original'].release, 'base64')), '1a8998077e5e306c3088bb442ce36617261dd58200754f457469a520801c565b');
  assert.equal(Object.keys(withLocalSamples(publicBank, local).presets).length, 5);
  const privatePair = { press: 'AA==', release: 'AQ==', gain: .5 };
  const merged = withLocalSamples(publicBank, { presets: { 'dsh-original': privatePair } });
  assert.equal(merged.defaultId, 'bubble-pop');
  assert.equal(merged.presets['dsh-original'], privatePair);
  assert.equal(Object.hasOwn(publicBank.presets, 'dsh-original'), false);
  assert.deepEqual(Object.keys(merged.presets), [...Object.keys(publicBank.presets), 'dsh-original']);
  assert.deepEqual(fs.readFileSync(path.join(__dirname, '../src/local-interaction-samples.js')),
    fs.readFileSync(path.join(__dirname, '../macos/src/local-interaction-samples.js')));
});

test('local build overlay requires matching review and original pair hashes inside the explicit tmp tree', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'maid-private-overlay-test-'));
  try {
    const directory = path.join(fixture, 'tmp', 'review');
    fs.mkdirSync(directory, { recursive: true });
    const file = path.join(directory, 'local-interaction-samples.js');
    const pair = { press: Buffer.from('fixture press').toString('base64'), release: Buffer.from('fixture release').toString('base64'), gain: .5 };
    const source = 'module.exports=' + JSON.stringify({ presets: { 'dsh-original': pair } }) + ';';
    fs.writeFileSync(file, source);
    const proof = { localModule: { path: path.basename(file), sha256: hash(source), presetId: 'dsh-original' },
      license: { assetsCoveredByMit: false, redistributionAuthorizationObtained: false },
      files: ['press','release'].map((role, index) => ({ file: ['Ya1.mp3','Ya2.mp3'][index], activeInLocalModule: true, sha256: hash(Buffer.from(pair[role], 'base64')) })) };
    const saveProof = () => fs.writeFileSync(path.join(directory, 'PROOF.json'), JSON.stringify(proof));
    saveProof();
    assert.equal(readLocalInteractionOverlay(file, fixture).toString(), source);
    fs.appendFileSync(file, '//changed');
    assert.throws(() => readLocalInteractionOverlay(file, fixture), /review does not match/);
    fs.writeFileSync(file, source);
    proof.files[1].sha256 = '0'.repeat(64); saveProof();
    assert.throws(() => readLocalInteractionOverlay(file, fixture), /reviewed original/);
    proof.license.redistributionAuthorizationObtained = true; saveProof();
    assert.throws(() => readLocalInteractionOverlay(file, fixture), /review does not match/);
    assert.throws(() => readLocalInteractionOverlay(path.join(fixture, 'elsewhere.js'), fixture), /reviewed local tmp/);
  } finally {
    assert.ok(path.resolve(fixture).startsWith(path.resolve(os.tmpdir()) + path.sep + 'maid-private-overlay-test-'));
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});
