'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const { createChatProject } = require('../src/chat-project.cjs');
const { MemoryStore } = require('../src/chat-memory.cjs');
const { createDefaultPersona } = require('../src/chat-persona.cjs');
const { ChatWorkflow, CHECKPOINT_BATCH } = require('../src/chat-workflow.cjs');
const { validate } = require('../src/chat-generation.cjs');
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function fixture(t, entries = []) {
  const isolated = fs.mkdtempSync(path.join(os.tmpdir(), 'maid-dream-semantic-中文 空格 ')), home = path.join(isolated, 'home'), parent = path.join(isolated, '自定义目录');
  fs.mkdirSync(home); fs.mkdirSync(parent); const project = createChatProject({ parentDir: parent, userNickname: '合成用户' });
  const measure = value => Buffer.byteLength(value), now = Date.parse('2026-10-27T01:00:00Z'), sources = new Map();
  const memory = new MemoryStore({ projectRoot: project.root, countTokens: measure, clock: () => new Date(now).toISOString(), resolveSource: source => ({ verified: true,
    eventId: `event-${source.conversationId}`, originalTurnId: `turn-${source.conversationId}`, complete: true, at: '2026-10-26T12:00:00Z', localDate: '2026-10-26' }) });
  memory.initialize({ pet_name: '合成桌宠', user_nickname: '合成用户', persona: createDefaultPersona({ user_nickname: '合成用户' }) });
  const refs = [];
  const patches = entries.map((input, index) => {
    const { module = 'facts', sourceText = input.content, ...entry } = input, conversationId = `C-synthetic-${index + 1}`, source = { type: 'chat', conversationId, messageId: 'M1', part: 'P01' };
    const ref = `${conversationId}/M1/P01`, file = path.join(isolated, `source-${index}.jsonl`);
    fs.writeFileSync(file, JSON.stringify({ role: 'user', content: [{ text: sourceText }] }) + '\n'); sources.set(ref, { file, text: sourceText }); refs.push(ref);
    return { module, action: 'upsert', automatic: false, payload: { entry: { certainty: 'explicit', ...entry, sources: [source] } } };
  });
  if (patches.length) memory.commitCheckpoint({ taskId: 'synthetic-seed', baseVersions: { persona: 1, userView: 1, facts: 1 }, operationWatermark: memory.getState().operationWatermark, sourceWatermark: 'isolated-sources', patches });
  let calls = 0, output, lastInput;
  const environment = { foreground: false, maintenance: false, recovering: false, drafts: false, lastInputAt: now - 1800001 };
  const runtime = { quotaObservation: async () => ({ authType: 'chatgpt', windowMinutes: 300, scope: 'synthetic-quota-scope', windowId: 'synthetic-window', observedAt: now, remaining: 80 - calls, weekBlocked: false }),
    generate: async input => { calls++; lastInput = input; assert.equal(input.purpose, 'dream'); assert.equal(input.maxOutputTokens, 2000); assert.equal(input.timeoutMs, 120000); assert.ok(measure(JSON.stringify({ instructions: input.instructions, input: input.input, outputSchema: input.outputSchema })) <= 6600); input.dreamPermit.guard();
      input.onEvent({ type: 'locator', threadId: 'synthetic-dream-thread', turnId: 'synthetic-dream-turn' });
      return { status: 'completed', finalText: JSON.stringify(typeof output === 'function' ? output(JSON.parse(input.input)) : output) }; } };
  const history = { close() {}, syncIndex: async () => ({ status: 'ready' }), resolveReference: (reference, options) => {
    assert.ok(options.maxBytes <= 2048); const source = sources.get(reference); if (!source) throw new Error('missing synthetic source');
    const text = JSON.parse(fs.readFileSync(source.file, 'utf8')).content[0].text; if (Buffer.byteLength(text) > options.maxBytes) throw new Error('bounded-source-too-large');
    return { ref: reference, text, role: 'user', start: 0, end: Array.from(text).length, committed: true };
  } };
  const workflow = new ChatWorkflow({ projectRoot: project.root, memory, runtime, history, countTokens: measure, clock: () => now, getDreamEnvironment: () => environment });
  t.after(() => { workflow.close(); fs.rmSync(isolated, { recursive: true, force: true }); });
  return { isolated, project, memory, workflow, runtime, sources, refs, environment, measure, now, get calls() { return calls; }, get lastInput() { return lastInput; },
    output(value) { output = value; }, signal({ kind = 'distributed', topic = '合成跨检查点整理', targets } = {}) {
      return workflow.dreamCatalog.recordSignals({ checkpointId: 'synthetic-checkpoint', sourceWatermark: 'synthetic-source', allowedSources: new Set(refs), signals: [{ kind, topic, targets, sources: [refs[0]] }] });
    } };
}
const dependency = (f, ref) => { const { entry, ...value } = f.memory.maintenanceDependency(ref); return value; };
function change(target, refs, content, kind = 'organize') { return { target, refs, content, kind, evidenceRefs: ['C-synthetic-1/M1/P01'] }; }

