'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createChatProject } = require('../src/chat-project.cjs');
const { MemoryStore } = require('../src/chat-memory.cjs');
const { ChatHistory } = require('../src/chat-history.cjs');
const { SummaryTree, digest } = require('../src/chat-summary.cjs');

const measure = text => Buffer.byteLength(text, 'utf8');
const nodeRef = node => `${node.id}@v${node.version}`;
function fixture(t) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'maid-history-frontier-'));
  const parentDir = path.join(sandbox, '自定义 中文 folder'); fs.mkdirSync(parentDir);
  const project = createChatProject({ parentDir, userNickname: '隔离历史测试' });
  const memory = new MemoryStore({ projectRoot: project.root, fs, countTokens: measure, resolveSource: () => true });
  memory.initialize({ pet_name: '龙', user_nickname: '隔离历史测试' });
  const tree = new SummaryTree({ projectRoot: project.root, fs, countTokens: measure, resolveSource: () => true });
  const history = new ChatHistory({ projectRoot: project.root, memory, fs, countTokens: measure, worker: false,
    semanticOptions: { resourceRoot: path.join(sandbox, 'explicitly-missing-local-model') } });
  t.after(async () => {
    await history.close();
    const resolved = fs.realpathSync(path.resolve(sandbox)), relative = path.relative(resolved, project.root);
    assert.equal(fs.realpathSync(path.dirname(parentDir)), resolved); assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  return { project, memory, tree, history };
}
function append(tree, index) {
  const conversationId = `C-history-${index}`, text = index === 17 ? 'withdrawnfrontierevidence' : `unrelateddetail${index}`;
  return tree.publishLeaf({ conversationId, sourceFingerprint: digest({ index }), sourceComplete: true,
    content: { text, guide: 'Read the original synthetic source.', entries: [{ text, refs: [`${conversationId}/M1/P01`] }] },
    compact: async data => ({ text: data.leaf.content.text, guide: 'Read the complete L1.',
      entries: [{ text: data.leaf.content.entries[0].text, refs: [`${data.leaf.ref}#I01`] }] }),
    summarize: async data => ({ text: data.children.map(child => child.content.text).join(';'), guide: 'Read each exact direct child.',
      entries: data.children.map(child => ({ text: child.content.text, refs: [`${child.ref}#I01`] })) }) });
}

test('pending root checks excluded provenance through unindexed historical child entries while exact historical quotes remain available', async t => {
  const { memory, tree, history } = fixture(t);
  for (let index = 1; index <= 20; index++) await append(tree, index);
  const formalRoot = tree.read(tree.state().root), historicalChild = tree.read(formalRoot.children[1]);
  assert.equal(formalRoot.level, 4); assert.equal(historicalChild.level, 3);
  const oldRef = `${nodeRef(historicalChild)}#I01`, untouchedRef = `${nodeRef(historicalChild)}#I02`;
  memory.commitCheckpoint({ taskId: 'synthetic-source-memory', operationWatermark: memory.getState().operationWatermark,
    baseVersions: { facts: 1 }, sourceWatermark: 'synthetic-source', patches: [{ module: 'facts', action: 'upsert', automatic: false,
      payload: { entry: { id: 'F-withdrawn', kind: 'fact', content: 'withdrawnfrontierevidence', sources: [{ type: 'chat', conversationId: 'C-history-17', messageId: 'M1', part: 'P01' }] } } }] });
  await history.syncIndex(); assert.ok(history._row(oldRef));
  const result = await append(tree, 21), pendingRoot = tree.read(result.root);
  assert.equal(pendingRoot.status, 0); assert.notEqual(tree.state().active[historicalChild.id], nodeRef(historicalChild));
  const staleRow = history._row(oldRef); assert.ok(staleRow);
  assert.equal(history._effective(staleRow, 'current'), false); assert.equal(history._effective(staleRow, 'quote'), true);
  assert.throws(() => history.resolveReference(oldRef, { intent: 'current' }), { code: 'CHAT_HISTORY_REFERENCE' });
  await history.syncIndex(); assert.equal(history._row(oldRef), null);
  const pendingEntry = pendingRoot.content.entries.find(entry => entry.refs.includes(oldRef)); assert.ok(pendingEntry);
  const pendingRef = `${result.root}#${pendingEntry.id}`, pendingRow = history._row(pendingRef); assert.ok(pendingRow);
  assert.equal(history._effective(pendingRow, 'current'), true); assert.equal(history._sourceRefsEffective([oldRef]), true);
  const oldBytes = fs.readFileSync(history.journal.file(`memory/summaries/nodes/${nodeRef(historicalChild)}.jsonl`));
  memory.save({ module: 'facts', operationId: 'withdraw-synthetic-source', baseVersion: memory.getModule('facts').version,
    action: 'withdraw', payload: { id: 'F-withdrawn' } });
  assert.equal(history._sourceRefsEffective([oldRef]), false); assert.equal(history._sourceRefsEffective([untouchedRef]), true);
  assert.equal(history._effective(pendingRow, 'current'), false);
  assert.throws(() => history.resolveReference(pendingRef, { intent: 'current' }), { code: 'CHAT_HISTORY_REFERENCE' });
  const current = await history.readRecords({ reference: pendingRef, intent: 'current' }, history.beginTurn()); assert.deepEqual(current.cards, []);
  const search = await history.searchRecords({ queries: ['withdrawnfrontierevidence'], types: ['summary'], intent: 'current' }, history.beginTurn());
  assert.deepEqual(search.cards, []);
  for (const intent of ['history', 'quote']) {
    assert.match(history.resolveReference(pendingRef, { intent }).text, /withdrawnfrontierevidence/);
    assert.match(history.resolveReference(oldRef, { intent }).text, /withdrawnfrontierevidence/);
    const read = await history.readRecords({ reference: oldRef, intent }, history.beginTurn());
    assert.equal(read.cards.length, 1); assert.match(read.cards[0].text, /withdrawnfrontierevidence/);
  }
  let nativeReads = 0; history.getNative = async () => { nativeReads++; return { status: 'ready', cards: [] }; };
  const quoted = await history.tools(history.beginTurn())({ name: 'read_record', arguments: { reference: oldRef, intent: 'quote' } });
  assert.equal(quoted.cards.length, 1); assert.equal(nativeReads, 0);
  assert.deepEqual(fs.readFileSync(history.journal.file(`memory/summaries/nodes/${nodeRef(historicalChild)}.jsonl`)), oldBytes);
});

test('fallback validates the saved node identity and actual entry instead of accepting missing or fabricated summary provenance', t => {
  const { tree, history } = fixture(t);
  const id = 'L1-11111111-1111-1111-1111-111111111111', reference = `${id}@v1`, missing = 'L1-22222222-2222-2222-2222-222222222222@v1';
  const node = { id, version: 1, level: 1, children: [], leaves: 1,
    content: { text: 'Exact isolated historical detail.', guide: 'Read its synthetic source.', entries: [{ id: 'I01', text: 'Exact isolated historical detail.', refs: ['C-synthetic/M1/P01'] }] } };
  history.journal.write(`memory/summaries/nodes/${reference}.jsonl`, node);
  assert.equal(history._sourceRefsEffective([`${reference}#I01`]), true);
  assert.equal(history._sourceRefsEffective([`${reference}#I999`]), false);
  assert.equal(history._sourceRefsEffective([`${missing}#I01`]), false);
  assert.throws(() => history.resolveReference(`${reference}#I999`, { intent: 'history' }), { code: 'CHAT_HISTORY_REFERENCE' });
  assert.throws(() => history.resolveReference(`${reference}#I01`, { intent: 'current' }), { code: 'CHAT_HISTORY_REFERENCE' });
  assert.equal(history.resolveReference(`${reference}#I01`, { intent: 'quote' }).text, node.content.entries[0].text);
  history.journal.write(`memory/summaries/nodes/${missing}.jsonl`, node);
  assert.equal(history._sourceRefsEffective([`${missing}#I01`]), false);
  assert.throws(() => history.resolveReference(`${missing}#I01`, { intent: 'history' }), { code: 'CHAT_HISTORY_REFERENCE' });
  assert.equal(tree.state().root, null);
});
