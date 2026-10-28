'use strict';
// Run only the production sandboxed page with synthetic account data and IPC.
const {app,BrowserWindow,ipcMain}=require('electron');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {pathToFileURL}=require('node:url');
const root=path.resolve(__dirname,'..'),runtimeRoot=path.resolve(process.env.CODEX_MAID_RUNTIME_ROOT||root),output=path.resolve(process.env.CODEX_MAID_SCREENSHOTS||path.join(root,'tmp/account-ui-check'));
fs.mkdirSync(output,{recursive:true});
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'Maid accounts 隔离 '));
for(const name of ['codex','maid','appdata','localappdata','temp','userdata'])fs.mkdirSync(path.join(profile,name));
Object.assign(process.env,{CODEX_HOME:path.join(profile,'codex'),CODEX_MAID_HOME:path.join(profile,'maid'),HOME:profile,USERPROFILE:profile,APPDATA:path.join(profile,'appdata'),LOCALAPPDATA:path.join(profile,'localappdata'),TEMP:path.join(profile,'temp'),TMP:path.join(profile,'temp')});app.setPath('userData',path.join(profile,'userdata'));
const {sanitize,widgetDimensions}=require(path.join(runtimeRoot,'src/settings.cjs')),snapshot=require(path.join(runtimeRoot,'src/demo.cjs'))();
const now=Math.floor(Date.now()/1000);
const fixtures=[
  {id:'current',label:'主力开发账号',autoLabel:'主力开发账号',userEdited:true,labelSource:'manual',current:true,planLabel:'Plus',scopeLabel:'个人',remainingPercent:18,resetsAt:now+7650,observedAt:now-60,weeklyRemainingPercent:90,weeklyObservedAt:now-90,weeklyResetsAt:now+86400},
  {id:'unknown',label:'待补充记录',userEdited:true,labelSource:'manual',planLabel:'未知套餐',scopeLabel:'未知范围',resetsAt:null,remainingPercent:null},
  {id:'soon',label:'项目协作账号',userEdited:true,labelSource:'manual',planLabel:'Pro',scopeLabel:'工作空间',workspaceName:'仅供隔离测试的长工作空间名称',resetsAt:now+600,remainingPercent:99.9,observedAt:now-10,weeklyRemainingPercent:99.9,weeklyObservedAt:now-10,weeklyResetsAt:now+86400},
  {id:'due',label:'备用账号',userEdited:true,labelSource:'manual',planLabel:'Plus',scopeLabel:'个人',resetsAt:now-60,remainingPercent:0,observedAt:now-600,weeklyRemainingPercent:0,weeklyObservedAt:now-600,weeklyResetsAt:now+86400},
];
let accounts=structuredClone(fixtures),settings=sanitize({mode:'accounts',sound:false,autoHideSeconds:0}),revision=1,win,phase='startup',renameCalls=0,removeCalls=0,listCalls=0;
const state=()=>({version:'isolated-accounts',settings,settingsRevision:revision,snapshot,demo:true,accountManagement:{accounts,count:accounts.length},activeCharacterId:'frost-glass-cheek',characterUrl:pathToFileURL(path.join(runtimeRoot,'assets/characters/frost-glass-cheek.png')).href,windowContainment:{enabled:false,visible:true}});
const publish=()=>{revision++;win.webContents.send('state',state());};
ipcMain.handle('state',state);ipcMain.handle('list-accounts',()=>{listCalls++;return {accounts};});ipcMain.handle('refresh',()=>snapshot);ipcMain.handle('action',()=>({ok:true}));ipcMain.handle('settings',(_event,patch)=>{settings=sanitize({...settings,...patch});publish();return state();});
ipcMain.handle('rename-account',(_event,id,label)=>{renameCalls++;accounts=accounts.map(a=>a.id===id?{...a,label:label||a.autoLabel,userEdited:!!label,labelSource:label?'manual':'nickname'}:a);publish();return {accounts};});
ipcMain.handle('remove-account',(_event,id)=>{removeCalls++;accounts=accounts.filter(a=>a.id!==id);publish();return {accounts};});
for(const name of ['drag-start','drag-move','drag-end','pointer-region'])ipcMain.on(name,()=>{});
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms)),evaluate=code=>win.webContents.executeJavaScript(code,true);
async function until(fn){for(let n=0;n<200;n++){if(await fn())return;await pause(20);}throw Error('Fixture state timed out');}
async function settled(){await until(()=>evaluate(`current.settingsRevision===${revision}`));await evaluate(`Date.now=()=>${now*1000};updateAccountTimers();reveal();for(const el of document.querySelectorAll('*'))for(const a of el.getAnimations())if(a instanceof CSSTransition)a.finish();void 0`);await pause(50);}
async function capture(name){await settled();fs.writeFileSync(path.join(output,name),(await win.webContents.capturePage()).toPNG());}
const card=id=>`document.querySelector('[data-account-id="${id}"]')`;
const fail=error=>{fs.writeFileSync(path.join(output,'account-ui-failure.json'),JSON.stringify({phase,message:String(error.message).slice(0,600)}));console.error('Account UI check failed during '+phase+': '+error.message);app.exit(1);};
const watchdog=setTimeout(()=>fail(Error('Watchdog expired')),90000);
app.whenReady().then(async()=>{try{
  win=new BrowserWindow({...widgetDimensions(),show:false,frame:false,transparent:true,backgroundColor:'#00000000',webPreferences:{preload:path.join(runtimeRoot,'src/preload.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false,offscreen:true,backgroundThrottling:false,partition:'accounts-'+Date.now()}});
  win.webContents.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(_,done)=>done({cancel:true}));
  await win.loadFile(path.join(runtimeRoot,'src/index.html'));await until(()=>evaluate(`!!current&&$('maid-image').naturalWidth>0&&accountCards.size===4`));await settled();
  assert.deepEqual(await evaluate(`[...$('account-list').children].map(el=>el.dataset.accountId)`),['due','soon','current','unknown']);
  const semantics=await evaluate(`(()=>{return [...accountCards].map(([id,e])=>({id,progress:e.track.getAttribute('aria-valuenow'),offset:e.bar.style.strokeDashoffset,shape:e.bar.tagName,cycle:e.cycle.textContent,resetHint:e.countdown.title,remaining:e.remaining.textContent,iconLabels:[...e.actions.children].map(b=>b.getAttribute('aria-label'))}));})()`);
  assert.equal(semantics.find(a=>a.id==='due').progress,'100');assert.equal(semantics.find(a=>a.id==='due').offset,'0');assert.equal(semantics.find(a=>a.id==='unknown').progress,null);assert.equal(semantics.find(a=>a.id==='unknown').cycle,'?');assert.equal(semantics.find(a=>a.id==='current').shape.toLowerCase(),'circle');assert.match(semantics.find(a=>a.id==='current').resetHint,/预计.*重置/);assert.match(semantics.find(a=>a.id==='current').remaining,/18%/);assert.deepEqual(semantics[0].iconLabels,['改名','移除']);
  phase='keyed alias editing during resort';
  assert.deepEqual(await evaluate(`[...accountCards].map(([id,e])=>[id,e.remaining.textContent])`),[['due','5h -- · 周 0%'],['soon','5h 99.9% · 周 99.9%'],['current','5h 18% · 周 90%'],['unknown','5h -- · 周 --']]);
  await evaluate(`${card('current')}.querySelector('.account-actions button').click();window.editorRef=${card('current')}.querySelector('input');editorRef.value='输入中的 <img src=x>';editorRef.setSelectionRange(2,4);void 0`);
  accounts=accounts.map(a=>a.id==='current'?{...a,resetsAt:now+1}:a);publish();await settled();
  assert.deepEqual(await evaluate(`[...$('account-list').children].map(el=>el.dataset.accountId)`),['due','current','soon','unknown']);
  assert.equal(await evaluate(`editorRef===${card('current')}.querySelector('input')&&editorRef.value==='输入中的 <img src=x>'&&document.activeElement===editorRef&&editorRef.selectionStart===2&&editorRef.selectionEnd===4`),true,'sorting preserves the active editor and text selection');
  await evaluate(`editorRef.closest('form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));void 0`);await until(()=>renameCalls===1);await until(()=>evaluate(`${card('current')}.querySelector('.account-editor').hidden`));assert.equal(await evaluate(`${card('current')}.querySelector('.account-name').textContent`),'输入中的 <img src=x>');assert.equal(await evaluate(`$('account-list').querySelectorAll('img').length`),0);
  phase='remove confirmation';await evaluate(`${card('soon')}.querySelectorAll('.account-actions button')[1].click();void 0`);assert.equal(removeCalls,0);assert.equal(await evaluate(`${card('soon')}.querySelector('.account-confirm').hidden`),false);await evaluate(`${card('soon')}.querySelector('.account-confirm button').click();void 0`);await until(()=>removeCalls===1);await until(()=>evaluate(`!${card('soon')}`));
  const cases=[];
  for(const language of ['zh-CN','en'])for(const mirror of [false,true])for(const scale of [.6,1,1.6]){
    phase=`layout ${language} mirror=${mirror} scale=${scale}`;accounts=structuredClone(fixtures);settings=sanitize({...settings,language,mirror});win.setSize(...Object.values(widgetDimensions(scale)));publish();await settled();await evaluate(`$('account-list').scrollTop=0;void 0`);
    const result=await evaluate(`(()=>{const list=$('account-list'),rect=list.getBoundingClientRect(),rows=[...list.children].map(c=>c.getBoundingClientRect()),ring=list.querySelector('.account-track').getBoundingClientRect(),style=getComputedStyle(list.querySelector('.account-action-icon'));return {horizontal:list.scrollWidth<=list.clientWidth,twoFull:rows[1].bottom<=rect.bottom+1,rowHeight:rows[0].height/($('widget').getBoundingClientRect().width/380),round:Math.abs(ring.width-ring.height)<.1,mask:style.maskImage,footer:$('accounts-view').getBoundingClientRect().bottom<=document.querySelector('.page-navigation').getBoundingClientRect().top+1,sort:[...list.children].map(c=>c.dataset.accountId)};})()`);
    const quotaLayout=await evaluate(`(()=>[...accountCards.values()].map(e=>{const r=e.remaining.getBoundingClientRect(),m=e.remaining.parentElement.getBoundingClientRect(),s=getComputedStyle(e.remaining);return {text:e.remaining.textContent,fontSize:s.fontSize,lineHeight:s.lineHeight,unclipped:e.remaining.scrollWidth<=e.remaining.clientWidth+1,rightAligned:Math.abs(m.right-r.right)<1};}))()`);
    for(const quota of quotaLayout){assert.equal(quota.fontSize,'10px');assert.equal(quota.lineHeight,'14px');assert.equal(quota.unclipped,true,quota.text+' must fit without ellipsis');assert.equal(quota.rightAligned,true);}
    assert.equal(quotaLayout.find(q=>q.text.includes('99.9')).text,language==='en'?'5h 99.9% · W 99.9%':'5h 99.9% · 周 99.9%');
    assert.equal(result.horizontal,true);assert.equal(result.twoFull,true,'two full accounts fit in the list');assert.ok(result.rowHeight<=61);assert.equal(result.round,true);assert.match(result.mask,/hugeicons.*\.svg/);assert.equal(result.footer,true);assert.deepEqual(result.sort,['due','soon','current','unknown']);cases.push({language,mirror,scale,...result,quotaLayout});
  }
  phase='local clock tick';const before=listCalls;await evaluate(`Date.now=()=>${(now+1)*1000};updateAccountTimers();void 0`);assert.equal(listCalls,before);assert.match(await evaluate(`${card('soon')}.querySelector('.account-countdown').textContent`),/00:09:59/);assert.equal(accounts.find(a=>a.id==='current').remainingPercent,18);
  phase='preview';accounts=structuredClone(fixtures).filter(a=>['soon','current'].includes(a.id));settings=sanitize({...settings,language:'zh-CN',mirror:false});win.setSize(...Object.values(widgetDimensions(1.6)));publish();await settled();await pause(700);
  await evaluate(`accountFeedbackSource='本机记录推算 · 历史账号需登录确认';$('accounts-feedback').textContent=t(accountFeedbackSource);void 0`);
  await capture('accounts-compact-zh.png');settings=sanitize({...settings,language:'en'});publish();await capture('accounts-compact-en.png');
  fs.writeFileSync(path.join(output,'account-ui-check.json'),JSON.stringify({ok:true,runtimeRoot,fixtureCases:cases.length,cases,dualQuotaLabels:true,quotaFontAndPositionUnchanged:true,sortedByReset:true,unknownLast:true,pendingResetNotConfirmed:true,cycleProgressNotQuota:true,aliasEditorPreservedDuringSort:true,aliasPlainText:true,explicitRemoval:true,localClockOnly:true,icons:'Hugeicons 4.3.5 MIT',fixturesOnly:true,isolatedDataDependencies:true,realMainStarted:false,nativeWindowShown:false},null,2));console.log('PASS: dual quota labels, unchanged font/position, compact account rings, ordering, editing/removal and bilingual mirror/scale layout.');clearTimeout(watchdog);win.destroy();app.quit();
}catch(error){fail(error);}});
