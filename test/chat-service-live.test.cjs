'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { EventEmitter } = require('node:events');
const { ChatService } = require('../src/chat-service.cjs');
const { ChatHistory } = require('../src/chat-history.cjs');
const { setImmediate: tick } = require('node:timers/promises');

class NativeFixture extends EventEmitter {
  constructor() { super(); this.threads = new Map(); this.sent = []; this.active = new Map(); this.immediate = true; this.sequence = 0; }
  async start() { return this.status(); }
  status() { return { connected: true, ready: true, accountType: 'chatgpt' }; }
  capabilities() { return { ready: true }; }
  measure(value) { return Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value)); }
  models() { return [{ id: 'gpt-6.1-sol', displayName: 'GPT-6.1 Sol', efforts: ['medium', 'high'] }]; }
  window(model) { return { verified: model === 'gpt-6.1-sol', effective: 258400, outputReserve: 32768, maintenanceReserve: 8192 }; }
  async startThread(input) { const threadId = `thread-${++this.sequence}`; this.threads.set(threadId, []); this.lastStartup = input; return { threadId }; }
  async resumeThread() { return { resumed: true, contextRecoveryRequired: false }; }
  contextMetadata(threadId) {
    const turn = this.threads.get(threadId)?.at(-1);
    return { threadId, model: 'gpt-6.1-sol', effort: 'medium', textUpper: 10000, observedUsed: 8000, observedWindow: 258400,
      turnId: turn?.id ?? null, turnStatus: turn?.status ?? null, contextReady: !turn || ['completed','failed','cancelled','interrupted'].includes(turn.status) };
  }
  async send(threadId, input) {
    this.sent.push({ threadId, ...input });
    const id = `turn-${this.sent.length}`, user = { id: `user-${id}`, clientId: input.clientMessageId, role: 'user', turnId: id, content: input.content, contentComplete: true };
    const turn = { id, status: 'inProgress', fullItems: true, items: [user] }; this.threads.get(threadId).push(turn);
    this.emit('message', { threadId, ...user, completed: true }); this.emit('turn', { threadId, id, status: 'inProgress' });
    if (this.immediate) this.complete(threadId);
    return { id, status: turn.status };
  }
  complete(threadId, status = 'completed') {
    const turn = this.threads.get(threadId).at(-1), request = this.sent.find(value => value.threadId === threadId && value.clientMessageId === turn.items[0].clientId);
    const text = request.outputSchema ? JSON.stringify({ answer: '合成回答', signals: [] }) : '合成回答';
    const item = { id: `reply-${turn.id}`, turnId: turn.id, role: 'assistant', phase: 'final_answer', content: [{ text }] };
    turn.items.push(item); turn.status = status; this.emit('message', { ...item, threadId, completed: true }); this.emit('turn', { threadId, id: turn.id, status });
  }
  async readOwnThread(threadId, input) { return input ? { threadId, data: this.threads.get(threadId), complete: true, nextCursor: null, sourceRecoveryVerified: true } : { threadId, status: 'idle' }; }
  async steer(threadId, input) {
    this.steered = { threadId, ...input }; return { acknowledged: true };
  }
  async interrupt(threadId) { this.complete(threadId, 'interrupted'); return { requested: true }; }
  async generate(input) {
    const data = JSON.parse(input.input), ref = `${this.getConversation()}/M000001/P01`; let result;
    if (data.leaf) result = { text: '合成验收问答精简版。', guide: '核对完整 L1。', entries: [{ text: '合成验收问答。', refs: [`${data.leaf.ref}#I01`] }] };
    else if (input.outputSchema.properties.changes && input.outputSchema.properties.summary) result = { changes: [], summary: { text: '合成验收问答。', guide: '核对原始问答。', entries: [{ text: '合成验收问答。', refs: [ref] }] } };
    else if (input.instructions.includes('提取明确事实')) result = { changes: [] };
    else if (input.instructions.includes('压缩预输入')) result = { segments: [] };
    else if (input.instructions.includes('递归交接')) result = { text: '刚完成合成验收问答。', refs: [ref] };
    else result = { text: '合成验收问答。', guide: '核对原始问答。', entries: [{ text: '合成验收问答。', refs: [ref] }] };
    return { status: 'completed', finalText: JSON.stringify(result) };
  }
  close() {}
}
function fixture(t) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'maid-service-live-')), dataDir = path.join(sandbox, '隔离 数据'), parent = path.join(sandbox, '非默认 路径'); fs.mkdirSync(dataDir); fs.mkdirSync(parent);
  // This suite exercises the real service/history worker against a fake native
  // transport. Keep model loading isolated too: host-prepared ONNX resources
  // must not turn every transport fixture into an unrelated native session.
  // The pinned encoder and worker restart paths have dedicated retrieval tests.
  const historyFactory = options => new ChatHistory({ ...options, semanticOptions: { resourceRoot: path.join(sandbox, 'absent-semantic-resources') } });
  const native = new NativeFixture(), service = new ChatService({ dataDir, transportFactory: () => native, historyFactory }); native.getConversation = () => service.conversation.conversationId;
  const choice = service.selectDirectory(parent); service.initialize({ selectionId: choice.selectionId, petName: '小龙娘', userNickname: '测试' });
  t.after(async () => { await service.close(); fs.rmSync(sandbox, { recursive: true, force: true }); }); return { service, native, sandbox, historyFactory };
}
test('production service sends default model/effort and streams without writing ordinary-turn bodies', async t => {
  const { service, native } = fixture(t); const state = await service.send({ text: '合成验收问题' });
  assert.equal(state.ready, true); assert.equal(state.mode, 'live'); assert.equal(state.messages.at(-1).text, '合成回答');
  assert.equal(native.sent[0].model, 'gpt-6.1-sol'); assert.equal(native.sent[0].effort, 'medium'); assert.equal(state.memory.pendingSync, false);
  assert.equal(fs.existsSync(path.join(service.project.root, 'chat-history')), false);
  await service.send({ text: '合成后续' }); assert.equal(native.sent[1].additionalContext, undefined);
});

