'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { DatabaseSync } = require('node:sqlite');
const { ConversationReader } = require('../src/conversation-reader.cjs');

const metadata = (id, extra = {}) => JSON.stringify({ timestamp: '2026-10-18T12:00:00Z', type: 'session_meta', payload: { id, ...extra } });
const usage = (used, window = 200000, total = 9000000) => JSON.stringify({
  timestamp: '2026-10-18T12:00:01Z', type: 'event_msg', payload: {
    type: 'token_count', info: { last_token_usage: { total_tokens: used }, model_context_window: window, total_token_usage: { total_tokens: total } },
  },
});

async function fixture(t, { schema = 'modern', version = 5 } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'maid-conversation-reader-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const codexHome = path.join(root, 'isolated-codex');
  const maidData = path.join(root, 'isolated-maid');
  const workspace = path.join(root, 'fixture-workspace');
  const selectionFile = path.join(maidData, 'conversation-selection.json');
  await Promise.all(['sessions', 'archived_sessions'].map(name => fs.mkdir(path.join(codexHome, name), { recursive: true })));
  await fs.mkdir(workspace);
  const database = path.join(codexHome, `state_${version}.sqlite`);
  const db = new DatabaseSync(database);
  if (schema === 'modern') db.exec(`CREATE TABLE threads (
    id TEXT PRIMARY KEY, title TEXT, name TEXT, cwd TEXT, rollout_path TEXT,
    source TEXT, thread_source TEXT, agent_role TEXT, updated_at INTEGER,
    updated_at_ms INTEGER, archived INTEGER, preview TEXT, first_user_message TEXT
  )`);
  else db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, cwd TEXT, rollout_path TEXT, title TEXT, updated_at INTEGER)');
  db.close();
  const reader = new ConversationReader({ codexHome, selectionFile });
  async function add(id = 'thread-main', values = {}, lines = [metadata(id), usage(50000)]) {
    const rollout = values.rollout_path || path.join(codexHome, 'sessions', `rollout-${id}.jsonl`);
    if (lines !== null) {
      await fs.mkdir(path.dirname(rollout), { recursive: true });
      await fs.writeFile(rollout, Array.isArray(lines) ? `${lines.join('\n')}\n` : lines);
    }
    const row = schema === 'modern' ? {
      id, title: `Fixture ${id}`, name: null, cwd: workspace, rollout_path: rollout,
      source: 'cli', thread_source: null, agent_role: null, updated_at: 1000, updated_at_ms: null, archived: 0,
      preview: 'PRIVATE FIXTURE PREVIEW MUST NOT BE RETURNED', first_user_message: 'PRIVATE FIXTURE BODY MUST NOT BE RETURNED', ...values,
    } : { id, title: `Fixture ${id}`, cwd: workspace, rollout_path: rollout, updated_at: 1000, ...values };
    const connection = new DatabaseSync(database);
    try { connection.prepare(`INSERT INTO threads (${Object.keys(row).join(',')}) VALUES (${Object.keys(row).map(() => '?').join(',')})`).run(...Object.values(row)); }
    finally { connection.close(); }
    return rollout;
  }
  return { root, codexHome, maidData, workspace, database, selectionFile, reader, add };
}

test('construction and unresolved selection are lazy and never choose a recent thread automatically', async t => {
  const data = await fixture(t);
  await data.add();
  assert.deepEqual(await data.reader.resolve(), { status: 'unavailable', reason: 'selection-missing' });
  assert.equal(await fs.stat(data.maidData).then(() => true, () => false), false);
  const missing = path.join(data.root, 'not-created');
  new ConversationReader({ codexHome: missing, selectionFile: path.join(data.root, 'other-maid', 'selection.json') });
  assert.equal(await fs.stat(missing).then(() => true, () => false), false);
  assert.throws(() => new ConversationReader({ codexHome: data.codexHome, selectionFile: path.join(data.codexHome, 'forbidden.json') }));
});

