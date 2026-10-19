'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { ActiveConversationDetector } = require('../src/active-conversation.cjs');

const SESSION = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SECOND_SESSION = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';
const BASE = Date.parse('2026-10-18T12:00:00.000Z');
const timestamp = seconds => new Date(BASE + seconds * 1000).toISOString();
const activity = (seconds = 1, { threadId = A, active = true, visible = true, focused = true, appearance = 'primary', windowId = 1, webContentsId = 10 } = {}) =>
  `${timestamp(seconds)} info [app-server-manager] thread_stream_view_activity_changed active=${active} conversationId=${threadId} rendererWebContentsId=${webContentsId} rendererWindowAppearance=${appearance} rendererWindowFocused=${focused} rendererWindowId=${windowId} rendererWindowVisible=${visible} resumeState=resumed streamRole=owner`;
const route = (seconds = 2, { threadId = A, routePath = `/local/${threadId}`, ownerId = threadId, windowId = 1, webContentsId = 10, event = 'IAB_LIFECYCLE received browser sidebar owner sync' } = {}) =>
  `${timestamp(seconds)} info [FetchHandler] ${event} browserTabId=null conversationId=${ownerId} originWebContentsId=${webContentsId} ownerRoutePath=${routePath} windowId=${windowId}`;

async function fixture(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'maid-active-conversation-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'isolated-codex-logs');
  const date = path.join(root, '2026', '10', '18');
  await fs.mkdir(date, { recursive: true });
  let now = BASE + 300000;
  let processes = { known: true, roots: [{ pid: 4321, path: path.join(directory, 'fixture-Codex.exe') }] };
  const count = { opens: 0, bytes: 0, processes: 0, operations: 0 };
  const filesystem = { ...fs,
    async open(...args) {
      count.opens++;
      const handle = await fs.open(...args);
      return {
        stat: () => handle.stat(), close: () => handle.close(),
        async read(...parameters) { const result = await handle.read(...parameters); count.bytes += result.bytesRead; return result; },
      };
    },
  };
  for (const method of ['lstat', 'realpath', 'readdir']) filesystem[method] = async (...args) => { count.operations++; return fs[method](...args); };
  const detector = new ActiveConversationDetector({ logRoots: [root], getProcesses: async () => { count.processes++; return processes; },
    filesystem, now: () => now, ...options });
  async function file(content = [activity(), route()], { pid = 4321, session = SESSION, thread = 0, instance = 1, segment = 0, dateDirectory = date, clock = '120000' } = {}) {
    await fs.mkdir(dateDirectory, { recursive: true });
    const filename = path.join(dateDirectory, `codex-desktop-${session}-${pid}-t${thread}-i${instance}-${clock}-${segment}.log`);
    await fs.writeFile(filename, Array.isArray(content) ? `${content.join('\n')}\n` : content);
    return filename;
  }
  return { directory, root, date, count, filesystem, detector, file, setProcesses: value => { processes = value; }, setNow: value => { now = value; } };
}

test('construction, waiting and cached inactivity perform no background reads', async t => {
  const data = await fixture(t);
  await data.file();
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.deepEqual(data.count, { opens: 0, bytes: 0, processes: 0, operations: 0 });
  const ready = await data.detector.resolve();
  assert.equal(ready.status, 'ready');
  assert.equal(ready.threadId, A);
  assert.equal(ready.source, 'app-window-log');
  const snapshot = { ...data.count };
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.deepEqual(data.count, snapshot);
  assert.equal(JSON.stringify(data.detector.cache).includes('resumeState'), false);
});

test('a route UUID is authoritative even when owner-sync conversationId is different', async t => {
  const data = await fixture(t);
  await data.file([activity(1, { threadId: B }), route(2, { threadId: A, ownerId: B })]);
  const result = await data.detector.resolve();
  assert.equal(result.threadId, A);
  assert.deepEqual(Object.keys(result), ['status', 'threadId', 'source', 'windowId', 'versionKey']);
});

