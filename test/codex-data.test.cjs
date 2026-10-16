'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
  CodexDataSource, LocalUsageReader, ReadOnlyAppServer,
  normalizeWindow, normalizeRateLimits, normalizeAccount, normalizeAccountUsage, friendlyError, weekRange,
} = require('../src/codex-data.cjs');

const now = new Date('2026-10-16T08:00:00Z');
const options = { now: () => now, timeZone: 'Asia/Shanghai' };
const emptyLocal = { read: async () => ({ today: null, weekly: null, lastTurn: null }) };
const event = (type, payload, timestamp = '2026-10-16T07:00:00Z') => JSON.stringify({
  type: 'event_msg', timestamp, payload: { type, ...payload },
});
const usage = (total, last = total, timestamp) => event('token_count', {
  info: { total_token_usage: { total_tokens: total }, last_token_usage: { total_tokens: last } },
}, timestamp);

test('app-server initialization reports package version and preserves read-only transport flags', async t => {
  const { PassThrough } = require('node:stream');
  const { EventEmitter } = require('node:events');
  let initialized = false;
  let initializeCount = 0;
  const server = new ReadOnlyAppServer({ codexPath: 'C:\\fixture\\codex.exe', spawn(file, args, options) {
    assert.equal(file, 'C:\\fixture\\codex.exe');
    assert.deepEqual(args, ['app-server', '--listen', 'stdio://', '-c', 'analytics.enabled=false']);
    assert.equal(options.windowsHide, true);
    assert.deepEqual(options.stdio, ['pipe', 'pipe', 'pipe']);
    assert.equal(Object.hasOwn(options, 'shell'), false);
    const child = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => {};
    child.stdin.on('data', data => {
      const message = JSON.parse(data.toString());
      if (message.method === 'initialize') {
        initializeCount++;
        assert.equal(message.params.clientInfo.version, require('../package.json').version);
        child.stdout.write(JSON.stringify({ id: message.id, result: {} }) + '\n');
      } else { assert.equal(message.method, 'initialized'); initialized = true; }
    });
    return child;
  } });
  t.after(() => server.close());
  await server.connect();
  assert.equal(initializeCount, 1);
  assert.equal(initialized, true);
});

test('quota windows preserve missing values and use seconds; over-limit remainder clamps', () => {
  assert.equal(normalizeWindow(null), null);
  assert.deepEqual(normalizeWindow({ usedPercent: 25, resetsAt: 1700000000 }), {
    usedPercent: 25, remainingPercent: 75, resetsAt: 1700000000, windowDurationMins: null,
  });
  assert.equal(normalizeWindow({}).remainingPercent, null);
  assert.equal(normalizeWindow({ usedPercent: 123 }).remainingPercent, 0);
});

test('multi-bucket view is authoritative; credit balances retain their units and precision', () => {
  const buckets = normalizeRateLimits({
    rateLimits: { limitId: 'stale', primary: { usedPercent: 99 } },
    rateLimitsByLimitId: {
      codex: { limitId: 'codex', primary: { usedPercent: 12 }, credits: { hasCredits: true, unlimited: false, balance: '1234.567890' } },
      review: { limitName: 'Code review', secondary: { usedPercent: 2 } },
    },
  });
  assert.deepEqual(buckets.map(value => value.id), ['codex', 'review']);
  assert.equal(buckets[0].credits.balance, '1234.567890');
  assert.equal(buckets[1].primary, null);
  assert.deepEqual(normalizeRateLimits({ rateLimitsByLimitId: {}, rateLimits: { limitId: 'stale' } }), []);
  assert.equal(normalizeRateLimits({ rateLimits: { limitId: 'legacy' } })[0].id, 'legacy');
});