test('catalogue rotates past 64 across every module and prioritizes a sourced important item outside the first page', t => {
  const entries = Array.from({ length: 140 }, (_, index) => ({ id: `F-item${index}`, kind: 'fact', content: `合成对象${index}的信息。`, ...(index === 129 ? { importance: { category: 'user_marked', sourceRefs: ['C-synthetic-130/M1/P01'] } } : {}) }));
  entries.push({ module: 'userView', id: 'V-view', kind: 'preference', content: '合成用户喜欢有条理的说明。' });
  const f = fixture(t, entries), original = f.memory.scanMaintenance.bind(f.memory), visited = []; f.memory.scanMaintenance = input => { assert.equal(input.limit, 48); const result = original(input); visited.push(result.entries.length); return result; };
  for (let i = 0; i < 4; i++) f.workflow.dreamCatalog.scan({ pages: 4 });
  const health = f.workflow.dreamCatalog.health(); assert.equal(health.scanComplete, true); assert.equal(health.catalogued, 141); assert.ok(Math.max(...visited) <= 48);
  const task = f.workflow._dreamTask('organize', 'manual'); assert.ok(task.entryRefs.includes('F-item129@1')); assert.ok(f.workflow.dreamCatalog.state().queue.length <= 192);
});

test('spent high-priority tasks do not permanently starve the final items in the bounded 192-entry comparison window', t => {
  const { hash } = require('../src/chat-dream-catalog.cjs'), f = fixture(t, Array.from({ length: 192 }, (_, index) => ({ id: `F-queue${String(index).padStart(3, '0')}`, kind: 'fact', content: `合成独立事项${index}。` })));
  const entries = Object.fromEntries(f.memory.getModule('facts').entries.map((entry, index) => [entry.id, { module: 'facts', ref: `${entry.id}@1`, terms: [], objects: [], sources: [f.refs[index]], importance: 'normal', seenAt: 0 }]));
  f.workflow.dreamCatalog.scan = () => ({ entries, queue: Object.keys(entries), signals: [] });
  const jobs = Object.values(entries).slice(0, 128).map(item => ({ calls: 1, sourceWatermark: hash({ targets: [item.ref.split('@')[0]], sources: item.sources }) }));
  const task = f.workflow.dreamCatalog.select({ mode: 'manual', target: 'organize', jobs }); assert.equal(task.entryRefs[0], 'F-queue128@1');
});
test('lexical resemblance alone never authorizes an automatic paid maintenance task', async t => {
  const f = fixture(t, [{ id: 'F-a', kind: 'fact', content: '合成猫桃子喜欢安静。' }, { id: 'F-b', kind: 'fact', content: '合成猫桃子使用皇家糖罐。' }]);
  f.workflow.journal.write('memory/dreaming/schedule.jsonl', { checkpoints: 8, seen: [], initializedAt: f.now - 8 * 86400000 });
  const result = await f.workflow.dream({ action: 'automatic' }); assert.equal(result.state, 'no-work'); assert.equal(f.calls, 0);
  assert.equal(f.signal({ targets: ['F-a@1', 'F-b@1'] }).recorded, 1);
  f.output(data => ({ text: '关联两项合成资料。', changes: [{ target: 'F-a@1', kind: 'link', content: '合成猫桃子喜欢安静。', refs: ['F-b@1'], evidence: data.evidence.filter(item => item.kind === 'original').map(item => item.id) }] }));
  const paid = await f.workflow.dream({ action: 'automatic' }); assert.equal(paid.state, 'candidate'); assert.equal(f.calls, 1); assert.equal(paid.job.mode, 'automatic');
});
test('optional same-request checkpoint signals are backward compatible and unresolvable signals are rejected', t => {
  const f = fixture(t, [{ id: 'F-a', kind: 'fact', content: '合成旧记录。' }]);
  const legacy = { changes: [], summary: { text: '合成', guide: '原文', entries: [{ text: '合成', refs: ['C-synthetic-1/M1/P01'] }] } };
  assert.equal(validate(legacy, CHECKPOINT_BATCH), legacy);
  assert.equal(f.workflow.dreamCatalog.recordSignals({ checkpointId: 'cp', sourceWatermark: 's', allowedSources: new Set(f.refs), signals: [{ kind: 'drift', topic: 'invalid', targets: ['F-a@1'], sources: ['C-other/M1/P01'] }] }).recorded, 0);
  assert.equal(f.workflow.dreamCatalog.recordSignals({ checkpointId: 'cp', sourceWatermark: 's', allowedSources: new Set(f.refs), signals: [{ kind: 'drift', topic: 'invalid', targets: ['F-missing@1'], sources: f.refs }] }).recorded, 0);
});
test('a structured cross-module candidate appends formal versions at the next checkpoint and preserves original bytes and historical content', async t => {
  const f = fixture(t, [{ id: 'F-cat', kind: 'fact', content: '合成猫叫桃子。' }, { module: 'userView', id: 'V-quiet', kind: 'preference', content: '合成用户喜欢安静。' }]);
  const before = [...f.sources.values()].map(source => digest(fs.readFileSync(source.file))), oldVersion = f.memory.getModule('facts').version;
  f.output(data => ({ text: '组织猫的资料并关联交流偏好。', changes: [{ target: 'F-cat@1', kind: 'organize', content: '合成猫叫桃子，交流时照顾用户喜欢安静的偏好。', refs: ['V-quiet@1'], evidence: data.evidence.filter(value => value.kind === 'original').map(value => value.id) }] }));
  const candidate = await f.workflow.dream({ action: 'run', target: 'organize' }); assert.equal(candidate.state, 'candidate'); assert.equal(f.memory.getModule('facts').version, oldVersion);
  assert.deepEqual(candidate.candidates[0].scope.modules.sort(), ['facts', 'userView']); assert.equal(candidate.candidates[0].scope.checkpoints, 2);
  await f.workflow._adoptDreams({ id: 'synthetic-next-checkpoint' });
  const current = f.memory.getModule('facts'); assert.equal(current.version, oldVersion + 1); assert.equal(current.entries[0].rev, 2); assert.match(current.entries[0].content, /照顾用户/); assert.ok(current.entries[0].memory_links.includes('V-quiet@1'));
  assert.equal(current.entries[0].last_supported_at, f.memory.revision('facts', oldVersion).snapshot.entries[0].recorded_at);
  assert.equal(f.memory.revision('facts', oldVersion).snapshot.entries[0].content, '合成猫叫桃子。');
  assert.deepEqual([...f.sources.values()].map(source => digest(fs.readFileSync(source.file))), before); assert.equal(f.calls, 1);
  const after = f.workflow.dreamSnapshot(); assert.equal(after.job.status, 'adopted'); assert.equal(after.benefit.adoptedChanges, 1); assert.equal(after.benefit.semanticBenefitVerified, false);
});
test('local dependency CAS reuses a candidate after unrelated saves and partially adopts independent valid changes', t => {
  const f = fixture(t, [{ id: 'F-a', kind: 'fact', content: '合成猫叫桃子。' }, { id: 'F-b', kind: 'fact', content: '合成糖罐放在厨房。' }]);
  const dependencies = [dependency(f, 'F-a@1'), dependency(f, 'F-b@1')], baseline = f.memory.getModule('facts');
  f.memory.save({ module: 'facts', baseVersion: baseline.version, operationId: 'unrelated', action: 'upsert', payload: { entry: { id: 'F-other', kind: 'fact', content: '合成无关条目。' } } });
  const reusable = f.memory.commitDreamCandidate({ operationId: 'D-reuse', checkpointId: 'cp1', dependencies: [dependencies[0]], changes: [change('F-a@1', [], '合成猫的名字是桃子。')] });
  assert.equal(reusable.state, 'adopted'); assert.equal(f.memory.getModule('facts').entries.find(entry => entry.id === 'F-other').content, '合成无关条目。');
  const nextDeps = [dependency(f, 'F-a@2'), dependency(f, 'F-b@1')]; f.memory.save({ module: 'facts', baseVersion: f.memory.getModule('facts').version, operationId: 'withdraw-second', action: 'withdraw', payload: { id: 'F-b' } });
  const partial = f.memory.commitDreamCandidate({ operationId: 'D-partial', checkpointId: 'cp2', dependencies: nextDeps, changes: [change('F-a@2', [], '合成猫名为桃子。'), change('F-b@1', [], '合成糖罐在厨房。')] });
  assert.equal(partial.state, 'partial'); assert.equal(partial.applied.length, 1); assert.equal(partial.invalidated.length, 1);
  const beforeRevision = f.memory.getState().revision, retry = f.memory.commitDreamCandidate({ operationId: 'D-partial', checkpointId: 'cp2', dependencies: nextDeps, changes: [change('F-a@2', [], '合成猫名为桃子。'), change('F-b@1', [], '合成糖罐在厨房。')] });
  assert.equal(retry.duplicate, true); assert.equal(f.memory.getState().revision, beforeRevision); assert.equal(f.memory.filterEvidence('F-b@1').allowed, false);
});
test('canonical links require exact claims with identical scope and never delete original records or infer equivalence from similar words', t => {
  const f = fixture(t, [{ id: 'F-a', kind: 'fact', content: '合成猫叫桃子。' }, { id: 'F-b', kind: 'fact', content: '合成猫叫桃子。' }, { id: 'F-c', kind: 'fact', content: '合成猫不叫桃子。' }]);
  const dependencies = ['F-a@1', 'F-b@1', 'F-c@1'].map(ref => dependency(f, ref));
  const same = f.memory.commitDreamCandidate({ operationId: 'D-canonical', checkpointId: 'cp', dependencies, changes: [change('F-b@1', ['F-a@1'], '合成猫叫桃子。', 'canonical'), change('F-c@1', ['F-a@1'], '合成猫不叫桃子。', 'canonical')] });
  assert.equal(same.state, 'partial'); assert.equal(f.memory.getModule('facts').entries.length, 3); assert.equal(f.memory.currentFacts().entries.length, 2);
  assert.equal(f.memory.getModule('facts').entries.find(entry => entry.id === 'F-b').canonical_ref, 'F-a@1'); assert.equal(f.memory.getModule('facts').entries.find(entry => entry.id === 'F-c').canonical_ref, undefined);
});
test('source repair is exact visible user evidence and late changes to that evidence block adoption', async t => {
  const f = fixture(t, [{ id: 'F-wrong', kind: 'fact', content: '合成用户喜欢咖啡。', sourceText: '合成用户不喜欢咖啡。' }]);
  f.output(data => ({ text: '用原话纠正合成表达漂移。', changes: [{ target: 'F-wrong@1', kind: 'source-repair', content: '合成用户不喜欢咖啡。', refs: [], evidence: [data.evidence.find(value => value.kind === 'original').id] }] }));
  assert.equal((await f.workflow.dream({ action: 'run', target: 'organize' })).state, 'candidate'); await f.workflow._adoptDreams({ id: 'repair-cp' }); assert.equal(f.memory.getModule('facts').entries[0].content, '合成用户不喜欢咖啡。');
  const g = fixture(t, [{ id: 'F-wrong', kind: 'fact', content: '合成用户喜欢咖啡。', sourceText: '合成用户不喜欢咖啡。' }]);
  g.output(data => ({ text: '修复', changes: [{ target: 'F-wrong@1', kind: 'source-repair', content: '合成用户不喜欢咖啡。', refs: [], evidence: [data.evidence[0].id] }] }));
  await g.workflow.dream({ action: 'run', target: 'organize' }); const source = [...g.sources.values()][0]; fs.writeFileSync(source.file, JSON.stringify({ content: [{ text: '已经被改变的合成原件。' }] }) + '\n');
  await g.workflow._adoptDreams({ id: 'changed-source-cp' }); assert.equal(g.workflow.dreamSnapshot().job.status, 'discarded'); assert.equal(g.memory.getModule('facts').entries[0].rev, 1);
});
test('negative conditions and numbers remain protected and a budget-sized candidate cannot silently overwrite user boundaries', t => {
  const f = fixture(t, [{ id: 'F-rule', kind: 'agreement', content: '合成约定：不在晚上23点讨论工作。' }, { module: 'userView', id: 'V-boundary', kind: 'boundary', content: '合成边界：不要催促。' }]);
  const deps = ['F-rule@1', 'V-boundary@1'].map(ref => dependency(f, ref));
  const result = f.memory.commitDreamCandidate({ operationId: 'D-protected', checkpointId: 'cp', dependencies: deps, changes: [change('F-rule@1', [], '合成约定：可以一直讨论工作。'), change('V-boundary@1', [], '合成边界取消。')] });
  assert.equal(result.state, 'discarded'); assert.equal(result.applied.length, 0); assert.equal(f.memory.getModule('facts').entries[0].rev, 1); assert.match(f.memory.getModule('userView').entries[0].content, /不要催促/);
});
test('single-call candidate/output/source limits fail closed without a model repair request', async t => {
  const f = fixture(t, [{ id: 'F-a', kind: 'fact', content: '合成资料。' }]);
  f.output(data => ({ text: 'x'.repeat(2100), changes: [{ target: 'F-a@1', kind: 'organize', content: '合成资料。', refs: [], evidence: [data.evidence[0].id] }] }));
  const result = await f.workflow.dream({ action: 'run', target: 'organize' }); assert.equal(result.state, 'failed'); assert.equal(f.calls, 1); assert.equal(result.job.calls, 1);
  await f.workflow.dream({ action: 'run', target: 'duplicates' }); assert.equal(f.calls, 1);
});
test('holdout comparison records structural deduplication and exact repair gains without calling those proof of long-term semantic quality', async t => {
  const f = fixture(t, [{ id: 'F-a', kind: 'fact', content: '合成猫叫桃子。' }, { id: 'F-b', kind: 'fact', content: '合成猫叫桃子。' }, { id: 'F-c', kind: 'fact', content: '合成用户喜欢咖啡。', sourceText: '合成用户不喜欢咖啡。' }]);
  const before = f.memory.currentFacts().entries, dependencies = ['F-a@1', 'F-b@1', 'F-c@1'].map(ref => dependency(f, ref));
  const result = f.memory.commitDreamCandidate({ operationId: 'D-holdout', checkpointId: 'cp', dependencies, changes: [change('F-b@1', ['F-a@1'], '合成猫叫桃子。', 'canonical'), { ...change('F-c@1', [], '合成用户不喜欢咖啡。', 'source-repair'), verbatim: true }] });
  const after = f.memory.currentFacts().entries; assert.equal(before.filter(entry => entry.content === '合成猫叫桃子。').length, 2); assert.equal(after.filter(entry => entry.content === '合成猫叫桃子。').length, 1);
  assert.equal(after.find(entry => entry.id === 'F-c').content, '合成用户不喜欢咖啡。'); assert.equal(result.applied.length, 2); assert.equal(f.memory.getModule('facts').entries.length, 3);
  t.diagnostic(JSON.stringify({ sample: 'synthetic-holdout', beforeDuplicateItems: 1, afterDuplicateItems: 0, exactSourceRepair: 1, originalEntriesRetained: 3, semanticBenefitVerified: false }));
});

