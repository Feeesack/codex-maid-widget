'use strict';
// Real sandboxed production renderer, synthetic data/IPC only. Never imports
// main, profile readers, user settings, account history, control or updater code.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {pathToFileURL}=require('node:url');
const {app,BrowserWindow,ipcMain}=require('electron');
const root=path.resolve(__dirname,'..');
const runtimeRoot=path.resolve(process.env.CODEX_MAID_RUNTIME_ROOT||root);
const output=path.resolve(process.env.CODEX_MAID_SCREENSHOTS||path.join(root,'tmp/toolbar-ui-check'));
fs.mkdirSync(output,{recursive:true});
const taskHome=fs.mkdtempSync(path.join(os.tmpdir(),'maid-toolbar-ui-'));
for(const name of ['codex','maid','appdata','localappdata','temp','userdata'])fs.mkdirSync(path.join(taskHome,name));
process.env.CODEX_HOME=path.join(taskHome,'codex');process.env.CODEX_MAID_HOME=path.join(taskHome,'maid');
process.env.HOME=process.env.USERPROFILE=taskHome;process.env.APPDATA=path.join(taskHome,'appdata');
process.env.LOCALAPPDATA=path.join(taskHome,'localappdata');process.env.TEMP=process.env.TMP=path.join(taskHome,'temp');
app.setPath('userData',path.join(taskHome,'userdata'));
app.on('window-all-closed',()=>{});
let win,phase='initialization',continuousPathFailure=null,keyboardFailure=null;
const failure=error=>{const assertion=error?.name==='AssertionError'?String(error.message).slice(0,400):null;try{fs.writeFileSync(path.join(output,'toolbar-ui-failure.json'),JSON.stringify({ok:false,phase,continuousPathFailure,keyboardFailure,assertion}));}catch{}console.error('Isolated toolbar UI verification failed during '+phase+'.');app.exit(1);};
process.on('uncaughtException',failure);process.on('unhandledRejection',failure);
const {sanitize,widgetDimensions}=require(path.join(runtimeRoot,'src/settings.cjs'));
const snapshot=require(path.join(runtimeRoot,'src/demo.cjs'))();
let settings=sanitize({mode:'quota',sound:false,autoHideSeconds:.3}),revision=1,lastPointerRegion=null,fixtureVisualPose;
const calls=[];
function state(){return {version:'isolated-toolbar-fixture',settings,settingsRevision:revision,snapshot,demo:true,visualPose:fixtureVisualPose,
  activeCharacterId:'lilac-dragon',characterName:'Isolated fixture',characterUrl:pathToFileURL(path.join(runtimeRoot,'assets/characters/lilac-dragon.png')).href,
  accountManagement:{accounts:[],count:0}};}
