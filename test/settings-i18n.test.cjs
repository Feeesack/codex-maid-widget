'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Renderer-only fixture: every state/IPC response is supplied below. No app,
// data-home provider, filesystem settings, account reader or native IPC starts.
class Node {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase(); this.children = []; this.childNodes = [];
    this.attributes = {}; this.listeners = {}; this.dataset = {};
    this.value = ''; this.textContent = ''; this.checked = false; this.disabled = false; this.hidden = false;
    const classes = new Set(); this.classList = {toggle(name, on) { if (on) classes.add(name); else classes.delete(name); }, contains(name) { return classes.has(name); }};
  }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  hasAttribute(name) { return Object.hasOwn(this.attributes, name); }
  removeAttribute(name) { delete this.attributes[name]; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  insertBefore(node, before) { this.children = this.children.filter(item => item !== node); const index = this.children.indexOf(before); this.children.splice(index < 0 ? this.children.length : index, 0, node); }
  addEventListener(name, callback) { this.listeners[name] = callback; }
  focus() { this.focused = true; }
  select() { this.selected = true; }
  querySelectorAll(selector) { return this.children.flatMap(child => [child, ...child.querySelectorAll(selector)]).filter(child => selector === 'button' && child.tagName === 'BUTTON'); }
}
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => {resolve = yes; reject = no;}); return {promise, resolve, reject}; }