test('list returns 30 recent local main threads, excludes agents/archive/remote, and exposes only chooser metadata', async t => {
  const data = await fixture(t);
  for (let index = 0; index < 35; index++) await data.add(`thread-${index}`, { updated_at_ms: 1000000 + index });
  await data.add('agent', { source: '{"subagent":{"thread_spawn":{}}}', updated_at_ms: 99999999 });
  await data.add('agent-role', { agent_role: 'worker', updated_at_ms: 99999999 });
  await data.add('agent-source', { thread_source: 'subAgent', updated_at_ms: 99999999 });
  await data.add('archive', { archived: 1, updated_at_ms: 99999999 });
  await data.add('remote', { source: 'cloud', updated_at_ms: 99999999 });
  const before = await fs.readFile(data.database);
  const listed = await data.reader.list();
  assert.equal(listed.status, 'ready');
  assert.equal(listed.selectedId, null);
  assert.equal(listed.threads.length, 30);
  assert.equal(listed.threads[0].id, 'thread-34');
  assert.equal(listed.threads[29].id, 'thread-5');
  for (const thread of listed.threads) assert.deepEqual(Object.keys(thread), ['id', 'title', 'workspaceLabel']);
  assert.equal(JSON.stringify(listed).includes('PRIVATE'), false);
  assert.equal(listed.threads[0].workspaceLabel, 'fixture-workspace');
  assert.deepEqual(await fs.readFile(data.database), before, 'metadata reads must not write the Codex database');
});

test('selection is revalidated, persisted only in explicit Maid storage, and survives a new reader', async t => {
  const data = await fixture(t);
  const rollout = await data.add('chosen', { name: 'User title', title: 'Fallback title' });
  await data.add('newer', { updated_at: 2000 });
  await assert.rejects(data.reader.select('not-listed'), { code: 'selection-expired' });
  await assert.rejects(data.reader.select("bad' OR 1=1"), { code: 'selection-missing' });
  assert.deepEqual(await data.reader.select('chosen'), { status: 'ready', selectedId: 'chosen' });
  assert.deepEqual(JSON.parse(await fs.readFile(data.selectionFile, 'utf8')), { version: 1, selectedId: 'chosen' });
  const restored = new ConversationReader({ codexHome: data.codexHome, selectionFile: data.selectionFile });
  assert.equal((await restored.list()).selectedId, 'chosen');
  assert.equal((await restored.list()).threads.find(thread => thread.id === 'chosen').title, 'User title');
  assert.deepEqual(await restored.resolve(), { status: 'ready', threadId: 'chosen', cwd: data.workspace, rolloutPath: await fs.realpath(rollout) });
});

test('resolveId returns checked local metadata and safe title without choosing or persisting a thread', async t => {
  const data = await fixture(t);
  const rollout = await data.add('observed', { name: ' Safe\nTitle\u0000 ', title: 'Fallback' });
  const before = await fs.readFile(data.database);
  assert.deepEqual(await data.reader.resolveId('observed'), {
    status: 'ready', threadId: 'observed', cwd: data.workspace,
    rolloutPath: await fs.realpath(rollout), title: 'Safe Title',
  });
  assert.equal(data.reader.selectedId, null);
  assert.equal(data.reader.selectionLoaded, false);
  assert.equal(await fs.stat(data.maidData).then(() => true, () => false), false);
  assert.deepEqual(await fs.readFile(data.database), before);
  assert.deepEqual(await data.reader.resolve(), { status: 'unavailable', reason: 'selection-missing' });
});

test('resolveId leaves an existing manual selection and its file unchanged', async t => {
  const data = await fixture(t);
  await data.add('manual');
  await data.add('observed');
  await data.reader.select('manual');
  const before = await fs.readFile(data.selectionFile);
  assert.equal((await data.reader.resolveId('observed')).threadId, 'observed');
  assert.equal((await data.reader.resolve()).threadId, 'manual');
  assert.deepEqual(await fs.readFile(data.selectionFile), before);
  const restored = new ConversationReader({ codexHome: data.codexHome, selectionFile: data.selectionFile });
  assert.equal((await restored.resolve()).threadId, 'manual');
});

test('resolveId rejects invalid IDs before metadata IO and reports missing valid IDs', async t => {
  const data = await fixture(t);
  let metadataReads = 0;
  const reader = new ConversationReader({ codexHome: data.codexHome, selectionFile: data.selectionFile,
    filesystem: { ...fs, readdir: async () => { metadataReads++; throw new Error('Invalid ID must not read metadata'); } } });
  for (const id of [null, undefined, '', '../escape', "bad' OR 1=1", 'x'.repeat(201), {}]) {
    assert.deepEqual(await reader.resolveId(id), { status: 'unavailable', reason: 'selection-missing' });
  }
  assert.equal(metadataReads, 0);
  assert.deepEqual(await data.reader.resolveId('valid-but-missing'), { status: 'unavailable', reason: 'selection-expired' });
  assert.equal(await fs.stat(data.maidData).then(() => true, () => false), false);
});

