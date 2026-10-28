'use strict';
// Sandboxed Chromium, production preload and renderers, synthetic IPC only.
// Do not load the real main, service, account, data-home or conversation readers.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const option = name => { const index = process.argv.indexOf('--' + name); return index < 0 ? null : process.argv[index + 1]; };
const output = option('output'), requestedRoot = option('windows-root');
assert.ok(output && path.isAbsolute(output), 'An explicit absolute --output is required.');
if (requestedRoot) assert.ok(path.isAbsolute(requestedRoot), '--windows-root must be absolute.');
const windowsRoot = requestedRoot || root, version = require('../package.json').version;
assert.ok(fs.existsSync(windowsRoot), 'Windows application root exists.');

if (!process.versions.electron) {
  fs.mkdirSync(output, { recursive: true });
  const profile = fs.mkdtempSync(path.join(output, 'isolated-profile-'));
  for (const name of ['codex', 'maid', 'appdata', 'localappdata', 'temp', 'userdata', 'session', 'crashDumps']) fs.mkdirSync(path.join(profile, name));
  const env = { ...process.env, CODEX_MAID_RECOVERY_UI_PROFILE: profile,
    CODEX_HOME: path.join(profile, 'codex'), CODEX_MAID_HOME: path.join(profile, 'maid'), HOME: profile, USERPROFILE: profile,
    APPDATA: path.join(profile, 'appdata'), LOCALAPPDATA: path.join(profile, 'localappdata'), TEMP: path.join(profile, 'temp'), TMP: path.join(profile, 'temp') };
  delete env.ELECTRON_RUN_AS_NODE;
  const args = [__filename, '--output', output];
  if (requestedRoot) args.push('--windows-root', requestedRoot);
  const child = require('node:child_process').spawn(require('electron'), args, { cwd: root, env, windowsHide: true, stdio: 'inherit' });
  child.once('error', error => { console.error(error.message); process.exitCode = 1; });
  child.once('exit', code => { process.exitCode = code ?? 1; });
} else {
  const profile = process.env.CODEX_MAID_RECOVERY_UI_PROFILE;
  assert.ok(profile && path.dirname(profile) === output, 'Use the Node launcher to create an isolated profile.');
  for (const [name, relative] of Object.entries({ CODEX_HOME: 'codex', CODEX_MAID_HOME: 'maid', APPDATA: 'appdata', LOCALAPPDATA: 'localappdata', TEMP: 'temp', TMP: 'temp' })) assert.equal(process.env[name], path.join(profile, relative));
  assert.equal(process.env.HOME, profile); assert.equal(process.env.USERPROFILE, profile);
  const { app, BrowserWindow, ipcMain } = require('electron');
  app.on('window-all-closed', () => {}); app.disableHardwareAcceleration();
  for (const [name, relative] of Object.entries({ userData: 'userdata', sessionData: 'session', crashDumps: 'crashDumps', temp: 'temp', home: '' })) app.setPath(name, path.join(profile, relative));
  const fixtures = new Map(), cases = [], captures = [], errors = [];
  let phase = 'startup', networkAttempts = 0;
  const archiveFs = require('original-fs'), sha256 = file => require('node:crypto').createHash('sha256').update(archiveFs.readFileSync(file)).digest('hex');
  const packagedArchive = requestedRoot && archiveFs.statSync(windowsRoot).isFile() ? { path: windowsRoot, sha256: sha256(windowsRoot) } : null;
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const evaluate = (win, source) => win.webContents.executeJavaScript(source, true);
  const query = (win, source) => evaluate(win, `(()=>{${source}})()`);
  async function until(win, source) {
    for (let index = 0; index < 180; index++) { if (await evaluate(win, source)) return; await wait(25); }
    throw new Error('Timed out: ' + phase + ' (' + source + ')');
  }
  async function untilMain(predicate) {
    for (let index = 0; index < 180; index++) { if (predicate()) return; await wait(25); }
    throw new Error('Timed out waiting for synthetic IPC: ' + phase);
  }
  async function click(win) { await evaluate(win, "document.getElementById('chat-reconcile').click();void 0"); }
  async function read(win) {
    return query(win, "const b=document.getElementById('chat-reconcile'),s=document.getElementById('chat-reconcile-status');return {disabled:b.disabled,busy:b.getAttribute('aria-busy'),label:b.textContent,status:s.textContent,hidden:s.hidden,draft:document.getElementById('manager-chat-input').value,send:document.getElementById('manager-send').disabled,append:document.getElementById('chat-append').disabled,queue:document.getElementById('chat-queue').disabled};");
  }
  function fixtureFor(event) { const f = fixtures.get(event.sender.id); assert.ok(f, 'IPC belongs to this isolated fixture.'); return f; }
  const channels = ['state', 'chat-state', 'chat-memory', 'chat-models', 'chat-draft', 'chat-reconcile', 'widget-input-active'];
  for (const channel of channels) ipcMain.handle(channel, async (event, input) => {
    const f = fixtureFor(event);
    if (channel === 'state') return f.applicationState();
    if (channel === 'chat-state') return structuredClone(f.chat);
    if (channel === 'chat-memory') return { module: input.module, version: 1, offset: 0, total: 0, entries: [], names: { pet_name: 'Synthetic companion', user_nickname: 'Synthetic user' }, baseline: { core: [], preferences: [], background: [], examples: [], boundaries: [] } };
    if (channel === 'chat-models') return { models: [{ id: 'gpt-6.1-sol', displayName: 'Synthetic model', reasoningEfforts: ['medium'] }] };
    if (channel === 'chat-draft') { f.draftWrites++; if (input.scope === 'chat') f.chat.draft = input.text; return { revision: f.draftWrites }; }
    if (channel === 'widget-input-active') return { active: input === true };
    if (channel === 'chat-reconcile') {
      assert.equal(f.pending, null, 'Only one reconciliation may be in flight.'); f.reconcileCalls++;
      return new Promise((resolve, reject) => { f.pending = { resolve, reject }; });
    }
  });
  for (const channel of ['chat-send', 'chat-steer', 'chat-maintenance', 'chat-initialize']) ipcMain.handle(channel, event => { const f = fixtureFor(event); f.unexpectedMutations++; throw new Error('Unexpected mutating IPC in recovery UI test.'); });
  function fixture(base, platform, language) {
    const settings = { language, chatModel: 'gpt-6.1-sol', chatReasoningEffort: 'medium', chatPageEnabled: true };
    const f = { base, platform, language, settings, pending: null, reconcileCalls: 0, draftWrites: 0, unexpectedMutations: 0, win: null,
      chat: { initialized: true, ready: false, mode: 'simulation', contextRecoveryRequired: true, unknownExecution: false, connecting: false, connection: { state: 'ready' }, generating: false,
        threadId: 'synthetic-existing-thread', project: { folder: 'synthetic project', petName: 'Synthetic companion', userNickname: 'Synthetic user' }, draft: 'Preserved draft — 初始草稿', messages: [], messageCount: 0, queued: [],
        memory: { modules: { persona: { version: 1 } }, pendingSync: false }, health: { maintenance: 'ready', search: {} }, maintenance: { state: 'idle', plan: [], limits: {}, used: {} }, dream: { state: 'ready', settings: { mode: 'automatic', target: 'duplicates' } } } };
    f.applicationState = () => ({ version, settings, demo: true, snapshot: { status: 'demo', buckets: [] } });
    f.publish = () => { f.win.webContents.send('chat-state', structuredClone(f.chat)); f.win.webContents.send('state', f.applicationState()); };
    f.release = ({ ready = false, contextRecoveryRequired = true, unknownExecution = false, failure = null } = {}) => {
      assert.ok(f.pending, 'Synthetic reconciliation is awaiting a result.'); const pending = f.pending; f.pending = null;
      Object.assign(f.chat, { ready, contextRecoveryRequired, unknownExecution });
      if (failure) pending.reject(new Error(failure)); else { f.publish(); pending.resolve(structuredClone(f.chat)); }
    };
    return f;
  }
  async function capture(f, name) {
    await evaluate(f.win, "document.getElementById('chat-reconcile').scrollIntoView({block:'center'});new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
    const image = await f.win.webContents.capturePage(), file = `${f.platform}-${f.language}-${name}.png`;
    fs.writeFileSync(path.join(output, file), image.toPNG()); captures.push({ file, ...image.getSize() });
  }
  async function translatedFeedback(f, original, draft, { checking = false } = {}) {
    const alternate = f.language === 'en' ? 'zh-CN' : 'en';
    f.settings.language = alternate; f.publish();
    await until(f.win, `window.MaidI18n.getLocale()===${JSON.stringify(alternate)}&&document.getElementById('chat-reconcile-status').textContent!==${JSON.stringify(original.status)}`);
    const translated = await read(f.win);
    assert.equal(translated.draft, draft); assert.equal(translated.hidden, false); assert.notEqual(translated.status, original.status);
    if (alternate === 'en') assert.doesNotMatch(translated.status, /[\u3400-\u9fff]/, 'Recovery feedback switches into English.');
    else assert.match(translated.status, /[\u3400-\u9fff]/, 'Recovery feedback switches into Chinese.');
    if (checking) { assert.equal(translated.busy, 'true'); assert.equal(translated.disabled, true); assert.equal(translated.send, true); assert.equal(translated.append, true); assert.equal(translated.queue, true); }
    f.settings.language = f.language; f.publish();
    await until(f.win, `window.MaidI18n.getLocale()===${JSON.stringify(f.language)}&&document.getElementById('chat-reconcile-status').textContent===${JSON.stringify(original.status)}`);
    const restored = await read(f.win); assert.equal(restored.draft, draft); assert.equal(restored.status, original.status);
    return translated;
  }
  async function check(base, platform, language) {
    phase = platform + ' ' + language + ' initial';
    assert.equal(require(path.join(base, 'package.json')).version, version, 'Application versions agree.');
    const f = fixture(base, platform, language);
    const win = f.win = new BrowserWindow({ width: 1024, height: 900, useContentSize: true, show: false, backgroundColor: '#f5faf8',
      webPreferences: { preload: path.join(base, 'src/preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false, partition: 'recovery-ui-' + platform + '-' + language } });
    fixtures.set(win.webContents.id, f); win.webContents.setAudioMuted(true); win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (_request, done) => { networkAttempts++; done({ cancel: true }); });
    win.webContents.on('console-message', (_event, details) => { if (details.level === 'error') errors.push({ phase, message: details.message }); });
    win.webContents.on('preload-error', (_event, _file, error) => errors.push({ phase, message: error.message }));
    await win.loadFile(path.join(base, 'src/chat-page.html'));
    await until(win, `window.MaidChatWorkspace&&window.MaidI18n.getLocale()===${JSON.stringify(language)}&&document.getElementById('chat-reconcile-status')`);
    assert.equal(await evaluate(win, "typeof require==='undefined'&&typeof process==='undefined'"), true, 'Renderer is sandboxed.');
    const initial = await read(win); assert.equal(initial.send, true); assert.equal(initial.disabled, false);
    const draft = 'Keep this draft — 核对期间继续编辑';
    await evaluate(win, `document.getElementById('manager-chat-input').value=${JSON.stringify(draft)};document.getElementById('manager-chat-input').dispatchEvent(new Event('input',{bubbles:true}));void 0`);
    await untilMain(() => f.chat.draft === draft);

    phase = platform + ' ' + language + ' service reconciliation broadcast';
    Object.assign(f.chat, { reconciling: true, ready: true, contextRecoveryRequired: false }); f.publish();
    await until(win, "document.getElementById('chat-reconcile').getAttribute('aria-busy')==='true'");
    const external = await read(win); assert.equal(external.disabled, true); assert.equal(external.send, true); assert.equal(external.append, true); assert.equal(external.queue, true); assert.equal(external.hidden, false); assert.ok(external.status.trim());
    await evaluate(win, "document.getElementById('chat-reconcile').dispatchEvent(new MouseEvent('click',{bubbles:true}));document.getElementById('manager-chat-form').dispatchEvent(new Event('submit',{cancelable:true}));document.getElementById('chat-queue').dispatchEvent(new MouseEvent('click',{bubbles:true}));void 0");
    await wait(40); assert.equal(f.reconcileCalls, 0); assert.equal(f.unexpectedMutations, 0);
    await translatedFeedback(f, external, draft, { checking: true });
    Object.assign(f.chat, { reconciling: false, ready: false, contextRecoveryRequired: true }); f.publish();
    await until(win, "!document.getElementById('chat-reconcile').disabled&&document.getElementById('manager-send').disabled");

    phase = platform + ' ' + language + ' pending'; await click(win); await untilMain(() => f.reconcileCalls === 1);
    await until(win, "document.getElementById('chat-reconcile').disabled&&document.getElementById('chat-reconcile').getAttribute('aria-busy')==='true'");
    const pending = await read(win);
    assert.equal(pending.hidden, false); assert.ok(pending.status.trim()); assert.notEqual(pending.label, initial.label);
    assert.equal(pending.send, true); assert.equal(pending.append, true); assert.equal(pending.queue, true);
    f.chat.ready = true; f.chat.contextRecoveryRequired = false; f.publish();
    await evaluate(win, "new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
    const broadcast = await read(win); assert.equal(broadcast.busy, 'true'); assert.equal(broadcast.disabled, true); assert.equal(broadcast.status, pending.status);
    assert.equal(broadcast.send, true); assert.equal(broadcast.append, true); assert.equal(broadcast.queue, true);
    await evaluate(win, "document.getElementById('chat-reconcile').dispatchEvent(new MouseEvent('click',{bubbles:true}));document.getElementById('manager-chat-form').dispatchEvent(new Event('submit',{cancelable:true}));document.getElementById('chat-queue').dispatchEvent(new MouseEvent('click',{bubbles:true}));void 0");
    await wait(40); assert.equal(f.reconcileCalls, 1); assert.equal(f.unexpectedMutations, 0);
    await translatedFeedback(f, pending, draft, { checking: true });
    await capture(f, 'pending');

    phase = platform + ' ' + language + ' restored'; f.release({ ready: true, contextRecoveryRequired: false });
    await until(win, "!document.getElementById('chat-reconcile').disabled&&document.getElementById('chat-reconcile').getAttribute('aria-busy')==='false'&&!document.getElementById('manager-send').disabled");
    const restored = await read(win); assert.equal(restored.draft, draft); assert.ok(restored.status.trim()); assert.notEqual(restored.status, pending.status); assert.equal(restored.hidden, false);
    assert.equal(f.chat.threadId, 'synthetic-existing-thread');
    f.publish(); await wait(40); assert.equal((await read(win)).status, restored.status); await translatedFeedback(f, restored, draft); await capture(f, 'restored');

    phase = platform + ' ' + language + ' still restricted'; Object.assign(f.chat, { ready: false, contextRecoveryRequired: true }); f.publish();
    await until(win, "document.getElementById('manager-send').disabled"); await click(win); await untilMain(() => f.reconcileCalls === 2);
    f.release(); await until(win, "!document.getElementById('chat-reconcile').disabled");
    const restricted = await read(win); assert.equal(restricted.send, true); assert.equal(restricted.draft, draft); assert.ok(restricted.status.trim()); assert.notEqual(restricted.status, pending.status); assert.notEqual(restricted.status, restored.status);
    assert.match(restricted.status, language === 'en' ? /could not|still|unable|cannot/i : /仍|未能|无法/); await translatedFeedback(f, restricted, draft); await capture(f, 'restricted');

    phase = platform + ' ' + language + ' rejected'; await click(win); await untilMain(() => f.reconcileCalls === 3);
    const failure = 'Synthetic safe recovery failure [CHAT_CONTEXT_METADATA_INVALID]'; f.release({ failure });
    await until(win, "!document.getElementById('chat-reconcile').disabled&&document.getElementById('chat-reconcile-status').textContent.includes('Synthetic safe recovery failure')");
    const rejected = await read(win); assert.equal(rejected.status, failure, 'Electron IPC prefix is removed while preserving the safe business reason.'); assert.equal(rejected.draft, draft); assert.equal(rejected.send, true);
    f.publish(); await wait(40); assert.equal((await read(win)).status, failure); await capture(f, 'failed');

    phase = platform + ' ' + language + ' retry'; await click(win); await untilMain(() => f.reconcileCalls === 4); f.release({ ready: true, contextRecoveryRequired: false });
    await until(win, "!document.getElementById('chat-reconcile').disabled&&!document.getElementById('manager-send').disabled");
    const retried = await read(win); assert.equal(retried.draft, draft); assert.equal(retried.status, restored.status); assert.equal(f.unexpectedMutations, 0);
    if (language === 'en') for (const value of [pending.label, pending.status, restored.status, restricted.status]) assert.doesNotMatch(value, /[\u3400-\u9fff]/, 'English recovery feedback is translated.');

    for (const [name, unknownExecution, reason] of [['unknown', true, null], ['writer-conflict', false, 'THREAD_WRITER_CONFLICT']]) {
      phase = platform + ' ' + language + ' readiness ' + name;
      Object.assign(f.chat, { ready: false, contextRecoveryRequired: false, unknownExecution, connection: { state: reason ? 'error' : 'ready', reason } }); f.publish();
      await until(win, "document.getElementById('manager-send').disabled"); const before = f.reconcileCalls; await click(win); await untilMain(() => f.reconcileCalls === before + 1);
      f.release({ unknownExecution, contextRecoveryRequired: false });
      await until(win, "!document.getElementById('chat-reconcile').disabled&&document.getElementById('chat-reconcile').getAttribute('aria-busy')==='false'");
      const readiness = await read(win); assert.equal(readiness.send, true); assert.equal(readiness.draft, draft); assert.ok(readiness.status.trim());
      assert.match(readiness.status, unknownExecution ? language === 'en' ? /previous request|do not resend/i : /上次请求|请勿重发/ : language === 'en' ? /Codex client|open|close/i : /占用|关闭/);
      await translatedFeedback(f, readiness, draft); await capture(f, name);
    }
    assert.equal(f.chat.threadId, 'synthetic-existing-thread'); assert.equal(f.unexpectedMutations, 0);
    cases.push({ platform, language, pendingVisible: true, duplicateClicksBlocked: true, pendingBroadcastPreserved: true, sendsBlockedWhileChecking: true,
      serviceBroadcastBlocksOtherWindows: true, pendingLocaleSwitchPreserved: true, resultLocaleSwitchPreserved: true, readinessLocaleSwitchPreserved: true,
      restorationUnlocksSend: true, restrictedStateVisible: true, failedReasonSurvivesBroadcast: true, retrySucceeds: true, draftPreserved: true, originalThreadPreserved: true, reconcileCalls: f.reconcileCalls, unexpectedMutations: f.unexpectedMutations });
    fixtures.delete(win.webContents.id); win.destroy();
  }
  function report(ok, error) {
    const archiveAfter = packagedArchive ? sha256(windowsRoot) : null;
    const value = { ok, version, phase, error: error?.message, syntheticDataOnly: true, productionPreloadAndRenderer: true,
      allProfilePathsIsolated: true, noProductionReaders: true, networkAttempts, realModelRequests: 0, errors, cases, captures,
      windowsRoot, packagedArchive: packagedArchive ? { ...packagedArchive, sha256After: archiveAfter, unchanged: archiveAfter === packagedArchive.sha256 } : null };
    fs.writeFileSync(path.join(output, 'chat-recovery-ui-report.json'), JSON.stringify(value, null, 2) + '\n');
    if (packagedArchive) assert.equal(archiveAfter, packagedArchive.sha256, 'Candidate archive remains unchanged.');
  }
  app.whenReady().then(async () => {
    for (const [base, platform] of [[windowsRoot, 'windows'], [path.join(root, 'macos'), 'macos']]) for (const language of ['zh-CN', 'en']) await check(base, platform, language);
    assert.equal(networkAttempts, 0); assert.deepEqual(errors, []); phase = 'complete'; report(true);
    console.log(JSON.stringify({ ok: true, version, cases: cases.length, screenshots: captures.length, networkAttempts, realModelRequests: 0 })); app.exit(0);
  }).catch(error => { report(false, error); console.error(error.stack); app.exit(1); });
}
