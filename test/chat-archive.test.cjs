'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createChatProject } = require('../src/chat-project.cjs');
const { createConversation, commitCheckpoint, readArchive, saveRecoveryMetadata, readRecoveryMetadata } = require('../src/chat-archive.cjs');

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=', 'base64');
const at = '2026-10-26T23:59:59+08:00';
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'maid-chat-archive-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const parentDir = path.join(directory, '隔离 中文 parent'); fs.mkdirSync(parentDir);
  const { root } = createChatProject({ parentDir, userNickname: '昵称' });
  const conversation = createConversation({ root, startedAt: at, timezone: 'Asia/Shanghai', nativeThreadId: 'native-thread-one', messageTimeSource: 'native_event' });
  return { directory, root, conversation };
}
function records({ turn = 'T000001', message = 'M000001', answer = 'M000002', status = 'completed', content = [{ text: '  用户\n😀原文  ' }], phase = 'final_answer' } = {}) {
  return [
    { turn: { id: turn, observed_at: at, requested_model: 'test-model', persona_version: 1, memory_view_versions: { persona: 1, userView: 2, facts: 3 } } },
    { id: message, turn_id: turn, time: at, role: 'user', content },
    { id: answer, turn_id: turn, time: '2026-10-27T00:00:01+08:00', role: 'assistant', phase, displayed: true, content: [{ text: ' 原样\n回答\t ' }], reasoning: 'FORBIDDEN_REASONING', protocol: 'FORBIDDEN_PROTOCOL' },
    { turn_result: { id: turn, observed_at: '2026-10-27T00:00:02+08:00', status, usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 }, source_event: 'turn.completed' } }
  ];
}
function commit(f, source = records(), options = {}) {
  return commitCheckpoint({ root: f.root, conversation: f.conversation, records: source, trigger: 'new-conversation', sourceComplete: true, ...options });
}

test('runtime construction writes no history and incomplete/ordinary calls cannot persist', t => {
  const f = fixture(t), source = records();
  assert.deepEqual(fs.readdirSync(f.root), ['project.json']);
  assert.throws(() => commit(f, source, { trigger: 'ordinary-turn' }), { code: 'CHAT_CHECKPOINT_REQUIRED' });
  assert.throws(() => commit(f, source, { sourceComplete: false }), { code: 'CHAT_CHECKPOINT_REQUIRED' });
  assert.deepEqual(fs.readdirSync(f.root), ['project.json']);
});

test('checkpoint retains exact text, true start date, actual loaded versions and idempotent identity', t => {
  const f = fixture(t), result = commit(f), first = fs.readFileSync(result.file);
  assert.equal(result.relativePath, 'chat-history/2026-10-26/2026-10-26_23-59-59.jsonl');
  const saved = readArchive(f.root, f.conversation).records;
  assert.equal(saved[0].meta.conversation_id, f.conversation.conversationId);
  assert.equal(saved[0].meta.archive_date, '2026-10-26');
  assert.equal(saved[2].content[0].text, '  用户\n😀原文  ');
  assert.equal(saved[3].content[0].text, ' 原样\n回答\t ');
  assert.deepEqual(saved[1].turn.memory_view_versions, { persona: 1, userView: 2, facts: 3 });
  assert.equal(first.includes('FORBIDDEN_REASONING'), false);
  assert.equal(first.includes('FORBIDDEN_PROTOCOL'), false);
  assert.equal(commit(f).reused, true);
  assert.deepEqual(fs.readFileSync(result.file), first);
  const renamed = { ...f.conversation, title: `${f.conversation.title}-2` };
  assert.throws(() => commit(f, records(), { conversation: renamed }), { code: 'CHAT_MAPPING_CONFLICT' });
});

test('real time zone rather than host date determines the immutable archive date and safe title', () => {
  const value = createConversation({ startedAt: '2026-10-26T23:30:00Z', timezone: 'Asia/Tokyo' });
  assert.equal(value.archiveDate, '2026-10-27');
  assert.equal(value.title, '2026-10-27_08-30-00');
  assert.throws(() => createConversation({ startedAt: '2026-10-26 12:00', timezone: 'UTC' }), { code: 'CHAT_ARCHIVE_INVALID' });
  assert.throws(() => createConversation({ startedAt: at, timezone: 'invalid/timezone' }), { code: 'CHAT_ARCHIVE_INVALID' });
});