test('a valid selected thread remains in the chooser after falling outside the latest 30', async t => {
  const data = await fixture(t);
  await data.add('chosen');
  await data.reader.select('chosen');
  for (let index = 0; index < 32; index++) await data.add(`newer-${index}`, { updated_at: 2000 + index });
  const listed = await data.reader.list();
  assert.equal(listed.threads.length, 30);
  assert.equal(listed.threads[0].id, 'chosen');
  assert.equal(listed.selectedId, 'chosen');
});

test('missing/damaged widget preferences and an expired selected record remain unknown', async t => {
  const data = await fixture(t);
  await data.add();
  await fs.mkdir(data.maidData);
  await fs.writeFile(data.selectionFile, '{bad json');
  assert.equal((await data.reader.resolve()).reason, 'selection-missing');
  await data.reader.select('thread-main');
  const db = new DatabaseSync(data.database);
  db.exec('DELETE FROM threads'); db.close();
  assert.equal((await data.reader.resolve()).reason, 'selection-expired');
  assert.equal((await data.reader.list()).selectedId, null);
});

test('preference write failure does not change the existing selection', async t => {
  const data = await fixture(t);
  await data.add();
  await fs.mkdir(data.maidData);
  await fs.writeFile(path.join(data.maidData, 'not-a-directory'), 'fixture');
  const reader = new ConversationReader({ codexHome: data.codexHome, selectionFile: path.join(data.maidData, 'not-a-directory', 'selection.json') });
  await assert.rejects(reader.select('thread-main'), { code: 'selection-save-failed' });
  assert.equal((await reader.resolve()).reason, 'selection-missing');
});

test('minimal legacy schema remains readable without optional columns', async t => {
  const data = await fixture(t, { schema: 'legacy' });
  await data.add();
  assert.equal((await data.reader.list()).threads.length, 1);
  assert.equal((await data.reader.select('thread-main')).status, 'ready');
  assert.equal((await data.reader.resolve()).status, 'ready');
});

test('newest numeric state version is authoritative; a corrupt latest database never falls back to stale records', async t => {
  const data = await fixture(t, { version: 9 });
  await data.add('old-thread');
  const modern = new DatabaseSync(path.join(data.codexHome, 'state_10.sqlite'));
  modern.exec('CREATE TABLE threads (id TEXT, cwd TEXT, rollout_path TEXT)'); modern.close();
  assert.deepEqual((await data.reader.list()).threads, []);
  await fs.writeFile(path.join(data.codexHome, 'state_11.sqlite'), 'corrupt fixture');
  assert.equal((await data.reader.list()).status, 'unavailable');
  const unsupported = new DatabaseSync(path.join(data.codexHome, 'state_12.sqlite'));
  unsupported.exec('CREATE TABLE threads (id TEXT)'); unsupported.close();
  assert.equal((await data.reader.list()).reason, 'local-schema-unsupported');
});

test('missing database and locked metadata fail without altering any Codex files', async t => {
  const data = await fixture(t);
  await data.add();
  const lock = new DatabaseSync(data.database);
  lock.exec('BEGIN EXCLUSIVE');
  const result = await data.reader.list();
  assert.equal(result.status, 'unavailable');
  lock.exec('ROLLBACK'); lock.close();
  assert.equal((await data.reader.list()).threads.length, 1);
  const absent = new ConversationReader({ codexHome: path.join(data.root, 'missing-codex'), selectionFile: path.join(data.root, 'missing-maid', 'selection.json') });
  assert.equal((await absent.list()).reason, 'no-local-data');
});

test('rollouts must exist inside actual sessions/archive roots, rejecting traversal, siblings and symlink escapes', async t => {
  const data = await fixture(t);
  await data.add('outside', { rollout_path: path.join(data.root, 'outside.jsonl') });
  await data.add('sibling', { rollout_path: path.join(data.codexHome, 'sessions-evil', 'sibling.jsonl') });
  await data.add('missing', {}, null);
  await data.add('wrong-extension', { rollout_path: path.join(data.codexHome, 'sessions', 'secret.txt') });
  await data.add('archived-root', { rollout_path: path.join(data.codexHome, 'archived_sessions', 'valid.jsonl') });
  const target = path.join(data.root, 'external-directory');
  await fs.mkdir(target);
  await fs.writeFile(path.join(target, 'escape.jsonl'), `${metadata('symlink')}\n${usage(1)}\n`);
  const link = path.join(data.codexHome, 'sessions', 'link');
  await fs.symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  await data.add('symlink', { rollout_path: path.join(link, 'escape.jsonl') }, null);
  assert.deepEqual((await data.reader.list()).threads.map(thread => thread.id), ['archived-root']);
});

