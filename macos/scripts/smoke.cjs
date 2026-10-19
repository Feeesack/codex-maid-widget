'use strict';
require('./stdio-errors.cjs').installOutputErrorHandlers();
// Exercise the real sandboxed renderer/preload at the shipped size and both orientations.
const { app, BrowserWindow, ipcMain, nativeImage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { sanitize, widgetDimensions, cornerPeekOffset } = require('../src/settings.cjs');
const { CharacterLibrary } = require('../src/character-library.cjs');
const { checkBubbleSortUi } = require('./bubble-sort-ui.cjs');
const { captureOffscreenFrame } = require('./offscreen-frame.cjs');
const root=path.join(__dirname,'..');
let smokePhase = 'starting Electron';
const smokeWatchdog = setTimeout(() => { console.error('UI smoke timed out during: ' + smokePhase); app.exit(1); }, 180000);
const markPhase = value => { smokePhase = value; console.log('CHECK: ' + value); };
const screenshotDirectory = process.env.CODEX_MAID_SCREENSHOTS || path.join(root, 'docs', 'screenshots');
const testHome=fs.mkdtempSync(path.join(os.tmpdir(),'maid-gallery-ui-'));
for(const name of ['codex','maid','appdata','localappdata','temp'])fs.mkdirSync(path.join(testHome,name));
process.env.CODEX_HOME=path.join(testHome,'codex');process.env.CODEX_MAID_HOME=path.join(testHome,'maid');
process.env.HOME=process.env.USERPROFILE=testHome;process.env.APPDATA=path.join(testHome,'appdata');
process.env.LOCALAPPDATA=path.join(testHome,'localappdata');process.env.TEMP=process.env.TMP=path.join(testHome,'temp');
app.setPath('userData',testHome);
const library=new CharacterLibrary({dataDir:testHome,assetRoot:path.join(root,'assets')});
let settings=sanitize({sound:false}), win, refreshes=0;
let settingsRevision=0, settingsWriteAttempts=0, settingsDeliveryPlans=[], settingsDeliveries=[], settingsReplies=[];
let inspections=0, inspectionDelay=0, inspectionFailure=false, inspectionResult, inspectionsAfterChecks=0;
let conversationLists=0, conversationListsAfterChecks=0, conversationSelections=[];
let selectedConversation='fixture-one', conversationListFailure=false;
let conversationSelectionMode='manual', conversationSelectionRevision=0;
let inspectionTargetOverrides={};
let conversationThreads=[{id:'fixture-one',title:'修复按钮布局',workspaceLabel:'fixture-workspace'},{id:'fixture-two',title:'<img src=x> 对话标题',workspaceLabel:'fixture-workspace'},{id:'fixture-same-a',title:'同名对话',workspaceLabel:'project-a'},{id:'fixture-same-b',title:'同名对话',workspaceLabel:'project-b'}];
let cornerDock={corner:null,peeking:false},visualPose;
let peekPreview=null,peekPreviewWindow=null,peekPreviewRequests=0;
let appearancePreview=null,appearancePreviewRequests=0;
function applyFixtureAppearance(){if(peekPreviewWindow){const effective={...settings,...appearancePreview},size=widgetDimensions(effective.scale);peekPreviewWindow.setSize(size.width,size.height);peekPreviewWindow.setOpacity(effective.opacity);}}
const snapshot=require('../src/demo.cjs')();
const pause = ms => new Promise(resolve=>setTimeout(resolve,ms));
function state(){const characters=library.list();const active=library.get(settings.activeCharacterId)||library.get(library.defaultId);const dock=peekPreviewWindow?{corner:'right',peeking:settings.peekAtCorners}:cornerDock;const pose=peekPreviewWindow?{offset:cornerPeekOffset(dock.peeking?dock.corner:null,widgetDimensions(settings.scale),{...settings,...peekPreview}),moving:false}:visualPose;return {settings,settingsRevision,snapshot,cornerDock:dock,visualPose:pose,demo:true,version:require('../package.json').version,characters,activeCharacterId:active.id,characterUrl:active.url,characterName:active.name};}
async function publish(patch={}) { settings=sanitize({...settings,...patch});if(Object.keys(patch).length)settingsRevision++;applyFixtureAppearance();win.webContents.send('state',state());await pause(100); }
let firstStateRequest = true;
ipcMain.handle('state',async()=>{
  // Exercise a real IPC response that arrives later than the old one-second wait.
  if (firstStateRequest) { firstStateRequest = false; await pause(1250); }
  return state();
});
ipcMain.handle('settings',async(_event,patch)=>{
  settingsWriteAttempts++;
  const plan=settingsDeliveryPlans.shift()||{};
  if(plan.reject)throw new Error('isolated settings save unavailable');
  peekPreview=null;
  appearancePreview=null;
  settings=sanitize({...settings,...patch});settingsRevision++;
  applyFixtureAppearance();
  const value=structuredClone(state());
  const deliver=()=>{win.webContents.send('state',value);peekPreviewWindow?.webContents.send('state',value);settingsDeliveries.push({revision:value.settingsRevision,mode:value.settings.mode});};
  if(plan.broadcastDelay) setTimeout(deliver,plan.broadcastDelay);else deliver();
  if(plan.replyDelay) await pause(plan.replyDelay);
  settingsReplies.push(value.settingsRevision);
  return value;
});
ipcMain.handle('preview-corner-peek',(_event,patch)=>{
  if(patch!==null)assert.ok(patch&&Object.keys(patch).every(key=>['peekBottomPercent','peekSidePercent'].includes(key)&&Number.isInteger(patch[key])&&patch[key]>=0&&patch[key]<=200));
  peekPreview=patch;if(patch)peekPreviewRequests++;
  const value=state();peekPreviewWindow?.webContents.send('state',value);return value;
});
ipcMain.handle('refresh',()=>{refreshes++;return snapshot;});
ipcMain.handle('preview-appearance',(_event,patch)=>{if(patch!==null)assert.ok(patch&&Object.keys(patch).every(key=>['scale','opacity'].includes(key)&&typeof patch[key]==='number'&&Number.isFinite(patch[key])&&patch[key]>=(key==='scale'?.6:.35)&&patch[key]<=(key==='scale'?1.6:1)));appearancePreview=patch;if(patch)appearancePreviewRequests++;applyFixtureAppearance();return state();});
ipcMain.handle('list-conversations',()=>{
  conversationLists++;
  if(conversationListFailure) throw new Error('isolated conversation list unavailable');
  return {threads:conversationThreads,selectedId:selectedConversation,selectionMode:conversationSelectionMode};
});
ipcMain.handle('select-conversation',(_event,id)=>{
  if(id!==null&&!conversationThreads.some(thread=>thread.id===id)) throw new Error('isolated conversation selection missing');
  conversationSelections.push(id);
  conversationSelectionMode=id===null?'auto':'manual';conversationSelectionRevision++;
  if(id!==null)selectedConversation=id;
  return {selectedId:selectedConversation,selectionMode:conversationSelectionMode,selectionRevision:conversationSelectionRevision};
});
ipcMain.handle('inspect-conversation',async()=>{
  inspections++;
  const result={...inspectionResult,selectionMode:conversationSelectionMode,selectionRevision:conversationSelectionRevision,targetTitle:conversationSelectionMode==='auto'?'自动测试对话':conversationThreads.find(thread=>thread.id===selectedConversation)?.title,targetProject:conversationSelectionMode==='auto'?'automatic-project':conversationThreads.find(thread=>thread.id===selectedConversation)?.workspaceLabel,targetProjectDetail:conversationSelectionMode==='auto'?'automatic-team / automatic-project':'fixture-team / fixture-workspace',...inspectionTargetOverrides}, delay=inspectionDelay, fail=inspectionFailure;
  if(delay) await pause(delay);
  if(fail) throw new Error('isolated inspection fixture unavailable');
  return result;
});
ipcMain.handle('list-accounts',()=>({accounts:[]}));
ipcMain.handle('action',()=>{});
ipcMain.handle('select-character',(_event,id)=>{settings.activeCharacterId=id;win.webContents.send('state',state());return state();});
ipcMain.handle('rename-character',(_event,id,name)=>{library.rename(id,name);win.webContents.send('state',state());return state();});
ipcMain.handle('remove-character',(_event,id)=>{library.remove(id);if(settings.activeCharacterId===id)settings.activeCharacterId=library.defaultId;win.webContents.send('state',state());return state();});
ipcMain.handle('import-characters',()=>{const result=library.importFiles([path.join(screenshotDirectory,'widget-demo.png')]);win.webContents.send('state',state());return {state:state(),importedCount:result.imported.length,existingCount:result.existing.length,errors:result.errors};});
const evaluate = code => win.webContents.executeJavaScript(code).catch(error=>{throw new Error(`${error.message}\nRenderer expression: ${code}`);});
async function waitForInitialWidget(errors) {
  let observed, timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Initial widget was not ready within 10s: ${JSON.stringify({observed, errors})}`)), 10000);
  });
  try {
    return await Promise.race([timeout, (async () => {
      for (;;) {
        // Hidden offscreen surfaces may defer requestAnimationFrame until a paint
        // is requested. Observe the real preload/render path; never inject state.
        win.webContents.invalidate();
        observed = await evaluate(`({stateApplied:typeof current==='object'&&current!==null,value:document.getElementById('remaining').textContent,artLoaded:document.getElementById('maid-image').naturalWidth>0,demo:!document.getElementById('demo-label').hidden,secure:typeof process==='undefined'&&typeof require==='undefined',width:innerWidth,height:innerHeight,logoLoaded:document.querySelector('.brand-mark img').naturalWidth>0,primaryWidth:document.getElementById('primary-bar').style.width})`);
        assert.deepEqual(errors, [], 'initial renderer and preload must load without errors');
        if (observed.stateApplied && observed.value === '82' && observed.artLoaded && observed.logoLoaded && observed.demo) return observed;
        await pause(50);
      }
    })()]);
  } finally { clearTimeout(timer); }
}
async function rects() {
  return evaluate(`Object.fromEntries(['bubble','character','toolbar','dot-one','dot-two','notice','demo-label'].map(id=>{const el=document.getElementById(id)||document.querySelector('.'+id);const r=el.getBoundingClientRect();return [id,{x:r.x,y:r.y,width:r.width,height:r.height}]}))`);
}
async function readable() {
  return evaluate(`['.bubble header','#phrase','.toolbar button'].every(selector=>{for(let el=document.querySelector(selector);el;el=el.parentElement){const s=getComputedStyle(el);if(s.transform!=='none'&&new DOMMatrix(s.transform).a<0)return false;if(s.scale.startsWith('-'))return false;}return true;})`);
}
async function finishBubbleTransitions() {
  // Layout assertions compare resting geometry. Offscreen macOS surfaces can
  // defer their first transition frame until capturePage requests a paint.
  await evaluate(`(()=>{for(const id of ['bubble','bubble-content','dot-one','dot-two','toolbar']){const el=document.getElementById(id)||document.querySelector('.'+id);void el.offsetWidth;for(const animation of el.getAnimations())if(animation instanceof CSSTransition)animation.finish();}return document.getElementById('bubble').getBoundingClientRect().width;})()`);
}
async function waitForPressedTransform() {
  // A compositor's first painted frame can start a transition after a wall-clock
  // sleep has already elapsed. Observe natural completion; never finish/seek it.
  const deadline = Date.now() + 2500;
  let observed;
  do {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await captureOffscreenFrame(win, { timeoutMs: Math.min(remaining, 1000) });
    observed = await evaluate(`(()=>{const el=document.getElementById('character');return {scaleY:new DOMMatrix(getComputedStyle(el).transform).d,activeTransforms:el.getAnimations().filter(animation=>animation.playState!=='finished'&&animation.playState!=='idle'&&(animation instanceof CSSTransition?animation.transitionProperty==='transform':animation.effect.getKeyframes().some(frame=>'transform' in frame))).length};})()`);
    if (observed.activeTransforms === 0) return observed;
    await pause(16);
  } while (Date.now() < deadline);
  assert.fail('pressed transform must settle naturally within the bounded paint wait: ' + JSON.stringify(observed));
}
async function phraseLayout() {
  return evaluate(`(()=>{const el=document.getElementById('phrase'),r=el.getBoundingClientRect(),box=document.getElementById('phrase-view').getBoundingClientRect(),title=document.querySelector('#phrase-view .eyebrow').getBoundingClientRect(),heart=document.querySelector('.phrase-heart').getBoundingClientRect(),footer=document.querySelector('.bubble footer').getBoundingClientRect(),style=getComputedStyle(el),range=document.createRange();range.selectNodeContents(el);const text=range.getBoundingClientRect();return {text:el.textContent,fontSize:parseFloat(style.fontSize),overflow:style.overflow,scrollTop:el.scrollTop,fits:el.scrollHeight<=el.clientHeight+1&&el.scrollWidth<=el.clientWidth&&r.left>=box.left-1&&r.right<=box.right+1&&r.top>=title.bottom-1&&r.bottom<=heart.top+1&&heart.bottom<=box.bottom+1&&box.bottom<=footer.top+1&&text.left>=r.left-1&&text.right<=r.right+1&&text.top>=r.top-1&&text.bottom<=r.bottom+1};})()`);
}
async function checkNativePhraseSizing(defaultPhrases,longPhrases) {
  // The onscreen renderer uses different text metrics from offscreen rendering
  // on high-DPI Windows. A 1px natural-line overflow must not shrink a short line.
  const native=new BrowserWindow({...widgetDimensions(),frame:false,show:false,transparent:true,backgroundColor:'#00000000',skipTaskbar:true,webPreferences:{preload:path.join(root,'src','preload.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false}});
  try {
    await native.loadFile(path.join(root,'src','index.html'));await pause(100);
    await native.webContents.executeJavaScript(`setMode('phrase',false)`);
    for(const zoom of [1,1.25,1.5,2]) {
      native.webContents.setZoomFactor(zoom);
      for(const mirror of [false,true]) {
        for(const text of [...defaultPhrases,...longPhrases,defaultPhrases[0]]) {
          const layout=await native.webContents.executeJavaScript(`(()=>{$('widget').classList.toggle('is-mirrored',${mirror});$('phrase').textContent=${JSON.stringify(text)};fitPhraseText();const el=$('phrase'),style=getComputedStyle(el),range=document.createRange();range.selectNodeContents(el);const text=range.getBoundingClientRect(),box=$('phrase-view').getBoundingClientRect(),title=document.querySelector('#phrase-view .eyebrow').getBoundingClientRect(),heart=document.querySelector('.phrase-heart').getBoundingClientRect();return {fontSize:parseFloat(style.fontSize),overflow:style.overflow,fits:text.left>=box.left-1&&text.right<=box.right+1&&text.top>=title.bottom-1&&text.bottom<=heart.top+1&&heart.bottom<=box.bottom+1,actualText:el.textContent};})()`);
          assert.equal(layout.actualText,text);
          assert.equal(layout.overflow,'visible');
          assert.equal(layout.fits,true,`onscreen dialogue fits (${zoom},${mirror}): ${text}`);
          if(defaultPhrases.includes(text)) assert.equal(layout.fontSize,24,`onscreen short line must stay large (${zoom},${mirror}): ${text}`);
          else assert.ok(layout.fontSize>0&&layout.fontSize<24,'onscreen long lines still shrink');
        }
      }
    }
    if(process.env.CODEX_MAID_CAPTURE_NATIVE==='1') {
      native.webContents.setZoomFactor(1);
      await native.webContents.executeJavaScript(`$('widget').classList.remove('is-mirrored');$('phrase').textContent=${JSON.stringify(defaultPhrases[0])};fitPhraseText();reveal()`);
      native.showInactive();await pause(550);
      fs.mkdirSync(screenshotDirectory, { recursive: true });
      fs.writeFileSync(path.join(screenshotDirectory,'widget-dragon-tibo-native-demo.png'),(await native.webContents.capturePage()).toPNG());
    }
  } finally { native.webContents.setZoomFactor(1); native.destroy(); }
}
async function checkMirrorMotion() {
  const sample=()=>evaluate("(()=>{const image=document.getElementById('maid-image'),matrix=new DOMMatrix(getComputedStyle(image.parentElement).transform);return {m11:matrix.m11,is2D:matrix.is2D};})()");
  await publish({mirror:false});await pause(260);
  for(const mirrored of [true,false]) {
    settings=sanitize({...settings,mirror:mirrored});settingsRevision++;win.webContents.send('state',state());
    const frames=[];
    for(let attempt=0;attempt<40;attempt++) {
      await pause(16);const frame=await sample();frames.push(frame);
      if(frames.length>3&&Math.abs(frame.m11-(mirrored?-1:1))<.001)break;
    }
    assert.ok(frames.every(frame=>frame.is2D),'the shared animation uses a 2D matrix');
    assert.ok(frames.some(frame=>Math.abs(frame.m11)<.98),'direction change presents intermediate horizontal-scale frames');
    assert.ok(Math.abs(frames.at(-1).m11-(mirrored?-1:1))<.001,'direction change settles at the requested orientation');
  }
  await pause(80);
}
async function themeColors() {
  // A theme is assigned before its CSS color transition has presented the
  // final control background. Observe the real transitions without finishing
  // them or changing product styles before taking an exact palette snapshot.
  await evaluate(`(async()=>{
    const controls=[...document.querySelectorAll('.page-navigation button')];
    for(let attempt=0;attempt<4;attempt++){
      for(const control of controls)void getComputedStyle(control).backgroundColor;
      const pending=controls.flatMap(control=>control.getAnimations()).filter(animation=>
        ['background','background-color'].includes(animation.transitionProperty)&&['running','pending'].includes(animation.playState));
      if(!pending.length)return;
      await Promise.all(pending.map(animation=>animation.finished.catch(()=>{})));
    }
    throw new Error('Navigation background transitions did not settle');
  })()`);
  return evaluate(`({outline:getComputedStyle(document.querySelector('.bubble-outline path')).stroke,fill:getComputedStyle(document.querySelector('.bubble-outline stop:last-child')).stopColor,title:getComputedStyle(document.querySelector('.bubble header')).color,details:getComputedStyle(document.querySelector('.quota-details')).color,progress:getComputedStyle(document.getElementById('primary-bar')).backgroundImage,shimmer:getComputedStyle(document.querySelector('.quota-value')).backgroundImage,pill:getComputedStyle(document.getElementById('next-page')).backgroundColor})`);
}
async function waitForTheme(id, source) {
  for(let attempt=0;attempt<40;attempt++) {
    if(await evaluate(`document.getElementById('widget').dataset.themeCharacter===${JSON.stringify(id)}&&document.getElementById('widget').dataset.themeSource===${JSON.stringify(source)}`))return;
    await pause(50);
  }
  assert.fail(`theme should finish applying for ${id} (${source})`);
}
function assertPaletteChanged(before, after, reason) {
  for(const key of Object.keys(before))assert.notEqual(after[key],before[key],`${reason}: ${key} should follow the character theme`);
}
function syntheticPng(name, [red, green, blue]) {
  // Electron's bitmap input is BGRA. Real file decoding exercises the sandbox's
  // image-to-canvas theme path rather than injecting a palette into the renderer.
  const bitmap=Buffer.alloc(32*32*4);
  for(let i=0;i<bitmap.length;i+=4) {bitmap[i]=blue;bitmap[i+1]=green;bitmap[i+2]=red;bitmap[i+3]=255;}
  const file=path.join(testHome,name);
  fs.writeFileSync(file,nativeImage.createFromBitmap(bitmap,{width:32,height:32}).toPNG());
  return file;
}
async function checkConversationStatus(capture) {
  const originalSettings={...settings}, refreshesBefore=refreshes;
  const ready={status:'ready',context:{status:'ready',usedTokens:51200,windowTokens:200000,percent:25.6},git:{status:'ready',count:12},compaction:{status:'ready',count:4,complete:true},elapsedMs:8};
  const clickBubble = async () => {
    // Exercise the shipped pointer down/up refresh gesture, including hit
    // testing and pointer capture, without bypassing the renderer handler.
    const point=await evaluate(`(()=>{const r=document.getElementById('context-track').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mousePressed',...point,button:'left',clickCount:1});
    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseReleased',...point,button:'left',clickCount:1});
  };
  const click = async () => {
    if(await evaluate(`mode!=='conversation'`)) await evaluate(`setMode('conversation')`);
    else await clickBubble();
  };
  const waitForResult = async () => {
    for(let attempt=0;attempt<100;attempt++) {
      if(await evaluate(`document.getElementById('conversation-view').getAttribute('aria-busy')!=='true'`)) return;
      await pause(20);
    }
    assert.fail('passive conversation inspection should settle promptly');
  };
  const inspectView = () => evaluate(`({shown:!document.getElementById('conversation-view').hidden,label:document.getElementById('bubble-label').textContent,context:document.getElementById('context-progress').textContent,contextTitle:document.getElementById('context-progress').title,bar:document.getElementById('context-bar').style.width,value:document.getElementById('context-track').getAttribute('aria-valuenow'),git:document.getElementById('git-count').textContent,gitTitle:document.getElementById('git-count').title,compaction:document.getElementById('compaction-count').textContent,compactionTitle:document.getElementById('compaction-count').title,project:document.getElementById('conversation-project').textContent,projectTitle:document.getElementById('conversation-project').title,automaticLabel:document.querySelector('#conversation-select option[value="@auto"]').textContent,selectTitle:document.getElementById('conversation-select').title,feedback:document.getElementById('conversation-feedback').textContent,busy:document.getElementById('conversation-view').getAttribute('aria-busy')})`);
  assert.equal(inspections,0,'initial state, quota timers and ordinary updates must not inspect a conversation');
  assert.equal(conversationLists,0,'the conversation list is also strictly passive');
  await pause(1100);await publish();
  assert.equal(inspections,0,'waiting through a timer tick must not inspect a conversation');
  assert.equal(conversationLists,0,'waiting and state delivery must not list conversations');
  inspectionResult=ready;inspectionDelay=160;
  await evaluate(`document.getElementById('next-page').click()`);await pause(20);
  let view=await inspectView();
  assert.equal(view.shown,true);assert.equal(view.label,'所选对话');assert.equal(view.feedback,'读取中…');
  assert.equal(settings.mode,'conversation','the first cycle after quota selects and saves the second conversation page');
  assert.equal(view.busy,'true','page entry shows its loading state immediately');
  assert.equal(view.compaction,'--','compaction counts share the immediate loading state');
  assert.equal(view.project,'项目：读取中…');assert.equal(view.projectTitle,'');assert.equal(view.automaticLabel,'自动识别当前对话');
  await click();await pause(30);
  assert.equal(inspections,1,'repeated clicks while loading must not overlap IPC reads');
  assert.equal(conversationLists,1,'entering the second page lists conversations only once');
  await waitForResult();
  view=await inspectView();
  assert.equal(view.context,'25.6%');assert.equal(view.contextTitle,'51,200 / 200,000 tokens');
  assert.equal(view.bar,'25.6%');assert.equal(view.value,'25.6');
  assert.equal(view.git,'12');assert.equal(view.gitTitle,'12 个未提交文件');assert.equal(view.busy,'false');
  assert.equal(view.feedback,'点击气泡刷新');
  assert.equal(view.compaction,'4 次');assert.equal(view.compactionTitle,'当前对话本地记录；自动与手动压缩合计');
  assert.equal(view.project,'项目：fixture-workspace');assert.equal(view.projectTitle,'fixture-workspace\nfixture-team / fixture-workspace');
  assert.deepEqual(await evaluate(`['fixture-same-a','fixture-same-b'].map(id=>document.querySelector('#conversation-select option[value="'+id+'"]').textContent)`),['同名对话 · project-a','同名对话 · project-b'],'every manual option includes its project to distinguish matching conversation names');
  assert.equal(await evaluate(`document.getElementById('conversation-select').value`),'fixture-one','the remembered selection is shown before inspecting');
  assert.deepEqual(conversationSelections,[],'opening a remembered selection does not rewrite it');
  for(const scale of [0.6,1,1.6]) {
    const size=widgetDimensions(scale);win.setSize(size.width,size.height);await pause(40);
    for(const mirror of [false,true]) {
      await publish({mirror});
      assert.equal(await readable(),true,'conversation content remains readable in both orientations');
      assert.equal(await evaluate(`(()=>{const box=document.getElementById('conversation-view').getBoundingClientRect(),footer=document.querySelector('.bubble footer').getBoundingClientRect();return [...document.querySelectorAll('#conversation-select,#conversation-project,#conversation-view strong,#conversation-view .conversation-feedback')].every(el=>{const r=el.getBoundingClientRect();return r.left>=box.left-1&&r.right<=box.right+1&&r.top>=box.top-1&&r.bottom<=box.bottom+1;})&&box.bottom<=footer.top+1;})()`),true,'conversation selector, project and metrics fit at every supported scale and orientation');
    }
  }
  const shipped=widgetDimensions();win.setSize(shipped.width,shipped.height);await publish({mirror:false});
  await capture('widget-conversation-status-fixture.png');
  await evaluate(`document.getElementById('refresh').click()`);await pause(80);await publish();
  assert.equal(inspections,1,'quota refresh and state delivery must not trigger another conversation read');
  assert.equal(conversationLists,1,'quota refresh and state delivery must not list conversations');
  assert.equal((await inspectView()).shown,true,'ordinary state delivery must preserve the conversation page');
  assert.equal(refreshes,refreshesBefore+1,'the original quota refresh still works');
  inspectionDelay=0;inspectionResult={...ready,context:{status:'ready',usedTokens:0,windowTokens:200000,percent:0},git:{status:'ready',count:0},compaction:{status:'ready',count:0,complete:true}};
  await click();await waitForResult();
  view=await inspectView();assert.equal(view.context,'0%');assert.equal(view.git,'0');assert.equal(view.value,'0');
  assert.equal(inspections,2,'clicking the conversation bubble after completion refreshes its inspection');
  assert.equal(view.compaction,'0 次','a fully scanned empty history is an exact zero');
  inspectionResult={...ready,compaction:{status:'ready',count:3,complete:false}};
  await click();await waitForResult();view=await inspectView();
  assert.equal(view.compaction,'≥3 次');
  assert.equal(view.compactionTitle,'当前对话本地记录；自动与手动压缩合计\n已发现至少3次，历史记录尚未统计完，点击继续读取');
  inspectionResult={...ready,compaction:{status:'ready',count:2,complete:false,incompleteReason:'legacy-records'}};
  await click();await waitForResult();view=await inspectView();
  assert.equal(view.compaction,'≥2 次');
  assert.equal(view.compactionTitle,'当前对话本地记录；自动与手动压缩合计\n部分旧记录无法确认，仅显示已确认次数','ambiguous legacy records must not promise more counts after rescanning');
  inspectionResult={...ready,compaction:{status:'unavailable'}};
  await click();await waitForResult();assert.equal((await inspectView()).compaction,'暂无数据','an unavailable scan must not imply zero compressions');
  for(const git of [{status:'not-repository'},{status:'timeout'}]) {
    inspectionResult={...ready,git};await click();await waitForResult();view=await inspectView();
    assert.equal(view.context,'25.6%');
    assert.equal(view.git,git.status==='not-repository'?'非 Git 工作区':'读取超时');
  }
  inspectionResult={status:'unavailable',reason:'fixture-private-path',context:{status:'unavailable',reason:'fixture-private-path'},git:{status:'unavailable',reason:'fixture-private-path'}};
  await click();await waitForResult();view=await inspectView();
  assert.equal(view.context,'暂无数据');assert.equal(view.git,'暂无数据');assert.equal(view.bar,'0%');assert.equal(view.value,null);assert.equal(view.contextTitle,'');
  assert.equal(await evaluate(`document.getElementById('conversation-view').textContent.includes('fixture-private-path')`),false,'backend diagnostics must not appear in the user-facing bubble');
  inspectionResult={status:'ready',context:{status:'ready'},git:{status:'ready'}};
  await click();await waitForResult();view=await inspectView();assert.equal(view.context,'暂无数据');assert.equal(view.git,'暂无数据');
  inspectionFailure=true;await click();await waitForResult();view=await inspectView();assert.equal(view.context,'暂无数据');assert.equal(view.git,'暂无数据');
  inspectionFailure=false;inspectionResult=ready;inspectionDelay=160;
  await click();
  await evaluate(`document.getElementById('next-page').click()`);await pause(30);
  assert.equal(settings.mode,'accounts','the next page after conversation is accounts even during inspection');
  await waitForResult();await pause(180);
  assert.equal((await inspectView()).shown,false,'a late reply must not navigate back to the conversation page');
  assert.equal(await evaluate(`!document.getElementById('accounts-view').hidden`),true);
  inspectionDelay=0;await click();await waitForResult();assert.equal((await inspectView()).context,'25.6%','a fresh click recovers after late or failed replies');
  const beforeReentry=inspections;
  inspectionDelay=160;inspectionResult=ready;
  await click();await pause(20);
  assert.equal(inspections,beforeReentry+1,'a refresh starts before rapid navigation');
  await evaluate(`document.getElementById('next-page').click()`);await pause(20);
  assert.equal(settings.mode,'accounts');
  inspectionDelay=300;inspectionResult={...ready,context:{status:'ready',usedTokens:60000,windowTokens:200000,percent:30},git:{status:'ready',count:3},compaction:{status:'ready',count:7,complete:false}};
  await evaluate(`setMode('conversation')`);await pause(180);
  view=await inspectView();
  assert.equal(view.shown,true);assert.equal(view.busy,'true','an older request finishing cannot clear the new page loading state');
  assert.equal(view.context,'--','an older request cannot replace a newer pending result');
  assert.equal(view.compaction,'--','an older compaction result cannot clear a newer request loading state');
  await waitForResult();view=await inspectView();
  assert.equal(inspections,beforeReentry+2,'returning to the second page starts a new read while an older reply is still pending');
  assert.equal(view.context,'30%');assert.equal(view.git,'3');assert.equal(view.busy,'false');
  assert.equal(view.compaction,'≥7 次','compaction counts follow the same generation as the other metrics');
  inspectionDelay=0;inspectionResult=ready;
  const beforeSameTick=inspections, revisionBeforeSameTick=settingsRevision, deliveriesBeforeSameTick=settingsDeliveries.length;
  settingsDeliveryPlans.push({broadcastDelay:180,replyDelay:120},{broadcastDelay:0,replyDelay:0});
  await evaluate(`setMode('today');setMode('conversation')`);
  await waitForResult();await pause(220);
  view=await inspectView();
  assert.equal(settings.mode,'conversation');assert.equal(view.shown,true);assert.equal(view.context,'25.6%');assert.equal(view.busy,'false');
  assert.equal(inspections,beforeSameTick+1,'two same-tick navigation actions inspect only the explicit conversation entry');
  assert.deepEqual(settingsDeliveries.slice(deliveriesBeforeSameTick).map(delivery=>delivery.revision),[revisionBeforeSameTick+2,revisionBeforeSameTick+1],'the stale intermediate state broadcast really arrives after the latest one');
  assert.ok(settingsReplies.includes(revisionBeforeSameTick+1),'the older settings reply also completes before the final assertion');
  assert.equal(await evaluate(`mode`),'conversation','a late intermediate navigation broadcast cannot change the final page');
  const beforeTransition=inspections, revisionBeforeTransition=settingsRevision, deliveriesBeforeTransition=settingsDeliveries.length;
  settingsDeliveryPlans.push({broadcastDelay:100,replyDelay:120},{broadcastDelay:10,replyDelay:0});
  inspectionDelay=260;
  await evaluate(`setMode('week');setMode('conversation')`);await pause(160);
  view=await inspectView();
  assert.equal(view.shown,true);assert.equal(view.busy,'true','an intermediate mode reply cannot cancel a newer pending inspection');
  assert.equal(view.context,'--');
  assert.deepEqual(settingsDeliveries.slice(deliveriesBeforeTransition).map(delivery=>delivery.revision),[revisionBeforeTransition+2,revisionBeforeTransition+1],'the delayed intermediate mode broadcast was delivered while inspection was pending');
  assert.ok(settingsReplies.includes(revisionBeforeTransition+1),'the delayed old invoke reply also arrived while the latest inspection was pending');
  await waitForResult();view=await inspectView();
  assert.equal(view.shown,true);assert.equal(view.context,'25.6%');assert.equal(view.busy,'false');
  assert.equal(inspections,beforeTransition+1,'stale settings replies neither restart nor silently clear an explicit inspection');
  assert.equal(await evaluate(`mode`),'conversation');
  assert.equal(settingsDeliveryPlans.length,0);
  inspectionDelay=0;
  await publish({mode:'phrase'});await click();await waitForResult();
  await evaluate(`document.getElementById('talk').click()`);await pause(50);
  assert.equal((await inspectView()).shown,false,'talk returns from conversation to the phrase page');
  assert.equal(await evaluate(`!document.getElementById('phrase-view').hidden`),true);
  const beforeSelection=inspections;
  selectedConversation=null;
  await click();await waitForResult();view=await inspectView();
  assert.equal(inspections,beforeSelection,'first use without a selected conversation must not read context or Git');
  assert.equal(view.feedback,'请选择要查看的对话');
  assert.equal(await evaluate(`document.getElementById('conversation-select').value`),'');
  assert.equal(await evaluate(`document.querySelector('#conversation-select option[value="fixture-two"]').textContent`),'<img src=x> 对话标题 · fixture-workspace','titles and projects render as plain text');
  assert.equal(await evaluate(`document.querySelector('#conversation-select img')===null`),true);
  const listsBeforeSelection=conversationLists;
  await evaluate(`document.getElementById('conversation-select').value='fixture-two';document.getElementById('conversation-select').dispatchEvent(new Event('change'))`);
  await waitForResult();
  assert.equal(inspections,beforeSelection+1,'choosing a conversation immediately reads its status');
  assert.equal(conversationLists,listsBeforeSelection,'selection uses the existing list without a second list read');
  assert.deepEqual(conversationSelections,['fixture-two']);assert.equal(selectedConversation,'fixture-two');
  await click();await waitForResult();
  assert.equal(inspections,beforeSelection+2);assert.equal(conversationLists,listsBeforeSelection+1);
  assert.equal(await evaluate(`document.getElementById('conversation-select').value`),'fixture-two','the next click restores the backend remembered selection');
  assert.deepEqual(conversationSelections,['fixture-two'],'refreshing preserves the remembered selection');
  const savedThreads=conversationThreads, beforeEmpty=inspections;
  conversationThreads=[];selectedConversation=null;
  await click();await waitForResult();view=await inspectView();
  assert.equal(inspections,beforeEmpty,'an empty conversation list must not inspect');
  assert.equal(view.feedback,'暂无本地对话');
  assert.equal(await evaluate(`document.getElementById('conversation-select').disabled`),false,'automatic selection remains available even without local list entries');
  conversationListFailure=true;
  await click();await waitForResult();
  assert.equal(inspections,beforeEmpty,'list errors must not inspect a stale conversation');
  assert.equal((await inspectView()).context,'暂无数据');
  conversationListFailure=false;conversationThreads=savedThreads;selectedConversation='fixture-two';
  await click();await waitForResult();assert.equal((await inspectView()).context,'25.6%','a fresh click recovers from an empty or unavailable list');
  const chooseConversation = async value => {
    await evaluate(`document.getElementById('conversation-select').value=${JSON.stringify(value)};document.getElementById('conversation-select').dispatchEvent(new Event('change'))`);
    await waitForResult();
  };
  const beforeAuto=inspections;
  await chooseConversation('@auto');view=await inspectView();
  assert.equal(conversationSelections.at(-1),null,'the automatic option sends null rather than a fabricated thread ID');
  assert.equal(conversationSelectionMode,'auto');assert.equal(selectedConversation,'fixture-two','switching to automatic mode preserves the remembered manual conversation');
  assert.equal(inspections,beforeAuto+1);assert.equal(view.label,'当前对话');assert.equal(view.context,'25.6%');
  assert.equal(await evaluate(`document.getElementById('conversation-select').value`),'@auto');
  assert.equal(await evaluate(`document.getElementById('conversation-select').options[0].textContent`),'自动识别当前对话（自动测试对话）');
  assert.equal(view.project,'项目：automatic-project');assert.match(view.projectTitle,/automatic-team/);
  assert.match(await evaluate(`document.getElementById('conversation-select').title`),/自动测试对话/);
  const selectionsBeforeAutoRestore=conversationSelections.length;
  await evaluate(`setMode('quota')`);await click();await waitForResult();view=await inspectView();
  assert.equal(view.label,'当前对话');
  assert.equal(await evaluate(`document.getElementById('conversation-select').value`),'@auto','automatic mode takes priority over an older remembered manual ID');
  assert.equal(conversationSelections.length,selectionsBeforeAutoRestore,'restoring automatic mode never rewrites the saved preference');
  const beforeOlderTarget=inspections, selectionsBeforeOlderTarget=conversationSelections.length, rememberedBeforeOlderTarget=selectedConversation;
  const originalRecentChoices=conversationThreads;
  conversationThreads=originalRecentChoices.slice(0,3);
  inspectionTargetOverrides={targetTitle:'列表之外的旧对话',targetProject:'older-project',targetProjectDetail:'older-team / older-project'};
  await click();await waitForResult();view=await inspectView();
  assert.equal(inspections,beforeOlderTarget+1,'automatic inspection must resolve a target outside the three recent choices');
  assert.equal(view.label,'当前对话');assert.equal(view.automaticLabel,'自动识别当前对话（列表之外的旧对话）');
  assert.equal(view.project,'项目：older-project');assert.equal(view.context,'25.6%');
  assert.equal(await evaluate(`[...document.getElementById('conversation-select').options].filter(option=>option.value&&option.value!=='@auto').length`),3,'resolving an older automatic target must not expand the manual recent-choice list');
  assert.equal(await evaluate(`document.getElementById('conversation-select').value`),'@auto');
  assert.equal(conversationSelections.length,selectionsBeforeOlderTarget,'automatic resolution must never write the older target as a manual choice');
  assert.equal(selectedConversation,rememberedBeforeOlderTarget,'the remembered manual target remains unchanged');
  conversationThreads=originalRecentChoices;inspectionTargetOverrides={};
  const longTargetTitle='<img src=x onerror=alert(1)> '+ '超长对话名称'.repeat(24);
  const longTargetProject='<b>项目</b> '+ '很长的项目名称'.repeat(24);
  inspectionTargetOverrides={targetTitle:longTargetTitle,targetProject:longTargetProject,targetProjectDetail:'team-two / selected-project'};
  await click();await waitForResult();view=await inspectView();
  assert.equal(view.label,'当前对话','long detected names never expand the main header');
  assert.equal(view.automaticLabel,'自动识别当前对话（'+longTargetTitle+'）');
  assert.equal(view.project,'项目：'+longTargetProject);assert.match(view.projectTitle,/team-two/);
  assert.ok(view.selectTitle.includes(longTargetTitle)&&view.selectTitle.includes(longTargetProject),'the tooltip preserves the complete title and project without truncating them');
  assert.equal(await evaluate(`document.querySelector('#conversation-select img,#conversation-project b')===null`),true,'automatically detected titles and project names are inserted only as text');
  for(const scale of [0.6,1,1.6]) {
    const size=widgetDimensions(scale);win.setSize(size.width,size.height);await pause(40);
    for(const mirror of [false,true]) {
      await publish({mirror});
      const projectLayout=await evaluate(`(()=>{const box=document.getElementById('conversation-view').getBoundingClientRect(),footer=document.querySelector('.bubble footer').getBoundingClientRect(),project=document.getElementById('conversation-project'),style=getComputedStyle(project);return {fits:[...document.querySelectorAll('#conversation-select,#conversation-project,#conversation-view strong,#conversation-feedback')].every(el=>{const r=el.getBoundingClientRect();return r.left>=box.left-1&&r.right<=box.right+1&&r.top>=box.top-1&&r.bottom<=box.bottom+1;})&&box.bottom<=footer.top+1,ellipsis:style.textOverflow,whitespace:style.whiteSpace,clipped:project.scrollWidth>project.clientWidth};})()`);
      assert.deepEqual(projectLayout,{fits:true,ellipsis:'ellipsis',whitespace:'nowrap',clipped:true},'long automatic names and project labels fit the unchanged bubble in both orientations and every scale');
    }
  }
  win.setSize(shipped.width,shipped.height);await publish({mirror:false});await capture('widget-conversation-project-long-fixture.png');
  inspectionTargetOverrides={targetTitle:'切换后的对话',targetProject:'next-project',targetProjectDetail:'team-three / next-project'};
  inspectionDelay=160;await click();view=await inspectView();
  assert.equal(view.project,'项目：读取中…');assert.equal(view.projectTitle,'');assert.equal(view.automaticLabel,'自动识别当前对话','a new request clears the previous name and project while loading');
  await waitForResult();view=await inspectView();
  assert.equal(view.automaticLabel,'自动识别当前对话（切换后的对话）');assert.equal(view.project,'项目：next-project');
  inspectionDelay=0;inspectionTargetOverrides={targetTitle:'没有本地项目的对话',targetProject:'',targetProjectDetail:''};
  await click();await waitForResult();assert.equal((await inspectView()).project,'项目：暂无本地项目','a resolved conversation without a local project is explicit');
  inspectionTargetOverrides={};
  inspectionResult={status:'unavailable',context:ready.context,git:ready.git,compaction:{status:'ready',count:99,complete:true},reason:'fixture-private-route'};
  await click();await waitForResult();view=await inspectView();
  assert.equal(view.label,'对话状态');assert.equal(view.context,'暂无数据');assert.equal(view.git,'暂无数据');assert.equal(view.bar,'0%');
  assert.equal(view.feedback,'未识别当前对话，可手动选择');
  assert.equal(view.compaction,'暂无数据','unknown automatic targets must hide even a ready compaction value');
  assert.equal(view.project,'项目：未识别');assert.equal(view.projectTitle,'');assert.equal(view.automaticLabel,'自动识别当前对话','unknown targets must clear the previous identified name and project');
  assert.equal(await evaluate(`document.getElementById('conversation-select').value`),'@auto','an unknown automatic source must not fall back to a recent manual conversation');
  conversationThreads=[];const beforeAutomaticEmpty=inspections;
  await click();await waitForResult();view=await inspectView();
  assert.equal(inspections,beforeAutomaticEmpty+1,'automatic inspection is attempted even when its target is outside the recent conversation list');
  assert.equal(view.feedback,'未识别当前对话，可手动选择');
  assert.equal(await evaluate(`document.getElementById('conversation-select').disabled`),false);
  inspectionResult=ready;
  await click();await waitForResult();view=await inspectView();assert.equal(view.label,'当前对话');assert.equal(view.context,'25.6%','a valid automatic target can be shown without any recent list entries');
  conversationThreads=savedThreads;
  await click();await waitForResult();
  await chooseConversation('fixture-two');view=await inspectView();
  assert.equal(conversationSelectionMode,'manual');assert.equal(view.label,'所选对话');
  assert.equal(await evaluate(`document.getElementById('conversation-select').selectedOptions[0].textContent`),'<img src=x> 对话标题 · fixture-workspace');
  await chooseConversation('@auto');assert.equal((await inspectView()).label,'当前对话','manual fallback can be switched back to automatic mode');
  const beforeAutoIdle=inspections, listsBeforeAutoIdle=conversationLists;
  await pause(1100);await publish();
  assert.equal(inspections,beforeAutoIdle);assert.equal(conversationLists,listsBeforeAutoIdle,'automatic mode does not add polling or state-triggered reads');
  const beforeModeSwitch=inspections;
  inspectionTargetOverrides={targetTitle:'旧自动识别对话',targetProject:'old-auto-project',targetProjectDetail:'old-team / old-auto-project'};
  inspectionDelay=180;inspectionResult={...ready,context:{status:'ready',usedTokens:110000,windowTokens:200000,percent:55},compaction:{status:'ready',count:55,complete:true}};
  await click();await pause(20);
  await evaluate(`setMode('today')`);await pause(20);
  conversationSelectionMode='manual';conversationSelectionRevision++;
  inspectionTargetOverrides={targetTitle:'<img src=x> 对话标题',targetProject:'new-manual-project',targetProjectDetail:'new-team / new-manual-project'};
  inspectionDelay=0;inspectionResult={...ready,context:{status:'ready',usedTokens:66000,windowTokens:200000,percent:33},git:{status:'ready',count:5},compaction:{status:'ready',count:9,complete:true}};
  await evaluate(`setMode('conversation')`);await waitForResult();await pause(220);view=await inspectView();
  assert.equal(inspections,beforeModeSwitch+2);
  assert.equal(view.label,'所选对话');assert.equal(view.context,'33%');assert.equal(view.git,'5');
  assert.equal(view.compaction,'9 次','an old automatic compression count must not replace the newer manual target');
  assert.equal(view.project,'项目：new-manual-project');assert.ok(view.projectTitle.includes('new-team'));assert.equal(view.automaticLabel,'自动识别当前对话','a delayed automatic result cannot replace a newer manual project or automatic option text');
  assert.equal(await evaluate(`document.getElementById('conversation-select').value`),'fixture-two','a delayed automatic reply cannot change a newer manual selection or heading');
  inspectionResult=ready;inspectionTargetOverrides={};
  await evaluate(`setMode('quota')`);await pause(30);
  const beforeCycle=inspections, listsBeforeCycle=conversationLists;
  for(const page of ['conversation','accounts','today','week','lastTurn','phrase','quota']) {
    await evaluate(`document.getElementById('next-page').click()`);await pause(30);
    if(page==='conversation') await waitForResult();
    assert.equal(settings.mode,page,'the full seven-page cycle follows quota → conversation → accounts → today → week → lastTurn → phrase → quota');
    assert.equal(await evaluate(`!document.getElementById('${page}-view').hidden`),true,'the selected cycle page is visible');
  }
  assert.equal(inspections,beforeCycle+1,'one complete page cycle inspects only on conversation entry');
  assert.equal(conversationLists,listsBeforeCycle+1);
  const beforePrevious=inspections,listsBeforePrevious=conversationLists,refreshesBeforePrevious=refreshes;
  await evaluate("window.navigationBubbleClicks=0;document.getElementById('bubble').addEventListener('click',()=>navigationBubbleClicks++);");
  for(const page of ['phrase','lastTurn','week','today','accounts','conversation','quota']) {
    await evaluate("document.getElementById('previous-page').querySelector('svg').dispatchEvent(new MouseEvent('click',{bubbles:true}))");await pause(30);
    if(page==='conversation')await waitForResult();
    assert.equal(settings.mode,page,'previous page traverses the visible sequence in reverse with wrap');
  }
  assert.equal(inspections,beforePrevious+1);assert.equal(conversationLists,listsBeforePrevious+1);
  assert.equal(refreshes,refreshesBeforePrevious,'arrow clicks cannot refresh the enclosing bubble');
  assert.equal(await evaluate('navigationBubbleClicks'),0,'SVG clicks stop at the arrow button');
  const beforeRestore=inspections, listsBeforeRestore=conversationLists;
  await publish({mode:'conversation',defaultBubblePage:'conversation'});
  assert.equal(inspections,beforeRestore,'restoring the conversation mode from state must not inspect');
  await win.loadFile(path.join(root,'src','index.html'));await waitForInitialWidget([]);
  assert.equal((await inspectView()).shown,true,'a saved conversation default restores the second page on reload');
  assert.equal(inspections,beforeRestore,'startup restoration must not inspect until a deliberate entry or refresh');
  assert.equal(conversationLists,listsBeforeRestore,'startup restoration must not list conversations');
  conversationListsAfterChecks=conversationLists;
  await publish(originalSettings);
  return inspections;
}
async function checkBubbleMotion(capture) {
  const visualState = () => evaluate(`Object.fromEntries(['bubble','bubble-content','dot-one','dot-two','character'].map(id=>{const el=document.getElementById(id)||document.querySelector('.'+id),s=getComputedStyle(el),r=el.getBoundingClientRect();return [id,{x:r.x,y:r.y,width:r.width,height:r.height,opacity:Number(s.opacity),scale:parseFloat(s.scale)||1,inert:el.inert,ariaHidden:el.getAttribute('aria-hidden'),pointerEvents:s.pointerEvents}]}))`);
  const sampleInteraction = time => evaluate(`(()=>{let count=0;for(const id of ['character','bubble-motion']){const el=document.getElementById(id);void el.offsetWidth;for(const animation of el.getAnimations())if(animation instanceof CSSTransition&&animation.transitionProperty==='transform'){animation.pause();animation.currentTime=${time};count++;}}return count;})()`);
  const interactionTransforms = () => evaluate(`['character','bubble-motion'].map(id=>{const style=getComputedStyle(document.getElementById(id)),matrix=new DOMMatrix(style.transform);return {values:[matrix.a,matrix.b,matrix.c,matrix.d,matrix.e,matrix.f],duration:style.transitionDuration,properties:style.transitionProperty};})`);
  const finishInteraction = () => evaluate(`(()=>{for(const id of ['character','bubble-motion']){const el=document.getElementById(id);void el.offsetWidth;for(const animation of el.getAnimations())if(animation instanceof CSSTransition&&animation.transitionProperty==='transform')animation.finish();}return true;})()`);
  const sampleTransition = time => evaluate(`(()=>{let count=0;for(const id of ['bubble','bubble-content','dot-one','dot-two']){const el=document.getElementById(id)||document.querySelector('.'+id);void el.offsetWidth;for(const animation of el.getAnimations()){animation.pause();animation.currentTime=${time};count++;}}return count;})()`);
  const finishTransitions = async () => { await evaluate(`for(const id of ['bubble','bubble-content','dot-one','dot-two'])for(const animation of (document.getElementById(id)||document.querySelector('.'+id)).getAnimations())animation.finish()`);await pause(30); };
  const assertVisible = (visual, shown, message) => {
    for(const id of ['bubble','dot-one','dot-two']) {
      assert.ok(shown ? visual[id].opacity>.999 : visual[id].opacity<.001,`${message}: ${id} opacity`);
      assert.ok(shown ? Math.abs(visual[id].scale-1)<.001 : visual[id].scale<.9,`${message}: ${id} scale`);
    }
    assert.ok(shown ? visual['bubble-content'].opacity>.999 : visual['bubble-content'].opacity<.001,`${message}: text opacity`);
    assert.equal(visual.bubble.inert,!shown,`${message}: hidden contents must not receive input`);
    assert.equal(visual.bubble.ariaHidden,String(!shown),`${message}: accessibility visibility`);
    assert.equal(visual.bubble.pointerEvents,shown?'auto':'none',`${message}: pointer visibility`);
  };
  await publish({autoHideSeconds:0});await pause(500);
  // Scrub the production transform transitions. Reentry must preserve the
  // presented frame instead of clearing a keyframe animation back to rest.
  for(const mirror of [false,true]) {
    await publish({mirror});
    const rest=await visualState();
    await evaluate(`clearBounce();pressInteraction(false)`);
    assert.equal(await sampleInteraction(220),2,'press starts both transform transitions');
    await finishInteraction();
    const compressed=await visualState(),held=await interactionTransforms();
    for(const id of Object.keys(rest))assert.ok(compressed[id].y>rest[id].y+.5,`${id} follows the held compression`);
    assert.ok(Math.abs(held[0].values[0]-1.05)<.001&&Math.abs(held[0].values[3]-.88)<.001,'character uses the DSH compression');
    assert.ok(held.every(item=>item.duration.split(',').some(value=>Math.abs(parseFloat(value)-.22)<.001)&&item.properties.includes('transform')),'ordinary motion uses a 220 ms transform transition');
    await evaluate(`releaseInteraction(false)`);
    assert.equal(await sampleInteraction(65),2,'release starts both return transitions immediately');
    const beforeReentry=await interactionTransforms();
    await evaluate(`pressInteraction(false)`);
    const afterReentry=await interactionTransforms();
    for(let index=0;index<2;index++)for(let axis=0;axis<6;axis++)assert.ok(Math.abs(afterReentry[index].values[axis]-beforeReentry[index].values[axis])<.02,'rapid reentry continues from the current transform');
    await evaluate(`releaseInteraction(false)`);
    await finishInteraction();
    assert.equal(await evaluate(`['character','bubble-motion'].every(id=>!document.getElementById(id).classList.contains('interaction-pressed'))`),true,'release clears both pressed states');
    assert.equal(await readable(),true,'animated mirrored content remains readable');
    const finished=await visualState();
    for(const id of Object.keys(rest))assert.ok(Math.abs(finished[id].y-rest[id].y)<.1,`${id} returns to rest`);
  }
  await publish({mirror:false});
  await evaluate(`setBubbleVisible(false)`);
  assert.ok(await sampleTransition(60)>=7,'hide uses real text, opacity and scale transitions');
  let frame=await visualState();
  assert.ok(frame['bubble-content'].opacity<.8&&frame.bubble.opacity>.999&&frame['dot-one'].opacity>.999&&frame['dot-two'].opacity>.999,'collapse starts with the text while the outline and dots remain visible');
  await sampleTransition(170);frame=await visualState();
  assert.ok(frame['bubble-content'].opacity<.001&&frame.bubble.opacity<.9&&frame['dot-one'].opacity>.999&&frame['dot-two'].opacity>.999,'the main outline collapses after the text');
  await sampleTransition(300);frame=await visualState();
  assert.ok(frame.bubble.opacity<.001&&frame['dot-one'].opacity<.9&&frame['dot-two'].opacity>.999,'collapse continues from the big dot to the small dot');
  await sampleTransition(600);assertVisible(await visualState(),false,'collapsed');await finishTransitions();
  await evaluate(`reveal()`);
  assert.ok(await sampleTransition(60)>=7,'show uses real text, opacity and scale transitions');
  frame=await visualState();
  assert.ok(frame['dot-two'].opacity>.1&&frame['dot-one'].opacity<.001&&frame.bubble.opacity<.001&&frame['bubble-content'].opacity<.001,'appearance starts with the small dot');
  await capture('bubble-appearance-first-dot.png');
  await sampleTransition(190);frame=await visualState();
  assert.ok(frame['dot-one'].opacity>.1&&frame.bubble.opacity<.001&&frame['bubble-content'].opacity<.001,'appearance continues through the big dot');
  await sampleTransition(300);frame=await visualState();
  assert.ok(frame.bubble.opacity>.1&&frame['bubble-content'].opacity<.001,'the outline expands before its text');
  await capture('bubble-appearance-outline.png');
  await sampleTransition(600);assertVisible(await visualState(),true,'expanded');await finishTransitions();
  // A user can click again while the collapse is still running. The final
  // appearance must not inherit a hidden class or a paused transition.
  await evaluate(`setBubbleVisible(false)`);await pause(70);await evaluate(`reveal()`);await pause(600);
  assertVisible(await visualState(),true,'rapid collapse/reveal');
  await publish({autoHideSeconds:.22});await pause(60);await evaluate(`reveal()`);await pause(120);
  assert.equal(await evaluate(`document.getElementById('bubble').classList.contains('hidden-bubble')`),false,'interaction restarts the automatic hide timer');
  await pause(140);await pause(600);assertVisible(await visualState(),false,'automatic collapse');
  await publish({autoHideSeconds:10,mirror:true});await pause(600);
  assertVisible(await visualState(),true,'settings restore a fully shown bubble');
}
async function checkCornerPeeking(capture) {
  const initialSettings={...settings},initialSize=win.getSize(),evidence=[];
  const viewport = () => evaluate(`({width:innerWidth,height:innerHeight,htmlOverflow:getComputedStyle(document.documentElement).overflow,bodyOverflow:getComputedStyle(document.body).overflow,peeking:document.getElementById('widget').classList.contains('is-corner-peeking'),moving:document.getElementById('widget').classList.contains('is-moving'),imageScale:getComputedStyle(document.getElementById('maid-image')).scale,translateAnimations:['character','bubble-motion'].reduce((count,id)=>count+document.getElementById(id).getAnimations().filter(animation=>animation instanceof CSSTransition&&animation.transitionProperty==='translate').length,0),bodyAnimations:document.getElementById('maid-image').getAnimations().length,characterTransition:getComputedStyle(document.getElementById('character')).transitionProperty,bubbleTransition:getComputedStyle(document.getElementById('bubble-motion')).transitionProperty})`);
  const pose = async (offset,moving=false,corner=null,peeking=false) => {cornerDock={corner,peeking};visualPose={offset,moving};await publish();};
  const assertPosition = (actual,full,offset,label) => {
    for(const id of ['character','bubble','dot-one','dot-two']) {
      assert.ok(Math.abs(actual[id].y-full[id].y-offset.y)<.2,`${label}: ${id} tracks the supplied vertical pose without a CSS lag`);
      const x=id==='character'?offset.x:0;
      assert.ok(Math.abs(actual[id].x-full[id].x-x)<.2,`${label}: ${id} uses the correct side offset`);
    }
    for(const id of ['toolbar','notice','demo-label'])assert.deepEqual(actual[id],full[id],`${label}: ${id} stays in place`);
  };
  await publish({peekAtCorners:true,peekBottomPercent:100,peekSidePercent:100,autoHideSeconds:0,mode:'quota'});
  await evaluate(`document.getElementById('notice').hidden=false;document.getElementById('notice').style.visibility='visible'`);
  for(const character of ['mint-maid','lilac-dragon']) {
    for(const scale of [.8,1.4]) {
      const size=widgetDimensions(scale);win.setSize(size.width,size.height);await pause(60);
      for(const mirror of [false,true]) {
        await publish({activeCharacterId:character,mirror});await waitForTheme(character,'builtin');
        await pose({x:0,y:0});await finishBubbleTransitions();
        const full=await rects(),before=await viewport(),nativeSize=win.getSize(),unit=before.width/380;
        const corner=mirror?'left':'right',target={x:(mirror?-48:48)*unit,y:56*unit};
        await pose(target,false,corner,true);
        const peek=await rects(),after=await viewport();
        assertPosition(peek,full,target,`${character}/${scale}/${corner} dock`);
        assert.equal(after.peeking,true,'bottom-corner state enables the peeking renderer');
        assert.deepEqual(win.getSize(),nativeSize,'peeking never resizes the native window');
        assert.equal(after.width,before.width);assert.equal(after.height,before.height);
        assert.equal(after.htmlOverflow,'hidden');assert.equal(after.bodyOverflow,'hidden');
        assert.ok(peek.character.y+peek.character.height>after.height+target.y-4,'the lower body extends beyond the clipped viewport');
        assert.ok(mirror?peek.character.x<-45*unit:peek.character.x+peek.character.width>after.width+45*unit,'the side of the character is clipped at the docked corner');
        assert.ok(peek.character.y<after.height-80*unit,'the head remains visible and draggable');
        assert.ok(peek.toolbar.y>=0&&peek.toolbar.y+peek.toolbar.height<=after.height,'toolbar remains inside the viewport');
        assert.equal(await readable(),true,'peeking keeps bubble text and controls readable in both orientations');
        if(await evaluate(`document.getElementById('maid-image').parentElement!==document.getElementById('character')`)) {
          await pause(340);
          const orientation=await evaluate(`({scale:getComputedStyle(document.getElementById('maid-image')).scale,x:new DOMMatrix(getComputedStyle(document.getElementById('maid-image').parentElement).transform).m11})`);
          assert.ok(['1','1 1'].includes(orientation.scale),'the image does not apply a second mirror scale');assert.ok(Math.abs(orientation.x-(mirror?-1:1))<.01,'the mirror plane retains the settled orientation while peeking');
        } else assert.equal(after.imageScale,mirror?'-1 1':'none','legacy fixtures preserve their own character orientation');
        assert.ok(!after.characterTransition.includes('translate'),'character translation has no second interpolation');
        assert.ok(!/(?:all|translate)/.test(after.bubbleTransition),'native bubble translation has no second interpolation');
        if(scale===1.4&&((character==='mint-maid'&&mirror)||(character==='lilac-dragon'&&!mirror))) {
          await evaluate(`document.getElementById('notice').hidden=true`);
          await pause(80);await captureOffscreenFrame(win);await pause(50);
          await capture(`widget-corner-peek-${character}-${corner}.png`);
          await evaluate(`document.getElementById('notice').hidden=false`);
        }
        // Clearing the dock state on pointer-down must not reset the pose. The
        // main process supplies each following drag/settle frame, even when a
        // downward drag is clamped at the bottom of the native viewport.
        await evaluate(`bounce()`);
        await pose(target,true,corner,false);
        assertPosition(await rects(),full,target,'drag begins at the exact dock pose');
        assert.equal((await viewport()).moving,true);
        assert.equal((await viewport()).bodyAnimations,0,'pointer motion suspends breathing');
        assert.equal(await evaluate(`['character','bubble-motion'].every(id=>!document.getElementById(id).classList.contains('bounce')&&document.getElementById(id).getAnimations().length===0)`),true,'pointer motion clears bounce without changing the supplied pose');
        let lastY=(await rects()).character.y;
        for(const delta of [12,24]) {
          const down={x:target.x,y:target.y+delta*unit};
          await pose(down,true,corner,false);
          const frame=await rects();assertPosition(frame,full,down,'downward pointer movement');
          assert.ok(frame.character.y>lastY,'dragging downward never makes the character spring upward');
          assert.equal((await viewport()).translateAnimations,0,'drag frames never start a translate transition');lastY=frame.character.y;
        }
        for(const fraction of [.75,.5,.25,0]) {
          const offset={x:target.x*fraction,y:target.y*fraction};
          await pose(offset,true,corner,false);assertPosition(await rects(),full,offset,'dragging naturally reveals the whole body');
        }
        // An off-corner release stays fully expanded; a near-corner release
        // receives continuous main-process interpolation before its final dock.
        await pose({x:0,y:0});assertPosition(await rects(),full,{x:0,y:0},'release away from a corner');
        for(const fraction of [.2,.4,.6,.8,1]) {
          const offset={x:target.x*fraction,y:target.y*fraction};
          await pose(offset,fraction<1,corner,fraction===1);assertPosition(await rects(),full,offset,'release settling frame');
        }
        evidence.push({character,scale,corner,unit,target,full:full.character,peek:peek.character,viewport:before,nativeSize});
        await pose({x:0,y:0});assert.equal((await viewport()).peeking,false);
      }
    }
  }
  // Older state providers can omit visualPose; only idle fallback derives the
  // same design offsets. New drag frames always take precedence over cornerDock.
  visualPose=undefined;cornerDock={corner:'left',peeking:true};await publish();
  assert.equal((await viewport()).peeking,true);
  assert.ok(await evaluate(`Math.abs(parseFloat(document.getElementById('widget').style.getPropertyValue('--visual-offset-x'))+48)<.01`),'idle fallback hides the left side as well');
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
  await pose({x:0,y:0});const reducedFull=await rects(),unit=(await viewport()).width/380;
  await pose({x:48*unit,y:56*unit},true,'right',true);
  assertPosition(await rects(),reducedFull,{x:48*unit,y:56*unit},'moving follows the supplied pose under either OS motion preference');
  assert.equal(await evaluate(`['character','bubble-motion','maid-image'].every(id=>document.getElementById(id).getAnimations().length===0)`),true,'the moving pose still pauses independent animations');
  await pose({x:0,y:0});
  assert.equal(await evaluate(`document.getElementById('maid-image').getAnimations().some(animation=>animation.animationName==='breathe')`),true,'breathing resumes at rest while the OS requests reduced motion');
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
  win.setSize(...initialSize);await pause(60);await publish(initialSettings);
  await evaluate(`document.getElementById('notice').hidden=true;document.getElementById('notice').style.visibility='hidden'`);
  fs.writeFileSync(path.join(screenshotDirectory,'continuous-pose-evidence.json'),JSON.stringify(evidence,null,2));
}

async function checkBubblePagesUi(capture,screenshots) {
  const ids=['quota','conversation','accounts','today','week','lastTurn','phrase'];
  const act=async code=>{const revision=settingsRevision;await evaluate(code);for(let attempt=0;attempt<80;attempt++){if(settingsRevision>revision&&!(await evaluate('bubblePageSaving')))return;await pause(25);}throw new Error('Bubble page settings action did not finish');};
  assert.equal(await evaluate(`document.getElementById('mode')===null&&document.querySelectorAll('.bubble-page-card').length===7`),true);
  const selectedBefore=settings.mode;
  await act(`document.getElementById('page-default-week').click()`);
  assert.equal(settings.defaultBubblePage,'week');assert.equal(settings.mode,selectedBefore,'selecting a startup default does not rewrite the current page');
  await act(`document.getElementById('page-handle-week').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowUp',altKey:true,bubbles:true}))`);assert.equal(settings.bubblePageOrder[3],'week');
  await act(`document.getElementById('page-handle-week').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowUp',altKey:true,bubbles:true}))`);assert.equal(settings.bubblePageOrder[2],'week');
  const sortEvidence=await checkBubbleSortUi({win,evaluate,pause,publish,getSettings:()=>settings,getRevision:()=>settingsRevision,getWrites:()=>settingsWriteAttempts,failNextSave:()=>settingsDeliveryPlans.push({reject:true}),capture});
  fs.writeFileSync(path.join(screenshots,'bubble-sort-ui.json'),JSON.stringify({ok:true,...sortEvidence,fixturesOnly:true},null,2));
  assert.equal(settings.bubblePageOrder[0],'phrase');
  await act(`document.getElementById('page-visible-week').click()`);assert.equal(settings.defaultBubblePage,'phrase');assert.ok(settings.bubbleHiddenPages.includes('week'));
  assert.match(await evaluate(`document.getElementById('bubble-pages-feedback').textContent`),/原默认页已隐藏/);
  for(const id of ['quota','conversation','accounts','today','lastTurn'])await act(`document.getElementById('page-visible-${id}').click()`);
  const beforeLast=settingsRevision;await evaluate(`document.getElementById('page-visible-phrase').click()`);await pause(50);
  assert.equal(settingsRevision,beforeLast);assert.equal(await evaluate(`document.getElementById('page-visible-phrase').checked`),true);assert.match(await evaluate(`document.getElementById('bubble-pages-feedback').textContent`),/至少保留/);
  await publish({bubblePageOrder:ids,bubbleHiddenPages:[],defaultBubblePage:'week'});
  await evaluate(`document.getElementById('bubble-pages').scrollIntoView({block:'center'})`);await pause(80);await capture('bubble-pages-settings.png');
  const inspectionsBefore=inspections,listsBefore=conversationLists;
  await publish({bubblePageOrder:['week','today','quota','conversation','accounts','lastTurn','phrase'],bubbleHiddenPages:['conversation','accounts','lastTurn','phrase'],defaultBubblePage:'week',mode:'quota'});
  const size=widgetDimensions(settings.scale);win.setSize(size.width,size.height);await win.loadFile(path.join(root,'src','index.html'));await pause(250);
  assert.equal(await evaluate('mode'),'week','startup uses the independent default instead of the last current page');
  for(const id of ['today','quota','week']){await evaluate(`document.getElementById('next-page').click()`);await pause(80);assert.equal(await evaluate('mode'),id);assert.equal(settings.defaultBubblePage,'week');}
  for(const id of ['quota','today','week']){await evaluate("document.getElementById('previous-page').click()");await pause(80);assert.equal(await evaluate('mode'),id);assert.equal(settings.defaultBubblePage,'week');}
  await evaluate("document.getElementById('next-page').focus()");
  assert.equal(await evaluate('document.activeElement?.id'),'next-page','the real next-page button receives keyboard focus');
  // Chromium needs the character text as well as the physical key to perform
  // native button activation; keyDown without text only delivers a key event.
  for(const type of ['keyDown','keyUp'])await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type,key:'Enter',code:'Enter',windowsVirtualKeyCode:13,nativeVirtualKeyCode:13,...(type==='keyDown'?{text:'\r'}:{})});
  await pause(80);assert.equal(await evaluate('mode'),'today','Enter activates the next-page button');
  await evaluate("document.getElementById('previous-page').focus()");
  assert.equal(await evaluate('document.activeElement?.id'),'previous-page','the real previous-page button receives keyboard focus');
  for(const type of ['keyDown','keyUp'])await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type,key:' ',code:'Space',windowsVirtualKeyCode:32,nativeVirtualKeyCode:32,...(type==='keyDown'?{text:' '}:{})});
  await pause(80);assert.equal(await evaluate('mode'),'week','Space activates the previous-page button');
  await evaluate(`document.getElementById('talk').click()`);await pause(60);assert.equal(await evaluate('mode'),'week');assert.match(await evaluate(`document.getElementById('notice').textContent`),/台词页已隐藏/);
  await publish({bubbleHiddenPages:['week','conversation','accounts','lastTurn','phrase'],defaultBubblePage:'today'});
  assert.equal(await evaluate('mode'),'today','hiding the current page selects a visible fallback');
  await publish({bubbleHiddenPages:ids.filter(id=>id!=='conversation'),defaultBubblePage:'conversation'});
  await win.loadFile(path.join(root,'src','index.html'));await pause(250);assert.equal(await evaluate('mode'),'conversation');
  await publish();assert.equal(await evaluate('mode'),'conversation','ordinary updates preserve the startup default without rewriting the saved current mode');
  assert.equal(await evaluate("['previous-page','next-page'].every(id=>document.getElementById(id).disabled&&document.getElementById(id).getAttribute('aria-disabled')==='true')"),true,'both arrows expose their disabled state when only one page is visible');
  const singleRevision=settingsRevision;
  await evaluate("document.getElementById('previous-page').click();document.getElementById('next-page').click()");await pause(60);
  assert.equal(settingsRevision,singleRevision,'disabled arrows cannot save or re-enter the sole page');
  assert.equal(inspections,inspectionsBefore);assert.equal(conversationLists,listsBefore);
  fs.writeFileSync(path.join(screenshots,'bubble-pages-ui.json'),JSON.stringify({ok:true,...sortEvidence,visibilityControls:true,dragReorder:true,keyboardReorder:true,directDefaultChoice:true,lastVisibleProtected:true,hiddenDefaultFallsBack:true,widgetCycleRespectsVisibleOrder:true,previousPage:true,nextPage:true,bidirectionalWrap:true,singleVisibleDisablesBoth:true,svgClickDoesNotRefresh:true,arrowKeyboardActivation:true,hiddenTalkDoesNotBypass:true,startupDefaultIndependent:true,conversationDefaultPassive:true,fixturesOnly:true},null,2));
  await publish({bubblePageOrder:ids,bubbleHiddenPages:[],defaultBubblePage:'week',mode:'week'});
  win.setSize(550,760);await win.loadFile(path.join(root,'src','settings.html'));await pause(250);
}

