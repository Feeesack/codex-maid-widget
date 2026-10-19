'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Every provider is injected. Importing and exercising this service never
// opens the host Codex profile, a rollout, or the developer's Git repository.
for (const variant of ['', 'macos/']) {
  const { ConversationStatus } = require(path.join(__dirname, '..', variant, 'src/conversation-status.cjs'));
  const name = variant ? 'macOS' : 'Windows';
  const selected = { status: 'ready', threadId: 'fixture-thread', cwd: '/isolated/workspace' };
  const context = { status: 'ready', usedTokens: 25000, windowTokens: 100000 };
  test(`${name}: only explicit reads inspect current conversation and coalesce concurrent clicks`, async () => {
    let resolves = 0, contexts = 0, gits = 0, finish;
    const gate = new Promise(resolve => { finish = resolve; });
    const reader = new ConversationStatus({
      resolveSelected: async () => { resolves++; return selected; },
      readContext: async () => { contexts++; await gate; return context; },
      readGit: async cwd => { assert.equal(cwd, selected.cwd); gits++; return { status: 'ready', count: 13, privateFile: 'never returned' }; },
    });
    assert.equal(resolves, 0);
    const first = reader.read(), second = reader.read();
    assert.equal(first, second);
    await Promise.resolve(); await Promise.resolve();
    assert.equal(contexts, 1); assert.equal(gits, 1);
    finish(); const result = await first;
    assert.equal(resolves, 2);
    assert.equal(result.context.percent, 25);
    assert.deepEqual(result.git, { status: 'ready', count: 13 });
    assert.ok(!JSON.stringify(result).includes('fixture-thread'));
    const { targetProjectDetail, ...metricsAndLabels } = result;
    assert.equal(typeof targetProjectDetail, 'string');
    assert.ok(!JSON.stringify(metricsAndLabels).includes('/isolated'));
    assert.ok(!JSON.stringify(metricsAndLabels).includes('\\isolated'));
    await reader.read(); assert.equal(contexts, 2, 'a new click refreshes rather than returning a stale cached result');
  });
  test(`${name}: switching conversations while Git is pending discards both old values`, async () => {
    let resolves = 0;
    const reader = new ConversationStatus({ resolveSelected: async () => (++resolves === 1 ? selected : { ...selected, threadId: 'different' }),
      readContext: async () => context, readGit: async () => ({ status: 'ready', count: 9 }) });
    const result = await reader.read();
    assert.equal(result.status, 'unavailable');
    assert.equal(result.context.usedTokens, undefined); assert.equal(result.git.count, undefined);
    assert.match(result.reason, /切换/);
  });
  test(`${name}: an unknown selection never scans logs or guesses a repository`, async () => {
    const reader = new ConversationStatus({ resolveSelected: async () => ({ status: 'unavailable' }),
      readContext: () => { throw Error('must not read context'); }, readGit: () => { throw Error('must not run Git'); } });
    assert.equal((await reader.read()).status, 'unavailable');
  });
  test(`${name}: provider failures are independent and never leak raw errors`, async () => {
    const reader = new ConversationStatus({ resolveSelected: async () => selected,
      readContext: async () => { throw Error('private body or path'); }, readGit: async () => ({ status: 'ready', count: 0 }) });
    const result = await reader.read();
    assert.equal(result.context.status, 'unavailable'); assert.equal(result.git.count, 0);
    assert.ok(!JSON.stringify(result).includes('private'));
  });
  test(`${name}: absent local cwd, non-repository and timeout stay distinct from zero changes`, async () => {
    for (const status of ['not-repository', 'timeout', 'unavailable']) {
      const reader = new ConversationStatus({ resolveSelected: async () => selected,
        readContext: async () => context, readGit: async () => ({ status, count: 0, reason: '/private/error' }) });
      const result = await reader.read(); assert.equal(result.git.status, status); assert.equal(result.git.count, undefined);
      assert.ok(!JSON.stringify(result).includes('/private'));
    }
    const reader = new ConversationStatus({ resolveSelected: async () => ({ ...selected, cwd: null }), readContext: async () => context,
      readGit: () => { throw Error('must not guess another workspace'); } });
    assert.equal((await reader.read()).git.status, 'unavailable');
  });
  test(`${name}: invalid counts are unavailable and progress is bounded`, async () => {
    const reader = new ConversationStatus({ resolveSelected: async () => selected,
      readContext: async () => ({ status: 'ready', usedTokens: 200, windowTokens: 100 }),
      readGit: async () => ({ status: 'ready', count: -1 }) });
    const result = await reader.read(); assert.equal(result.context.percent, 100); assert.equal(result.git.status, 'unavailable');
  });
  test(`${name}: a hung context provider times out, releases the request and allows retry`, async () => {
    const reader = new ConversationStatus({ timeoutMs: 25, resolveSelected: async () => selected,
      readContext: () => new Promise(() => {}), readGit: async () => ({ status: 'ready', count: 0 }) });
    const result = await reader.read();
    assert.equal(result.status, 'unavailable'); assert.equal(result.git.status, 'timeout');
    assert.equal(reader.pending, null);
    reader.readContext = async () => context;
    assert.equal((await reader.read()).context.status, 'ready');
  });
  test(`${name}: changes of mode, revision or rollout discard values even when thread and workspace match`, async () => {
    const original = { ...selected, rolloutPath: '/isolated/session-a.jsonl', selectionMode: 'auto', selectionRevision: 1 };
    for (const change of [{ selectionMode: 'manual' }, { selectionRevision: 2 }, { rolloutPath: '/isolated/session-b.jsonl' }]) {
      let resolves = 0;
      const reader = new ConversationStatus({ resolveSelected: async () => (++resolves === 1 ? original : { ...original, ...change }),
        readContext: async () => context, readGit: async () => ({ status: 'ready', count: 42 }) });
      const result = await reader.read();
      assert.equal(result.status, 'unavailable'); assert.equal(result.reason, '对话已切换，请再点一次');
      assert.equal(result.context.usedTokens, undefined); assert.equal(result.git.count, undefined);
    }
  });
  test(`${name}: invalidate starts a fresh request while the superseded request is still pending`, async () => {
    let finishOld, finishNew, enteredOld, enteredNew, reads = 0;
    const oldStarted = new Promise(resolve => { enteredOld = resolve; });
    const newStarted = new Promise(resolve => { enteredNew = resolve; });
    const oldGate = new Promise(resolve => { finishOld = resolve; });
    const newGate = new Promise(resolve => { finishNew = resolve; });
    const target = { ...selected, rolloutPath: '/isolated/session.jsonl', selectionMode: 'auto', selectionRevision: 1 };
    const reader = new ConversationStatus({ resolveSelected: async () => target,
      readContext: async () => { if (++reads === 1) { enteredOld(); await oldGate; } else { enteredNew(); await newGate; } return context; },
      readGit: async () => ({ status: 'ready', count: 7 }) });
    const old = reader.read(); await oldStarted;
    reader.invalidate();
    const fresh = reader.read(); assert.notEqual(fresh, old); await newStarted;
    finishOld();
    const discarded = await old;
    assert.equal(discarded.status, 'unavailable'); assert.equal(discarded.reason, '对话已切换，请再点一次');
    assert.equal(reader.pending, fresh, 'completion of an old request must not clear a newer pending request');
    assert.equal(reader.read(), fresh);
    finishNew();
    assert.equal((await fresh).git.count, 7); assert.equal(reader.pending, null);
  });
  test(`${name}: automatic unknown returns fixed manual fallback copy without reading metrics`, async () => {
    let contexts = 0, gits = 0;
    const reader = new ConversationStatus({ resolveSelected: async () => ({ status: 'unavailable', selectionMode: 'auto', reason: '/private/provider/error' }),
      readContext: async () => { contexts++; return context; }, readGit: async () => { gits++; return { status: 'ready', count: 0 }; } });
    const result = await reader.read();
    assert.equal(result.selectionMode, 'auto'); assert.equal(result.reason, '未识别当前对话，可手动选择');
    assert.deepEqual(result.context, { status: 'unavailable', reason: '未识别当前对话，可手动选择' });
    assert.deepEqual(result.git, { status: 'unavailable', reason: '未识别当前对话，可手动选择' });
    assert.equal(contexts, 0); assert.equal(gits, 0); assert.equal(JSON.stringify(result).includes('/private'), false);
  });
  test(`${name}: compaction counts are independent, bounded and whitelisted`, async () => {
    for (const value of [{ status: 'ready', count: 0, complete: true }, { status: 'ready', count: 4, complete: false },
      { status: 'ready', count: 2, complete: false, incompleteReason: 'legacy-records' }]) {
      const reader = new ConversationStatus({ resolveSelected: async () => selected,
        readContext: async () => { throw Error('private'); }, readGit: async () => ({ status: 'ready', count: 2 }),
        readCompactions: async () => ({ ...value, privateSummary: 'PRIVATE' }) });
      const result = await reader.read();
      assert.deepEqual(result.compaction, value); assert.equal(result.context.status, 'unavailable');
      assert.equal(result.git.count, 2); assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
    }
    for (const value of [{ status: 'ready', count: -1, complete: true }, { status: 'ready', count: 2.5, complete: true },
      { status: 'ready', count: Number.MAX_SAFE_INTEGER + 1, complete: true }, { status: 'ready', count: 3, complete: 'true' }]) {
      const reader = new ConversationStatus({ resolveSelected: async () => selected, readContext: async () => context,
        readGit: async () => ({ status: 'ready', count: 1 }), readCompactions: async () => value });
      const result = await reader.read(); assert.equal(result.compaction.status, 'unavailable'); assert.equal(result.compaction.count, undefined);
    }
  });
  test(`${name}: unknown or switched targets cannot leak a compaction count`, async () => {
    let reads = 0, resolves = 0;
    const reader = new ConversationStatus({ resolveSelected: async () => (++resolves === 1 ? selected : { status: 'unavailable' }),
      readContext: async () => context, readGit: async () => ({ status: 'ready', count: 0 }),
      readCompactions: async () => { reads++; return { status: 'ready', count: 9, complete: true }; } });
    assert.equal((await reader.read()).compaction.count, undefined); assert.equal(reads, 1);
    reader.resolveSelected = async () => ({ status: 'unavailable' });
    await reader.read(); assert.equal(reads, 1);
  });
  test(`${name}: manual and automatic targets expose safe local titles and pure workspace display metadata`, async () => {
    for (const selectionMode of ['manual', 'auto']) {
      const target = { ...selected, title: '\u0000 当前标题\u202e\u2066 ', selectionMode,
        rolloutPath: '/PRIVATE-ROLLOUT.jsonl', selectionRevision: 1 };
      const reader = new ConversationStatus({ resolveSelected: async () => target,
        readContext: async () => context, readGit: async () => ({ status: 'ready', count: 2 }),
        readCompactions: async () => ({ status: 'ready', count: 0, complete: true }) });
      const result = await reader.read();
      assert.equal(result.status, 'ready'); assert.equal(result.selectionMode, selectionMode);
      assert.equal(result.targetTitle, '当前标题');
      assert.equal(result.targetProject, 'workspace'); assert.equal(result.targetProjectDetail, '/isolated/workspace');
      assert.doesNotMatch(JSON.stringify(result), /fixture-thread|PRIVATE-ROLLOUT|[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/);
      const { targetProjectDetail, ...rest } = result;
      assert.equal(JSON.stringify(rest).includes('/isolated'), false);
    }
  });
  test(`${name}: project provider exports only bounded label and detail strings and strips controls`, async () => {
    const target = { ...selected, title: 'T'.repeat(2000), selectionMode: 'auto', selectionRevision: 1 };
    const reader = new ConversationStatus({ resolveSelected: async () => target,
      readContext: async () => ({ ...context, rolloutPath: '/SECRET-ROLLOUT', threadId: 'SECRET-ID' }),
      readGit: async () => ({ status: 'ready', count: 1, stderr: 'SECRET-ERROR' }),
      readCompactions: async () => ({ status: 'ready', count: 2, complete: true, message: 'SECRET-BODY' }),
      readProject: async cwd => {
        assert.equal(cwd, selected.cwd);
        return { label: '\u0001\u202a' + 'L'.repeat(1000) + '\u2069', detail: '\u0000\u202e' + '/project/' + 'p'.repeat(6000),
          threadId: 'SECRET-ID', rolloutPath: '/SECRET-ROLLOUT', error: 'SECRET-ERROR', project: 'SECRET-BODY', nested: { label: 'SECRET-NESTED' } };
      } });
    const result = await reader.read();
    assert.equal(result.targetTitle.length, 160); assert.equal(result.targetProject.length, 160);
    assert.equal(result.targetProjectDetail.length, 2048);
    assert.ok(result.targetProjectDetail.startsWith('/project/'));
    assert.doesNotMatch(JSON.stringify(result), /SECRET|[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/);
    assert.deepEqual(Object.keys(result).sort(), ['status', 'context', 'git', 'compaction', 'selectionMode', 'targetTitle', 'targetProject', 'targetProjectDetail', 'elapsedMs'].sort());
  });
  test(`${name}: rejected or malformed project metadata falls back independently to the pure workspace display`, async () => {
    const invalid = { toString() { throw Error('must not coerce metadata'); } };
    for (const readProject of [async () => { throw Error('/PRIVATE-PROJECT-ERROR'); },
      () => { throw Error('/PRIVATE-PROJECT-ERROR'); }, async () => null, async () => ({}),
      async () => ({ label: invalid, detail: 2048 })]) {
      const reader = new ConversationStatus({ resolveSelected: async () => ({ ...selected, title: 'title' }),
        readContext: async () => context, readGit: async () => ({ status: 'ready', count: 0 }),
        readCompactions: async () => ({ status: 'ready', count: 0, complete: true }), readProject });
      const result = await reader.read();
      assert.equal(result.status, 'ready'); assert.equal(result.targetProject, 'workspace');
      assert.equal(result.targetProjectDetail, '/isolated/workspace');
      assert.equal(result.context.percent, 25); assert.equal(result.git.count, 0);
      assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
    }
    for (const [metadata, label, detail] of [
      [{ label: ' named project ', detail: '' }, 'named project', '/isolated/workspace'],
      [{ label: '', detail: ' /explicit/project ' }, 'workspace', '/explicit/project'],
    ]) {
      const reader = new ConversationStatus({ resolveSelected: async () => selected, readContext: async () => context,
        readGit: async () => ({ status: 'ready', count: 0 }), readProject: async () => metadata });
      const result = await reader.read(); assert.equal(result.targetProject, label); assert.equal(result.targetProjectDetail, detail);
    }
  });
  test(`${name}: the second target resolution supplies the current renamed title`, async () => {
    let resolves = 0;
    const reader = new ConversationStatus({ resolveSelected: async () => ({ ...selected, title: ++resolves === 1 ? 'old title' : 'renamed title',
      selectionMode: 'manual', selectionRevision: 3 }), readContext: async () => context,
      readGit: async () => ({ status: 'ready', count: 0 }), readProject: async () => ({ label: 'project', detail: '/explicit/project' }) });
    const result = await reader.read(); assert.equal(resolves, 2);
    assert.equal(result.status, 'ready'); assert.equal(result.targetTitle, 'renamed title');
    assert.equal(JSON.stringify(result).includes('old title'), false);
  });
  test(`${name}: switching the target while project metadata is pending discards its old title and project`, async () => {
    let finishOld, enteredOld;
    const started = new Promise(resolve => { enteredOld = resolve; });
    const gate = new Promise(resolve => { finishOld = resolve; });
    let target = { ...selected, title: 'OLD-TITLE', selectionMode: 'auto', selectionRevision: 1 };
    const reader = new ConversationStatus({ resolveSelected: async () => target, readContext: async () => context,
      readGit: async () => ({ status: 'ready', count: 0 }), readCompactions: async () => ({ status: 'ready', count: 0, complete: true }),
      readProject: async cwd => {
        if (cwd === selected.cwd) { enteredOld(); await gate; return { label: 'OLD-PROJECT', detail: '/OLD-PATH' }; }
        return { label: 'NEW-PROJECT', detail: '/NEW-PATH' };
      } });
    const oldRead = reader.read(); await started;
    target = { ...target, threadId: 'new-thread', title: 'NEW-TITLE', cwd: '/new/workspace', selectionRevision: 2 };
    finishOld();
    const discarded = await oldRead;
    assert.equal(discarded.status, 'unavailable'); assert.equal(discarded.reason, '对话已切换，请再点一次');
    assert.equal(discarded.targetTitle, undefined); assert.equal(discarded.targetProject, undefined); assert.equal(discarded.targetProjectDetail, undefined);
    assert.doesNotMatch(JSON.stringify(discarded), /OLD-|NEW-|fixture-thread|new-thread|\/isolated|\/new/);
    const fresh = await reader.read(); assert.equal(fresh.targetTitle, 'NEW-TITLE');
    assert.equal(fresh.targetProject, 'NEW-PROJECT'); assert.equal(fresh.targetProjectDetail, '/NEW-PATH');
    assert.equal(JSON.stringify(fresh).includes('OLD-'), false);
  });
}
test('conversation controller mirrors are identical', () => {
  assert.equal(fs.readFileSync(path.join(__dirname, '../src/conversation-status.cjs'), 'utf8'),
    fs.readFileSync(path.join(__dirname, '../macos/src/conversation-status.cjs'), 'utf8'));
});