test('unchanged logs are not reread and append updates read only their new bytes', async t => {
  const data = await fixture(t);
  const filename = await data.file();
  assert.equal((await data.detector.resolve()).threadId, A);
  const before = { ...data.count };
  assert.equal((await data.detector.resolve()).threadId, A);
  assert.equal(data.count.bytes, before.bytes);
  assert.equal(data.count.opens, before.opens);
  const append = `${route(3, { threadId: B })}\n`;
  await fs.appendFile(filename, append);
  assert.equal((await data.detector.resolve()).threadId, B);
  assert.equal(data.count.bytes - before.bytes, Buffer.byteLength(append));
});

test('version keys depend on target identity, not file growth, repeated routes or harmless activity timestamps', async t => {
  const data = await fixture(t);
  const filename = await data.file();
  const original = await data.detector.resolve();
  await fs.appendFile(filename, `${timestamp(3)} info unrelated-fixture message=PRIVATE\n${route(4)}\n${activity(5, { focused: false })}\n`);
  assert.equal((await data.detector.resolve()).versionKey, original.versionKey);
  await fs.appendFile(filename, `${route(6, { threadId: B })}\n`);
  assert.notEqual((await data.detector.resolve()).versionKey, original.versionKey);
});

test('zero, unknown or multiple desktop roots reject stale cached selection before opening any logs', async t => {
  const data = await fixture(t);
  await data.file();
  assert.equal((await data.detector.resolve()).status, 'ready');
  const count = data.count.opens;
  data.setProcesses({ known: true, roots: [] });
  assert.equal((await data.detector.resolve()).reason, 'desktop-missing');
  data.setProcesses({ known: false, roots: [] });
  assert.equal((await data.detector.resolve()).reason, 'process-unknown');
  data.setProcesses({ known: true, roots: [{ pid: 4321 }, { pid: 4322 }] });
  assert.equal((await data.detector.resolve()).reason, 'multiple-desktops');
  assert.equal(data.count.opens, count);
  assert.equal(data.detector.cache, null);
});

test('only current-PID main-thread logs are used; stale or auxiliary process logs do not determine the chat', async t => {
  const data = await fixture(t);
  await data.file([activity(), route(2, { threadId: B })], { pid: 9999 });
  await data.file([activity(), route(2, { threadId: B })], { thread: 1 });
  assert.equal((await data.detector.resolve()).reason, 'logs-missing');
  await data.file();
  assert.equal((await data.detector.resolve()).threadId, A);
});

test('ambiguous app sessions and logging instances are rejected without an mtime guess', async t => {
  const data = await fixture(t);
  await data.file();
  const second = await data.file([activity(), route(2, { threadId: B })], { session: SECOND_SESSION });
  await fs.utimes(second, new Date(), new Date());
  assert.equal((await data.detector.resolve()).reason, 'ambiguous-session');
  await fs.rm(second);
  await data.file([activity(), route(2, { threadId: B })], { instance: 2 });
  assert.equal((await data.detector.resolve()).reason, 'ambiguous-instance');
});

test('primary visible classification is required; auxiliary/hidden/missing classification cannot identify a chat', async t => {
  for (const appearance of ['avatarOverlay', 'detached']) {
    const data = await fixture(t);
    await data.file([activity(1, { appearance }), route()]);
    assert.equal((await data.detector.resolve()).reason, 'window-unconfirmed');
  }
  const hidden = await fixture(t);
  await hidden.file([activity(1, { visible: false }), route()]);
  assert.equal((await hidden.detector.resolve()).reason, 'window-unconfirmed');
  const absent = await fixture(t);
  await absent.file([route()]);
  assert.equal((await absent.detector.resolve()).reason, 'window-unconfirmed');
});

test('a matching inactive event clears the current route; a newer route can recover without matching its owner ID', async t => {
  const data = await fixture(t);
  const filename = await data.file([activity(1, { threadId: B }), route(2, { ownerId: B })]);
  assert.equal((await data.detector.resolve()).threadId, A);
  await fs.appendFile(filename, `${activity(3, { threadId: B, active: false })}\n`);
  assert.equal((await data.detector.resolve()).reason, 'window-unconfirmed');
  await fs.appendFile(filename, `${route(4, { threadId: C, ownerId: B })}\n`);
  assert.equal((await data.detector.resolve()).threadId, C);
});