test('foreground token accounting is turn scoped, ignores foreign threads and deduplicates late events',async t=>{
  const {service,native}=fixture(t);native.immediate=false;await service.send({text:'PRIVATE_USAGE_INPUT'});
  const firstThread=service.threadId,firstTurn=service.activeTurnId;
  native.emit('usage',{threadId:firstThread,turnId:firstTurn,last:{inputTokens:100,outputTokens:20,totalTokens:120},total:{inputTokens:100,outputTokens:20,totalTokens:120}});
  native.complete(firstThread);await service.send({text:'PRIVATE_USAGE_SECOND'});const secondTurn=service.activeTurnId;
  const event={threadId:firstThread,turnId:secondTurn,last:{inputTokens:200,outputTokens:10,totalTokens:210},total:{inputTokens:300,outputTokens:30,totalTokens:330}};
  native.emit('usage',event);native.emit('usage',event);native.emit('usage',{...event,threadId:'unrelated-codex-thread',last:{inputTokens:999999,totalTokens:999999}});native.complete(firstThread);
  native.emit('usage',{threadId:firstThread,turnId:firstTurn,last:{inputTokens:100,outputTokens:20,totalTokens:120},total:{inputTokens:100,outputTokens:20,totalTokens:120}});
  const report=service.listUsage({});assert.equal(report.summary.requests,2);assert.equal(report.summary.tokens.totalTokens,330);assert.equal(report.summary.completed,2);assert.equal(JSON.stringify(report).includes('PRIVATE_USAGE'),false);
});
test('refreshing available models rereads the native catalog and retains the selected model and draft', async t => {
  const {service,native} = fixture(t);
  let reads = 0, terra = false;
  native.models = () => { reads++; return [{id:'gpt-6.1-sol',model:'gpt-6.1-sol',efforts:['medium','high']},...(terra?[{id:'server-display-id',model:'gpt-6.1-terra',displayName:'GPT-6.1 Terra',efforts:['medium','high']}]:[])]; };
  await service.listModels(); const firstReads = reads;
  service.setDraft({scope:'chat',text:'保留未发送的输入'});
  terra = true;
  const refreshed = await service.listModels();
  assert.equal(reads, firstReads + 1);
  assert.ok(refreshed.models.some(model => model.id === 'gpt-6.1-terra'));
  assert.equal(refreshed.selectedModel, 'gpt-6.1-sol');
  assert.equal(service.getState().draft, '保留未发送的输入');
  await service.configure({model:'gpt-6.1-terra',reasoningEffort:'medium'});
  assert.equal(service._settings().model, 'gpt-6.1-terra');
  assert.equal(native.sent.length, 0);
});
test('failed model refresh keeps the previous confirmed catalog and selected model', async t => {
  const {service,native} = fixture(t);
  const first = await service.listModels();
  native.models = async () => { throw Object.assign(Error('synthetic model refresh failed'),{code:'MODEL_REFRESH_FAILED'}); };
  await assert.rejects(service.listModels(),{code:'MODEL_REFRESH_FAILED'});
  assert.deepEqual(service.modelsCache, first.models);
  assert.equal(service._settings().model, first.selectedModel);
  assert.equal(native.sent.length, 0);
});
test('a save during generation is synchronized only on the next request and keeps current snapshot', async t => {
  const { service, native } = fixture(t); native.immediate = false; await service.send({ text: '第一条' });
  service.saveMemory({ module: 'userView', operationId: 'save-inflight', baseVersion: 1, action: 'upsert', payload: { entry: { kind: 'boundary', content: '不要催促', certainty: 'explicit' } } });
  assert.equal(service.getState().memory.pendingSync, true); assert.equal(native.sent.length, 1);
  native.complete(service.threadId); native.immediate = true; await service.send({ text: '第二条' });
  assert.match(native.sent[1].additionalContext, /不要催促/); assert.equal(service.getState().memory.pendingSync, false);
  await assert.rejects(service.configure({ model: 'missing', reasoningEffort: 'medium' }), { code: 'CHAT_MODEL_UNAVAILABLE' });
  await service.configure({ model: 'gpt-6.1-sol', reasoningEffort: 'high' }); await service.send({ text: '第三条' }); assert.equal(native.sent[2].effort, 'high');
});
test('unknown execution cannot replay; explicit queue waits for a terminal event', async t => {
  const { service, native } = fixture(t); native.immediate = false; await service.send({ text: '第一条' });
  await service.send({ text: '排队条目', queue: true }); assert.equal(service.getState().queued.length, 1); assert.equal(native.sent.length, 1);
  native.emit('disconnected'); await assert.rejects(service.send({ text: '不能重发' }), { code: 'CHAT_REQUEST_PENDING' }); assert.equal(native.sent.length, 1);
  native.complete(service.threadId); await service.reconcile(); await tick(); await tick(); assert.equal(native.sent.length, 2);
});
test('manual checkpoint executes actual workflow and a new native thread with one archived conversation', async t => {
  const { service } = fixture(t); await service.send({ text: '合成完整验收问题' }); const oldThread = service.threadId, oldC = service.conversation.conversationId;
  await service.maintenance({ action: 'checkpoint' }); assert.notEqual(service.threadId, oldThread);
  const list = await service.listHistory({ cursor: null }); assert.equal(list.conversations.length, 1); assert.equal(list.conversations[0].conversationId, oldC);
  const history = await service.readHistory({ conversationId: oldC }); assert.equal(history.messages[0].text, '合成完整验收问题'); assert.equal(history.messages[1].text, '合成回答');
  assert.equal(Object.keys(service.workflow.tree.state().conversations).length, 1);
});
test('a lost acknowledgement is reconciled by its exact client ID after reopening without replaying it', async t => {
  const { service, native, historyFactory } = fixture(t); const original = native.send.bind(native);
  native.send = async (thread, input) => { await original(thread, input); throw Object.assign(new Error('lost ack'), { code: 'DISCONNECTED', executionState: 'unknown' }); };
  await assert.rejects(service.send({ text: '仅合成未知请求', clientMessageId: 'lost-ack-once' }), { code: 'DISCONNECTED' });
  assert.equal(service.getState().unknownExecution, true); await service.close();
  native.send = original;
  native.resumeThread = async () => ({ contextRecoveryRequired: true });
  const reopened = new ChatService({ dataDir: service.dataDir, transportFactory: () => native, historyFactory }); t.after(async () => { await reopened.close(); });
  await assert.rejects(reopened.reconcile(), { code: 'CHAT_CONTEXT_RECOVERY_REQUIRED' }); assert.equal(native.sent.length, 1); assert.equal(reopened.getState().unknownExecution, false);
  assert.equal(reopened.getState().contextRecoveryRequired, true); assert.equal(reopened.getState().ready, false);
  assert.equal(reopened.getState().messages.filter(value => value.role === 'user').length, 1);
  await reopened.maintenance({ action: 'checkpoint' }); assert.equal((await reopened.listHistory()).conversations.length, 1); await reopened.close();
});
test('a missing client ID never clears an unresolved dispatch just because an older turn ended', async t => {
  const { service, native } = fixture(t); await service.send({ text: '已经结束的旧请求' });
  native.send = async () => { throw Object.assign(new Error('unknown dispatch'), { code: 'DISCONNECTED', executionState: 'unknown' }); };
  await assert.rejects(service.send({ text: '尚未确认的请求' }), { code: 'DISCONNECTED' });
  await assert.rejects(service.reconcile(), { code: 'CHAT_EXECUTION_UNKNOWN' }); assert.equal(native.sent.length, 1);
  assert.equal(service.getState().draft, '尚未确认的请求');
});
test('image selection preserves originals and renderer paths cannot masquerade as staged images', async t => {
  const { service } = fixture(t);
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  const result = service.stageImages({ images: [{ bytes, mime: 'image/png', name: '原图.png' }] });
  await assert.rejects(service.send({ content: [{ image: { path: 'C:/forbidden.png' } }] }), { code: 'CHAT_INPUT_INVALID' });
  await service.send({ content: [{ text: '先' }, { imageId: result.images[0].imageId }, { text: '后' }] });
  const user = service.messageBuffer.find(value => value.role === 'user'); assert.ok(user.content[1].image.bytes.equals(bytes));
  assert.deepEqual(user.content.filter(part => part.text).map(part => part.text), ['先', '后']);
  assert.equal(service.stagedImages.size, 0);
});
test('streamed control envelopes expose only the answer and temporary signals never enter the archive', async t => {
  const { service, native } = fixture(t); native.immediate = false; await service.send({ text: '合成情绪触发' });
  const item = { threadId: service.threadId, turnId: service.activeTurnId, id: 'signal-answer', role: 'assistant', phase: 'final_answer', content: [{ text: '' }] };
  native.emit('message', item);
  native.emit('messageDelta', { threadId: service.threadId, turnId: service.activeTurnId, itemId: item.id, delta: '{"answer":"合成可见回答","signals":[{"kind":"emotion","label":"轻快","eventId":"event-once"}]}' });
  assert.equal(service.getState().messages.at(-1).text, '合成可见回答'); assert.equal(JSON.stringify(service.getState().messages).includes('event-once'), false);
  const raw = JSON.stringify({ answer: '合成可见回答', signals: [{ kind: 'emotion', label: '轻快', eventId: 'event-once' }] });
  const turn = native.threads.get(service.threadId).at(-1); turn.items.push({ ...item, content: [{ text: raw }] }); turn.status = 'completed';
  native.emit('message', { ...item, completed: true, content: [{ text: raw }] }); native.emit('turn', { threadId: service.threadId, id: turn.id, status: 'completed' });
  assert.equal(service.personaRuntime.snapshot().emotion.remaining, 2);
  await service.maintenance({ action: 'checkpoint' }); const list = await service.listHistory(); const messages = (await service.readHistory({ conversationId: list.conversations[0].conversationId })).messages;
  assert.equal(messages.at(-1).text, '合成可见回答'); assert.equal(JSON.stringify(messages).includes('event-once'), false);
});
test('queue scheduling takes one turn at a time and repeated drain notifications cannot race', async t => {
  const { service, native } = fixture(t); native.immediate = false; await service.send({ text: '第一轮' });
  await service.send({ text: '第二轮', queue: true }); await service.send({ text: '第三轮', queue: true });
  native.complete(service.threadId); service._drain(); service._drain(); service._drain();
  await tick(); await tick(); assert.equal(native.sent.length, 2); assert.equal(native.sent[1].content[0].text, '第二轮'); assert.equal(service.queued.length, 1);
  native.complete(service.threadId); await tick(); await tick(); assert.equal(native.sent.length, 3); assert.equal(native.sent[2].content[0].text, '第三轮');
});
test('steering rejects a reused client ID and preserves a definitely unexecuted addition as a draft', async t => {
  const { service, native } = fixture(t); native.immediate = false; await service.send({ text: '原始请求', clientMessageId: 'original-once' });
  await assert.rejects(service.steer({ text: '不能重用', clientMessageId: 'original-once' }), { code: 'CHAT_DUPLICATE_REQUEST' });
  native.steer = async () => { throw Object.assign(new Error('pre-dispatch failure'), { executionState: 'not-executed' }); };
  await assert.rejects(service.steer({ text: '保留追加草稿', clientMessageId: 'steer-once' }));
  assert.equal(service.getState().draft, '保留追加草稿'); assert.equal(service.getState().unknownExecution, false); assert.equal(service.clientOperations.has('original-once'), true);
});
test('recovery storage failure before dispatch retains input and cannot create a phantom native request', async t => {
  const { service, native } = fixture(t); const io = Object.create(fs);
  io.openSync = (file, ...args) => { if (String(file).includes('chat-service-recovery.jsonl.')) throw Object.assign(new Error('synthetic full disk'), { code: 'ENOSPC' }); return fs.openSync(file, ...args); };
  service.io = io;
  await assert.rejects(service.send({ text: '磁盘故障保留', clientMessageId: 'disk-fail-once' }), { code: 'CHAT_RECOVERY_WRITE_FAILED', executionState: 'not-executed' });
  assert.equal(native.sent.length, 0); assert.equal(service.getState().draft, '磁盘故障保留'); assert.equal(service.clientOperations.size, 0); assert.equal(service.pendingDispatch, undefined);
  service.io = fs; service.storageError = null; service._persistRecovery();
});
test('close freezes new requests and confirms a bounded terminal state before final metadata persistence', async t => {
  const { service, native } = fixture(t); native.immediate = false; await service.send({ text: '关闭前请求' });
  native.reconcile = async (_threadId, turnId) => ({ id: turnId, status: 'interrupted' });
  const result = await service.prepareClose(); assert.equal(result.terminalConfirmed, true); assert.equal(service.getState().generating, false);
  await assert.rejects(service.send({ text: '关闭时不得新发' }), { code: 'CHAT_CLOSING' }); assert.equal(native.sent.length, 1);
});