test('account normalization strips email and identifiers; absent usage is unknown', () => {
  assert.deepEqual(normalizeAccount({ account: { type: 'chatgpt', planType: 'team', email: 'private@example.test', accountId: 'secret' } }), {
    authMode: 'chatgpt', planType: 'team',
  });
  assert.equal(normalizeAccountUsage({ dailyUsageBuckets: [] }, '2026-10-16'), null);
  assert.equal(normalizeAccountUsage({ dailyUsageBuckets: [{ startDate: '2026-10-16', tokens: 0 }] }, '2026-10-16').tokens, 0);
  assert.equal(normalizeAccountUsage({ dailyUsageBuckets: [{ startDate: '2026-10-16', tokens: Number.MAX_SAFE_INTEGER + 1 }] }, '2026-10-16'), null);
});

test('read coalesces refreshes, uses device tokens and never requests account usage or token refresh', async () => {
  const methods = [];
  let connects = 0;
  const local = {
    today: { tokens: 42, turns: 1, source: 'local', scope: 'device', date: '2026-10-16', complete: true },
    weekly: { tokens: 240, turns: 4, source: 'local', scope: 'device', startDate: '2026-10-12', endDate: '2026-10-16', complete: true },
    lastTurn: null,
  };
  const source = new CodexDataSource({ ...options, localReader: { read: async () => local }, server: {
    connect: async () => { connects++; await new Promise(resolve => setTimeout(resolve, 10)); },
    request: async (method, params) => {
      methods.push([method, params]);
      if (method === 'account/read') return { account: { type: 'chatgpt', planType: 'team' } };
      assert.notEqual(method, 'account/usage/read');
      return { rateLimits: { limitId: 'codex', primary: { usedPercent: 14, windowDurationMins: 300, resetsAt: 1792135207 } } };
    }, close() {},
  } });
  const first = source.read();
  assert.equal(first, source.read());
  const snapshot = await first;
  assert.equal(connects, 1);
  assert.equal(snapshot.status, 'live');
  assert.equal(snapshot.today.source, 'local');
  assert.equal(snapshot.weekly.scope, 'device');
  assert.equal(snapshot.weekly.tokens, 240);
  assert.equal(snapshot.today.tokens, 42);
  assert.deepEqual(methods[0], ['account/read', { refreshToken: false }]);
  assert.deepEqual(methods.map(value => value[0]).sort(), ['account/rateLimits/read', 'account/read'].sort());
  source.close();
});

test('completed snapshots release their app-server process and reconnect only on the next refresh', async () => {
  const server = new ReadOnlyAppServer();
  let starts = 0;
  let kills = 0;
  let destroys = 0;
  let requests = 0;
  server.start = async () => {
    starts++;
    server.child = { stdin: { destroy() { destroys++; } }, kill() { kills++; } };
  };
  server.request = async method => {
    requests++;
    return method === 'account/read'
      ? { account: { type: 'chatgpt', email: 'account@example.test' } }
      : { rateLimits: { primary: { usedPercent: 14 } } };
  };
  const source = new CodexDataSource({ ...options, localReader: emptyLocal, server });
  const first = source.read();
  assert.equal(source.read(), first);
  assert.equal((await first).buckets[0].primary.remainingPercent, 86);
  assert.equal(server.child, null);
  assert.equal(server.pending.size, 0);
  assert.equal(starts, 1);
  assert.equal(kills, 1);
  assert.equal(destroys, 1);
  assert.equal(requests, 2);
  assert.equal((await source.read()).clearPrevious, false);
  assert.equal(starts, 2);
  assert.equal(kills, 2);
  assert.equal(destroys, 2);
  assert.equal(requests, 4);
  source.close();
});

test('failed initialization, account and quota reads also release their owned app-server', async t => {
  for (const failure of ['initialize', 'account/read', 'account/rateLimits/read']) {
    await t.test(failure, async () => {
      const server = new ReadOnlyAppServer();
      let kills = 0;
      server.start = async () => {
        server.child = { stdin: { destroy() {} }, kill() { kills++; } };
        if (failure === 'initialize') throw Object.assign(new Error('private transport error'), { code: 'TIMEOUT' });
      };
      server.request = async method => {
        if (failure === method) throw Object.assign(new Error('private transport error'), { code: 'TIMEOUT' });
        return { account: { type: 'chatgpt' } };
      };
      const source = new CodexDataSource({ ...options, localReader: emptyLocal, server });
      const snapshot = await source.read();
      assert.equal(snapshot.status, 'offline');
      assert.match(snapshot.error, /超时/);
      assert.doesNotMatch(snapshot.error, /private/);
      assert.equal(server.child, null);
      assert.equal(kills, 1);
      source.close();
    });
  }
});