test('older inactive activity does not erase a later route; unrelated old-thread inactive does not erase the current route', async t => {
  const data = await fixture(t);
  const filename = await data.file([activity(1, { active: false }), route(2, { threadId: B })]);
  assert.equal((await data.detector.resolve()).threadId, B);
  await fs.appendFile(filename, `${activity(3, { active: false })}\n`);
  assert.equal((await data.detector.resolve()).threadId, B);
});

test('home, settings, malformed or unknown routes clear a previous current thread', async t => {
  for (const routePath of ['/', '/settings', '/local/not-a-uuid', '/new', '/chatgpt/unknown']) {
    const data = await fixture(t);
    const filename = await data.file();
    assert.equal((await data.detector.resolve()).threadId, A);
    await fs.appendFile(filename, `${route(3, { routePath })}\n`);
    assert.equal((await data.detector.resolve()).reason, 'window-unconfirmed');
  }
});

test('thread/threads routes and quoted route values remain compatible', async t => {
  for (const routePath of [`/thread/${A}`, `/threads/${A}?view=review`, `"/local/${A}"`]) {
    const data = await fixture(t);
    await data.file([activity(), route(2, { routePath, event: 'owner_sync' })]);
    assert.equal((await data.detector.resolve()).threadId, A);
  }
});

test('two active primary windows remain ambiguous even if the last event belongs to only one', async t => {
  const data = await fixture(t);
  const filename = await data.file([activity(), route(), activity(3, { threadId: B, windowId: 2, webContentsId: 20, focused: false }),
    route(4, { threadId: B, windowId: 2, webContentsId: 20 })]);
  assert.equal((await data.detector.resolve()).reason, 'multiple-windows');
  await fs.appendFile(filename, `${activity(5, { threadId: B, windowId: 2, webContentsId: 20, active: false })}\n`);
  assert.equal((await data.detector.resolve()).reason, 'multiple-windows');
  await fs.appendFile(filename, `${activity(6, { threadId: B, windowId: 2, webContentsId: 20, active: false, visible: false })}\n`);
  assert.equal((await data.detector.resolve()).threadId, A);
});

test('a second visible primary Home/other/unconfirmed window makes a single chat candidate ambiguous', async t => {
  for (const routePath of ['/', '/settings', null]) {
    const data = await fixture(t);
    const lines = [activity(), route(), activity(3, { threadId: B, windowId: 2, webContentsId: 20, focused: false })];
    if (routePath !== null) lines.push(route(4, { routePath, threadId: B, windowId: 2, webContentsId: 20 }));
    await data.file(lines);
    assert.equal((await data.detector.resolve()).reason, 'multiple-windows');
  }
});

test('window and webContents identity must agree before combining activity and route evidence', async t => {
  const data = await fixture(t);
  await data.file([activity(), route(2, { webContentsId: 99 })]);
  assert.equal((await data.detector.resolve()).reason, 'window-unconfirmed');
});

test('a later active different conversation invalidates an older route until a fresh route arrives', async t => {
  const data = await fixture(t);
  const filename = await data.file();
  assert.equal((await data.detector.resolve()).threadId, A);
  await fs.appendFile(filename, `${activity(3, { threadId: B })}\n`);
  assert.equal((await data.detector.resolve()).reason, 'window-unconfirmed');
  await fs.appendFile(filename, `${route(4, { threadId: B })}\n`);
  assert.equal((await data.detector.resolve()).threadId, B);
});

test('initial read stays bounded per file and never expands into old history', async t => {
  const data = await fixture(t);
  const giant = `${activity()}\n${route()}\n${'PRIVATE SYNTHETIC BODY '.repeat(120000)}\n`;
  await data.file(giant);
  assert.equal((await data.detector.resolve()).reason, 'window-unconfirmed');
  assert.equal(data.count.bytes, 2 * 1024 * 1024);
  assert.equal(JSON.stringify(data.detector.cache).includes('PRIVATE'), false);
});

