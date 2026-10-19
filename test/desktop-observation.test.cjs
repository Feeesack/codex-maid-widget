'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DesktopObservationWriter, readDesktopObservation } = require('../src/desktop-observation.cjs');

function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maid-observation-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const identity = { pid: 123, executable: path.resolve('widget.exe'), version: 'test' };
  fs.writeFileSync(path.join(dataDir, 'watcher.json'), JSON.stringify(identity));
  let time = 100000;
  const options = { dataDir, ...identity, now: () => time, isAlive: pid => pid === 123 };
  return { options, file: path.join(dataDir, 'desktop-observation.json'), writer: new DesktopObservationWriter(options), at: value => { time = value; } };
}
const roots = [{ pid: 200, parentPid: 1, sessionId: 12, path: 'D:\\WindowsApps\\OpenAI.Codex_26.1013.3656.0_x64__2p2nqsd0c76g0\\app\\ChatGPT.exe', officialDesktop: true }];

test('widget consumes the live helper inventory and confirmed empty observations', t => {
  const f = fixture(t);
  f.writer.publish({ known: true, roots });
  assert.deepEqual(readDesktopObservation(f.options), { known: true, roots });
  f.writer.publish({ known: true, roots: [] });
  assert.deepEqual(readDesktopObservation(f.options), { known: true, roots: [] });
  assert.equal(fs.existsSync(f.file + '.123.tmp'), false);
});

test('unchanged inventory writes only a heartbeat while changes and errors publish immediately', t => {
  const f = fixture(t);
  f.writer.publish({ known: true, roots });
  f.at(102500); f.writer.publish({ known: true, roots });
  assert.equal(JSON.parse(fs.readFileSync(f.file)).observedAt, 100000);
  f.at(105000); f.writer.publish({ known: true, roots });
  assert.equal(JSON.parse(fs.readFileSync(f.file)).observedAt, 105000);
  f.at(105001); f.writer.publish({ known: false, roots });
  assert.equal(JSON.parse(fs.readFileSync(f.file)).observedAt, 105001);
  assert.equal(readDesktopObservation(f.options).known, false);
});

test('stale, dead, mismatched and malformed observers never claim Codex exited', t => {
  const f = fixture(t);
  f.writer.publish({ known: true, roots: [] });
  const good = fs.readFileSync(f.file, 'utf8');
  f.at(115001); assert.equal(readDesktopObservation(f.options).known, false);
  f.at(99999); assert.equal(readDesktopObservation({ ...f.options, isAlive: () => false }).known, false);
  for (const patch of [{ pid: 999 }, { version: 'old' }, { executable: path.resolve('other.exe') }, { observedAt: 120000 }, { roots: [{ pid: 2, parentPid: 1, path: 'C:\\tools\\codex.exe' }] }]) {
    fs.writeFileSync(f.file, JSON.stringify({ ...JSON.parse(good), ...patch }));
    assert.equal(readDesktopObservation(f.options).known, false);
  }
  fs.writeFileSync(f.file, '{broken'); assert.equal(readDesktopObservation(f.options).known, false);
  fs.unlinkSync(f.file); assert.equal(readDesktopObservation(f.options).known, false);
});
