'use strict';
// Real Chromium settings renderer and sandboxed preload, fixture IPC only.
// Never imports the production main, profile/data-home helpers or audio engine.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const runtimeRoot = path.resolve(process.env.CODEX_MAID_RUNTIME_ROOT || root);
const output = path.resolve(process.env.CODEX_MAID_SCREENSHOTS || path.join(root, 'tmp/sound-settings-ui-check'));
const taskHome = fs.mkdtempSync(path.join(os.tmpdir(), 'maid-sound-settings-ui-'));
for (const name of ['codex', 'maid', 'appdata', 'localappdata', 'temp', 'userdata', 'session']) fs.mkdirSync(path.join(taskHome, name));
process.env.CODEX_HOME = path.join(taskHome, 'codex'); process.env.CODEX_MAID_HOME = path.join(taskHome, 'maid');
process.env.HOME = process.env.USERPROFILE = taskHome; process.env.APPDATA = path.join(taskHome, 'appdata');
process.env.LOCALAPPDATA = path.join(taskHome, 'localappdata'); process.env.TEMP = process.env.TMP = path.join(taskHome, 'temp');
const { app, BrowserWindow, ipcMain } = require('electron');
app.setPath('userData', path.join(taskHome, 'userdata')); app.setPath('sessionData', path.join(taskHome, 'session'));
if (process.env.GITHUB_ACTIONS === 'true') app.disableHardwareAcceleration();
const { sanitize } = require(path.join(runtimeRoot, 'src/settings.cjs'));
const soundCatalog = require(path.join(runtimeRoot, 'src/interaction-sound-catalog.js'));
const snapshot = require(path.join(runtimeRoot, 'src/demo.cjs'))();
const fixtureSettingsFile = path.join(taskHome, 'maid', 'settings.json');
let settings = sanitize({ sound: true }), revision = 1, win, phase = 'startup', networkAttempts = 0, nativeWindowShown = false;
let saveMode = 'normal', releaseSave = null, savePending = false;
let appearanceDiagnostics = null;
let unreadyCompositorFrames = 0;
let windowContainment = { supported: true, enabled: false, reason: 'disabled', topmost: { desired: true, verified: true, reason: 'verified' } };
const errors = [], patches = [], actions = [];
fs.writeFileSync(fixtureSettingsFile, JSON.stringify(settings));
function state() {
  return { version: 'isolated-sound-settings-fixture', settings, settingsRevision: revision, snapshot, demo: true,
    characters: [], activeCharacterId: 'lilac-dragon', characterName: '隔离测试形象', characterUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1kAAAAASUVORK5CYII=',
    followSupported: false, platform: process.platform, windowContainment };
}
function publish() { win.webContents.send('state', state()); }
ipcMain.handle('state', () => state());
ipcMain.handle('settings', async (_event, patch) => {
  patches.push(JSON.parse(JSON.stringify(patch)));
  if (saveMode === 'fail-once') { saveMode = 'normal'; throw new Error('Isolated fixture save rejected'); }
  if (saveMode === 'mismatch-once') { saveMode = 'normal'; return state(); }
  if (saveMode === 'hold') {
    savePending = true;
    await new Promise(resolve => { releaseSave = resolve; });
    savePending = false; releaseSave = null; saveMode = 'normal';
  }
  settings = sanitize({ ...settings, ...patch }); revision++;
  fs.writeFileSync(fixtureSettingsFile, JSON.stringify(settings));
  publish(); return state();
});
ipcMain.handle('action', (_event, name) => { assert.equal(name, 'bounce'); actions.push(name); });
ipcMain.handle('refresh', () => snapshot);
// All remaining settings-page capabilities return inert, synthetic responses.
ipcMain.handle('import-characters', () => ({ state: state(), importedCount: 0, existingCount: 0, errors: [] }));
for (const name of ['select-character', 'rename-character', 'remove-character']) ipcMain.handle(name, () => state());
for (const name of ['list-accounts', 'rename-account', 'remove-account']) ipcMain.handle(name, () => ({ accounts: [], count: 0 }));
ipcMain.handle('list-conversations', () => ({ conversations: [] }));
ipcMain.handle('select-conversation', () => ({})); ipcMain.handle('inspect-conversation', () => ({}));
const evaluate = code => win.webContents.executeJavaScript(code, true);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(condition, timeout = 5000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    // This never-shown offscreen page has no native paint loop. MediaQueryList
    // .matches can update before Chromium dispatches its frame-bound change
    // event; request a real compositor frame instead of synthesizing the event.
    win.webContents.invalidate();
    try { await win.webContents.capturePage(); }
    catch (error) {
      if (error?.message !== 'UnknownVizError') throw error;
      // A newly navigated offscreen surface may not have its first frame yet.
      // Retry within the same bounded timeout; never accept the condition until
      // Chromium has actually produced a frame.
      unreadyCompositorFrames++; await pause(20); continue;
    }
    if (await condition()) return;
    await pause(20);
  }
  throw new Error('Fixture condition timed out');
}
async function key(name) {
  const spec = { ArrowDown: { code: 'ArrowDown', value: 40 }, Tab: { code: 'Tab', value: 9 }, Enter: { code: 'Enter', value: 13 } }[name];
  for (const type of ['keyDown', 'keyUp']) await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {
    type, key: name, code: spec.code, windowsVirtualKeyCode: spec.value, nativeVirtualKeyCode: spec.value,
    ...(name === 'Enter' && type === 'keyDown' ? { text: '\r', unmodifiedText: '\r' } : {}),
  });
}
async function click(id) {
  await evaluate(`document.getElementById(${JSON.stringify(id)}).scrollIntoView({block:'center'});void 0`);
  win.webContents.invalidate(); await win.webContents.capturePage(); await pause(25);
  const point = await evaluate(`(()=>{const r=document.getElementById(${JSON.stringify(id)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
  for (const [type, buttons] of [['mouseMoved', 0], ['mousePressed', 1], ['mouseReleased', 0]]) {
    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, ...point, button: type === 'mouseMoved' ? 'none' : 'left', buttons, clickCount: type === 'mouseMoved' ? 0 : 1 });
  }
}
async function choose(id) {
  await evaluate(`(()=>{const select=document.getElementById('interactionSound');select.value=${JSON.stringify(id)};select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
}
async function appearanceUi() {
  const value = await evaluate(`(()=>{return {
    animationOptionAbsent:!document.getElementById('animationMode')&&!document.getElementById('animation-mode-note'),
    systemReduced:matchMedia('(prefers-reduced-motion: reduce)').matches,
    topmostNote:document.getElementById('topmost-note').textContent,topmostDisabled:document.getElementById('alwaysOnTop').disabled,
    contained:document.getElementById('stayInCodexWindow').checked};})()`);
  appearanceDiagnostics = { ...value, legacyAnimationSettingPresent:Object.hasOwn(settings,'animationMode'), saveMode, savePending };
  return value;
}
const mediaMotion = reduced => win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: reduced ? 'reduce' : 'no-preference' }] });
async function ui() {
  return evaluate(`(()=>{const select=document.getElementById('interactionSound'),preview=document.getElementById('preview-interaction-sound'),feedback=document.getElementById('interaction-sound-feedback');return {
    id:select.value,options:[...select.options].map(option=>({id:option.value,label:option.textContent,disabled:option.disabled})),description:document.getElementById('interaction-sound-description').textContent,
    selectDisabled:select.disabled,previewDisabled:preview.disabled,muted:!document.getElementById('sound').checked,
    feedback:feedback.textContent,feedbackHidden:feedback.hidden,feedbackError:feedback.classList.contains('has-error'),focused:document.activeElement?.id,
    sandbox:typeof process==='undefined'&&typeof require==='undefined',loadedAudioSamples:[...document.scripts].some(script=>/(^|\\/)(interaction-samples|interaction-audio)\\.js(?:[?#]|$)/.test(script.src)),
    installedLocalSoundIds:Object.keys(window.MaidLocalInteractionSamples?.presets||{})};})()`);
}
async function ready() { await until(async () => (await ui()).options.length === soundCatalog.presets.length && await evaluate(`typeof current==='object'&&current!==null`)); }
async function saved(id) { await until(async () => settings.interactionSound === id && !(await ui()).selectDisabled); }
function fail(error) {
  try { fs.mkdirSync(output, { recursive: true }); fs.writeFileSync(path.join(output, 'sound-settings-ui-failure.json'), JSON.stringify({ ok: false, phase, error: String(error?.message || error), errors, appearanceDiagnostics, unreadyCompositorFrames }, null, 2)); } catch {}
  console.error('Isolated sound settings UI check failed at ' + phase + ': ' + String(error?.message || error)); app.exit(1);
}
process.on('uncaughtException', fail); process.on('unhandledRejection', fail);
const watchdog = setTimeout(() => fail(new Error('Watchdog timeout')), 90000);
app.whenReady().then(async () => {
  try {
    fs.mkdirSync(output, { recursive: true });
    win = new BrowserWindow({ width: 620, height: 840, show: false, webPreferences: { preload: path.join(runtimeRoot, 'src/preload.cjs'),
      sandbox: true, contextIsolation: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false, partition: 'sound-settings-ui-isolated-' + Date.now() } });
    win.on('show', () => { nativeWindowShown = true; win.hide(); });
    win.webContents.setAudioMuted(true);
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_request, done) => { networkAttempts++; done({ cancel: true }); });
    win.webContents.on('console-message', (_event, details) => { if (details.level === 'error') errors.push(details.message); });
    win.webContents.on('preload-error', (_event, _path, error) => errors.push(String(error.message)));
    await win.loadFile(path.join(runtimeRoot, 'src/settings.html')); win.webContents.debugger.attach('1.3'); await ready();
    const initial = await ui(); assert.equal(initial.sandbox, true); assert.equal(initial.loadedAudioSamples, false);
    assert.deepEqual(initial.options, soundCatalog.presets.map(({id,label,separateBank}) => ({id,label,disabled:!!separateBank && !initial.installedLocalSoundIds.includes(id)})));
    assert.equal(initial.id, soundCatalog.defaultId); assert.equal(initial.options[0].id, soundCatalog.defaultId);
    assert.equal(initial.options.find(option => option.id === 'original').label, '经典啾啾');
    assert.ok(initial.description.length > 0); assert.equal(initial.previewDisabled, false); assert.equal(actions.length, 0);
    phase = 'all available descriptions without autoplay';
    for (const option of initial.options.filter(option => !option.disabled)) {
      await choose(option.id); await saved(option.id);
      assert.ok((await ui()).description.length > 0, option.id + ' has a rendered description');
      assert.equal(actions.length, 0); assert.equal(settings.sound, true);
    }
    await choose('soft-spring'); await saved('soft-spring');
    phase = 'keyboard selection and persistence across reload';
    await evaluate(`document.getElementById('interactionSound').scrollIntoView({block:'center'});document.getElementById('interactionSound').focus();void 0`);
    assert.equal((await ui()).focused, 'interactionSound'); await key('ArrowDown'); await saved('original');
    assert.equal((await ui()).id, 'original'); assert.match((await ui()).description, /最初|原|保留/); assert.equal(actions.length, 0, 'selection must not autoplay');
    assert.equal(JSON.parse(fs.readFileSync(fixtureSettingsFile, 'utf8')).interactionSound, 'original');
    settings = sanitize(JSON.parse(fs.readFileSync(fixtureSettingsFile, 'utf8'))); revision++;
    await win.loadFile(path.join(runtimeRoot, 'src/settings.html')); await ready(); assert.equal((await ui()).id, 'original');
    phase = 'pointer preview activation after reload';
    await click('preview-interaction-sound'); await until(() => actions.length === 1); await until(async () => !(await ui()).previewDisabled);
    assert.deepEqual(actions, ['bounce'], 'one pointer activation dispatches exactly one bounce');
    phase = 'keyboard Tab/Enter preview activation';
    await evaluate(`document.getElementById('interactionSound').focus();void 0`); await key('Tab');
    assert.equal((await ui()).focused, 'preview-interaction-sound'); await key('Enter'); await until(() => actions.length === 2);
    await until(async () => !(await ui()).previewDisabled); assert.deepEqual(actions, ['bounce', 'bounce'], 'one Enter activation dispatches exactly one bounce');
    phase = 'pending save prevents stale preview';
    saveMode = 'hold'; await choose('wood-tap'); await until(() => savePending);
    assert.equal((await ui()).selectDisabled, true); assert.equal((await ui()).previewDisabled, true);
    await click('preview-interaction-sound'); await pause(60); assert.equal(actions.length, 2);
    assert.equal(settings.interactionSound, 'original'); releaseSave(); await saved('wood-tap');
    phase = 'mute remains effective while selecting and reloading';
    await click('sound'); await until(async () => settings.sound === false && !(await ui()).selectDisabled);
    assert.equal((await ui()).previewDisabled, true); await click('preview-interaction-sound'); await pause(60); assert.equal(actions.length, 2);
    await choose('original'); await saved('original'); assert.equal(settings.sound, false); assert.equal((await ui()).muted, true);
    assert.equal(JSON.parse(fs.readFileSync(fixtureSettingsFile, 'utf8')).sound, false);
    settings = sanitize(JSON.parse(fs.readFileSync(fixtureSettingsFile, 'utf8'))); revision++;
    await win.loadFile(path.join(runtimeRoot, 'src/settings.html')); await ready();
    assert.equal((await ui()).id, 'original'); assert.equal((await ui()).muted, true); assert.equal((await ui()).previewDisabled, true);
    phase = 'save failure feedback, rollback and retry';
    saveMode = 'fail-once'; await choose('bubble-pop'); await until(async () => (await ui()).feedbackError && !(await ui()).selectDisabled);
    const failed = await ui(); assert.equal(failed.id, 'original'); assert.equal(failed.previewDisabled, true); assert.equal(failed.feedbackHidden, false); assert.match(failed.feedback, /未能保存/);
    assert.equal(settings.interactionSound, 'original'); assert.equal(settings.sound, false);
    await click('preview-interaction-sound'); await pause(60); assert.equal(actions.length, 2);
    await choose('original'); await saved('original'); await click('sound'); await until(async () => settings.sound === true && !(await ui()).previewDisabled);
    const dshAvailable = initial.installedLocalSoundIds.includes('dsh-original');
    let expectedPreviewActions = 2;
    if (dshAvailable) {
      phase = 'installed DSH choice and preview';
      await choose('dsh-original'); await saved('dsh-original');
      assert.equal((await ui()).previewDisabled, false); assert.equal(settings.sound, true);
      await click('preview-interaction-sound'); expectedPreviewActions++;
      await until(() => actions.length === expectedPreviewActions); await until(async () => !(await ui()).previewDisabled);
    } else {
      assert.equal(initial.options.find(option => option.id === 'dsh-original').disabled, true);
    }
    phase = 'removed animation option and ignored legacy storage';
    assert.equal((await appearanceUi()).animationOptionAbsent,true,'animation has no setting or explanatory selector');
    const soundPreferences = { sound: settings.sound, interactionSound: settings.interactionSound };
    const otherPreferences = { scale: settings.scale, position: settings.position, activeCharacterId: settings.activeCharacterId, phrases: settings.phrases };
    const legacyAnimationSettingsMatrix = [];
    const savesBeforeMediaChange = patches.length;
    for (const systemReduced of [false, true]) for (const legacyValue of ['system', 'full', 'reduced']) {
      await mediaMotion(systemReduced);
      fs.writeFileSync(fixtureSettingsFile,JSON.stringify({...settings,animationMode:legacyValue}));
      const persisted = sanitize(JSON.parse(fs.readFileSync(fixtureSettingsFile, 'utf8')));
      assert.equal(Object.hasOwn(persisted,'animationMode'),false,'legacy animation preference is ignored');
      assert.deepEqual({sound:persisted.sound,interactionSound:persisted.interactionSound}, soundPreferences, 'legacy animation values preserve sound and mute');
      assert.deepEqual({scale:persisted.scale,position:persisted.position,activeCharacterId:persisted.activeCharacterId,phrases:persisted.phrases}, otherPreferences, 'legacy animation values preserve appearance and custom preferences');
      settings = persisted; revision++;
      await win.loadFile(path.join(runtimeRoot, 'src/settings.html')); await ready();
      await until(async () => (await appearanceUi()).systemReduced === systemReduced);
      const restored = await appearanceUi();
      assert.equal(restored.animationOptionAbsent,true);assert.equal(restored.systemReduced,systemReduced);
      assert.equal((await ui()).id, soundPreferences.interactionSound); assert.equal((await ui()).muted, !soundPreferences.sound);
      legacyAnimationSettingsMatrix.push({legacyValue,systemReduced,ignoredOnRead:true,animationOptionAbsent:true,soundAndOtherPreferencesPreserved:true});
    }
    phase = 'system motion changes leave settings and mute independent';
    await mediaMotion(false); await until(async () => !(await appearanceUi()).systemReduced);
    await mediaMotion(true); await until(async () => (await appearanceUi()).systemReduced);
    assert.equal(patches.length, savesBeforeMediaChange, 'system preference changes do not rewrite settings');
    await click('sound');await until(async () => settings.sound===false&&(await ui()).muted);
    for(const systemReduced of [false,true]){
      await mediaMotion(systemReduced);await until(async () => (await appearanceUi()).systemReduced===systemReduced);
      assert.equal((await ui()).previewDisabled,true);await click('preview-interaction-sound');await pause(40);
      assert.equal(actions.length,expectedPreviewActions,'system motion settings cannot bypass mute');
    }
    await click('sound');await until(async () => settings.sound===true&&!(await ui()).previewDisabled);
    phase = 'topmost native status and contained mode explanation';
    const topmostStates = [
      [{desired:true,verified:false,reason:'pending'}, /正在应用置顶设置/],
      [{desired:true,verified:true,reason:'verified'}, /已启用置顶/],
      [{desired:false,verified:true,reason:'verified'}, /已关闭置顶/],
      [{desired:true,verified:false,reason:'topmost-unavailable'}, /暂时无法确认置顶状态.*重新显示挂件重试/],
    ];
    for (const [topmost, expected] of topmostStates) {
      windowContainment = {...windowContainment,topmost}; publish();
      await until(async () => expected.test((await appearanceUi()).topmostNote));
      assert.equal((await appearanceUi()).topmostDisabled, false, 'native confirmation remains distinct from the editable preference');
    }
    await click('stayInCodexWindow'); await until(async () => {const value = await appearanceUi();return settings.stayInCodexWindow && value.contained && value.topmostDisabled && /窗口内模式不使用全局置顶/.test(value.topmostNote);});
    assert.match((await appearanceUi()).topmostNote, /窗口内模式不使用全局置顶/); assert.equal((await appearanceUi()).topmostDisabled, true);
    await click('stayInCodexWindow'); await until(async () => {const value = await appearanceUi();return !settings.stayInCodexWindow && !value.contained && !value.topmostDisabled && /暂时无法确认置顶状态/.test(value.topmostNote);});
    assert.match((await appearanceUi()).topmostNote, /暂时无法确认置顶状态/); assert.equal((await appearanceUi()).topmostDisabled, false);
    windowContainment = {...windowContainment,topmost:{desired:true,verified:true,reason:'verified'}}; publish();
    await until(async () => /已启用置顶/.test((await appearanceUi()).topmostNote));
    await evaluate(`document.getElementById('alwaysOnTop').scrollIntoView({block:'center'});document.getElementById('alwaysOnTop').focus();void 0`);
    win.webContents.invalidate(); await pause(80); fs.writeFileSync(path.join(output, 'topmost-settings-ui.png'), (await win.webContents.capturePage()).toPNG());
    phase = 'capture and report';
    await evaluate(`document.getElementById('interactionSound').scrollIntoView({block:'center'});document.getElementById('interactionSound').focus();void 0`);
    win.webContents.invalidate(); await pause(80); fs.writeFileSync(path.join(output, 'sound-settings-ui.png'), (await win.webContents.capturePage()).toPNG());
    assert.deepEqual(errors, []); assert.equal(networkAttempts, 0); assert.equal(nativeWindowShown, false); assert.equal(actions.length, expectedPreviewActions);
    const report = { ok: true, runtimeRoot, presetCount: initial.options.length, presets: initial.options, defaultBubbleFirst: true, originalSelectable: true,
      installedLocalSoundIds: initial.installedLocalSoundIds, localDshAvailable: dshAvailable, localDshSelectionAndPreview: dshAvailable ? true : 'not-verified-not-installed',
      descriptionsPresent: true, mockSettingsPersistedAndReloaded: true, pointerPreviewExactlyOnce: true, keyboardSelectionAndTabEnterPreview: true,
      pendingSaveBlocksPreview: true, muteRetainedDuringChoiceAndReload: true, mutedPreviewBlocked: true, failedSaveRolledBackWithFeedback: true, retryWorks: true,
      animationSelectorRemoved:true, animationOptionAbsent:true, legacyAnimationSettingsIgnored:true, legacyAnimationSettingsMatrix,
      systemMotionDoesNotRewriteSettings:true,systemMotionDoesNotBypassMute:true,animationRemovalPreservesSoundAndOtherPreferences:true,
      topmostNativeStatusExplanations: topmostStates.map(([status]) => status), containedModeDisablesGlobalTopmost: true,
      previewActions: actions.length, settingsSaveAttempts: patches.length, fixturesOnly: true, isolatedDataDependencies: true, productionSettingsRenderer: true,
      sandboxedPreload: true, loadedPublicAudioBank: false, privateAudioPayloadLoaded: dshAvailable, networkRequestsBlocked: true, networkAttempts, fixtureNativeWindowShown: nativeWindowShown,
      realMainStarted: false, realUserSettingsRead: false, realAuthenticationRead: false, realWidgetInteracted: false, realSoundPlayed: false };
    fs.writeFileSync(path.join(output, 'sound-settings-ui-check.json'), JSON.stringify(report, null, 2) + '\n');
    fs.rmSync(path.join(output, 'sound-settings-ui-failure.json'), { force: true });
    console.log('PASS: isolated Chromium sound settings, ' + initial.options.length + ' presets (' + initial.options.filter(option => !option.disabled).length + ' available), persistence/reload, pointer/keyboard preview, save-inflight guard, mute, failure rollback and retry; local DSH ' + (dshAvailable ? 'selection/preview passed.' : 'not installed, not verified.'));
    clearTimeout(watchdog); win.destroy(); win = null; app.quit();
  } catch (error) { fail(error); }
});
