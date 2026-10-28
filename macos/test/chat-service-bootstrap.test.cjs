'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), { EventEmitter } = require('node:events');
const { setImmediate: tick } = require('node:timers/promises');
const { ChatService } = require('../src/chat-service.cjs');
const { createConversation, commitCheckpoint } = require('../src/chat-archive.cjs');

function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
class Native extends EventEmitter {
  start() { return Promise.resolve(this.status()); }
  status() { return { ready: true, connected: true, accountType: 'chatgpt' }; }
  capabilities() { return { ready: true }; }
  models() { return [{ id: 'gpt-6.1-sol', efforts: ['medium'] }]; }
  window() { return { verified: true, effective: 258400, outputReserve: 32768, maintenanceReserve: 8192 }; }
  generate() { throw new Error('Model requests are forbidden in history bootstrap'); }
  close() {}
}
function fixture(t, makeHistory) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'maid-bootstrap-中文 空格 ')), dataDir = path.join(sandbox, '数据'), parent = path.join(sandbox, '自定义项目');
  fs.mkdirSync(dataDir); fs.mkdirSync(parent); const histories = [];
  const service = new ChatService({ dataDir, transportFactory: () => new Native(), historyFactory: options => {
    assert.equal(options.projectRoot, service.project.root); const history = makeHistory(options, histories.length); histories.push(history); return history;
  }, workflowFactory: () => ({ status: () => ({ state: 'idle' }), dream: async () => ({ state: 'idle' }), nextDreamAt: () => null, stop() {}, cancelDream() {} }) });
  const selection = service.selectDirectory(parent); service.initialize({ selectionId: selection.selectionId, petName: '合成桌宠', userNickname: '合成用户' });
  const conversation = createConversation({ root: service.project.root, startedAt: '2026-10-26T12:00:00Z', timezone: 'Asia/Shanghai' });
  commitCheckpoint({ root: service.project.root, conversation, sourceComplete: true, trigger: 'new-conversation', records: [
    { turn: { id: 'T1', observed_at: '2026-10-26T12:00:00Z' } },
    { id: 'M1', role: 'user', turn_id: 'T1', time: '2026-10-26T12:00:00Z', content: [{ text: '已归档的合成启动检查，不是真实聊天。' }] },
    { turn_result: { id: 'T1', status: 'completed', observed_at: '2026-10-26T12:00:01Z' } }
  ] });
  t.after(async () => { await service.close(); fs.rmSync(sandbox, { recursive: true, force: true }); });
  return { service, histories, sandbox };
}
function historyState(boot = deferred()) {
  let listener, retained; const health = { lexical: 'ready', semantic: 'loading', coverage: 'partial' };
  return { boot, calls: 0, closed: false, unsubscribed: 0, health: () => ({ ...health }),
    onHealthChange(callback) { listener = retained = callback; return () => { listener = null; this.unsubscribed++; }; },
    initialize(options) { this.calls++; this.options = options; return boot.promise; },
    publish(patch, late = false) { Object.assign(health, patch); (late ? retained : listener)?.({ ...health }); },
    close() { this.closed = true; },
  };
}
test('connecting an archived project starts one background initialization without awaiting it or issuing a model request', async t => {
  const history = historyState(), { service } = fixture(t, options => { assert.ok(fs.existsSync(path.join(options.projectRoot, 'chat-history'))); return history; });
  const states = []; service.on('state', state => states.push(state));
  await service.listModels(); assert.equal(service.getState().ready, true); assert.equal(history.calls, 1);
  await service.listModels(); assert.equal(history.calls, 1); assert.equal(service.getState().health.search.semantic, 'loading');
  history.publish({ semantic: 'ready', coverage: 'ready' }); assert.equal(states.at(-1).health.search.semantic, 'ready');
  history.boot.resolve({ status: 'ready' }); await tick(); assert.equal(service.getState().ready, true); assert.equal(history.calls, 1);
});
test('background initialization errors stay inside search health and preserve chat readiness without retries', async t => {
  const history = historyState(), { service } = fixture(t, () => history); await service.listModels();
  history.boot.reject(Object.assign(new Error('synthetic locked derived index'), { code: 'CHAT_HISTORY_WORKER_FAILED' })); await tick();
  const state = service.getState(); assert.equal(state.ready, true); assert.equal(state.connection.state, 'ready');
  assert.equal(state.health.search.coverage, 'partial'); assert.equal(state.health.search.initializationError, 'CHAT_HISTORY_WORKER_FAILED');
  await service.listModels(); await tick(); assert.equal(history.calls, 1);
});
test('closing before the scheduled initializer cancels startup and detaches late health notifications', async t => {
  const history = historyState(), { service } = fixture(t, () => history); service.history = history;
  let changes = 0; service.on('state', () => changes++); service._startHistoryBootstrap(history); await service.close();
  history.publish({ semantic: 'ready', coverage: 'ready' }, true); await tick();
  assert.equal(history.calls, 0); assert.equal(history.unsubscribed, 1); assert.equal(changes, 0); assert.equal(history.closed, true);
});
test('repair replaces the background subscription and ignores both errors and health from the older history', async t => {
  const first = historyState(), second = historyState(), { service } = fixture(t, (_options, index) => index ? second : first);
  await service.listModels(); await service.maintenance({ action: 'repair' }); assert.equal(first.unsubscribed, 1); assert.equal(first.closed, true); assert.equal(second.calls, 1);
  first.boot.reject(new Error('private/path/should/not/be/rendered')); first.publish({ semantic: 'ready' }, true); await tick();
  assert.equal(service.getState().health.search.semantic, 'loading'); assert.equal(service.getState().health.search.initializationError, undefined);
  second.publish({ semantic: 'unavailable', semanticReason: 'missing-resources', coverage: 'ready' });
  assert.equal(service.getState().health.search.semanticReason, 'missing-resources'); second.boot.resolve({ status: 'ready' }); await tick();
});