test('append messages remain independent with true turn and target association', t => {
  const f = fixture(t), source = records();
  source.splice(2, 0, { id: 'M000003', turn_id: 'T000001', time: null, role: 'user', append_to: 'M000001', delivery: 'steer', content: [{ text: '追加，不合并。' }] });
  const saved = readArchive(f.root, f.conversation, commit(f, source) && undefined).records;
  assert.equal(saved[3].append_to, 'M000001');
  assert.equal(saved[3].turn_id, 'T000001');
  assert.equal(saved[2].content[0].text, '  用户\n😀原文  ');
  assert.equal(saved[3].content[0].text, '追加，不合并。');
});

test('normal commentary is omitted while displayed failed/interrupted answers retain their actual phase', t => {
  const f = fixture(t), source = records();
  source.splice(2, 0, { id: 'M000003', turn_id: 'T000001', time: at, role: 'assistant', phase: 'commentary', content: [{ text: 'DO_NOT_ARCHIVE_NORMAL_COMMENTARY' }] });
  const result = commit(f, source);
  assert.equal(fs.readFileSync(result.file, 'utf8').includes('DO_NOT_ARCHIVE_NORMAL_COMMENTARY'), false);
  for (const status of ['failed', 'interrupted', 'cancelled']) {
    const other = { ...f, conversation: createConversation({ root: f.root, startedAt: at, timezone: 'Asia/Shanghai', nativeThreadId: `native-${status}` }) };
    const saved = readArchive(other.root, other.conversation, commit(other, records({ status, phase: 'partial_answer' })) && undefined).records;
    assert.equal(saved[3].phase, 'partial_answer');
    assert.equal(saved.at(-1).turn_result.status, status);
  }
});

test('unknown phase/terminal, hidden partial, reasoning and tools block before any history write', t => {
  const f = fixture(t);
  const samples = [records({ phase: null }), records({ status: 'unknown' }), records({ phase: 'partial_answer' })];
  const hidden = records({ status: 'failed', phase: 'partial_answer' }); hidden[2].displayed = false; samples.push(hidden);
  const reasoning = records(); reasoning[2].role = 'reasoning'; samples.push(reasoning);
  const tool = records(); tool[2].content = [{ tool_result: 'secret' }]; samples.push(tool);
  for (const sample of samples) assert.throws(() => commit(f, sample));
  assert.deepEqual(fs.readdirSync(f.root), ['project.json']);
});

test('a displayed failed fragment with unknown phase remains null rather than being relabeled final or partial', t => {
  const f = fixture(t), source = records({ status: 'interrupted', phase: null });
  commit(f, source);
  const message = readArchive(f.root, f.conversation).records[3];
  assert.equal(message.phase, null);
  assert.equal(message.content[0].text, ' 原样\n回答\t ');
});