test('context uses latest last_token_usage and dynamic window, allowing zero and clamping over-limit', async t => {
  const data = await fixture(t);
  const rollout = await data.add('chosen', {}, [metadata('chosen'), usage(5, 100, 9000000), usage(25, 50)]);
  await data.reader.select('chosen');
  const selection = await data.reader.resolve();
  assert.deepEqual(await data.reader.readContext(selection), { status: 'ready', usedTokens: 25, windowTokens: 50, percent: 50 });
  await fs.appendFile(rollout, `${usage(0, 90000)}\n`);
  assert.deepEqual(await data.reader.readContext(selection), { status: 'ready', usedTokens: 0, windowTokens: 90000, percent: 0 });
  await fs.appendFile(rollout, `${usage(1000, 100)}\n`);
  assert.deepEqual(await data.reader.readContext(selection), { status: 'ready', usedTokens: 100, windowTokens: 100, percent: 100 });
});

test('missing/invalid latest counters never fall back to cumulative totals or a previous context window', async t => {
  const data = await fixture(t);
  const rollout = await data.add('chosen', {}, [metadata('chosen'), usage(30, 100), usage(15, null)]);
  await data.reader.select('chosen');
  const selection = await data.reader.resolve();
  assert.equal((await data.reader.readContext(selection)).reason, 'context-missing');
  for (const [used, window] of [[-1, 100], [10, 0], [1.5, 100], [Number.MAX_SAFE_INTEGER + 1, 100]]) {
    await fs.writeFile(rollout, `${metadata('chosen')}\n${usage(used, window)}\n`);
    assert.equal((await data.reader.readContext(selection)).reason, 'context-missing');
  }
});

test('response content mentioning token_count is ignored, including nested fake event objects', async t => {
  const data = await fixture(t);
  const forged = JSON.stringify({ type: 'response_item', payload: { type: 'message', content: [JSON.parse(usage(99, 100)), { text: 'token_count' }] } });
  const wrongPayload = JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', nested: JSON.parse(usage(99, 100)) } });
  await data.add('chosen', {}, [metadata('chosen'), usage(20, 100), forged, wrongPayload]);
  await data.reader.select('chosen');
  assert.equal((await data.reader.readContext(await data.reader.resolve())).percent, 20);
});

test('rate-limit-only token events do not erase the last actual usage', async t => {
  const data = await fixture(t);
  await data.add('chosen', {}, [metadata('chosen'), usage(20, 100), JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: null } })]);
  await data.reader.select('chosen');
  assert.equal((await data.reader.readContext(await data.reader.resolve())).percent, 20);
});

test('compaction invalidates previous context usage until a new numeric token event', async t => {
  const data = await fixture(t);
  const rollout = await data.add('chosen', {}, [metadata('chosen'), usage(90, 100), JSON.stringify({ type: 'event_msg', payload: { type: 'context_compacted' } })]);
  await data.reader.select('chosen');
  const selection = await data.reader.resolve();
  assert.equal((await data.reader.readContext(selection)).reason, 'context-compacted');
  await fs.appendFile(rollout, `${usage(10, 100)}\n`);
  assert.equal((await data.reader.readContext(selection)).percent, 10);
  await fs.appendFile(rollout, `${JSON.stringify({ type: 'compacted', payload: { replacement_history: ['PRIVATE FIXTURE '.repeat(15000)] } })}\n`);
  assert.equal((await data.reader.readContext(selection)).reason, 'context-compacted');
});

test('session identity is required and checked without parsing large instruction-bearing headers', async t => {
  const data = await fixture(t);
  const rollout = await data.add('chosen', {}, [metadata('different'), usage(20, 100)]);
  await data.reader.select('chosen');
  const selection = await data.reader.resolve();
  assert.equal((await data.reader.readContext(selection)).reason, 'session-mismatch');
  await fs.writeFile(rollout, `${metadata('chosen', { base_instructions: 'PRIVATE INSTRUCTIONS '.repeat(15000) })}\n${usage(20, 100)}\n`);
  assert.equal((await data.reader.readContext(selection)).percent, 20);
  await fs.writeFile(rollout, `${usage(20, 100)}\n`);
  assert.equal((await data.reader.readContext(selection)).reason, 'session-mismatch');
});

