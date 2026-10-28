'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
// Layout/input behavior is exercised by check-toolbar-ui.cjs in real Chromium.
// These boundary checks protect mirrored delivery and the stable four actions.
test('toolbar delivery stays mirrored apart from platform viewport clipping',()=>{
  const comparable=(name,source)=>name!=='widget.css'?source:source
    .replace(/\/\*[\s\S]*?\*\//g,'')
    // macOS prevents focus-induced root scrolling; all other CSS stays paired.
    .replace(/(html,body\{[^}]*\boverflow:)(?:hidden|clip)(;)/,'$1viewport$2')
    .replace(/^\s*\n/gm,'');
  for(const name of ['widget.js','widget.css','index.html','preload.cjs'])assert.equal(
    comparable(name,fs.readFileSync(path.join(__dirname,'../src',name),'utf8')),
    comparable(name,fs.readFileSync(path.join(__dirname,'../macos/src',name),'utf8')),name);
});
for(const folder of ['', 'macos/'])test(`${folder||'Windows'} toolbar retains four native keyboard-reachable actions`,()=>{
  const html=fs.readFileSync(path.join(__dirname,'..',folder,'src/index.html'),'utf8');
  const toolbar=html.match(/<nav\b[^>]*class="toolbar interactive"[^>]*>([\s\S]*?)<\/nav>/)?.[1];
  assert.ok(toolbar);
  assert.deepEqual([...toolbar.matchAll(/<button\b[^>]*id="([^"]+)"/g)].map(match=>match[1]),['refresh','talk','settings','hide']);
  assert.doesNotMatch(toolbar,/\binert\b|tabindex="-1"|\bdisabled\b/);
});
for(const folder of ['', 'macos/'])test(`${folder||'Windows'} production toolbar dismissal arms once and reentry cancels it`,()=>{
  const source=fs.readFileSync(path.join(__dirname,'..',folder,'src/widget.js'),'utf8');
  const start=source.indexOf('let toolbarHideTimer;'),end=source.indexOf("\ndocument.addEventListener('pointermove'",start);
  assert.ok(start>=0&&end>start,'production pointer handler is available');
  let now=0,nextId=1;const scheduled=new Map(),classes=new Set();
  const element={classList:{add:name=>classes.add(name),remove:name=>classes.delete(name),contains:name=>classes.has(name)}};
  const documentEvents={},windowEvents={},document={activeElement:null,hidden:false,addEventListener:(name,fn)=>{documentEvents[name]=fn;}};
  const context={document,window:{addEventListener:(name,fn)=>{windowEvents[name]=fn;}},$:id=>{assert.equal(id,'widget');return element;},setTimeout(callback,delay){const id=nextId++;scheduled.set(id,{callback,at:now+delay});return id;},clearTimeout:id=>scheduled.delete(id)};
  const advance=milliseconds=>{now+=milliseconds;for(const [id,timer]of [...scheduled])if(timer.at<=now){scheduled.delete(id);timer.callback();}};
  vm.runInNewContext(source.slice(start,end)+'\nglobalThis.pointer=updateToolbarPointer;',context);
  context.pointer(true);assert.equal(classes.has('toolbar-open'),true);assert.equal(scheduled.size,0);
  context.pointer(false);assert.equal(scheduled.size,1);const first=[...scheduled.values()][0];
  assert.equal(first.at,600);advance(300);context.pointer(false);assert.equal(scheduled.size,1);assert.equal([...scheduled.values()][0],first);
  advance(299);assert.equal(classes.has('toolbar-open'),true);context.pointer(false);advance(1);
  assert.equal(classes.has('toolbar-open'),false);assert.equal(scheduled.size,0);
  context.pointer(false);assert.equal(scheduled.size,0,'already hidden state never starts a timer');
  context.pointer(true);context.pointer(false);advance(450);context.pointer(true);
  assert.equal(scheduled.size,0);advance(1000);assert.equal(classes.has('toolbar-open'),true,'reentry cancels the previous dismissal');
  const focusToolbar=()=>{document.activeElement={closest:selector=>selector==='.toolbar',blur:()=>{document.activeElement=null;}};};
  focusToolbar();context.pointer(false);advance(600);
  assert.equal(document.activeElement,null,'departure clears the separate CSS focus visibility path');
  assert.equal(classes.has('toolbar-open'),false);
  focusToolbar();context.pointer(false);assert.equal(scheduled.size,1,'focus-only visibility also arms dismissal');advance(600);
  focusToolbar();context.pointer(true);context.pointer(false);
  documentEvents.keydown({target:document.activeElement});advance(1000);
  assert.ok(document.activeElement,'keyboard use cancels mouse departure dismissal');
  assert.equal(classes.has('toolbar-open'),false,'keyboard takeover clears stale hover so Tab away can dismiss');
  for(const hide of [()=>windowEvents.blur(),()=>{document.hidden=true;documentEvents.visibilitychange();}]){
    focusToolbar();context.pointer(true);context.pointer(false);hide();
    assert.equal(document.activeElement,null,'hidden/blurred window clears toolbar focus');
    assert.equal(classes.has('toolbar-open'),false);assert.equal(scheduled.size,0);
  }
  const outsideFocus={closest:()=>null,blur:()=>assert.fail('unrelated input focus must be preserved')};
  document.activeElement=outsideFocus;context.pointer(true);context.pointer(false);advance(600);
  assert.equal(document.activeElement,outsideFocus);
});