test('reconnect uses the newest runtime bound and continues the same under-capacity conversation', async t => {
  const { service, native } = fixture(t); await service.send({ text: '第一条合成消息' });
  const threadId = service.threadId, latest = { ...native.contextMetadata(threadId), bound: 'latest-runtime' };
  native.contextMetadata = () => latest;
  service.savedContext = { threadId, bound: 'old-disk-load', turnId: 'older-turn' };
  service.connection = { state: 'error', reason: 'DISCONNECTED' };
  let resumedWith;
  native.resumeThread = async (id, options) => { assert.equal(id, threadId); resumedWith = options.contextMetadata; return { contextRecoveryRequired: false }; };
  await service.reconcile();
  assert.deepEqual(resumedWith, latest); assert.equal(service.getState().contextRecoveryRequired, false);
  await service.send({ text: '继续同一条合成对话' });
  assert.equal(service.threadId, threadId); assert.equal(native.sequence, 1); assert.equal(native.sent.length, 2);
});

test('invalid recovery capacity preserves the conversation and draft until an explicit checkpoint', async t => {
  const { service, native } = fixture(t); await service.send({ text: '容量尚未满的合成对话' });
  const threadId = service.threadId;
  native.resumeThread = async () => { throw Object.assign(new Error('synthetic changed native proof'), { code: 'CHAT_CONTEXT_METADATA_INVALID' }); };
  service.connection = { state: 'error', reason: 'DISCONNECTED' };
  await assert.rejects(service.reconcile(), { code: 'CHAT_CONTEXT_RECOVERY_REQUIRED' });
  assert.equal(service.getState().ready, false); assert.equal(service.getState().contextRecoveryRequired, true);
  assert.ok(service.getState().missing.includes('context-recovery-required')); assert.equal(service.getState().health.context, 'recovery-required');
  await assert.rejects(service.send({ text: '必须保留的后续输入' }), { code: 'CHAT_CONTEXT_RECOVERY_REQUIRED', executionState: 'not-executed' });
  service.checkpointPending = true; service._drain(); await tick(); await tick();
  assert.equal(service.threadId, threadId); assert.equal(native.sequence, 1); assert.equal(native.sent.length, 1);
  assert.equal(service.getState().draft, '必须保留的后续输入');
  await assert.rejects(service.maintenance({ action: 'resume' }), { code: 'CHAT_CONTEXT_RECOVERY_REQUIRED' });
  await service.maintenance({ action: 'checkpoint' });
  assert.notEqual(service.threadId, threadId); assert.equal(service.getState().contextRecoveryRequired, false);
  assert.equal(service.getState().draft, '必须保留的后续输入');
});