test('a bounded partial tail still fails closed without current primary-window evidence', async t => {
  const data = await fixture(t, { maxFileBytes: 512, maxTotalBytes: 600 });
  await data.file(`${activity()}\n${route()}\n`, { segment: 0 });
  await data.file(`${activity()}\n${route()}\n`, { segment: 1 });
  assert.equal((await data.detector.resolve()).reason, 'window-unconfirmed');
  assert.equal(data.count.bytes, 600);
  const before = { ...data.count };
  assert.equal((await data.detector.resolve()).reason, 'window-unconfirmed');
  assert.equal(data.count.bytes, before.bytes, 'An initially skipped prefix must not be replayed on the next unchanged read');
});

test('long-running rotation reads at most five newest segments and never substitutes a latest thread for missing classification', async t => {
  const many = await fixture(t);
  await many.file([activity(), route()], { segment: 0 });
  for (let segment = 1; segment < 5; segment++) await many.file([`${timestamp(segment)} info unrelated-fixture count=0`], { segment });
  const latest = await many.file([route(5, { threadId: B })], { segment: 5 });
  assert.equal((await many.detector.resolve()).reason, 'window-unconfirmed');
  assert.ok(many.count.opens <= 5); assert.equal(many.detector.cache.files.size, 5);
  await fs.appendFile(latest, `${activity(6, { threadId: B })}\n`);
  assert.equal((await many.detector.resolve()).threadId, B);
});

test('MSIX physical file aliases deduplicate before file and total-byte budgets, and cold reads stay within four MiB', async t => {
  const data = await fixture(t), aliasRoot = path.join(data.directory, 'isolated-package-log-alias');
  const aliasDate = path.join(aliasRoot, '2026', '10', '18'); await fs.mkdir(aliasDate, { recursive: true });
  const padding = 'UNRELATED'.repeat(300000) + '\n';
  for (let segment = 0; segment < 3; segment++) {
    const file = await data.file(padding + `${activity(segment * 2 + 1, { threadId: segment === 2 ? B : A })}\n${route(segment * 2 + 2, { threadId: segment === 2 ? B : A })}\n`, { segment });
    await fs.link(file, path.join(aliasDate, path.basename(file)));
  }
  const detector = new ActiveConversationDetector({ logRoots: [data.root, aliasRoot], filesystem: data.filesystem,
    now: () => BASE + 300000, getProcesses: async () => ({ known: true, roots: [{ pid: 4321 }] }) });
  assert.equal((await detector.resolve()).threadId, B);
  assert.equal(data.count.opens, 2); assert.equal(data.count.bytes, 4 * 1024 * 1024);
  assert.equal(detector.cache.files.size, 3);
  const before = { ...data.count }; assert.equal((await detector.resolve()).threadId, B);
  assert.equal(data.count.opens, before.opens); assert.equal(data.count.bytes, before.bytes);
});

test('missing, zero or imprecise physical identity never merges distinct files with the same segment name', async t => {
  const data = await fixture(t), secondRoot = path.join(data.directory, 'isolated-second-root');
  const secondDate = path.join(secondRoot, '2026', '10', '18'); await fs.mkdir(secondDate, { recursive: true });
  const original = await data.file([activity(), route()]);
  await fs.writeFile(path.join(secondDate, path.basename(original)), `${activity(3, { threadId: B })}\n${route(4, { threadId: B })}\n`);
  for (const invalid of [{ dev: 0 }, { ino: 0 }, { dev: undefined }, { ino: undefined }, { ino: Number.MAX_SAFE_INTEGER + 1 }]) {
    const changed = stat => { stat.dev = 1; stat.ino = 1; stat.birthtimeMs = BASE; Object.assign(stat, invalid); return stat; };
    const filesystem = { ...data.filesystem,
      async lstat(file) { return changed(await fs.lstat(file)); },
      async open(...args) { const handle = await data.filesystem.open(...args); return { ...handle, stat: async () => changed(await handle.stat()) }; },
    };
    const detector = new ActiveConversationDetector({ logRoots: [data.root, secondRoot], filesystem,
      now: () => BASE + 300000, getProcesses: async () => ({ known: true, roots: [{ pid: 4321 }] }) });
    const before = data.count.opens; assert.equal((await detector.resolve()).threadId, B);
    assert.equal(data.count.opens - before, 2, 'Both distinct files must remain in the metadata replay');
  }
});

