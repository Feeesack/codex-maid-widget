'use strict';
require('./stdio-errors.cjs').installOutputErrorHandlers();
// Exercise the real sandboxed renderer/preload at the shipped size and both orientations.
const { app, BrowserWindow, ipcMain, nativeImage } = require('electron');
// Hosted Windows runners can lose their virtual GPU while reading offscreen
// frames. Exercise the same renderer through the software compositor in CI.
if (process.platform === 'win32' && process.env.GITHUB_ACTIONS === 'true') app.disableHardwareAcceleration();
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { sanitize, widgetDimensions } = require('../src/settings.cjs');
const { CharacterLibrary } = require('../src/character-library.cjs');
const root=path.join(__dirname,'..');
let smokePhase = 'starting Electron';
const smokeWatchdog = setTimeout(() => { console.error('UI smoke timed out during: ' + smokePhase); app.exit(1); }, 180000);
const markPhase = value => { smokePhase = value; console.log('CHECK: ' + value); };
const screenshotDirectory = process.env.CODEX_MAID_SCREENSHOTS || path.join(root, 'docs', 'screenshots');
const testHome=fs.mkdtempSync(path.join(os.tmpdir(),'maid-gallery-ui-'));
app.setPath('userData',testHome);
const library=new CharacterLibrary({dataDir:testHome,assetRoot:path.join(root,'assets')});
let settings=sanitize({sound:false}), win, refreshes=0;
let cornerDock={corner:null,peeking:false},visualPose;
const snapshot=require('../src/demo.cjs')();
const pause = ms => new Promise(resolve=>setTimeout(resolve,ms));
function state(){const characters=library.list();const active=library.get(settings.activeCharacterId)||library.get(library.defaultId);return {settings,snapshot,cornerDock,visualPose,demo:true,version:require('../package.json').version,characters,activeCharacterId:active.id,characterUrl:active.url,characterName:active.name};}
async function publish(patch={}) { settings=sanitize({...settings,...patch});win.webContents.send('state',state());await pause(100); }
let firstStateRequest = true;
ipcMain.handle('state',async()=>{
  // Exercise a real IPC response that arrives later than the old one-second wait.
  if (firstStateRequest) { firstStateRequest = false; await pause(1250); }
  return state();
});
ipcMain.handle('settings',(_event,patch)=>{settings=sanitize({...settings,...patch});win.webContents.send('state',state());return state();});
ipcMain.handle('refresh',()=>{refreshes++;return snapshot;});
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
  // Layout assertions compare resting geometry. Hidden offscreen surfaces can
  // defer their first transition frame until capturePage requests a paint.
  await evaluate(`(()=>{for(const id of ['bubble','bubble-content','dot-one','dot-two']){const el=document.getElementById(id)||document.querySelector('.'+id);void el.offsetWidth;for(const animation of el.getAnimations())if(animation instanceof CSSTransition)animation.finish();}return document.getElementById('bubble').getBoundingClientRect().width;})()`);
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
async function themeColors() {
  return evaluate(`({outline:getComputedStyle(document.querySelector('.bubble-outline path')).stroke,fill:getComputedStyle(document.querySelector('.bubble-outline stop:last-child')).stopColor,title:getComputedStyle(document.querySelector('.bubble header')).color,details:getComputedStyle(document.querySelector('.quota-details')).color,progress:getComputedStyle(document.getElementById('primary-bar')).backgroundImage,shimmer:getComputedStyle(document.querySelector('.quota-value')).backgroundImage,pill:getComputedStyle(document.getElementById('cycle')).backgroundColor})`);
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
async function checkBubbleMotion(capture) {
  const visualState = () => evaluate(`Object.fromEntries(['bubble','bubble-content','dot-one','dot-two','character'].map(id=>{const el=document.getElementById(id)||document.querySelector('.'+id),s=getComputedStyle(el),r=el.getBoundingClientRect();return [id,{x:r.x,y:r.y,width:r.width,height:r.height,opacity:Number(s.opacity),scale:parseFloat(s.scale)||1,inert:el.inert,ariaHidden:el.getAttribute('aria-hidden'),pointerEvents:s.pointerEvents}]}))`);
  const sampleBounce = time => evaluate(`(()=>{for(const id of ['character','bubble-motion']){const animation=document.getElementById(id).getAnimations()[0];if(!animation)throw new Error('Missing bounce for '+id);animation.pause();animation.currentTime=${time};}return true;})()`);
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
  // Scrub both real CSS animations together to check the compression, rise and
  // settling positions without depending on the offscreen compositor's clock.
  for(const mirror of [false,true]) {
    await publish({mirror});
    const rest=await visualState();
    await evaluate(`bounce()`);
    await sampleBounce(0);
    const start=await visualState();
    for(const id of Object.keys(rest))assert.ok(Math.abs(start[id].y-rest[id].y)<.1,`${id} starts at rest`);
    for(const [time,direction] of [[117,1],[273,-1],[429,1]]) {
      await sampleBounce(time);
      const frame=await visualState();
      for(const id of Object.keys(rest))assert.ok((frame[id].y-rest[id].y)*direction>.5,`${mirror?'left':'right'} ${id} follows the character at ${time} ms`);
      assert.equal(await readable(),true,'animated mirrored content remains readable');
      if(!mirror&&time===273)await capture('bubble-motion-rise.png');
    }
    await evaluate(`window.__smokeBounceRefs=['character','bubble-motion'].map(id=>document.getElementById(id).getAnimations()[0]);bounce()`);
    const restarted=await evaluate(`['character','bubble-motion'].every((id,index)=>{const animation=document.getElementById(id).getAnimations()[0];return animation&&animation!==window.__smokeBounceRefs[index]&&(animation.currentTime||0)<100;})`);
    assert.equal(restarted,true,'a repeated click restarts both bounce animations');
    await sampleBounce(0);
    const restartedStart=await visualState();
    for(const id of Object.keys(rest))assert.ok(Math.abs(restartedStart[id].y-rest[id].y)<.1,`${id} restarts from rest`);
    await sampleBounce(650);
    await evaluate(`for(const id of ['character','bubble-motion'])for(const animation of (document.getElementById(id)||document.querySelector('.'+id)).getAnimations())animation.finish()`);
    // animationend arrives on a compositor update, which can be delayed for a
    // hidden surface on a hosted runner.
    for (let attempt=0;attempt<40;attempt++) {
      if (await evaluate(`['character','bubble-motion'].every(id=>!document.getElementById(id).classList.contains('bounce'))`)) break;
      await pause(50);
    }
    assert.equal(await evaluate(`['character','bubble-motion'].every(id=>!document.getElementById(id).classList.contains('bounce'))`),true,'both bounce classes clear at completion');
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
  const viewport = () => evaluate(`({width:innerWidth,height:innerHeight,htmlOverflow:getComputedStyle(document.documentElement).overflow,bodyOverflow:getComputedStyle(document.body).overflow,peeking:document.getElementById('widget').classList.contains('is-corner-peeking'),moving:document.getElementById('widget').classList.contains('is-moving'),imageScale:getComputedStyle(document.getElementById('maid-image')).scale,translateAnimations:['character','bubble-motion'].reduce((count,id)=>count+document.getElementById(id).getAnimations().filter(animation=>animation instanceof CSSTransition&&animation.transitionProperty==='translate').length,0),bodyAnimations:document.getElementById('maid-image').getAnimations().length,characterTransition:getComputedStyle(document.getElementById('character')).transitionProperty,bubbleTransitionDuration:getComputedStyle(document.getElementById('bubble-motion')).transitionDuration})`);
  const pose = async (offset,moving=false,corner=null,peeking=false) => {cornerDock={corner,peeking};visualPose={offset,moving};await publish();};
  const assertPosition = (actual,full,offset,label) => {
    for(const id of ['character','bubble','dot-one','dot-two']) {
      assert.ok(Math.abs(actual[id].y-full[id].y-offset.y)<.2,`${label}: ${id} tracks the supplied vertical pose without a CSS lag`);
      const x=id==='character'?offset.x:0;
      assert.ok(Math.abs(actual[id].x-full[id].x-x)<.2,`${label}: ${id} uses the correct side offset`);
    }
    for(const id of ['toolbar','notice','demo-label'])assert.deepEqual(actual[id],full[id],`${label}: ${id} stays in place`);
  };
  await publish({peekAtCorners:true,autoHideSeconds:0,mode:'quota'});
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
        assert.equal(after.imageScale,mirror?'-1 1':'none','peeking preserves the character orientation');
        assert.ok(!after.characterTransition.includes('translate'),'character translation has no second interpolation');
        assert.equal(after.bubbleTransitionDuration,'0s','bubble motion has no second interpolation');
        if(scale===1.4&&((character==='mint-maid'&&mirror)||(character==='lilac-dragon'&&!mirror))) {
          await evaluate(`document.getElementById('notice').hidden=true`);
          await pause(80);await win.webContents.capturePage();await pause(50);
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
  assertPosition(await rects(),reducedFull,{x:48*unit,y:56*unit},'reduced motion follows the supplied pose immediately');
  assert.equal(await evaluate(`['character','bubble-motion','maid-image'].every(id=>document.getElementById(id).getAnimations().length===0)`),true,'reduced motion disables independent pose/breathing animations');
  await pose({x:0,y:0});
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
  win.setSize(...initialSize);await pause(60);await publish(initialSettings);
  await evaluate(`document.getElementById('notice').hidden=true;document.getElementById('notice').style.visibility='hidden'`);
  fs.writeFileSync(path.join(screenshotDirectory,'continuous-pose-evidence.json'),JSON.stringify(evidence,null,2));
}

app.whenReady().then(async()=>{
  markPhase('initial widget');
  const errors=[];
  win=new BrowserWindow({...widgetDimensions(),frame:false,show:false,transparent:true,backgroundColor:'#00000000',webPreferences:{preload:path.join(root,'src','preload.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false,offscreen:true,backgroundThrottling:false}});
  win.webContents.on('console-message',(_event,details)=>{if(details.level==='error')errors.push(details.message);});
  win.webContents.on('preload-error',(_event,_path,error)=>errors.push(error.message));
  await win.loadFile(path.join(root,'src','index.html'));
  // Hosted runners can enable Reduce Motion globally. Exercise the complete
  // normal animations, then separately test the reduced-motion branch below.
  win.webContents.debugger.attach('1.3');
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
  const first=await waitForInitialWidget(errors);
  assert.equal(first.value,'82');assert.equal(first.artLoaded,true);assert.equal(first.demo,true);assert.equal(first.secure,true);assert.equal(first.logoLoaded,true);
  assert.equal(first.width,228);assert.equal(first.height,288);
  assert.equal(await evaluate(`document.getElementById('bucket-name')===null && document.getElementById('footnote')===null`),true,'remove verbose metadata from the bubble');
  assert.equal(await evaluate(`document.getElementById('characters')===null && document.querySelectorAll('.toolbar button').length===4`),true,'keep only refresh, talk, settings and hide in the toolbar');
  assert.match(await evaluate(`document.getElementById('bubble').title`),/演示数据/);
  assert.equal(settings.activeCharacterId,'lilac-dragon','a fresh widget should start with the lilac dragon');
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
  const capture = async name => fs.writeFileSync(path.join(screenshots,name),(await win.webContents.capturePage()).toPNG());
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
  await evaluate(`document.getElementById('notice').hidden=true`);
  markPhase('bottom-corner peeking and drag restoration');
  await checkCornerPeeking(capture);
  markPhase('bubble animation and visibility');
  await checkBubbleMotion(capture);
  markPhase('quota highlight and reduced motion');
  const shine = () => evaluate(`({active:document.querySelector('.headline').classList.contains('quota-shimmer'),background:getComputedStyle(document.querySelector('.quota-value')).backgroundImage,position:getComputedStyle(document.querySelector('.quota-value')).backgroundPosition,playState:getComputedStyle(document.querySelector('.quota-value')).animationPlayState,animations:document.querySelector('.quota-value').getAnimations().length})`);
  const waitForShineFrame = async previous => {
    // Request real compositor paints while waiting for the CSS animation.
    for(let attempt=0;attempt<40;attempt++) {
      await win.webContents.capturePage();await pause(50);
      const frame=await shine();
      if(frame.position!==previous.position)return frame;
    }
    assert.fail('running quota shimmer should produce a new painted frame');
  };
  const shineBefore=await shine();const shineAfter=await waitForShineFrame(shineBefore);
  assert.equal(shineAfter.active,true);assert.ok(shineAfter.animations>0);assert.notEqual(shineBefore.position,shineAfter.position);
  await evaluate('setBubbleVisible(false)');await pause(60);
  const pausedShine=await shine();assert.equal(pausedShine.playState,'paused');
  await win.webContents.capturePage();await pause(180);
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
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
  await pause(80);assert.equal((await shine()).animations,0);
  const reducedMotion=await evaluate(`(()=>{bounce();setBubbleVisible(false);const hidden=['bubble','bubble-content','dot-one','dot-two'].every(id=>getComputedStyle(document.getElementById(id)||document.querySelector('.'+id)).opacity==='0');setBubbleVisible(true);const shown=['bubble','bubble-content','dot-one','dot-two'].every(id=>getComputedStyle(document.getElementById(id)||document.querySelector('.'+id)).opacity==='1');return {hidden,shown,animations:['character','bubble-motion','bubble','bubble-content','dot-one','dot-two'].reduce((count,id)=>count+(document.getElementById(id)||document.querySelector('.'+id)).getAnimations().length,0)};})()`);
  assert.deepEqual(reducedMotion,{hidden:true,shown:true,animations:0},'reduced motion shows/hides immediately without bounce or transition animations');
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
  await pause(60);
  assert.equal(await evaluate(`['character','bubble-motion'].every(id=>{const el=document.getElementById(id);return !el.classList.contains('bounce')&&el.getAnimations().length===0;})`),true,'restoring motion must not replay a bounce requested while reduced motion was enabled');
  await evaluate(`document.getElementById('cycle').click()`);await pause(80);assert.equal(settings.mode,'today');
  const today=await evaluate(`({shown:!document.getElementById('today-view').hidden,text:document.getElementById('today-tokens').textContent})`);
  assert.equal(today.shown,true);assert.match(today.text,/tokens/);
  assert.match(await evaluate(`document.getElementById('today-detail').textContent`),/本机/,'today should describe device usage');
  await evaluate(`document.getElementById('cycle').click()`);await pause(80);assert.equal(settings.mode,'week');
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
  await evaluate(`document.getElementById('cycle').click()`);await pause(80);assert.equal(settings.mode,'lastTurn');
  assert.equal(await evaluate(`!document.getElementById('lastTurn-view').hidden`),true);
  assert.match(await evaluate(`document.getElementById('last-tokens').textContent`),/tokens/);
  await evaluate(`document.getElementById('cycle').click()`);await pause(80);assert.equal(settings.mode,'phrase');
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
    await win.webContents.capturePage();await pause(50);
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
  await evaluate(`document.getElementById('refresh').click()`);await pause(80);assert.equal(refreshes,1);
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
  await evaluate(`document.getElementById('peekAtCorners').click()`);await pause(80);assert.equal(settings.peekAtCorners,true);
  await publish();assert.equal(await evaluate(`document.getElementById('peekAtCorners').checked`),true,'settings refresh preserves corner-peeking opt-in');
  await evaluate(`document.getElementById('peekAtCorners').click()`);await pause(80);assert.equal(settings.peekAtCorners,false);
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
  await evaluate(`document.getElementById('mode').value='week';document.getElementById('mode').dispatchEvent(new Event('change'))`);await pause(80);
  assert.equal(settings.mode,'week');
  await publish();assert.equal(await evaluate(`document.getElementById('mode').value`),'week','the saved weekly default should survive a settings refresh');
  assert.equal(await evaluate(`document.querySelectorAll('.character-card').length`),2);
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
  await pause(100);assert.equal(library.get(custom.id),null);assert.equal(settings.activeCharacterId,'lilac-dragon');
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
  assert.deepEqual(errors,[]);
  console.log('PASS: continuous bottom-corner side/bottom clipping and pointer-following drag/settle pose for both builtin characters, orientations and scales, fixed native bounds and toolbar, opt-in settings, synchronized character/bubble bounce in both orientations, ordered bubble/dot show and collapse, rapid reversal and automatic hide, reduced motion, device-wide weekly tokens and mode cycle, compact weekly layout, weekly default and Codex-follow settings, builtin/imported character themes and async switch guard, full dialogue auto-fit across long CJK/mixed/unbroken text, both orientations and scale range, short-line font reset and immediate dialogue updates, four-button toolbar, gallery preview/import/select/rename/delete, edit focus across refresh, plain-text names, compact/mirrored layouts, live gradient and warning/offline colors, sandbox, IPC, settings, screenshots.');
  clearTimeout(smokeWatchdog);app.exit(0);
}).catch(error=>{console.error(error);app.exit(1);});
