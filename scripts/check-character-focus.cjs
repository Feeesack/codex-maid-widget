'use strict';
// Only the production renderer/preload and synthetic state run here. All data
// directories are isolated; the real main, account readers and control stay out.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {pathToFileURL}=require('node:url');
const {app,BrowserWindow,ipcMain}=require('electron');
const root=path.resolve(__dirname,'..'),runtimeRoot=path.resolve(process.env.CODEX_MAID_RUNTIME_ROOT||root);
const output=path.resolve(process.env.CODEX_MAID_SCREENSHOTS||path.join(root,'tmp/character-focus-check'));
fs.mkdirSync(output,{recursive:true});
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'Maid focus 隔离 '));
for(const name of ['codex','maid','appdata','localappdata','temp','userdata'])fs.mkdirSync(path.join(profile,name));
Object.assign(process.env,{CODEX_HOME:path.join(profile,'codex'),CODEX_MAID_HOME:path.join(profile,'maid'),HOME:profile,USERPROFILE:profile,APPDATA:path.join(profile,'appdata'),LOCALAPPDATA:path.join(profile,'localappdata'),TEMP:path.join(profile,'temp'),TMP:path.join(profile,'temp')});
app.setPath('userData',path.join(profile,'userdata'));
const {sanitize,widgetDimensions}=require(path.join(runtimeRoot,'src/settings.cjs'));
const snapshot=require(path.join(runtimeRoot,'src/demo.cjs'))();
let settings=sanitize({mode:'phrase',sound:false,autoHideSeconds:0,phrases:['下班啦。AI 没跑完，明天再说。']}),revision=1,unit=1,win,phase='startup';
const dragEvents=[];
const state=()=>({version:'isolated-character-focus',settings,settingsRevision:revision,snapshot,demo:true,
  activeCharacterId:'frost-glass-cheek',characterUrl:pathToFileURL(path.join(runtimeRoot,'assets/characters/frost-glass-cheek.png')).href,
  windowContainment:{enabled:false,visible:true},visualPose:{offset:{x:(settings.mirror?-48:48)*unit,y:28*unit},moving:false},accountManagement:{accounts:[],count:0}});