test('a physical hardlink under a different logical session cannot hide session ambiguity', async t => {
  const data = await fixture(t), original = await data.file();
  await fs.link(original, path.join(data.date, `codex-desktop-${SECOND_SESSION}-4321-t0-i1-120000-0.log`));
  assert.equal((await data.detector.resolve()).reason, 'ambiguous-session'); assert.equal(data.count.opens, 0);
});

test('excessive candidate metadata fails closed before opening log contents', async t => {
  const data = await fixture(t);
  for (let segment = 0; segment < 129; segment++) await data.file([], { segment });
  assert.equal((await data.detector.resolve()).reason, 'log-limit'); assert.equal(data.count.opens, 0);
});

test('half-written metadata is completed from an offset without retaining raw line text in memory', async t => {
  const data = await fixture(t);
  const filename = await data.file();
  assert.equal((await data.detector.resolve()).threadId, A);
  const pending = route(3, { threadId: B });
  await fs.appendFile(filename, pending.slice(0, 25));
  assert.equal((await data.detector.resolve()).threadId, A);
  assert.equal(JSON.stringify(data.detector.cache).includes('ownerRoutePath'), false);
  await fs.appendFile(filename, `${pending.slice(25)}\n`);
  assert.equal((await data.detector.resolve()).threadId, B);
});

test('unrelated log text, nested fake event strings and oversized records never become route metadata', async t => {
  const data = await fixture(t);
  const privateBody = `${timestamp(3)} info tool-output text="${route(4, { threadId: B })}"`;
  await data.file([activity(), route(), privateBody, `${route(5, { threadId: B })} extra=${'PRIVATE'.repeat(2000)}`]);
  assert.equal((await data.detector.resolve()).threadId, A);
  assert.equal(JSON.stringify(data.detector.cache).includes('PRIVATE'), false);
});

test('new rollover segment preserves earlier classification; truncation and deleted segments rebuild safely', async t => {
  const data = await fixture(t);
  const first = await data.file();
  assert.equal((await data.detector.resolve()).threadId, A);
  const second = await data.file([route(3, { threadId: B })], { segment: 1 });
  assert.equal((await data.detector.resolve()).threadId, B);
  await fs.writeFile(first, `${activity(4, { threadId: C })}\n${route(5, { threadId: C })}\n`);
  await fs.rm(second);
  assert.equal((await data.detector.resolve()).threadId, C);
  await fs.truncate(first, 5);
  assert.equal((await data.detector.resolve()).reason, 'window-unconfirmed');
});

test('UTC date discovery can join adjacent-day files and never enumerates unrelated years', async t => {
  const data = await fixture(t);
  await data.file([activity()], { dateDirectory: path.join(data.root, '2026', '10', '17') });
  await data.file([route()]);
  await data.file([activity(), route(2, { threadId: B })], { dateDirectory: path.join(data.root, '2025', '10', '18'), session: SECOND_SESSION });
  assert.equal((await data.detector.resolve()).threadId, A);
});

test('clock rollback, future events and out-of-order new events invalidate existing cached results', async t => {
  const data = await fixture(t);
  const filename = await data.file();
  assert.equal((await data.detector.resolve()).status, 'ready');
  data.setNow(BASE + 100000);
  assert.equal((await data.detector.resolve()).reason, 'clock-regressed');
  data.setNow(BASE + 300000);
  assert.equal((await data.detector.resolve()).status, 'ready');
  await fs.appendFile(filename, `${route(1, { threadId: B })}\n`);
  assert.equal((await data.detector.resolve()).reason, 'clock-regressed');
  const future = await fixture(t);
  await future.file([activity(), route(400)]);
  assert.equal((await future.detector.resolve()).reason, 'clock-regressed');
});