app.whenReady().then(async()=>{
  markPhase('initial widget');
  const errors=[];
  win=new BrowserWindow({...widgetDimensions(),frame:false,show:false,transparent:true,backgroundColor:'#00000000',webPreferences:{preload:path.join(root,'src','preload.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false,offscreen:true,backgroundThrottling:false}});
  // Hosted Macs can enable Reduce Motion globally. Exercise normal animations
  // explicitly, then separately exercise the reduced-motion branch below.
  win.webContents.on('console-message',(_event,details)=>{if(details.level==='error')errors.push(details.message);});
  win.webContents.on('preload-error',(_event,_path,error)=>errors.push(error.message));
  await win.loadFile(path.join(root,'src','index.html'));
  win.webContents.debugger.attach('1.3');
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
  const first=await waitForInitialWidget(errors);
  assert.equal(first.value,'82');assert.equal(first.artLoaded,true);assert.equal(first.demo,true);assert.equal(first.secure,true);assert.equal(first.logoLoaded,true);
  assert.equal(first.width,228);assert.equal(first.height,288);
  assert.equal(await evaluate(`document.getElementById('bucket-name')===null && document.getElementById('footnote')===null`),true,'remove verbose metadata from the bubble');
  assert.equal(await evaluate(`document.getElementById('characters')===null && document.getElementById('inspect-conversation')===null && document.querySelectorAll('.toolbar button').length===4`),true,'keep only refresh, talk, settings and hide in the toolbar');
  assert.match(await evaluate(`document.getElementById('bubble').title`),/演示数据/);
  assert.equal(settings.activeCharacterId,'frost-glass-cheek','a fresh widget should start with Frost Glass cheek');
  await waitForTheme('frost-glass-cheek','builtin');const frostTheme=await themeColors();
  for(const id of ['frost-glass-idle','frost-glass-cheek']) {
    await publish({activeCharacterId:id});await waitForTheme(id,'builtin');
    const art=await evaluate(`(async()=>{const image=document.getElementById('maid-image');await image.decode();return {width:image.naturalWidth,height:image.naturalHeight,alt:image.alt};})()`);
    assert.equal(art.width,1381);assert.equal(art.height,1139);assert.equal(art.alt,library.get(id).name);
    assert.deepEqual(await themeColors(),frostTheme,'both Frost Glass poses share the curated palette');
  }
  await publish({activeCharacterId:'lilac-dragon'});
  await waitForTheme('lilac-dragon','builtin');const lilacTheme=await themeColors();
  const purpleChannels=lilacTheme.outline.match(/\d+(?:\.\d+)?/g).map(Number);
  assert.ok(purpleChannels[2]>purpleChannels[1],'the lilac character should use a purple bubble outline');
  await publish({activeCharacterId:'mint-maid'});await waitForTheme('mint-maid','builtin');
  const mintTheme=await themeColors();assertPaletteChanged(lilacTheme,mintTheme,'switching to the mint maid');
  await publish({activeCharacterId:'lilac-dragon'});await waitForTheme('lilac-dragon','builtin');
  assert.deepEqual(await themeColors(),lilacTheme,'switching back should restore the lilac palette');
  await publish({activeCharacterId:'mint-maid'});await waitForTheme('mint-maid','builtin');
  assert.deepEqual(await themeColors(),mintTheme,'switching back should restore the mint palette');
  const screenshots=screenshotDirectory;fs.mkdirSync(screenshots,{recursive:true});
  const capture = async name => fs.writeFileSync(path.join(screenshots,name),(await captureOffscreenFrame(win)).toPNG());
  await checkMirrorMotion();
  await publish({autoHideSeconds:0});
  await evaluate(`document.getElementById('notice').hidden=false;document.getElementById('notice').textContent='测试提示';document.querySelector('.toolbar').style.opacity='1';document.querySelector('.toolbar').style.transition='none'`);
  await finishBubbleTransitions();
  const normal=await rects();assert.equal(await readable(),true);
  await evaluate(`document.getElementById('notice').style.visibility='hidden'`);await pause(100);await capture('widget-right-demo.png');
  await publish({mirror:true});await finishBubbleTransitions();const mirrored=await rects();
  for(const id of Object.keys(normal)) {
    assert.ok(Math.abs(mirrored[id].x-(first.width-normal[id].x-normal[id].width))<1, `${id} should move to its mirrored position: ${JSON.stringify({normal:normal[id],mirrored:mirrored[id],viewport:first.width})}`);
    assert.ok(Math.abs(normal[id].y-mirrored[id].y)<1,`${id} should keep its vertical position`);
  }
  assert.equal(await readable(),true,'mirroring must keep labels and controls readable');await capture('widget-left-demo.png');
  markPhase('passive conversation status');
  inspectionsAfterChecks=await checkConversationStatus(capture);
  await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseMoved',x:-100,y:-100});
  await pause(250);
  await evaluate(`document.getElementById('notice').hidden=true`);
  markPhase('bottom-corner peeking and drag restoration');
  await checkCornerPeeking(capture);
  markPhase('bubble animation and visibility');
  await checkBubbleMotion(capture);
  markPhase('quota highlight and always-on animation');
  const shine = () => evaluate(`({active:document.querySelector('.headline').classList.contains('quota-shimmer'),background:getComputedStyle(document.querySelector('.quota-value')).backgroundImage,position:getComputedStyle(document.querySelector('.quota-value')).backgroundPosition,playState:getComputedStyle(document.querySelector('.quota-value')).animationPlayState,animations:document.querySelector('.quota-value').getAnimations().length})`);
  const waitForShineFrame = async previous => {
    // Hidden offscreen surfaces may not request a compositor frame on their
    // own. Request real paints and wait for the CSS animation to advance.
    for(let attempt=0;attempt<40;attempt++) {
      await captureOffscreenFrame(win);await pause(50);
      const frame=await shine();
      if(frame.position!==previous.position)return frame;
    }
    assert.fail('running quota shimmer should produce a new painted frame');
  };
  const shineBefore=await shine();const shineAfter=await waitForShineFrame(shineBefore);
  assert.equal(shineAfter.active,true);assert.ok(shineAfter.animations>0);assert.notEqual(shineBefore.position,shineAfter.position);
  await evaluate('setBubbleVisible(false)');await pause(60);
  const pausedShine=await shine();assert.equal(pausedShine.playState,'paused');
  await captureOffscreenFrame(win);await pause(180);
  assert.equal((await shine()).position,pausedShine.position,'hidden quota shimmer should stop repainting');
  await evaluate('setBubbleVisible(true)');
  assert.equal((await shine()).playState,'running');
  assert.notEqual((await waitForShineFrame(pausedShine)).position,pausedShine.position,'showing the bubble resumes the existing shimmer');
  snapshot.buckets[0].primary.remainingPercent=10;await publish();const warningShine=await shine();assert.notEqual(warningShine.background,shineBefore.background);
  const warningColors=await evaluate(`({time:getComputedStyle(document.getElementById('countdown')).color,badge:getComputedStyle(document.getElementById('reset-tag')).backgroundColor,progress:getComputedStyle(document.getElementById('primary-bar')).backgroundColor})`);
  await publish({activeCharacterId:'lilac-dragon'});await waitForTheme('lilac-dragon','builtin');
  assert.equal((await shine()).background,warningShine.background,'low quota keeps its amber shimmer across character themes');
  assert.deepEqual(await evaluate(`({time:getComputedStyle(document.getElementById('countdown')).color,badge:getComputedStyle(document.getElementById('reset-tag')).backgroundColor,progress:getComputedStyle(document.getElementById('primary-bar')).backgroundColor})`),warningColors,'low quota keeps its amber warning colors');
  await publish({activeCharacterId:'mint-maid'});await waitForTheme('mint-maid','builtin');
  snapshot.buckets[0].primary.remainingPercent=82;await publish();
  const systemMotionEvidence=[];
  for(const systemReduced of [true,false]){
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:systemReduced?'reduce':'no-preference'}]});
    win.webContents.invalidate();await captureOffscreenFrame(win);await pause(80);
    assert.equal(await evaluate(`matchMedia('(prefers-reduced-motion: reduce)').matches`),systemReduced);
    const before=await shine(),after=await waitForShineFrame(before);assert.ok(after.animations>0);assert.notEqual(after.position,before.position);
    assert.equal(await evaluate(`document.getElementById('maid-image').getAnimations().some(animation=>animation.animationName==='breathe')`),true);
    await evaluate('pressInteraction(false)');
    assert.equal(await evaluate(`['character','bubble-motion'].every(id=>document.getElementById(id).classList.contains('interaction-pressed'))`),true,'press animation remains enabled for either OS motion preference');
    const pressedPose=await waitForPressedTransform();
    assert.ok(Math.abs(pressedPose.scaleY-.88)<.002,'settled press keeps the exact shipped compression: '+JSON.stringify(pressedPose));
    await evaluate('releaseInteraction(false)');await pause(320);
    await evaluate('setBubbleVisible(false)');
    assert.ok(await evaluate(`['bubble','bubble-content','dot-one','dot-two'].reduce((count,id)=>count+(document.getElementById(id)||document.querySelector('.'+id)).getAnimations().length,0)`)>0,'bubble hide transitions remain enabled');
    await captureOffscreenFrame(win);await pause(550);win.webContents.invalidate();await captureOffscreenFrame(win);
    assert.equal(await evaluate(`getComputedStyle(document.getElementById('bubble')).opacity`),'0');
    await evaluate('setBubbleVisible(true)');await captureOffscreenFrame(win);await pause(550);win.webContents.invalidate();await captureOffscreenFrame(win);
    assert.equal(await evaluate(`getComputedStyle(document.getElementById('bubble')).opacity`),'1');
    systemMotionEvidence.push({systemReduced,shimmerPaints:true,breathing:true,pressedPose:true,bubbleShowHideAnimated:true});
  }
  fs.writeFileSync(path.join(screenshots,'always-on-animation-evidence.json'),JSON.stringify({animationsAlwaysEnabled:true,systemMotionEvidence},null,2));
  await evaluate(`setMode('today')`);await pause(80);assert.equal(settings.mode,'today');
  const today=await evaluate(`({shown:!document.getElementById('today-view').hidden,text:document.getElementById('today-tokens').textContent})`);
  assert.equal(today.shown,true);assert.match(today.text,/tokens/);
  assert.match(await evaluate(`document.getElementById('today-detail').textContent`),/本机/,'today should describe device usage');
  await evaluate(`document.getElementById('next-page').click()`);await pause(80);assert.equal(settings.mode,'week');
  assert.ok(Number.isFinite(snapshot.weekly?.tokens),'the demo should include weekly tokens');
  const week=await evaluate(`({shown:!document.getElementById('week-view').hidden,text:document.getElementById('week-tokens').textContent,detail:document.getElementById('week-detail').textContent,title:document.getElementById('week-view').title,label:document.getElementById('bubble-label').textContent,fits:Array.from(document.querySelectorAll('#week-view > *')).every(el=>{const r=el.getBoundingClientRect(),box=document.getElementById('week-view').getBoundingClientRect();return r.left>=box.left-1&&r.right<=box.right+1&&r.top>=box.top-1&&r.bottom<=box.bottom+1;})})`);
  assert.equal(week.shown,true);assert.equal(week.label,'本周');
  assert.equal(week.text,'126.85万 tokens');
  assert.match(week.detail,/周一至今/);assert.match(week.detail,/本机/);
  assert.match(week.title,/各账号|全部账号|所有账号/,'weekly scope should include every local account');
  assert.equal(week.fits,true,'weekly labels and tokens should fit at the shipped widget size');
  await capture('widget-left-week-demo.png');
  const originalToday = snapshot.today.tokens, originalWeek = snapshot.weekly.tokens;
  snapshot.today.tokens = 143612647; snapshot.weekly.tokens = 999990000000;
  await publish({mode:'today'});
  assert.equal(await evaluate(`document.getElementById('today-tokens').textContent`),'1.4361亿 tokens');
  assert.equal(await evaluate(`document.getElementById('today-tokens').title`),'143,612,647 tokens');
  await capture('widget-today-precision-demo.png');
  await publish({mode:'week'});
  assert.equal(await evaluate(`document.getElementById('week-tokens').textContent`),'9999.9亿 tokens');
  assert.equal(await evaluate(`(()=>{const el=document.getElementById('week-tokens'),view=document.getElementById('week-view'),r=el.getBoundingClientRect(),box=view.getBoundingClientRect();return el.scrollWidth<=el.clientWidth+1&&r.left>=box.left&&r.right<=box.right;})()`),true,'five significant digits and units must remain on one line inside the bubble');
  snapshot.today.tokens=originalToday; snapshot.weekly.tokens=originalWeek; await publish();
  await evaluate(`document.getElementById('next-page').click()`);await pause(80);assert.equal(settings.mode,'lastTurn');
  assert.equal(await evaluate(`!document.getElementById('lastTurn-view').hidden`),true);
  assert.match(await evaluate(`document.getElementById('last-tokens').textContent`),/tokens/);
  await evaluate(`document.getElementById('next-page').click()`);await pause(80);assert.equal(settings.mode,'phrase');
  assert.equal(await evaluate(`!document.getElementById('phrase-view').hidden`),true);
  assert.equal(await readable(),true);await capture('widget-left-phrase-demo.png');
  await publish({activeCharacterId:'lilac-dragon'});await waitForTheme('lilac-dragon','builtin');
  const defaultPhrases=[...settings.phrases];
  for(const mirror of [false,true]) {
    await publish({mirror});
    for(let index=0;index<defaultPhrases.length;index++) {
      await evaluate(`nextPhrase()`);
      const phrase=await phraseLayout();
      assert.equal(phrase.fontSize,24,`every shipped short line should keep 24px (${mirror?'left':'right'}): ${phrase.text}`);
      assert.ok(defaultPhrases.includes(phrase.text));
      assert.equal(phrase.fits,true,`default dialogue should fit without scrolling (${mirror?'left':'right'}): ${phrase.text}`);
      if(!mirror&&phrase.text.includes('Tibo')) { await pause(500);await capture('widget-dragon-tibo-demo.png'); }
    }
    await evaluate(`phraseIndex=-1;nextPhrase()`);await pause(500);
    await capture(mirror?'widget-dragon-phrase-left-demo.png':'widget-dragon-phrase-demo.png');
  }
  const shortPhrase='茶给你放这儿啦。';
  const longPhrases=[
    '这是一条需要完整显示的自定义台词，长度再长也不应该滚动或翻页。'.repeat(8).slice(0,160),
    'Codex 正在处理 PR，等测试过了再一起去喝茶。OpenAI says soon; still waiting! '.repeat(4).slice(0,160),
    'W'.repeat(160),
  ];
  await checkNativePhraseSizing(defaultPhrases,longPhrases);
  for(const scale of [0.6,1,1.6]) {
    const size=widgetDimensions(scale);win.setSize(size.width,size.height);await pause(60);
    for(const mirror of [false,true]) {
      for(const text of longPhrases) {
        await publish({mirror,phrases:[text,shortPhrase]});
        const long=await phraseLayout();
        assert.equal(long.text,text,'updating custom dialogue immediately replaces the current line');
        assert.ok(long.fontSize>0&&long.fontSize<24,'long dialogue reduces its font size');
        assert.equal(long.fits,true,`160-character dialogue fits in full (${scale}, ${mirror?'left':'right'}): ${text}`);
        assert.equal(long.overflow,'visible','dialogue has no clipped or scrollable text box');
        assert.equal(long.scrollTop,0);
        if(scale===1&&!mirror&&text===longPhrases[0]) await capture('widget-dragon-long-phrase-demo.png');
        await evaluate(`nextPhrase()`);
        const short=await phraseLayout();
        assert.equal(short.text,shortPhrase);assert.equal(short.fontSize,24,'changing back to a short line restores the large font');assert.equal(short.fits,true,`short dialogue fits (${scale}, ${mirror}): ${JSON.stringify(short)}`);
      }
    }
  }
  await publish({phrases:['新台词，收到。']});
  assert.deepEqual(await evaluate(`({text:document.getElementById('phrase').textContent,fontSize:parseFloat(getComputedStyle(document.getElementById('phrase')).fontSize)})`),{text:'新台词，收到。',fontSize:24},'saving a replacement list updates the visible line without another click');
  // Both a font-load event and a layout change must recalculate an existing line.
  await publish({phrases:[longPhrases[0]]});
  await evaluate(`document.getElementById('phrase').style.fontFamily='monospace';document.fonts.dispatchEvent(new Event('loadingdone'))`);
  assert.equal((await phraseLayout()).fits,true,'font changes recalculate the fitting size');
  await evaluate(`document.getElementById('phrase-view').style.width='210px'`);
  // ResizeObserver runs on a render update; hidden hosted surfaces may defer
  // it beyond a fixed 60 ms sleep. Wait for the real observer to refit text.
  for(let attempt=0;attempt<40;attempt++) {
    await captureOffscreenFrame(win);await pause(50);
    if((await phraseLayout()).fits)break;
  }
  assert.equal((await phraseLayout()).fits,true,'container width changes recalculate the fitting size');
  await publish({mode:'quota'});
  await evaluate(`document.getElementById('phrase').style.fontFamily='';document.getElementById('phrase-view').style.width=''`);
  await publish({mode:'phrase'});
  assert.equal((await phraseLayout()).fits,true,'returning to the dialogue view refits text hidden during a layout change');
  const shipped=widgetDimensions();win.setSize(shipped.width,shipped.height);await pause(60);
  await publish({phrases:defaultPhrases});
  await publish({mode:'quota',mirror:false});
  const beforeQuotaRefresh=refreshes;
  await evaluate(`document.getElementById('refresh').click()`);await pause(80);assert.equal(refreshes,beforeQuotaRefresh+1);
  snapshot.status='offline';snapshot.error='连接测试';snapshot.stale=true;await publish();
  assert.equal((await shine()).active,false);assert.equal((await shine()).animations,0);
  const offlineColor=await evaluate(`getComputedStyle(document.querySelector('.headline')).color`);
  await publish({activeCharacterId:'lilac-dragon'});await waitForTheme('lilac-dragon','builtin');
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('.headline')).color`),offlineColor,'offline quota stays gray across character themes');
  assert.equal((await shine()).active,false);
  await publish({activeCharacterId:'mint-maid'});await waitForTheme('mint-maid','builtin');
  snapshot.buckets=[];await publish();assert.equal(await evaluate(`document.getElementById('remaining').textContent`),'--');assert.equal((await shine()).active,false);
  // Keep an additional readable preview at the full design-board size.
  Object.assign(snapshot,require('../src/demo.cjs')(),{error:null,stale:false});
  win.setSize(380,480);await publish();await evaluate(`document.getElementById('notice').hidden=true`);await pause(750);await capture('widget-demo.png');
  markPhase('settings and gallery');
  win.setSize(550,760);await win.loadFile(path.join(root,'src','settings.html'));await pause(300);
  assert.equal(await evaluate(`document.getElementById('peekAtCorners').checked`),false,'bottom-corner peeking should be opt-in');
  assert.deepEqual(await evaluate(`['peekBottomPercent','peekSidePercent'].map(id=>({disabled:document.getElementById(id).disabled,value:Number(document.getElementById(id).value),min:document.getElementById(id).min,max:document.getElementById(id).max,step:document.getElementById(id).step}))`),[{disabled:true,value:50,min:'0',max:'200',step:'1'},{disabled:true,value:100,min:'0',max:'200',step:'1'}]);
  assert.equal(await evaluate(`document.getElementById('corner-peek-controls').hidden&&getComputedStyle(document.getElementById('corner-peek-controls')).display==='none'`),true,'disabled peeking hides the entire slider module');
  await evaluate(`document.getElementById('peekAtCorners').click()`);await pause(80);assert.equal(settings.peekAtCorners,true);
  assert.equal(await evaluate(`['peekBottomPercent','peekSidePercent'].every(id=>!document.getElementById(id).disabled)`),true);
  assert.equal(await evaluate(`!document.getElementById('corner-peek-controls').hidden`),true);
  peekPreviewWindow=new BrowserWindow({...widgetDimensions(settings.scale),frame:false,show:false,transparent:true,backgroundColor:'#00000000',webPreferences:{preload:path.join(root,'src','preload.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false,offscreen:true,backgroundThrottling:false}});
  peekPreviewWindow.webContents.on('console-message',(_event,details)=>{if(details.level==='error')errors.push(details.message);});
  await peekPreviewWindow.loadFile(path.join(root,'src','index.html'));await pause(250);
  const readPeekPreview=()=>peekPreviewWindow.webContents.executeJavaScript(`(()=>{const widget=document.getElementById('widget'),rect=document.getElementById('character').getBoundingClientRect();return {x:rect.x,y:rect.y,offsetX:parseFloat(widget.style.getPropertyValue('--visual-offset-x')),offsetY:parseFloat(widget.style.getPropertyValue('--visual-offset-y'))};})()`);
  const assertPeekOffset=(actual,expected,message)=>assert.ok(Math.abs(actual-expected)<.01,message);
  const savedPreviewPose=await readPeekPreview();assertPeekOffset(savedPreviewPose.offsetY,28,'the fresh bottom default is half of the old 56px baseline');
  const beforePeekDrag=settingsRevision;
  const previewsBeforeDrag=peekPreviewRequests;
  await evaluate(`for(const value of [125,160,200]){const slider=document.getElementById('peekBottomPercent');slider.value=value;slider.dispatchEvent(new Event('input'));}`);
  await pause(160);
  assert.equal(settingsRevision,beforePeekDrag,'live preview never writes settings before change');
  assert.equal(settings.peekBottomPercent,50);
  assert.equal(peekPreviewRequests,previewsBeforeDrag+1,'same-frame inputs coalesce into one preview IPC');
  const livePreviewPose=await readPeekPreview();assertPeekOffset(livePreviewPose.offsetY,112);
  assert.ok(Math.abs(livePreviewPose.y-savedPreviewPose.y-84*widgetDimensions(settings.scale).width/380)<.2,'the actual widget character moves before slider change');
  assert.equal(await evaluate(`document.getElementById('peekBottomPercent-value').textContent`),'200%');
  await publish();assert.equal(await evaluate(`document.getElementById('peekBottomPercent').value`),'200','state refresh preserves a slider draft');
  await evaluate(`document.getElementById('peekBottomPercent').dispatchEvent(new Event('change'))`);await pause(80);
  assert.equal(settings.peekBottomPercent,200);assert.equal(settings.peekSidePercent,100);assert.equal(settingsRevision,beforePeekDrag+1);
  assert.equal(peekPreview,null,'the final setting commit clears the transient overlay atomically');
  assertPeekOffset((await readPeekPreview()).offsetY,112,'commit retains the last previewed pose');
  const beforePeekCancel=settingsRevision;
  await evaluate(`document.getElementById('peekBottomPercent').value=125;document.getElementById('peekBottomPercent').dispatchEvent(new Event('input'));`);await pause(100);
  assertPeekOffset((await readPeekPreview()).offsetY,70);
  await evaluate(`document.getElementById('peekBottomPercent').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));`);await pause(100);
  assertPeekOffset((await readPeekPreview()).offsetY,112);assert.equal(settingsRevision,beforePeekCancel);
  assert.equal(await evaluate(`document.getElementById('peekBottomPercent').value`),'200');
  fs.writeFileSync(path.join(screenshots,'corner-peek-live-preview.json'),JSON.stringify({ok:true,hiddenWhileDisabled:true,previewChangedBeforeCommit:true,settingsWritesDuringPreview:0,commitWrites:1,defaultBottomPercent:50,cancelRestoresSaved:true,sameFramePreviewRequests:1,fixturesOnly:true,realWidgetRenderer:true},null,2));
  await evaluate(`const side=document.getElementById('peekSidePercent');side.value=0;side.dispatchEvent(new Event('input'));side.dispatchEvent(new Event('change'));`);await pause(80);
  assert.equal(settings.peekSidePercent,0);assert.equal(settings.peekBottomPercent,200);
  await evaluate(`document.getElementById('corner-peek-controls').scrollIntoView({block:'center'});`);await pause(80);await capture('corner-peek-settings.png');
  await evaluate(`window.scrollTo(0,0)`);
  await evaluate(`document.getElementById('peekAtCorners').click()`);await pause(80);assert.equal(settings.peekAtCorners,false);
  assert.equal(await evaluate(`['peekBottomPercent','peekSidePercent'].every(id=>document.getElementById(id).disabled)`),true);
  assert.equal(await evaluate(`document.getElementById('corner-peek-controls').hidden&&getComputedStyle(document.getElementById('corner-peek-controls')).display==='none'`),true);
  assertPeekOffset((await readPeekPreview()).offsetY,0,'switching peeking off unfolds the preview widget');
  await win.loadFile(path.join(root,'src','settings.html'));await pause(300);
  assert.deepEqual(await evaluate(`['peekBottomPercent','peekSidePercent'].map(id=>({value:Number(document.getElementById(id).value),disabled:document.getElementById(id).disabled}))`),[{value:200,disabled:true},{value:0,disabled:true}],'reopening settings retains disabled edge widths');
  await evaluate(`document.getElementById('peekAtCorners').click()`);await pause(80);
  assert.equal(await evaluate(`['peekBottomPercent','peekSidePercent'].every(id=>!document.getElementById(id).disabled)`),true);
  for(const id of ['peekBottomPercent','peekSidePercent']) {
    const amount=id==='peekBottomPercent'?50:100;
    await evaluate(`document.getElementById('${id}').value=${amount};document.getElementById('${id}').dispatchEvent(new Event('input'));document.getElementById('${id}').dispatchEvent(new Event('change'));`);await pause(80);
  }
  assert.equal(settings.peekBottomPercent,50);assert.equal(settings.peekSidePercent,100);
  await publish();assert.equal(await evaluate(`document.getElementById('peekAtCorners').checked`),true,'settings refresh preserves corner-peeking opt-in');
  await evaluate(`document.getElementById('peekAtCorners').click()`);await pause(80);assert.equal(settings.peekAtCorners,false);
  const savedAppearance={scale:settings.scale,opacity:settings.opacity},appearanceSize=peekPreviewWindow.getSize(),appearanceOpacity=peekPreviewWindow.getOpacity();
  const appearanceRevision=settingsRevision,appearanceRequests=appearancePreviewRequests;
  await evaluate(`for(const value of [.8,1.2,1.4]){document.getElementById('scale').value=value;document.getElementById('scale').dispatchEvent(new Event('input'));}`);await pause(160);
  const previewSize=widgetDimensions(1.4);assert.deepEqual(peekPreviewWindow.getSize(),[previewSize.width,previewSize.height]);
  assert.notDeepEqual(peekPreviewWindow.getSize(),appearanceSize);assert.equal(settings.scale,savedAppearance.scale);assert.equal(settingsRevision,appearanceRevision);assert.equal(appearancePreviewRequests,appearanceRequests+1);
  assert.equal(await evaluate(`document.getElementById('scale-value').textContent`),'140%');
  await evaluate(`document.getElementById('scale').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));`);await pause(100);
  assert.deepEqual(peekPreviewWindow.getSize(),appearanceSize);assert.equal(settingsRevision,appearanceRevision);
  const opacityRequests=appearancePreviewRequests;
  await evaluate(`for(const value of [.8,.65,.5]){document.getElementById('opacity').value=value;document.getElementById('opacity').dispatchEvent(new Event('input'));}`);await pause(160);
  assert.ok(Math.abs(peekPreviewWindow.getOpacity()-.5)<.01);assert.notEqual(peekPreviewWindow.getOpacity(),appearanceOpacity);assert.equal(settings.opacity,savedAppearance.opacity);assert.equal(settingsRevision,appearanceRevision);assert.equal(appearancePreviewRequests,opacityRequests+1);
  await evaluate(`document.getElementById('opacity').dispatchEvent(new Event('change'))`);await pause(100);
  assert.equal(settings.opacity,.5);assert.equal(settingsRevision,appearanceRevision+1);assert.equal(appearancePreview,null);assert.ok(Math.abs(peekPreviewWindow.getOpacity()-.5)<.01);
  fs.writeFileSync(path.join(screenshots,'appearance-live-preview.json'),JSON.stringify({ok:true,nativeSizeChangedBeforeCommit:true,nativeOpacityChangedBeforeCommit:true,settingsWritesDuringPreview:0,commitWrites:1,sameFramePreviewRequests:1,cancelRestoresSaved:true,fixturesOnly:true,realNativeWindow:true},null,2));
  await publish(savedAppearance);
  peekPreviewWindow.destroy();peekPreviewWindow=null;peekPreview=null;appearancePreview=null;
  assert.equal(await evaluate(`document.getElementById('stayInCodexWindow').checked`),false,'window-only mode should be opt-in');
  await evaluate(`document.getElementById('stayInCodexWindow').click()`);await pause(80);
  assert.equal(settings.stayInCodexWindow,true);
  assert.equal(await evaluate(`document.getElementById('alwaysOnTop').disabled`),true);
  await publish();assert.equal(await evaluate(`document.getElementById('stayInCodexWindow').checked`),true);
  await evaluate(`document.getElementById('stayInCodexWindow').click()`);await pause(80);
  assert.equal(settings.stayInCodexWindow,false);
  assert.equal(await evaluate(`document.getElementById('alwaysOnTop').disabled`),false);
  assert.equal(await evaluate(`document.getElementById('followCodex').checked`),true,'following Codex should be enabled by default');
  assert.equal(await evaluate(`document.getElementById('autoStart')===null`),true,'the settings page should present following Codex rather than standalone login startup');
  await evaluate(`document.getElementById('followCodex').click()`);await pause(80);assert.equal(settings.followCodex,false);
  await publish();assert.equal(await evaluate(`document.getElementById('followCodex').checked`),false,'refreshing settings should preserve an explicit opt-out');
  await evaluate(`document.getElementById('followCodex').click()`);await pause(80);assert.equal(settings.followCodex,true);
  await checkBubblePagesUi(capture,screenshots);
  assert.equal(await evaluate(`document.querySelectorAll('.character-card').length`),4);
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('.character-card')].slice(0,2).map(card=>({id:card.dataset.characterId,name:card.querySelector('.character-name').textContent}))`),[{id:'frost-glass-cheek',name:'小龙娘-托腮'},{id:'frost-glass-idle',name:'小龙娘-端庄'}],'the requested dragon names lead the gallery in the requested order');
  for(const id of ['frost-glass-idle','frost-glass-cheek']) {
    await evaluate(`document.querySelector('[data-character-id="${id}"] [data-action="select"]').click()`);
    await pause(100);assert.equal(settings.activeCharacterId,id);
    assert.equal(await evaluate(`document.getElementById('current-character-name').textContent`),library.get(id).name);
    assert.equal(await evaluate(`(async()=>{const image=document.querySelector('[data-character-id="${id}"] img');await image.decode();return image.naturalWidth===1381&&image.naturalHeight===1139;})()`),true);
    await capture(id+'-gallery.png');
  }
  await evaluate(`document.querySelector('[data-character-id="lilac-dragon"] [data-action="select"]').click()`);
  await pause(100);assert.equal(settings.activeCharacterId,'lilac-dragon');
  assert.equal(await evaluate(`document.getElementById('current-character-name').textContent`),'紫晶龙女仆');
  const thumbnailsFit=await evaluate(`Array.from(document.querySelectorAll('.character-card')).every(card=>{const image=card.querySelector('img').getBoundingClientRect();const frame=card.querySelector('.character-image-frame').getBoundingClientRect();const caption=card.querySelector('.character-caption').getBoundingClientRect();return image.bottom<=frame.bottom+1&&frame.bottom<=caption.top+1;})`);
  assert.equal(thumbnailsFit,true,'thumbnail images must not cover character names');
  await capture('character-library.png');
  await evaluate(`document.getElementById('import-characters').click()`);await pause(150);
  const custom=library.list().find(item=>!item.builtIn);assert.ok(custom);
  const card=`[data-character-id="${custom.id}"]`;
  await evaluate(`document.querySelector('${card} [data-action="rename"]').click();document.querySelector('${card} input').value='<b>我的形象</b>';document.querySelector('${card} input').focus();document.querySelector('${card} input').setSelectionRange(2,5)`);
  await publish();
  const editing=await evaluate(`({value:document.querySelector('${card} input').value,focused:document.activeElement===document.querySelector('${card} input'),start:document.querySelector('${card} input').selectionStart})`);
  assert.deepEqual(editing,{value:'<b>我的形象</b>',focused:true,start:2});
  await evaluate(`document.querySelector('${card} form').requestSubmit()`);await pause(100);
  assert.equal(library.get(custom.id).name,'<b>我的形象</b>');
  assert.equal(await evaluate(`document.querySelector('${card} .character-name').children.length`),0,'names must render as text');
  await evaluate(`document.querySelector('${card} [data-action="select"]').click()`);await pause(100);assert.equal(settings.activeCharacterId,custom.id);
  await evaluate(`document.querySelector('${card} [data-action="remove"]').click();document.querySelector('${card} [data-action="cancel-remove"]').click()`);
  assert.ok(library.get(custom.id),'cancel deletion preserves a saved character');
  await evaluate(`document.querySelector('${card} [data-action="remove"]').click();document.querySelector('${card} [data-action="confirm-remove"]').click()`);
  await pause(100);assert.equal(library.get(custom.id),null);assert.equal(settings.activeCharacterId,'frost-glass-cheek');
  await evaluate(`document.querySelector('[data-character-id="lilac-dragon"] [data-action="select"]').click()`);await pause(100);
  await evaluate(`document.getElementById('phrases').value='一起写代码吧。';document.getElementById('phrases').dispatchEvent(new Event('input'));document.getElementById('save-phrases').click()`);
  await pause(80);assert.deepEqual(settings.phrases,['一起写代码吧。']);
  snapshot.status='offline';snapshot.error='连接测试';await publish();assert.equal(await evaluate(`document.getElementById('error').textContent`),'连接测试');
  snapshot.status='demo';snapshot.error=null;await publish();await capture('settings-demo.png');
  win.setSize(380,480);await win.loadFile(path.join(root,'src','index.html'));await pause(750);
  assert.equal(await evaluate(`!document.getElementById('week-view').hidden`),true,'reloading the widget should retain the weekly default selected in settings');
  await publish({mode:'quota'});
  await waitForTheme('lilac-dragon','builtin');
  assert.deepEqual(await themeColors(),lilacTheme,'reloading the widget keeps the selected character palette');
  await capture('widget-dragon-demo.png');
  const importedBlue=library.importFiles([syntheticPng('blue-theme.png',[35,90,230])]).imported[0];
  assert.ok(importedBlue);await publish({activeCharacterId:importedBlue.id});await waitForTheme(importedBlue.id,'image');
  const blueTheme=await themeColors();assertPaletteChanged(mintTheme,blueTheme,'an imported blue image');
  const blueChannels=blueTheme.outline.match(/\d+(?:\.\d+)?/g).map(Number);
  assert.ok(blueChannels[2]>blueChannels[0]&&blueChannels[2]>blueChannels[1],'an imported blue image should produce a blue bubble outline');
  const pendingCharacter=library.importFiles([syntheticPng('pending-theme.png',[230,45,160])]).imported[0];
  assert.ok(pendingCharacter);
  settings=sanitize({...settings,activeCharacterId:pendingCharacter.id});win.webContents.send('state',state());
  settings=sanitize({...settings,activeCharacterId:'mint-maid'});win.webContents.send('state',state());
  await waitForTheme('mint-maid','builtin');await pause(350);
  assert.deepEqual(await themeColors(),mintTheme,'an older image decode must not overwrite a newer character theme');
  assert.equal(await evaluate(`document.getElementById('widget').dataset.themeCharacter`),'mint-maid');
  assert.equal(inspections,inspectionsAfterChecks,'later quota updates, normal pages, settings and reloads must never poll conversation status');
  assert.equal(conversationLists,conversationListsAfterChecks,'later quota updates, normal pages, settings and reloads must never poll the conversation list');
  assert.deepEqual(errors,[]);
  console.log('PASS: continuous bottom-corner side/bottom clipping and pointer-following drag/settle pose for both builtin characters, orientations and scales, fixed native bounds and toolbar, opt-in settings, synchronized character/bubble bounce in both orientations, ordered bubble/dot show and collapse, rapid reversal and automatic hide, always-on animation under either OS preference, device-wide weekly tokens and mode cycle, compact weekly layout, weekly default and Codex-follow settings, builtin/imported character themes and async switch guard, full dialogue auto-fit across long CJK/mixed/unbroken text, both orientations and scale range, short-line font reset and immediate dialogue updates, passive conversation context/Git status as the second of seven pages, bubble-click refresh, passive default restoration, immediate loading, deduplication, stale reply protection, four-button toolbar, gallery preview/import/select/rename/delete, edit focus across refresh, plain-text names, compact/mirrored layouts, live gradient and warning/offline colors, sandbox, IPC, settings, screenshots.');
  clearTimeout(smokeWatchdog);app.exit(0);
}).catch(error=>{console.error(error);app.exit(1);});