test('missing CLI falls back to labeled local counters without echoing private errors', async () => {
  const local = { today: { date: '2026-10-16', tokens: 6, turns: 1, source: 'local', complete: false }, lastTurn: null };
  const source = new CodexDataSource({ ...options, localReader: { read: async () => local }, server: {
    connect: async () => { throw Object.assign(new Error('private path and token'), { code: 'ENOENT' }); }, close() {},
  } });
  const snapshot = await source.read();
  assert.equal(snapshot.status, 'partial');
  assert.equal(snapshot.today.complete, false);
  assert.match(snapshot.error, /未找到 Codex CLI/);
  assert.doesNotMatch(snapshot.error, /private/);
  source.close();
  assert.match((await source.read()).error, /关闭/);
});

test('usage endpoint is never called while subscription limits still work', async () => {
  let usageCalls = 0;
  const source = new CodexDataSource({ ...options, localReader: emptyLocal, server: {
    connect: async () => {}, request: async method => {
      if (method === 'account/read') return { account: { type: 'chatgpt' } };
      if (method === 'account/usage/read') { usageCalls++; throw Object.assign(new Error('method missing'), { code: -32601 }); }
      return { rateLimits: { primary: { usedPercent: 0 } } };
    }, close() {},
  } });
  assert.equal((await source.read()).status, 'live');
  await source.read();
  assert.equal(usageCalls, 0);
  source.close();
});

test('signed-out state has a useful error and does not query authenticated endpoints', async () => {
  const calls = [];
  const source = new CodexDataSource({ ...options, localReader: emptyLocal, server: {
    connect: async () => {}, request: async method => { calls.push(method); return { account: null }; }, close() {},
  } });
  const result = await source.read();
  assert.match(result.error, /尚未登录/);
  assert.equal(result.clearPrevious, true);
  assert.deepEqual(calls, ['account/read']);
  assert.doesNotMatch(friendlyError(new Error('bearer private-value')), /private-value/);
  source.close();
});

test('local usage handles cumulative duplicates, midnight and appended partial JSON lines', async t => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'maid-usage-test-'));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const directory = path.join(temporary, 'sessions', '2026', '10', '15');
  await fs.mkdir(directory, { recursive: true });
  const filename = path.join(directory, 'rollout.jsonl');
  await fs.writeFile(filename, [
    event('task_started', { turn_id: 'old' }, '2026-10-15T15:59:00Z'),
    usage(100, 100, '2026-10-15T15:59:30Z'),
    event('task_complete', { turn_id: 'old' }, '2026-10-15T15:59:31Z'),
    event('task_started', { turn_id: 'new' }), usage(150, 50), usage(150, 50),
  ].join('\n') + '\n');
  const reader = new LocalUsageReader(temporary, options);
  const first = await reader.read(now);
  assert.equal(first.today.tokens, 50);
  assert.equal(first.today.turns, 1);
  assert.equal(first.lastTurn.tokens, 100);
  const offset = [...reader.files.values()][0].offset;
  await reader.read(now);
  assert.equal([...reader.files.values()][0].offset, offset);
  const finalLine = usage(210, 60, '2026-10-16T07:01:00Z');
  await fs.appendFile(filename, finalLine.slice(0, 50));
  assert.equal((await reader.read(now)).today.tokens, 50);
  await fs.appendFile(filename, finalLine.slice(50) + '\n' + event('task_complete', { turn_id: 'new' }, '2026-10-16T07:01:30Z') + '\n');
  const last = await reader.read(now);
  assert.equal(last.today.tokens, 110);
  assert.deepEqual(last.lastTurn, { tokens: 110, timestamp: '2026-10-16T07:01:30.000Z', scope: 'device' });
  assert.equal(last.today.source, 'local');
});

