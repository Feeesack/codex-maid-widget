'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { DEFAULTS, sanitize, snapBounds, constrainPosition, widgetDimensions, readSettings, writeSettings } = require('../src/settings.cjs');

const vm = require('node:vm');
const soundCatalog = require('../src/interaction-sound-catalog.js');
test('the curated catalog starts with the bubble default and retains the classic and DSH choices', () => {
  assert.equal(soundCatalog.defaultId, 'bubble-pop');
  assert.equal(sanitize().interactionSound, soundCatalog.defaultId);
  assert.equal(soundCatalog.presets[0].id, soundCatalog.defaultId);
  assert.deepEqual(soundCatalog.presets.map(preset => preset.id), ['bubble-pop','soft-spring','original','wood-tap','dsh-original']);
  assert.equal(soundCatalog.presets.find(preset => preset.id === 'original').label, '经典啾啾');
  assert.equal(soundCatalog.presets.find(preset => preset.id === 'dsh-original').separateBank, true);
  for (const {id} of soundCatalog.presets) assert.equal(sanitize({interactionSound:id,sound:false}).interactionSound,id);
  for (const interactionSound of [null,42,{},['original'],'unknown','__proto__','toString','../sound.wav']) {
    assert.equal(sanitize({interactionSound}).interactionSound,soundCatalog.defaultId);
  }
});
test('removed sound selections migrate to the bubble default without changing saved preferences', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'maid-sound-migration-'));
  t.after(() => fs.rmSync(dir,{recursive:true,force:true}));
  const file = path.join(dir,'settings.json');
  for (const interactionSound of [undefined,'glass-tick','soft-click','mechanical','digital','pluck']) {
    fs.writeFileSync(file,JSON.stringify({sizeBaseline:2,interactionSound,sound:false,scale:1.2,activeCharacterId:'custom-kept',phrases:['保留自定义台词']}));
    const restored = readSettings(file);
    assert.equal(restored.interactionSound,soundCatalog.defaultId);
    assert.equal(restored.sound,false);assert.equal(restored.scale,1.2);assert.equal(restored.activeCharacterId,'custom-kept');
    assert.deepEqual(restored.phrases,['保留自定义台词']);
    writeSettings(file,restored);assert.deepEqual(readSettings(file),restored);
  }
});
test('every interaction sound survives an isolated save without changing mute or character preferences', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'maid-sound-settings-'));
  t.after(() => fs.rmSync(dir,{recursive:true,force:true}));
  const file = path.join(dir,'settings.json');
  for (const {id} of soundCatalog.presets) {
    const settings = sanitize({interactionSound:id,sound:false,scale:1.2,activeCharacterId:'custom-kept',phrases:['保留自定义台词']});
    writeSettings(file,settings);
    assert.deepEqual(readSettings(file),settings);
  }
});
// The actual settings renderer runs against DOM/IPC doubles only; it cannot
// read any real data directory, send native IPC, or play an audio device.
class SettingsElement {
  constructor() {
    this.children = []; this.attributes = {}; this.listeners = {}; this.value = ''; this.textContent = '';
    this.checked = false; this.disabled = false; this.hidden = false;
    const classes = new Set();
    this.classList = {toggle(name,on) { if(on) classes.add(name); else classes.delete(name); },contains(name) {return classes.has(name);}};
  }
  append(...nodes) {this.children.push(...nodes);}
  replaceChildren(...nodes) {this.children = nodes;}
  insertBefore(node,before) {this.children=this.children.filter(item=>item!==node);const index=this.children.indexOf(before);if(index<0)this.children.push(node);else this.children.splice(index,0,node);}
  focus() {this.focused=true;}
  setAttribute(key,value) {this.attributes[key] = value;}
  getAttribute(key) {return this.attributes[key] ?? null;}
  addEventListener(name,callback) {this.listeners[name] = callback;}
}
async function soundSettingsUi(settings = {}, localSamples = {presets:{}}, reduced = false) {
  const html = fs.readFileSync(path.join(__dirname,'../src/settings.html'),'utf8');
  const nodes = new Map([...html.matchAll(/\bid="([^"]+)"/g)].map(match => [match[1],new SettingsElement()]));
  for(const [id,node] of nodes){node.id=id;node.dataset={};if(/^page-(quota|conversation|accounts|today|week|lastTurn|phrase|resetForecast)$/.test(id))node.dataset.pageId=id.slice(5);}
  let sorter;
  // Only the public adapter contract is doubled here. The Electron pointer
  // checks load the official library and exercise its actual dragging/animation.
  const Sortable={create(el,options){sorter={el,options,option(name,...args){if(args.length)options[name]=args[0];return options[name];},toArray(){return this.orderOverride||el.children.map(row=>row.dataset.pageId);}};return sorter;}};
  let value = {settings:sanitize(settings),settingsRevision:0,version:'isolated-fixture',snapshot:{status:'demo',buckets:[]},characters:[],activeCharacterId:'lilac-dragon',characterUrl:'fixture.png',characterName:'隔离测试形象',demo:true};
  const calls = [], actions = [], previews = [], appearancePreviews = [], windowListeners = {}, frames = new Map();
  let frameId=0;
  let listener, save = patch => {
    value = {...value,settings:sanitize({...value.settings,...patch}),settingsRevision:value.settingsRevision+1};
    listener(value);
    return value;
  };
  const maid = {
    getState: async () => value, onState: callback => {listener = callback;},
    setSettings: async patch => {calls.push(JSON.parse(JSON.stringify(patch))); return save(patch);},
    action: async name => {actions.push(name);},
    previewCornerPeek: async patch => {previews.push(patch && JSON.parse(JSON.stringify(patch)));return value;},
    previewAppearance: async patch => {appearancePreviews.push(patch && JSON.parse(JSON.stringify(patch)));return value;},
  };
  let motionQueries = 0;
  const context = {window:{maid,Sortable,MaidInteractionCatalog:soundCatalog,MaidLocalInteractionSamples:localSamples,addEventListener:(name,callback)=>{windowListeners[name]=callback;},requestAnimationFrame:callback=>{frames.set(++frameId,callback);return frameId;},cancelAnimationFrame:id=>frames.delete(id),matchMedia:() => {motionQueries++;return {matches:reduced,addEventListener() {}};}},document:{getElementById:id => nodes.get(id),createElement:() => new SettingsElement(),querySelectorAll:() => []}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../src/settings.js'),'utf8'),context);
  await Promise.resolve();
  return {nodes,calls,actions,previews,appearancePreviews,windowListeners,maid,get sorter(){return sorter;},get value(){return value;},get motionQueries(){return motionQueries;},setSave(callback){save = callback;},broadcast(next) {value = next;listener(next);},async finishSort(order,source='phrase'){const item=nodes.get('page-'+source);sorter.options.onChoose?.({item});sorter.options.onStart?.({item});sorter.el.children=order.map(id=>nodes.get('page-'+id));await sorter.options.onEnd({item});for(let index=0;index<16;index++)await Promise.resolve();},async flushFrames(){const pending=[...frames.values()];frames.clear();for(const callback of pending)callback();for(let index=0;index<8;index++)await Promise.resolve();}};
}
test('obsolete animation choices are ignored without resetting any useful saved preferences', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'maid-animation-settings-'));
  t.after(() => fs.rmSync(dir,{recursive:true,force:true}));
  const file = path.join(dir,'settings.json');
  for (const animationMode of [undefined,null,42,{},['full'],'unknown','system','full','reduced']) {
    const raw = {sizeBaseline:2,animationMode,sound:false,interactionSound:'original',scale:1.2,activeCharacterId:'custom-kept',position:{x:-20,y:70},phrases:['保留自定义台词']};
    fs.writeFileSync(file,JSON.stringify(raw));
    const restored = readSettings(file);
    assert.equal(Object.hasOwn(restored,'animationMode'),false);
    assert.equal(restored.sound,false);assert.equal(restored.interactionSound,'original');assert.equal(restored.scale,1.2);assert.equal(restored.activeCharacterId,'custom-kept');
    assert.deepEqual(restored.position,raw.position);assert.deepEqual(restored.phrases,raw.phrases);
    writeSettings(file,restored);assert.deepEqual(readSettings(file),restored);
    assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(file,'utf8')),'animationMode'),false);
  }
});
test('settings have no animation option, system listener or stale animation save path', async () => {
  assert.equal(Object.hasOwn(DEFAULTS,'animationMode'),false);
  for (const animationMode of ['system','full','reduced']) for (const reduced of [false,true]) {
    const h = await soundSettingsUi({animationMode,sound:false,interactionSound:'original'},undefined,reduced);
    assert.equal(h.nodes.has('animationMode'),false);assert.equal(h.nodes.has('animation-mode-note'),false);
    assert.equal(h.motionQueries,0);assert.equal(Object.hasOwn(h.value.settings,'animationMode'),false);
    assert.deepEqual(h.calls,[]);assert.deepEqual(h.actions,[]);
    assert.equal(h.value.settings.sound,false);assert.equal(h.value.settings.interactionSound,'original');
  }
});
test('topmost settings show native confirmation separately from the saved switch and containment', async () => {
  const h = await soundSettingsUi({alwaysOnTop:true});
  for (const [topmost,expected] of [
    [{desired:true,verified:false,reason:'pending'},/正在应用置顶/],
    [{desired:true,verified:true,reason:'verified'},/已启用置顶/],
    [{desired:false,verified:true,reason:'verified'},/已关闭置顶/],
    [{desired:true,verified:false,reason:'topmost-unavailable'},/暂时无法确认置顶状态/],
  ]) {
    h.broadcast({...h.value,windowContainment:{topmost}});
    assert.match(h.nodes.get('topmost-note').textContent,expected);
  }
  h.broadcast({...h.value,settings:sanitize({...h.value.settings,stayInCodexWindow:true})});
  assert.match(h.nodes.get('topmost-note').textContent,/窗口内模式不使用全局置顶/);
  assert.equal(h.nodes.get('alwaysOnTop').disabled,true);assert.deepEqual(h.calls,[]);
});
test('corner-peeking sliders hide while off, preview input without saving and commit each edge on change', async () => {
  const html = fs.readFileSync(path.join(__dirname,'../src/settings.html'),'utf8');
  for (const id of ['peekBottomPercent','peekSidePercent']) {
    assert.match(html,new RegExp('<label[^>]+for="'+id+'"'));
    assert.match(html,new RegExp('<input id="'+id+'" type="range" min="0" max="200" step="1" value="'+(id==='peekBottomPercent'?50:100)+'"'));
  }
  const h = await soundSettingsUi();
  for (const id of ['peekBottomPercent','peekSidePercent']) {
    const expected=id==='peekBottomPercent'?50:100;
    assert.equal(h.nodes.get(id).disabled,true);assert.equal(Number(h.nodes.get(id).value),expected);
    assert.equal(h.nodes.get(id+'-value').textContent,expected+'%');
    await h.nodes.get(id).listeners.change();
  }
  assert.deepEqual(h.calls,[]);
  assert.equal(h.nodes.get('corner-peek-controls').hidden,true);
  h.nodes.get('peekAtCorners').checked=true;await h.nodes.get('peekAtCorners').listeners.change();
  assert.equal(h.nodes.get('corner-peek-controls').hidden,false);
  assert.deepEqual(h.calls,[{peekAtCorners:true}]);
  for (const id of ['peekBottomPercent','peekSidePercent']) assert.equal(h.nodes.get(id).disabled,false);
  for (const value of [120,145,160]) {
    h.nodes.get('peekBottomPercent').value=value;h.nodes.get('peekBottomPercent').listeners.input();
    assert.equal(h.nodes.get('peekBottomPercent-value').textContent,value+'%');
  }
  assert.equal(h.calls.length,1,'dragging updates the label without writing settings');
  await h.flushFrames();assert.deepEqual(h.previews,[{peekBottomPercent:160,peekSidePercent:100}],'multiple input events share a single frame preview');
  h.broadcast({...h.value,snapshot:{status:'demo',buckets:[]}});
  assert.equal(Number(h.nodes.get('peekBottomPercent').value),160,'an unrelated update preserves the draft');
  await h.nodes.get('peekBottomPercent').listeners.change();
  assert.deepEqual(h.calls[1],{peekBottomPercent:160});
  assert.equal(h.value.settings.peekSidePercent,100);
  h.nodes.get('peekSidePercent').value=0;h.nodes.get('peekSidePercent').listeners.input();
  await h.nodes.get('peekSidePercent').listeners.change();
  assert.deepEqual(h.calls[2],{peekSidePercent:0});
  assert.equal(h.value.settings.peekBottomPercent,160);assert.equal(h.value.settings.peekSidePercent,0);
  h.nodes.get('peekAtCorners').checked=false;await h.nodes.get('peekAtCorners').listeners.change();
  assert.equal(h.nodes.get('corner-peek-controls').hidden,true);
  for (const id of ['peekBottomPercent','peekSidePercent']) assert.equal(h.nodes.get(id).disabled,true);
  const reopened = await soundSettingsUi(h.value.settings);
  assert.equal(Number(reopened.nodes.get('peekBottomPercent').value),160);
  assert.equal(Number(reopened.nodes.get('peekSidePercent').value),0);
  reopened.nodes.get('peekAtCorners').checked=true;await reopened.nodes.get('peekAtCorners').listeners.change();
  assert.equal(Number(reopened.nodes.get('peekBottomPercent').value),160);
  assert.equal(Number(reopened.nodes.get('peekSidePercent').value),0);
});
test('failed or mismatched corner-peeking saves roll back visibly and allow retry', async () => {
  for (const mismatch of [false,true]) {
    const h=await soundSettingsUi({peekAtCorners:true,peekBottomPercent:80,peekSidePercent:120});
    h.setSave(() => mismatch ? h.value : Promise.reject(new Error('isolated failure')));
    h.nodes.get('peekBottomPercent').value=170;h.nodes.get('peekBottomPercent').listeners.input();
    await h.nodes.get('peekBottomPercent').listeners.change();
    assert.equal(Number(h.nodes.get('peekBottomPercent').value),80);
    assert.equal(h.nodes.get('peekBottomPercent-value').textContent,'80%');
    assert.equal(Number(h.nodes.get('peekSidePercent').value),120);
    assert.match(h.nodes.get('corner-peek-feedback').textContent,/未能保存/);
    assert.equal(h.nodes.get('corner-peek-feedback').classList.contains('has-error'),true);
    assert.equal(h.nodes.get('peekBottomPercent').disabled,false);
    h.setSave(patch => ({...h.value,settings:sanitize({...h.value.settings,...patch}),settingsRevision:1}));
    h.nodes.get('peekBottomPercent').value=170;await h.nodes.get('peekBottomPercent').listeners.change();
    assert.equal(Number(h.nodes.get('peekBottomPercent').value),170);
    assert.equal(h.nodes.get('corner-peek-feedback').classList.contains('has-error'),false);
    assert.match(h.nodes.get('corner-peek-feedback').textContent,/已保存/);
  }
  const off=await soundSettingsUi({peekBottomPercent:75});
  off.setSave(() => Promise.reject(new Error('isolated switch failure')));
  off.nodes.get('peekAtCorners').checked=true;await off.nodes.get('peekAtCorners').listeners.change();
  assert.equal(off.nodes.get('peekAtCorners').checked,false);
  assert.equal(off.nodes.get('peekBottomPercent').disabled,true);
  assert.equal(Number(off.nodes.get('peekBottomPercent').value),75);
  assert.match(off.nodes.get('corner-peek-feedback').textContent,/未能保存/);
});
test('pending corner-peeking saves retain the draft and older replies cannot revert a newer state', async () => {
  const h=await soundSettingsUi({peekAtCorners:true,peekSidePercent:90});
  let resolveSave;h.setSave(() => new Promise(resolve => {resolveSave=resolve;}));
  h.nodes.get('peekBottomPercent').value=150;h.nodes.get('peekBottomPercent').listeners.input();
  const pending=h.nodes.get('peekBottomPercent').listeners.change();
  await Promise.resolve();
  for (const id of ['peekAtCorners','peekBottomPercent','peekSidePercent']) assert.equal(h.nodes.get(id).disabled,true);
  h.broadcast({...h.value,snapshot:{status:'demo',buckets:[]}});
  assert.equal(Number(h.nodes.get('peekBottomPercent').value),150);
  const older={...h.value,settings:sanitize({...h.value.settings,peekBottomPercent:150}),settingsRevision:1};
  h.broadcast({...older,settings:sanitize({...older.settings,peekSidePercent:45}),settingsRevision:2});
  resolveSave(older);await pending;
  assert.equal(Number(h.nodes.get('peekBottomPercent').value),150);
  assert.equal(Number(h.nodes.get('peekSidePercent').value),45);
  h.broadcast(older);
  assert.equal(Number(h.nodes.get('peekSidePercent').value),45);
  assert.equal(h.nodes.get('peekBottomPercent').disabled,false);
  assert.deepEqual(h.calls,[{peekBottomPercent:150}]);
});
test('cancelled peek drafts restore saved values and cannot accidentally commit on change', async () => {
  for (const event of ['pointercancel','Escape','blur','pagehide']) {
    const h=await soundSettingsUi({peekAtCorners:true});
    const slider=h.nodes.get('peekBottomPercent');slider.value=175;slider.listeners.input();await h.flushFrames();
    assert.deepEqual(h.previews,[{peekBottomPercent:175,peekSidePercent:100}]);
    if(event==='Escape')await slider.listeners.keydown({key:'Escape',preventDefault(){}});
    else if(event==='pointercancel')await slider.listeners.pointercancel();
    else await h.windowListeners[event]();
    assert.equal(h.previews.at(-1),null);
    assert.equal(Number(slider.value),50);assert.equal(h.nodes.get('peekBottomPercent-value').textContent,'50%');
    await slider.listeners.change();assert.deepEqual(h.calls,[]);
  }
  const failed=await soundSettingsUi({peekAtCorners:true});
  failed.maid.previewCornerPeek=async patch=>{failed.previews.push(patch);if(patch)throw new Error('isolated preview failure');};
  failed.nodes.get('peekBottomPercent').value=175;failed.nodes.get('peekBottomPercent').listeners.input();await failed.flushFrames();
  assert.equal(failed.previews.at(-1),null);assert.equal(Number(failed.nodes.get('peekBottomPercent').value),50);
  assert.match(failed.nodes.get('corner-peek-feedback').textContent,/预览未完成/);assert.deepEqual(failed.calls,[]);
});
test('a commit drains in-flight previews and drops queued old input before writing once', async () => {
  const h=await soundSettingsUi({peekAtCorners:true});let resolvePreview;
  h.maid.previewCornerPeek=patch=>{h.previews.push(patch);return new Promise(resolve=>{resolvePreview=resolve;});};
  const slider=h.nodes.get('peekBottomPercent');slider.value=100;slider.listeners.input();await h.flushFrames();
  for(const value of [150,200]){slider.value=value;slider.listeners.input();}await h.flushFrames();
  assert.equal(h.previews.length,1,'only one preview can be in flight');
  const commit=slider.listeners.change();assert.deepEqual(h.calls,[]);
  resolvePreview({...h.value,settings:sanitize({...h.value.settings,peekBottomPercent:100})});await commit;await h.flushFrames();
  assert.deepEqual(h.calls,[{peekBottomPercent:200}]);assert.equal(h.previews.length,1,'old queued input cannot replay after the save');
  assert.equal(Number(slider.value),200);assert.equal(h.nodes.get('peekBottomPercent-value').textContent,'200%');
});
test('the settings renderer lists the lightweight catalog and never autoplays while choosing', async () => {
  const h = await soundSettingsUi({sound:false});
  assert.deepEqual(h.nodes.get('interactionSound').children.map(option => [option.value,option.textContent]),soundCatalog.presets.map(({id,label}) => [id,label]));
  assert.equal(h.nodes.get('interactionSound').value,soundCatalog.defaultId);
  h.nodes.get('interactionSound').value = 'original';
  await h.nodes.get('interactionSound').listeners.change();
  assert.deepEqual(h.calls,[{interactionSound:'original'}]);
  assert.equal(h.value.settings.interactionSound,'original');assert.equal(h.value.settings.sound,false);
  assert.equal(h.nodes.get('preview-interaction-sound').disabled,true);
  await h.nodes.get('preview-interaction-sound').listeners.click();
  assert.deepEqual(h.actions,[]);
  assert.match(h.nodes.get('interaction-sound-note').textContent,/已关闭/);
});
test('an uninstalled local DSH sound is disabled and cannot silently preview another sound', async () => {
  const h = await soundSettingsUi({interactionSound:'dsh-original'});
  assert.equal(h.nodes.get('interactionSound').children.find(option => option.value === 'dsh-original').disabled,true);
  assert.equal(h.nodes.get('interactionSound').children.filter(option => !option.disabled).length,4);
  assert.match(h.nodes.get('interaction-sound-description').textContent,/此音效尚未在本机安装/);
  assert.equal(h.nodes.get('preview-interaction-sound').disabled,true);
  await h.nodes.get('preview-interaction-sound').listeners.click();
  assert.deepEqual(h.actions,[]);assert.equal(h.value.settings.interactionSound,'dsh-original');
  const fresh = await soundSettingsUi();
  fresh.nodes.get('interactionSound').value = 'dsh-original';
  await fresh.nodes.get('interactionSound').listeners.change();
  assert.deepEqual(fresh.calls,[]);assert.equal(fresh.nodes.get('interactionSound').value,soundCatalog.defaultId);
});
test('an installed local DSH sound can be selected and previewed without changing mute preferences', async () => {
  const h = await soundSettingsUi({}, {presets:{'dsh-original':{press:'isolated-press',release:'isolated-release',gain:1}}});
  assert.equal(h.nodes.get('interactionSound').children.find(option => option.value === 'dsh-original').disabled,false);
  h.nodes.get('interactionSound').value = 'dsh-original';
  await h.nodes.get('interactionSound').listeners.change();
  assert.equal(h.value.settings.interactionSound,'dsh-original');
  assert.equal(h.nodes.get('preview-interaction-sound').disabled,false);
  await h.nodes.get('preview-interaction-sound').listeners.click();
  assert.deepEqual(h.actions,['bounce']);assert.deepEqual(h.calls,[{interactionSound:'dsh-original'}]);
});
test('a pending sound save blocks preview until its matching state is confirmed', async () => {
  const h = await soundSettingsUi();
  let resolveSave;
  h.setSave(() => new Promise(resolve => {resolveSave = resolve;}));
  h.nodes.get('interactionSound').value = 'original';
  const pending = h.nodes.get('interactionSound').listeners.change();
  assert.equal(h.nodes.get('interactionSound').disabled,true);
  assert.equal(h.nodes.get('preview-interaction-sound').disabled,true);
  await h.nodes.get('preview-interaction-sound').listeners.click();
  assert.deepEqual(h.actions,[]);
  // An unrelated broadcast cannot revert the selected option mid-save.
  h.broadcast({...h.value,snapshot:{status:'demo',buckets:[]}});
  assert.equal(h.nodes.get('interactionSound').value,'original');
  const saved = {...h.value,settings:sanitize({...h.value.settings,interactionSound:'original'})};
  resolveSave(saved);await pending;
  assert.equal(h.nodes.get('interactionSound').disabled,false);
  assert.equal(h.nodes.get('preview-interaction-sound').disabled,false);
  await h.nodes.get('preview-interaction-sound').listeners.click();
  assert.deepEqual(h.actions,['bounce']);
  assert.deepEqual(h.calls,[{interactionSound:'original'}]);
});
test('failed or mismatched sound saves roll back the selection and cannot preview a stale choice', async () => {
  for (const mismatch of [false,true]) {
    const h = await soundSettingsUi();
    h.setSave(() => mismatch ? h.value : Promise.reject(new Error('isolated failure')));
    h.nodes.get('interactionSound').value = 'original';
    await h.nodes.get('interactionSound').listeners.change();
    assert.equal(h.nodes.get('interactionSound').value,soundCatalog.defaultId);
    assert.equal(h.nodes.get('preview-interaction-sound').disabled,true);
    assert.match(h.nodes.get('interaction-sound-feedback').textContent,/未能保存/);
    await h.nodes.get('preview-interaction-sound').listeners.click();
    assert.deepEqual(h.actions,[]);
    h.setSave(patch => ({...h.value,settings:sanitize({...h.value.settings,...patch})}));
    h.nodes.get('interactionSound').value = 'original';
    await h.nodes.get('interactionSound').listeners.change();
    assert.equal(h.nodes.get('preview-interaction-sound').disabled,false);
  }
});
test('turning audio off blocks preview immediately and keeps the chosen sound', async () => {
  const h = await soundSettingsUi({interactionSound:'original'});
  let resolveSave;
  h.setSave(() => new Promise(resolve => {resolveSave = resolve;}));
  h.nodes.get('sound').checked = false;
  const pending = h.nodes.get('sound').listeners.change();
  assert.equal(h.nodes.get('preview-interaction-sound').disabled,true);
  await h.nodes.get('preview-interaction-sound').listeners.click();
  assert.deepEqual(h.actions,[]);
  resolveSave({...h.value,settings:sanitize({...h.value.settings,sound:false})});await pending;
  assert.equal(h.nodes.get('interactionSound').value,'original');
  assert.equal(h.nodes.get('preview-interaction-sound').disabled,true);
  assert.deepEqual(h.calls,[{sound:false}]);
});
test('a preview failure remains in the settings feedback and does not change preferences', async () => {
  const h = await soundSettingsUi({interactionSound:'original'});
  h.maid.action = async () => {throw new Error('isolated action failure');};
  await h.nodes.get('preview-interaction-sound').listeners.click();
  assert.match(h.nodes.get('interaction-sound-feedback').textContent,/试听未完成/);
  assert.equal(h.nodes.get('preview-interaction-sound').disabled,false);
  assert.deepEqual(h.calls,[]);
});