test('an empty recovered thread is not discarded because its context bound needs verification', async t => {
  const { service, native } = fixture(t); await service.send({ text: '合成占位消息' });
  const threadId = service.threadId, conversation = service.conversation;
  service.activeTurnId = null; service.activeTurnStatus = 'idle'; service.contextNeedsCheckpoint = true;
  await assert.rejects(service.send({ text: '空对话恢复输入' }), { code: 'CHAT_CONTEXT_RECOVERY_REQUIRED' });
  assert.equal(service.threadId, threadId); assert.equal(service.conversation, conversation); assert.equal(native.sequence, 1);
  assert.equal(service.getState().draft, '空对话恢复输入');
});

test('an explicit new conversation recovers a verified zero-turn thread and preserves its original native record', async t => {
  const { service, native } = fixture(t); await service._ensureConnected();
  const original = await service._newThread(await service._prepare('synthetic-empty-creation', 0));
  service.threadId = original.threadId; service.conversation = original.conversation; service.pendingCreation = null;
  service.contextNeedsCheckpoint = true; service._persistRecovery();
  await assert.rejects(service.send({ text: '等待明确恢复的输入' }), { code: 'CHAT_CONTEXT_RECOVERY_REQUIRED' });
  assert.equal(native.sequence, 1);
  await service.maintenance({ action: 'new-conversation' });
  assert.notEqual(service.threadId, original.threadId); assert.equal(native.sequence, 2);
  assert.deepEqual(native.threads.get(original.threadId), []); assert.equal(native.sent.length, 0);
  assert.equal(service.getState().contextRecoveryRequired, false); assert.equal(service.getState().ready, true);
  assert.equal(service.getState().draft, '等待明确恢复的输入');
});