test('large local logs use a bounded tail and label incomplete counters', async t => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'maid-tail-test-'));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  await fs.mkdir(path.join(temporary, 'sessions'));
  await fs.writeFile(path.join(temporary, 'sessions', 'large.jsonl'), 'x'.repeat(2000) + '\n' + [usage(1000, 20), usage(1010, 10)].join('\n') + '\n');
  const reader = new LocalUsageReader(temporary, { ...options, maxTailBytes: 900 });
  const result = await reader.read(now);
  assert.equal(result.today.tokens, 30);
  assert.equal(result.today.complete, false);
});

test('default local scan streams the full log beyond 16 MiB and then reads only appended bytes', async t => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'maid-full-log-test-'));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  await fs.mkdir(path.join(temporary, 'sessions'));
  const filename = path.join(temporary, 'sessions', 'large.jsonl');
  const ignored = JSON.stringify({ type: 'message', payload: 'x'.repeat(4096) }) + '\n';
  await fs.writeFile(filename, usage(100) + '\n' + ignored.repeat(4200) + usage(150, 50) + '\n');
  const reader = new LocalUsageReader(temporary, options);
  const first = await reader.read(now);
  assert.equal(first.weekly.tokens, 150);
  assert.equal(first.weekly.complete, true);
  const state = [...reader.files.values()][0];
  assert.ok(state.offset > 16 * 1024 * 1024);
  assert.equal(state.carry, '');
  await fs.appendFile(filename, usage(190, 40) + '\n');
  const next = await reader.read(now);
  assert.equal(next.weekly.tokens, 190);
  assert.equal([...reader.files.values()][0], state);
});

test('transport refuses all mutation or inference method names before sending', async () => {
  const server = new ReadOnlyAppServer();
  await assert.rejects(server.request('turn/start'), /Only quota read/);
  await assert.rejects(server.request('account/logout'), /Only quota read/);
  await assert.rejects(server.request('account/rateLimitResetCredit/consume'), /Only quota read/);
  server.close();
});

test('request timeout rejects pending reads and kills the owned process', async () => {
  let killed = 0;
  let destroyed = 0;
  const server = new ReadOnlyAppServer({ timeoutMs: 15 });
  server.child = { stdin: { write() {}, destroy() { destroyed++; } }, kill() { killed++; } };
  await assert.rejects(server.request('account/read'), error => error.code === 'TIMEOUT');
  assert.equal(killed, 1);
  assert.equal(destroyed, 1);
  assert.equal(server.pending.size, 0);
  assert.equal(server.child, null);
  server.close();
});

test('closing a connection cancels its pending read and cannot reconnect', async () => {
  const server = new ReadOnlyAppServer();
  let killed = false;
  server.child = { stdin: { write() {}, destroy() {} }, kill() { killed = true; } };
  const pending = server.request('account/read');
  server.close();
  await assert.rejects(pending, error => error.code === 'CLOSED');
  await assert.rejects(server.connect(), error => error.code === 'CLOSED');
  assert.equal(killed, true);
});

test('a forked log does not charge inherited cumulative usage to today', async t => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'maid-fork-test-'));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  await fs.mkdir(path.join(temporary, 'sessions'));
  await fs.writeFile(path.join(temporary, 'sessions', 'fork.jsonl'), [usage(10000, 100), usage(10100, 100)].join('\n') + '\n');
  const reader = new LocalUsageReader(temporary, options);
  const result = await reader.read(now);
  assert.equal(result.today.tokens, 200);
  assert.equal(result.today.complete, false);
});

