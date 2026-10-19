'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function fixture(t, ConversationTarget, overrides = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'maid-conversation-target-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.match(path.basename(directory), /^maid-conversation-target-/);
    await fs.rm(directory, { recursive: true, force: true });
  });
  const profile = path.join(directory, 'isolated-maid');
  const modeFile = path.join(profile, 'conversation-mode.json');
  const selectionFile = path.join(profile, 'conversation-selection.json');
  await fs.mkdir(profile);
  await fs.writeFile(selectionFile, JSON.stringify({ version: 1, selectedId: 'remembered' }));
  const io = [], calls = { list: 0, select: [], resolve: 0, resolveId: [], detector: 0 };
  let selectedId = 'remembered';
  const checked = id => ({ status: 'ready', threadId: id, cwd: path.join(directory, 'workspace'),
    rolloutPath: path.join(directory, 'isolated-codex', 'sessions', id + '.jsonl'), title: 'Fixture title' });
  const reader = {
    async list() { calls.list++; return { status: 'ready', selectedId, threads: [{ id: selectedId, title: 'Fixture title', workspaceLabel: 'workspace' }] }; },
    async select(id) {
      calls.select.push(id); selectedId = id;
      await fs.writeFile(selectionFile, JSON.stringify({ version: 1, selectedId: id }));
      return { status: 'ready', selectedId: id };
    },
    async resolve() { calls.resolve++; return checked(selectedId); },
    async resolveId(id) { calls.resolveId.push(id); return checked(id); },
  };
  const detector = { async resolve() { calls.detector++; return { status: 'ready', threadId: 'visible', versionKey: 'window-a' }; } };
  const filesystem = {
    async open(file, flags) {
      io.push(['open', file, flags]);
      assert.equal(file, modeFile, 'facade may read only its own isolated mode file');
      assert.equal(flags, 'r');
      return fs.open(file, flags);
    },
    async mkdir(file, options) { io.push(['mkdir', file]); assert.equal(file, profile); return fs.mkdir(file, options); },
    async writeFile(file, ...args) { io.push(['writeFile', file]); assert.equal(path.dirname(file), profile); assert.ok(file.startsWith(modeFile + '.')); return fs.writeFile(file, ...args); },
    async rename(from, to) { io.push(['rename', to]); assert.equal(path.dirname(from), profile); assert.ok(from.startsWith(modeFile + '.')); assert.equal(to, modeFile); return fs.rename(from, to); },
    async unlink(file) { io.push(['unlink', file]); assert.equal(path.dirname(file), profile); assert.ok(file.startsWith(modeFile + '.')); return fs.unlink(file); },
  };
  const target = new ConversationTarget({ reader, detector, modeFile, filesystem, ...overrides });
  return { directory, profile, modeFile, selectionFile, reader, detector, filesystem, target, calls, io, checked };
}