test('explicit empty recovery rejects nonempty, incomplete, failed or pending native evidence', async t => {
  for (const mode of ['nonempty', 'incomplete', 'failed', 'pending', 'active']) await t.test(mode, async sub => {
    const { service, native } = fixture(sub); await service._ensureConnected();
    const original = await service._newThread(await service._prepare(`synthetic-empty-${mode}`, 0));
    service.threadId = original.threadId; service.conversation = original.conversation; service.pendingCreation = null;
    service.contextNeedsCheckpoint = true; service.drafts.set('chat', '不得丢弃的输入');
    const read = native.readOwnThread.bind(native);
    native.readOwnThread = async (id, options) => {
      if (!options) return read(id, options);
      if (mode === 'failed') throw Object.assign(new Error('synthetic source unavailable'), { code: 'CHAT_SOURCE_UNAVAILABLE' });
      return { threadId: id, sourceRecoveryVerified: true, data: mode === 'nonempty' ? [{ id: 'persisted-turn', status: 'completed', items: [] }] : [],
        complete: mode !== 'incomplete', nextCursor: mode === 'incomplete' ? 'unread-page' : null };
    };
    if (mode === 'pending') service.pendingDispatch = { clientId: 'unresolved-send' };
    if (mode === 'active') native.active.set(original.threadId, { id: 'unresolved-turn', status: 'unknown' });
    const code = mode === 'nonempty' ? 'CHAT_CHECKPOINT_EMPTY' : mode === 'incomplete' ? 'CHAT_SOURCE_INCOMPLETE' : mode === 'failed' ? 'CHAT_SOURCE_UNAVAILABLE' : 'CHAT_REQUEST_PENDING';
    await assert.rejects(service.maintenance({ action: 'checkpoint' }), { code });
    assert.equal(service.threadId, original.threadId); assert.equal(native.sequence, 1); assert.equal(native.sent.length, 0);
    assert.equal(service.getState().contextRecoveryRequired, true); assert.equal(service.getState().draft, '不得丢弃的输入');
  });
});

