'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

for (const variant of ['..', '../macos']) {
  const { DesktopProjectBinding, readDesktopRegistration, OWNER_KEY } = require(variant + '/src/chat-desktop-project.cjs');
  const { createChatProject } = require(variant + '/src/chat-project.cjs');
  const { ChatTransport } = require(variant + '/src/chat-transport.cjs');
  function fixture(t, options = {}) {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'maid-native-project-中文 '));
    const home = path.join(base, '自定义 Codex 数据'); fs.mkdirSync(home);
    const { root, project } = createChatProject({ parentDir: base, userNickname: 'isolated fixture' });
    const sameRoot = value => { try { return fs.realpathSync(value).toLowerCase() === root.toLowerCase(); } catch { return false; } };
    const stateFile = path.join(home, '.codex-global-state.json');
    const save = state => fs.writeFileSync(stateFile, JSON.stringify(state));
    const state = { 'local-projects': { 'local-widget': { id: 'local-widget', name: '桌宠项目', rootPaths: [root] } },
      'app-server-project-id-by-legacy-project-id-by-host': { ['local:' + home]: { 'local-widget': 'native-widget' } }, unrelated: { preserve: 'unchanged' } };
    if (!options.unregistered) save(state);
    const native = { id: 'native-widget', name: '桌宠项目', roots: [{ path: root }], metadata: {} };
    const calls = [], threads = new Map([['owned', { id: 'owned', cwd: root, projectId: null }]]);
    const request = async (method, params) => {
      calls.push({ method, params });
      if (options.request) { const result = await options.request(method, params); if (result !== undefined) return result; }
      if (method === 'project/read' || method === 'project/create') return { project: native };
      if (method === 'project/list') return { data: [native], nextCursor: null };
      if (method === 'thread/metadata/update') { threads.get(params.threadId).projectId = params.projectId; return {}; }
      if (method === 'thread/read') return { thread: threads.get(params.threadId) };
      if (method === 'thread/start') { const thread = { id: 'created', cwd: root, projectId: params.projectId, createdAt: 1 }; threads.set(thread.id, thread); return { thread }; }
      if (method === 'thread/name/set') { threads.get(params.threadId).name = params.name; return {}; }
      if (method === 'thread/resume') return { thread: threads.get(params.threadId) };
      if (method === 'turn/start') return { turn: { id: 'turn', status: 'inProgress' } };
      return {};
    };
    const binding = new DesktopProjectBinding({ projectRoot: root, codexHome: home, env: {}, home: base,
      fs, sameRoot, request, ...options.binding });
    const transport = new ChatTransport({ projectRoot: root, codexHome: home, env: {}, home: base,
      ownedThreads: [{ threadId: 'owned', projectRoot: root }], desktopProject: true });
    transport.ready = true; transport.child = {}; transport._rpc = request; transport._allowMutation = async () => {};
    t.after(() => fs.rmSync(base, { recursive: true, force: true }));
    return { base, home, root, project, stateFile, state, save, native, binding, transport, calls, threads, sameRoot };
  }

  test(`${variant}: native project uses desktop identity, canonical root and no shared-state writes`, async t => {
    const h = fixture(t), before = fs.readFileSync(h.stateFile);
    assert.deepEqual(await h.binding.ensure(), { projectId: 'native-widget', desktopRegistered: true, localProjectId: 'local-widget', registrationRequired: false });
    assert.deepEqual(h.calls, [{ method: 'project/read', params: { projectId: 'native-widget' } }]);
    assert.deepEqual(fs.readFileSync(h.stateFile), before);
  });

  test(`${variant}: first use automatically creates and registers the native project`, async t => {
    const h = fixture(t, { unregistered: true });
    const state = await h.binding.ensure(); assert.equal(state.registrationRequired, false);
    assert.equal(state.desktopRegistered, true); assert.equal(state.projectId, 'native-widget');
    assert.equal(h.calls.some(call => call.method === 'project/list'), true);
    assert.equal(JSON.parse(fs.readFileSync(h.stateFile, 'utf8'))['local-projects'][state.localProjectId].rootPaths[0], h.root);
    const started = await h.transport.startThread({ title: '2026-10-27_14-00-00' });
    assert.equal(started.projectAssigned, true); assert.equal(h.calls.some(call => call.method === 'thread/start'), true);
    assert.equal(h.transport.unknownCreation, false);
  });

  test(`${variant}: first use appends the mapping without replacing unrelated desktop projects`, async t => {
    const h = fixture(t, { unregistered: true });
    const preserved = { 'local-projects': { unrelated: { id: 'unrelated', name: '其他项目', rootPaths: [h.home] } },
      'app-server-project-id-by-legacy-project-id-by-host': { ['local:' + h.home]: { unrelated: 'other-native' } }, marker: 'keep-me' };
    h.save(preserved);
    const result = await h.binding.ensure();
    const after = JSON.parse(fs.readFileSync(h.stateFile, 'utf8'));
    assert.equal(result.desktopRegistered, true); assert.equal(after.marker, 'keep-me');
    assert.deepEqual(after['local-projects'].unrelated, preserved['local-projects'].unrelated);
    assert.equal(after['local-projects'][result.localProjectId].rootPaths[0], h.root);
    assert.equal(after['app-server-project-id-by-legacy-project-id-by-host']['local:' + h.home].unrelated, 'other-native');
  });

  test(`${variant}: desktop registration changes are retried without restarting or adding a second project`, async t => {
    const h = fixture(t, { unregistered: true });
    const first = await h.binding.ensure(); assert.equal(first.registrationRequired, false);
    h.save(h.state); const second = await h.binding.ensure(); assert.equal(second.projectId, 'native-widget');
    assert.equal(h.calls.filter(call => call.method === 'project/create').length, 0);
  });

  test(`${variant}: concurrent native registration reuses desktop idempotency key`, async t => {
    const h = fixture(t, { request: async method => method === 'project/list' ? { data: [], nextCursor: null } : undefined });
    delete h.state['app-server-project-id-by-legacy-project-id-by-host']; h.save(h.state);
    const result = await Promise.all([h.binding.ensure(), h.binding.ensure()]); assert.deepEqual(result[0], result[1]);
    const create = h.calls.filter(call => call.method === 'project/create'); assert.equal(create.length, 1);
    assert.deepEqual(create[0].params, { idempotencyKey: 'local-widget', name: '桌宠项目', roots: [{ path: h.root }], metadata: { [OWNER_KEY]: h.project.projectId } });
  });

  test(`${variant}: root or marker mismatch and ambiguous desktop roots cannot claim another project`, async t => {
    const h = fixture(t); h.native.roots = [{ path: h.home }];
    await assert.rejects(h.binding.ensure(), { code: 'CHAT_DESKTOP_PROJECT_SCOPE' });
    h.native.roots = [{ path: h.root }]; h.native.metadata[OWNER_KEY] = 'P-foreign';
    await assert.rejects(h.binding.ensure(), { code: 'CHAT_DESKTOP_PROJECT_SCOPE' });
    h.native.metadata = {}; h.state['local-projects'].duplicate = { rootPaths: [h.root] }; h.save(h.state);
    await assert.rejects(h.binding.ensure(), { code: 'CHAT_DESKTOP_PROJECT_AMBIGUOUS' });
    assert.equal(h.calls.some(call => call.method === 'thread/metadata/update'), false);
  });

  test(`${variant}: only an owned thread with verified metadata can migrate and readback is required`, async t => {
    const h = fixture(t), hooks = { isOwned: value => value === 'owned', readThread: value => h.transport._rpc('thread/read', { threadId: value, includeTurns: false }) };
    await assert.rejects(h.binding.assign('foreign', hooks), { code: 'THREAD_SCOPE' });
    assert.equal(h.calls.length, 0);
    assert.equal((await h.binding.assign('owned', hooks)).projectAssigned, true);
    assert.equal(h.threads.get('owned').projectId, 'native-widget');
    assert.deepEqual(h.calls.filter(call => call.method === 'thread/metadata/update').map(call => call.params), [{ threadId: 'owned', projectId: 'native-widget' }]);
    await h.binding.assign('owned', hooks);
    assert.equal(h.calls.filter(call => call.method === 'thread/metadata/update').length, 1);
    h.threads.get('owned').projectId = 'different-project';
    await assert.rejects(h.binding.assign('owned', hooks), { code: 'CHAT_DESKTOP_THREAD_PROJECT_CONFLICT' });
    h.threads.get('owned').projectId = null; h.threads.get('owned').cwd = h.home;
    await assert.rejects(h.binding.assign('owned', hooks), { code: 'THREAD_SCOPE' });
  });

  test(`${variant}: thread creation and continued sends bind the actual native project`, async t => {
    const h = fixture(t); const result = await h.transport.startThread({ title: '2026-10-27_14-00-00' });
    assert.equal(result.projectAssigned, true);
    assert.equal(h.calls.find(call => call.method === 'thread/start').params.projectId, 'native-widget');
    assert.equal(h.calls.find(call => call.method === 'thread/start').params.cwd, h.root);
    await h.transport.send('owned', { text: 'isolated test input' });
    const assignment = h.calls.findIndex(call => call.method === 'thread/metadata/update'), turn = h.calls.findIndex(call => call.method === 'turn/start');
    assert(assignment >= 0 && turn > assignment);
    for (const method of ['project/create', 'project/list', 'thread/metadata/update']) await assert.rejects(h.transport.request(method, {}), { code: 'METHOD_DENIED' });
  });

  test(`${variant}: unconfirmed project returned by thread/start is unknown and never dispatched a turn`, async t => {
    const h = fixture(t, { request: async method => method === 'thread/start' ? { thread: { id: 'wrong', cwd: h.root, projectId: 'another' } } : undefined });
    await assert.rejects(h.transport.startThread(), { code: 'THREAD_SCOPE', executionState: 'unknown' });
    assert.equal(h.transport.unknownCreation, true); assert.equal(h.transport.owned.has('wrong'), false);
    assert.equal(h.calls.some(call => call.method === 'turn/start'), false);
  });

  test(`${variant}: metadata-only reconciliation includes archived threads and rejects foreign or changed roots`, async t => {
    const h = fixture(t, { request: async (method, params) => {
      if (method !== 'thread/list') return;
      assert.equal(params.cwd, h.root); assert.equal(params.useStateDbOnly, true);
      assert.equal(params.limit, 50); assert.equal(Object.hasOwn(params, 'searchTerm'), false);
      assert(params.sourceKinds.includes('appServer')); assert(params.sourceKinds.includes('exec'));
      return { data: params.archived ? [{ id: 'archived', cwd: h.root, ephemeral: false }] : [
        { id: 'owned', cwd: h.root, ephemeral: false }, { id: 'foreign', cwd: h.home },
        { id: 'changed-root', cwd: h.root }, { id: 'conflict', cwd: h.root }, { id: 'ephemeral', cwd: h.root, ephemeral: true }
      ], nextCursor: null };
    } });
    h.threads.set('archived', { id: 'archived', cwd: h.root, projectId: null });
    h.threads.set('changed-root', { id: 'changed-root', cwd: h.home, projectId: null });
    h.threads.set('conflict', { id: 'conflict', cwd: h.root, projectId: 'user-other-project' });
    const result = await h.transport.reconcileDesktopProject();
    assert.equal(result.discovered, 4); assert.equal(result.assigned, 2); assert.equal(result.failed, 1); assert.equal(result.conflicts, 1);
    assert.equal(result.discoveryComplete, true);
    assert.equal(h.transport.owned.has('archived'), true); assert.equal(h.transport.owned.has('foreign'), false);
    assert.equal(h.transport.owned.has('changed-root'), false); assert.equal(h.transport.owned.has('conflict'), false);
    assert.deepEqual(h.calls.filter(call => call.method === 'thread/metadata/update').map(call => call.params.threadId).sort(), ['archived', 'owned']);
    assert(h.calls.every(call => call.method !== 'thread/read' || call.params.includeTurns === false));
    assert.equal(JSON.stringify(result).includes('archived'), false);
    const repeat = await h.transport.reconcileDesktopProject(); assert.equal(repeat.assigned, 0); assert.equal(repeat.alreadyAssigned, 2);
  });

  test(`${variant}: desktop state damage and native paging loops never broaden project ownership`, async t => {
    const h = fixture(t); fs.writeFileSync(h.stateFile, '{broken');
    await assert.rejects(h.binding.ensure(), { code: 'CHAT_DESKTOP_STATE_INVALID' });
    h.save(h.state);
    h.transport._rpc = async method => {
      if (method === 'project/read') return { project: h.native };
      if (method === 'thread/list') return { data: [], nextCursor: 'loop' };
      throw new Error('unexpected native mutation');
    };
    await assert.rejects(h.transport.reconcileDesktopProject(), { code: 'CHAT_DESKTOP_PROJECT_PROTOCOL' });
    assert.deepEqual([...h.transport.owned], ['owned']);
  });

  test(`${variant}: Windows custom drive, case insensitive home and Unicode paths use injected metadata only`, () => {
    const root = 'F:\\桌宠 项目', home = 'G:\\自定义 数据\\Codex'; let readFile;
    const state = { 'local-projects': { chosen: { rootPaths: [root.toLowerCase()], name: '桌宠' } },
      'app-server-project-id-by-legacy-project-id-by-host': { ['local:' + home.toLowerCase()]: { chosen: 'native' } } };
    const io = { lstatSync: () => ({ isFile: () => true, isSymbolicLink: () => false, size: 100 }),
      readFileSync: file => { readFile = file; return JSON.stringify(state); }, realpathSync: value => value };
    const same = (a, b) => path.win32.normalize(a).toLowerCase() === path.win32.normalize(b).toLowerCase();
    assert.deepEqual(readDesktopRegistration({ projectRoot: root, codexHome: home, sameRoot: value => same(value, root), samePath: same,
      fs: io, pathApi: path.win32 }), { localProjectId: 'chosen', name: '桌宠', serverProjectId: 'native' });
    assert.equal(readFile, 'G:\\自定义 数据\\Codex\\.codex-global-state.json');
  });
}