test('long tails are bounded and missing recent usage stays unknown instead of scanning complete history', async t => {
  const data = await fixture(t);
  const giant = JSON.stringify({ type: 'response_item', payload: { type: 'message', content: 'PRIVATE BODY '.repeat(220000) } });
  const rollout = await data.add('chosen', {}, [metadata('chosen'), usage(90, 100), giant]);
  await data.reader.select('chosen');
  const selection = await data.reader.resolve();
  assert.equal((await data.reader.readContext(selection)).reason, 'context-missing');
  await fs.appendFile(rollout, `${usage(10, 100)}\n`);
  assert.equal((await data.reader.readContext(selection)).percent, 10);
});

test('incomplete final JSON and malformed lines are ignored; later truncation never reuses cached usage', async t => {
  const data = await fixture(t);
  const rollout = await data.add('chosen', {}, `${metadata('chosen')}\n${usage(20, 100)}\n{broken}\n${usage(99, 100)}`);
  await data.reader.select('chosen');
  const selection = await data.reader.resolve();
  assert.equal((await data.reader.readContext(selection)).percent, 20);
  await fs.writeFile(rollout, `${metadata('chosen')}\n`);
  assert.equal((await data.reader.readContext(selection)).reason, 'context-missing');
  await fs.truncate(rollout, 4);
  assert.equal((await data.reader.readContext(selection)).reason, 'session-mismatch');
  await fs.rm(rollout);
  assert.equal((await data.reader.readContext(selection)).status, 'unavailable');
});

test('forged/stale resolve objects cannot change a thread cwd or read arbitrary files', async t => {
  const data = await fixture(t);
  await data.add('chosen');
  await data.reader.select('chosen');
  const selection = await data.reader.resolve();
  assert.equal((await data.reader.readContext({ ...selection, rolloutPath: path.join(data.root, 'private.jsonl') })).reason, 'selection-changed');
  assert.equal((await data.reader.readContext({ ...selection, cwd: data.root })).reason, 'selection-changed');
  assert.equal((await data.reader.readContext(null)).reason, 'selection-missing');
});

test('rollout permission failures return unknown without propagating paths or reusing an earlier number', async t => {
  const data = await fixture(t);
  await data.add('chosen');
  await data.reader.select('chosen');
  const selection = await data.reader.resolve();
  assert.equal((await data.reader.readContext(selection)).status, 'ready');
  const original = fs.open;
  fs.open = async function(filename, ...args) {
    if (filename === selection.rolloutPath) throw Object.assign(new Error('Private fixture path must not escape'), { code: 'EACCES' });
    return original.call(this, filename, ...args);
  };
  try { assert.deepEqual(await data.reader.readContext(selection), { status: 'unavailable', reason: 'rollout-unavailable' }); }
  finally { fs.open = original; }
});

test('metadata and context reads have deadlines when isolated filesystem providers never return', async t => {
  const data = await fixture(t);
  await data.add('chosen');
  const never = () => new Promise(() => {});
  await fs.mkdir(data.maidData);
  await fs.writeFile(data.selectionFile, JSON.stringify({ version: 1, selectedId: 'chosen' }));
  const metadataReader = new ConversationReader({ codexHome: data.codexHome, selectionFile: data.selectionFile,
    filesystem: { ...fs, readdir: never }, timeoutMs: 40, selectionTimeoutMs: 60 });
  assert.equal((await metadataReader.list()).reason, 'local-data-timeout');
  assert.equal((await metadataReader.resolve()).reason, 'local-data-timeout');
  assert.equal((await metadataReader.resolveId('chosen')).reason, 'local-data-timeout');
  await assert.rejects(metadataReader.select('chosen'), { code: 'selection-timeout' });
  const contextReader = new ConversationReader({ codexHome: data.codexHome, selectionFile: data.selectionFile,
    filesystem: { ...fs, open: never }, timeoutMs: 40 });
  const selection = await data.reader.resolve();
  assert.equal((await contextReader.readContext(selection)).reason, 'context-timeout');
});