test('copied logs deduplicate by their first session ID while child logs keep their own usage', async t => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'maid-copy-test-'));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const directory = path.join(temporary, 'sessions');
  await fs.mkdir(directory);
  const metadata = id => JSON.stringify({ type: 'session_meta', payload: { id } });
  const original = [metadata('parent'), event('task_started', { turn_id: 'a' }), usage(100, 100)].join('\n') + '\n';
  await fs.writeFile(path.join(directory, 'original.jsonl'), original);
  await fs.writeFile(path.join(directory, 'copy.jsonl'), original);
  // A child has its own first metadata row and can subsequently replay parent metadata.
  await fs.writeFile(path.join(directory, 'child.jsonl'), [metadata('child'), metadata('parent'), event('task_started', { turn_id: 'b' }), usage(50, 50)].join('\n') + '\n');
  const reader = new LocalUsageReader(temporary, options);
  assert.equal((await reader.read(now)).today.tokens, 150);
  assert.equal((await reader.read(now)).today.turns, 2);
  await fs.appendFile(path.join(directory, 'original.jsonl'), usage(140, 40) + '\n');
  assert.equal((await reader.read(now)).today.tokens, 190);
});

test('weekly boundaries use Monday in the device timezone, including month changes and DST', () => {
  const midnight = new Date('2026-10-18T16:00:00Z');
  assert.deepEqual(weekRange(midnight, 'Asia/Shanghai'), { startDate: '2026-10-19', endDate: '2026-10-19' });
  assert.deepEqual(weekRange(midnight, 'UTC'), { startDate: '2026-10-12', endDate: '2026-10-18' });
  assert.deepEqual(weekRange(new Date('2026-11-01T06:30:00Z'), 'America/New_York'), { startDate: '2026-10-26', endDate: '2026-11-01' });
  assert.deepEqual(weekRange(new Date('2026-11-02T05:00:00Z'), 'America/New_York'), { startDate: '2026-11-02', endDate: '2026-11-02' });
});

test('weekly device totals include old-mtime and archived logs, deduplicate copies and exclude other weeks', async t => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'maid-week-test-'));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const sessions = path.join(temporary, 'sessions');
  const archived = path.join(temporary, 'archived_sessions');
  await fs.mkdir(sessions);
  await fs.mkdir(archived);
  const metadata = id => JSON.stringify({ type: 'session_meta', payload: { id } });
  const first = [
    metadata('device-session-a'),
    event('task_started', { turn_id: 'previous-week' }, '2026-10-11T15:59:00Z'),
    usage(100, 100, '2026-10-11T15:59:30Z'),
    event('task_started', { turn_id: 'monday' }, '2026-10-11T16:00:00Z'),
    usage(200, 100, '2026-10-11T16:00:30Z'),
    event('task_started', { turn_id: 'friday' }), usage(350, 150),
    // Next week is excluded even if such an event is present in the log.
    usage(999, 649, '2026-10-18T16:00:00Z'),
  ].join('\n') + '\n';
  await fs.writeFile(path.join(sessions, 'first.jsonl'), first);
  await fs.writeFile(path.join(archived, 'first-copy.jsonl'), first);
  await fs.writeFile(path.join(archived, 'second.jsonl'), [
    metadata('device-session-b'), event('task_started', { turn_id: 'tuesday' }, '2026-10-13T01:00:00Z'),
    usage(80, 80, '2026-10-13T01:00:30Z'),
  ].join('\n') + '\n');
  // A restored archive can retain an old timestamp, unrelated to event timestamps.
  const oldMtime = new Date('2020-01-01T00:00:00Z');
  await Promise.all([
    fs.utimes(path.join(sessions, 'first.jsonl'), oldMtime, oldMtime),
    fs.utimes(path.join(archived, 'first-copy.jsonl'), oldMtime, oldMtime),
    fs.utimes(path.join(archived, 'second.jsonl'), oldMtime, oldMtime),
  ]);
  const reader = new LocalUsageReader(temporary, options);
  const result = await reader.read(now);
  assert.deepEqual(result.weekly, {
    tokens: 330, turns: 3, source: 'local', scope: 'device', startDate: '2026-10-12', endDate: '2026-10-16', complete: true,
  });
  assert.equal(result.today.tokens, 150);
  // A week rollover reuses parsed logs without including last week's usage.
  const next = await reader.read(new Date('2026-10-18T16:01:00Z'));
  assert.equal(next.weekly.tokens, 649);
  assert.equal(next.weekly.startDate, '2026-10-19');
});