test('formal revision invalidates old preinput and cross-module derived assertions without excluding original sources', async t => {
  const f = fixture(t, [{ id: 'F-a', kind: 'fact', content: '合成猫叫桃子。' }, { module: 'userView', id: 'V-derived', kind: 'overall', content: '合成旧总体印象。', dependsOn: ['F-a@1'] }]);
  for (const module of ['facts', 'userView']) {
    const value = f.memory.getModule(module);
    assert.equal(f.memory.publishPreinput({ module, baseVersion: value.version, segments: value.entries.map(entry => ({ kind: entry.kind, text: entry.content, refs: [`${entry.id}@${entry.rev}`] })) }).ready, true);
  }
  const result = f.memory.commitDreamCandidate({ operationId: 'D-derived', checkpointId: 'cp', dependencies: [dependency(f, 'F-a@1')], changes: [change('F-a@1', [], '合成猫的名字是桃子。')] });
  assert.deepEqual(result.invalidatedDerived, ['V-derived@1']);
  const facts = f.memory.getModule('facts'), view = f.memory.getModule('userView');
  assert.notEqual(facts.preinput.sourceVersion, facts.version); assert.equal(facts.preinput.segments.length, 0); assert.equal(view.preinput.segments.length, 0);
  assert.equal(view.entries[0].status, 'needs_review'); assert.equal(facts.exclusions.length, 0); assert.equal(f.memory.filterEvidence('F-a@1').allowed, false); assert.equal(f.memory.filterEvidence('F-a@2').allowed, true);
  let rebuilt = 0;
  f.workflow._generate = async (_job, _batch, _stage, _instruction, input) => { rebuilt++; return { segments: input.entries.map(value => { const entry = JSON.parse(value.text); return { kind: entry.kind, text: entry.content, refs: [value.ref] }; }) }; };
  await f.workflow._views({ id: 'rebuild-synthetic-views' }); assert.equal(rebuilt, 2);
  assert.equal(f.memory.getModule('facts').preinput.sourceVersion, facts.version); assert.match(JSON.stringify(f.memory.getModule('facts').preinput), /F-a@2/); assert.doesNotMatch(JSON.stringify(f.memory.getModule('facts').preinput), /F-a@1/);
});