function publish(){win.webContents.send('state',state());}
ipcMain.handle('state',()=>state());
ipcMain.handle('refresh',()=>{calls.push('refresh');publish();return snapshot;});
ipcMain.handle('settings',(_event,patch)=>{settings=sanitize({...settings,...patch});revision++;publish();return state();});
ipcMain.handle('action',(_event,name)=>{calls.push(name);});
ipcMain.handle('list-accounts',()=>({accounts:[],count:0}));
for(const channel of ['drag-start','drag-move','drag-end','pointer-region'])ipcMain.on(channel,(_event,value)=>{if(channel==='pointer-region')lastPointerRegion=value;});
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const evaluate=code=>win.webContents.executeJavaScript(code,true);
async function until(callback,timeout=5000){const end=Date.now()+timeout;while(Date.now()<end){if(await callback())return;await pause(25);}throw Error('Fixture condition not reached');}
async function move(x,y){await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseMoved',x,y});await pause(250);}
async function center(id){return evaluate(`(()=>{const r=$(${JSON.stringify(id)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);}
async function click(id){const point=await center(id);await move(point.x,point.y);for(const type of ['mousePressed','mouseReleased'])await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type,...point,button:'left',clickCount:1});await pause(40);}
async function key(name){const code=({Tab:9,Enter:13,Escape:27,' ':32})[name];for(const type of ['keyDown','keyUp'])await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type,key:name,code:name===' '?'Space':name,windowsVirtualKeyCode:code,nativeVirtualKeyCode:code,...(type==='keyDown'&&(name===' '||name==='Enter')?{text:name==='Enter'?'\r':' '}:{} )});await pause(70);}
async function sample(){return evaluate(`(()=>{const toolbar=document.querySelector('.toolbar');return {active:document.activeElement?.id||document.activeElement?.tagName,focusVisible:toolbar.matches(':has(:focus-visible)'),focusWithin:toolbar.matches(':focus-within'),rootHover:$('widget').matches(':hover'),interactiveHover:!!document.querySelector('.interactive:hover'),opacity:Number(getComputedStyle(toolbar).opacity),pointerEvents:getComputedStyle(toolbar).pointerEvents,bubbleHidden:$('bubble').classList.contains('hidden-bubble')};})()`);}
async function hidden(label){await pause(850);const result=await sample();assert.equal(result.opacity,0,label);assert.equal(result.pointerEvents,'none',label+' removes mouse target');return result;}
async function shown(label){await pause(250);const result=await sample();assert.equal(result.opacity,1,label);assert.notEqual(result.pointerEvents,'none',label+' enables controls');return result;}
async function tabToToolbar(){for(let i=0;i<16;i++){await key('Tab');if(await evaluate(`!!document.activeElement?.closest('.toolbar')`))return;}throw Error('Toolbar not keyboard reachable');}
async function clearFocus(){await evaluate(`document.activeElement?.blur();void 0`);await move(-20,-20);}
async function capture(name){win.webContents.invalidate();await pause(100);fs.writeFileSync(path.join(output,name),(await win.webContents.capturePage()).toPNG());}
async function pointerPath(from,to,durationMs,{keepVisible=false}={}){
  const steps=Math.max(1,Math.ceil(durationMs/20)),started=Date.now();let minimumOpacity=1;
  for(let index=1;index<=steps;index++){
    const fraction=index/steps,x=from.x+(to.x-from.x)*fraction,y=from.y+(to.y-from.y)*fraction;
    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseMoved',x,y});await pause(20);
    if(keepVisible){const observed=await sample();minimumOpacity=Math.min(minimumOpacity,observed.opacity);
      if(observed.opacity<.99||observed.pointerEvents==='none'){
        continuousPathFailure={sampleIndex:index,totalSteps:steps,elapsedMs:Date.now()-started,toolbarOpacity:observed.opacity,
          pointerEvents:observed.pointerEvents,interactiveHover:observed.interactiveHover,x,y};
        throw Error('Toolbar became unavailable during the real continuous pointer route');
      }
    }
  }
  return {samples:steps,durationMs:Date.now()-started,minimumOpacity};
}
async function clickCurrent(point,id){
  const before=calls.length;
  assert.equal(await evaluate(`document.elementFromPoint(${point.x},${point.y})?.closest('button')?.id`),id,'continuous route arrives at the actual button');
  for(const type of ['mousePressed','mouseReleased'])await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type,...point,button:'left',clickCount:1});
  await pause(60);
  if(id==='talk')assert.equal(await evaluate(`mode==='phrase'`),true);
  else assert.ok(calls.slice(before).includes(id),'real pointer click invokes the mocked '+id+' action');
}
async function checkContinuousReachability(mirror,scale){
  phase=`continuous pointer route mirror=${mirror},scale=${scale}`;
  await clearFocus();await move(...Object.values(await center('character')));await shown('character reveals before continuous route');
  const geometry=await evaluate(`(()=>{const toolbar=document.querySelector('.toolbar').getBoundingClientRect(),character=$('character').getBoundingClientRect(),refresh=$('refresh').getBoundingClientRect(),unit=$('widget').getBoundingClientRect().width/380;return {toolbar:toolbar.toJSON(),character:character.toJSON(),unit,refreshY:refresh.y+refresh.height/2};})()`);
  const unit=geometry.unit,start={x:geometry.character.x+geometry.character.width/2,y:geometry.refreshY};
  const bridge={x:mirror?geometry.toolbar.right+12*unit:geometry.toolbar.left-12*unit,y:geometry.refreshY};
  const outside={x:mirror?geometry.toolbar.right+25*unit:geometry.toolbar.left-25*unit,y:geometry.refreshY};
  await move(start.x,start.y);const route=await pointerPath(start,bridge,1000,{keepVisible:true});
  await pause(720);
  const expanded=await evaluate(`(()=>{const hit=document.elementFromPoint(${bridge.x},${bridge.y});return {inToolbar:!!hit?.closest('.toolbar'),outsideNav:${bridge.x}<${geometry.toolbar.left}||${bridge.x}>${geometry.toolbar.right},opacity:Number(getComputedStyle(document.querySelector('.toolbar')).opacity)};})()`);
  assert.equal(expanded.outsideNav,true);assert.equal(expanded.inToolbar,true,'expanded hit area owns the bridge outside the visible nav');
  assert.equal(expanded.opacity,1,'a bridge pause longer than the dismissal grace keeps the toolbar usable');
  assert.equal(lastPointerRegion,true);
  let previous=bridge;const clicked=[];
  for(const id of ['refresh','talk','settings','hide']){
    const target=await center(id);await pointerPath(previous,target,id==='refresh'?300:180,{keepVisible:true});
    await clickCurrent(target,id);clicked.push(id);previous=target;
    if(id==='refresh'){
      const next=await center('talk'),gap={x:target.x,y:(target.y+next.y)/2};
      await pointerPath(previous,gap,120,{keepVisible:true});await pause(720);
      const gapHit=await evaluate(`!!document.elementFromPoint(${gap.x},${gap.y})?.closest('.toolbar')`);
      assert.equal(gapHit,true,'button gap is part of the same interactive toolbar');await shown('button gap pause does not dismiss toolbar');previous=gap;
    }
  }
  await pointerPath(previous,bridge,160,{keepVisible:true});
  await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseMoved',...outside});await pause(220);
  const grace=await sample();assert.equal(grace.opacity,1,'short departure keeps a 600 ms return window');assert.equal(lastPointerRegion,false,'outside click-through is immediate');
  await pointerPath(outside,{x:outside.x,y:outside.y+5*unit},700);
  const after=await sample();assert.equal(after.opacity,0,'repeated outside moves do not restart the dismissal timer');assert.equal(after.pointerEvents,'none');
  await hidden('genuine outside departure eventually dismisses toolbar');
  return {mirror,scale,cornerPose:!!fixtureVisualPose,route,expandedBridgePauseMs:720,buttonGapPauseMs:720,clicked,graceMs:600,
    continuousPointerPathClickable:true,expandedToolbarHitArea:true,dismissalGracePeriod:true,eventualDismissal:true};
}
const watchdog=setTimeout(failure,180000);
app.whenReady().then(async()=>{
  try{
    win=new BrowserWindow({...widgetDimensions(),show:false,frame:false,transparent:true,backgroundColor:'#00000000',webPreferences:{
      preload:path.join(runtimeRoot,'src/preload.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false,offscreen:true,backgroundThrottling:false,
      partition:'toolbar-ui-isolated-'+Date.now()}});
    let networkAttempts=0;
    win.webContents.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(_request,done)=>{networkAttempts++;done({cancel:true});});
    win.webContents.on('render-process-gone',failure);
    await win.loadFile(path.join(runtimeRoot,'src/index.html'));
    await until(()=>evaluate(`typeof current==='object'&&current!==null&&$('maid-image').naturalWidth>0`));
    win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
    assert.equal(await evaluate(`typeof process==='undefined'&&typeof require==='undefined'`),true);
    assert.equal(await evaluate(`document.querySelectorAll('.toolbar button').length`),4);
    const cases=[],continuousPaths=[];
    for(const mirror of [false,true])for(const scale of [.6,1,1.6]){
      phase=`mirror=${mirror},scale=${scale}`;win.setSize(...Object.values(widgetDimensions(scale)));await pause(80);
      const unit=widgetDimensions(scale).width/380;
      fixtureVisualPose=scale===1?{offset:{x:(mirror?-48:48)*unit,y:56*unit},moving:false}:undefined;
      settings=sanitize({...settings,mirror,mode:'quota',autoHideSeconds:.3});revision++;publish();await pause(80);
      await clearFocus();await hidden('initially hidden');
      const blank={x:5*scale*.6,y:5*scale*.6};await move(blank.x,blank.y);
      const rootBlank=await hidden('root transparent padding is not a trigger');
      assert.equal(rootBlank.rootHover,true);assert.equal(rootBlank.interactiveHover,false);assert.equal(lastPointerRegion,false);
      await move(-20,-20);await hidden('leave blank');
      const hit=await evaluate(`(()=>{const r=$('refresh').getBoundingClientRect(),target=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2),toolbar=document.querySelector('.toolbar');return {buttonHit:!!target?.closest('.toolbar'),focusable:$('refresh').tabIndex>=0&&!$('refresh').disabled,inert:toolbar.inert};})()`);
      assert.equal(hit.buttonHit,false,'hidden toolbar must not intercept a mouse hit');assert.equal(hit.focusable,true);assert.equal(hit.inert,false,'hidden toolbar remains keyboard reachable');
      for(const id of ['refresh','talk']){
        await move(...Object.values(await center('character')));await shown('character hover reveals toolbar');
        await click(id);await move(-20,-20);await pause(450);
        const left=await hidden('mouse click then leave does not pin toolbar');
        assert.equal(left.focusVisible,false);
        assert.equal(left.bubbleHidden,true,'bubble timeout is independent and still works');
      }
      continuousPaths.push(await checkContinuousReachability(mirror,scale));
      phase=`keyboard mirror=${mirror},scale=${scale}`;
      await clearFocus();await tabToToolbar();const keyboard=await shown('Tab focus reveals toolbar');assert.equal(keyboard.focusVisible,true);
      const focused=keyboard.active,beforeEnter=calls.filter(value=>value==='refresh').length;
      await evaluate(`window.fixtureKeyEvents=[];document.addEventListener('keydown',event=>fixtureKeyEvents.push({key:event.key,target:event.target.id,defaultPrevented:event.defaultPrevented}));void 0`);
      await key('Enter');await shown('Enter preserves keyboard access');
      if(focused==='refresh') {keyboardFailure={key:'Enter',before:beforeEnter,after:calls.filter(value=>value==='refresh').length,observed:await sample(),events:await evaluate(`fixtureKeyEvents`)};assert.equal(calls.filter(value=>value==='refresh').length,beforeEnter+1);}
      const beforeSpace=calls.filter(value=>value==='refresh').length;
      await key(' ');await shown('Space preserves keyboard access');
      if(focused==='refresh') {keyboardFailure={key:'Space',before:beforeSpace,after:calls.filter(value=>value==='refresh').length,observed:await sample(),events:await evaluate(`fixtureKeyEvents`)};assert.equal(calls.filter(value=>value==='refresh').length,beforeSpace+1);}
      keyboardFailure=null;
      await key('Escape');const escapeObservation=await sample();
      for(let i=0;i<5&&await evaluate(`!!document.activeElement?.closest('.toolbar')`);i++)await key('Tab');
      await hidden('Tab leaving toolbar dismisses it');
      cases.push({mirror,scale,mouseClicksDoNotPin:true,transparentRootIgnored:true,hiddenMouseHitDisabled:true,tabReachable:true,keyboardActivationPreserved:true,escapeObservation,tabAwayDismisses:true});
    }
    phase='blur and hidden lifecycle';
    settings=sanitize({...settings,mirror:false});revision++;publish();await clearFocus();await tabToToolbar();await shown('before window blur');
    const lifecycle=[];
    await evaluate(`window.dispatchEvent(new Event('blur'));`);lifecycle.push({event:'window-blur',...await sample()});
    await evaluate(`Object.defineProperty(document,'hidden',{configurable:true,get:()=>true});document.dispatchEvent(new Event('visibilitychange'));void 0`);
    lifecycle.push({event:'document-hidden',...await sample()});
    await evaluate(`delete document.hidden;document.dispatchEvent(new Event('visibilitychange'));void 0`);lifecycle.push({event:'document-restored',...await sample()});
    win.webContents.send('presence',{visible:false});await until(()=>evaluate(`document.body.classList.contains('presence-hidden')`));
    win.webContents.send('presence',{visible:true});await until(()=>evaluate(`!document.body.classList.contains('presence-hidden')`));
    lifecycle.push({event:'presence-hide-restore',...await sample()});
    // The fixture remains an invisible offscreen surface for its whole life.
    // Observe hide only; never show a temporary native window to the user.
    win.hide();await pause(100);await move(-20,-20);
    lifecycle.push({event:'native-hide-only',...await sample()});await clearFocus();await hidden('cleared keyboard focus after lifecycle');
    await capture('toolbar-hidden-after-leave.png');
    await move(...Object.values(await center('character')));await shown('hover remains usable after lifecycle');await capture('toolbar-visible-on-interaction.png');
    const report={ok:true,runtimeRoot,fixtureCases:cases.length,cases,continuousPaths,lifecycleObservations:lifecycle,
      continuousPointerPathClickable:true,expandedToolbarHitArea:true,dismissalGracePeriod:true,eventualDismissal:true,graceMs:600,
      mouseClickDoesNotPin:true,transparentPaddingDoesNotReveal:true,hiddenToolbarDoesNotIntercept:true,
      keyboardTabReveals:true,keyboardActivationRetainsVisibility:true,keyboardTabExitHides:true,mirroredScaled:true,fixturesOnly:true,
      productionRenderer:true,sandboxedPreload:true,isolatedDataDependencies:true,networkRequestsBlocked:true,networkAttempts,
      fixtureNativeWindowShown:false,realMainStarted:false,realAuthenticationRead:false,realUserSettingsRead:false,realWidgetInteracted:false,realSoundPlayed:false,toolbarButtons:4};
    fs.writeFileSync(path.join(output,'toolbar-ui-check.json'),JSON.stringify(report,null,2)+'\n');
    console.log('PASS: isolated production toolbar hover, mouse-focus dismissal, transparent root, hidden hit-testing, keyboard access, mirror/scale and lifecycle regression.');
    clearTimeout(watchdog);win.destroy();win=null;app.quit();
  }catch(error){failure(error);}
});
