'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { ChatService, selectProjectDirectory } = require('../src/chat-service.cjs');
const { sanitize } = require('../src/settings.cjs');

function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'maid-chat-service-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const dataDir = path.join(directory, 'isolated profile'), parent = path.join(directory, '中文 父目录');
  fs.mkdirSync(dataDir); fs.mkdirSync(parent);
  const service = new ChatService({ dataDir, ...options });
  return { directory, dataDir, parent, service };
}
function initialize(f) {
  const selected = f.service.selectDirectory(f.parent, 'new');
  return f.service.initialize({ selectionId: selected.selectionId, petName: '小龙娘', userNickname: '测试昵称' });
}

test('chat page migration preserves the original eight-page order and is explicitly opt-in', () => {
  const old = { bubblePageOrder: ['phrase','accounts','quota','conversation','week','today','lastTurn','resetForecast'], bubbleHiddenPages: ['accounts'], defaultBubblePage: 'phrase', mode: 'week' };
  const value = sanitize(old);
  assert.equal(value.chatPageEnabled, false);
  for (const key of ['bubblePageOrder', 'bubbleHiddenPages', 'defaultBubblePage', 'mode']) assert.deepEqual(value[key], old[key]);
  assert.equal(sanitize({ ...old, chatPageEnabled: true, mode: 'chat' }).mode, 'chat');
  assert.equal(sanitize({ ...old, chatPageEnabled: false, mode: 'chat' }).mode, 'quota');
});

test('cancelling the native picker never constructs a chat service or initializes a project', async () => {
  let serviceCalls = 0;
  const result = await selectProjectDirectory({ mode: 'new', window: null,
    defaultParent: () => path.resolve('isolated chooser default'), getService: () => { serviceCalls++; throw new Error('must remain lazy'); },
    dialog: { showOpenDialog: async (_window, options) => { assert.deepEqual(options.properties, ['openDirectory']); return { canceled: true, filePaths: [] }; } } });
  assert.deepEqual(result, { cancelled: true }); assert.equal(serviceCalls, 0);
});

test('opening uninitialized state makes no directories, model requests or identity reads', async t => {
  let factoryCalls = 0;
  const f = fixture(t, { transportFactory: () => { factoryCalls++; throw new Error('must not connect'); } });
  assert.equal(f.service.getState().initialized, false);
  assert.equal(f.service.getState().ready, false);
  assert.deepEqual(fs.readdirSync(f.dataDir), []);
  await assert.rejects(f.service.send({ text: '未发送原文' }), { code: 'CHAT_NOT_READY' });
  assert.equal(factoryCalls, 0);
  assert.equal(f.service.getState().draft, '未发送原文');
  assert.deepEqual(fs.readdirSync(f.dataDir), []);
});

test('only a native-picker selection can initialize; renderer paths and capability claims are rejected', t => {
  const f = fixture(t);
  assert.throws(() => f.service.initialize({ selectionId: 'invented', petName: '小龙娘', userNickname: '昵称' }), { code: 'CHAT_SELECTION_INVALID' });
  const selected = f.service.selectDirectory(f.parent);
  for (const extra of [{ root: f.parent }, { evidence: { ready: true } }, { credentials: 'secret' }]) {
    assert.throws(() => f.service.initialize({ selectionId: selected.selectionId, userNickname: '昵称', ...extra }), { code: 'CHAT_INPUT_INVALID' });
  }
  assert.deepEqual(fs.readdirSync(f.parent), []);
  assert.equal(initialize(f).initialized, true);
  assert.equal(f.service.getState().ready, false);
  const pointer = JSON.parse(fs.readFileSync(path.join(f.dataDir, 'chat-project-pointer.json'), 'utf8'));
  assert.deepEqual(Object.keys(pointer).sort(), ['projectId', 'root', 'schema']);
  assert.equal(Object.hasOwn(f.service.getState().project, 'root'), false);
});