test('canonical equivalence includes object, status, time, speaker and source nature; editing an alias makes it visible again', t => {
  const fields = { subject: '另一对象', status: 'conflict', source_nature: 'report', speaker: 'assistant', target_date: '2026-12-01', followup: 'unknown' };
  for (const [field, value] of Object.entries(fields)) {
    const f = fixture(t, [{ id: 'F-a', kind: 'fact', content: '相同合成表达。' }, { id: 'F-b', kind: 'fact', content: '相同合成表达。', [field]: value }]);
    const result = f.memory.commitDreamCandidate({ operationId: `D-field-${field}`, checkpointId: 'cp', dependencies: ['F-a@1', 'F-b@1'].map(ref => dependency(f, ref)), changes: [change('F-b@1', ['F-a@1'], '相同合成表达。', 'canonical')] });
    assert.equal(result.state, 'discarded', field);
  }
  const f = fixture(t, [{ id: 'F-a', kind: 'fact', content: '合成猫叫桃子。' }, { id: 'F-b', kind: 'fact', content: '合成猫叫桃子。' }]);
  f.memory.commitDreamCandidate({ operationId: 'D-alias', checkpointId: 'cp', dependencies: ['F-a@1', 'F-b@1'].map(ref => dependency(f, ref)), changes: [change('F-b@1', ['F-a@1'], '合成猫叫桃子。', 'canonical')] });
  assert.equal(f.memory.currentFacts().entries.length, 1);
  f.memory.save({ module: 'facts', baseVersion: f.memory.getModule('facts').version, operationId: 'edit-alias', action: 'upsert', payload: { entry: { id: 'F-b', kind: 'fact', content: '合成狗叫糖果。' } } });
  assert.equal(f.memory.currentFacts().entries.length, 2);
});