ipcMain.handle('state',state);ipcMain.handle('settings',state);ipcMain.handle('refresh',()=>snapshot);ipcMain.handle('action',()=>({ok:true}));
for(const name of ['pointer-region','drag-start','drag-move','drag-end'])ipcMain.on(name,()=>{if(name.startsWith('drag-'))dragEvents.push(name);});
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const evaluate=code=>win.webContents.executeJavaScript(code,true);
async function until(fn){for(let n=0;n<150;n++){if(await fn())return;await pause(20);}throw Error('Fixture condition timed out');}
async function key(name,type){const code={Tab:9,Enter:13,Escape:27,' ':32,q:81}[name];for(const event of type?[type]:['keyDown','keyUp'])await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type:event,key:name,code:name===' '?'Space':name==='q'?'KeyQ':name,windowsVirtualKeyCode:code,nativeVirtualKeyCode:code});await pause(30);}
async function move(x,y){await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseMoved',x,y});await pause(30);}
async function point(){return evaluate(`(()=>{const r=$('character').getBoundingClientRect();return {x:Math.max(5,Math.min(innerWidth-8,r.x+r.width/2)),y:Math.min(innerHeight-8,r.bottom-12)};})()`);}
async function mouse(type,p){await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type,...p,button:'left',buttons:type==='mousePressed'?1:0,clickCount:1});await pause(30);}
async function clickCharacter(){const p=await point();await move(p.x,p.y);const hit=await evaluate(`(()=>{const hit=document.elementFromPoint(${p.x},${p.y});return {character:hit?.closest('#character')?.id,hit:hit?.id||hit?.tagName,rect:$('character').getBoundingClientRect().toJSON(),viewport:[innerWidth,innerHeight]};})()`);assert.equal(hit.character,'character',JSON.stringify(hit));await mouse('mousePressed',p);await mouse('mouseReleased',p);await pause(260);return p;}
async function sample(){return evaluate(`(()=>{const c=$('character');return {active:document.activeElement?.id||document.activeElement?.tagName,focused:document.activeElement===c,focusVisible:c.matches(':focus-visible'),outline:getComputedStyle(c).outlineStyle,imageFilter:getComputedStyle($('maid-image')).filter,held:interactionHeld,pressed:c.classList.contains('interaction-pressed')};})()`);}
async function assertNoRectangle(label){const value=await sample();assert.equal(value.outline,'none',label);return value;}
async function tabTo(id){for(let i=0;i<18;i++){await key('Tab');if(await evaluate(`document.activeElement===$(${JSON.stringify(id)})`))return;}throw Error('Keyboard target unavailable');}
async function capture(name){fs.writeFileSync(path.join(output,name),(await win.webContents.capturePage()).toPNG());}
const failure=error=>{fs.writeFileSync(path.join(output,'character-focus-failure.json'),JSON.stringify({ok:false,phase,message:String(error?.message||error).slice(0,450)}));console.error('Character focus regression failed during '+phase);app.exit(1);};
const watchdog=setTimeout(()=>failure(Error('Watchdog expired')),90000);
app.whenReady().then(async()=>{
  try{
    win=new BrowserWindow({...widgetDimensions(),frame:false,show:false,transparent:true,backgroundColor:'#00000000',webPreferences:{preload:path.join(runtimeRoot,'src/preload.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false,offscreen:true,backgroundThrottling:false,partition:'character-focus-'+Date.now()}});
    win.webContents.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(_,done)=>done({cancel:true}));
    await win.loadFile(path.join(runtimeRoot,'src/index.html'));await until(()=>evaluate(`!!current&&$('maid-image').naturalWidth>0`));win.webContents.debugger.attach('1.3');
    const cases=[];
    for(const mirror of [false,true])for(const scale of [.6,1,1.6]){
      phase=`mirror=${mirror},scale=${scale}`;
      const size=widgetDimensions(scale);unit=size.width/380;win.setSize(size.width,size.height);
      settings=sanitize({...settings,mirror});revision++;win.webContents.send('state',state());
      await until(()=>evaluate(`current.settingsRevision===${revision}&&innerWidth===${size.width}`));
      // The previous drag's release and the mirror FLIP must settle before a
      // geometry-based click in the newly resized viewport.
      await pause(280);
      await evaluate(`document.activeElement?.blur();document.documentElement.scrollTop=0;document.body.scrollTop=0;void 0`);
      await clickCharacter();const baseline=await assertNoRectangle('mouse click has no rectangle');
      await key('q','keyDown');assert.equal((await sample()).held,true,'Q still presses the character');
      await key('q','keyUp');const keyboard=await assertNoRectangle('click then Q never draws a rectangular outline');
      assert.equal(keyboard.focusVisible,true);assert.equal(keyboard.held,false);assert.notEqual(keyboard.imageFilter,baseline.imageFilter,'keyboard users retain an alpha-shaped focus cue');
      if(scale===1.6)await capture(`character-focus-${mirror?'left':'right'}.png`);
      await move(-20,-20);assert.equal((await sample()).focused,false,'mouse departure clears character focus');
      await clickCharacter();await key('q');await key('Escape');assert.equal((await sample()).focused,false,'Escape leaves character focus');
      await tabTo('character');const tab=await assertNoRectangle('Tab character focus has no rectangle');assert.equal(tab.focusVisible,true);
      for(const name of ['q',' ','Enter']){await key(name,'keyDown');assert.equal((await sample()).held,true,name+' presses');await key(name,'keyUp');const after=await sample();assert.equal(after.held,false,name+' releases');assert.equal(after.focused,true,'keyboard interaction keeps its target');}
      await tabTo('refresh');assert.equal(await evaluate(`getComputedStyle($('refresh')).outlineStyle`),'solid','toolbar buttons keep their standard focus ring');
      await clickCharacter();const start=await point(),before=dragEvents.length;await mouse('mousePressed',start);
      await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseMoved',x:start.x+(mirror?8:-8),y:start.y-8,button:'left',buttons:1});
      await pause(30);assert.equal((await sample()).held,true,'drag remains held');await mouse('mouseReleased',{x:start.x+(mirror?8:-8),y:start.y-8});
      assert.equal((await sample()).held,false,'drag releases');assert.ok(dragEvents.slice(before).includes('drag-start'));assert.ok(dragEvents.slice(before).includes('drag-end'));
      cases.push({mirror,scale,noRectangularFocus:true,alphaFocusCue:true,pointerDepartureClearsFocus:true,escapeClearsFocus:true,tabReachable:true,keyboardPressReleasePreserved:true,toolbarFocusPreserved:true,dragPreserved:true});
    }
    const lifecycle=[];
    for(const event of ['blur','document-hidden','presence-hidden']){
      phase=event;await tabTo('character');await key('q','keyDown');
      if(event==='blur')await evaluate(`window.dispatchEvent(new Event('blur'));void 0`);
      if(event==='document-hidden')await evaluate(`Object.defineProperty(document,'hidden',{configurable:true,get:()=>true});document.dispatchEvent(new Event('visibilitychange'));void 0`);
      if(event==='presence-hidden'){win.webContents.send('presence',{visible:false});await until(()=>evaluate(`document.body.inert`));}
      const observed=await sample();assert.equal(observed.focused,false);assert.equal(observed.held,false);assert.equal(observed.pressed,false);
      if(event==='document-hidden')await evaluate(`delete document.hidden;document.dispatchEvent(new Event('visibilitychange'));void 0`);
      if(event==='presence-hidden'){win.webContents.send('presence',{visible:true});await until(()=>evaluate(`!document.body.inert`));}
      await key('q','keyUp');assert.equal((await sample()).focused,false,'restore does not restore stale focus');lifecycle.push({event,focusCleared:true,interactionReleased:true});
    }
    const report={ok:true,fixtureCases:cases.length,cases,lifecycle,productionRenderer:true,isolatedDataDependencies:true,realMainStarted:false,nativeWindowShown:false};
    fs.writeFileSync(path.join(output,'character-focus-check.json'),JSON.stringify(report,null,2)+'\n');console.log('PASS: character rectangle regression, alpha focus cue, keyboard, drag, mirror/scale and focus lifecycle.');clearTimeout(watchdog);win.destroy();app.quit();
  }catch(error){failure(error);}
});