test('bubble page schema migrates legacy mode, repairs order and keeps a visible default without changing current mode', t => {
  const ids=['quota','conversation','accounts','today','week','lastTurn','phrase','resetForecast'];
  for(const mode of ids){const value=sanitize({mode});assert.deepEqual(value.bubblePageOrder,ids);assert.deepEqual(value.bubbleHiddenPages,[]);assert.equal(value.defaultBubblePage,mode);assert.equal(value.mode,mode);}
  const repaired=sanitize({mode:'week',bubblePageOrder:['phrase','bad','quota','phrase'],bubbleHiddenPages:['phrase','bad'],defaultBubblePage:'phrase'});
  assert.deepEqual(repaired.bubblePageOrder,['phrase','quota','conversation','accounts','today','week','lastTurn','resetForecast']);assert.deepEqual(repaired.bubbleHiddenPages,['phrase']);assert.equal(repaired.defaultBubblePage,'quota');assert.equal(repaired.mode,'week');
  const allHidden=sanitize({mode:'accounts',bubbleHiddenPages:ids});assert.equal(allHidden.bubbleHiddenPages.length,7);assert.equal(allHidden.defaultBubblePage,'accounts');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'maid 气泡 pages '));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const file=path.join(dir,'settings.json');writeSettings(file,repaired);assert.deepEqual(readSettings(file),repaired);
});
test('bubble cards commit the Sortable drop and keyboard order, select defaults directly and protect the last visible page',async()=>{
  const h=await soundSettingsUi();
  assert.equal(h.nodes.has('mode'),false);
  assert.equal([...h.nodes.keys()].some(id=>/^page-(up|down)-/.test(id)),false,'right-side ordering controls are absent from the production HTML');assert.doesNotMatch(fs.readFileSync(path.join(__dirname,'../src/settings.html'),'utf8'),/page-order-buttons/);
  h.nodes.get('page-default-week').checked=true;await h.nodes.get('page-default-week').listeners.change();assert.equal(h.value.settings.defaultBubblePage,'week');assert.equal(h.value.settings.mode,'quota');
  await h.nodes.get('page-handle-week').listeners.keydown({altKey:true,key:'ArrowUp',preventDefault(){}});assert.equal(h.value.settings.bubblePageOrder[3],'week');
  await h.nodes.get('page-handle-week').listeners.keydown({altKey:true,key:'ArrowUp',preventDefault(){}});assert.equal(h.value.settings.bubblePageOrder[2],'week');
  await h.finishSort(['phrase',...h.value.settings.bubblePageOrder.filter(id=>id!=='phrase')]);assert.equal(h.value.settings.bubblePageOrder[0],'phrase');
  h.nodes.get('page-visible-week').checked=false;await h.nodes.get('page-visible-week').listeners.change();assert.equal(h.value.settings.defaultBubblePage,'phrase');assert.match(h.nodes.get('bubble-pages-feedback').textContent,/原默认页已隐藏/);
  for(const id of ['quota','conversation','accounts','today','lastTurn','resetForecast']){h.nodes.get('page-visible-'+id).checked=false;await h.nodes.get('page-visible-'+id).listeners.change();}
  const writes=h.calls.length;h.nodes.get('page-visible-phrase').checked=false;await h.nodes.get('page-visible-phrase').listeners.change();assert.equal(h.calls.length,writes);assert.equal(h.nodes.get('page-visible-phrase').checked,true);assert.match(h.nodes.get('bubble-pages-feedback').textContent,/至少保留/);
  const reopened=await soundSettingsUi(h.value.settings);assert.equal(reopened.nodes.get('page-default-phrase').checked,true);assert.equal(reopened.nodes.get('page-visible-week').checked,false);
  reopened.setSave(()=>Promise.reject(new Error('isolated page commit failure')));await reopened.nodes.get('page-handle-quota').listeners.keydown({altKey:true,key:'ArrowUp',preventDefault(){}});assert.match(reopened.nodes.get('bubble-pages-feedback').textContent,/未能保存/);assert.equal(reopened.nodes.get('page-default-phrase').checked,true);
});

