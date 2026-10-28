'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { MemoryStore } = require('../src/chat-memory.cjs');
const { LIMITS } = require('../src/chat-policy.cjs');

// Every dependency and path is explicit. The meter is a synthetic unit counter,
// not a claim about any shipping model tokenizer or account quota.
function fixture(t, options = {}) {
  const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'maid-memory-')));
  const root = path.join(sandbox, '非默认盘 中文 folder');
  fs.mkdirSync(root);
  t.after(() => { const resolved = fs.realpathSync(path.resolve(sandbox)); assert.equal(fs.realpathSync(path.dirname(root)), resolved); fs.rmSync(resolved, { recursive: true, force: true }); });
  const meter = value => Array.from(value).length;
  const store = new MemoryStore({ projectRoot: root, fs, clock: () => '2026-10-26T10:00:00+08:00', countTokens: meter, resolveSource: source => source.conversationId === 'C-fixture' ? { verified: true, eventId: source.eventId, localDate: source.localDate, originalTurnId: 'turn-1', complete: true } : false, ...options });
  return { store, root, sandbox, meter };
}
function init(store) { return store.initialize({ pet_name: '小龙娘', user_nickname: '星河 中文' }); }
function save(store, module, entry, operationId = 'OP-one', action = 'upsert') {
  return store.save({ operationId, module, baseVersion: store.getModule(module).version, action, payload: { entry } });
}
function views(store) { for (const module of ['persona', 'userView', 'facts']) assert.equal(store.publishPreinput({ module, baseVersion: store.getModule(module).version, segments: [] }).ready, true); }
function source(index = 1, day = '2026-10-26') { return { type: 'chat', conversationId: 'C-fixture', messageId: `M${String(index).padStart(6, '0')}`, eventId: `E-${index}`, localDate: day }; }
function checkpoint(store, patches, taskId = 'CP-one') { const state = store.getState(); return store.commitCheckpoint({ taskId, operationWatermark: state.operationWatermark, baseVersions: Object.fromEntries(Object.entries(state.modules).map(([key, value]) => [key, value.version])), sourceWatermark: { conversationId: 'C-fixture', throughMessage: 'M000010' }, patches }); }

test('requires an explicit existing absolute root and preserves initialized names', t => {
  assert.throws(() => new MemoryStore({ projectRoot: '.' }), { code: 'MEMORY_ROOT' });
  const { store, root } = fixture(t);
  init(store);
  assert.deepEqual(store.getModule('persona').names, { pet_name: '小龙娘', user_nickname: '星河 中文' });
  assert.throws(() => init(store), { code: 'MEMORY_EXISTS' });
  assert.equal(fs.readdirSync(root).some(file => file.includes('星河')), false);
});

test('initialization rejects empty, multiline names without creating memory', t => {
  const { store, root } = fixture(t);
  assert.throws(() => store.initialize({ pet_name: 'small\nname', user_nickname: 'user' }), { code: 'MEMORY_INPUT' });
  assert.equal(fs.readdirSync(root).length, 0);
});

test('persona naming matches initialization control, Unicode line and 160-character limits', t => {
  const { store, root } = fixture(t);
  const invalid = [...Array.from({ length: 32 }, (_, index) => `前${String.fromCharCode(index)}后`), '前\u007f后', '前\u2028后', '前\u2029后', '名'.repeat(161), '🙂'.repeat(81)];
  for (const value of invalid) for (const field of ['pet_name', 'user_nickname']) {
    assert.throws(() => store.initialize({ pet_name: '名字', user_nickname: '昵称', [field]: value }), { code: 'MEMORY_INPUT' });
    assert.deepEqual(fs.readdirSync(root), []);
  }
  store.initialize({ pet_name: '名'.repeat(160), user_nickname: '🙂'.repeat(80) });
  const before = fs.readFileSync(path.join(root, 'memory/head.jsonl'));
  for (const value of invalid) for (const field of ['pet_name', 'user_nickname']) {
    assert.throws(() => store.save({ module: 'persona', operationId: 'OP-invalid-name', baseVersion: 1, action: 'upsert', payload: { names: { [field]: value } } }), { code: 'MEMORY_INPUT' });
    assert.deepEqual(fs.readFileSync(path.join(root, 'memory/head.jsonl')), before);
  }
  assert.equal(store.getModule('persona').version, 1);
});

