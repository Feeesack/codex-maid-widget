'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createChatProject } = require('../src/chat-project.cjs');
const { createConversation } = require('../src/chat-archive.cjs');
const { MemoryStore } = require('../src/chat-memory.cjs');
const { createDefaultPersona } = require('../src/chat-persona.cjs');
const { ChatWorkflow } = require('../src/chat-workflow.cjs');
const { LIMITS } = require('../src/chat-policy.cjs');

const measure = text => Buffer.byteLength(text, 'utf8');
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function fixture(t, generate) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'maid-frontier-workflow-'));
  const parentDir = path.join(sandbox, '自定义 中文 folder'); fs.mkdirSync(parentDir);
  const project = createChatProject({ parentDir, userNickname: '隔离测试' });
  const memory = new MemoryStore({ projectRoot: project.root, fs, countTokens: measure });
  memory.initialize({ pet_name: '小龙娘', user_nickname: '隔离测试', persona: createDefaultPersona({ user_nickname: '隔离测试' }) });
  const history = { close() {}, resolveReference: () => false, syncIndex: async () => ({ status: 'ready' }) };
  const runtime = { generate }, workflow = new ChatWorkflow({ projectRoot: project.root, fs, countTokens: measure, runtime, memory, history });
  t.after(async () => {
    await history.close();
    const resolved = fs.realpathSync(path.resolve(sandbox)), relative = path.relative(resolved, project.root);
    assert.equal(fs.realpathSync(path.dirname(parentDir)), resolved); assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  return { project, memory, runtime, workflow };
}
function primeData() {
  const content = { text: '', guide: 'Synthetic source navigation', entries: Array.from({ length: 80 }, (_, index) => ({
    id: `I${String(index + 1).padStart(2, '0')}`, text: `Synthetic detail ${index + 1}`, refs: ['C-synthetic/M000001/P01'] })) };
  content.text = '"'.repeat(Math.floor((LIMITS.node - 500 - measure(JSON.stringify(content))) / 2));
  return { leaf: { ref: 'L1-11111111-1111-1111-1111-111111111111@v1', content }, inputLimit: LIMITS.node, outputLimit: LIMITS.leafPrime };
}
function compactOutput(data) {
  return { text: 'Keep the latest synthetic correction, including its condition.', guide: 'Read the complete L1 entry for the original.',
    entries: [{ text: 'Only after explicit confirmation; the earlier plan remains cancelled.', refs: [`${data.leaf.ref}#I80`] }] };
}

test('leaf-prime generation accepts the full 20K leaf envelope, reserves stable IDs and reuses the paid result', async t => {
  const requests = [], f = fixture(t, async input => {
    requests.push(input); const data = JSON.parse(input.input);
    assert.equal(input.maxOutputTokens, LIMITS.leafPrime - 80 * 16 - 256);
    assert.equal(input.purpose, 'maintenance'); assert.equal(data.inputLimit, LIMITS.node); assert.equal(data.outputLimit, LIMITS.leafPrime);
    return { status: 'completed', finalText: JSON.stringify(compactOutput(data)) };
  });
  const data = primeData(), task = f.workflow.generator.begin({ id: 'prime-envelope', sourceWatermark: 'synthetic-source', operationWatermark: 0 });
  assert.ok(measure(JSON.stringify(data.leaf.content)) <= LIMITS.node);
  const first = await f.workflow._compactLeaf(task, data), repeated = await f.workflow._compactLeaf(task, data);
  assert.deepEqual(first, compactOutput(data)); assert.deepEqual(repeated, first); assert.equal(requests.length, 1);
  assert.deepEqual(JSON.parse(requests[0].input), data); assert.equal(Object.hasOwn(first.entries[0], 'id'), false);
  const saved = f.workflow.generator.task(task.id), [batchId] = Object.keys(saved.batches);
  assert.equal(batchId, `prime-${digest(data).slice(0, 24)}`); assert.equal(saved.used.calls, 1);
  assert.ok(saved.batches[batchId].input > LIMITS.sourceBatch);
  assert.ok(saved.batches[batchId].input <= 2 * LIMITS.node + 8192);
  const changed = { ...data, leaf: { ...data.leaf, content: { ...data.leaf.content, text: `${data.leaf.content.text}new` } } };
  await f.workflow._compactLeaf(task, changed); assert.equal(requests.length, 2);
});

test('completed prime repair is reused after restart without another model dispatch', async t => {
  let requests = 0;
  const f = fixture(t, async () => { requests++; throw new Error('synthetic-unexpected-dispatch'); });
  const data = primeData(), task = f.workflow.generator.begin({ id: 'prime-repair-recovery', sourceWatermark: 'synthetic-source', operationWatermark: 0 });
  const output = compactOutput(data), batchId = `prime-${digest(data).slice(0, 24)}`, artifact = 'memory/maintenance/results/prime-recovery.jsonl';
  f.workflow.journal.write(artifact, { output });
  task.batches[batchId] = { status: 'invalid-output' };
  task.batches[`${batchId}-repair`] = { status: 'completed', artifact, outputDigest: digest(output) };
  task.used.calls = 2; f.workflow.journal.write(`memory/maintenance/generation/${task.id}.jsonl`, task);
  assert.deepEqual(await f.workflow._compactLeaf(task, data), output);
  assert.equal(requests, 0); assert.equal(f.workflow.generator.task(task.id).used.calls, 2);
});

test('unknown prime execution remains charged and cannot be replayed', async t => {
  let requests = 0;
  const f = fixture(t, async () => { requests++; return { status: 'unknown' }; });
  const data = primeData(), task = f.workflow.generator.begin({ id: 'prime-unknown', sourceWatermark: 'synthetic-source', operationWatermark: 0 });
  await assert.rejects(f.workflow._compactLeaf(task, data), { code: 'CHAT_EXECUTION_UNKNOWN' });
  await assert.rejects(f.workflow._compactLeaf(task, data), { code: 'CHAT_EXECUTION_UNKNOWN' });
  assert.equal(requests, 1); assert.equal(f.workflow.generator.task(task.id).used.calls, 1);
});

test('production checkpoints compact the first three leaves and omit the fourth prime when its group closes', async t => {
  const primes = [], parents = [], f = fixture(t, async input => {
    const data = JSON.parse(input.input); let output;
    if (Array.isArray(data.sources)) output = { changes: [], summary: { text: `Synthetic full leaf ${'x'.repeat(7000)}`,
      guide: 'Read the committed synthetic conversation.', entries: [{ text: 'The condition and latest correction remain in the original.', refs: [data.sources[0].ref] }] } };
    else if (data.leaf) {
      primes.push(data); assert.equal(input.maxOutputTokens, LIMITS.leafPrime - 80 * 16 - 256);
      assert.ok(measure(JSON.stringify(data.leaf.content)) > LIMITS.leafPrime);
      output = { text: `Synthetic prime ${primes.length}`, guide: 'Read this complete L1.', entries: [{ text: 'Explicit condition retained.', refs: [`${data.leaf.ref}#I01`] }] };
    } else if (Array.isArray(data.children)) {
      parents.push(data); assert.equal(data.children.length, LIMITS.children);
      output = { text: 'Four complete synthetic leaves are now grouped.', guide: 'Read each direct L1 child.',
        entries: data.children.map(child => ({ text: child.content.entries[0].text, refs: [`${child.ref}#I01`] })) };
    } else if (Array.isArray(data.latest)) output = { text: 'Synthetic recent handoff.', refs: [data.latest.at(-1).ref] };
    else throw new Error('unexpected synthetic generation');
    return { status: 'completed', finalText: JSON.stringify(output) };
  });
  f.runtime.readOwnThread = async (threadId, input) => input ? { threadId, sourceRecoveryVerified: true, complete: true, nextCursor: null,
    data: [{ id: 'turn', status: 'completed', fullItems: true, items: [{ id: 'user', turnId: 'turn', role: 'user', contentComplete: true,
      content: [{ text: `Synthetic conversation ${threadId}: the earlier plan is cancelled unless explicitly renewed.` }] }] }] } : { status: 'idle' };
  for (let index = 1; index <= 4; index++) {
    const conversation = createConversation({ root: f.project.root, startedAt: `2026-10-27T12:00:0${index}+08:00`, timezone: 'Asia/Shanghai', nativeThreadId: `frontier-${index}` });
    const result = await f.workflow.checkpoint({ conversation, cutoffTurnId: 'turn', terminal: 'completed', window: 160000 });
    assert.equal(result.state, 'startup-ready'); assert.equal(primes.length, Math.min(index, 3)); assert.equal(parents.length, index === 4 ? 1 : 0);
    assert.equal(f.workflow.tree.read(result.tree.root).level, 2);
    f.workflow.confirmSwitch({ taskId: result.taskId, newThreadId: `next-${index}`, operationWatermark: result.startup.operationWatermark });
  }
  assert.equal(Object.keys(f.workflow.tree.state().conversations).length, 4);
  assert.equal(new Set(primes.map(prime => prime.leaf.ref)).size, 3);
});
