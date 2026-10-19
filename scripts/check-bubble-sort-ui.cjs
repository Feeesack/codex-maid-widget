'use strict';
// Production settings/preload and official SortableJS; all state, IPC and writes
// below are isolated. No main process, account, auth or conversation readers.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {app,BrowserWindow,ipcMain}=require('electron');
const {checkBubbleSortUi}=require('./bubble-sort-ui.cjs');
const root=path.resolve(__dirname,'..'),macos=process.argv.includes('--macos');
const runtimeRoot=path.resolve(process.env.CODEX_MAID_RUNTIME_ROOT||path.join(root,macos?'macos':''));
const output=path.resolve(process.env.CODEX_MAID_SCREENSHOTS||path.join(root,'tmp/local-update-0.3.47',macos?'bubble-sort-macos-source':'bubble-sort-windows-source'));
if(fs.existsSync(output))throw new Error('Existing UI evidence must be retained');
fs.mkdirSync(output,{recursive:true});
const taskHome=fs.mkdtempSync(path.join(os.tmpdir(),'maid 气泡排序 ui-'));
for(const name of ['codex','maid','appdata','localappdata','temp','userdata'])fs.mkdirSync(path.join(taskHome,name));
Object.assign(process.env,{CODEX_HOME:path.join(taskHome,'codex'),CODEX_MAID_HOME:path.join(taskHome,'maid'),HOME:taskHome,USERPROFILE:taskHome,APPDATA:path.join(taskHome,'appdata'),LOCALAPPDATA:path.join(taskHome,'localappdata'),TEMP:path.join(taskHome,'temp'),TMP:path.join(taskHome,'temp')});
app.setPath('userData',path.join(taskHome,'userdata'));
app.on('window-all-closed',()=>{});
// Load byte-identical production renderer assets from a nondefault installation
// path containing both Chinese characters and spaces, independently of cwd.
const rendererRoot=path.join(taskHome,'非默认 安装目录','气泡 挂件');
for(const file of ['src/preload.cjs','src/settings.html','src/settings.css','src/settings.js','src/interaction-sound-catalog.js','src/local-interaction-samples.js','src/vendor/sortable/Sortable-1.15.7.min.js','assets/icons/app-256.png']) {
  const destination=path.join(rendererRoot,file);fs.mkdirSync(path.dirname(destination),{recursive:true});fs.copyFileSync(path.join(runtimeRoot,file),destination);assert.equal(fs.readFileSync(destination).equals(fs.readFileSync(path.join(runtimeRoot,file))),true);
}
const {sanitize,writeSettings,readSettings}=require(path.join(runtimeRoot,'src/settings.cjs'));
const snapshot=require(path.join(runtimeRoot,'src/demo.cjs'))();
let settings=sanitize({sound:false,mode:'week',defaultBubblePage:'week',bubblePageOrder:['quota','conversation','week','accounts','today','lastTurn','phrase']}),revision=1,writes=0,diskWrites=0,rejectNext=false,win;
const settingsFile=path.join(taskHome,'maid','settings.json');writeSettings(settingsFile,settings);
function state(){return {version:'isolated-bubble-sort-fixture',settings,settingsRevision:revision,snapshot,demo:true,characters:[],activeCharacterId:'frost-glass-cheek',characterName:'fixture',characterUrl:''};}
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const evaluate=code=>win.webContents.executeJavaScript(code);
async function publish(patch={}){settings=sanitize({...settings,...patch});if(Object.keys(patch).length)revision++;win.webContents.send('state',state());await pause(60);}
ipcMain.handle('state',state);
ipcMain.handle('settings',(_event,patch)=>{writes++;if(rejectNext){rejectNext=false;throw new Error('isolated settings save unavailable');}const next=sanitize({...settings,...patch});writeSettings(settingsFile,next);diskWrites++;settings=next;revision++;win.webContents.send('state',state());return state();});
ipcMain.handle('preview-corner-peek',()=>state());ipcMain.handle('preview-appearance',()=>state());
ipcMain.handle('list-accounts',()=>({accounts:[]}));ipcMain.handle('action',()=>{});
let phase='load isolated settings';
function failure(error){try{fs.writeFileSync(path.join(output,'bubble-sort-ui-failure.json'),JSON.stringify({ok:false,phase,message:String(error?.message||error)},null,2));}catch{}console.error(error);app.exit(1);}
process.on('uncaughtException',failure);process.on('unhandledRejection',failure);
const timeout=setTimeout(()=>failure(new Error('Isolated page-sort UI check timed out')),45000);
app.whenReady().then(async()=>{
  win=new BrowserWindow({width:550,height:760,show:false,frame:false,webPreferences:{preload:path.join(rendererRoot,'src/preload.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false,offscreen:true,backgroundThrottling:false,partition:'bubble-sort-isolated-'+Date.now()}});
  let networkAttempts=0;win.webContents.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(_request,done)=>{networkAttempts++;done({cancel:true});});
  await win.loadFile(path.join(rendererRoot,'src/settings.html'));await pause(200);win.webContents.debugger.attach('1.3');
  assert.equal(await evaluate(`typeof process==='undefined'&&typeof require==='undefined'`),true);
  assert.equal(await evaluate(`document.querySelector('.app-logo').naturalWidth>0&&document.querySelectorAll('#bubble-pages .ui-icon').length===21&&document.querySelectorAll('#reset-page-order .ui-icon').length===1`),true,'relative icon assets and all 22 inline Hugeicons load from the nondefault path');
  phase='real handle drag, status broadcast, failed save and ordinary controls';
  const evidence=await checkBubbleSortUi({win,evaluate,pause,publish,getSettings:()=>settings,getRevision:()=>revision,getWrites:()=>writes,getDiskWrites:()=>diskWrites,failNextSave:()=>{rejectNext=true;},capture:async name=>{win.webContents.invalidate();fs.writeFileSync(path.join(output,name),(await win.webContents.capturePage()).toPNG());}});
  // The helper restores only fixture-only display values after the actual save
  // checks. The isolated file must still contain the final successful user edit.
  assert.equal(readSettings(settingsFile).bubbleHiddenPages.includes('conversation'),false);assert.equal(networkAttempts,0);
  clearTimeout(timeout);fs.writeFileSync(path.join(output,'bubble-sort-ui.json'),JSON.stringify({ok:true,...evidence,isolatedSettingsFile:true,successfulDiskWrites:diskWrites,networkRequests:networkAttempts,nondefaultChineseAndSpaceRuntimePath:true,byteIdenticalRendererAssets:true,macosNativeBuildPerformed:false},null,2));
  console.log('PASS: official SortableJS real pointer drag, live row-gap animation, zero writes before drop, one write after drop, status rendering, failure rollback and ordinary controls.');app.exit(0);
}).catch(failure);