test('evidence checks are local to each change and unrelated handoff changes do not discard independent work', async t => {
  const f = fixture(t, [{ id: 'F-a', kind: 'fact', content: '合成猫叫桃子。' }, { id: 'F-b', kind: 'fact', content: '合成糖罐放在厨房。' }]);
  f.signal({ targets: ['F-a@1', 'F-b@1'] });
  f.output(data => ({ text: '分别整理两项。', changes: data.entries.map(entry => ({ target: entry.ref, kind: 'organize', content: entry.content, refs: [], evidence: [data.evidence.find(value => value.supports.includes(entry.ref) && value.kind === 'original').id] })) }));
  assert.equal((await f.workflow.dream({ action: 'run', target: 'organize' })).state, 'candidate');
  const job = f.workflow.dreams.state().jobs.at(-1), candidatePath = `memory/dreaming/candidates/${job.id}.jsonl`, candidate = f.workflow.journal.read(candidatePath);
  candidate.evidence.push({ id: 'E-unused', ref: 'S-no-longer-current@v1', kind: 'handoff', hash: 'unrelated', supports: ['F-a@1'] }); f.workflow.journal.write(candidatePath, candidate);
  fs.writeFileSync([...f.sources.values()][1].file, JSON.stringify({ content: [{ text: '改变的第二来源。' }] }));
  await f.workflow._adoptDreams({ id: 'local-evidence-cp' });
  const after = f.workflow.dreamSnapshot(); assert.equal(after.job.adoption.state, 'partial'); assert.equal(after.job.adoption.applied.length, 1); assert.equal(after.job.adoption.invalidated.length, 1);
  assert.equal(f.memory.getModule('facts').entries.find(entry => entry.id === 'F-a').rev, 2); assert.equal(f.memory.getModule('facts').entries.find(entry => entry.id === 'F-b').rev, 1);
});