test('an explicit save is immediately visible, idempotent, and uses operation sources', t => {
  const { store } = fixture(t); init(store);
  const input = { operationId: 'OP-edit', at: '2026-10-26T10:01:00+08:00', module: 'userView', baseVersion: 1, action: 'upsert', payload: { entry: { id: 'V-boundary', kind: 'boundary', content: '以后别叫我老板。' } } };
  const first = store.save(input), repeated = store.save(input);
  assert.equal(first.version, 2); assert.equal(repeated.duplicate, true);
  assert.equal(store.getModule('userView').entries.length, 1);
  assert.deepEqual(store.getModule('userView').entries[0].sources, [{ type: 'operation', operationId: 'OP-edit', at: input.at }]);
  assert.throws(() => store.save({ ...input, payload: { entry: { kind: 'boundary', content: 'different' } } }), { code: 'MEMORY_ID_CONFLICT' });
});

test('version conflicts and unapproved fields cannot change committed bytes', t => {
  const { store, root } = fixture(t); init(store);
  const before = fs.readFileSync(path.join(root, 'memory/head.jsonl'));
  assert.throws(() => store.save({ operationId: 'OP-stale', module: 'facts', baseVersion: 99, action: 'upsert', payload: { entry: { kind: 'fact', content: 'x' } } }), { code: 'MEMORY_STALE' });
  assert.throws(() => save(store, 'facts', { kind: 'fact', content: 'x', reasoning: 'excluded' }), { code: 'MEMORY_INPUT' });
  assert.deepEqual(fs.readFileSync(path.join(root, 'memory/head.jsonl')), before);
});

test('durable head selects committed revisions, never corrupt projections or orphan high versions', t => {
  const { store, root } = fixture(t); init(store); save(store, 'facts', { id: 'F-cat', kind: 'fact', content: '用户说猫叫小白。' });
  fs.writeFileSync(path.join(root, 'memory/facts/current.jsonl'), 'damaged');
  fs.writeFileSync(path.join(root, 'memory/facts/revisions/uncommitted.jsonl'), '{"snapshot":{"version":999}}\n');
  const reopened = new MemoryStore({ projectRoot: root, fs });
  assert.equal(reopened.getModule('facts').version, 2);
  assert.equal(reopened.getModule('facts').entries[0].content, '用户说猫叫小白。');
});

test('a failed atomic commit leaves the old head and a retry does not duplicate the operation', t => {
  const { store, root, meter } = fixture(t); init(store);
  const before = fs.readFileSync(path.join(root, 'memory/head.jsonl'));
  const failingFs = Object.create(fs);
  failingFs.renameSync = (from, to) => { if (to === path.join(root, 'memory/head.jsonl')) throw Object.assign(new Error('simulated disk failure'), { code: 'EIO' }); return fs.renameSync(from, to); };
  const failed = new MemoryStore({ projectRoot: root, fs: failingFs, countTokens: meter });
  assert.throws(() => save(failed, 'facts', { kind: 'fact', content: '保留草稿的失败' }), { code: 'EIO' });
  assert.deepEqual(fs.readFileSync(path.join(root, 'memory/head.jsonl')), before);
  assert.equal(store.getModule('facts').entries.length, 0);
  assert.equal(save(store, 'facts', { kind: 'fact', content: '保留草稿的失败' }).saved, true);
  assert.equal(store.getModule('facts').entries.length, 1);
});

test('damaged committed bytes stop recovery without replacing existing data', t => {
  const { store, root } = fixture(t); init(store);
  const file = path.join(root, 'memory/head.jsonl'); fs.writeFileSync(file, 'corrupt bytes');
  assert.throws(() => store.getState(), { code: 'MEMORY_CORRUPT' });
  assert.throws(() => init(store), { code: 'MEMORY_CORRUPT' });
  assert.equal(fs.readFileSync(file, 'utf8'), 'corrupt bytes');
});

