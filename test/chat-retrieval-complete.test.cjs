'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createChatProject } = require('../src/chat-project.cjs'), { createConversation, commitCheckpoint } = require('../src/chat-archive.cjs');
const { MemoryStore } = require('../src/chat-memory.cjs'), { ChatHistory } = require('../src/chat-history.cjs');
const { SemanticEncoder, discoverResources, verifyResources, fingerprint } = require('../src/chat-semantic.cjs');
const { reciprocalRankFusion, rerankNear, evidenceDuplicate, NEAR_RRF_RATIO } = require('../src/chat-search.cjs');
function fixture(t, messages = ['隔离测试：不要删除原图。'], options = {}) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'maid-retrieval-中文 空格-'));
  // All data directory functions used here receive the explicit isolated root;
  // neither MemoryStore nor ChatJournal resolves the host's real data directory.
  const project = createChatProject({ parentDir: sandbox, userNickname: '合成' }), measure = value => Buffer.byteLength(value);
  const memory = new MemoryStore({ projectRoot: project.root, countTokens: measure }); memory.initialize({ pet_name: '合成', user_nickname: '合成' });
  const archive = (texts, day = 26) => {
    const conversation = createConversation({ root: project.root, startedAt: `2026-10-${day}T12:00:00+08:00`, timezone: 'Asia/Shanghai', nativeThreadId: `synthetic-${day}` });
    const records = texts.flatMap((text, index) => [{ turn: { id: `T${index + 1}`, observed_at: null } }, { id: `M${index + 1}`, turn_id: `T${index + 1}`, role: 'user', time: `2026-10-${day}T12:00:01+08:00`, content: [{ text }] }, { turn_result: { id: `T${index + 1}`, observed_at: null, status: 'completed' } }]);
    commitCheckpoint({ root: project.root, conversation, sourceComplete: true, trigger: 'new-conversation', records }); return conversation;
  };
  const conversation = archive(messages), history = new ChatHistory({ projectRoot: project.root, memory, measure, semanticOptions: { resourceRoot: path.join(sandbox, 'missing') }, ...options });
  t.after(async () => { await history.close(); fs.rmSync(sandbox, { recursive: true, force: true }); });
  return { sandbox, project, memory, history, conversation, archive };
}
test('incremental source manifests reuse unchanged archives, append new commits, and delete contentless postings safely', async t => {
  const f = fixture(t); const first = await f.history.syncIndex(); assert.equal(first.status, 'ready'); assert.ok(first.changedFiles > 0);
  const second = await f.history.updateIndex(); assert.equal(second.changedFiles, 0); assert.equal(second.indexed, 0);
  f.archive(['后来讨论：我喜欢骑自行车。'], 27); const next = await f.history.syncIndex(); assert.equal(next.changedFiles, 1); assert.ok(next.unchangedFiles >= 4);
  assert.ok((await f.history.searchRecords('自行车', f.history.beginTurn())).cards.length);
  const rebuild = await f.history.rebuildIndex(); assert.ok(rebuild.changedFiles > 1); assert.equal(f.history.health().semantic, 'unavailable');
});
test('background initialization starts once, indexes existing archives, publishes health changes and stays closed', async t => {
  const f = fixture(t); let requests = 0; const request = f.history._workerRequest.bind(f.history);
  f.history._workerRequest = (...args) => { if (args[0] === 'syncIndex') requests++; return request(...args); };
  const states = [], unsubscribe = f.history.onHealthChange(health => states.push(health));
  const first = f.history.initialize(), second = f.history.initialize(); assert.equal(first, second);
  assert.equal(f.history.health().coverage, 'indexing'); const result = await first;
  assert.equal(result.status, 'ready'); assert.equal(requests, 1); assert.equal(f.history.resolveReference(`${f.conversation.conversationId}/M1/P01`).text, '隔离测试：不要删除原图。');
  assert.ok(states.some(state => state.coverage === 'indexing')); assert.ok(states.some(state => state.coverage === 'ready'));
  const count = states.length; unsubscribe(); f.history._notifyHealth(); assert.equal(states.length, count);
  await f.history.close(); assert.deepEqual(await f.history.initialize(), { status: 'unavailable', reason: 'closed' }); assert.equal(requests, 1);
});
test('initialization reports index failure without silently claiming ready or reopening a closed project', async t => {
  const f = fixture(t), states = []; f.history.onHealthChange(state => states.push(state));
  f.history._workerRequest = async () => { throw new Error('SYNTHETIC_INDEX_FAILURE'); };
  await assert.rejects(f.history.initialize(), /SYNTHETIC_INDEX_FAILURE/); assert.equal(f.history.health().coverage, 'unavailable'); assert.ok(states.some(state => state.coverage === 'unavailable'));
  const count = states.length; await f.history.close(); f.history._notifyHealth(); assert.equal(states.length, count);
});
test('overlapping Unicode chunks retain exact UTF8 locations and reconstruct base references without duplicate overlap', async t => {
  const text = '🙂有中文、引号"与换行\n不要删除这张原图。'.repeat(40), f = fixture(t, [text]); await f.history.syncIndex();
  const rows = f.history._open().prepare("SELECT ref,metadata FROM refs WHERE kind='original' ORDER BY rowid").all().map(row => ({ ...row, metadata: JSON.parse(row.metadata) }));
  assert.ok(rows.length > 2); assert.ok(rows[1].metadata.start < rows[0].metadata.end);
  for (const row of rows) assert.equal(f.history.resolveReference(row.ref).text, Array.from(text).slice(row.metadata.start, row.metadata.end).join(''));
  assert.equal(f.history.resolveReference(`${f.conversation.conversationId}/M1/P01`).text, text);
});
test('explicit management commits mark coverage partial immediately and coalesce background incremental indexing', async t => {
  const f = fixture(t); await f.history.syncIndex();
  f.memory.save({ module: 'facts', operationId: 'new-managed-fact', baseVersion: 1, action: 'upsert', payload: { entry: { id: 'F-managed', kind: 'fact', content: '新的管理保存内容是青铜火车站。' } } });
  assert.equal(f.history.health().coverage, 'partial');
  const deadline = Date.now() + 3000; while (f.history.health().coverage !== 'ready' && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(f.history.health().coverage, 'ready'); const found = await f.history.searchRecords('青铜火车站', f.history.beginTurn()); assert.ok(found.cards.some(card => card.ref === 'F-managed@1'));
});
test('a saved-operation background worker sync and explicit rebuild await all queued coverage including original images', async t => {
  const f = fixture(t); await f.history.syncIndex();
  let release, entered; const gate = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
  const request = f.history._workerRequest.bind(f.history); let held = false;
  f.history._workerRequest = async function(method, ...args) {
    const result = await request(method, ...args);
    if (method === 'syncIndex' && !held) { held = true; entered(); await gate; }
    return result;
  };
  t.after(() => release());
  f.memory.save({ module: 'facts', operationId: 'background-before-image', baseVersion: 1, action: 'upsert', payload: { entry: { id: 'F-before-image', kind: 'fact', content: '合成后台保存先开始。' } } });
  let timeout;
  try { await Promise.race([started, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('BACKGROUND_SYNC_NOT_STARTED')), 3000); })]); } finally { clearTimeout(timeout); }
  const conversation = createConversation({ root: f.project.root, startedAt: '2026-10-28T12:00:00+08:00', timezone: 'Asia/Shanghai', nativeThreadId: 'synthetic-queued-image' });
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=', 'base64');
  commitCheckpoint({ root: f.project.root, conversation, sourceComplete: true, trigger: 'new-conversation', records: [{ turn: { id: 'T1', observed_at: null } }, { id: 'M1', turn_id: 'T1', role: 'user', time: null, content: [{ text: '新的合成原图' }, { image: { bytes: png, mime: 'image/png', name: '隔离 原图.png' } }] }, { turn_result: { id: 'T1', observed_at: null, status: 'completed' } }] });
  let resolved = false; const rebuild = f.history.rebuildIndex().then(result => { resolved = true; return result; });
  await Promise.resolve(); assert.equal(resolved, false, 'rebuild must wait while an older background pass is active');
  release(); const result = await rebuild; assert.equal(result.status, 'ready');
  assert.deepEqual(f.history.resolveReference(`${conversation.conversationId}/M1/P02`).image.bytes, png);
});
test('importance and real discussion/event times enter the derived index without becoming rebuild time', async t => {
  const f = fixture(t); f.memory.save({ module: 'facts', operationId: 'save-notable', baseVersion: 1, action: 'upsert', payload: { entry: { id: 'F-event', kind: 'fact', content: '合成用户养过一只猫。', importance: 'user_marked', event_time: '2020-01-01T00:00:00Z', last_supported_at: '2026-01-01T00:00:00Z' } } });
  await f.history.syncIndex(); const row = f.history._row('F-event@1'); assert.equal(row.metadata.importance, 'user_marked'); assert.equal(row.metadata.eventTime, '2020-01-01T00:00:00Z'); assert.equal(row.metadata.discussedAt, '2026-01-01T00:00:00Z');
  const before = row.metadata; await f.history.rebuildIndex(); assert.deepEqual(f.history._row('F-event@1').metadata, before);
});
test('calibrated near-RRF bands preserve strong relevance and apply sourced importance then real discussion recency', t => {
  const cases = [
    { scores: [1 / 61, 1 / 62], metadata: [{ importance: 'normal' }, { importance: 'user_marked' }], expected: 'b' },
    { scores: [1 / 61, 1 / 63], metadata: [{ importance: 'normal' }, { importance: 'user_marked' }], expected: 'a' },
    { scores: [1 / 61, 1 / 71], metadata: [{ importance: 'normal' }, { importance: 'user_marked', discussedAt: '2026-10-26' }], expected: 'a' },
    { scores: [1 / 61, 1 / 62], metadata: [{ importance: 'notable' }, { importance: 'normal', discussedAt: '2026-10-26' }], expected: 'a' },
    { scores: [1 / 61, 1 / 62], metadata: [{ importance: 'normal', discussedAt: '2020-01-01' }, { importance: 'normal', discussedAt: '2026-01-01' }], expected: 'b' },
    { scores: [1 / 61, 1 / 62], metadata: [{ importance: 'normal' }, { importance: 'user_marked' }], expected: 'b', historical: true },
  ];
  const evaluations = [0, 0.01, 0.018, 0.025, 0.04].map(nearRatio => ({ nearRatio, correct: cases.filter(item => rerankNear(item.scores.map((score, n) => ({ ref: n ? 'b' : 'a', score })), new Map(item.metadata.map((metadata, n) => [n ? 'b' : 'a', { metadata }])), { nearRatio, historical: item.historical })[0].ref === item.expected).length }));
  assert.equal(evaluations.find(value => value.nearRatio === NEAR_RRF_RATIO).correct, cases.length); assert.ok(evaluations[0].correct < cases.length);
  t.diagnostic(JSON.stringify({ calibration: evaluations, samples: cases.length, scope: 'small deterministic ranking sample; not long-term semantic quality' }));
  assert.deepEqual(reciprocalRankFusion([['a', 'b'], ['b', 'c']]).map(value => value.ref), ['b', 'a', 'c']);
});
test('cross-layer duplicate facts collapse while conflicting revisions and separate facts from one message survive', () => {
  assert.equal(evidenceDuplicate({ metadata: { factRefs: ['F-one@2'] } }, { metadata: { factRefs: ['F-one@2'] } }), true);
  assert.equal(evidenceDuplicate({ metadata: { factRefs: ['F-one@1'] } }, { metadata: { factRefs: ['F-one@2'] } }), false);
  assert.equal(evidenceDuplicate({ metadata: { sourceRef: 'C-a/M1/P01', start: 0, end: 100 } }, { metadata: { sourceRef: 'C-a/M1/P01', start: 80, end: 180 } }), false);
  assert.equal(evidenceDuplicate({ metadata: { factRefs: ['F-one@2'], conflict: true } }, { metadata: { factRefs: ['F-one@2'] } }), false);
});
test('formal source-backed summary folds exact same fact but separate clauses and contradictions stay independently available', async t => {
  const text = '我最喜欢喝乌龙茶。', f = fixture(t, [text]); await f.history.syncIndex();
  const ref = `${f.conversation.conversationId}/M1/P01`, original = f.history._row(ref);
  const summary = { kind: 'summary', metadata: { sources: [ref], importance: 'normal' } }; f.history._inheritMetadata(summary.metadata, text);
  assert.equal(evidenceDuplicate(summary, original), true);
  const contradiction = { kind: 'summary', metadata: { sources: [ref], importance: 'normal' } }; f.history._inheritMetadata(contradiction.metadata, '我不喜欢喝乌龙茶。');
  assert.equal(evidenceDuplicate(contradiction, original), false);
  const distinct = { metadata: { claimRanges: [{ sourceRef: ref, start: 10, end: 20, textHash: 'different-clause' }] } }; assert.equal(evidenceDuplicate(summary, distinct), false);
});
test('resource discovery supports custom Chinese/spaced locations and invalid explicit resources fail closed', async t => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), '语义 资源-')); t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));
  assert.equal(discoverResources({ resourceRoot: sandbox, resourcesPath: '/unrelated' }), fs.realpathSync(sandbox));
  assert.equal(discoverResources({ resourceRoot: path.join(sandbox, 'missing'), sourceRoot: path.resolve(__dirname, '..') }), null);
  await assert.rejects(verifyResources(sandbox));
});
test('real pinned CPU encoder recalls Chinese/English paraphrases and persistent vectors; no remote requests or user data', async t => {
  const localResource = path.resolve(__dirname, '../resources/chat-semantic'), sourceResource = path.resolve(__dirname, '../../resources/chat-semantic');
  const resourceRoot = fs.existsSync(path.join(localResource, 'model/onnx/model_quantized.onnx')) ? localResource : sourceResource;
  if (!fs.existsSync(path.join(resourceRoot, 'model/onnx/model_quantized.onnx'))) return t.skip('Explicit pinned semantic resources are not prepared; run prepare-chat-semantic --download for real-model QA');
  const f = fixture(t, ['I cannot drink milk because I am lactose intolerant.', '我家养了一只叫团团的橘猫。', '明天要完成数学作业。'], { worker: false, semanticOptions: { resourceRoot } });
  const nativeFetch = globalThis.fetch; let requests = 0; globalThis.fetch = async () => { requests++; throw new Error('Network disabled during semantic test'); }; t.after(() => { globalThis.fetch = nativeFetch; });
  const result = await f.history.syncIndex({ waitSemantic: true }); assert.equal(result.semantic, 'ready'); assert.ok(f.history.health().indexedVectors >= 3);
  for (const [query, expected] of [['Which food makes me sick?', 'lactose'], ['宠物的名字是什么？', '团团'], ['What is my cat called?', '团团']]) {
    const found = await f.history.searchRecords(query, f.history.beginTurn()); assert.equal(found.semantic, 'ready'); assert.ok(found.cards[0].text.includes(expected), JSON.stringify(found));
  }
  assert.equal(requests, 0); assert.equal(f.history._open().prepare('SELECT COUNT(*) n FROM vectors WHERE model=?').get(fingerprint).n, 3);
  const before = f.history._open().prepare('SELECT textHash FROM vectors ORDER BY ref').all(); await f.history.syncIndex({ waitSemantic: true }); assert.deepEqual(f.history._open().prepare('SELECT textHash FROM vectors ORDER BY ref').all(), before);
});