test('source repair cannot borrow a different dependency user quote and empty public benefit has no observation claim', async t => {
  const f = fixture(t, [{ id: 'F-a', kind: 'fact', content: '合成猫叫桃子。' }, { id: 'F-b', kind: 'fact', content: '合成糖罐在厨房。' }]);
  assert.equal(f.workflow.dreamSnapshot().benefit.sample, 'none'); f.signal({ targets: ['F-a@1', 'F-b@1'] });
  f.output(data => ({ text: '错误借用别的来源。', changes: [{ target: 'F-a@1', refs: ['F-b@1'], kind: 'source-repair', content: '合成糖罐在厨房。', evidence: [data.evidence.find(value => value.ref === f.refs[1]).id] }] }));
  const result = await f.workflow.dream({ action: 'run', target: 'organize' }); assert.equal(result.state, 'failed'); assert.match(result.job.reason, /^CHAT_DREAM_(?:REPAIR_NOT_VERBATIM|EVIDENCE_SCOPE)$/); assert.equal(f.memory.getModule('facts').entries[0].rev, 1);
});

test('ordinary management and model extraction cannot forge internal canonical and maintenance metadata', t => {
  const f = fixture(t, [{ id: 'F-a', kind: 'fact', content: '合成记录。' }]);
  for (const field of ['canonical_ref', 'memory_links', 'maintenance']) {
    const entry = { id: 'F-b', kind: 'fact', content: '合成记录。', [field]: field === 'canonical_ref' ? 'F-a@1' : field === 'memory_links' ? ['F-a@1'] : { jobId: 'fake' } };
    assert.throws(() => f.memory.save({ module: 'facts', baseVersion: f.memory.getModule('facts').version, operationId: `forge-save-${field}`, action: 'upsert', payload: { entry } }), { code: 'MEMORY_INPUT' });
    assert.throws(() => f.memory.commitCheckpoint({ taskId: `forge-model-${field}`, baseVersions: { persona: 1, userView: 1, facts: f.memory.getModule('facts').version },
      operationWatermark: f.memory.getState().operationWatermark, sourceWatermark: 'forged', patches: [{ module: 'facts', action: 'upsert', automatic: false,
        payload: { entry: { ...entry, sources: [{ type: 'chat', conversationId: 'C-synthetic-1', messageId: 'M1', part: 'P01' }] } } }] }), { code: 'MEMORY_INPUT' });
  }
  assert.equal(f.memory.getModule('facts').entries.length, 1);
});

test('a verified new checkpoint source is bounded material for its matching drift signal without pretending another claim is evidence', async t => {
  const f = fixture(t, [{ id: 'F-a', kind: 'fact', content: '合成用户喜欢咖啡。' }]);
  const ref = 'C-synthetic-new/M1/P01', file = path.join(f.isolated, 'new-source.jsonl');
  fs.writeFileSync(file, JSON.stringify({ content: [{ text: '合成用户不喜欢咖啡。' }] })); f.sources.set(ref, { file });
  f.workflow.dreamCatalog.recordSignals({ checkpointId: 'new-cp', sourceWatermark: 'new', allowedSources: new Set([ref]), signals: [{ kind: 'drift', topic: '同一表达新增否定纠正', targets: ['F-a@1'], sources: [ref] }] });
  const task = await f.workflow.dreamCatalog.materialize(f.workflow._dreamTask('organize', 'manual')), evidence = task.evidence.find(item => item.ref === ref);
  assert.ok(evidence); assert.deepEqual(evidence.supports, ['F-a@1']);
  const candidate = f.workflow._semanticDreamCandidate({ text: '原文纠偏', changes: [{ target: 'F-a@1', kind: 'source-repair', content: '合成用户不喜欢咖啡。', refs: [], evidence: [evidence.id] }] }, task);
  assert.equal(candidate.changes[0].kind, 'source-repair');
  f.memory.commitDreamCandidate({ operationId: 'D-new-source', checkpointId: 'new-cp', dependencies: candidate.dependencies, changes: candidate.changes });
  assert.ok(f.memory.getModule('facts').entries[0].sources.some(source => source.conversationId === 'C-synthetic-new'));
  assert.deepEqual(f.workflow._summaryCorrections()[0].sourceRefs.sort(), [ref, f.refs[0]].sort());
});