test('original images retain their content position and byte hashes in C-isolated portable paths', t => {
  const f = fixture(t), content = [{ text: 'A\n' }, { image: { bytes: png, name: '同名 原图.png', mime: 'image/png' } }, { text: '\nB' }];
  const result = commit(f, records({ content }));
  const saved = readArchive(f.root, f.conversation).records[2].content;
  assert.equal(saved[0].text, 'A\n'); assert.equal(saved[2].text, '\nB');
  assert.equal(saved[1].image.path, `chat-history/2026-10-26/attachments/${f.conversation.conversationId}/M000001-01.png`);
  assert.equal(saved[1].image.size, png.length);
  assert.match(saved[1].image.sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(fs.readFileSync(path.join(f.root, ...saved[1].image.path.split('/'))), png);
  const other = { ...f, conversation: createConversation({ root: f.root, startedAt: at, timezone: 'Asia/Shanghai', nativeThreadId: 'native-thread-two' }) };
  assert.equal(other.conversation.title, `${f.conversation.title}-1`);
  commit(other, records({ content }));
  const otherPath = readArchive(other.root, other.conversation).records[2].content[1].image.path;
  assert.notEqual(otherPath, saved[1].image.path);
  const moved = path.join(f.directory, '移动后的 项目'); fs.renameSync(f.root, moved);
  assert.equal(readArchive(moved, f.conversation).records[2].content[1].image.path, saved[1].image.path);
  assert.deepEqual(fs.readFileSync(path.join(moved, ...saved[1].image.path.split('/'))), png);
  assert.ok(result.complete);
});

test('missing, contradictory or unavailable image originals never publish a complete archive', t => {
  const f = fixture(t);
  for (const image of [{ path: '../private.png' }, { bytes: png, mime: 'image/jpeg' }, { bytes: png, size: 1 }, { bytes: png, sha256: 'a'.repeat(64) }, { bytes: Buffer.from('not an image') }]) {
    assert.throws(() => commit(f, records({ content: [{ image }] })));
  }
  assert.deepEqual(fs.readdirSync(f.root), ['project.json']);
});

test('corrupted original image bytes are detected even when the text checkpoint is reused', t => {
  const f = fixture(t), source = records({ content: [{ image: { bytes: png } }] });
  commit(f, source);
  const relative = readArchive(f.root, f.conversation).records[2].content[0].image.path;
  fs.writeFileSync(path.join(f.root, ...relative.split('/')), Buffer.alloc(png.length));
  assert.throws(() => commit(f, source), { code: 'CHAT_IMAGE_MISMATCH' });
});

test('a failed atomic publish keeps committed bytes and leaves only allowlisted JSONL staging', t => {
  const f = fixture(t), first = commit(f), before = fs.readFileSync(first.file);
  const extended = [...records(), ...records({ turn: 'T000002', message: 'M000003', answer: 'M000004' })];
  const io = { ...fs, renameSync: () => { throw Object.assign(new Error('injected disk error'), { code: 'EIO' }); } };
  assert.throws(() => commit(f, extended, { fs: io }), { code: 'EIO' });
  assert.deepEqual(fs.readFileSync(first.file), before);
  const staging = fs.readdirSync(path.dirname(first.file)).filter(name => name.endsWith('.pending.jsonl'));
  assert.equal(staging.length, 1);
  assert.equal(fs.readFileSync(path.join(path.dirname(first.file), staging[0]), 'utf8').includes('FORBIDDEN_REASONING'), false);
  assert.equal(commit(f, extended).complete, true);
  const changed = records(); changed[1].content[0].text = '改写旧原文';
  assert.throws(() => commit(f, changed), { code: 'CHAT_ARCHIVE_CONFLICT' });
});

test('native mappings and pending project locks cannot be bypassed with another C or filename', t => {
  const f = fixture(t); commit(f);
  const duplicate = createConversation({ root: f.root, startedAt: at, timezone: 'Asia/Shanghai', nativeThreadId: f.conversation.nativeThreadId });
  assert.throws(() => commit(f, records(), { conversation: duplicate }), { code: 'CHAT_MAPPING_CONFLICT' });
  fs.writeFileSync(path.join(f.root, '.chat-archive.lock'), 'interrupted task marker');
  assert.throws(() => commit(f), { code: 'CHAT_ARCHIVE_BUSY' });
  assert.equal(fs.readFileSync(path.join(f.root, '.chat-archive.lock'), 'utf8'), 'interrupted task marker');
});

test('archive child links are refused and cannot write into an external directory', t => {
  const f = fixture(t), outside = path.join(f.directory, 'outside'); fs.mkdirSync(outside);
  try { fs.symlinkSync(outside, path.join(f.root, 'chat-history'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) return t.skip('Symbolic links unavailable'); throw error; }
  assert.throws(() => commit(f), { code: 'CHAT_ARCHIVE_UNSAFE' });
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('normal-exit recovery persists only explicitly allowlisted locator metadata', t => {
  const f = fixture(t);
  assert.equal(readRecoveryMetadata(f.root), null);
  const metadata = { conversationId: f.conversation.conversationId, nativeThreadId: 'native-thread-one', executionState: 'unknown',
    sourceWatermark: 12, operationWatermark: 3, startedAt: at, archiveDate: '2026-10-26', timezone: 'Asia/Shanghai', title: f.conversation.title };
  const saved = saveRecoveryMetadata(f.root, metadata);
  assert.deepEqual(readRecoveryMetadata(f.root), saved);
  for (const field of ['messages', 'draft', 'text', 'content', 'reasoning', 'accountId', 'token']) {
    assert.throws(() => saveRecoveryMetadata(f.root, { ...metadata, [field]: 'FORBIDDEN' }), { code: 'CHAT_RECOVERY_INVALID' });
  }
  assert.deepEqual(readRecoveryMetadata(f.root), saved);
  assert.equal(fs.existsSync(path.join(f.root, 'chat-history')), false);
});
