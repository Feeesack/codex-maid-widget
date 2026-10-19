'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const header = id => JSON.stringify({ type: 'session_meta', payload: { id } });
const compacted = summary => JSON.stringify({ type: 'compacted', payload: { message: summary || 'fixture summary', compaction_response_id: 'fixture-response' } });
const notification = JSON.stringify({ type: 'event_msg', payload: { type: 'context_compacted' } });
const recordType = text => /^\s*\{\s*"type"\s*:\s*"([^"\\]+)"/.exec(text)?.[1] || null;
const sessionIdentity = text => recordType(text) === 'session_meta' ? /"payload"\s*:\s*\{\s*"id"\s*:\s*"([^"\\]+)"/.exec(text)?.[1] || null : null;
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

async function fixture(t, Counter, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'maid-compaction-counter-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.match(path.basename(directory), /^maid-compaction-counter-/);
    await fs.rm(directory, { recursive: true, force: true });
  });
  const calls = { open: 0, read: 0, bytes: 0, close: 0 };
  const filesystem = { async open(filename, mode) {
    assert.equal(path.dirname(filename), directory, 'counter must only open an explicit isolated rollout');
    assert.equal(mode, 'r'); calls.open++;
    const handle = await fs.open(filename, mode);
    return {
      stat: () => handle.stat(),
      async read(...args) { calls.read++; const result = await handle.read(...args); calls.bytes += result.bytesRead; return result; },
      async close() { calls.close++; return handle.close(); },
    };
  } };
  const counter = new Counter({ filesystem, sessionIdentity, recordType, now: () => 0, ...options });
  async function add(id = 'fixture', lines = []) {
    const rolloutPath = path.join(directory, id + '.jsonl');
    await fs.writeFile(rolloutPath, [header(id), ...lines].join('\n') + '\n');
    return { status: 'ready', threadId: id, rolloutPath };
  }
  return { directory, calls, filesystem, counter, add };
}