test('explicit memory save immediately changes visible records and remains pending request synchronization', t => {
  const f = fixture(t); initialize(f);
  const before = f.service.getMemory({ module: 'userView' });
  const draft = f.service.setDraft({ scope: 'userView', text: '未保存边界草稿' });
  assert.equal(f.service.getMemory({ module: 'userView' }).entries.length, 0);
  const operation = { module: 'userView', operationId: 'save-once', baseVersion: before.version, action: 'upsert', payload: { entry: { kind: 'boundary', content: '请不要催促我', certainty: 'explicit' } }, draftScope: 'userView', draftRevision: draft.revision };
  f.service.generating = true;
  const receipt = f.service.saveMemory(operation);
  assert.equal(receipt.saved, true); assert.equal(receipt.generatingSnapshotUnchanged, true);
  assert.equal(receipt.synchronization, 'pending-next-request');
  assert.equal(f.service.getMemory({ module: 'userView' }).entries[0].content, '请不要催促我');
  assert.equal(f.service.getState().memory.pendingSync, true);
  assert.equal(f.service.getState().dirtyScopes.includes('userView'), false);
  assert.equal(f.service.saveMemory(operation).duplicate, true);
  assert.equal(f.service.getMemory({ module: 'userView' }).entries.length, 1);
  assert.equal(fs.existsSync(path.join(f.service.project.root, 'chat-history')), false);
});

test('save conflicts and invalid payloads retain the draft and existing committed version', t => {
  const f = fixture(t); initialize(f);
  f.service.setDraft({ scope: 'facts', text: '保留草稿' });
  const before = f.service.getMemory({ module: 'facts' });
  assert.throws(() => f.service.saveMemory({ module: 'facts', operationId: 'stale', baseVersion: 999, action: 'upsert', payload: { entry: { kind: 'fact', content: '不得写入' } } }), { code: 'MEMORY_STALE' });
  assert.throws(() => f.service.saveMemory({ module: 'facts', operationId: 'raw', baseVersion: before.version, action: 'upsert', payload: { entry: { kind: 'fact', content: '不得写入', reasoning: 'secret' } } }));
  assert.equal(f.service.getState().dirtyScopes.includes('facts'), true);
  assert.equal(f.service.getMemory({ module: 'facts' }).version, before.version);
});

test('an older save cannot clear later typing or the other persona editor form', t => {
  const f = fixture(t); initialize(f);
  const original = f.service.setDraft({ scope: 'persona', text: '旧成长草稿' });
  f.service.setDraft({ scope: 'personaNames', text: '尚未保存的名字' });
  f.service.setDraft({ scope: 'persona', text: '保存点击后继续输入的新成长草稿' });
  f.service.saveMemory({ module: 'persona', operationId: 'old-editor-save', baseVersion: 1, action: 'upsert',
    payload: { entry: { kind: 'growth', content: '旧成长草稿' } }, draftScope: 'persona', draftRevision: original.revision });
  assert.equal(f.service.getState().dirtyScopes.includes('persona'), true);
  assert.equal(f.service.getState().dirtyScopes.includes('personaNames'), true);
  assert.match(f.service.copyPendingDrafts(), /保存点击后继续输入/);
});

test('name and formation saves preserve separate entry drafts', t => {
  const f = fixture(t); initialize(f);
  f.service.setDraft({ scope: 'persona', text: '尚未保存的成长' });
  const names = f.service.setDraft({ scope: 'personaNames', text: '新名字\n昵称' });
  f.service.saveMemory({ module: 'persona', operationId: 'names-only', baseVersion: 1, action: 'upsert',
    payload: { names: { pet_name: '新名字', user_nickname: '昵称' } }, draftScope: 'personaNames', draftRevision: names.revision });
  assert.deepEqual(f.service.getState().dirtyScopes, ['persona']);
  f.service.setDraft({ scope: 'userView', text: '未提交的相处边界' });
  f.service.saveMemory({ module: 'userView', operationId: 'formation-only', baseVersion: 1, action: 'pause-automatic', payload: {} });
  assert.equal(f.service.getState().dirtyScopes.includes('userView'), true);
  assert.match(f.service.copyPendingDrafts(), /未提交的相处边界/);
});

