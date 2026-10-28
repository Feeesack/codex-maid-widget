'use strict';
// Real sandboxed Chromium + shipped preload/renderers. All IPC and source data
// are synthetic; no production main, data-home, account or conversation reader.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const option = (name, fallback) => {const index=process.argv.indexOf('--'+name);return index<0?fallback:process.argv[index+1];};
const version = require('../package.json').version;
const output = path.resolve(option('output', path.join(root, 'tmp', 'local-update-'+version, 'ui')));
const windowsRootOption = option('windows-root', null);
const windowsRoot = windowsRootOption ? path.resolve(windowsRootOption) : root;
const checkAllPhrases = process.argv.includes('--check-all-phrases');
if (windowsRootOption) {
  assert.ok(path.isAbsolute(windowsRootOption), '--windows-root requires an absolute application root.');
  assert.ok(fs.existsSync(windowsRoot), '--windows-root does not exist.');
}
if (!process.versions.electron) {
  fs.mkdirSync(output,{recursive:true});
  const profile=fs.mkdtempSync(path.join(output,'isolated-profile-'));
  for(const name of ['codex','maid','appdata','localappdata','temp','userdata','session','crashDumps'])fs.mkdirSync(path.join(profile,name));
  const env={...process.env,CODEX_MAID_LANGUAGE_UI_PROFILE:profile,CODEX_HOME:path.join(profile,'codex'),CODEX_MAID_HOME:path.join(profile,'maid'),HOME:profile,USERPROFILE:profile,APPDATA:path.join(profile,'appdata'),LOCALAPPDATA:path.join(profile,'localappdata'),TEMP:path.join(profile,'temp'),TMP:path.join(profile,'temp')};
  delete env.ELECTRON_RUN_AS_NODE;
  const args=[__filename,'--output',output];
  if(windowsRootOption)args.push('--windows-root',windowsRoot);
  if(checkAllPhrases)args.push('--check-all-phrases');
  const child=require('node:child_process').spawn(require('electron'),args,{cwd:root,env,windowsHide:true,stdio:'inherit'});
  child.once('error',error=>{console.error(error.message);process.exitCode=1;});child.once('exit',code=>{process.exitCode=code??1;});
} else {
  const profile=process.env.CODEX_MAID_LANGUAGE_UI_PROFILE;
  assert.ok(profile&&path.dirname(profile)===output,'Use the Node launcher to create an explicit isolated profile.');
  for(const [name,expected] of Object.entries({CODEX_HOME:'codex',CODEX_MAID_HOME:'maid',APPDATA:'appdata',LOCALAPPDATA:'localappdata',TEMP:'temp',TMP:'temp'}))assert.equal(process.env[name],path.join(profile,expected));
  const {app,BrowserWindow,ipcMain}=require('electron');
  app.on('window-all-closed',()=>{});
  app.disableHardwareAcceleration();
  for(const [name,child] of Object.entries({userData:'userdata',sessionData:'session',crashDumps:'crashDumps',temp:'temp',home:''}))app.setPath(name,path.join(profile,child));
  const fixtures=new Map(),cases=[],captures=[],errors=[];let phase='startup',networkAttempts=0;
  const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const evaluate=(win,code)=>win.webContents.executeJavaScript(code,true);
  // Electron's patched fs presents an ASAR as a virtual directory. Hash the
  // physical archive through original-fs while renderers use its normal VFS.
  const archiveFs=require('original-fs');
  const packagedArchive=windowsRootOption&&archiveFs.statSync(windowsRoot).isFile()?{path:windowsRoot,sha256:require('node:crypto').createHash('sha256').update(archiveFs.readFileSync(windowsRoot)).digest('hex')}:null;
  const writeReport=(ok,error)=>{
    const archiveAfter=packagedArchive?require('node:crypto').createHash('sha256').update(archiveFs.readFileSync(windowsRoot)).digest('hex'):null;
    fs.writeFileSync(path.join(output,'language-ui-report.json'),JSON.stringify({ok,version,phase,error:error?.message,windowsRoot,packagedArchive:packagedArchive?{...packagedArchive,sha256After:archiveAfter,unchanged:archiveAfter===packagedArchive.sha256}:null,syntheticDataOnly:true,productionPreloadAndRenderer:true,explicitCharacterDataDirectory:true,allProfilePathsIsolated:true,noProductionReaders:true,networkAttempts,errors,cases,captures},null,2)+'\n');
    if(packagedArchive)assert.equal(archiveAfter,packagedArchive.sha256,'Packaged application archive remains unchanged.');
  };
  function getFixture(event){const fixture=fixtures.get(event.sender.id);assert.ok(fixture,'IPC sender belongs to this isolated harness');return fixture;}
  for(const channel of ['state','refresh','settings','preview-corner-peek','preview-appearance','list-accounts','rename-account','remove-account','inspect-conversation','list-conversations','select-conversation','action','import-characters','select-character','rename-character','remove-character'])ipcMain.handle(channel,async(event,...args)=>{
    const f=getFixture(event);
    if(channel==='state'||channel.startsWith('preview-'))return f.state();
    if(channel==='settings'){
      if(f.rejectLanguage&&Object.hasOwn(args[0],'language')){f.rejectLanguage=false;throw new Error('Synthetic language save failure');}
      f.settings=f.schema.sanitize({...f.settings,...args[0]});f.revision++;f.schema.writeSettings(f.settingsFile,f.settings);f.publish();return f.state();
    }
    if(channel==='refresh')return f.snapshot;
    if(channel==='list-accounts')return {accounts:f.accounts,count:f.accounts.length};
    if(channel==='inspect-conversation')return f.conversation;
    if(channel==='list-conversations')return {threads:[{id:'fixture-thread',title:'Polish the desktop companion',workspaceLabel:'Companion workspace'}],selectedId:'fixture-thread',selectionMode:'auto'};
    if(channel==='select-conversation')return {selectedId:args[0],selectionMode:args[0]?'manual':'auto',selectionRevision:1};
    if(channel==='rename-character'){f.library.rename(...args);f.publish();return f.state();}
    if(channel==='select-character'){f.settings=f.schema.sanitize({...f.settings,activeCharacterId:args[0]});f.revision++;f.publish();return f.state();}
    if(channel==='import-characters')return {state:f.state(),importedCount:0,existingCount:0,errors:[]};
    if(channel==='rename-account'||channel==='remove-account')return {accounts:f.accounts};
    return f.state();
  });
  for(const channel of ['drag-start','drag-move','drag-end','pointer-region'])ipcMain.on(channel,()=>{});
  function createFixture(base,label){
    const schema=require(path.join(base,'src/settings.cjs'));
    const data=path.join(profile,'maid',label);fs.mkdirSync(data,{recursive:true});
    const {CharacterLibrary}=require(path.join(base,'src/character-library.cjs'));
    const library=new CharacterLibrary({dataDir:data,assetRoot:path.join(base,'assets')});
    const now=Math.floor(Date.now()/1000),f={base,label,schema,library,settingsFile:path.join(data,'settings.json'),settings:schema.sanitize({language:'zh-CN',sound:false,followCodex:false,autoHideSeconds:0,peekAtCorners:true}),revision:1,windows:[]};
    f.snapshot={status:'demo',updatedAt:new Date(now*1000).toISOString(),account:{planType:'演示',authMode:'demo'},buckets:[{id:'demo',name:'演示额度',primary:{usedPercent:18,remainingPercent:82,windowDurationMins:300,resetsAt:now+5209},secondary:{usedPercent:36,remainingPercent:64,windowDurationMins:10080,resetsAt:now+214449}}],today:{tokens:128460,complete:true},weekly:{tokens:1268450,complete:true},lastTurn:{tokens:8420,timestamp:new Date((now-90)*1000).toISOString()}};
    f.accounts=[{id:'fixture-a',label:'Personal account for everyday coding',labelSource:'manual',userEdited:true,current:true,planType:'plus',scopeLabel:'个人',resetsAt:now+5209,observedAt:now,remainingPercent:82},{id:'fixture-b',label:'Studio account with a longer friendly name',labelSource:'manual',userEdited:true,current:false,planType:'pro',scopeLabel:'工作空间',workspaceName:'Companion design studio',resetsAt:now-1,observedAt:now-300,remainingPercent:36},{id:'fixture-c',label:'A previously used account',labelSource:'manual',userEdited:true,current:false,planType:null,scopeLabel:'未知范围',resetsAt:null,observedAt:null,remainingPercent:null}];
    f.readyConversation={status:'ready',selectionMode:'auto',selectionRevision:0,targetTitle:'Polish the desktop companion',targetProject:'Companion workspace with a descriptive project name',targetProjectDetail:'D:/Isolated project/Example workspace',context:{status:'ready',usedTokens:51200,windowTokens:200000,percent:25.6},git:{status:'ready',count:12},compaction:{status:'ready',count:4,complete:true}};f.conversation=f.readyConversation;
    f.state=()=>{const active=library.get(f.settings.activeCharacterId);return {version,settings:f.settings,settingsRevision:f.revision,snapshot:f.snapshot,demo:true,characters:library.list(),activeCharacterId:active.id,characterUrl:active.url,characterName:active.name,accountManagement:{accounts:f.accounts},followSupported:true,cornerDock:{corner:null,peeking:false},windowContainment:{supported:true,enabled:false,reason:'disabled',topmost:{desired:true,verified:true,reason:'verified'}}};};
    f.publish=()=>{for(const win of f.windows)if(!win.isDestroyed())win.webContents.send('state',f.state());};schema.writeSettings(f.settingsFile,f.settings);return f;
  }
  function createWindow(f,width,height,widget=false){
    const win=new BrowserWindow({width,height,useContentSize:true,frame:false,transparent:widget,backgroundColor:widget?'#00000000':'#f5faf8',show:false,resizable:true,webPreferences:{preload:path.join(f.base,'src/preload.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false,offscreen:true,backgroundThrottling:false}});
    fixtures.set(win.webContents.id,f);f.windows.push(win);win.webContents.setAudioMuted(true);win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
    win.webContents.session.setPermissionRequestHandler((_wc,_permission,callback)=>callback(false));
    win.webContents.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(_request,done)=>{networkAttempts++;done({cancel:true});});
    win.webContents.on('console-message',(_event,details)=>{if(details.level==='error')errors.push({phase,message:details.message});});win.webContents.on('preload-error',(_event,_file,error)=>errors.push({phase,message:error.message}));
    return win;
  }
  async function until(win,code){for(let i=0;i<160;i++){win.webContents.invalidate();if(await evaluate(win,code))return;await wait(25);}throw new Error('Timed out in '+phase);}
  async function settle(win){win.webContents.invalidate();await wait(90);await win.webContents.capturePage();await wait(20);}
  async function capture(win,file,rect){await settle(win);const image=await win.webContents.capturePage(rect);fs.writeFileSync(path.join(output,file),image.toPNG());captures.push({file,...image.getSize()});}
  async function changeLanguage(win,f,language){await evaluate(win,`document.getElementById('language').value=${JSON.stringify(language)};document.getElementById('language').dispatchEvent(new Event('change',{bubbles:true}));void 0`);await until(win,`document.documentElement.lang===${JSON.stringify(language)}&&!document.getElementById('language').disabled`);assert.equal(f.settings.language,language);}
  async function cjkText(win){return evaluate(win,`(()=>{const result=[],walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);while(walker.nextNode()){const n=walker.currentNode,p=n.parentElement;if(!p||p.closest('#language,script,style')||!p.getClientRects().length||getComputedStyle(p).visibility==='hidden')continue;if(/[\\u3400-\\u9fff]/.test(n.nodeValue))result.push({tag:p.tagName,id:p.id,text:n.nodeValue.trim()});}return result;})()`);}
  async function settingsCheck(f){
    const win=createWindow(f,660,1100);phase=f.label+' settings initial';await win.loadFile(path.join(f.base,'src/settings.html'));
    await until(win,`typeof current==='object'&&document.querySelectorAll('.character-card').length===4`);
    assert.equal(await evaluate(win,`typeof process==='undefined'&&typeof require==='undefined'`),true);
    await evaluate(win,`document.getElementById('phrases').value='Unsaved bilingual draft — 我的草稿';document.getElementById('phrases').dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('.character-actions button').click();window.fixtureRename=document.querySelector('.character-name-input');fixtureRename.value='A long custom character name — 自定义';void 0`);
    await changeLanguage(win,f,'en');
    assert.equal(await evaluate(win,`document.getElementById('phrases').value`),'Unsaved bilingual draft — 我的草稿');assert.equal(await evaluate(win,`fixtureRename.value`),'A long custom character name — 自定义');
    await changeLanguage(win,f,'zh-CN');await changeLanguage(win,f,'en');
    f.rejectLanguage=true;await evaluate(win,`document.getElementById('language').value='zh-CN';document.getElementById('language').dispatchEvent(new Event('change',{bubbles:true}));void 0`);
    await until(win,`!document.getElementById('language').disabled&&document.getElementById('language-feedback').classList.contains('has-error')`);assert.equal(await evaluate(win,`document.documentElement.lang`),'en');
    assert.equal(await evaluate(win,`document.getElementById('phrases').value`),'Unsaved bilingual draft — 我的草稿');
    await evaluate(win,`document.querySelector('[data-action="cancel-rename"]').click();void 0`);
    f.settings=f.schema.readSettings(f.settingsFile);f.revision++;await win.loadFile(path.join(f.base,'src/settings.html'));await until(win,`document.documentElement.lang==='en'&&document.querySelectorAll('.character-card').length===4`);
    assert.equal(f.settings.language,'en');
    f.library.rename('mint-maid','A thoughtfully named custom companion');f.revision++;f.publish();
    const categoryControls={general:['language','accountResetAlerts','refreshSeconds','followCodex'],appearance:['import-characters','scale','opacity','alwaysOnTop','stayInCodexWindow','peekAtCorners','peekBottomPercent','peekSidePercent'],display:['bucketId','reset-page-order','page-visible-quota','page-default-quota','showBubble','autoHideSeconds'],chat:['chatPageEnabled','open-chat-manager','chat-config-model','chat-config-effort','chat-config-refresh','chat-config-save','phrases','save-phrases'],interaction:['clickThrough','sound','interactionSound','preview-interaction-sound']};
    for(const language of ['en','zh-CN']){
      await evaluate(win,`document.getElementById('settings-tab-general').click();void 0`);await changeLanguage(win,f,language);
      for(const width of [660,440,320])for(const [category,controlIds] of Object.entries(categoryControls)){
        phase=f.label+' settings '+language+' '+width+' '+category;win.setContentSize(width,1100);
        await evaluate(win,`document.getElementById(${JSON.stringify('settings-tab-'+category)}).click();window.scrollTo(0,0);void 0`);await settle(win);
        const visible=await evaluate(win,`[...document.querySelectorAll('.settings-panel')].filter(panel=>!panel.hidden&&panel.getClientRects().length).map(panel=>panel.id)`);
        assert.deepEqual(visible,['settings-panel-'+category],'Exactly the selected settings category is rendered');
        assert.equal(await evaluate(win,`document.getElementById(${JSON.stringify('settings-tab-'+category)}).getAttribute('aria-selected')`),'true');
        const geometry=await evaluate(win,`({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,bodyWidth:document.body.scrollWidth})`);
        assert.ok(geometry.scrollWidth<=geometry.width+1&&geometry.bodyWidth<=geometry.width+1,'Settings horizontal overflow '+JSON.stringify({category,language,...geometry}));
        const controls=await evaluate(win,`(${JSON.stringify(controlIds)}).map(id=>{const node=document.getElementById(id),r=node?.getBoundingClientRect();return {id,visible:!!node&&!!node.getClientRects().length&&r.width>0&&r.height>0,inside:!!r&&r.left>=-1&&r.right<=innerWidth+1};})`);
        assert.deepEqual(controls.filter(control=>!control.visible||!control.inside),[],'Selected category controls remain visible and inside the page');
        if(language==='en')assert.deepEqual(await cjkText(win),[],'English settings contain no built-in Chinese');
        const pageHeight=await evaluate(win,`Math.ceil(document.body.scrollHeight)+20`);win.setContentSize(width,Math.max(760,pageHeight));await settle(win);
        await evaluate(win,`window.scrollTo(0,0);void 0`);await capture(win,f.label+'-settings-'+language+'-'+width+'-'+category+'.png');
        cases.push({platform:f.label,kind:'settings-category',category,language,width,...geometry,controlIds,languageSaveRollback:true,draftPreserved:true,reopenPersisted:true});
        if(category==='interaction'){
          await evaluate(win,`document.querySelector('details.help').open=true;void 0`);await settle(win);
          const guide=await evaluate(win,`(()=>{const help=document.querySelector('details.help'),content=help.querySelector('.help-content');return {open:help.open,text:content.textContent.trim(),paragraphs:content.querySelectorAll('p').length,shortcuts:[...content.querySelectorAll('dd')].map(node=>node.textContent.trim()),visible:!!content.getClientRects().length};})()`);
          assert.equal(guide.open,true);assert.equal(guide.visible,true);assert.ok(guide.text.length>80&&guide.paragraphs>=2,'Expanded help keeps the interaction and usage explanations');assert.deepEqual(guide.shortcuts,['Ctrl + Alt + M','Ctrl + Alt + Q','Ctrl + Alt + Shift + M']);
          if(language==='en')assert.deepEqual(await cjkText(win),[],'Expanded English help contains no built-in Chinese');
          const helpGeometry=await evaluate(win,`({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,bodyWidth:document.body.scrollWidth})`);assert.ok(helpGeometry.scrollWidth<=helpGeometry.width+1&&helpGeometry.bodyWidth<=helpGeometry.width+1,'Expanded help fits the page');
          await evaluate(win,`document.querySelector('details.help').scrollIntoView({block:'end'});void 0`);await capture(win,f.label+'-settings-'+language+'-'+width+'-help.png');
          cases.push({platform:f.label,kind:'settings-help',language,width,shortcuts:guide.shortcuts,paragraphs:guide.paragraphs});
          await evaluate(win,`document.querySelector('details.help').open=false;void 0`);
        }
      }
    }
    win.setContentSize(660,1100);await changeLanguage(win,f,'zh-CN');await evaluate(win,`window.scrollTo(0,0);void 0`);await capture(win,f.label+'-settings-zh-660.png');win.destroy();
  }
  async function widgetCheck(f){
    f.settings=f.schema.sanitize({...f.settings,language:'en',mode:'quota'});f.revision++;
    const win=createWindow(f,365,461,true);await win.loadFile(path.join(f.base,'src/index.html'));await until(win,`typeof current==='object'&&document.getElementById('maid-image').naturalWidth>0`);
    for(const scale of [.6,1,1.6])for(const mirror of [false,true]){
      const size=f.schema.widgetDimensions(scale);win.setContentSize(size.width,size.height);f.settings=f.schema.sanitize({...f.settings,scale,mirror});f.revision++;f.publish();
      for(const page of ['quota','conversation','accounts','today','week','lastTurn','phrase','resetForecast']){
        phase=f.label+' widget '+page+' '+scale+' '+mirror;
        await evaluate(win,`setMode(${JSON.stringify(page)},false);if(${JSON.stringify(page)}==='conversation'){populateConversationChoices({threads:[{id:'fixture-thread',title:'Polish the desktop companion',workspaceLabel:'Companion workspace'}],selectedId:'fixture-thread',selectionMode:'auto'});renderConversation(${JSON.stringify(f.readyConversation)});}reveal();void 0`);
        await wait(330);
        const geometry=await evaluate(win,`(()=>{const bubble=document.getElementById('bubble').getBoundingClientRect(),view=document.getElementById(${JSON.stringify(page+'-view')}),r=view.getBoundingClientRect();const footer=document.querySelector('.page-navigation').getBoundingClientRect();const selectors=['#bubble-label','#'+view.id+' .eyebrow','#'+view.id+' strong','#'+view.id+' time','#conversation-project','#conversation-feedback','#accounts-feedback','#accounts-empty','#phrase','#primary-label','#secondary','#countdown'];const textBoxes=[...new Set(selectors.flatMap(selector=>[...document.querySelectorAll(selector)]))].filter(el=>el.getClientRects().length&&el.offsetWidth>0).map(el=>{const box=el.getBoundingClientRect(),style=getComputedStyle(el);return {id:el.id||el.className,text:el.textContent,box:{x:box.x,y:box.y,width:box.width,height:box.height},scroll:{width:el.scrollWidth,clientWidth:el.clientWidth,height:el.scrollHeight,clientHeight:el.clientHeight},policy:{overflowX:style.overflowX,overflowY:style.overflowY,textOverflow:style.textOverflow,whiteSpace:style.whiteSpace}};});return {textBoxes,bubble:{x:bubble.x,y:bubble.y,width:bubble.width,height:bubble.height},view:{x:r.x,y:r.y,width:r.width,height:r.height},footer:{y:footer.y,bottom:footer.bottom},viewport:{width:innerWidth,height:innerHeight},viewScroll:{height:view.scrollHeight,client:view.clientHeight,overflow:getComputedStyle(view).overflowY},accountList:{scroll:document.getElementById('account-list').scrollHeight,client:document.getElementById('account-list').clientHeight,overflow:getComputedStyle(document.getElementById('account-list')).overflowY},phrase:{scroll:document.getElementById('phrase').scrollHeight,client:document.getElementById('phrase').clientHeight,overflow:getComputedStyle(document.getElementById('phrase')).overflowY}};})()`);
        const s=size.width/380,b=geometry.bubble,v=geometry.view;
        assert.ok(v.x>=b.x-1&&v.x+v.width<=b.x+b.width+1&&v.y>=b.y-1&&v.y+v.height<=b.y+b.height+1,'Page must fit bubble: '+JSON.stringify({page,scale,geometry}));
        assert.ok(geometry.footer.bottom<=b.y+b.height-7*s,'Navigation is inside the bubble');
        assert.deepEqual(await cjkText(win),[],'English widget contains no built-in Chinese');
        cases.push({platform:f.label,kind:'widget',page,scale,mirror,...geometry});await capture(win,f.label+'-widget-en-'+page+'-'+scale+'-'+(mirror?'left':'right')+'.png');
      }
    }
    if(checkAllPhrases){
      const scale=1.6,mirror=false,size=f.schema.widgetDimensions(scale);
      win.setContentSize(size.width,size.height);f.settings=f.schema.sanitize({...f.settings,scale,mirror});f.revision++;f.publish();
      await until(win,`current.settings.scale===1.6&&current.settings.mirror===false`);
      const defaults=f.schema.DEFAULTS.phrases;
      assert.equal(defaults.length,10,'The complete stock phrase set is covered.');
      await evaluate(win,`setMode('phrase',false);phraseIndex=-1;void 0`);
      for(let index=0;index<defaults.length;index++){
        phase=f.label+' default phrase '+(index+1);await evaluate(win,`nextPhrase();renderPhrase();reveal();void 0`);await settle(win);
        const geometry=await evaluate(win,`(()=>{const view=document.getElementById('phrase-view'),label=document.getElementById('phrase'),style=getComputedStyle(view),font=getComputedStyle(label),gap=parseFloat(style.rowGap)||0;const fixedHeight=[...view.children].filter(child=>child!==label).reduce((height,child)=>height+child.offsetHeight,0);const availableHeight=view.clientHeight-fixedHeight-gap*(view.children.length-1)-(parseFloat(style.paddingTop)||0)-(parseFloat(style.paddingBottom)||0);const rect=el=>{const r=el.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,bottom:r.bottom,right:r.right};};return {index:phraseIndex,text:label.textContent,fontSize:font.fontSize,lineHeight:font.lineHeight,fontFamily:font.fontFamily,availableHeight,heightLimit:Math.min(parseFloat(font.maxHeight)||availableHeight,availableHeight),phrase:{...rect(label),scrollWidth:label.scrollWidth,clientWidth:label.clientWidth,scrollHeight:label.scrollHeight,clientHeight:label.clientHeight},view:{...rect(view),scrollWidth:view.scrollWidth,clientWidth:view.clientWidth,scrollHeight:view.scrollHeight,clientHeight:view.clientHeight},children:[...view.children].map(child=>({tag:child.tagName,...rect(child)}))};})()`);
        assert.equal(geometry.index,index,'nextPhrase visits every default phrase in sequence.');
        assert.equal(geometry.text,await evaluate(win,`t(${JSON.stringify(defaults[index])})`),'Rendered text is the current stock translation.');
        assert.ok(geometry.phrase.scrollWidth<=geometry.phrase.clientWidth+1,'Phrase text fits its width: '+JSON.stringify(geometry));
        assert.ok(geometry.phrase.scrollHeight<=Math.ceil(geometry.heightLimit),'Phrase text fits its reserved height: '+JSON.stringify(geometry));
        assert.ok(geometry.view.scrollWidth<=geometry.view.clientWidth+1&&geometry.view.scrollHeight<=geometry.view.clientHeight+1,'The phrase page has no overflow: '+JSON.stringify(geometry));
        for(const child of geometry.children)assert.ok(child.x>=geometry.view.x-1&&child.right<=geometry.view.right+1&&child.y>=geometry.view.y-1&&child.bottom<=geometry.view.bottom+1,'All phrase elements stay inside the page: '+JSON.stringify(geometry));
        assert.deepEqual(await cjkText(win),[],'English default phrase has no untranslated Chinese');
        cases.push({platform:f.label,kind:'default-phrase',number:index+1,scale,mirror,...geometry});await capture(win,f.label+'-widget-en-default-phrase-'+String(index+1).padStart(2,'0')+'.png');
      }
    }
    const unknown={status:'unavailable',selectionMode:'auto',context:{status:'unavailable'},git:{status:'timeout'},compaction:{status:'unavailable'}};
    for(const [name,result] of [['unavailable',unknown],['not-repository',{...f.readyConversation,context:{status:'unavailable'},git:{status:'not-repository'},compaction:{status:'unavailable'}}]]){
      phase=f.label+' widget conversation '+name;await evaluate(win,`setMode('conversation',false);renderConversation(${JSON.stringify(result)});reveal();void 0`);await capture(win,f.label+'-widget-en-conversation-'+name+'.png');assert.deepEqual(await cjkText(win),[]);
    }
    phase=f.label+' accounts empty';f.accounts=[];f.revision++;f.publish();await evaluate(win,`setMode('accounts',false);reveal();void 0`);await capture(win,f.label+'-widget-en-accounts-empty.png');assert.deepEqual(await cjkText(win),[]);
    win.destroy();
  }
  const watchdog=setTimeout(()=>{writeReport(false,new Error('UI check watchdog timeout'));app.exit(1);},240000);
  app.whenReady().then(async()=>{
    try{for(const [label,base] of [['windows',windowsRoot],['macos',path.join(root,'macos')]]){const fixture=createFixture(base,label);await settingsCheck(fixture);await widgetCheck(fixture);}assert.equal(networkAttempts,0);assert.deepEqual(errors,[]);phase='complete';writeReport(true);console.log(JSON.stringify({ok:true,cases:cases.length,captures:captures.length,report:path.join(output,'language-ui-report.json')}));clearTimeout(watchdog);app.exit(0);}
    catch(error){writeReport(false,error);console.error(phase+': '+error.stack);clearTimeout(watchdog);for(const win of BrowserWindow.getAllWindows())win.destroy();app.exit(1);}
  });
}
