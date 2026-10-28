'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { SessionBudget, assembleStartup, tokens, LIMITS } = require('../src/chat-policy.cjs');
// Synthetic token meter deliberately counts code points; never used at runtime.
const syntheticMeter = text => Array.from(text).length;
test('400K remains sticky across compaction and reconnection; other threads ignored', () => {
  const b = new SessionBudget({ threadId: 'own', countTokens: syntheticMeter });
  assert.equal(b.addMessage({threadId:'other',id:'x',text:'x'}),false);
  b.addMessage({threadId:'own',id:'m',text:'x'.repeat(400000)});
  b.compact({threadId:'own',id:'c',status:'completed'});
  const next = new SessionBudget({threadId:'own',countTokens:syntheticMeter,state:b.snapshot()});
  assert.equal(next.check().pending,true); assert.equal(next.body,400000);
  assert.equal(next.addMessage({threadId:'own',id:'m',text:'different'}),false);
});
test('fallback bytes and successful turns are distinct from tokens', () => {
  const b = new SessionBudget({threadId:'own'});
  b.addMessage({threadId:'own',id:'m',text:'你'.repeat(349526)});
  assert.equal(b.check().pending,true); assert.equal(b.snapshot().bodyUnit,'unknown');
  assert.equal(b.complete({threadId:'own',turnId:'t',status:'failed'}),false);
  assert.equal(b.turns,0);
});
test('recovering an unknown body with a new tokenizer retains its fallback history',()=>{
 const unmetered=new SessionBudget({threadId:'own'});
 unmetered.addMessage({threadId:'own',id:'m1',text:'你'.repeat(349526)});
 const restored=new SessionBudget({threadId:'own',countTokens:syntheticMeter,state:unmetered.snapshot()});
 assert.equal(restored.snapshot().bodyUnit,'unknown');assert.equal(restored.check().pending,true);
 restored.addMessage({threadId:'own',id:'m2',text:'newly metered'});
 assert.equal(restored.snapshot().bodyUnit,'unknown');
 assert.equal(restored.bytes,unmetered.bytes+Buffer.byteLength('newly metered'));
});
test('latest contextual count, model, freshness and compaction invalidate send', () => {
  const b = new SessionBudget({threadId:'own', countTokens:syntheticMeter});
  b.observe({threadId:'own',used:100,window:20000,at:1000,model:'m',scope:'current-context'});
  const request={inputTokens:100,outputReserve:1000,maintenanceReserve:2000,now:1001,model:'m'};
  assert.equal(b.beforeSend(request).allowed,true);
  assert.equal(b.beforeSend({...request,now:32000}).allowed,false);
  assert.equal(b.beforeSend({...request,model:'new'}).allowed,false);
  b.compact({threadId:'own',id:'c',status:'completed'});
  assert.equal(b.beforeSend(request).allowed,false);
  assert.equal(b.check().pending,false);
  assert.equal(b.observe({threadId:'own',used:3,window:10,at:1000,model:'m',scope:'cumulative'}),false);
});
test('90/95 percent and smaller windows protect the actual input capacity', () => {
  for (const [used,pending] of [[427499,false],[427500,true],[451250,true]]) {
    const b=new SessionBudget({threadId:'own'});
    b.observe({threadId:'own',used,window:475000,at:1000,model:'m',scope:'current-context'});
    assert.equal(b.check().pending,pending);
  }
  const b=new SessionBudget({threadId:'own'});
  b.observe({threadId:'own',used:100,window:1000,at:1000,model:'m',scope:'current-context'});
  assert.equal(b.beforeSend({inputTokens:901,outputReserve:0,maintenanceReserve:0,now:1000,model:'m'}).allowed,false);
});
test('startup counts packaging and rejects oversized mandatory content rather than truncating', () => {
  const s={root:'root',persona:'称呼',opinions:'边界',facts:'约定',window:30000,otherTokens:1000,countTokens:syntheticMeter};
  assert.ok(assembleStartup(s).tokens>0);
  assert.throws(()=>assembleStartup({...s,persona:'x'.repeat(LIMITS.persona+1)}),/BUDGET/);
  assert.throws(()=>assembleStartup({...s,window:5000}),/BUDGET|REPAIR/);
  assert.throws(()=>tokens('hello'),/UNVERIFIED/);
  assert.throws(()=>tokens('hello',()=>NaN),/INVALID/);
});
test('expanded startup blocks fit above the old 19K package while the real window remains protected', () => {
  const s={root:'r'.repeat(LIMITS.root),persona:'p'.repeat(LIMITS.persona),opinions:'v'.repeat(LIMITS.views),facts:'f'.repeat(LIMITS.views),
    handoff:{summary:'s'.repeat(LIMITS.handoffSummary-100),originals:'o'.repeat(LIMITS.handoffOriginal-100)},window:100000,otherTokens:1000,countTokens:syntheticMeter};
  const ready=assembleStartup(s);
  assert.ok(ready.tokens>70000);assert.ok(ready.tokens<76000);
  assert.throws(()=>assembleStartup({...s,root:'r'.repeat(LIMITS.root+1)}),/BUDGET/);
  assert.throws(()=>assembleStartup({...s,facts:'f'.repeat(LIMITS.views+1)}),/BUDGET/);
  assert.throws(()=>assembleStartup({...s,window:80000}),/BUDGET|REPAIR/);
  assert.equal(LIMITS.node,20000);assert.equal(LIMITS.root,40000);assert.equal(LIMITS.leafPrime,5000);
  assert.equal(LIMITS.persona,10000);assert.equal(LIMITS.views,10000);
  assert.equal(LIMITS.handoff,5000);assert.equal(LIMITS.handoffSummary,3000);assert.equal(LIMITS.handoffOriginal,2000);
});

test('the root has its own 40K startup allowance without relaxing window or ordinary node limits', () => {
  const input={window:100000,otherTokens:0,countTokens:syntheticMeter};
  for (const length of [LIMITS.node+1,LIMITS.root]) {
    const root='r'.repeat(length),prepared=assembleStartup({...input,root});
    assert.equal(JSON.parse(prepared.content).root,root);
    assert.ok(prepared.tokens>=length);
  }
  assert.throws(()=>assembleStartup({...input,root:'r'.repeat(LIMITS.root+1)}),/BUDGET/);
  assert.throws(()=>assembleStartup({...input,root:'r'.repeat(LIMITS.root),window:50000}),/BUDGET|REPAIR/);
  assert.equal(LIMITS.node,20000);assert.equal(LIMITS.root,40000);assert.equal(LIMITS.leafPrime,5000);
});
