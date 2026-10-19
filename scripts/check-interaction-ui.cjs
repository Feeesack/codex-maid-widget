'use strict';
// Invisible production renderer with fixture IPC only. No main process, profile
// reader, data-home helper, updater, real control endpoint or audio is loaded.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {pathToFileURL}=require('node:url');
const root=path.resolve(__dirname,'..'),runtimeRoot=path.resolve(process.env.CODEX_MAID_RUNTIME_ROOT||root);
const output=path.resolve(process.env.CODEX_MAID_SCREENSHOTS||path.join(root,'tmp/interaction-ui-check'));
const taskHome=fs.mkdtempSync(path.join(os.tmpdir(),'maid-interaction-ui-'));
for(const name of ['codex','maid','appdata','localappdata','temp','userdata'])fs.mkdirSync(path.join(taskHome,name));
process.env.CODEX_HOME=path.join(taskHome,'codex');process.env.CODEX_MAID_HOME=path.join(taskHome,'maid');
process.env.HOME=process.env.USERPROFILE=taskHome;process.env.APPDATA=path.join(taskHome,'appdata');
process.env.LOCALAPPDATA=path.join(taskHome,'localappdata');process.env.TEMP=process.env.TMP=path.join(taskHome,'temp');
const {app,BrowserWindow,ipcMain}=require('electron');
app.setPath('userData',path.join(taskHome,'userdata'));
if(process.env.GITHUB_ACTIONS==='true')app.disableHardwareAcceleration();
const {sanitize,widgetDimensions,readSettings,writeSettings}=require(path.join(runtimeRoot,'src/settings.cjs'));
const snapshot=require(path.join(runtimeRoot,'src/demo.cjs'))();
let settings=sanitize({mode:'quota',sound:false,autoHideSeconds:0}),revision=1,win,phase='startup',networkAttempts=0;
const settingsFile=path.join(taskHome,'maid','settings.json');
writeSettings(settingsFile,settings);
const calls=[],errors=[];
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function state(){return {version:'isolated-interaction-fixture',settings,settingsRevision:revision,snapshot,demo:true,
  activeCharacterId:'lilac-dragon',characterName:'Isolated fixture',characterUrl:pathToFileURL(path.join(runtimeRoot,'assets/characters/lilac-dragon.png')).href,
  accountManagement:{accounts:[],count:0}};}
function publish(){win.webContents.send('state',state());}
ipcMain.handle('state',()=>state());
ipcMain.handle('refresh',()=>{calls.push('refresh');return snapshot;});
ipcMain.handle('settings',(_event,patch)=>{writeSettings(settingsFile,{...settings,...patch});settings=readSettings(settingsFile);revision++;publish();return state();});
ipcMain.handle('action',(_event,name)=>calls.push(name));
ipcMain.handle('list-accounts',()=>({accounts:[],count:0}));
for(const channel of ['drag-start','drag-move','drag-end','pointer-region'])ipcMain.on(channel,()=>{if(channel!=='pointer-region')calls.push(channel);});
const evaluate=code=>win.webContents.executeJavaScript(code,true);
async function until(condition,timeout=5000){const end=Date.now()+timeout;while(Date.now()<end){win.webContents.invalidate();if(await condition())return;await pause(20);}throw Error('Fixture condition timed out');}
const mouse=(type,point,buttons=0)=>win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type,...point,
  ...(type==='mouseMoved'?{buttons}:{button:'left',buttons,clickCount:1})});
async function key(type,name,autoRepeat=false){const code=({' ':32,Enter:13,q:81})[name];await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{
  type,key:name,code:name===' '?'Space':name==='q'?'KeyQ':'Enter',windowsVirtualKeyCode:code,nativeVirtualKeyCode:code,autoRepeat});}