test('the real next checkpoint uses repaired summary projection for startup and pending leaf compaction without a second dream request', async t => {
  const { createConversation } = require('../src/chat-archive.cjs'), { digest: treeDigest } = require('../src/chat-summary.cjs');
  const f = fixture(t, [{ id: 'F-coffee', kind: 'fact', content: '合成用户喜欢咖啡。', sourceText: '合成用户不喜欢咖啡。' }]), wrong = '合成用户喜欢咖啡。', correct = '合成用户不喜欢咖啡。';
  f.workflow.sources.set(f.refs[0], { text: correct, role: 'user', time: null });
  const old = await f.workflow.tree.publishLeaf({ conversationId: 'C-synthetic-1', sourceFingerprint: treeDigest('synthetic-old'), sourceComplete: true, content: { text: wrong, guide: '旧表达', entries: [{ text: wrong, refs: f.refs }] } });
  const originalFile = path.join(f.project.root, 'memory', 'summaries', 'nodes', `${old.leaf}.jsonl`), originalHash = digest(fs.readFileSync(originalFile));
  const seedHandoff = f.workflow.handoff.publish({ taskId: 'synthetic-old-handoff', baseVersion: 0, sourceWatermark: 'old-source', operationWatermark: f.memory.getState().operationWatermark, summary: wrong,
    originals: [{ ref: f.refs[0], role: 'user', time: null, unit: 'unicode-code-point', start: 0, end: Array.from(correct).length, excerpt: false, text: correct }], sourceRefs: f.refs, complete: true });
  const handoffOriginalBytes = fs.readFileSync(path.join(f.project.root, 'memory', 'recent', 'current.jsonl'));
  f.output(data => ({ text: '同一原话否定纠偏', changes: [{ target: 'F-coffee@1', kind: 'source-repair', content: correct, refs: [], evidence: [data.evidence.find(item => item.kind === 'original').id] }] }));
  assert.equal((await f.workflow.dream({ action: 'run', target: 'organize' })).state, 'candidate');
  let ordinary = 0, parentSeen = false, repairedPrimeSeen = false;
  const conversation = createConversation({ root: f.project.root, startedAt: '2026-10-27T02:00:00Z', timezone: 'Asia/Shanghai', nativeThreadId: 'synthetic-next-native' }), ref = `${conversation.conversationId}/M000001/P01`;
  f.runtime.readOwnThread = async (_id, input) => input ? { threadId: conversation.nativeThreadId, sourceRecoveryVerified: true, complete: true, nextCursor: null, data: [{ id: 'synthetic-next-turn', status: 'completed', fullItems: true, items: [{ id: 'synthetic-next-user', turnId: 'synthetic-next-turn', role: 'user', contentComplete: true, content: [{ text: '合成问候。' }] }] }] } : { status: 'idle' };
  f.runtime.generate = async input => {
    ordinary++; const data = JSON.parse(input.input); let output;
    if (input.instructions.includes('提取明确事实')) { assert.equal(data.memory.facts.entries[0].ref, 'F-coffee@1'); assert.ok(input.outputSchema.required.includes('maintenanceSignals')); output = { changes: [], maintenanceSignals: [], summary: { text: '合成问候。', guide: '问候原文', entries: [{ text: '合成问候。', refs: [ref] }] } }; }
    else if (input.instructions.includes('压缩预输入')) output = { segments: [{ kind: 'fact', text: correct, refs: ['F-coffee@2'] }] };
    else if (input.instructions.includes('合并最多4')) { parentSeen = true; assert.doesNotMatch(JSON.stringify(data), /合成用户喜欢咖啡/); assert.match(JSON.stringify(data), /F-coffee@2/); output = { text: correct, guide: '来源纠偏', entries: data.children.map(child => ({ text: child.content.text, refs: [`${child.ref}#I01`] })) }; }
    else if (data.leaf) { if (data.leaf.ref === old.leaf) { repairedPrimeSeen = true; assert.doesNotMatch(JSON.stringify(data), /合成用户喜欢咖啡/); assert.match(JSON.stringify(data), /F-coffee@2/); } output = { text: data.leaf.content.text, guide: '按完整L1核对', entries: [{ text: data.leaf.content.entries[0].text, refs: [`${data.leaf.ref}#I01`] }] }; }
    else { assert.doesNotMatch(JSON.stringify(data.previous), /合成用户喜欢咖啡/); assert.match(JSON.stringify(data.previous), /F-coffee@2/); output = { text: '合成问候已交接。', refs: [ref] }; }
    return { status: 'completed', finalText: JSON.stringify(output) };
  };
  const checkpoint = await f.workflow.checkpoint({ conversation, cutoffTurnId: 'synthetic-next-turn', terminal: 'completed', window: 64000 });
  assert.equal(checkpoint.state, 'startup-ready'); assert.equal(parentSeen, false); assert.equal(repairedPrimeSeen, true); assert.match(checkpoint.startup.content, /合成用户不喜欢咖啡/); assert.doesNotMatch(checkpoint.startup.content, /合成用户喜欢咖啡/);
  assert.equal(f.workflow.dreamSnapshot().job.status, 'adopted'); assert.equal(f.calls, 1); assert.equal(ordinary, 5); assert.equal(digest(fs.readFileSync(originalFile)), originalHash); assert.equal(f.workflow.tree.read(old.leaf).content.text, wrong);
  assert.deepEqual(fs.readFileSync(path.join(f.project.root, 'memory', 'recent', 'previous.jsonl')), handoffOriginalBytes); assert.deepEqual(f.workflow.handoff.read(`${seedHandoff.id}@v1`).modelView.originals, seedHandoff.modelView.originals);
  const entry = f.memory.getModule('facts').entries[0];
  f.memory.commitDreamCandidate({ operationId: 'D-later-organize', checkpointId: 'later-cp', dependencies: [dependency(f, `${entry.id}@${entry.rev}`)], changes: [change(`${entry.id}@${entry.rev}`, [], correct)] });
  assert.equal(f.memory.getModule('facts').entries[0].maintenance.kind, 'organize');
  assert.match(f.workflow.tree.projectCurrent(old.leaf, { corrections: f.workflow._summaryCorrections() }).content.text, /合成用户不喜欢咖啡/);
  f.memory.save({ module: 'facts', baseVersion: f.memory.getModule('facts').version, operationId: 'later-withdraw', action: 'withdraw', payload: { id: 'F-coffee' } });
  const withdrawnProjection = f.workflow.tree.projectCurrent(old.leaf, { corrections: f.workflow._summaryCorrections() });
  assert.doesNotMatch(withdrawnProjection.content.text, /合成用户喜欢咖啡/); assert.match(withdrawnProjection.content.text, /撤回或待复核/);
});