test('incomplete local scans are labeled and unsafe daily or weekly sums are never exposed', async t => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'maid-safe-week-test-'));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  await fs.mkdir(path.join(temporary, 'sessions'));
  await fs.writeFile(path.join(temporary, 'sessions', 'a.jsonl'), usage(Number.MAX_SAFE_INTEGER) + '\n');
  await fs.writeFile(path.join(temporary, 'sessions', 'b.jsonl'), usage(1) + '\n');
  const unsafe = await new LocalUsageReader(temporary, options).read(now);
  assert.equal(unsafe.today, null);
  assert.equal(unsafe.weekly, null);
  await fs.writeFile(path.join(temporary, 'sessions', 'a.jsonl'), 'x'.repeat(2000) + '\n' + usage(200, 20) + '\n');
  const tail = await new LocalUsageReader(temporary, { ...options, maxTailBytes: 900 }).read(now);
  assert.equal(tail.weekly.tokens, 21);
  assert.equal(tail.weekly.complete, false);
});

test('fresh transports follow account switches without resetting device token totals or exposing identity', async () => {
  let identity = 'account-a@example.test';
  let connections = 0;
  let disconnections = 0;
  const local = {
    today: { tokens: 42, source: 'local', scope: 'device', date: '2026-10-16' },
    weekly: { tokens: 240, source: 'local', scope: 'device', startDate: '2026-10-12', endDate: '2026-10-16' },
    lastTurn: { tokens: 12, timestamp: now.toISOString(), scope: 'device' },
  };
  const source = new CodexDataSource({ ...options, localReader: { read: async () => local }, server: {
    connect: async () => { connections++; }, disconnect() { disconnections++; }, close() {},
    request: async method => {
      if (method === 'account/read') return { account: identity ? { type: 'chatgpt', planType: 'pro', email: identity } : null };
      assert.equal(method, 'account/rateLimits/read');
      return { rateLimits: { primary: { usedPercent: identity === 'account-a@example.test' ? 10 : 70 } } };
    },
  } });
  const a = await source.read();
  assert.equal(a.buckets[0].primary.remainingPercent, 90);
  assert.equal((await source.read()).clearPrevious, false);
  identity = 'account-b@example.test';
  const b = await source.read();
  assert.equal(b.accountChanged, true);
  assert.equal(b.clearPrevious, true);
  assert.equal(b.generation, a.generation + 1);
  assert.equal(b.buckets[0].primary.remainingPercent, 30);
  assert.deepEqual(b.weekly, a.weekly);
  assert.doesNotMatch(JSON.stringify(b), /account-[ab]|example|[a-f0-9]{64}/);
  identity = null;
  const out = await source.read();
  assert.equal(out.clearPrevious, true);
  assert.equal(out.account, null);
  assert.deepEqual(out.buckets, []);
  assert.deepEqual(out.today, a.today);
  assert.deepEqual(out.weekly, a.weekly);
  assert.deepEqual(out.lastTurn, a.lastTurn);
  assert.equal(out.status, 'partial');
  assert.equal(connections, 4);
  assert.equal(disconnections, 8); // Each refresh opens from a clean transport and releases it afterward.
  source.close();
});