test('recovery persistence retains the last proof when the replacement runtime has no bound yet', async t => {
  const { service, native } = fixture(t); await service.send({ text: '保全恢复证据的合成消息' });
  const latest = { threadId: service.threadId, bound: 'synthetic-latest-proof' };
  native.contextMetadata = () => latest;
  service._persistRecovery(); assert.deepEqual(service.savedContext, latest);
  native.contextMetadata = () => { throw Object.assign(new Error('new runtime has not resumed'), { code: 'CHAT_CONTEXT_RECOVERY_REQUIRED' }); };
  service._persistRecovery();
  const journal = new (require('../src/chat-journal.cjs').ChatJournal)(service.project.root);
  assert.deepEqual(journal.read('chat-service-recovery.jsonl').contextMetadata, latest); assert.deepEqual(service.savedContext, latest);
});

test('repair saves the live bound before replacing its runtime owner', async t => {
  const { service, native } = fixture(t); await service.send({ text: '修复前合成消息' });
  const latest = { threadId: service.threadId, bound: 'latest-before-close' }; let closed = false, resumedWith;
  native.contextMetadata = () => { if (closed) throw Object.assign(new Error('owner closed'), { code: 'CHAT_CONTEXT_RECOVERY_REQUIRED' }); return latest; };
  native.close = () => { closed = true; };
  native.resumeThread = async (_id, options) => { resumedWith = options.contextMetadata; return { contextRecoveryRequired: false }; };
  await service.maintenance({ action: 'repair' });
  assert.equal(closed, true); assert.deepEqual(resumedWith, latest); assert.equal(native.sequence, 1); assert.equal(service.getState().contextRecoveryRequired, false);
});