test('confirmed native source-ref output normalizes only exact selected target evidence and cannot borrow an unrelated source alias', async t => {
  const f = fixture(t, [{ id: 'F-synthetic-coffee-drift', kind: 'fact', content: '合成用户喜欢咖啡。', sourceText: '合成用户不喜欢咖啡。' }]);
  f.output({ text: '提出否定遗漏修复候选，待下一检查点核验采用。', changes: [{ target: 'F-synthetic-coffee-drift@1', kind: 'source-repair', content: '合成用户不喜欢咖啡。', refs: [f.refs[0]], evidence: ['E1'] }] });
  assert.equal((await f.workflow.dream({ action: 'run', target: 'organize' })).state, 'candidate');
  const job = f.workflow.dreams.state().jobs.at(-1), candidate = f.workflow.journal.read(`memory/dreaming/candidates/${job.id}.jsonl`);
  assert.deepEqual(candidate.changes[0].refs, []); assert.deepEqual(candidate.changes[0].evidenceRefs, [f.refs[0]]); assert.equal(f.calls, 1);
  const g = fixture(t, [{ id: 'F-a', kind: 'fact', content: '合成猫叫桃子。' }, { id: 'F-b', kind: 'fact', content: '合成糖罐在厨房。' }]), task = await g.workflow.dreamCatalog.materialize(g.workflow._dreamTask('organize', 'manual'));
  assert.throws(() => g.workflow._semanticDreamCandidate({ text: '错误借用原文', changes: [{ target: 'F-a@1', kind: 'organize', content: '合成糖罐在厨房。', refs: [g.refs[1]], evidence: ['E1'] }] }, task), { code: 'CHAT_DREAM_CANDIDATE_INVALID' });
});

test('explicit reconciliation revalidates a failed confirmed output using the same locator without another reservation, dispatch or quota observation', async t => {
  const f = fixture(t, [{ id: 'F-coffee', kind: 'fact', content: '合成用户喜欢咖啡。', sourceText: '合成用户不喜欢咖啡。' }]);
  f.output({ text: '先前引用校验失败', changes: [{ target: 'F-coffee@1', kind: 'source-repair', content: '合成用户不喜欢咖啡。', refs: ['C-unselected/M1/P01'], evidence: ['E1'] }] });
  const failed = await f.workflow.dream({ action: 'run', target: 'organize' }); assert.equal(failed.state, 'failed'); assert.equal(failed.job.reason, 'CHAT_DREAM_CANDIDATE_INVALID');
  const before = f.workflow.dreams.state().jobs.at(-1); assert.throws(() => f.workflow.dreams.settle(before.id, { status: 'candidate' }), { code: 'CHAT_DREAM_NOT_RUNNING' });
  let reads = 0; f.runtime.quotaObservation = async () => { throw new Error('revalidation must not sample a later shared quota interval'); };
  const finalText = JSON.stringify({ text: '复用已完成终态', changes: [{ target: 'F-coffee@1', kind: 'source-repair', content: '合成用户不喜欢咖啡。', refs: [f.refs[0]], evidence: ['E1'] }] });
  f.runtime.readOwnThread = async (threadId, request) => { reads++; assert.equal(threadId, before.locator.threadId); assert.equal(request.kind, 'thread/turns/list'); return { sourceRecoveryVerified: true, complete: true, data: [{ id: before.locator.turnId, status: 'completed', items: [{ role: 'assistant', phase: 'final_answer', content: [{ text: finalText }] }] }] }; };
  const after = await f.workflow.dream({ action: 'reconcile' }); assert.equal(after.state, 'candidate'); assert.equal(after.job.id, before.id); assert.equal(after.job.calls, 1); assert.equal(after.job.reservedPoints, before.reservedPoints); assert.equal(after.job.finishedAt, before.finishedAt); assert.deepEqual(after.job.observation, before.observation); assert.equal(f.calls, 1); assert.equal(reads, 1);
  await f.workflow.dream({ action: 'reconcile' }); assert.equal(reads, 1); assert.equal(f.calls, 1);
});