for (const variant of ['', 'macos/']) {
  const { ConversationTarget } = require(path.join(__dirname, '..', variant, 'src/conversation-target.cjs'));
  const { ConversationReader } = require(path.join(__dirname, '..', variant, 'src/conversation-reader.cjs'));
  const name = variant ? 'macOS' : 'Windows';

  test(`${name}: target construction is lazy and upgrades to auto without changing remembered manual selection`, async t => {
    const f = await fixture(t, ConversationTarget);
    const remembered = await fs.readFile(f.selectionFile);
    assert.deepEqual(f.io, []);
    assert.deepEqual(f.calls, { list: 0, select: [], resolve: 0, resolveId: [], detector: 0 });
    assert.equal(await f.target.load(), 'auto');
    assert.deepEqual(await fs.readFile(f.selectionFile), remembered);
    assert.equal(await fs.stat(f.modeFile).then(() => true, () => false), false);
    assert.deepEqual(f.io.map(item => item[0]), ['open']);
  });

  test(`${name}: list reads chooser metadata without detecting or resolving the current window`, async t => {
    const f = await fixture(t, ConversationTarget);
    const result = await f.target.list();
    assert.equal(result.selectionMode, 'auto'); assert.equal(result.selectedId, 'remembered');
    assert.equal(f.calls.list, 1); assert.equal(f.calls.detector, 0);
    assert.equal(f.calls.resolve, 0); assert.deepEqual(f.calls.resolveId, []);
    assert.deepEqual(f.io.map(item => item[0]), ['open']);
  });

  test(`${name}: auto resolves only the detected ID and never writes a manual choice`, async t => {
    const f = await fixture(t, ConversationTarget);
    const remembered = await fs.readFile(f.selectionFile);
    const result = await f.target.resolve();
    assert.equal(result.threadId, 'visible'); assert.equal(result.selectionMode, 'auto');
    assert.equal(f.calls.detector, 1); assert.deepEqual(f.calls.resolveId, ['visible']);
    assert.equal(f.calls.resolve, 0); assert.deepEqual(f.calls.select, []);
    assert.deepEqual(await fs.readFile(f.selectionFile), remembered);
    assert.deepEqual(f.io.map(item => item[0]), ['open']);
    assert.equal(await fs.stat(f.modeFile).then(() => true, () => false), false);
  });

  test(`${name}: unknown, invalid and missing-database auto targets never fall back to remembered or recent threads`, async t => {
    const f = await fixture(t, ConversationTarget);
    const actualReader = new ConversationReader({ codexHome: path.join(f.directory, 'absent-isolated-codex'), selectionFile: f.selectionFile });
    actualReader.resolve = () => { throw new Error('Automatic mode must not read remembered choice'); };
    actualReader.list = () => { throw new Error('Automatic mode must not guess recent threads'); };
    for (const active of [{ status: 'unavailable' }, { status: 'ready', threadId: '../invalid' }, { status: 'ready', threadId: 'valid-but-no-database' }]) {
      const target = new ConversationTarget({ reader: actualReader, detector: { resolve: async () => active },
        modeFile: f.modeFile, filesystem: f.filesystem });
      const result = await target.resolve();
      assert.equal(result.status, 'unavailable'); assert.equal(result.selectionMode, 'auto');
      assert.equal(result.threadId, undefined);
    }
    assert.equal(JSON.parse(await fs.readFile(f.selectionFile, 'utf8')).selectedId, 'remembered');
    assert.equal(await fs.stat(path.join(f.directory, 'absent-isolated-codex')).then(() => true, () => false), false);
  });

  test(`${name}: manual then auto persists mode across restarts while retaining the last manual selection`, async t => {
    const f = await fixture(t, ConversationTarget);
    const manualSelection = await fs.readFile(f.selectionFile);
    assert.deepEqual(await f.target.select('picked'), { selectedId: 'picked', selectionMode: 'manual' });
    assert.deepEqual(JSON.parse(await fs.readFile(f.modeFile, 'utf8')), { version: 1, mode: 'manual', selectedId: 'picked' });
    assert.deepEqual(await fs.readFile(f.selectionFile), manualSelection, 'new selections must not overwrite the legacy selection file');
    const manualRestart = new ConversationTarget({ reader: f.reader, detector: f.detector, modeFile: f.modeFile, filesystem: f.filesystem });
    const manual = await manualRestart.resolve();
    assert.equal(manual.selectionMode, 'manual'); assert.equal(manual.threadId, 'picked');
    assert.equal(f.calls.detector, 0);
    assert.equal(f.calls.resolve, 0, 'a saved facade ID resolves without reading the old remembered choice');
    assert.deepEqual(await manualRestart.select(null), { selectedId: null, selectionMode: 'auto' });
    assert.deepEqual(await fs.readFile(f.selectionFile), manualSelection);
    assert.deepEqual(f.calls.select, []);
    assert.deepEqual(JSON.parse(await fs.readFile(f.modeFile, 'utf8')), { version: 1, mode: 'auto', selectedId: 'picked' });
    const autoRestart = new ConversationTarget({ reader: f.reader, detector: f.detector, modeFile: f.modeFile, filesystem: f.filesystem });
    assert.equal((await autoRestart.resolve()).threadId, 'visible');
    assert.deepEqual(await fs.readFile(f.selectionFile), manualSelection);
    assert.deepEqual((await fs.readdir(f.profile)).sort(), ['conversation-mode.json', 'conversation-selection.json']);
  });

  test(`${name}: a mode switch invalidates an older pending automatic resolution`, async t => {
    const f = await fixture(t, ConversationTarget);
    const entered = deferred(), finish = deferred();
    f.detector.resolve = async () => { entered.resolve(); return finish.promise; };
    const old = f.target.resolve();
    await entered.promise;
    const epoch = f.target.epoch;
    await f.target.select('picked');
    assert.ok(f.target.epoch > epoch);
    const beforeLateCompletion = await f.target.resolve();
    finish.resolve({ status: 'ready', threadId: 'old-visible', versionKey: 'old-window' });
    const stale = await old;
    assert.equal(stale.status, 'unavailable'); assert.equal(stale.threadId, undefined);
    assert.equal(stale.selectionMode, 'manual');
    assert.equal(stale.selectionRevision, beforeLateCompletion.selectionRevision);
    const current = await f.target.resolve();
    assert.equal(current.threadId, 'picked'); assert.equal(current.selectionMode, 'manual');
    assert.equal(current.selectionRevision, beforeLateCompletion.selectionRevision, 'an obsolete resolve must not mutate the current signature or revision');
  });

  test(`${name}: rejected atomic rename preserves the old mode and ID in memory and on restart`, async t => {
    const f = await fixture(t, ConversationTarget);
    const legacy = await fs.readFile(f.selectionFile);
    await f.target.select('picked');
    const stored = await fs.readFile(f.modeFile);
    f.target.fs = { ...f.filesystem, rename: async () => { throw new Error('Isolated injected rename failure'); } };
    await assert.rejects(f.target.select('rejected'));
    assert.equal(f.target.mode, 'manual'); assert.equal(f.target.selectedId, 'picked');
    assert.equal((await f.target.resolve()).threadId, 'picked');
    assert.deepEqual(await fs.readFile(f.modeFile), stored);
    assert.deepEqual(await fs.readFile(f.selectionFile), legacy);
    assert.deepEqual(f.calls.select, []);
    const restarted = new ConversationTarget({ reader: f.reader, detector: f.detector, modeFile: f.modeFile, filesystem: f.filesystem });
    assert.equal((await restarted.resolve()).threadId, 'picked');
    assert.deepEqual((await fs.readdir(f.profile)).sort(), ['conversation-mode.json', 'conversation-selection.json']);
  });

  test(`${name}: a rejected first manual save keeps automatic mode and leaves no new preference file`, async t => {
    const f = await fixture(t, ConversationTarget);
    const legacy = await fs.readFile(f.selectionFile);
    f.target.fs = { ...f.filesystem, rename: async () => { throw new Error('Isolated injected rename failure'); } };
    await assert.rejects(f.target.select('rejected'));
    assert.equal(f.target.mode, 'auto'); assert.equal(f.target.selectedId, null);
    assert.equal((await f.target.resolve()).threadId, 'visible');
    assert.deepEqual(await fs.readFile(f.selectionFile), legacy);
    assert.deepEqual(f.calls.select, []);
    assert.deepEqual(await fs.readdir(f.profile), ['conversation-selection.json']);
  });

  test(`${name}: a missing validated ID cannot alter an existing atomic selection`, async t => {
    const f = await fixture(t, ConversationTarget);
    await f.target.select('picked');
    const stored = await fs.readFile(f.modeFile), legacy = await fs.readFile(f.selectionFile);
    f.reader.resolveId = async id => id === 'missing' ? { status: 'unavailable', reason: 'selection-expired' } : f.checked(id);
    await assert.rejects(f.target.select('missing'));
    assert.equal(f.target.mode, 'manual'); assert.equal(f.target.selectedId, 'picked');
    assert.deepEqual(await fs.readFile(f.modeFile), stored);
    assert.deepEqual(await fs.readFile(f.selectionFile), legacy);
    assert.equal((await f.target.resolve()).threadId, 'picked');
  });

  test(`${name}: old manual mode records still resolve the untouched legacy choice`, async t => {
    const f = await fixture(t, ConversationTarget);
    await fs.writeFile(f.modeFile, JSON.stringify({ version: 1, mode: 'manual' }));
    const legacy = await fs.readFile(f.selectionFile);
    const result = await f.target.resolve();
    assert.equal(result.threadId, 'remembered'); assert.equal(result.selectionMode, 'manual');
    assert.equal(f.calls.resolve, 1); assert.deepEqual(f.calls.resolveId, []);
    assert.deepEqual(f.calls.select, []); assert.equal(f.calls.detector, 0);
    assert.deepEqual(await fs.readFile(f.selectionFile), legacy);
  });

  test(`${name}: a persisted manual choice outside the latest 30 is added using safe metadata only`, async t => {
    const f = await fixture(t, ConversationTarget);
    await f.target.select('picked');
    f.reader.list = async () => ({ status: 'ready', selectedId: 'remembered',
      threads: Array.from({ length: 30 }, (_, index) => ({ id: 'recent-' + index, title: 'Fixture recent', workspaceLabel: 'workspace' })) });
    const listed = await f.target.list();
    assert.equal(listed.selectionMode, 'manual'); assert.equal(listed.selectedId, 'picked');
    assert.equal(listed.threads.length, 30); assert.equal(listed.threads[0].id, 'picked');
    assert.equal(listed.threads[0].title, 'Fixture title');
    assert.equal(listed.threads.some(thread => 'cwd' in thread || 'rolloutPath' in thread), false);
    assert.equal(f.calls.detector, 0); assert.deepEqual(f.calls.select, []);
    const legacy = JSON.parse(await fs.readFile(f.selectionFile, 'utf8'));
    assert.equal(legacy.selectedId, 'remembered');
  });

  test(`${name}: revisions are stable for the same target and advance with window identity or metadata`, async t => {
    const f = await fixture(t, ConversationTarget);
    let windowKey = 'window-a', rolloutSuffix = '';
    f.detector.resolve = async () => ({ status: 'ready', threadId: 'visible', versionKey: windowKey });
    f.reader.resolveId = async id => ({ ...f.checked(id), rolloutPath: f.checked(id).rolloutPath + rolloutSuffix });
    const first = await f.target.resolve(), same = await f.target.resolve();
    assert.equal(first.selectionRevision, same.selectionRevision); assert.equal(f.target.epoch, 0);
    windowKey = 'window-b';
    const otherWindow = await f.target.resolve();
    assert.ok(otherWindow.selectionRevision > same.selectionRevision);
    assert.equal((await f.target.resolve()).selectionRevision, otherWindow.selectionRevision);
    rolloutSuffix = '.replaced';
    assert.ok((await f.target.resolve()).selectionRevision > otherWindow.selectionRevision);
    const epoch = f.target.epoch;
    await f.target.select(null);
    assert.ok(f.target.epoch > epoch);
  });

  test(`${name}: loading reads only its own bounded regular mode file and closes every handle`, async t => {
    const f = await fixture(t, ConversationTarget);
    for (const scenario of [
      { size: 5000, regular: true, text: '' },
      { size: 10, regular: false, text: '' },
      { text: '{malformed' },
      { text: JSON.stringify({ version: 2, mode: 'manual' }) },
      { text: JSON.stringify({ version: 1, mode: 'unknown' }) },
      { text: JSON.stringify({ version: 1, mode: 'manual' }), expected: 'manual' },
    ]) {
      let opens = 0, reads = 0, closes = 0;
      const text = Buffer.from(scenario.text);
      const filesystem = { async open(file, flags) {
        opens++; assert.equal(file, f.modeFile); assert.equal(flags, 'r');
        return {
          async stat() { return { size: scenario.size ?? text.length, isFile: () => scenario.regular !== false }; },
          async read(buffer, offset, length) { reads++; assert.ok(length <= 4096); text.copy(buffer, offset, 0, length); return { bytesRead: Math.min(length, text.length) }; },
          async close() { closes++; },
        };
      } };
      const target = new ConversationTarget({ reader: f.reader, detector: f.detector, modeFile: f.modeFile, filesystem });
      assert.equal(await target.load(), scenario.expected || 'auto');
      assert.equal(await target.load(), scenario.expected || 'auto');
      assert.equal(opens, 1); assert.equal(closes, 1);
      assert.equal(reads, scenario.size > 4096 || scenario.regular === false ? 0 : 1);
    }
    assert.equal(f.calls.detector, 0); assert.equal(f.calls.resolve, 0);
  });
}

test('conversation target mirrors are identical', async () => {
  assert.equal(await fs.readFile(path.join(__dirname, '../src/conversation-target.cjs'), 'utf8'),
    await fs.readFile(path.join(__dirname, '../macos/src/conversation-target.cjs'), 'utf8'));
});
