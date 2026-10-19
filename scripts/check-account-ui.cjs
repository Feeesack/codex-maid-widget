'use strict';
// Run with Electron. All account and quota data are fixtures; no auth reader,
// control endpoint, OS notification or real sound is created by this harness.
const {app, BrowserWindow, ipcMain} = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const root = path.join(__dirname, '..');
const runtimeRoot = path.resolve(process.env.CODEX_MAID_RUNTIME_ROOT || root);
const taskHome = fs.mkdtempSync(path.join(os.tmpdir(), 'maid-account-ui-'));
app.setPath('userData', taskHome);
process.env.CODEX_MAID_HOME = taskHome;
process.env.CODEX_HOME = path.join(taskHome, 'codex');
fs.mkdirSync(process.env.CODEX_HOME);
if (process.env.GITHUB_ACTIONS === 'true') app.disableHardwareAcceleration();
const {sanitize, widgetDimensions} = require(path.join(runtimeRoot, 'src/settings.cjs'));
const screenshots = process.env.CODEX_MAID_SCREENSHOTS || path.join(root, 'tmp/account-ui-check');
const now = Math.floor(Date.now() / 1000);
let settings = sanitize({mode:'accounts',sound:false,autoHideSeconds:0}), settingsRevision = 1;
const fixtureProfileNickname = '虚构昵称 <img src=x>', fixtureDisplayName = 'not_the_nickname', fixtureWorkspaceName = '星河研发工作空间（仅供隔离测试的长名称）';
const fixturePersonalLabel = `${fixtureProfileNickname} · 个人`, fixtureWorkspaceLabel = `${fixtureProfileNickname} · ${fixtureWorkspaceName}`;
let accounts = [
  {id:'fixture-personal-pro',label:fixturePersonalLabel,autoLabel:fixturePersonalLabel,labelSource:'nickname',userEdited:false,profileNickname:fixtureProfileNickname,displayName:fixtureDisplayName,email:'personal.fixture@example.invalid',workspaceName:null,planType:'pro',planLabel:'Pro',scopeLabel:'个人',current:true,resetsAt:now+9000,observedAt:now-30,remainingPercent:27},
  {id:'fixture-workspace-team',label:fixtureWorkspaceLabel,autoLabel:fixtureWorkspaceLabel,labelSource:'nickname',userEdited:false,profileNickname:fixtureProfileNickname,displayName:'@not_a_profile_nickname',email:'workspace.fixture@example.invalid',workspaceName:fixtureWorkspaceName,planType:'team',planLabel:'Team',scopeLabel:'工作空间',current:false,resetsAt:now+600,observedAt:now-90,remainingPercent:3},
  {id:'fixture-expired',label:'账号 3',planType:'plus',planLabel:'Plus',scopeLabel:'个人',current:false,resetsAt:now-60,observedAt:now-1000,remainingPercent:null},
  {id:'fixture-unknown',label:'unread.fixture@example.invalid',autoLabel:'unread.fixture@example.invalid',labelSource:'email',userEdited:false,profileNickname:null,displayName:'@not_a_profile_nickname',email:'unread.fixture@example.invalid',planType:null,planLabel:'未知套餐',scopeLabel:'未知范围',current:false,resetsAt:null,observedAt:null,remainingPercent:null},
];
let mainWindow, settingsWindow, listCalls = 0, refreshCalls = 0, renameCalls = 0, removeCalls = 0, phase = 'startup';
let delayedList, shouldDelayList = false;
const snapshot = require(path.join(runtimeRoot, 'src/demo.cjs'))();
function accountSnapshot() { return structuredClone({accounts,count:accounts.length}); }
function state() {
  return {version:'fixture',settings,settingsRevision,snapshot,demo:true,accountManagement:accountSnapshot(),activeCharacterId:'lilac-dragon',characterName:'紫晶龙女仆',
    characterUrl:pathToFileURL(path.join(runtimeRoot, 'assets/characters/lilac-dragon.png')).href,characters:[]};
}
function publish() { for (const window of [mainWindow, settingsWindow]) if (window && !window.isDestroyed()) window.webContents.send('state',state()); }
ipcMain.handle('state', () => state());
ipcMain.handle('settings', (_event, patch) => { settings = sanitize({...settings,...patch}); settingsRevision++; publish(); return state(); });
ipcMain.handle('refresh', () => { refreshCalls++; publish(); return snapshot; });
ipcMain.handle('list-accounts', () => {
  listCalls++;
  if (shouldDelayList) return new Promise(resolve => { delayedList = resolve; });
  return accountSnapshot();
});
ipcMain.handle('rename-account', (_event, id, label) => {
  renameCalls++; accounts = accounts.map(account => account.id === id ? {...account,label:label || account.autoLabel,labelSource:label ? 'manual' : account.profileNickname ? 'nickname' : 'fallback',userEdited:!!label} : account); publish(); return accountSnapshot();
});
ipcMain.handle('remove-account', (_event, id) => { removeCalls++; accounts = accounts.filter(account => account.id !== id); publish(); return accountSnapshot(); });
for (const channel of ['drag-start','drag-move','drag-end','pointer-region']) ipcMain.on(channel, () => {});
ipcMain.handle('action', () => {});
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function evaluate(source, window = mainWindow) { return window.webContents.executeJavaScript(source, true); }
async function until(callback, timeout = 10000) { const end = Date.now()+timeout; while (Date.now()<end) { if (await callback()) return; await pause(25); } throw Error('Fixture UI did not reach expected state'); }
async function capture(name) {
  phase = 'capture ' + name;
  fs.mkdirSync(screenshots,{recursive:true});
  await evaluate(`reveal(); for (const element of document.querySelectorAll('*')) for (const animation of element.getAnimations()) if (animation instanceof CSSTransition) animation.finish();`);
  mainWindow.webContents.invalidate(); await pause(200);
  await mainWindow.webContents.capturePage(); await pause(40);
  fs.writeFileSync(path.join(screenshots,name),(await mainWindow.webContents.capturePage()).toPNG());
}
async function checkAccountAlarmAnimation() {
  phase = 'one-second four-bounce account alarm';
  const timing = await evaluate(`(()=>{clearBounce();accountAlarmBounce();
    window.alarmCharacter=$('character').getAnimations().find(animation=>animation.animationName==='accountAlarmCharacter');
    window.alarmBubble=$('bubble-motion').getAnimations().find(animation=>animation.animationName==='accountAlarmBubble');
    const animations=[alarmCharacter,alarmBubble];const timing=animations.map(animation=>{const t=animation.effect.getTiming();return {duration:t.duration,iterations:t.iterations,endTime:animation.effect.getComputedTiming().endTime};});
    for(const animation of animations) animation.pause();
    const toolbar=document.querySelector('.toolbar');const before=toolbar.getBoundingClientRect().toJSON();
    const samples=[120,360,600,840].map(time=>{for(const animation of animations)animation.currentTime=time;return {iteration:alarmCharacter.effect.getComputedTiming().currentIteration,character:getComputedStyle($('character')).transform,bubble:getComputedStyle($('bubble-motion')).transform,toolbar:toolbar.getBoundingClientRect().toJSON()};});
    const boundaries=[0,240,480,720,960].map(time=>{for(const animation of animations)animation.currentTime=time;return [$('character'),$('bubble-motion')].map(element=>{const transform=getComputedStyle(element).transform;const matrix=new DOMMatrix(transform==='none'?undefined:transform);return {x:matrix.e,y:matrix.f,scaleX:matrix.a,scaleY:matrix.d};});});
    return {timing,samples,boundaries,before,toolbarAnimations:toolbar.getAnimations().length};})()`);
  assert.deepEqual(timing.timing,[{duration:240,iterations:4,endTime:960},{duration:240,iterations:4,endTime:960}]);
  assert.ok(timing.timing.every(effect=>effect.endTime<=1000),'four-bounce effects finish within one second');
  assert.deepEqual(timing.samples.map(sample=>sample.iteration),[0,1,2,3]);
  assert.ok(timing.samples.every(sample=>sample.character===timing.samples[0].character && sample.bubble===timing.samples[0].bubble),'each 240 ms cycle repeats the same synchronized pose');
  assert.ok(timing.samples.every(sample=>JSON.stringify(sample.toolbar)===JSON.stringify(timing.before)));
  assert.ok(timing.boundaries.every(pair=>pair.every(pose=>pose.x===0&&pose.y===0&&pose.scaleX===1&&pose.scaleY===1)),'every 240 ms boundary returns to the original pose');
  assert.equal(timing.toolbarAnimations,0);
  const restarted = await evaluate(`(()=>{const previous=alarmCharacter;accountAlarmBounce();const next=$('character').getAnimations().find(animation=>animation.animationName==='accountAlarmCharacter');return {replaced:previous!==next,oldState:previous.playState,time:next.currentTime};})()`);
  assert.equal(restarted.replaced,true); assert.equal(restarted.oldState,'idle'); assert.ok(restarted.time===null||restarted.time<20,'reentry starts from the first bounce');
  // Let the actual production CSS animation run to its real end, without
  // calling finish() or synthesizing animationend.
  const completed = await evaluate(`new Promise(resolve=>{const node=$('character'),start=performance.now();const done=event=>{if(event.target!==node||event.animationName!=='accountAlarmCharacter')return;node.removeEventListener('animationend',done);resolve({elapsed:performance.now()-start,character:getComputedStyle(node).transform,bubble:getComputedStyle($('bubble-motion')).transform,classes:[$('character'),$('bubble-motion')].some(element=>element.classList.contains('account-alarm-bounce'))});};node.addEventListener('animationend',done);accountAlarmBounce();setTimeout(()=>{node.removeEventListener('animationend',done);resolve({timeout:true});},2500);})`);
  assert.equal(completed.timeout,undefined); assert.ok(completed.elapsed>=900 && completed.elapsed<1800);
  assert.equal(completed.character,'none'); assert.equal(completed.bubble,'none'); assert.equal(completed.classes,false);
  await evaluate(`accountAlarmBounce();current.visualPose={moving:true,offset:{x:0,y:0}};applyVisualPose();accountAlarmBounce();`);
  assert.equal(await evaluate(`[$('character'),$('bubble-motion')].every(element=>!element.classList.contains('account-alarm-bounce')&&element.getAnimations().length===0)`),true,'moving interrupts and blocks the account animation');
  await evaluate(`delete current.visualPose;applyVisualPose();accountAlarmBounce();`);
  await mainWindow.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
  mainWindow.webContents.invalidate(); await mainWindow.webContents.capturePage(); await pause(50);
  await until(()=>evaluate(`motionPreference.matches && [$('character'),$('bubble-motion')].every(element=>!element.classList.contains('account-alarm-bounce'))`));
  await evaluate(`accountAlarmBounce()`);
  assert.equal(await evaluate(`[$('character'),$('bubble-motion')].every(element=>!element.classList.contains('account-alarm-bounce')&&element.getAnimations().length===0)`),true,'reduced motion interrupts and blocks the account animation');
  await mainWindow.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
  mainWindow.webContents.invalidate(); await mainWindow.webContents.capturePage(); await pause(50);
  await until(()=>evaluate(`!motionPreference.matches`));
  const normal = await evaluate(`(()=>{pressInteraction(false);const style=getComputedStyle($('character')),properties=style.transitionProperty.split(',').map(value=>value.trim()),durations=style.transitionDuration.split(',').map(value=>parseFloat(value)*1000),index=properties.indexOf('transform');releaseInteraction(false);return {duration:durations[index%durations.length],keyframes:$('character').getAnimations().filter(animation=>animation instanceof CSSAnimation).length,held:$('character').classList.contains('interaction-pressed')};})()`);
  assert.deepEqual(normal,{duration:220,keyframes:0,held:false},'ordinary input releases immediately through a 220 ms transform transition');
  return {durationMs:240,iterations:4,totalMs:960,actualElapsedMs:completed.elapsed,toolbarFixed:true,reentryRestarts:true,movingStops:true,reducedMotionStops:true};
}
const watchdog = setTimeout(() => { console.error('Account fixture UI verification timed out.'); app.exit(1); }, 90000);
app.whenReady().then(async () => {
  try {
    mainWindow = new BrowserWindow({...widgetDimensions(),show:false,frame:false,transparent:true,backgroundColor:'#00000000',webPreferences:{preload:path.join(runtimeRoot,'src/preload.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false,offscreen:true,backgroundThrottling:false}});
    await mainWindow.loadFile(path.join(runtimeRoot,'src/index.html'));
    mainWindow.webContents.debugger.attach('1.3');
    await mainWindow.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
    await until(() => evaluate(`typeof current==='object' && current!==null && document.querySelectorAll('.account-card').length===4 && $('maid-image').naturalWidth>0`));
    await evaluate(`Date.now=()=>${now * 1000}; updateAccountTimers(); window.soundAttempts=0; window.AudioContext=class {constructor(){window.soundAttempts++;throw Error('fixture prevents real sound');}};void 0;`);
    assert.equal(listCalls,0,'default account page uses supplied local state without another IPC/data query');
    const initial = await evaluate(`({sandbox:typeof require==='undefined'&&typeof process==='undefined',mode,toolbar:document.querySelectorAll('.toolbar button').length,names:[...document.querySelectorAll('.account-name')].map(el=>el.textContent),plans:[...document.querySelectorAll('.account-plan')].map(el=>el.textContent),progress:[...document.querySelectorAll('.account-track')].map(el=>el.getAttribute('aria-valuenow')),times:[...document.querySelectorAll('.account-countdown')].map(el=>el.textContent),scrollable:$('account-list').scrollHeight>$('account-list').clientHeight})`);
    assert.equal(initial.sandbox,true); assert.equal(initial.mode,'accounts'); assert.equal(initial.toolbar,4);
    assert.deepEqual(initial.plans,['Pro · 个人',`Team · 工作空间 · ${fixtureWorkspaceName}`,'Plus · 个人','未知套餐 · 未知范围']);
    assert.equal(initial.names[0],fixturePersonalLabel); assert.equal(initial.names[1],fixtureWorkspaceLabel);
    assert.equal(initial.names[3],'昵称未读取');
    assert.ok(initial.names.every(name=>!name.includes('@')&&!name.includes(fixtureDisplayName)),'email, handle and account name never become a nickname');
    const identityLayout = await evaluate(`({names:[...document.querySelectorAll('.account-name')].map(element=>({title:element.title,truncated:element.scrollWidth>element.clientWidth,ellipsis:getComputedStyle(element).textOverflow})),workspaceTitle:document.querySelectorAll('.account-plan')[1].title,unsafeImages:document.querySelectorAll('.account-card img').length})`);
    assert.ok(identityLayout.names[0].title.includes(`资料昵称：${fixtureProfileNickname}`) && identityLayout.names[0].title.includes(`账户资料名称：${fixtureDisplayName}`) && identityLayout.names[0].title.includes('personal.fixture@example.invalid'));
    assert.ok(identityLayout.names[1].title.includes('workspace.fixture@example.invalid') && identityLayout.workspaceTitle.includes(fixtureWorkspaceName));
    assert.equal(identityLayout.names[0].truncated,true); assert.equal(identityLayout.names[1].truncated,true);
    assert.equal(identityLayout.names[0].ellipsis,'ellipsis'); assert.equal(identityLayout.unsafeImages,0);
    assert.deepEqual(initial.progress,['50','97','100',null]);
    assert.match(initial.times[0],/02:30:00/); assert.match(initial.times[1],/00:10:00/);
    assert.equal(initial.times[2],'预计已重置，待登录确认'); assert.match(initial.times[3],/未知/); assert.equal(initial.scrollable,true);
    mainWindow.webContents.invalidate(); await pause(600);
    await capture('accounts-native-personal.png');
    await evaluate(`$('account-list').scrollTop=document.querySelectorAll('.account-card')[1].offsetTop-document.querySelector('.account-card').offsetTop;`);
    await capture('accounts-native-workspace.png');
    await evaluate(`$('account-list').scrollTop=0;document.querySelector('.account-actions button').click();window.editRef=document.querySelector('.account-editor input');editRef.value='正在编辑';editRef.setSelectionRange(2,3);`);
    publish(); await pause(60);
    assert.deepEqual(await evaluate(`({same:window.editRef===document.querySelector('.account-editor input'),value:editRef.value,start:editRef.selectionStart,end:editRef.selectionEnd,focused:document.activeElement===editRef})`),{same:true,value:'正在编辑',start:2,end:3,focused:true});
    await evaluate(`editRef.value='主力 <img src=x>';editRef.closest('form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));`);
    await until(() => renameCalls===1);
    await until(() => evaluate(`document.querySelector('.account-name').textContent==='主力 <img src=x>' && document.querySelector('.account-editor').hidden`));
    assert.equal(await evaluate(`document.querySelectorAll('.account-card img').length`),0,'alias must remain plain text');
    accounts[0].displayName = '刷新后的虚构用户名'; publish(); await pause(40);
    assert.equal(await evaluate(`document.querySelector('.account-name').textContent`),'主力 <img src=x>','metadata refresh preserves manual alias');
    await evaluate(`document.querySelector('.account-actions button').click()`);
    assert.equal(await evaluate(`document.querySelector('.account-editor input').value`),'主力 <img src=x>');
    assert.match(await evaluate(`document.querySelector('.account-editor-hint').textContent`),/清空.*自动/);
    await evaluate(`const input=document.querySelector('.account-editor input');input.value='   ';input.closest('form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));`);
    await until(() => renameCalls===2);
    await until(() => evaluate(`document.querySelector('.account-name').textContent===${JSON.stringify(fixturePersonalLabel)} && document.querySelector('.account-editor').hidden`));
    assert.equal(accounts[0].userEdited,false); assert.equal(accounts[0].labelSource,'nickname');
    // An old list reply must not restore a stale name after a new state snapshot.
    shouldDelayList = true;
    await evaluate(`void refreshAccounts()`); await until(() => !!delayedList);
    const oldSnapshot = accountSnapshot(); accounts[0] = {...accounts[0],label:'最新别名',labelSource:'manual',userEdited:true}; publish(); await pause(40);
    delayedList(oldSnapshot); shouldDelayList = false; await pause(60);
    assert.equal(await evaluate(`document.querySelector('.account-name').textContent`),'最新别名');
    await evaluate(`document.querySelectorAll('.account-card')[3].querySelector('.account-actions button').click()`);
    assert.equal(await evaluate(`document.querySelectorAll('.account-editor input')[3].placeholder`),'昵称未读取');
    await evaluate(`{const input=document.querySelectorAll('.account-editor input')[3];input.value='';input.closest('form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));}`);
    await until(() => renameCalls===3);
    await until(() => evaluate(`document.querySelectorAll('.account-editor')[3].hidden`));
    assert.equal(await evaluate(`document.querySelectorAll('.account-name')[3].textContent`),'昵称未读取','restoring an unread nickname must not restore an old email-derived label');
    await evaluate(`$('account-list').scrollTop=0`);
    const beforeTick = listCalls;
    await evaluate(`Date.now=()=>${(now + 1) * 1000};updateAccountTimers()`); await pause(1100);
    assert.equal(listCalls,beforeTick,'per-second countdown must use the local clock, not IPC');
    assert.match(await evaluate(`document.querySelector('.account-countdown').textContent`),/02:29:59/);
    // Account reset events only update the widget; no OS notification is used.
    mainWindow.webContents.send('account-reset',{id:'fixture-workspace-team',label:'账号 2',resetsAt:now+600});
    await until(() => evaluate(`!$('notice').hidden && $('notice').textContent.includes('预计已重置')`));
    assert.equal(await evaluate(`window.soundAttempts`),0);
    await evaluate(`$('notice').textContent='dedupe-marker'`);
    mainWindow.webContents.send('account-reset',{id:'fixture-workspace-team',label:'账号 2',resetsAt:now+600});
    await pause(40); assert.equal(await evaluate(`$('notice').textContent`),'dedupe-marker');
    mainWindow.webContents.send('account-reset',{id:'fixture-expired',label:'账号 3',resetsAt:now-60});
    await pause(40); assert.equal(await evaluate(`window.soundAttempts`),0,'global sound mute covers account alarm sound');
    settings = sanitize({...settings,sound:true}); publish(); await pause(40);
    mainWindow.webContents.send('account-reset',{id:'fixture-unknown',label:'账号 4',resetsAt:now+18000});
    await until(() => evaluate(`window.soundAttempts===1`));
    await pause(1100); assert.equal(await evaluate(`window.soundAttempts`),1,'four bounces play only one sound');
    settings = sanitize({...settings,sound:false}); publish(); await pause(40);
    const alarmAnimation = await checkAccountAlarmAnimation();
    // Removal is explicit, leaves no account credentials changed, and explains re-recording.
    await evaluate(`document.querySelectorAll('.account-actions button')[1].click()`);
    assert.equal(removeCalls,0); assert.match(await evaluate(`document.querySelector('.account-confirm').textContent`),/下次登录会再次记录/);
    await evaluate(`document.querySelector('.account-confirm button').click()`); await until(() => removeCalls===1);
    await until(() => evaluate(`document.querySelectorAll('.account-card').length===3`));
    for (const mirror of [false,true]) for (const scale of [0.6,1,1.6]) {
      mainWindow.setSize(...Object.values(widgetDimensions(scale)));
      await pause(80);
      await evaluate(`$('widget').classList.toggle('is-mirrored',${mirror}); fit(); $('account-list').scrollTop=0;`);
      const layout = await evaluate(`(()=>{const list=$('account-list'),view=$('accounts-view').getBoundingClientRect(),footer=document.querySelector('.bubble footer').getBoundingClientRect();return {horizontal:list.scrollWidth<=list.clientWidth,footer:view.bottom<=footer.top+1,font:parseFloat(getComputedStyle(document.querySelector('.account-countdown')).fontSize),outline:document.querySelector('.bubble-outline').getAttribute('viewBox'),phraseOverflow:getComputedStyle($('phrase')).overflow};})()`);
      assert.equal(layout.horizontal,true,`account list has no sideways overflow (${scale},${mirror})`); assert.equal(layout.footer,true);
      assert.ok(layout.font>=16); assert.equal(layout.outline,'0 0 354 246'); assert.equal(layout.phraseOverflow,'visible');
    }
    mainWindow.setSize(...Object.values(widgetDimensions(1.6))); await pause(100); await evaluate(`$('widget').classList.remove('is-mirrored');fit();`);
    await capture('accounts-large-workspace.png');
    settingsWindow = new BrowserWindow({show:false,webPreferences:{preload:path.join(runtimeRoot,'src/preload.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false}});
    await settingsWindow.loadFile(path.join(runtimeRoot,'src/settings.html'));
    await until(() => evaluate(`document.getElementById('accountResetAlerts').checked===true`,settingsWindow));
    assert.equal(await evaluate(`document.querySelector('#mode option[value="accounts"]').textContent.includes('账号管理')`,settingsWindow),true);
    await evaluate(`$('accountResetAlerts').checked=false;$('accountResetAlerts').dispatchEvent(new Event('change',{bubbles:true}));`,settingsWindow);
    await until(() => settings.accountResetAlerts===false);
    const accountNaming = {automaticLabelsVisible:true,profileNicknameOnly:true,emailAndHandleNotNicknames:true,missingNicknameExplicit:true,metadataTitlesComplete:true,longLabelsEllipsized:true,manualAliasesPreserved:true,emptyAliasRestoresAutomatic:true,emptyAliasWithoutNicknameStaysUnknown:true,htmlRenderedAsText:true};
    const result = {ok:true,runtimeRoot,alarmAnimation,accountNaming,checks:['sandboxed preload IPC','independent Pro personal and Team workspace rows','genuine profile nickname labels and complete metadata titles','email and handle never substitute for a nickname','unread nickname explicitly unknown','long labels ellipsized','manual aliases preserved and empty alias restores automatic name','cycle progress and countdown','expired/unknown state','alias editing and plain text','state/list race guard','local-only ticking','deduplicated four-bounce widget alarm','single muted sound','explicit removal','scale/mirror layout','alert settings'],fixturesOnly:true,realNotifications:false,realSound:false};
    fs.writeFileSync(path.join(screenshots,'account-ui-check.json'),JSON.stringify(result,null,2));
    console.log('PASS: isolated actual account UI, Pro/Team scopes, timers, safe alias editor/removal, late replies, local ticking, deduplicated muted alarms, scale/mirror layout and settings.');
  } finally {
    clearTimeout(watchdog);
    settingsWindow?.destroy(); mainWindow?.destroy();
    // Chromium can retain its isolated cache lock until the Electron process
    // exits on Windows. A leftover temporary fixture must not hide a test error.
    try { fs.rmSync(taskHome,{recursive:true,force:true}); } catch {}
  }
}).then(() => app.quit()).catch(error => { console.error('Account UI check failed during ' + phase); console.error(error);app.exit(1); });