async function settingsUi(directory, overrides = {}) {
  const root = path.join(__dirname, '..', directory), nodes = new Map(), marked = [], made = [];
  const html = fs.readFileSync(path.join(root, 'settings.html'), 'utf8');
  const decode = value => value.replace(/&quot;/g, '"').replace(/&amp;/g, '&');
  for (const tag of html.matchAll(/<([a-z][a-z0-9-]*)\b([^>]*)>/gi)) {
    const attrs = Object.fromEntries([...tag[2].matchAll(/([a-z][a-z0-9-]*)="([^"]*)"/gi)].map(match => [match[1], decode(match[2])]));
    if (!attrs.id && !Object.keys(attrs).some(name => name.startsWith('data-i18n'))) continue;
    const node = new Node(tag[1]); node.attributes = attrs;
    if (attrs.id) { node.id = attrs.id; nodes.set(attrs.id, node); }
    if (attrs['data-page-id']) node.dataset.pageId = attrs['data-page-id'];
    if (Object.keys(attrs).some(name => name.startsWith('data-i18n'))) marked.push(node);
  }
  const {sanitize} = require(path.join(root, 'settings.cjs'));
  let state = {version:'isolated-fixture', settings:sanitize(overrides), settingsRevision:0,
    snapshot:{status:'demo',buckets:[]}, characters:[], activeCharacterId:'custom-fixture', characterUrl:'fixture.png', characterName:'测试形象', demo:true};
  let listener, saveOverride, refreshOverride = async () => {}, importOverride = async () => ({importedCount:0});
  const calls = [];
  const document = {documentElement:{lang:'zh-CN'}, getElementById:id => nodes.get(id), createElement:tag => {const node = new Node(tag); made.push(node); return node;},
    querySelectorAll:() => [...marked, ...made.filter(node => Object.keys(node.attributes).some(name => name.startsWith('data-i18n')))]};
  const context = {document, console, addEventListener() {}, requestAnimationFrame:() => 1, cancelAnimationFrame() {},
    MaidInteractionCatalog:require(path.join(root,'interaction-sound-catalog.js')), MaidLocalInteractionSamples:{presets:{}},
    Sortable:{create(element) {return {option() {},toArray:() => element.children.map(node => node.dataset.pageId)};}},
    maid:{getState:async () => state, onState:callback => {listener = callback;}, action:async () => {},
      previewCornerPeek:async () => state, previewAppearance:async () => state,
      setSettings:async patch => {calls.push(JSON.parse(JSON.stringify(patch))); if (saveOverride) return saveOverride(patch); state = {...state,settings:sanitize({...state.settings,...patch}),settingsRevision:state.settingsRevision+1}; listener(state); return state;},
      refresh:() => refreshOverride(), importCharacters:() => importOverride()},
  };
  context.window = context;
  vm.createContext(context);
  for (const file of ['i18n.js','i18n-settings.js','settings.js']) vm.runInContext(fs.readFileSync(path.join(root,file),'utf8'),context,{filename:file});
  await Promise.resolve();
  return {nodes, marked, calls, document, i18n:context.MaidI18n, get state() {return state;}, setSave:callback => {saveOverride = callback;}, setRefresh:callback => {refreshOverride = callback;}, setImport:callback => {importOverride = callback;},
    broadcast(patch) {state = {...state,...patch}; listener(state);}, async language(value) {nodes.get('language').value=value; return nodes.get('language').listeners.change();}};
}

for (const directory of ['src', 'macos/src']) {
  test(directory + ': settings categories switch panels without changing control ids', async () => {
    const h = await settingsUi(directory);
    const categories = ['general', 'appearance', 'display', 'chat', 'interaction'];
    assert.equal(h.nodes.get('settings-panel-general').hidden, false);
    assert.equal(h.nodes.get('settings-tab-general').getAttribute('aria-selected'), 'true');
    for (const id of categories.slice(1)) {
      assert.equal(h.nodes.get('settings-panel-' + id).hidden, true);
      assert.equal(h.nodes.get('settings-tab-' + id).getAttribute('aria-selected'), 'false');
    }
    h.nodes.get('settings-tab-chat').listeners.click();
    assert.equal(h.nodes.get('settings-panel-chat').hidden, false);
    assert.equal(h.nodes.get('settings-panel-general').hidden, true);
    assert.equal(h.nodes.get('settings-tab-chat').getAttribute('aria-selected'), 'true');
    h.nodes.get('settings-tab-chat').listeners.keydown({key:'ArrowRight',preventDefault(){}});
    assert.equal(h.nodes.get('settings-panel-interaction').hidden, false);
    assert.equal(h.nodes.get('settings-tab-interaction').getAttribute('aria-selected'), 'true');
    h.nodes.get('settings-tab-interaction').listeners.keydown({key:'ArrowRight',preventDefault(){}});
    assert.equal(h.nodes.get('settings-panel-general').hidden, false);
    h.nodes.get('settings-tab-general').listeners.keydown({key:'End',preventDefault(){}});
    assert.equal(h.nodes.get('settings-panel-interaction').hidden, false);
    h.nodes.get('settings-tab-interaction').listeners.keydown({key:'Home',preventDefault(){}});
    assert.equal(h.nodes.get('settings-panel-general').hidden, false);
    h.nodes.get('settings-tab-chat').listeners.click();
    h.nodes.get('phrases').value = '分类切换后的未保存台词'; h.nodes.get('phrases').listeners.input();
    h.nodes.get('settings-tab-general').listeners.click(); await h.language('en');
    h.nodes.get('settings-tab-chat').listeners.click();
    assert.equal(h.nodes.get('phrases').value, '分类切换后的未保存台词');
    h.broadcast({snapshot:{status:'live',buckets:[]}});
    assert.equal(h.nodes.get('settings-panel-chat').hidden, false);
    for (const id of ['language','scale','bubble-pages','chatPageEnabled','chat-config-model','phrases','sound']) assert.ok(h.nodes.has(id), id);
  });
  test(directory + ': collapsed help retains instructions, all shortcuts and usage notes', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', directory, 'settings.html'), 'utf8');
    const help = html.match(/<div class="help-content">([\s\S]*?)<\/div>/)?.[1] || '';
    assert.match(help, /拖动角色或气泡移动位置/);
    for (const shortcut of ['Ctrl + Alt + M','Ctrl + Alt + Q','Ctrl + Alt + Shift + M']) assert.ok(help.includes(shortcut), shortcut);
    assert.match(help, /Token 是用量/);
    assert.match(html, /<details class="help">/);
  });
  test(directory + ': every marked settings label has English copy and dynamic status wins over static defaults', async () => {
    const h = await settingsUi(directory, {language:'en'});
    for (const node of h.marked) for (const [attr, source] of Object.entries(node.attributes)) {
      if (attr.startsWith('data-i18n')) assert.doesNotMatch(h.i18n.t(source), /[\u3400-\u9fff]/, source);
    }
    assert.equal(h.document.documentElement.lang,'en');
    assert.equal(h.nodes.get('status-text').textContent,'Previewing demo data');
    assert.equal(h.nodes.get('current-character-name').textContent,'测试形象');
    h.broadcast({snapshot:{status:'live',buckets:[],account:{planType:'pro'}}});
    await h.language('zh-CN');
    assert.equal(h.nodes.get('status-text').textContent,'已连接本机 Codex');
    assert.match(h.nodes.get('data-detail').textContent,/当前套餐：pro/);
    await h.language('en');
    assert.equal(h.nodes.get('status-text').textContent,'Connected to local Codex');
    assert.match(h.nodes.get('data-detail').textContent,/Current plan: pro/);
  });
  test(directory + ': language changes apply immediately, persist, and preserve unsaved custom phrases', async () => {
    const h = await settingsUi(directory, {phrases:['原来保存的台词']});
    const draft='没有保存的中文\nAn unsaved English line';
    h.nodes.get('phrases').value=draft; h.nodes.get('phrases').listeners.input();
    const saved=deferred(); h.setSave(() => saved.promise);
    const pending=h.language('en');
    assert.equal(h.document.documentElement.lang,'en');
    assert.equal(h.nodes.get('language').disabled,true);
    assert.equal(h.nodes.get('phrases').value,draft);
    saved.resolve({...h.state,settings:{...h.state.settings,language:'en'},settingsRevision:1}); await pending;
    assert.equal(h.nodes.get('language').disabled,false);
    assert.equal(h.nodes.get('language').value,'en');
    assert.equal(h.nodes.get('phrases').value,draft);
    assert.deepEqual(h.calls,[{language:'en'}]);
    assert.equal(h.nodes.get('language-feedback').textContent,'Language saved.');
  });
  test(directory + ': failed and mismatched language replies roll back visibly without discarding edits', async () => {
    for (const mismatch of [false,true]) {
      const h=await settingsUi(directory,{language:'en',phrases:['Keep me']});
      h.nodes.get('phrases').value='我的草稿'; h.nodes.get('phrases').listeners.input();
      h.setSave(async () => {if(mismatch)return h.state;throw new Error('fixture save failure');});
      await h.language('zh-CN');
      assert.equal(h.document.documentElement.lang,'en');
      assert.equal(h.nodes.get('language').value,'en');
      assert.equal(h.nodes.get('language').disabled,false);
      assert.equal(h.nodes.get('language-feedback').textContent,'Could not save the language. Please try again.');
      assert.equal(h.nodes.get('phrases').value,'我的草稿');
    }
  });
  test(directory + ': in-flight refresh and import keep their busy labels across a language change', async () => {
    const h=await settingsUi(directory), refresh=deferred(), importing=deferred();
    h.setRefresh(() => refresh.promise); h.setImport(() => importing.promise);
    const refreshing=h.nodes.get('refresh').listeners.click(), importingTask=h.nodes.get('import-characters').listeners.click();
    await h.language('en');
    assert.equal(h.nodes.get('refresh').textContent,'Refreshing…');
    assert.equal(h.nodes.get('import-characters').textContent,'Importing…');
    assert.equal(h.nodes.get('refresh').disabled,true); assert.equal(h.nodes.get('import-characters').disabled,true);
    refresh.resolve(); importing.resolve({importedCount:2,existingCount:1,errors:[]});
    await Promise.all([refreshing,importingTask]);
    assert.equal(h.nodes.get('refresh').textContent,'Refresh ↻');
    assert.equal(h.nodes.get('import-characters').textContent,'＋ Import characters');
    assert.match(h.nodes.get('character-feedback').children[0].textContent,/Characters imported: 2/);
    await h.language('zh-CN');
    assert.equal(h.nodes.get('character-feedback').children[0].textContent,'已导入 2 个形象，1 张图片已在形象库中。');
  });
  test(directory + ': viewing and saving English default phrases keeps the original preset untouched', async () => {
    const h=await settingsUi(directory,{language:'en'}), original=[...h.state.settings.phrases];
    assert.equal(h.i18n.isDefaultPhrases(original),true);
    assert.doesNotMatch(h.nodes.get('phrases').value,/[\u3400-\u9fff]/);
    await h.nodes.get('save-phrases').listeners.click();
    assert.deepEqual(h.calls,[{phrases:original}]);
    await h.language('zh-CN');
    assert.equal(h.nodes.get('phrases').value,original.join('\n'));
    assert.equal(h.nodes.get('saved').textContent,'已保存');
  });
  test(directory + ': switching languages preserves an open character rename draft and literal custom names', async () => {
    const h=await settingsUi(directory);
    h.broadcast({characters:[{id:'mint-maid',name:'薄荷女仆',builtIn:true,nameCustomized:false,available:true,url:'fixture.png'}],activeCharacterId:'mint-maid'});
    const card=h.nodes.get('character-grid').children[0], rename=card.children[2].children[0], form=card.children[3], input=form.children[0].children[1];
    rename.listeners.click(); input.value='新的自定义名字';
    await h.language('en');
    assert.strictEqual(h.nodes.get('character-grid').children[0],card);
    assert.equal(form.hidden,false); assert.equal(input.value,'新的自定义名字');
    assert.equal(h.nodes.get('current-character-name').textContent,'Mint Maid');
    h.broadcast({characters:[{id:'mint-maid',name:'薄荷女仆',builtIn:true,nameCustomized:true,available:true,url:'fixture.png'}]});
    assert.equal(h.nodes.get('current-character-name').textContent,'薄荷女仆');
    assert.equal(input.value,'新的自定义名字');
  });
}