test('production admission rejects unverified native transport despite constructor evidence', async t => {
  let calls = 0;
  const f = fixture(t, { evidence: { ready: true }, capabilities: { initialWindow: true, generationHardLimit: true }, transportFactory: () => { calls++; const transport = new EventEmitter(); transport.start = async () => ({}); transport.capabilities = () => ({ ready: false }); return transport; } });
  initialize(f);
  await assert.rejects(f.service.send({ text: '  不丢失这条\n消息  ' }), { code: 'CHAT_NATIVE_NOT_READY' });
  assert.equal(f.service.getState().draft, '  不丢失这条\n消息  ');
  assert.equal(f.service.getState().messages.length, 0);
  await assert.rejects(f.service.activeDream(), { code: 'CHAT_NATIVE_NOT_READY' });
  assert.equal(calls, 1);
});

test('normal-close metadata never persists unsent messages or memory drafts', t => {
  const f = fixture(t); initialize(f);
  f.service.setDraft({ scope: 'chat', text: 'PRIVATE_UNSENT_CHAT' });
  f.service.setDraft({ scope: 'facts', text: 'PRIVATE_UNSAVED_FACT' });
  assert.equal(f.service.hasPendingDrafts(), true);
  assert.match(f.service.copyPendingDrafts(), /PRIVATE_UNSENT_CHAT/);
  f.service.close();
  const reopened = new ChatService({ dataDir: f.dataDir });
  assert.equal(reopened.getState().initialized, true);
  assert.equal(reopened.hasPendingDrafts(), false);
  assert.equal(reopened.getState().draft, '');
  assert.equal(fs.readFileSync(path.join(f.dataDir, 'chat-project-pointer.json'), 'utf8').includes('PRIVATE_'), false);
  assert.equal(fs.existsSync(path.join(f.service.project.root, 'chat-history')), false);
});

test('isolated injected stream validates UI plumbing without enabling the shipping adapter', async t => {
  class MockTransport extends EventEmitter {
    async start() { return { connected: true }; }
    async startThread(input) { assert.match(input.developerInstructions, /persona/); return { threadId: 'synthetic-own-thread' }; }
    async send(threadId) {
      this.emit('message', { threadId: 'other-project', id: 'foreign', role: 'assistant', content: [{ text: 'DO_NOT_SHOW' }] });
      this.emit('message', { threadId, id: 'reply', role: 'assistant', phase: 'final_answer', content: [{ text: '' }] });
      this.emit('messageDelta', { threadId, itemId: 'reply', delta: '合成片段' });
      this.emit('message', { threadId, id: 'reply', role: 'assistant', phase: 'final_answer', content: [{ text: '合成完整回答' }], completed: true });
      return { id: 'synthetic-turn', status: 'completed' };
    }
    close() {}
  }
  const f = fixture(t, { simulation: true, transportFactory: () => new MockTransport(), countTokens: () => 10 });
  initialize(f);
  for (const module of ['persona','userView','facts']) f.service.memory.publishPreinput({ module, baseVersion: 1, segments: [] });
  const value = await f.service.send({ text: '合成问题' });
  assert.equal(value.mode, 'simulation');
  assert.equal(value.messages.length, 2);
  assert.equal(value.messages[1].text, '合成完整回答');
  assert.equal(value.messages.some(message => message.id === 'foreign'), false);
  assert.equal(value.draft, '');
  assert.equal(fs.existsSync(path.join(f.service.project.root, 'chat-history')), false);
  assert.equal(f.service.getState().memory.pendingSync, false);
  const module = f.service.getMemory({ module: 'userView' });
  f.service.saveMemory({ module: 'userView', operationId: 'later-save', baseVersion: module.version, action: 'upsert', payload: { entry: { kind: 'boundary', content: '新边界' } } });
  await assert.rejects(f.service.send({ text: '下次消息' }), { code: 'CHAT_CONTEXT_SYNC_UNVERIFIED' });
  assert.equal(f.service.getState().memory.pendingSync, true);
});