test('timed-out selection cannot write after its delayed mkdir returns or overwrite a later choice', async t => {
  const data = await fixture(t);
  await data.add('chosen-old');
  await data.add('chosen-new');
  let release;
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const delayed = new Promise(resolve => { release = resolve; });
  let first = true;
  let writes = 0;
  const reader = new ConversationReader({ codexHome: data.codexHome, selectionFile: data.selectionFile, timeoutMs: 200,
    selectionTimeoutMs: 100, filesystem: { ...fs,
      async mkdir(...args) { if (first) { first = false; entered(); await delayed; } return fs.mkdir(...args); },
      async writeFile(...args) { writes++; return fs.writeFile(...args); },
    } });
  const oldSelection = reader.select('chosen-old');
  await started;
  await assert.rejects(oldSelection, { code: 'selection-timeout' });
  assert.equal((await reader.select('chosen-new')).selectedId, 'chosen-new');
  release();
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(writes, 1);
  assert.equal(JSON.parse(await fs.readFile(data.selectionFile, 'utf8')).selectedId, 'chosen-new');
  assert.equal((await reader.resolve()).threadId, 'chosen-new');
  assert.deepEqual(await fs.readdir(data.maidData), ['conversation-selection.json']);
});

test('superseded selection aborts temporary writes and cannot rename or update selected memory', async t => {
  const data = await fixture(t);
  await data.add('chosen-old');
  await data.add('chosen-new');
  let release;
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const delayed = new Promise(resolve => { release = resolve; });
  let first = true;
  let renames = 0;
  const reader = new ConversationReader({ codexHome: data.codexHome, selectionFile: data.selectionFile, timeoutMs: 400,
    selectionTimeoutMs: 500, filesystem: { ...fs,
      async writeFile(...args) { if (first) { first = false; entered(); await delayed; } return fs.writeFile(...args); },
      async rename(...args) { renames++; return fs.rename(...args); },
    } });
  const oldSelection = reader.select('chosen-old');
  const rejection = assert.rejects(oldSelection, { code: 'selection-superseded' });
  await started;
  assert.equal((await reader.select('chosen-new')).selectedId, 'chosen-new');
  release();
  await rejection;
  assert.equal(renames, 1);
  assert.equal(JSON.parse(await fs.readFile(data.selectionFile, 'utf8')).selectedId, 'chosen-new');
  assert.equal((await reader.resolve()).threadId, 'chosen-new');
  assert.deepEqual(await fs.readdir(data.maidData), ['conversation-selection.json']);
});

test('compaction history is lazy, counts only committed top-level envelopes and survives a reader restart', async t => {
  const data = await fixture(t);
  const compacted = summary => JSON.stringify({ type: 'compacted', payload: { message: summary, compaction_response_id: 'fixture-response' } });
  const notified = JSON.stringify({ type: 'event_msg', payload: { type: 'context_compacted' } });
  const nested = JSON.stringify({ type: 'response_item', payload: { type: 'message', text: compacted('fake escaped'), nested: { type: 'compacted' } } });
  const rollout = await data.add('chosen', {}, [metadata('chosen'), notified, compacted('PRIVATE FIXTURE '.repeat(150000)), notified, nested, compacted('second'), usage(20)]);
  assert.equal(data.reader.compactionCounter, null);
  const selected = await data.reader.resolveId('chosen');
  assert.equal(data.reader.compactionCounter, null);
  assert.deepEqual(await data.reader.readCompactions(selected), { status: 'ready', count: 2, complete: true });
  assert.ok(data.reader.compactionCounter);
  assert.equal(data.reader.selectedId, null); assert.equal(data.reader.selectionLoaded, false);
  assert.equal(await fs.stat(data.maidData).then(() => true, () => false), false);
  const reader = new ConversationReader({ codexHome: data.codexHome });
  assert.deepEqual(await reader.readCompactions(await reader.resolveId('chosen')), { status: 'ready', count: 2, complete: true });
  await fs.appendFile(rollout, compacted('third') + '\n' + notified + '\n');
  assert.deepEqual(await data.reader.readCompactions(selected), { status: 'ready', count: 3, complete: true });
  assert.deepEqual(await data.reader.readCompactions(selected), { status: 'ready', count: 3, complete: true });
});