test('Sortable adapter keeps in-progress order through status broadcasts and commits only a valid changed drop',async()=>{
  const h=await soundSettingsUi({defaultBubblePage:'week',bubbleHiddenPages:['conversation','lastTurn']});
  const saved=JSON.parse(JSON.stringify(h.value.settings)),order=['phrase',...saved.bubblePageOrder.filter(id=>id!=='phrase')],item=h.nodes.get('page-phrase');
  assert.equal(h.sorter.options.handle,'.page-drag-handle');assert.equal(h.sorter.options.forceFallback,true);assert.ok(h.sorter.options.animation>0);
  h.sorter.options.onChoose({item});h.sorter.options.onStart?.({item});h.sorter.el.children=order.map(id=>h.nodes.get('page-'+id));
  assert.deepEqual(h.calls,[]);assert.deepEqual(h.value.settings,saved);
  h.broadcast({...h.value,snapshot:{status:'demo',buckets:[]}});
  assert.deepEqual(h.sorter.el.children.map(row=>row.dataset.pageId),order,'ordinary rendering must not reset the active DOM order');
  assert.equal(h.sorter.options.disabled,false,'the active official drag stays enabled');assert.equal(h.nodes.get('page-visible-quota').disabled,true);
  await h.sorter.options.onEnd({item});for(let index=0;index<16;index++)await Promise.resolve();
  assert.equal(h.calls.length,1);assert.deepEqual(h.value.settings.bubblePageOrder,order);assert.equal(h.value.settings.defaultBubblePage,'week');assert.deepEqual(h.value.settings.bubbleHiddenPages,['conversation','lastTurn']);
  await h.finishSort(order);assert.equal(h.calls.length,1,'dropping back at the saved position makes no settings request');
  h.sorter.orderOverride=['quota','quota'];await h.finishSort(order);assert.equal(h.calls.length,1,'invalid or duplicate DOM identifiers must not reach settings persistence');
  assert.deepEqual(h.sorter.el.children.map(row=>row.dataset.pageId),order);delete h.sorter.orderOverride;
});