test('uncertain account identity, expired auth and empty authoritative quota clear previous limits', async () => {
  let result = { account: { type: 'chatgpt', email: 'a@example.test' } };
  let failure = null;
  let limits = { rateLimits: { primary: { usedPercent: 20 } } };
  const source = new CodexDataSource({ ...options, localReader: emptyLocal, server: {
    connect: async () => {}, close() {}, request: async method => {
      if (method === 'account/read') {
        if (failure) throw failure;
        return result;
      }
      return limits;
    },
  } });
  await source.read();
  assert.equal((await source.read()).clearPrevious, false);
  limits = { rateLimitsByLimitId: {} };
  assert.equal((await source.read()).clearPrevious, true);
  failure = Object.assign(new Error('account lookup timed out'), { code: 'TIMEOUT' });
  const timeout = await source.read();
  assert.equal(timeout.clearPrevious, true);
  assert.equal(timeout.account, null);
  assert.deepEqual(timeout.buckets, []);
  failure = null;
  result = { account: { type: 'chatgpt', planType: 'team' } };
  assert.equal((await source.read()).clearPrevious, true);
  source.close();
});

test('invalidation discards a late previous-account read without corrupting a newer refresh', async () => {
  let releaseOld;
  let started;
  const start = new Promise(resolve => { started = resolve; });
  const oldAccount = new Promise(resolve => { releaseOld = resolve; });
  let accountReads = 0;
  let disconnects = 0;
  const source = new CodexDataSource({ ...options, localReader: emptyLocal, server: {
    connect: async () => {}, disconnect() { disconnects++; }, close() {},
    request: async method => {
      if (method === 'account/read') {
        if (++accountReads === 1) { started(); return oldAccount; }
        return { account: { type: 'chatgpt', email: 'new@example.test' } };
      }
      return { rateLimits: { primary: { usedPercent: 65 } } };
    },
  } });
  const oldRead = source.read();
  await start;
  assert.equal(source.invalidate(), 1);
  const next = source.read();
  assert.notEqual(oldRead, next);
  const fresh = await next;
  assert.equal(fresh.buckets[0].primary.remainingPercent, 35);
  releaseOld({ account: { type: 'chatgpt', email: 'previous@example.test' } });
  const discarded = await oldRead;
  assert.equal(discarded.invalidated, true);
  assert.equal(discarded.clearPrevious, true);
  assert.deepEqual(discarded.buckets, []);
  assert.equal(discarded.account, null);
  assert.equal((await source.read()).clearPrevious, false);
  assert.equal(disconnects, 6); // Three initial cleanups, invalidation, and two current-revision completions.
  source.close();
});

test('a superseded refresh cannot release the newer app-server while its quota read is pending', async () => {
  let releaseOld;
  let oldStarted;
  let releaseNew;
  let newStarted;
  const oldReady = new Promise(resolve => { oldStarted = resolve; });
  const oldAccount = new Promise(resolve => { releaseOld = resolve; });
  const newReady = new Promise(resolve => { newStarted = resolve; });
  const newLimits = new Promise(resolve => { releaseNew = resolve; });
  let serial = 0;
  let transport = null;
  const killed = [];
  const server = {
    async connect() { transport = ++serial; },
    disconnect() { if (transport !== null) killed.push(transport); transport = null; },
    close() { this.disconnect(); },
    async request(method) {
      if (method === 'account/read') {
        if (transport === 1) { oldStarted(); return oldAccount; }
        return { account: { type: 'chatgpt', email: 'new@example.test' } };
      }
      assert.equal(transport, 2);
      newStarted();
      const result = await newLimits;
      assert.equal(transport, 2, 'the old completion must leave the current transport connected');
      return result;
    },
  };
  const source = new CodexDataSource({ ...options, localReader: emptyLocal, server });
  const oldRead = source.read();
  await oldReady;
  source.invalidate();
  const freshRead = source.read();
  await newReady;
  releaseOld({ account: { type: 'chatgpt', email: 'old@example.test' } });
  assert.equal((await oldRead).invalidated, true);
  assert.equal(transport, 2);
  assert.deepEqual(killed, [1]);
  releaseNew({ rateLimits: { primary: { usedPercent: 35 } } });
  assert.equal((await freshRead).buckets[0].primary.remainingPercent, 65);
  assert.equal(transport, null);
  assert.deepEqual(killed, [1, 2]);
  source.close();
});
