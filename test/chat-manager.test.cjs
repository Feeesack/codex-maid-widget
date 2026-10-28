'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
for(const folder of ['src','macos/src']){
  const view=require('../'+folder+'/chat-manager.js');
  test(folder+': session capacity is distinct from billed tokens and preserves unknown observations',()=>{
    const missing=view.sessionProgress({initialized:true,ready:true});assert.equal(missing.contextPercent,null);assert.equal(missing.context,null);assert.equal(missing.body,null);
    const progress=view.sessionProgress({ready:true,budget:{used:460000,window:500000,bodyUpperBound:100000,bodyMeasurement:'tokens',successfulTurns:22,pending:true,reasons:['context'],limits:{body:400000,soft:.9,hard:.95}}});
    assert.equal(progress.contextPercent,92);assert.equal(progress.bodyPercent,25);assert.equal(progress.turns,22);assert.equal(progress.pending,true);assert.equal(progress.isBytes,false);
    const fallback=view.sessionProgress({budget:{bodyMeasurement:'bytes-fallback',byteCount:524288,bodyUpperBound:999999}});assert.equal(fallback.isBytes,true);assert.equal(fallback.bodyPercent,50);assert.equal(fallback.body,524288);
  });
  test(folder+': maintenance progress counts finished stages without pretending token-generation progress',()=>{
    assert.equal(view.maintenanceProgress().completed,0);
    const value=view.maintenanceProgress({state:'paused',stage:'tree',progress:.99,plan:[{stage:'archive',state:'completed'},{stage:'memory',state:'completed'},{stage:'tree',state:'paused'}]});
    assert.equal(value.completed,2);assert.equal(value.total,7);assert.equal(value.state,'paused');assert.equal(value.plan.at(-1).stage,'switch');
  });
  test(folder+': date filters convert local calendar days into inclusive ISO boundaries',()=>{
    const now=new Date(2026,9,28,15,40),range=view.rangeFilter('7','','',now);
    assert.equal(new Date(range.from).getDate(),22);assert.equal(new Date(range.from).getHours(),0);
    const end=new Date(range.to);assert.equal(end.getDate(),28);assert.equal(end.getHours(),23);assert.equal(end.getMilliseconds(),999);
    assert.deepEqual(view.rangeFilter('all'),{});
  });
  test(folder+': management layout keeps old controls, immutable-source tools and licensed icons',()=>{
    const source=fs.readFileSync(path.join(__dirname,'../'+folder+'/chat-page.html'),'utf8');
    for(const id of ['chat-conversation','manager-chat-input','chat-config-model','memory-panel','dream-now','maintenance-checkpoint','source-open','history-messages-more','usage-records','archive-edit','archive-hide'])assert.ok(source.includes('id="'+id+'"'),id);
    const ids=[...source.matchAll(/\sid="([^"]+)"/g)].map(match=>match[1]);assert.equal(ids.length,new Set(ids).size,'No duplicate IDs');
    assert.equal([...source.matchAll(/role="tabpanel"/g)].length,7);
    assert.ok(source.includes('class="manager-icon"'));assert.ok(source.includes('chat-manager.js'));
  });
  test(folder+': every marked management label has English copy',()=>{
    const dictionaries={...require('../'+folder+'/i18n-chat.js'),...require('../'+folder+'/i18n-chat-manager.js')};
    const html=fs.readFileSync(path.join(__dirname,'../'+folder+'/chat-page.html'),'utf8');
    for(const match of html.matchAll(/data-i18n(?:-(?:aria-label|placeholder|title|alt))?="([^"]+)"/g))assert.doesNotMatch(dictionaries[match[1]]||match[1],/[\u3400-\u9fff]/,match[1]);
  });
}