test('desktop registration readiness is refreshed before dispatch without creating scattered threads', async t => {
  const { service, native } = fixture(t); let registered = false, reconciliations = 0;
  native.ensureDesktopProject = async () => ({ projectId: registered ? 'desktop-project' : null, desktopRegistered: registered, localProjectId: null, registrationRequired: !registered });
  native.reconcileDesktopProject = async () => { reconciliations++; return { discovered: 2, assigned: 2, alreadyAssigned: 0, conflicts: 0, failed: 0, discoveryComplete: true }; };
  await assert.rejects(service.send({ text: '等待项目归集的输入' }), { code: 'CHAT_DESKTOP_PROJECT_REQUIRED', executionState: 'not-executed' });
  assert.equal(native.sequence, 0); assert.equal(service.getState().ready, false); assert.equal(service.getState().desktopProject.registrationRequired, true);
  assert.ok(service.getState().missing.includes('desktop-project-required')); assert.equal(service.getState().draft, '等待项目归集的输入');
  assert.equal(service.getState().project.directory, service.project.root);
  registered = true; await service.reconcile();
  assert.equal(service.getState().ready, true); assert.equal(service.getState().desktopProject.reconciliation.assigned, 2);
  await service.send({ text: '注册后合成消息' }); await service.send({ text: '仍在同项目内的后续消息' });
  assert.equal(reconciliations, 1);
  assert.equal(service.getState().desktopProject.reconciliation.assigned, 2);
  assert.equal(native.sequence, 1); assert.equal(native.sent.length, 2);
});