test('process disconnection or replacement during a read prevents committing route state', async t => {
  const data = await fixture(t);
  await data.file();
  let calls = 0;
  const detector = new ActiveConversationDetector({ logRoots: [data.root], now: () => BASE + 300000,
    getProcesses: async () => ++calls === 1 ? { known: true, roots: [{ pid: 4321 }] } : { known: true, roots: [{ pid: 4322 }] } });
  assert.equal((await detector.resolve()).reason, 'process-changed');
  assert.equal(detector.cache, null);
});

test('symlink/junction escapes are rejected and duplicate trusted roots do not double-count logs', async t => {
  const data = await fixture(t);
  await data.file();
  const duplicate = new ActiveConversationDetector({ logRoots: [data.root, data.root], getProcesses: async () => ({ known: true, roots: [{ pid: 4321 }] }), now: () => BASE + 300000 });
  assert.equal((await duplicate.resolve()).threadId, A);
  const outside = path.join(data.directory, 'outside');
  await fs.mkdir(outside);
  const linked = path.join(data.directory, 'linked');
  await fs.symlink(outside, linked, process.platform === 'win32' ? 'junction' : 'dir');
  const unsafe = new ActiveConversationDetector({ logRoots: [linked], getProcesses: async () => ({ known: true, roots: [{ pid: 4321 }] }), now: () => BASE + 300000 });
  assert.equal((await unsafe.resolve()).reason, 'unsafe-log-path');
});

test('Darwin directory/file ownership and group/world write permissions are checked through injected metadata', async t => {
  const data = await fixture(t);
  await data.file();
  const safe = stat => { stat.uid = 42; stat.mode &= ~0o022; return stat; };
  const filesystem = { ...data.filesystem,
    async lstat(file) { return safe(await fs.lstat(file)); },
    async open(...args) {
      const handle = await data.filesystem.open(...args);
      return { ...handle, stat: async () => safe(await handle.stat()) };
    },
  };
  const options = { logRoots: [data.root], getProcesses: async () => ({ known: true, roots: [{ pid: 4321 }] }), now: () => BASE + 300000, platform: 'darwin', uid: 42, filesystem };
  assert.equal((await new ActiveConversationDetector(options).resolve()).threadId, A);
  const bad = { ...filesystem, async lstat(file) { const stat = safe(await fs.lstat(file)); if (file === data.root) stat.mode |= 0o002; return stat; } };
  assert.equal((await new ActiveConversationDetector({ ...options, filesystem: bad }).resolve()).reason, 'unsafe-log-path');
});

test('hanging filesystem/process providers time out and old work cannot commit after recovery', async t => {
  const data = await fixture(t);
  await data.file();
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  let first = true;
  const detector = new ActiveConversationDetector({ logRoots: [data.root], getProcesses: async () => ({ known: true, roots: [{ pid: 4321 }] }),
    now: () => BASE + 300000, timeoutMs: 40, filesystem: { ...fs, async readdir(...args) { if (first) { first = false; await blocked; } return fs.readdir(...args); } } });
  assert.equal((await detector.resolve()).reason, 'timeout');
  assert.equal((await detector.resolve()).threadId, A);
  const version = detector.cache;
  release();
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(detector.cache, version);
  const hung = new ActiveConversationDetector({ logRoots: [data.root], now: () => BASE + 300000, timeoutMs: 30,
    getProcesses: () => new Promise(() => {}) });
  assert.equal((await hung.resolve()).reason, 'timeout');
});

test('concurrent resolve calls share one passive observation without extra I/O', async t => {
  const data = await fixture(t);
  await data.file();
  const first = data.detector.resolve();
  const second = data.detector.resolve();
  assert.equal(first, second);
  assert.equal((await first).threadId, A);
  assert.equal(data.count.opens, 1);
  assert.equal(data.count.processes, 2);
});