test('compaction read revalidates selection paths and missing IDs before opening rollout data', async t => {
  const data = await fixture(t);
  await data.add('chosen');
  const selection = await data.reader.resolveId('chosen');
  const reader = new ConversationReader({ codexHome: data.codexHome, filesystem: { ...fs,
    open: async () => { throw new Error('A forged selection must not reach rollout IO'); },
  } });
  for (const changed of [{ ...selection, cwd: data.root }, { ...selection, rolloutPath: path.join(data.root, 'outside.jsonl') }]) {
    assert.deepEqual(await reader.readCompactions(changed), { status: 'unavailable', reason: 'selection-changed' });
  }
  assert.deepEqual(await reader.readCompactions(null), { status: 'unavailable', reason: 'selection-missing' });
  assert.deepEqual(await reader.readCompactions({ status: 'ready', threadId: '../invalid' }), { status: 'unavailable', reason: 'selection-missing' });
  assert.deepEqual(await reader.readCompactions({ ...selection, threadId: 'missing' }), { status: 'unavailable', reason: 'selection-expired' });
  assert.equal(reader.compactionCounter, null);
});

test('compaction data distinguishes exact zero, unfinished line and wrong session identity', async t => {
  const data = await fixture(t);
  const rollout = await data.add('chosen', {}, [metadata('chosen'), usage(20)]);
  const selection = await data.reader.resolveId('chosen');
  assert.deepEqual(await data.reader.readCompactions(selection), { status: 'ready', count: 0, complete: true });
  await fs.appendFile(rollout, '{"type":"compacted","payload":{"message":"partial","compaction_response_id":"fixture-response"}}');
  assert.deepEqual(await data.reader.readCompactions(selection), { status: 'ready', count: 0, complete: false });
  await fs.appendFile(rollout, '\n');
  assert.deepEqual(await data.reader.readCompactions(selection), { status: 'ready', count: 1, complete: true });
  await fs.writeFile(rollout, metadata('different') + '\n');
  assert.deepEqual(await data.reader.readCompactions(selection), { status: 'unavailable', reason: 'session-mismatch' });
});

test('compaction counts direct successful response IDs, excludes reset checkpoints and keeps legacy uncertainty', async t => {
  const data = await fixture(t);
  const record = payload => JSON.stringify({ type: 'compacted', payload });
  const rollout = await data.add('chosen', {}, [metadata('chosen'),
    record({ message: 'reset', compaction_response_id: null }),
    record({ message: 'reset', compaction_response_id: '' }),
    record({ message: '', replacement_history: [{ type: 'message', content: 'fixture' }], compaction_response_id: 'fixture-response' }),
    record({ message: '', compaction_response_id: 'fixture-response' }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'context_compacted' } }),
  ]);
  const selection = await data.reader.resolveId('chosen');
  assert.deepEqual(await data.reader.readCompactions(selection), { status: 'ready', count: 2, complete: true });
  await fs.appendFile(rollout, record({ message: 'legacy summary', replacement_history: [{ compaction_response_id: 'nested-only' }] }) + '\n');
  assert.deepEqual(await data.reader.readCompactions(selection), { status: 'ready', count: 2, complete: false, incompleteReason: 'legacy-records' });
});

test('a timed-out compaction metadata lookup cannot lazily start scanning when its filesystem returns later', async t => {
  const data = await fixture(t);
  await data.add('chosen');
  const selection = await data.reader.resolveId('chosen');
  let release, enter;
  const gated = new Promise(resolve => { release = resolve; });
  const entered = new Promise(resolve => { enter = resolve; });
  let opens = 0;
  const reader = new ConversationReader({ codexHome: data.codexHome, selectionFile: data.selectionFile, timeoutMs: 25,
    filesystem: { ...fs,
      async readdir(...args) { enter(); await gated; return fs.readdir(...args); },
      async open(...args) { opens++; return fs.open(...args); },
    } });
  const pending = reader.readCompactions(selection);
  await entered;
  assert.deepEqual(await pending, { status: 'unavailable', reason: 'compaction-timeout' });
  release();
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(opens, 0);
  assert.equal(reader.compactionCounter, null, 'expired metadata must not create a counter or cache');
  assert.equal(reader.selectedId, null); assert.equal(reader.selectionLoaded, false);
});

