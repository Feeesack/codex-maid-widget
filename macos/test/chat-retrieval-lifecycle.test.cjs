'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { createChatProject } = require('../src/chat-project.cjs'), { createConversation, commitCheckpoint } = require('../src/chat-archive.cjs'), { MemoryStore } = require('../src/chat-memory.cjs'), { ChatHistory } = require('../src/chat-history.cjs');
const { explicitAliases, scriptGroup } = require('../src/chat-search.cjs');
function fixture(t, semantic = false) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'maid-history-lifecycle-中文 空格-')), project = createChatProject({ parentDir: sandbox, userNickname: '隔离用户' });
  const local = path.resolve(__dirname, '../resources/chat-semantic'), outer = path.resolve(__dirname, '../../resources/chat-semantic'), resources = fs.existsSync(path.join(local, 'model/onnx/model_quantized.onnx')) ? local : outer;
  const memory = new MemoryStore({ projectRoot: project.root, countTokens: Buffer.byteLength }); memory.initialize({ pet_name: '合成', user_nickname: '隔离用户' });
  let history; const open = () => history = new ChatHistory({ projectRoot: project.root, memory, measure: Buffer.byteLength, semanticOptions: { resourceRoot: semantic ? resources : path.join(sandbox, 'absent') } }); open();
  const archive = (day, messages) => { const conversation = createConversation({ root: project.root, startedAt: `2026-10-${String(day).padStart(2, '0')}T12:00:00+08:00`, timezone: 'Asia/Shanghai', nativeThreadId: `synthetic-lifecycle-${day}` }); commitCheckpoint({ root: project.root, conversation, sourceComplete: true, trigger: 'new-conversation', records: messages.flatMap((text, n) => [{ turn: { id: `T${n + 1}`, observed_at: null } }, { id: `M${n + 1}`, turn_id: `T${n + 1}`, role: 'user', time: `2026-10-${String(day).padStart(2, '0')}T12:00:01+08:00`, content: [{ text }] }, { turn_result: { id: `T${n + 1}`, observed_at: null, status: 'completed' } }]) }); return conversation; };
  t.after(async () => { await history.close(); assert.equal(path.dirname(sandbox), os.tmpdir()); assert.ok(path.basename(sandbox).startsWith('maid-history-lifecycle-')); fs.rmSync(sandbox, { recursive: true, force: true }); });
  return { sandbox, project, memory, archive, open, get history() { return history; } };
}
test('sourced explicit aliases expand lexical recall while negated/tentative aliases do not become equivalence', async t => {
  const f = fixture(t); f.archive(1, ['"Noori"也叫"糯米"。', 'Noori keeps the silver harness beside the door.']); await f.history.syncIndex();
  const found = await f.history.searchRecords({ query: '糯米 harness' }, f.history.beginTurn()); assert.ok(found.cards.some(card => card.text.includes('silver harness')));
  assert.deepEqual(explicitAliases('也许"Noori"也叫"糯米"。'), []); assert.deepEqual(explicitAliases('"A"并不是也叫"B"。'), []); assert.equal(scriptGroup('English question with 星帆'), 'latin'); assert.equal(scriptGroup('中文角色 Noori 的新名字'), 'han');
});
test('postposed alias denial or uncertainty cannot expand queries, including aliases persisted by an older analyzer', async t => {
  const f = fixture(t), negatives = ['“蓝盒子”也叫“SkyAlias”，但这只是猜测。', '“蓝盒子”也叫“SkyAlias”，其实不是。', '“蓝盒子”也叫“SkyAlias”，尚未确认。', '“蓝盒子”也叫“SkyAlias”，这是错误说法。', '“Blue Box” aka “SkyAlias” is incorrect.', '“Blue Box” aka “SkyAlias” is only a rumor.', '“Blue Box” also known as “SkyAlias”?'];
  for (const text of negatives) assert.deepEqual(explicitAliases(text), [], text);
  const c = f.archive(1, [negatives[0], 'SkyAlias is the silver toolbox.']); await f.history.syncIndex();
  assert.ok(!f.history._queryTerms('蓝盒子', 'current').includes('skyalias')); assert.deepEqual(explicitAliases('“蓝盒子”也叫“SkyAlias”，它是银色工具箱。'), [['蓝盒子', 'skyalias']]);
  const ref = `${c.conversationId}/M1/P01`, row = f.history._open().prepare('SELECT sourceKey FROM refs WHERE ref=?').get(ref);
  f.history._open().prepare('INSERT OR IGNORE INTO aliases VALUES(?,?,?,?)').run('蓝盒子', 'skyalias', ref, row.sourceKey); f.history._open().prepare("INSERT OR REPLACE INTO index_config VALUES('metadata-analyzer','2')").run();
  const updated = await f.history.syncIndex(); assert.equal(updated.indexed, 0); assert.equal(f.history._open().prepare('SELECT COUNT(*) n FROM aliases').get().n, 0); assert.ok(!f.history._queryTerms('蓝盒子', 'current').includes('skyalias'));
});
test('discussion and event filters retain real time meaning and exact quote remains historical after withdrawal', async t => {
  const f = fixture(t), c = f.archive(1, ['旧的灯塔旅行约定']); await f.history.syncIndex();
  f.memory.resolveSource = source => ({ verified: !!f.history.resolveReference(`${source.conversationId}/${source.messageId}/P01`), at: '2026-10-01T12:00:01+08:00' });
  f.memory.commitCheckpoint({ taskId: 'time-source', operationWatermark: f.memory.getState().operationWatermark, baseVersions: { facts: 1 }, sourceWatermark: 'time-source', patches: [{ module: 'facts', action: 'upsert', automatic: false, payload: { entry: { id: 'F-trip', kind: 'fact', content: '灯塔旅行发生于2020年，2026年再次谈起。', event_time: '2020-01-01T00:00:00Z', last_supported_at: '2026-10-01T12:00:01+08:00', sources: [{ type: 'chat', conversationId: c.conversationId, messageId: 'M1', part: 'P01' }] } } }] }); await f.history.syncIndex();
  const event = await f.history.searchRecords({ query: '灯塔', types: ['facts'], timeBasis: 'event', before: '2021-01-01T00:00:00Z' }, f.history.beginTurn()); assert.ok(event.cards.length);
  const discussed = await f.history.searchRecords({ query: '灯塔', types: ['facts'], timeBasis: 'discussion', before: '2021-01-01T00:00:00Z' }, f.history.beginTurn()); assert.equal(discussed.cards.length, 0);
  f.memory.save({ module: 'facts', operationId: 'withdraw-time', baseVersion: 2, action: 'withdraw', payload: { id: 'F-trip' } }); await f.history.syncIndex();
  const current = await f.history.searchRecords('灯塔', f.history.beginTurn()); assert.equal(current.cards.length, 0);
  const quote = await f.history.searchRecords({ query: '灯塔', intent: 'quote' }, f.history.beginTurn()); assert.ok(quote.cards.length); assert.ok(quote.cards.every(card => card.historical));
  const invalid = await f.history.searchRecords({ query: '灯塔', before: 'not-a-date' }, f.history.beginTurn()); assert.equal(invalid.status, 'unavailable'); assert.equal(invalid.reason, 'CHAT_SEARCH_QUERY');
});
test('a formally adopted source repair projects current summary evidence while historical quotes retain immutable wording', async t => {
  const f = fixture(t), wrong = '合成用户喜欢咖啡。', correct = '合成用户不喜欢咖啡。', c = f.archive(1, [correct]), ref = `${c.conversationId}/M1/P01`;
  f.memory.resolveSource = () => ({ verified: true, at: '2026-10-01T12:00:01+08:00' });
  f.memory.commitCheckpoint({ taskId: 'drift-seed', operationWatermark: f.memory.getState().operationWatermark, baseVersions: { facts: 1 }, sourceWatermark: 'drift-source', patches: [{ module: 'facts', action: 'upsert', automatic: false, payload: { entry: { id: 'F-coffee', kind: 'fact', content: wrong, sources: [{ type: 'chat', conversationId: c.conversationId, messageId: 'M1', part: 'P01' }] } } }] });
  const { SummaryTree, digest } = require('../src/chat-summary.cjs'), tree = new SummaryTree({ projectRoot: f.project.root, countTokens: Buffer.byteLength, resolveSource: () => true });
  const published = await tree.publishLeaf({ conversationId: c.conversationId, sourceFingerprint: digest('drift-source'), sourceComplete: true, content: { text: wrong, guide: '旧摘要待回查', entries: [{ text: wrong, refs: [ref] }] } });
  const { HandoffStore } = require('../src/chat-handoff.cjs'), handoff = new HandoffStore({ projectRoot: f.project.root, countTokens: Buffer.byteLength, resolveSource: () => ({ text: correct, role: 'user', time: null }) });
  const recent = handoff.publish({ taskId: 'wrong-short-handoff', sourceWatermark: 'drift-source', operationWatermark: f.memory.getState().operationWatermark, complete: true, summary: wrong, sourceRefs: [ref], originals: [{ ref, text: correct, role: 'user', time: null, unit: 'unicode-code-point', start: 0, end: Array.from(correct).length }] }); await f.history.syncIndex();
  const file = tree.journal.file(`memory/summaries/nodes/${published.leaf}.jsonl`), bytes = fs.readFileSync(file), { entry, ...dependency } = f.memory.maintenanceDependency('F-coffee@1');
  const adopted = f.memory.commitDreamCandidate({ operationId: 'repair-coffee', checkpointId: 'repair-next-cp', dependencies: [dependency], changes: [{ target: 'F-coffee@1', refs: [], kind: 'source-repair', content: correct, verbatim: true, evidenceRefs: [ref], repairSourceRefs: [ref] }] }); assert.equal(adopted.state, 'adopted');
  const reference = `${published.leaf}#I01`; assert.match(f.history.resolveReference(reference, { intent: 'current' }).text, /合成用户不喜欢咖啡/);
  await f.history.syncIndex();
  const current = await f.history.readRecords({ reference, intent: 'current' }, f.history.beginTurn()); assert.match(current.cards[0].text, /合成用户不喜欢咖啡/); assert.doesNotMatch(current.cards[0].text, /合成用户喜欢咖啡/);
  const historical = await f.history.readRecords({ reference, intent: 'quote' }, f.history.beginTurn()); assert.equal(historical.cards[0].text, wrong); assert.deepEqual(fs.readFileSync(file), bytes);
  const recentRef = `${recent.id}@v${recent.version}`, recentBytes = fs.readFileSync(handoff.journal.file('memory/recent/current.jsonl'));
  assert.match(f.history.resolveReference(recentRef, { intent: 'current' }).text, /合成用户不喜欢咖啡/);
  const currentRecent = await f.history.readRecords({ reference: recentRef, intent: 'current' }, f.history.beginTurn()); assert.ok(currentRecent.cards.length, JSON.stringify(currentRecent)); assert.match(currentRecent.cards[0].text, /合成用户不喜欢咖啡/); assert.doesNotMatch(currentRecent.cards[0].text, /合成用户喜欢咖啡/);
  const oldRecent = await f.history.readRecords({ reference: recentRef, intent: 'quote' }, f.history.beginTurn()); assert.equal(oldRecent.cards[0].text, wrong); assert.deepEqual(fs.readFileSync(handoff.journal.file('memory/recent/current.jsonl')), recentBytes);
});
test('continuous checkpoints, actual worker restarts and memory revisions reuse unchanged embeddings', async t => {
  const f = fixture(t, true); let totalNew = 0;
  for (let day = 1; day <= 12; day++) {
    f.archive(day, [`Checkpoint ${day} keeps a different blue notebook in room ${day}.`, `第${day}次记录：合成花园新增第${day}号花盆，尚未开花。`]);
    const result = await f.history.syncIndex({ waitSemantic: true }); totalNew += result.indexed; assert.equal(result.indexed, 2); assert.equal(result.changedFiles, day === 1 ? 4 : 1);
    assert.equal(f.history.health().pendingVectors, 0);
    if (day % 4 === 0) { await f.history.close(); f.open(); const resumed = await f.history.syncIndex({ waitSemantic: true }); assert.equal(resumed.indexed, 0); assert.equal(f.history.health().encodedTextWindows || 0, 0); }
  }
  assert.equal(totalNew, 24);
  f.memory.save({ module: 'facts', operationId: 'stable-memory-1', baseVersion: 1, action: 'upsert', payload: { entry: { id: 'F-stable', kind: 'fact', content: 'A sourced stable memory about a green notebook.' } } }); await f.history.syncIndex({ waitSemantic: true });
  const before = f.history.health().encodedTextWindows || 0;
  f.memory.save({ module: 'facts', operationId: 'another-memory-2', baseVersion: 2, action: 'upsert', payload: { entry: { id: 'F-extra', kind: 'fact', content: 'Another separate memory about the red workshop.' } } }); await f.history.syncIndex({ waitSemantic: true });
  assert.equal((f.history.health().encodedTextWindows || 0) - before, 1, 'a module revision must preserve embeddings of unchanged entry references');
  const a = f.history._open().prepare('SELECT embedding FROM vectors WHERE ref=?').get('F-stable@1'); assert.ok(a.embedding.length);
  await assert.rejects(f.history.rebuildIndex({ isCancelled: () => true }), /CHAT_INDEX_CANCELLED/); const repaired = await f.history.syncIndex({ waitSemantic: true }); assert.equal(repaired.status, 'ready');
  assert.equal(f.history._open().prepare('SELECT embedding FROM vectors WHERE ref=?').get('F-stable@1').embedding.length, a.embedding.length);
});
test('single-language, small bilingual and unsupported-script corpora fall back to original cosine', async t => {
  const f = fixture(t, true); f.archive(1, ['English alpha claim.', 'English beta claim.', 'English gamma claim.', 'English delta claim.', '第一条中文事实。', '第二条中文事实。', '第三条中文事实。']); await f.history.syncIndex({ waitSemantic: true }); assert.equal(f.history.health().semanticRanking, 'cosine');
  f.archive(2, ['第四条中文事实。']); await f.history.syncIndex({ waitSemantic: true }); assert.equal(f.history.health().semanticRanking, 'language-centered-cosine');
  f.archive(3, ['١٢٣٤٥٦٧٨٩']); await f.history.syncIndex({ waitSemantic: true }); assert.equal(f.history.health().semanticRanking, 'cosine');
});
