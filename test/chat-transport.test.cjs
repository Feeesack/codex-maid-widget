'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

for (const variant of ['..', '../macos']) {
  const { ChatTransport, capabilityReport, sanitizeThreadHistory, RECOVERY_SCENARIOS } = require(variant + '/src/chat-transport.cjs');
  function fixture(t, options = {}) {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'maid-chat-隔离 '));
    const root = path.join(base, '项目 & 空格'), home = path.join(base, '自定义 Codex');
    fs.mkdirSync(root); fs.mkdirSync(home);
    const executable = path.join(base, 'codex.exe'); fs.writeFileSync(executable, 'isolated executable fixture');
    const digest = crypto.createHash('sha256').update(fs.readFileSync(executable)).digest('hex');
    const evidence = { kind: 'native-synthetic', projectRoot: root, cliVersion: 'fixture-cli', schemaFingerprint: 'a'.repeat(64), executableSha256: digest,
      verifiedAt: Date.now() - 1000, expiresAt: Date.now() + 60000, scenarios: Object.fromEntries(RECOVERY_SCENARIOS.map(name => [name, true])) };
    const child = new EventEmitter(), written = []; let launch, accountType = options.accountType || 'chatgpt';
    const threads = new Map([['owned', { id: 'owned', cwd: root, createdAt: 123, name: null, status: { type: 'idle' } }]]);
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = new EventEmitter();
    child.stdout.setEncoding = () => {};
    child.stdin.destroy = () => { child.destroyed = true; };
    child.kill = () => { child.killed = true; };
    const emit = value => child.stdout.emit('data', JSON.stringify(value) + '\n');
    child.stdin.write = (value, callback) => {
      const message = JSON.parse(value); written.push(message); callback?.();
      if (options.write?.(message, emit, child) === false) return true;
      if (message.id === undefined || !message.method) return true;
      let result;
      switch (message.method) {
        case 'initialize': result = {}; break;
        case 'account/read': result = { account: { type: accountType, planType: 'pro', email: 'private-fixture@example.invalid' } }; break;
        case 'account/rateLimits/read': result = { rateLimits: { primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: 999 } }, token: 'secret-fixture' }; break;
        case 'thread/start': {
          const thread = { id: 'new-owned', cwd: root, createdAt: 123, name: null, status: { type: 'idle' } }; threads.set(thread.id, thread); result = { thread }; break;
        }
        case 'thread/name/set': threads.get(message.params.threadId).name = message.params.name; result = {}; break;
        case 'thread/read': result = { thread: threads.get(message.params.threadId) }; break;
        case 'thread/resume': result = { thread: threads.get(message.params.threadId) }; break;
        case 'thread/turns/list': result = { data: [], nextCursor: null }; break;
        case 'thread/items/list': result = { data: [], nextCursor: null }; break;
        case 'turn/start': result = { turn: { id: 'turn-1', status: 'inProgress', items: [] } }; break;
        case 'turn/interrupt': result = {}; break;
        default: result = {};
      }
      queueMicrotask(() => emit({ id: message.id, result })); return true;
    };
    const transport = new ChatTransport({ projectRoot: root, codexHome: home, env: { PATH: '', CODEX_HOME: 'must-be-replaced' },
      codexPath: executable, cliVersion: 'fixture-cli', schemaFingerprint: 'a'.repeat(64), evidence: options.verified === false ? undefined : evidence,
      ownedThreads: [{ threadId: 'owned', projectRoot: root }], timeoutMs: 500,
      resolveExecutable: async explicit => explicit,
      spawn(file, args, settings) { launch = { file, args, settings }; return child; }, ...options.transport });
    t.after(() => { transport.close(); fs.rmSync(base, { recursive: true, force: true }); });
    return { root, home, executable, evidence, transport, child, written, emit, threads, get launch() { return launch; }, set accountType(value) { accountType = value; } };
  }

  test(`${variant}: explicit isolated project/home, no cwd or host environment assumptions`, async t => {
    const h = fixture(t); const status = await h.transport.start();
    assert.equal(status.accountType, 'chatgpt'); assert.equal(status.ready, true);
    assert.equal(h.launch.file, h.executable); assert.equal(h.launch.settings.cwd, h.root);
    assert.deepEqual(h.launch.settings.env, { PATH: '', CODEX_HOME: h.home });
    assert.equal(h.launch.settings.windowsHide, true);
    assert(h.launch.args.includes('analytics.enabled=false')); assert(h.launch.args.includes('features.shell_tool=false'));
    assert.equal(h.written[0].method, 'initialize'); assert.equal(h.written[1].method, 'initialized');
    assert.throws(() => new ChatTransport({ projectRoot: 'relative-root' }), { code: 'PROJECT_REQUIRED' });
  });

  test(`${variant}: native proof defaults closed, binds executable/schema/version/project/expiry`, async t => {
    const h = fixture(t, { verified: false }); await h.transport.start();
    assert.equal(h.transport.capabilities().ready, false);
    await assert.rejects(h.transport.startThread(), { code: 'SOURCE_NOT_READY' });
    await assert.rejects(h.transport.send('owned', { text: 'never sent' }), { code: 'SOURCE_NOT_READY' });
    assert.equal(h.written.filter(value => value.method === 'turn/start' || value.method === 'thread/start').length, 0);
    const runtime = { projectRoot: h.root, cliVersion: 'fixture-cli', schemaFingerprint: 'a'.repeat(64), executableSha256: h.evidence.executableSha256 };
    assert.equal(capabilityReport(h.evidence, runtime).ready, true);
    for (const change of [{ cliVersion: 'changed' }, { projectRoot: 'another' }, { schemaFingerprint: 'b'.repeat(64) }, { executableSha256: 'b'.repeat(64) }])
      assert.equal(capabilityReport(h.evidence, { ...runtime, ...change }).ready, false);
    assert.equal(capabilityReport({ ...h.evidence, kind: 'fixture-only' }, runtime).ready, false);
    assert.equal(capabilityReport({ ...h.evidence, expiresAt: Date.now() - 1 }, runtime).ready, false);
    assert.equal(capabilityReport({ ...h.evidence, scenarios: { ...h.evidence.scenarios, originalAttachments: false } }, runtime).ready, false);
  });

  test(`${variant}: public RPC cannot bypass mutation gate or disclose account identity`, async t => {
    const h = fixture(t); await h.transport.start();
    assert.deepEqual(await h.transport.request('account/read'), { type: 'chatgpt', planType: 'pro' });
    assert.equal(JSON.stringify(await h.transport.request('account/rateLimits/read')).includes('secret'), false);
    for (const method of ['turn/start', 'thread/start', 'thread/delete', 'account/login/start', 'initialize'])
      await assert.rejects(h.transport.request(method, { threadId: 'owned' }), { code: 'METHOD_DENIED' });
  });

  test(`${variant}: API keys and later account change cannot start paid turns`, async t => {
    const h = fixture(t, { accountType: 'apiKey' }); await h.transport.start();
    await assert.rejects(h.transport.send('owned', { text: 'no API billing' }), { code: 'CHATGPT_LOGIN_REQUIRED' });
    h.transport.active.set('owned', { threadId: 'owned', id: 'inflight', status: 'inProgress' });
    h.accountType = 'chatgpt'; h.emit({ method: 'account/updated', params: { authMode: 'chatgpt', private: 'ignored' } });
    await assert.rejects(h.transport.send('owned', { text: 'pause on change' }), { code: 'UNKNOWN_EXECUTION' });
    assert.equal(h.written.filter(value => value.method === 'turn/start').length, 0);
  });

  test(`${variant}: thread ownership and returned canonical root are required for every history page`, async t => {
    const h = fixture(t); await h.transport.start();
    await assert.rejects(h.transport.readOwnThread('foreign'), { code: 'THREAD_SCOPE' });
    await assert.rejects(h.transport.request('thread/turns/list', { threadId: 'foreign' }), { code: 'THREAD_SCOPE' });
    h.threads.get('owned').cwd = h.home;
    await assert.rejects(h.transport.readOwnThread('owned'), { code: 'THREAD_SCOPE' });
    assert.equal(h.written.some(value => value.params?.threadId === 'foreign'), false);
  });

  test(`${variant}: no reasoning/tool/raw-event leakage; only owned visible content and numeric usage`, async t => {
    const h = fixture(t); await h.transport.start(); const messages = [], deltas = [], usage = [], turns = [], compact = [];
    h.transport.on('message', value => messages.push(value)); h.transport.on('messageDelta', value => deltas.push(value));
    h.transport.on('usage', value => usage.push(value)); h.transport.on('turn', value => turns.push(value)); h.transport.on('compaction', value => compact.push(value));
    const notify = (method, params) => h.emit({ method, params: { threadId: 'owned', turnId: 'turn-1', ...params } });
    for (const type of ['reasoning', 'commandExecution', 'mcpToolCall', 'fileChange']) notify('item/completed', { item: { id: 'hidden', type, text: 'never retain', summary: ['private'] } });
    notify('item/reasoning/textDelta', { delta: 'never retain' });
    notify('item/completed', { item: { id: 'm1', type: 'userMessage', content: [{ type: 'text', text: '  exact\n文本  ' }] }, startedAtMs: 123 });
    notify('item/agentMessage/delta', { itemId: 'm2', delta: 'hello' });
    notify('item/completed', { item: { id: 'm2', type: 'agentMessage', text: 'hello', phase: 'final_answer', memoryCitation: { private: 'never retain' } } });
    notify('item/completed', { item: { id: 'cmp', type: 'contextCompaction', summary: 'never retain' } });
    notify('thread/tokenUsage/updated', { tokenUsage: { last: { inputTokens: 3, totalTokens: 4, token: 'secret' }, total: { totalTokens: 44 }, modelContextWindow: 500 } });
    notify('turn/completed', { turn: { id: 'turn-1', status: 'completed', error: { message: 'private' }, items: [] } });
    h.emit({ method: 'item/agentMessage/delta', params: { threadId: 'foreign', turnId: 'turn-1', itemId: 'm3', delta: 'foreign' } });
    assert.equal(messages.length, 2); assert.equal(messages[0].content[0].text, '  exact\n文本  ');
    assert.deepEqual(deltas, [{ threadId: 'owned', turnId: 'turn-1', itemId: 'm2', delta: 'hello' }]);
    assert.equal(usage[0].last.totalTokens, 4); assert.equal(usage[0].total.totalTokens, 44);
    assert.equal(compact.length, 1); assert.equal(turns[0].status, 'completed');
    assert.equal(JSON.stringify({ messages, deltas, usage, turns, compact }).includes('never retain'), false);
  });

  test(`${variant}: unsupported server requests never grant execution or expose prompts`, async t => {
    const h = fixture(t); await h.transport.start(); const blocked = []; h.transport.on('blockedRequest', value => blocked.push(value));
    for (const method of ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/tool/call', 'account/chatgptAuthTokens/refresh'])
      h.emit({ id: 'request-' + method, method, params: { prompt: 'private' } });
    const responses = h.written.filter(value => value.error);
    assert.equal(responses.length, 4); assert(responses.every(value => value.error.code === -32601));
    assert(blocked.every(value => value.method === 'unsupported'));
  });

  test(`${variant}: native source paging asks full items, bounds page size, does not claim attachment recovery`, async t => {
    const h = fixture(t, { write(message, emit) {
      if (message.method !== 'thread/turns/list') return;
      queueMicrotask(() => emit({ id: message.id, result: { data: [{ id: 'turn-1', status: 'completed', items: [
        { id: 'reason', type: 'reasoning', summary: ['hidden'] }, { id: 'm1', type: 'userMessage', content: [
          { type: 'text', text: 'text' }, { type: 'image', url: 'https://private.invalid/temporary' }, { type: 'text', text: 'tail' }] } ] }], nextCursor: 'opaque' } })); return false;
    } });
    await h.transport.start(); const page = await h.transport.readOwnThread('owned', { kind: 'thread/turns/list', limit: 2 });
    assert.equal(page.data[0].items.length, 1); assert.equal(page.data[0].items[0].content.length, 3);
    assert.equal(page.data[0].items[0].content[1].image.originalAvailable, false);
    assert.equal(page.complete, false); assert.equal(page.nextCursor, 'opaque');
    const request = h.written.find(value => value.method === 'thread/turns/list'); assert.equal(request.params.itemsView, 'full'); assert.equal(request.params.sortDirection, 'asc');
    await assert.rejects(h.transport.readOwnThread('owned', { kind: 'thread/turns/list', limit: 100 }), { code: 'PAGE_LIMIT' });
  });

  test(`${variant}: one new thread, canonical cwd, native title readback, read-only sandbox`, async t => {
    const h = fixture(t); await h.transport.start();
    const result = await h.transport.startThread({ title: '2026-10-26_01-02-03', developerInstructions: 'bounded initialization' });
    assert.equal(result.threadId, 'new-owned');
    const request = h.written.find(value => value.method === 'thread/start'); assert.equal(request.params.cwd, h.root); assert.equal(request.params.sandbox, 'read-only'); assert.equal(request.params.approvalPolicy, 'never');
    await assert.rejects(h.transport.startThread({ title: 'unsafe/filename' }), { code: 'INVALID_TITLE' });
  });

  test(`${variant}: concurrent sends cannot duplicate a paid turn and interrupt acknowledgement is not terminal proof`, async t => {
    const h = fixture(t); await h.transport.start();
    const pending = h.transport.send('owned', { text: ' exact\ntext ', clientMessageId: 'M-1' });
    await assert.rejects(h.transport.send('owned', { text: 'duplicate' }), { code: 'TURN_ACTIVE' });
    const result = await pending; assert.equal(result.id, 'turn-1');
    const request = h.written.find(value => value.method === 'turn/start'); assert.equal(request.params.input[0].text, ' exact\ntext ');
    assert.deepEqual(request.params.sandboxPolicy, { type: 'readOnly', networkAccess: false });
    assert.deepEqual(await h.transport.interrupt('owned', 'turn-1'), { requested: true, terminalConfirmed: false });
    await assert.rejects(h.transport.send('owned', { text: 'cannot replay' }), { code: 'TURN_ACTIVE' });
    h.emit({ method: 'turn/completed', params: { threadId: 'owned', turn: { id: 'turn-1', status: 'interrupted', items: [] } } });
    assert.equal(h.transport.recoveryMetadata().turns[0].status, 'interrupted');
  });

  test(`${variant}: remote writer conflicts stay classified and never expose server error text`, async t => {
    let writerConflict = true;
    const h = fixture(t, { write(message, emit) {
      if (message.method !== 'turn/start' || !writerConflict) return;
      writerConflict = false;
      queueMicrotask(() => emit({ id: message.id, error: { code: -32600, message: 'thread private-id already has an active writer private-token' } }));
      return false;
    } });
    await h.transport.start();
    await assert.rejects(h.transport.send('owned', { text: 'private body' }), failure => {
      assert.equal(failure.code, 'THREAD_WRITER_CONFLICT'); assert.equal(failure.executionState, 'not-executed');
      assert.equal(failure.message.includes('private-token'), false); assert.equal(failure.message.includes('private-id'), false); return true;
    });
    assert.equal(h.transport.recoveryMetadata().turns.length, 0);
    assert.equal(JSON.stringify(h.transport.recoveryMetadata()).includes('private-token'), false);
    const retry = await h.transport.send('owned', { text: 'safe retry' });
    assert.equal(retry.id, 'turn-1');
  });

  test(`${variant}: remote unloaded-thread errors have a bounded classification`, async t => {
    const h = fixture(t, { write(message, emit) {
      if (message.method !== 'thread/read') return;
      queueMicrotask(() => emit({ id: message.id, error: { code: -32600, message: 'thread private-id not found private-token' } }));
      return false;
    } });
    await h.transport.start();
    await assert.rejects(h.transport.readOwnThread('owned'), failure => {
      assert.equal(failure.code, 'THREAD_NOT_LOADED'); assert.equal(failure.executionState, undefined);
      assert.equal(failure.message.includes('private-token'), false); return true;
    });
  });

  test(`${variant}: inline image originals preserve exact bytes and content position without persisting paths`, async t => {
    const h = fixture(t); await h.transport.start();
    const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aKRkAAAAASUVORK5CYII=', 'base64');
    await h.transport.send('owned', { content: [{ text: 'before\n' }, { image: { bytes, mime: 'image/png' } }, { text: 'after  ' }] });
    const sent = h.written.find(value => value.method === 'turn/start').params.input;
    assert.equal(sent[0].text, 'before\n'); assert.equal(sent[2].text, 'after  ');
    assert.equal(sent[1].type, 'image'); assert(sent[1].url.startsWith('data:image/png;base64,'));
    const history = sanitizeThreadHistory([{ id: 't', status: 'completed', items: [{ id: 'm', type: 'userMessage', content: sent }] }]);
    assert.equal(history[0].items[0].contentComplete, true);
    assert(history[0].items[0].content[1].image.bytes.equals(bytes));
    assert.equal(history[0].items[0].content[1].image.sha256, crypto.createHash('sha256').update(bytes).digest('hex'));
    const invalid = fixture(t); await invalid.transport.start();
    await assert.rejects(invalid.transport.send('owned', { content: [{ image: { bytes, mime: 'image/jpeg' } }] }), { code: 'INVALID_IMAGE' });
    await assert.rejects(invalid.transport.send('owned', { text: 'x', content: [{ text: 'y' }] }), { code: 'INVALID_INPUT' });
  });

  test(`${variant}: restoring metadata never converts an in-flight request into permission to replay`, async t => {
    const h = fixture(t, { transport: { activeTurns: [{ threadId: 'owned', turnId: 'lost-turn', status: 'inProgress' }] } });
    await h.transport.start(); const resumed = await h.transport.resumeThread('owned');
    assert.equal(resumed.terminalReconciliationRequired, true);
    await assert.rejects(h.transport.send('owned', { text: 'never replay' }), { code: 'UNKNOWN_EXECUTION' });
    assert.equal(h.written.filter(value => value.method === 'turn/start').length, 0);
  });

  test(`${variant}: appended input binds expected native turn, while stale lifecycle cannot release another active turn`, async t => {
    const h = fixture(t); await h.transport.start(); await h.transport.send('owned', { text: 'initial' });
    const result = await h.transport.steer('owned', { text: '  append\n ', clientMessageId: 'client-append', expectedTurnId: 'turn-1' });
    assert.equal(result.delivery, 'steer');
    const sent = h.written.find(value => value.method === 'turn/steer'); assert.equal(sent.params.expectedTurnId, 'turn-1'); assert.equal(sent.params.clientUserMessageId, 'client-append');
    h.emit({ method: 'turn/completed', params: { threadId: 'owned', turn: { id: 'old-turn', status: 'completed' } } });
    assert.equal(h.transport.recoveryMetadata().turns[0].status, 'inProgress');
    await assert.rejects(h.transport.steer('owned', { text: 'bad target', expectedTurnId: 'old-turn' }), { code: 'TURN_SCOPE' });
  });

  test(`${variant}: lost turn result is unknown, never replayed; recovery metadata contains no body`, async t => {
    const h = fixture(t, { transport: { timeoutMs: 30 }, write(message) { if (message.method === 'turn/start') return false; } });
    await h.transport.start(); await assert.rejects(h.transport.send('owned', { text: 'private body' }), { executionState: 'unknown' });
    assert.equal(h.transport.recoveryMetadata().turns[0].status, 'unknown');
    assert.equal(JSON.stringify(h.transport.recoveryMetadata()).includes('private body'), false);
    await assert.rejects(h.transport.send('owned', { text: 'do not replay' }), { code: 'UNKNOWN_EXECUTION' });
    assert.equal(h.written.filter(value => value.method === 'turn/start').length, 1);
  });

  test(`${variant}: native history reconciliation requires observed terminal and refuses unbounded cursor loops`, async t => {
    const h = fixture(t, { write(message, emit) {
      if (message.method !== 'thread/turns/list') return;
      queueMicrotask(() => emit({ id: message.id, result: { data: [{ id: 'turn-1', status: 'failed', items: [] }], nextCursor: null } })); return false;
    } });
    await h.transport.start(); await h.transport.send('owned', { text: 'one turn' });
    const result = await h.transport.reconcile('owned', 'turn-1'); assert.equal(result.status, 'failed');
    assert.equal(h.transport.recoveryMetadata().turns[0].status, 'failed');
  });

  test(`${variant}: closing during discovery cancels owned operation without spawning`, async t => {
    const h = fixture(t, { transport: { resolveExecutable: () => new Promise(() => {}) } });
    const starting = h.transport.start(); h.transport.close();
    await assert.rejects(starting, { code: 'CLOSED' }); assert.equal(h.launch, undefined);
  });

  test(`${variant}: invalid or oversized protocol frames release owned process and all pending requests`, async t => {
    for (const value of ['42\n', '{not-json}\n', 'x'.repeat(1100)]) {
      const h = fixture(t, { transport: { maxFrameBytes: 1024 } }); await h.transport.start();
      h.child.stdout.emit('data', value);
      assert.equal(h.transport.status().connected, false); assert.equal(h.child.killed, true); assert.equal(h.transport.pending.size, 0);
    }
  });

  test(`${variant}: history sanitizer preserves message bytes and separates terminal from unknown`, () => {
    const safe = sanitizeThreadHistory([{ id: 't', status: 'unexpected', items: [
      { id: 'a', type: 'agentMessage', text: '  final\n文本 ', phase: 'final_answer', reasoning: 'hidden' },
      { id: 'b', type: 'reasoning', text: 'hidden' }] }]);
    assert.equal(safe[0].status, 'unknown'); assert.equal(safe[0].items[0].content[0].text, '  final\n文本 ');
    assert.equal(safe[0].items.length, 1); assert.equal(JSON.stringify(safe).includes('hidden'), false);
  });
}