test('extended Windows drive and UNC aliases retain lexical and real-path containment', async () => {
  const source = await fs.readFile(path.join(__dirname, '../src/conversation-reader.cjs'), 'utf8');
  const module = { exports: {} };
  const neverFilesystem = new Proxy({}, { get() { throw Error('Host filesystem must never be used'); } });
  vm.runInNewContext(source, { module, exports: module.exports, Buffer, setTimeout, clearTimeout, AbortController, performance,
    process: { env: {}, pid: 1 }, require(name) {
      if (name === 'node:path') return path.win32;
      if (name === 'node:fs/promises') return neverFilesystem;
      if (name === 'node:os') return { homedir: () => 'C:\\isolated-host' };
      if (name === 'node:crypto') return { randomUUID: () => 'fixture' };
      throw Error('Unexpected dependency');
    } });
  const Reader = module.exports.ConversationReader;
  for (const home of ['C:\\isolated-codex', '\\\\fixture-server\\fixture-share\\isolated-codex']) {
    const alias = value => path.win32.toNamespacedPath(value);
    const root = path.win32.join(home, 'sessions');
    const filename = path.win32.join(root, '2020', 'legacy.jsonl');
    const workspace = path.win32.join(path.win32.dirname(home), 'workspace');
    let escaped = false, statCalls = 0;
    const filesystem = {
      async realpath(value) {
        assert.ok([home, root, filename].includes(value));
        return escaped && value === filename ? alias(path.win32.join(path.win32.dirname(home), 'outside.jsonl')) : alias(value);
      },
      async stat(value) { assert.equal(value, filename); statCalls++; return { isFile: () => true }; },
    };
    const reader = new Reader({ codexHome: alias(home), filesystem });
    const row = { id: 'legacy', cwd: alias(workspace), rollout_path: alias(filename) };
    const selected = await reader._rollout(row);
    assert.equal(selected.status, 'ready'); assert.equal(selected.cwd, workspace); assert.equal(selected.rolloutPath, filename);
    escaped = true;
    assert.equal(await reader._rollout(row), null, 'real-path escapes remain rejected after alias normalization');
    const before = statCalls;
    for (const bad of [alias(path.win32.join(path.win32.dirname(home), 'outside.jsonl')),
      '\\\\?\\GLOBALROOT\\Device\\HarddiskVolume1\\outside.jsonl', '\\\\.\\pipe\\fixture.jsonl']) {
      assert.equal(await reader._rollout({ ...row, rollout_path: bad }), null);
    }
    assert.equal(statCalls, before, 'outside and device paths must be rejected before filesystem access');
    assert.throws(() => new Reader({ codexHome: home, selectionFile: alias(path.win32.join(home, 'selection.json')), filesystem }));
    assert.throws(() => new Reader({ codexHome: alias(home), selectionFile: path.win32.join(home, 'selection.json'), filesystem }));
  }
});

test('an old namespaced conversation outside the recent 30 and candidate 120 resolves automatically', { skip: process.platform !== 'win32' }, async t => {
  const data = await fixture(t);
  const filename = path.join(data.codexHome, 'sessions', '2020', '01', 'old.jsonl');
  await data.add('legacy-old', { updated_at_ms: 1, cwd: path.toNamespacedPath(data.workspace), rollout_path: path.toNamespacedPath(filename) },
    [metadata('legacy-old'), usage(30000)]);
  for (let index = 0; index < 130; index++) await data.add(`recent-${index}`, { updated_at_ms: 1000000 + index });
  const listed = await data.reader.list();
  assert.equal(listed.threads.length, 30); assert.equal(listed.threads.some(thread => thread.id === 'legacy-old'), false);
  const selected = await data.reader.resolveId('legacy-old');
  assert.equal(selected.status, 'ready');
  assert.equal(await fs.realpath(selected.cwd), await fs.realpath(data.workspace));
  assert.equal(await fs.realpath(selected.rolloutPath), await fs.realpath(filename));
  assert.equal((await data.reader.readContext(selected)).usedTokens, 30000);
  const { ConversationTarget } = require('../src/conversation-target.cjs');
  data.reader.list = async () => { throw Error('Automatic lookup must not use the recent list'); };
  const target = new ConversationTarget({ reader: data.reader, detector: { resolve: async () => ({ status: 'ready', threadId: 'legacy-old' }) },
    modeFile: path.join(data.maidData, 'absent-mode.json') });
  const automatic = await target.resolve();
  assert.equal(automatic.status, 'ready'); assert.equal(automatic.threadId, 'legacy-old'); assert.equal(automatic.selectionMode, 'auto');
  assert.equal(data.reader.selectedId, null); assert.equal(await fs.stat(data.maidData).then(() => true, () => false), false);
});