test('a rejected Sortable drop restores confirmed order, visibility and default and releases its controls',async()=>{
  const h=await soundSettingsUi({defaultBubblePage:'today',bubbleHiddenPages:['accounts','phrase']});
  const saved=JSON.parse(JSON.stringify(h.value.settings));h.setSave(()=>Promise.reject(new Error('isolated sort commit failure')));
  await h.finishSort(['phrase',...saved.bubblePageOrder.filter(id=>id!=='phrase')]);
  assert.equal(h.calls.length,1);assert.deepEqual(h.value.settings,saved);assert.deepEqual(h.sorter.el.children.map(row=>row.dataset.pageId),saved.bubblePageOrder);
  assert.equal(h.nodes.get('page-default-today').checked,true);assert.equal(h.nodes.get('page-visible-phrase').checked,false);assert.equal(h.nodes.get('page-visible-quota').disabled,false);assert.equal(h.sorter.options.disabled,false);assert.match(h.nodes.get('bubble-pages-feedback').textContent,/未能保存/);
});
test('appearance sliders share bounded previews, keep drafts across broadcasts and recover on cancel or failed save',async()=>{
  const h=await soundSettingsUi();
  for(const value of [.8,1.2,1.4]){h.nodes.get('scale').value=value;h.nodes.get('scale').listeners.input();}await h.flushFrames();assert.deepEqual(h.appearancePreviews,[{scale:1.4,opacity:1}]);assert.deepEqual(h.calls,[]);
  h.broadcast({...h.value,snapshot:{status:'demo',buckets:[]}});assert.equal(Number(h.nodes.get('scale').value),1.4);assert.equal(h.nodes.get('scale-value').textContent,'140%');
  await h.nodes.get('scale').listeners.change();assert.deepEqual(h.calls,[{scale:1.4}]);assert.equal(h.value.settings.scale,1.4);
  h.nodes.get('opacity').value=.5;h.nodes.get('opacity').listeners.input();await h.flushFrames();await h.nodes.get('opacity').listeners.keydown({key:'Escape',preventDefault(){}});assert.equal(h.appearancePreviews.at(-1),null);assert.equal(Number(h.nodes.get('opacity').value),1);assert.equal(h.calls.length,1);
  h.setSave(()=>Promise.reject(new Error('isolated appearance commit failure')));h.nodes.get('opacity').value=.6;h.nodes.get('opacity').listeners.input();await h.nodes.get('opacity').listeners.change();assert.equal(Number(h.nodes.get('opacity').value),1);assert.match(h.nodes.get('appearance-feedback').textContent,/未能保存/);assert.equal(h.appearancePreviews.at(-1),null);
});