const center=id=>evaluate(`(()=>{const r=$(${JSON.stringify(id)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
async function sample(){win.webContents.invalidate();await win.webContents.capturePage();return evaluate(`(()=>{
  const matrix=id=>{const m=new DOMMatrix(getComputedStyle($(id)).transform);return [m.a,m.b,m.c,m.d,m.e,m.f];};
  return {character:matrix('character'),bubble:matrix('bubble-motion'),pressed:[$('character'),$('bubble-motion')].map(el=>el.classList.contains('interaction-pressed')),
    toolbar:document.querySelector('.toolbar').getBoundingClientRect().toJSON(),readable:getComputedStyle($('bubble')).scale!=='-1 1',
    moving:current?.visualPose?.moving===true,phraseIndex,transition:getComputedStyle($('character')).transitionProperty};})()`);}
const matrixDifference=(a,b)=>Math.max(...a.map((value,index)=>Math.abs(value-b[index])));
function assertRest(value,label){for(const id of ['character','bubble'])assert.ok(matrixDifference(value[id],[1,0,0,1,0,0])<.002,label+': '+id+' returns to rest '+JSON.stringify({matrix:value[id],pressed:value.pressed}));assert.deepEqual(value.pressed,[false,false],label+': no stuck pressed state');}
function assertToolbar(before,after,label){for(const key of ['x','y','width','height'])assert.ok(Math.abs(before.toolbar[key]-after.toolbar[key])<.15,label+': toolbar '+key+' stays fixed');}
async function settled(label){await sample();await pause(320);const value=await sample();assertRest(value,label);return value;}
async function press(point){await mouse('mouseMoved',point);await mouse('mousePressed',point,1);}
async function release(point){await mouse('mouseReleased',point);}
async function capture(name){fs.writeFileSync(path.join(output,name),(await win.webContents.capturePage()).toPNG());}
function fail(error){try{fs.mkdirSync(output,{recursive:true});fs.writeFileSync(path.join(output,'interaction-ui-failure.json'),JSON.stringify({ok:false,phase,error:String(error?.message||error),errors},null,2));}catch{}console.error('Isolated interaction UI check failed at '+phase+': '+String(error?.message||error));app.exit(1);}
process.on('uncaughtException',fail);process.on('unhandledRejection',fail);
const watchdog=setTimeout(()=>fail(Error('watchdog timeout')),150000);
app.whenReady().then(async()=>{
  try{
    fs.mkdirSync(output,{recursive:true});
    win=new BrowserWindow({...widgetDimensions(),show:false,frame:false,transparent:true,backgroundColor:'#00000000',webPreferences:{
      preload:path.join(runtimeRoot,'src/preload.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false,offscreen:true,backgroundThrottling:false,
      partition:'interaction-ui-isolated-'+Date.now()}});
    win.webContents.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(_request,done)=>{networkAttempts++;done({cancel:true});});
    win.webContents.on('console-message',(_event,details)=>{if(details.level==='error')errors.push(details.message);});
    win.webContents.on('preload-error',(_event,_path,error)=>errors.push(String(error.message)));
    await win.loadFile(path.join(runtimeRoot,'src/index.html'));win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
    await until(()=>evaluate(`typeof current==='object'&&current!==null&&$('maid-image').naturalWidth>0`));
    assert.equal(await evaluate(`typeof process==='undefined'&&typeof require==='undefined'`),true);
    await evaluate(`window.soundAttempts=0;window.AudioContext=class {constructor(){soundAttempts++;throw Error('fixture prevents audio');}};
      window.interactionEvents=[];for(const type of ['pointerdown','pointerup'])document.addEventListener(type,event=>{
        if(!event.target.closest('#character,#talk'))return;const read=id=>{const m=new DOMMatrix(getComputedStyle($(id)).transform);return [m.a,m.b,m.c,m.d,m.e,m.f];};
        const before=[read('character'),read('bubble-motion')];queueMicrotask(()=>interactionEvents.push({type,trusted:event.isTrusted,before,after:[read('character'),read('bubble-motion')]}));
      },true);void 0`);
    const cases=[];
    for(const mirror of [false,true])for(const scale of [.6,1,1.6]){
      phase='hold and rapid taps mirror='+mirror+', scale='+scale;
      win.setSize(...Object.values(widgetDimensions(scale)));settings=sanitize({...settings,mirror,mode:'quota'});revision++;publish();await pause(400);
      const point=await center('character');await mouse('mouseMoved',point);await pause(260);
      const baseline=await sample();await press(point);await pause(280);const held=await sample();
      assert.deepEqual(held.pressed,[true,true]);assert.ok(Math.abs(held.character[0]-1.05)<.002&&Math.abs(held.character[3]-.88)<.002,'long press settles compressed');
      assert.ok(Math.abs(held.bubble[0]-1.015)<.002&&Math.abs(held.bubble[3]-.96)<.002&&Math.abs(held.bubble[5]-8)<.05,'bubble follows the same held gesture');
      assertToolbar(baseline,held,'press');await release(point);assert.deepEqual((await sample()).pressed,[false,false],'release is immediate');
      assertToolbar(baseline,await settled('long press release'),'release');
      if(!mirror&&scale===1){await press(point);await pause(280);await capture('interaction-held.png');await release(point);await settled('capture release');}
      const rapid=[];
      for(const intervalMs of [30,60,120]){
        await evaluate(`interactionEvents.length=0;void 0`);
        for(let tap=0;tap<7;tap++){await mouse('mousePressed',point,1);await pause(8);await mouse('mouseReleased',point);await pause(Math.max(0,intervalMs-8));}
        const events=await evaluate(`interactionEvents`),downs=events.filter(event=>event.type==='pointerdown');
        assert.equal(downs.length,7,'every trusted rapid tap reaches the character');assert.ok(events.every(event=>event.trusted),'input comes from CDP rather than synthetic DOM dispatch');
        for(const event of downs.slice(1))for(let index=0;index<2;index++)assert.ok(matrixDifference(event.before[index],event.after[index])<.025,'rapid pointerdown preserves the displayed transform');
        const final=await settled('rapid '+intervalMs+' ms');assertToolbar(baseline,final,'rapid taps');
        rapid.push({intervalMs,taps:7,continuous:true,returnedToRest:true});
      }
      cases.push({mirror,scale,longHold:true,bubbleSynchronized:true,toolbarFixed:true,rapid});
    }
    phase='keyboard hold, repeat and focused activation';
    settings=sanitize({...settings,mirror:false});revision++;publish();win.setSize(...Object.values(widgetDimensions()));await pause(350);
    const keyboard=[];
    await evaluate(`$('character').focus();void 0`);
    for(const name of ['q',' ','Enter']){
      await key('keyDown',name);await pause(280);assert.deepEqual((await sample()).pressed,[true,true],name+' holds');
      const startedAt=await evaluate(`interactionPressedAt`);for(let repeat=0;repeat<3;repeat++)await key('keyDown',name,true);
      assert.equal(await evaluate(`interactionPressedAt`),startedAt,'key repeat does not restart the press');
      await key('keyUp',name);await settled('key '+name+' release');keyboard.push({key:name,hold:true,repeatIgnored:true});
    }
    await evaluate(`$('character').blur();document.body.focus();void 0`);await key('keyDown','Enter');
    assert.deepEqual((await sample()).pressed,[false,false],'Enter only activates a focused character');await key('keyUp','Enter');
    const talkPoint=await center('talk');await mouse('mouseMoved',await center('character'));await pause(250);
    await evaluate(`setMode('phrase',false);void 0`);const phraseBefore=await evaluate(`phraseIndex`),phraseCount=await evaluate(`current.settings.phrases.length`);
    await mouse('mouseMoved',talkPoint);await mouse('mousePressed',talkPoint,1);await pause(90);assert.deepEqual((await sample()).pressed,[true,true]);
    await mouse('mouseReleased',talkPoint);await settled('talk release');assert.equal(await evaluate(`phraseIndex`),(phraseBefore+1)%phraseCount,'pointer talk click advances once');
    phase='drag, capture loss and cancellation';
    const point=await center('character');await evaluate(`$('character').focus();void 0`);const phraseAtDrag=await evaluate(`phraseIndex`);
    await press(point);await mouse('mouseMoved',{x:point.x+18,y:point.y+8},1);await release({x:point.x+18,y:point.y+8});await settled('drag');
    assert.equal(await evaluate(`phraseIndex`),phraseAtDrag,'drag does not trigger a character click');assert.ok(calls.includes('drag-move'));
    // Offscreen CDP does not route events outside the viewport. Returning with
    // buttons=0 exercises the real lost-pointerup recovery path; it does not
    // claim to verify native cross-window pointer capture.
    await press(point);await mouse('mouseMoved',{x:-20,y:-20},1);await release({x:-20,y:-20});
    await mouse('mouseMoved',point,0);await settled('missed pointerup recovery');
    assert.equal(await evaluate(`phraseIndex`),phraseAtDrag,'recovering a lost pointerup does not click');
    // Chromium's never-shown offscreen surface does not establish native mouse
    // capture (confirmed by hasPointerCapture=false after trusted pointerdown).
    // Exercise the handler explicitly and report this boundary separately.
    await press(point);await evaluate(`$('character').dispatchEvent(new PointerEvent('lostpointercapture',{pointerId:1}));void 0`);
    await release(point);await settled('capture loss handler');
    assert.equal(await evaluate(`phraseIndex`),phraseAtDrag,'lost capture does not click');
    await win.webContents.debugger.sendCommand('Emulation.setTouchEmulationEnabled',{enabled:true});
    await win.webContents.debugger.sendCommand('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{...point,id:7}]});await pause(80);
    assert.deepEqual((await sample()).pressed,[true,true],'touch must actually press before testing cancellation');
    await win.webContents.debugger.sendCommand('Input.dispatchTouchEvent',{type:'touchCancel',touchPoints:[]});await settled('touch cancellation');
    assert.equal(await evaluate(`phraseIndex`),phraseAtDrag,'pointer cancellation does not click');
    await win.webContents.debugger.sendCommand('Emulation.setTouchEmulationEnabled',{enabled:false});
    phase='blur and live system motion changes';
    await key('keyDown','q');await evaluate(`window.dispatchEvent(new Event('blur'));void 0`);await key('keyUp','q');await settled('blur');
    const mediaMotion=async systemReduced=>{
      await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:systemReduced?'reduce':'no-preference'}]});
      await until(()=>evaluate(`matchMedia('(prefers-reduced-motion: reduce)').matches===${systemReduced}`));
    };
    await press(point);await pause(280);
    for(const systemReduced of [true,false]){
      const before=await sample();await mediaMotion(systemReduced);const after=await sample();
      assert.deepEqual(after.pressed,[true,true],'an OS motion change preserves the held pose');
      assert.ok(matrixDifference(before.character,after.character)<.002,'an OS motion change does not reset compression');
      assertToolbar(before,after,'live system motion change');
    }
    await release(point);await settled('system motion change during hold');
    assert.equal(await evaluate(`soundAttempts`),0);
    phase='always-on animation with ignored legacy storage';
    const legacyAnimationMatrix=[];
    for(const legacyValue of ['system','full','reduced'])for(const systemReduced of [false,true]){
      await mediaMotion(systemReduced);
      fs.writeFileSync(settingsFile,JSON.stringify({...settings,animationMode:legacyValue}));
      settings=readSettings(settingsFile);revision++;publish();
      assert.equal(Object.hasOwn(settings,'animationMode'),false,'legacy animation preferences are discarded on read');
      await until(()=>evaluate(`!Object.hasOwn(current.settings,'animationMode')`));
      const pointForPolicy=await center('character');
      await mouse('mouseMoved',pointForPolicy);await pause(260);
      const before=await sample();
      await press(pointForPolicy);await pause(280);const held=await sample();
      assert.deepEqual(held.pressed,[true,true],legacyValue+' / '+systemReduced+' keeps animation enabled');
      assert.ok(Math.abs(held.character[3]-.88)<.002,'CSS compression remains enabled');
      assertToolbar(before,held,'always-on animation');await release(pointForPolicy);await settled('legacy storage release');
      const effects=await evaluate(`({shimmer:document.querySelector('.quota-value').getAnimations().some(a=>a.animationName==='quotaShimmer'),breathing:$('maid-image').getAnimations().some(a=>a.animationName==='breathe'),transition:getComputedStyle($('character')).transitionDuration})`);
      assert.equal(effects.shimmer,true,'quota shimmer remains enabled');assert.equal(effects.breathing,true,'breathing remains enabled');
      assert.notEqual(effects.transition,'0s','transform transitions remain enabled');
      assert.equal(Object.hasOwn(readSettings(settingsFile),'animationMode'),false);
      assert.equal(readSettings(settingsFile).sound,false,'always-on animation does not unmute audio');
      // Restart the renderer against the persisted state instead of relying on
      // a synthetic current object. The fixture never reads real user settings.
      await new Promise(resolve=>{win.webContents.once('did-finish-load',resolve);win.webContents.reload();});
      await until(()=>evaluate(`current!==null&&!Object.hasOwn(current.settings,'animationMode')&&$('maid-image').naturalWidth>0`));
      assert.equal(await evaluate(`document.querySelector('.quota-value').getAnimations().some(a=>a.animationName==='quotaShimmer')`),true,'always-on shimmer survives reload');
      legacyAnimationMatrix.push({legacyValue,systemReduced,ignoredOnRead:true,pressAndShimmer:true,reloadedWithAnimation:true});
    }
    phase='drag audio keeps press and release';
    await mediaMotion(false);
    // Trace a local, in-memory audio graph. Trusted pointer input and repeated
    // production native-pose updates exercise the original cancellation bug.
    await evaluate(`window.dragAudio={time:10,sources:[],decodes:0};window.AudioContext=class {
      state='running';destination={};get currentTime(){return dragAudio.time;}resume(){return Promise.resolve();}
      decodeAudioData(){return Promise.resolve({duration:.15,name:dragAudio.decodes++%2?'release':'press'});}
      createGain(){return {gain:{setValueAtTime(){},linearRampToValueAtTime(){},cancelAndHoldAtTime(){}},connect(){},disconnect(){}};}
      createBufferSource(){const source={buffer:null,stops:[],connect(){},disconnect(){},start(at){this.at=at;dragAudio.sources.push(this);},stop(at){this.stops.push(at);}};return source;}
    };void 0`);
    settings=sanitize({...settings,sound:true,interactionSound:require(path.join(runtimeRoot,'src/interaction-sound-catalog.js')).defaultId});revision++;publish();await until(()=>evaluate(`current.settings.sound===true`));
    await evaluate(`interactionSound.prepare()`);
    const dragAudioCases=[],audioPhraseBefore=await evaluate(`phraseIndex`);
    for(const holdSeconds of [.02,.32]){
      await evaluate(`dragAudio.time=10;void 0`);const before=await evaluate(`dragAudio.sources.length`);
      await press(point);await mouse('mouseMoved',{x:point.x+18,y:point.y+8},1);
      await evaluate(`current.visualPose={moving:true,offset:{x:0,y:0}};for(let i=0;i<3;i++)applyVisualPose();void 0`);
      for(const systemReduced of [true,false]){
        await mediaMotion(systemReduced);await sample();
        const live=await evaluate(`({held:interactionHeld,pressed:[$('character'),$('bubble-motion')].every(node=>node.classList.contains('interaction-pressed')),starts:dragAudio.sources.length,stops:dragAudio.sources[${before}]?.stops.length})`);
        assert.equal(live.held,true);assert.equal(live.pressed,true,'OS changes do not cancel a held drag');
        assert.equal(live.starts,before+1);assert.equal(live.stops,0,'OS changes neither restart nor stop held audio');
      }
      await sample();await pause(250);
      const held=await evaluate(`({held:interactionHeld,pressed:[$('character'),$('bubble-motion')].every(node=>node.classList.contains('interaction-pressed')),scale:new DOMMatrix(getComputedStyle($('character')).transform).d,starts:dragAudio.sources.length,stops:dragAudio.sources[${before}]?.stops.length})`);
      assert.equal(held.held,true,'drag retains the held sound gesture');assert.equal(held.pressed,true,'drag retains visual compression');
      assert.ok(Math.abs(held.scale-.88)<.002,'moving pose updates keep the pressed shape');
      assert.equal(held.starts,before+1);assert.equal(held.stops,0,'moving never stops the press sound');
      await evaluate(`dragAudio.time=${10+holdSeconds};void 0`);await release({x:point.x+18,y:point.y+8});
      const released=await evaluate(`({held:interactionHeld,sources:dragAudio.sources.slice(${before}).map(source=>({name:source.buffer.name,at:source.at,stops:source.stops.length}))})`);
      assert.equal(released.held,false);assert.deepEqual(released.sources.map(source=>source.name),['press','release']);
      assert.equal(released.sources[0].stops,0,'press finishes naturally after dragging');
      assert.ok(Math.abs(released.sources[1].at-Math.max(10+holdSeconds,10.11))<.00001,'drag release follows the same audio-clock join');
      assert.equal(await evaluate(`phraseIndex`),audioPhraseBefore,'drag audio does not introduce a click action');
      dragAudioCases.push({holdSeconds,pressedPosePreserved:true,pressUninterrupted:true,releasePlayed:true});
      await evaluate(`delete current.visualPose;applyVisualPose();void 0`);await settled('audio drag release');
    }
    settings=sanitize({...settings,sound:false});revision++;publish();await until(()=>evaluate(`current.settings.sound===false`));
    const mutedBefore=await evaluate(`dragAudio.sources.length`);await press(point);await mouse('mouseMoved',{x:point.x+18,y:point.y+8},1);await release({x:point.x+18,y:point.y+8});
    assert.equal(await evaluate(`dragAudio.sources.length`),mutedBefore,'mute also suppresses both phases during drag');
    assert.deepEqual(errors,[]);assert.equal(networkAttempts,0);
    const report={ok:true,runtimeRoot,cases,keyboard,realPointerAndKeyboardInput:true,rapidReentryContinuous:true,releaseImmediate:true,
      dragDoesNotClick:true,missedPointerUpRecovered:true,nativeOutsideWindowReleaseVerified:false,lostCaptureHandlerVerified:true,nativeCaptureLossVerified:false,pointerCancelDoesNotClick:true,
      animationsAlwaysEnabled:true,legacyAnimationSettingsIgnored:true,legacyAnimationMatrix,liveSystemMotionPreservesHeldPose:true,liveSystemMotionPreservesHeldAudio:true,
      talkAdvancesOnce:true,fixturesOnly:true,isolatedDataDependencies:true,productionRenderer:true,sandboxedPreload:true,
      dragPressedPosePreserved:true,dragPressAudioPreserved:true,dragReleaseAudioPlayed:true,dragAudioCases,mutedDragSilent:true,audioGraphMocked:true,
      networkRequestsBlocked:true,networkAttempts,fixtureNativeWindowShown:false,realMainStarted:false,realAuthenticationRead:false,
      realUserSettingsRead:false,realWidgetInteracted:false,realSoundPlayed:false};
    await capture('interaction-final-always-on-animation.png');fs.writeFileSync(path.join(output,'interaction-ui-check.json'),JSON.stringify(report,null,2)+'\n');
    console.log('PASS: isolated production interaction hold/release, rapid-tap continuity, keyboard repeat, drag/cancel, mirror/scale, synchronized bubble, fixed toolbar and always-on animation.');
    clearTimeout(watchdog);win.destroy();win=null;app.quit();
  }catch(error){fail(error);}
});