test('a native writer conflict never turns into a capacity checkpoint or an automatic fork', async t => {
  const { service, native } = fixture(t); await service.send({ text: '另一个界面只读查看的合成对话' });
  const threadId = service.threadId;
  native.resumeThread = async () => { throw Object.assign(new Error('synthetic active writer'), { code: 'THREAD_WRITER_CONFLICT' }); };
  service.connection = { state: 'error', reason: 'DISCONNECTED' };
  await assert.rejects(service.send({ text: '写入占用期间保留的输入' }), { code: 'THREAD_WRITER_CONFLICT' });
  assert.equal(service.threadId, threadId); assert.equal(native.sequence, 1); assert.equal(native.sent.length, 1);
  assert.equal(service.getState().draft, '写入占用期间保留的输入'); assert.equal(service.getState().contextRecoveryRequired, false);
});

test('partial historical grouping remains visible, permits correctly bound new chat and retries only on request', async t => {
  const { service, native } = fixture(t); let attempts = 0, resolved = false;
  native.ensureDesktopProject = async () => ({ projectId: 'desktop-project', desktopRegistered: true, localProjectId: 'local-project', registrationRequired: false });
  native.reconcileDesktopProject = async () => { attempts++; return { discovered: 3, assigned: resolved ? 1 : 2, alreadyAssigned: resolved ? 2 : 0,
    conflicts: resolved ? 0 : 1, failed: 0, discoveryComplete: true }; };
  await service._ensureConnected();
  assert.equal(attempts, 1); assert.equal(service.getState().health.desktopProject, 'needs-reconciliation');
  assert.equal(service.getState().desktopProject.reconciliation.conflicts, 1); assert.equal(service.getState().ready, true);
  await service.send({ text: '新对话仍绑定到已登记的项目' }); await service.send({ text: '普通发送不反复归集旧对话' });
  assert.equal(attempts, 1); assert.equal(service.getState().desktopProject.reconciliation.needsReconciliation, true);
  resolved = true; await service.reconcile();
  assert.equal(attempts, 2); assert.equal(service.getState().health.desktopProject, 'ready');
  assert.equal(service.getState().desktopProject.reconciliation.needsReconciliation, false); assert.equal(native.sequence, 1);
});

test('failed historical discovery is surfaced and an explicit repair can retry it', async t => {
  const { service, native } = fixture(t); let attempts = 0;
  native.ensureDesktopProject = async () => ({ projectId: 'desktop-project', desktopRegistered: true, localProjectId: null, registrationRequired: false });
  native.reconcileDesktopProject = async () => { if (++attempts === 1) throw Object.assign(new Error('synthetic discovery failure'), { code: 'CHAT_DESKTOP_PROJECT_PROTOCOL' });
    return { discovered: 1, assigned: 1, alreadyAssigned: 0, conflicts: 0, failed: 0, discoveryComplete: true }; };
  await service._ensureConnected();
  assert.equal(service.getState().ready, true); assert.equal(service.getState().health.desktopProject, 'needs-reconciliation');
  assert.equal(service.getState().desktopProject.reconciliation.discoveryComplete, false); assert.equal(service.getState().desktopProject.reconciliation.failed, 1);
  await service.maintenance({ action: 'repair' });
  assert.equal(attempts, 2); assert.equal(service.getState().health.desktopProject, 'ready');
});