test('an active writer is respected and a provably abandoned writer can recover', t => {
  const { store, root, meter } = fixture(t); init(store);
  const lock = path.join(root, 'memory/.writer.lock');
  fs.writeFileSync(lock, JSON.stringify({ pid: 123456, token: 'synthetic-holder' }));
  const busy = new MemoryStore({ projectRoot: root, fs, countTokens: meter, isProcessAlive: () => true });
  assert.throws(() => save(busy, 'facts', { kind: 'fact', content: 'x' }), { code: 'MEMORY_BUSY' });
  const recovered = new MemoryStore({ projectRoot: root, fs, countTokens: meter, isProcessAlive: () => false });
  assert.equal(save(recovered, 'facts', { kind: 'fact', content: 'x' }).saved, true);
});

test('storage children cannot escape through a symlink or junction', t => {
  const { store, root, sandbox } = fixture(t);
  const outside = path.join(sandbox, 'outside'); fs.mkdirSync(outside);
  try { fs.symlinkSync(outside, path.join(root, 'memory'), process.platform === 'win32' ? 'junction' : 'dir'); } catch (error) { if (error.code === 'EPERM') { t.skip('symlink capability unavailable'); return; } throw error; }
  assert.throws(() => init(store), { code: 'MEMORY_PATH' });
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('model preinput requires a verified integer meter, includes packaging, and never truncates', t => {
  const { store, root } = fixture(t); init(store);
  const noMeter = new MemoryStore({ projectRoot: root, fs });
  assert.equal(noMeter.publishPreinput({ module: 'persona', baseVersion: 1, segments: [] }).reason, 'token-meter-unverified');
  const invalidMeter = new MemoryStore({ projectRoot: root, fs, countTokens: () => NaN });
  assert.equal(invalidMeter.publishPreinput({ module: 'persona', baseVersion: 1, segments: [] }).reason, 'token-meter-unverified');
  const over = store.publishPreinput({ module: 'persona', baseVersion: 1, segments: [{ text: '长'.repeat(LIMITS.persona), refs: [] }] });
  assert.equal(over.reason, 'memory-capacity'); assert.ok(over.tokens > LIMITS.persona);
  assert.equal(store.getModule('persona').preinput, null);
});

test('all three model views admit content beyond the old caps and keep the shared 10K limits', t => {
  const { store } = fixture(t); init(store);
  const fixtures = [['persona', 'P-large', 'growth'], ['userView', 'V-large', 'preference'], ['facts', 'F-large', 'fact']];
  for (const [module, id, kind] of fixtures) {
    const content = `${module}:` + 'x'.repeat(6000);
    save(store, module, { id, kind, content }, `OP-${module}`);
    const published = store.publishPreinput({ module, baseVersion: store.getModule(module).version, segments: [{ kind, text: content, refs: [`${id}@1`] }] });
    assert.equal(published.ready, true); assert.ok(published.tokens > 6000); assert.ok(published.tokens <= 10000);
  }
  const prepared = store.prepareForRequest({ requestId: 'REQ-large-views', nativeContextVerified: true });
  assert.equal(prepared.ready, true);
  for (const [module] of fixtures) { assert.ok(prepared.modules[module].tokens > 6000); assert.ok(prepared.modules[module].tokens <= 10000); }
});

test('full archives exceed view limits without truncation and over-cap views preserve their committed bytes', t => {
  const { store, root } = fixture(t); init(store);
  const fixtures = [['persona', 'P-archive', 'growth'], ['userView', 'V-archive', 'preference'], ['facts', 'F-archive', 'fact']];
  for (const [module, id, kind] of fixtures) {
    const content = `${module}:` + '完整原文 '.repeat(5000);
    save(store, module, { id, kind, content }, `OP-full-${module}`);
    const snapshot = store.getModule(module);
    assert.equal(snapshot.entries[0].content, content); assert.ok(content.length > 10000);
    assert.equal(store.publishPreinput({ module, baseVersion: snapshot.version, segments: [{ kind, text: '有来源的压缩视图', refs: [`${id}@1`] }] }).ready, true);
    const head = fs.readFileSync(path.join(root, 'memory/head.jsonl'));
    const over = store.publishPreinput({ module, baseVersion: snapshot.version, segments: [{ kind, text: 'x'.repeat(10001), refs: [`${id}@1`] }] });
    assert.equal(over.reason, 'memory-capacity'); assert.equal(over.limit, 10000);
    assert.deepEqual(fs.readFileSync(path.join(root, 'memory/head.jsonl')), head);
    assert.equal(store.getModule(module).entries[0].content, content);
    assert.equal(store.revision(module, snapshot.version).snapshot.entries[0].content, content);
  }
  assert.equal(store.prepareForRequest({ requestId: 'REQ-compressed-large-archives', nativeContextVerified: true }).ready, true);
});

test('large saved persona baseline is intact and its request view uses the expanded cap', t => {
  const { store } = fixture(t); init(store);
  const baseline = require('../src/chat-persona.cjs').createDefaultPersona(store.getModule('persona').names);
  baseline.core = ['x'.repeat(7000)]; baseline.preferences = []; baseline.examples = []; baseline.background = []; baseline.boundaries = ['这是有界人设视图，不是执行权限。'];
  store.save({ module: 'persona', operationId: 'OP-large-baseline', baseVersion: 1, action: 'upsert', payload: { persona: baseline } });
  views(store);
  const prepared = store.prepareForRequest({ requestId: 'REQ-large-baseline', nativeContextVerified: true });
  assert.equal(prepared.ready, true); assert.ok(prepared.modules.persona.tokens > 7000); assert.ok(prepared.modules.persona.tokens <= 10000);
  baseline.core = ['y'.repeat(20000)];
  store.save({ module: 'persona', operationId: 'OP-full-baseline', baseVersion: store.getModule('persona').version, action: 'upsert', payload: { persona: baseline } });
  assert.equal(store.getModule('persona').baseline.core[0], baseline.core[0]);
  assert.equal(store.prepareForRequest({ requestId: 'REQ-over-baseline', nativeContextVerified: true }).ready, false);
  assert.equal(store.getModule('persona').baseline.core[0].length, 20000);
});

test('persona fitting measures the final request once with long names, retained growth and complete boundaries', t => {
  const byteMeter = text => Buffer.byteLength(text, 'utf8');
  const { store } = fixture(t, { countTokens: byteMeter });
  const names = { pet_name: '龙'.repeat(160), user_nickname: '测'.repeat(160) };
  const baseline = require('../src/chat-persona.cjs').createDefaultPersona(names);
  baseline.core = ['x'.repeat(6500)];
  baseline.boundaries = ['只有用户明确要求时才更改当前设定，不省略这项条件。'];
  baseline.preferences = ['v'.repeat(300), 'optional'.repeat(1000)]; baseline.examples = []; baseline.background = [];
  store.initialize({ ...names, persona: baseline });
  save(store, 'persona', { id: 'P-retained', kind: 'growth', content: '保留已经确认的人设成长。' }, 'OP-retained');
  views(store);
  assert.equal(store.publishPreinput({ module: 'persona', baseVersion: store.getModule('persona').version,
    segments: [{ kind: 'growth', text: '保留已经确认的人设成长。', refs: ['P-retained@1'] }] }).ready, true);
  const prepared = store.prepareForRequest({ requestId: 'REQ-long-persona-names', nativeContextVerified: true });
  assert.equal(prepared.ready, true);
  const projection = prepared.modules.persona, parsed = JSON.parse(projection.content);
  assert.equal(projection.tokens, byteMeter(projection.content)); assert.ok(projection.tokens > 9000); assert.ok(projection.tokens <= LIMITS.persona);
  assert.equal(parsed.segments.filter(segment => segment.kind === 'naming').length, 1);
  assert.deepEqual(parsed.segments.filter(segment => segment.kind === 'core').map(segment => segment.text), baseline.core);
  assert.deepEqual(parsed.segments.filter(segment => segment.kind === 'boundaries').map(segment => segment.text), baseline.boundaries);
  assert.ok(parsed.segments.some(segment => segment.refs.includes('P-retained@1') && segment.text === '保留已经确认的人设成长。'));
  assert.ok(parsed.segments.some(segment => segment.text === baseline.preferences[0]));
  assert.ok(!parsed.segments.some(segment => segment.text === baseline.preferences[1]));
  assert.deepEqual(store.getModule('persona').baseline, baseline);
  baseline.core = ['y'.repeat(LIMITS.persona + 1)];
  store.save({ module: 'persona', operationId: 'OP-mandatory-too-large', baseVersion: store.getModule('persona').version, action: 'upsert', payload: { persona: baseline } });
  const blocked = store.prepareForRequest({ requestId: 'REQ-over-long-persona-names', nativeContextVerified: true });
  assert.equal(blocked.ready, false); assert.equal(blocked.reason, 'persona-capacity'); assert.equal(blocked.module, 'persona');
  assert.deepEqual(store.getModule('persona').baseline.core, baseline.core);
  assert.deepEqual(store.getModule('persona').baseline.boundaries, baseline.boundaries);
});

test('boundaries and complete overall cognition must be referenced in a compressed view', t => {
  const { store } = fixture(t); init(store);
  save(store, 'userView', { id: 'V-boundary', kind: 'boundary', content: '工作时不要催我。' });
  save(store, 'userView', { id: 'V-overall', kind: 'overall', content: '在讨论细节时认真，其他情境还不了解。' }, 'OP-two');
  assert.throws(() => store.publishPreinput({ module: 'userView', baseVersion: 3, segments: [] }), { code: 'MEMORY_CAPACITY' });
  assert.equal(store.publishPreinput({ module: 'userView', baseVersion: 3, segments: [{ kind: 'boundary', text: '工作时不要催促。', refs: ['V-boundary@1'] }, { kind: 'overall', text: '细节认真，其他方面未知。', refs: ['V-overall@1'] }] }).ready, true);
});

test('ordinary prepare/sync is memory-only and native context evidence remains required', t => {
  const { store, root } = fixture(t); init(store); views(store);
  const before = fs.readFileSync(path.join(root, 'memory/head.jsonl'));
  assert.equal(store.prepareForRequest({ requestId: 'REQ-unverified' }).reason, 'native-context-unverified');
  const prepared = store.prepareForRequest({ requestId: 'REQ-one', nativeContextVerified: true });
  assert.equal(prepared.ready, true);
  assert.match(prepared.modules.userView.content, /了解有限/);
  assert.equal(store.markSynced({ requestId: 'REQ-one', operationWatermark: prepared.operationWatermark }).synchronized, true);
  assert.deepEqual(fs.readFileSync(path.join(root, 'memory/head.jsonl')), before);
});

test('a save during generation does not alter the frozen request and leaves next-request synchronization pending', t => {
  const { store } = fixture(t); init(store); views(store);
  const first = store.prepareForRequest({ requestId: 'REQ-first', nativeContextVerified: true });
  save(store, 'facts', { id: 'F-trip', kind: 'plan', content: '旅行已取消。', event_status: 'cancelled' });
  assert.equal(store.markSynced({ requestId: 'REQ-first', operationWatermark: first.operationWatermark }).pending, true);
  assert.doesNotMatch(first.modules.facts.content, /旅行/);
  const next = store.prepareForRequest({ requestId: 'REQ-next', nativeContextVerified: true });
  assert.match(next.modules.facts.content, /旅行已取消/);
  assert.equal(next.modules.facts.viewStatus, 'saved-overrides-view');
});

test('unknown later natural-language changes block synchronization rather than revive a saved nickname', t => {
  const { store } = fixture(t); init(store); views(store);
  const pending = store.prepareForRequest({ requestId: 'REQ-later', nativeContextVerified: true, laterNativeChanges: [{ module: 'persona', verified: false, text: '使用后来昵称' }] });
  assert.equal(pending.reason, 'later-requirements-unverified');
  const ready = store.prepareForRequest({ requestId: 'REQ-known', nativeContextVerified: true, laterNativeChanges: [{ module: 'persona', verified: true, text: '昵称已在后续聊天改为流星。' }] });
  assert.equal(ready.ready, true); assert.match(ready.modules.persona.content, /laterThanSaved/);
});

test('correction invalidates dependent overall paragraphs and excludes stale search results immediately', t => {
  const { store } = fixture(t); init(store);
  save(store, 'userView', { id: 'V-coffee', kind: 'preference', content: '喜欢咖啡。' });
  save(store, 'userView', { id: 'V-overall', kind: 'overall', content: '喜欢咖啡等饮料。', dependsOn: ['V-coffee@1'] }, 'OP-overall');
  store.publishPreinput({ module: 'userView', baseVersion: 3, segments: [{ kind: 'overall', text: '喜欢咖啡。', refs: ['V-overall@1'] }] });
  store.save({ operationId: 'OP-correct', module: 'userView', baseVersion: 3, action: 'correct', payload: { entry: { id: 'V-coffee', kind: 'preference', content: '之前理解错误，用户没有说喜欢咖啡。' } } });
  assert.equal(store.getModule('userView').entries.find(entry => entry.kind === 'overall').status, 'needs_review');
  assert.equal(store.filterEvidence('V-coffee@1').allowed, false);
  assert.equal(store.filterEvidence('V-overall@1').allowed, false);
  assert.equal(store.filterEvidence('V-overall@1', { intent: 'history' }).allowed, true);
});

test('checkpoint source resolution and operation watermarks prevent fabricated evidence and stale publication', t => {
  const { store } = fixture(t); init(store);
  assert.throws(() => checkpoint(store, [{ module: 'facts', action: 'upsert', automatic: false, payload: { entry: { kind: 'fact', content: 'x', sources: [{ ...source(), conversationId: 'C-unrelated' }] } } }]), { code: 'MEMORY_EVIDENCE' });
  const before = store.getState();
  save(store, 'facts', { kind: 'fact', content: 'a newer explicit save' });
  assert.throws(() => store.commitCheckpoint({ taskId: 'CP-stale', baseVersions: { facts: before.modules.facts.version }, operationWatermark: before.operationWatermark, sourceWatermark: { through: 'M10' }, patches: [] }), { code: 'MEMORY_STALE' });
});

test('supported impressions need three distinct events across two dates, never repeated summary evidence', t => {
  const { store } = fixture(t); init(store);
  const patch = sources => ({ module: 'userView', action: 'upsert', originalTurnId: 'turn-1', payload: { entry: { id: 'V-supported', kind: 'impression', content: '讨论选择时看重依据，其他情境未知。', certainty: 'supported', sources } } });
  assert.throws(() => checkpoint(store, [patch([source(1), source(1), source(2)])]), { code: 'MEMORY_EVIDENCE' });
  assert.throws(() => checkpoint(store, [patch([source(1), source(2), source(3)])]), { code: 'MEMORY_EVIDENCE' });
  assert.equal(checkpoint(store, [patch([source(1), source(2), source(3, '2026-10-25')])]).saved, true);
});

test('persona/user-view share three automatic changes per original turn; explicit facts are not cut to three', t => {
  const { store } = fixture(t); init(store);
  const patches = Array.from({ length: 4 }, (_, index) => ({ module: index % 2 ? 'persona' : 'userView', action: 'upsert', originalTurnId: 'turn-1', payload: { entry: { kind: index % 2 ? 'growth' : 'impression', content: `观察${index}`, sources: [source(index + 1)] } } }));
  assert.throws(() => checkpoint(store, patches), { code: 'MEMORY_GROWTH_BUDGET' });
  assert.equal(checkpoint(store, Array.from({ length: 8 }, (_, index) => ({ module: 'facts', action: 'upsert', automatic: false, payload: { entry: { id: `F-item-${index}`, kind: 'fact', content: `明确事实${index}`, sources: [source(index + 1)] } } })), 'CP-facts').saved, true);
  assert.equal(store.getModule('facts').entries.length, 8);
});

test('withdrawn automatic impressions cannot be rebuilt from old sources under another entry ID', t => {
  const { store } = fixture(t); init(store);
  checkpoint(store, [{ module: 'userView', action: 'upsert', originalTurnId: 'turn-1', payload: { entry: { id: 'V-old', kind: 'impression', content: '暂时观察', sources: [source()] } } }]);
  store.save({ operationId: 'OP-remove', module: 'userView', baseVersion: 2, action: 'withdraw', payload: { id: 'V-old' } });
  assert.throws(() => checkpoint(store, [{ module: 'userView', action: 'upsert', originalTurnId: 'turn-1', payload: { entry: { id: 'V-new', kind: 'impression', content: '旧来源重建', sources: [source()] } } }], 'CP-rebuild'), { code: 'MEMORY_EXCLUDED' });
});

test('expiry does not delete full records, cancel permanent boundaries, or infer a plan was completed', t => {
  let now = '2026-10-26T10:00:00+08:00';
  const { store } = fixture(t, { clock: () => now }); init(store);
  checkpoint(store, [{ module: 'userView', action: 'upsert', originalTurnId: 'turn-1', payload: { entry: { id: 'V-observation', kind: 'impression', content: '暂时观察', sources: [source()] } } }]);
  save(store, 'userView', { id: 'V-boundary', kind: 'boundary', content: '以后别催我。' });
  save(store, 'facts', { id: 'F-plan', kind: 'plan', content: '用户当时计划出游，后续未知。', target_date: '2026-11', event_status: 'proposed', followup: 'unknown' }, 'OP-plan');
  now = '2027-03-01T10:00:00+08:00';
  assert.equal(store.filterEvidence('V-observation@1').allowed, false);
  assert.equal(store.filterEvidence('V-boundary@1').allowed, true);
  assert.equal(store.getModule('userView').entries.length, 2);
  assert.equal(store.getModule('facts').entries[0].event_status, 'proposed');
  assert.equal(store.getModule('facts').entries[0].followup, 'unknown');
});

test('full memory preserves more than twenty candidates, eight sources, and 400 units of overall cognition', t => {
  const { store } = fixture(t); init(store);
  const entries = Array.from({ length: 25 }, (_, index) => ({ module: 'userView', action: 'upsert', automatic: false, payload: { entry: { id: `V-many-${index}`, kind: 'preference', content: `详细偏好${index}`, sources: Array.from({ length: 12 }, (_, sourceIndex) => source(sourceIndex + 1)) } } }));
  checkpoint(store, entries);
  save(store, 'userView', { id: 'V-overall', kind: 'overall', content: '长认知'.repeat(250) }, 'OP-long');
  const memory = store.getModule('userView');
  assert.equal(memory.entries.length, 26); assert.equal(memory.entries[0].sources.length, 12);
  assert.ok(memory.entries.find(entry => entry.kind === 'overall').content.length > 400);
});

test('Windows and Mac memory implementations remain identical', () => {
  const local = path.resolve(__dirname, '..'), root = fs.existsSync(path.join(local, 'macos', 'src', 'chat-memory.cjs')) ? local : path.resolve(local, '..');
  assert.deepEqual(fs.readFileSync(path.join(root, 'src', 'chat-memory.cjs')), fs.readFileSync(path.join(root, 'macos', 'src', 'chat-memory.cjs')));
});

test('proposed event IDs and dates cannot manufacture independent support', t => {
  const { store } = fixture(t, { resolveSource: () => ({ verified: true, eventId: 'same-actual-event', localDate: '2026-10-26', originalTurnId: 'turn-1', complete: true }) }); init(store);
  assert.throws(() => checkpoint(store, [{ module: 'userView', action: 'upsert', originalTurnId: 'turn-1', payload: { entry: { kind: 'impression', content: '伪造三次支持', certainty: 'supported', sources: [source(1), source(2), source(3, '2026-10-25')] } } }]), { code: 'MEMORY_EVIDENCE' });
});

test('automatic growth budgets persist across checkpoint retries and new task IDs', t => {
  const { store } = fixture(t); init(store);
  const patch = index => ({ module: 'userView', action: 'upsert', originalTurnId: 'turn-1', payload: { entry: { id: `V-growth-${index}`, kind: 'impression', content: `观察${index}`, sources: [source(index)] } } });
  checkpoint(store, [patch(1), patch(2), patch(3)], 'CP-first');
  assert.throws(() => checkpoint(store, [patch(4)], 'CP-second'), { code: 'MEMORY_GROWTH_BUDGET' });
  assert.equal(store.getModule('userView').entries.length, 3);
});

test('commit listeners cannot turn an already committed save into reported failure', t => {
  const { store } = fixture(t); init(store);
  store.on('commit', () => { throw new Error('simulated subscriber failure'); });
  const receipt = save(store, 'facts', { kind: 'fact', content: '已提交的资料' });
  assert.equal(receipt.saved, true); assert.equal(receipt.notified, false);
  assert.equal(store.getModule('facts').entries[0].content, '已提交的资料');
});

test('naming templates rebuild from the current authority before the next request', t => {
  const { store } = fixture(t); init(store); views(store);
  store.publishPreinput({ module: 'persona', baseVersion: 1, segments: [{ kind: 'naming', text: '称呼用户：旧昵称。', refs: [] }] });
  store.save({ operationId: 'OP-nickname', module: 'persona', baseVersion: 1, action: 'upsert', payload: { names: { user_nickname: '新昵称' } } });
  const next = store.prepareForRequest({ requestId: 'REQ-new-name', nativeContextVerified: true });
  assert.equal(next.ready, true); assert.match(next.modules.persona.content, /新昵称王朝/);
  assert.doesNotMatch(next.modules.persona.content, /旧昵称/);
});

test('explicit archived facts retain their last-known state beyond the impression ageing period', t => {
  let now = '2026-10-26T10:00:00+08:00';
  const { store } = fixture(t, { clock: () => now }); init(store);
  checkpoint(store, [{ module: 'facts', action: 'upsert', automatic: false, payload: { entry: { id: 'F-trip', kind: 'plan', content: '当时计划十一月旅行。', event_status: 'accepted', target_date: '2026-11', followup: 'unknown', sources: [source()] } } }]);
  now = '2027-03-01T10:00:00+08:00';
  const facts = store.currentFacts();
  assert.equal(facts.entries.length, 1); assert.equal(facts.entries[0].certainty, 'explicit');
  assert.equal(facts.entries[0].event_status, 'accepted');
  assert.equal(facts.entries[0].timeDisposition, 'target-passed-outcome-unknown');
  assert.equal(store.getModule('facts').entries[0].timeDisposition, undefined);
});

test('an older archived message cannot override a later explicit management save', t => {
  const { store } = fixture(t, { resolveSource: () => ({ verified: true, at: '2026-10-25T10:00:00+08:00', originalTurnId: 'turn-1', complete: true }) }); init(store);
  save(store, 'facts', { id: 'F-trip', kind: 'plan', content: '旅行取消。', event_status: 'cancelled' });
  assert.throws(() => checkpoint(store, [{ module: 'facts', action: 'upsert', automatic: false, payload: { entry: { id: 'F-trip', kind: 'plan', content: '旧聊天计划旅行', event_status: 'proposed', sources: [source()] } } }]), { code: 'MEMORY_STALE' });
  assert.equal(store.currentFacts().entries[0].event_status, 'cancelled');
});

test('module ownership and explicit factual states are validated without merging equal names', t => {
  const { store } = fixture(t); init(store);
  assert.throws(() => save(store, 'facts', { kind: 'preference', content: '属于V的偏好' }), { code: 'MEMORY_INPUT' });
  assert.throws(() => save(store, 'facts', { kind: 'plan', content: '未知状态', event_status: 'guessed-done' }), { code: 'MEMORY_INPUT' });
  save(store, 'facts', { id: 'F-person-a', kind: 'relationship', content: '同名朋友甲', subject: '小明', object_ids: ['person-a'] });
  save(store, 'facts', { id: 'F-person-b', kind: 'relationship', content: '同名朋友乙', subject: '小明', object_ids: ['person-b'] }, 'OP-other-person');
  assert.equal(store.currentFacts().entries.length, 2);
  assert.equal(store.currentUserView().overallStatus, 'limited-acquaintance');
});

test('a bounded view can select from an unlimited explicit archive and only newer saved revisions are overlaid',t=>{
 const {store}=fixture(t);init(store);
 for(let index=0;index<8;index++)save(store,'facts',{id:`F-many${index}`,kind:'fact',content:'明确事实'.repeat(150)},`OP-many${index}`);
 const snapshot=store.getModule('facts');assert.equal(store.publishPreinput({module:'facts',baseVersion:snapshot.version,segments:[{kind:'fact',text:'本次选择第一条事实。',refs:['F-many0@1']}]}).ready,true);
 store.publishPreinput({module:'persona',baseVersion:1,segments:[]});store.publishPreinput({module:'userView',baseVersion:1,segments:[]});
 const prepared=store.prepareForRequest({requestId:'limited-archive',nativeContextVerified:true});assert.equal(prepared.ready,true);assert.ok(prepared.modules.facts.tokens<4000);assert.match(prepared.modules.facts.content,/authority/);
 save(store,'facts',{id:'F-next',kind:'fact',content:'刚保存的新要求。'},'OP-new');
 const next=store.prepareForRequest({requestId:'new-override',nativeContextVerified:true});assert.equal(next.ready,true);assert.match(next.modules.facts.content,/刚保存的新要求/);
});