for (const variant of ['', 'macos/']) {
  const { CompactionCounter } = require(path.join(__dirname, '..', variant, 'src/compaction-counter.cjs'));
  const name = variant ? 'macOS' : 'Windows';

  test(`${name}: counter construction and invalid selections do no IO and idle creates no work`, async t => {
    const f = await fixture(t, CompactionCounter);
    assert.deepEqual(f.calls, { open: 0, read: 0, bytes: 0, close: 0 });
    assert.equal(f.counter.cache.size, 0); assert.equal(f.counter.pending.size, 0);
    for (const selection of [null, {}, { status: 'ready' }, { status: 'unavailable', threadId: 'x', rolloutPath: 'x' }]) {
      assert.deepEqual(await f.counter.read(selection), { status: 'unavailable', reason: 'selection-missing' });
    }
    await new Promise(resolve => setTimeout(resolve, 15));
    assert.equal(f.calls.open, 0);
    const source = await fs.readFile(path.join(__dirname, '..', variant, 'src/compaction-counter.cjs'), 'utf8');
    assert.equal(/\b(?:setInterval|watch|watchFile|createConnection)\s*\(/.test(source), false);
  });

  test(`${name}: zero and exact history survive restart while paired notifications are not double counted`, async t => {
    const f = await fixture(t, CompactionCounter);
    const empty = await f.add('zero');
    assert.deepEqual(await f.counter.read(empty), { status: 'ready', count: 0, complete: true });
    const history = await f.add('history', [notification, compacted(), notification, compacted(), notification]);
    assert.deepEqual(await f.counter.read(history), { status: 'ready', count: 2, complete: true });
    const restarted = new CompactionCounter({ filesystem: f.filesystem, sessionIdentity, recordType, now: () => 0 });
    assert.deepEqual(await restarted.read(history), { status: 'ready', count: 2, complete: true });
    assert.equal(f.calls.close, f.calls.open);
  });

  test(`${name}: repeat and append use an incremental offset without inflating the historical count`, async t => {
    const f = await fixture(t, CompactionCounter);
    const selected = await f.add('incremental', [compacted(), notification]);
    assert.equal((await f.counter.read(selected)).count, 1);
    const firstState = [...f.counter.cache.values()][0];
    const originalOffset = firstState.offset;
    assert.deepEqual(await f.counter.read(selected), { status: 'ready', count: 1, complete: true });
    assert.equal([...f.counter.cache.values()][0].offset, originalOffset);
    await fs.appendFile(selected.rolloutPath, compacted() + '\n' + notification + '\n');
    assert.deepEqual(await f.counter.read(selected), { status: 'ready', count: 2, complete: true });
    assert.ok([...f.counter.cache.values()][0].offset > originalOffset);
    assert.deepEqual(await f.counter.read(selected), { status: 'ready', count: 2, complete: true });
  });

  test(`${name}: multi-megabyte summary and escaped nested content are never parsed or retained`, async t => {
    let largestParsedPrefix = 0;
    const f = await fixture(t, CompactionCounter, { recordType(prefix) { largestParsedPrefix = Math.max(largestParsedPrefix, Buffer.byteLength(prefix)); return recordType(prefix); } });
    const body = 'PRIVATE SYNTHETIC SUMMARY '.repeat(150000);
    const escaped = JSON.stringify({ type: 'response_item', payload: { type: 'message', content: [{ text: compacted() }, { nested: { type: 'compacted' } }] } });
    const selected = await f.add('large', [compacted(body), escaped, notification, compacted()]);
    assert.deepEqual(await f.counter.read(selected), { status: 'ready', count: 2, complete: true });
    assert.ok(largestParsedPrefix <= 4096);
    for (const state of f.counter.cache.values()) {
      assert.ok(state.prefix.length <= 4096);
      assert.equal(JSON.stringify(state).includes('PRIVATE'), false);
    }
  });

  test(`${name}: half-written records commit only at newline across very small read chunks`, async t => {
    const f = await fixture(t, CompactionCounter, { chunkBytes: 7 });
    const selected = await f.add('partial', [compacted()]);
    const half = compacted('halfline fixture');
    await fs.appendFile(selected.rolloutPath, half.slice(0, 24));
    assert.deepEqual(await f.counter.read(selected), { status: 'ready', count: 1, complete: false });
    await fs.appendFile(selected.rolloutPath, half.slice(24));
    assert.deepEqual(await f.counter.read(selected), { status: 'ready', count: 1, complete: false });
    await fs.appendFile(selected.rolloutPath, '\n');
    assert.deepEqual(await f.counter.read(selected), { status: 'ready', count: 2, complete: true });
  });

  test(`${name}: modern checkpoints require a direct nonempty response ID while reset and nested IDs are excluded`, async t => {
    const f = await fixture(t, CompactionCounter);
    const lines = [
      JSON.stringify({ type: 'compacted', payload: { message: 'reset summary', compaction_response_id: null } }),
      JSON.stringify({ type: 'compacted', payload: { message: 'reset summary', compaction_response_id: '' } }),
      JSON.stringify({ type: 'compacted', payload: { message: '', compaction_response_id: 'fixture-response', replacement_history: [{ compaction_response_id: 'nested' }] } }),
      JSON.stringify({ type: 'compacted', payload: { message: '', compaction_response_id: 'fixture-response' } }),
      JSON.stringify({ type: 'response_item', payload: { compaction_response_id: 'spoofed', type: 'compacted' } }),
      notification,
    ];
    const selected = await f.add('modern', lines);
    assert.deepEqual(await f.counter.read(selected), { status: 'ready', count: 2, complete: true });
  });

  test(`${name}: legacy checkpoints and nested-only response IDs expose a confirmed lower bound`, async t => {
    const f = await fixture(t, CompactionCounter);
    const legacy = JSON.stringify({ type: 'compacted', payload: { message: 'legacy summary' } });
    const nested = JSON.stringify({ type: 'compacted', payload: { message: '', replacement_history: [{ compaction_response_id: 'not-direct' }] } });
    const selected = await f.add('legacy', [legacy, nested]);
    assert.deepEqual(await f.counter.read(selected), { status: 'ready', count: 0, complete: false, incompleteReason: 'legacy-records' });
    await fs.appendFile(selected.rolloutPath, compacted() + '\n');
    assert.deepEqual(await f.counter.read(selected), { status: 'ready', count: 1, complete: false, incompleteReason: 'legacy-records' });
    assert.deepEqual(await f.counter.read(selected), { status: 'ready', count: 1, complete: false, incompleteReason: 'legacy-records' });
  });

  test(`${name}: malformed compacted JSON with a newline never counts as a committed checkpoint`, async t => {
    const f = await fixture(t, CompactionCounter);
    const selected = await f.add('malformed', ['{"type":"compacted","payload":{"compaction_response_id":"fixture-response","message":"unfinished']);
    const result = await f.counter.read(selected);
    assert.equal(result.status, 'unavailable'); assert.equal(result.count, undefined);
  });

  test(`${name}: byte-limited partial scans return lower bounds and resume to the exact result`, async t => {
    const f = await fixture(t, CompactionCounter, { maxBytes: 90, chunkBytes: 17 });
    const selected = await f.add('bounded', Array.from({ length: 14 }, (_, index) => compacted('fixture ' + index)));
    let previousCount = -1, previousOffset = 0, final;
    for (let attempt = 0; attempt < 30; attempt++) {
      const result = await f.counter.read(selected);
      assert.equal(result.status, 'ready'); assert.ok(result.count >= previousCount && result.count <= 14);
      const state = [...f.counter.cache.values()][0];
      assert.ok(state.offset - previousOffset <= 90);
      previousCount = result.count; previousOffset = state.offset;
      if (result.complete) { final = result; break; }
    }
    assert.deepEqual(final, { status: 'ready', count: 14, complete: true });
    assert.deepEqual(await f.counter.read(selected), final);
  });

  test(`${name}: elapsed work budget yields a partial result then a later click resumes`, async t => {
    let clock = 0;
    const f = await fixture(t, CompactionCounter, { chunkBytes: 64, budgetMs: 2, now: () => clock++ });
    const selected = await f.add('budget', Array.from({ length: 10 }, () => compacted()));
    const first = await f.counter.read(selected);
    assert.equal(first.status, 'ready'); assert.equal(first.complete, false);
    f.counter.now = () => 0;
    assert.deepEqual(await f.counter.read(selected), { status: 'ready', count: 10, complete: true });
  });

  test(`${name}: defaults cap scan bytes, chunk size, time and cache entries`, async t => {
    const f = await fixture(t, CompactionCounter);
    assert.equal(f.counter.maxBytes, 16 * 1024 * 1024);
    assert.equal(f.counter.chunkBytes, 256 * 1024);
    assert.equal(f.counter.budgetMs, 250); assert.equal(f.counter.timeoutMs, 750);
    assert.equal(f.counter.maxEntries, 8);
    const capped = new CompactionCounter({ filesystem: f.filesystem, sessionIdentity, recordType,
      maxBytes: 1024 * 1024 * 1024, chunkBytes: 1024 * 1024, maxEntries: 1000 });
    assert.equal(capped.maxBytes, 16 * 1024 * 1024);
    assert.equal(capped.chunkBytes, 256 * 1024); assert.equal(capped.maxEntries, 8);
  });

  test(`${name}: unsupported metadata never produces a misleading exact historical count`, async t => {
    const f = await fixture(t, CompactionCounter);
    const selected = await f.add('unsupported', [compacted(), 'PRIVATE UNRECOGNIZED RECORD']);
    assert.deepEqual(await f.counter.read(selected), { status: 'unavailable', reason: 'record-format-unsupported' });
    assert.equal(f.counter.cache.size, 0);
    const empty = { ...selected, rolloutPath: path.join(f.directory, 'empty.jsonl') };
    await fs.writeFile(empty.rolloutPath, '');
    assert.deepEqual(await f.counter.read(empty), { status: 'unavailable', reason: 'rollout-missing' });
  });

  test(`${name}: the cache is bounded to eight entries and recently used history survives LRU eviction`, async t => {
    const f = await fixture(t, CompactionCounter);
    const selections = [];
    for (let index = 0; index < 8; index++) { selections.push(await f.add('history-' + index, [compacted()])); await f.counter.read(selections[index]); }
    await f.counter.read(selections[0]);
    const ninth = await f.add('history-8', [compacted(), compacted()]);
    await f.counter.read(ninth);
    assert.equal(f.counter.cache.size, 8);
    assert.ok(f.counter.cache.has(selections[0].threadId + '\0' + selections[0].rolloutPath));
    assert.equal(f.counter.cache.has(selections[1].threadId + '\0' + selections[1].rolloutPath), false);
    assert.deepEqual(await f.counter.read(selections[1]), { status: 'ready', count: 1, complete: true });
    assert.equal(f.counter.cache.size, 8);
  });

  test(`${name}: truncation and replacement rebuild rather than retaining an old historical count`, async t => {
    const f = await fixture(t, CompactionCounter);
    const selected = await f.add('replace', [compacted(), compacted(), compacted()]);
    assert.equal((await f.counter.read(selected)).count, 3);
    await fs.writeFile(selected.rolloutPath, header('replace') + '\n' + compacted() + '\n');
    assert.deepEqual(await f.counter.read(selected), { status: 'ready', count: 1, complete: true });
    await fs.rename(selected.rolloutPath, path.join(f.directory, 'retained-before.jsonl'));
    await fs.writeFile(selected.rolloutPath, header('replace') + '\n');
    assert.deepEqual(await f.counter.read(selected), { status: 'ready', count: 0, complete: true });
  });

  test(`${name}: session mismatch and filesystem failures never return an old cached number or raw error`, async t => {
    const f = await fixture(t, CompactionCounter);
    const selected = await f.add('identity', [compacted()]);
    assert.equal((await f.counter.read(selected)).count, 1);
    await fs.writeFile(selected.rolloutPath, header('some-other-thread') + '\n' + compacted() + '\n');
    assert.deepEqual(await f.counter.read(selected), { status: 'unavailable', reason: 'session-mismatch' });
    f.counter.fs = { open: async () => { throw new Error('PRIVATE AUTH FIXTURE PATH'); } };
    const result = await f.counter.read(selected);
    assert.deepEqual(result, { status: 'unavailable', reason: 'compaction-unavailable' });
    assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
  });

  test(`${name}: a hanging read times out, coalesces requests and never commits a late cache state`, async t => {
    const f = await fixture(t, CompactionCounter, { timeoutMs: 25 });
    const selected = await f.add('timeout', [compacted()]);
    const entered = deferred(), release = deferred(), closed = deferred();
    f.counter.fs = { async open(filename, mode) {
      const handle = await fs.open(filename, mode);
      let first = true;
      return { stat: () => handle.stat(), async read(...args) {
        if (first) { first = false; entered.resolve(); await release.promise; }
        return handle.read(...args);
      }, async close() { await handle.close(); closed.resolve(); } };
    } };
    const first = f.counter.read(selected), coalesced = f.counter.read(selected);
    assert.equal(first, coalesced);
    await entered.promise;
    assert.deepEqual(await first, { status: 'unavailable', reason: 'compaction-timeout' });
    assert.equal(f.counter.pending.size, 0); assert.equal(f.counter.cache.size, 0);
    release.resolve(); await closed.promise;
    assert.equal(f.counter.cache.size, 0, 'expired IO may finish but cannot publish a cache entry');
    f.counter.fs = f.filesystem;
    assert.deepEqual(await f.counter.read(selected), { status: 'ready', count: 1, complete: true });
  });
}

test('compaction counter mirrors are identical', async () => {
  assert.equal(await fs.readFile(path.join(__dirname, '../src/compaction-counter.cjs'), 'utf8'),
    await fs.readFile(path.join(__dirname, '../macos/src/compaction-counter.cjs'), 'utf8'));
});