const previousDefaultPhrases = [
  '先开分支再放大招，勇者翻车也得留个存档点。',
  '测试还红着就别插旗啦，这集还没到庆功宴呢。',
  '上下文别塞成异世界史书，Codex 也得翻目录。',
  'Tibo 重置教父在上……咳，先喝茶，少搞玄学。',
  '又在等 OpenAI 的「soon」？先把这杯茶喝完。',
  '别盯着进度条施法，茶凉了可不算 Codex 的锅。',
  '报错先看第一行，别急着给整座魔王城重装修。',
  '这点小 bug 还轮不到龙息出场，把日志拿来。',
  '不是专门陪你熬夜，刚好这壶茶还没泡完而已。',
  '灵感来了先记两行，别指望明天还能原地读档。',
  '需求又追加？行吧，这次的支线任务得加一块布丁。',
  '别急着重构宇宙，眼前这只史莱姆还卡着编译呢。',
];
test('settings reject invalid values and preserve useful preferences',()=>{
  const s=sanitize({scale:99,opacity:NaN,refreshSeconds:-10,mode:'bad',clickThrough:'yes',phrases:['',' hi ',null],position:{x:-1800,y:40}});
  assert.equal(s.scale,1.6);assert.equal(s.opacity,1);assert.equal(s.refreshSeconds,30);assert.equal(s.mode,'quota');assert.equal(s.clickThrough,false);assert.deepEqual(s.phrases,['hi']);assert.equal(s.position.x,-1800);
});
test('bounce audio is enabled by default and an explicit mute is retained',()=>{
  assert.equal(sanitize().sound,true);
  assert.equal(sanitize({sound:false}).sound,false);
});
test('following Codex is enabled by default and an explicit opt-out is retained',()=>{
  assert.equal(sanitize().followCodex,true);
  assert.equal(sanitize({followCodex:false}).followCodex,false);
  assert.equal(sanitize({followCodex:'false'}).followCodex,true);
});
test('Frost Glass cheek is the default while all saved character choices survive',()=>{
  assert.equal(sanitize().activeCharacterId,'frost-glass-cheek');
  for(const activeCharacterId of ['mint-maid','lilac-dragon','frost-glass-idle','frost-glass-cheek','custom-saved-character']) {
    assert.equal(sanitize({activeCharacterId}).activeCharacterId,activeCharacterId);
  }
});
test('untouched old dialogue upgrades once while unrelated preferences survive',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'maid-dialogue-upgrade-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const file=path.join(dir,'settings.json');
  const phrases=['主人，今天也一起把想法变成代码吧。','额度我来照看，你只管专心创造。','写累了记得喝水，休息一下也很好。','每一个小进展，都值得开心一下。'];
  fs.writeFileSync(file,JSON.stringify({sizeBaseline:2,scale:1.2,sound:false,activeCharacterId:'mint-maid',phrases,position:{x:-200,y:100}}));
  const upgraded=readSettings(file);
  assert.deepEqual(upgraded.phrases,DEFAULTS.phrases);
  assert.equal(upgraded.scale,1.2);assert.equal(upgraded.sound,false);assert.equal(upgraded.activeCharacterId,'mint-maid');
  assert.deepEqual(upgraded.position,{x:-200,y:100});
  writeSettings(file,upgraded);
  assert.deepEqual(readSettings(file),upgraded);
});
test('the rejected 0.3.4 preset upgrades and persists without changing other preferences',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'maid-dialogue-035-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const file=path.join(dir,'settings.json');
  const old=sanitize({phrases:previousDefaultPhrases,activeCharacterId:'lilac-dragon',scale:1.1,sound:false,mode:'phrase'});
  writeSettings(file,old);
  const upgraded=readSettings(file);
  assert.deepEqual(upgraded,{...old,phrases:DEFAULTS.phrases});
  writeSettings(file,upgraded);
  assert.deepEqual(readSettings(file),upgraded);
});
test('custom dialogue including an edited old preset is preserved across upgrades',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'maid-dialogue-custom-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const file=path.join(dir,'settings.json');
  for(const phrases of [
    ['我的自定义台词'],
    ['主人，今天也一起把想法变成代码吧。','额度我来照看，你只管专心创造。','写累了记得喝水，休息一下也很好。','这句是我改的。'],
    [...previousDefaultPhrases.slice(0,-1),'这句是我自己改的。'],
    previousDefaultPhrases.slice(1),
    [...DEFAULTS.phrases],
  ]) {
    writeSettings(file,sanitize({phrases}));
    assert.deepEqual(readSettings(file).phrases,phrases);
  }
});
test('weekly and conversation pages and Codex-follow preferences survive saving and reopening settings',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'maid-week-settings-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const file=path.join(dir,'settings.json');
  for (const mode of ['week','conversation']) {
    writeSettings(file,sanitize({mode,followCodex:false}));
    const restored=readSettings(file);
    assert.equal(restored.mode,mode);assert.equal(restored.followCodex,false);
  }
});
test('left half mirrors without magnetizing the side of a negative-coordinate monitor',()=>{
  const p=snapBounds({x:-1910,y:102,width:380,height:480},{x:-1920,y:0,width:1920,height:1080});
  assert.deepEqual(p,{x:-1910,y:102,mirror:true});
});
test('right/bottom snap and disconnected display recovery remain in work area',()=>{
  const area={x:0,y:0,width:1920,height:1040};
  assert.deepEqual(snapBounds({x:1530,y:550,width:380,height:480},area),{x:1540,y:560,mirror:false});
  assert.deepEqual(constrainPosition({x:8000,y:-200,width:380,height:480},area),{x:1540,y:0});
});
test('mirroring follows the left half independently of the snap threshold and container offset',()=>{
  for (const area of [{x:0,y:0,width:1920,height:1080},{x:100,y:200,width:800,height:600},{x:-1920,y:0,width:1920,height:1080}]) {
    for (const width of [137,228,319]) {
      const centre=area.x+(area.width-width)/2;
      assert.equal(snapBounds({x:centre-90,y:area.y+100,width,height:288},area).mirror,true);
      assert.equal(snapBounds({x:centre+90,y:area.y+100,width,height:288},area).mirror,false);
      assert.equal(snapBounds({x:centre,y:area.y+100,width,height:288},area).mirror,false);
    }
  }
});
test('new 100% equals former 60%, and migrating a saved size happens only once', t=>{
  assert.deepEqual(widgetDimensions(),{width:228,height:288});
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'maid-settings-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const file=path.join(dir,'settings.json');
  fs.writeFileSync(file,JSON.stringify({scale:0.6,mirror:true,opacity:0.75,phrases:['保留台词'],position:{x:0,y:250}}));
  const migrated=readSettings(file);
  assert.equal(migrated.scale,1);assert.equal(migrated.sizeBaseline,2);
  assert.equal(migrated.mirror,true);assert.equal(migrated.opacity,0.75);
  assert.deepEqual(migrated.phrases,['保留台词']);assert.deepEqual(migrated.position,{x:0,y:250});
  writeSettings(file,migrated);
  assert.equal(readSettings(file).scale,1);
});
