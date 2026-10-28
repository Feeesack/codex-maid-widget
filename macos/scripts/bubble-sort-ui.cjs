'use strict';
// Shared real-input assertions for the full smoke and the short isolated check.
// The fixture owns its saved data/IPC; this helper only operates the renderer.
const assert = require('node:assert/strict');

async function checkBubbleSortUi({win,evaluate,pause,publish,getSettings,getRevision,getWrites,getDiskWrites,failNextSave,capture}) {
  const config = () => {
    const value=getSettings();
    return {bubblePageOrder:[...value.bubblePageOrder],bubbleHiddenPages:[...value.bubbleHiddenPages],defaultBubblePage:value.defaultBubblePage};
  };
  const domOrder = () => evaluate(`[...document.getElementById('bubble-pages').children].filter(row=>row.matches('.bubble-page-card')&&!row.classList.contains('page-sort-fallback')).map(row=>row.dataset.pageId)`);
  const wait = async (callback,label) => {const end=Date.now()+5000;while(Date.now()<end){if(await callback())return;await pause(25);}throw new Error(label);};
  const center = id => evaluate(`(()=>{const node=document.getElementById(${JSON.stringify(id)}),r=node.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
  const mouse = (type,point,held=false) => win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type,...point,button:type==='mouseMoved'?'none':'left',buttons:held?1:0,...(type==='mouseMoved'?{}:{clickCount:1})});
  const click = async id => {
    await evaluate(`document.getElementById(${JSON.stringify(id)}).scrollIntoView({block:'nearest'})`);await pause(35);
    const point=await center(id);await mouse('mouseMoved',point);await mouse('mousePressed',point,true);await mouse('mouseReleased',point);await pause(65);
    assert.equal(await evaluate('!!Sortable.active'),false,'an ordinary control click must not start sorting');
  };
  const library=await evaluate(`(()=>{const list=document.getElementById('bubble-pages'),instance=window.Sortable?.get(list);return {loaded:typeof window.Sortable==='function',version:window.Sortable?.version,attached:instance?.el===list,animation:instance?.option('animation'),handle:instance?.option('handle')};})()`);
  assert.equal(library.loaded,true,'the shipped official SortableJS runtime is loaded');
  assert.equal(library.attached,true,'SortableJS owns the production page list');
  assert.equal(library.version,'1.15.7');assert.ok(library.animation>0,'row-gap movement has an animation duration');assert.equal(library.handle,'.page-drag-handle');
  const controls=await evaluate(`({cards:document.querySelectorAll('#bubble-pages>.bubble-page-card').length,icons:[...document.querySelectorAll('#bubble-pages>.bubble-page-card')].map(row=>row.querySelectorAll('.ui-icon').length),resetIcons:document.querySelectorAll('#reset-page-order .ui-icon').length,rightOrderButtons:document.querySelectorAll('.page-order-buttons,[id^="page-up-"],[id^="page-down-"]').length})`);
  assert.equal(controls.cards,8);assert.deepEqual(controls.icons,Array(8).fill(3));assert.equal(controls.resetIcons,1);assert.equal(controls.rightOrderButtons,0,'cards have no right-side up/down sorting buttons');
  const original=config();
  await publish({bubbleHiddenPages:['conversation','lastTurn']});
  const drag = async (source,target,{reject=false,statusDuringDrag=false}={}) => {
    await evaluate(`document.getElementById('bubble-pages').scrollIntoView({block:'center'})`);await pause(80);
    const saved=config(),writes=getWrites(),diskWrites=getDiskWrites?.(),revision=getRevision(),before=await evaluate(`Object.fromEntries([...document.querySelectorAll('#bubble-pages>.bubble-page-card')].map(row=>[row.dataset.pageId,row.getBoundingClientRect().y]))`);
    const from=await center('page-handle-'+source),targetBox=await evaluate(`document.getElementById(${JSON.stringify('page-'+target)}).getBoundingClientRect().toJSON()`);
    const to={x:from.x,y:targetBox.y+5};
    assert.ok(from.y>to.y+120,'the real pointer route crosses several page rows');
    assert.ok(from.y<await evaluate('innerHeight')&&to.y>0,'both ends of the pointer route are inside the viewport');
    if(reject)failNextSave();
    await mouse('mouseMoved',from);await mouse('mousePressed',from,true);await pause(40);
    let animationObserved=false,displacementObserved=false,statusObserved=false,activeObserved=false;
    const steps=36;
    for(let index=1;index<=steps;index++) {
      const fraction=index/steps,point={x:from.x+8*Math.sin(Math.PI*fraction),y:from.y+(to.y-from.y)*fraction};
      await mouse('mouseMoved',point,true);win.webContents.invalidate();await pause(20);
      const sample=await evaluate(`(()=>{const rows=[...document.querySelectorAll('#bubble-pages>.bubble-page-card')].filter(row=>row.dataset.pageId!==${JSON.stringify(source)}&&!row.classList.contains('page-sort-fallback'));return {active:!!Sortable.active,rows:rows.map(row=>({id:row.dataset.pageId,y:row.getBoundingClientRect().y,transform:getComputedStyle(row).transform,transition:getComputedStyle(row).transitionDuration}))};})()`);
      activeObserved ||= sample.active;
      displacementObserved ||= sample.rows.some(row=>Math.abs(row.y-before[row.id])>10);
      // Inspect the browser's actual presented transform, rather than testing a
      // vendor class or accepting the mere presence of an animation option.
      animationObserved ||= await evaluate(`(()=>{for(const row of document.querySelectorAll('#bubble-pages>.bubble-page-card')){if(row.dataset.pageId===${JSON.stringify(source)}||row.classList.contains('page-sort-fallback'))continue;const style=getComputedStyle(row),matrix=new DOMMatrix(style.transform);if((Math.abs(matrix.m41)>.5||Math.abs(matrix.m42)>.5)&&style.transitionProperty.includes('transform')&&parseFloat(style.transitionDuration)>0)return true;}return false;})()`);
      assert.equal(getWrites(),writes,'moving the pointer never calls settings save');assert.equal(getRevision(),revision,'moving the pointer never advances saved revision');assert.deepEqual(config(),saved,'moving the pointer keeps the saved order/default/visibility');
      if(getDiskWrites)assert.equal(getDiskWrites(),diskWrites,'moving the pointer never writes the isolated settings file');
      if(statusDuringDrag&&index===24){const draft=await domOrder();assert.notDeepEqual(draft,saved.bubblePageOrder,'several rows already move before drop');await publish();assert.deepEqual(await domOrder(),draft,'a status broadcast preserves the in-progress DOM ordering');statusObserved=true;}
    }
    assert.equal(activeObserved,true,'real mouse input started the official SortableJS drag');
    assert.equal(animationObserved,true,'a displaced neighbouring row presents an intermediate transform');
    assert.equal(displacementObserved,true,'neighbouring rows leave a real moving gap before drop');
    const draft=await domOrder();assert.notDeepEqual(draft,saved.bubblePageOrder,'DOM ordering changes before drop while saved ordering stays untouched');
    assert.equal(getWrites(),writes);assert.equal(getRevision(),revision);
    if(capture)await capture(reject?'bubble-pages-drag-before-rejected-drop.png':'bubble-pages-drag-moving.png');
    await mouse('mouseReleased',to);
    await wait(async()=>getWrites()===writes+1&&!(await evaluate('bubblePageSaving')),'one drop did not finish its single settings request');await pause(library.animation+40);
    assert.equal(getWrites(),writes+1,'drop makes exactly one settings request');
    if(getDiskWrites)assert.equal(getDiskWrites(),diskWrites+(reject?0:1),'drop writes the isolated file once, or zero times when saving fails');
    if(reject){assert.equal(getRevision(),revision,'failed save does not advance saved revision');assert.deepEqual(config(),saved);assert.deepEqual(await domOrder(),saved.bubblePageOrder,'failed save restores the last saved row ordering');assert.match(await evaluate(`document.getElementById('bubble-pages-feedback').textContent`),/未能保存/);}
    else {assert.equal(getRevision(),revision+1);assert.deepEqual(getSettings().bubblePageOrder,draft);assert.equal(getSettings().bubblePageOrder[0],source);assert.equal(getSettings().defaultBubblePage,saved.defaultBubblePage);assert.deepEqual([...getSettings().bubbleHiddenPages].sort(),[...saved.bubbleHiddenPages].sort());assert.deepEqual(await domOrder(),draft);}
    assert.equal(await evaluate('!!Sortable.active'),false);
    return {crossedRows:saved.bubblePageOrder.indexOf(source)-saved.bubblePageOrder.indexOf(target),animationObserved,displacementObserved,statusObserved,settingsWritesDuringDrag:0,dropSaveRequests:1};
  };
  const success=await drag('phrase',original.bubblePageOrder[0],{statusDuringDrag:true});
  const committed=config();await publish();assert.deepEqual(await domOrder(),committed.bubblePageOrder,'status rendering after drag keeps the committed order');
  const rejected=await drag(committed.bubblePageOrder.at(-1),committed.bubblePageOrder[0],{reject:true});
  let writes=getWrites();await click('page-handle-phrase');assert.equal(getWrites(),writes,'a handle click without movement does not save');
  await click('page-default-quota');await wait(()=>getWrites()===writes+1,'default radio click did not save');assert.equal(getSettings().defaultBubblePage,'quota');assert.deepEqual(getSettings().bubblePageOrder,committed.bubblePageOrder);
  writes=getWrites();await click('page-visible-conversation');await wait(()=>getWrites()===writes+1,'visibility click did not save');assert.equal(getSettings().bubbleHiddenPages.includes('conversation'),false);assert.deepEqual(getSettings().bubblePageOrder,committed.bubblePageOrder);
  writes=getWrites();await evaluate("document.getElementById('page-handle-week').focus()");assert.equal(await evaluate('document.activeElement?.id'),'page-handle-week');
  for(const type of ['keyDown','keyUp'])await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type,key:'ArrowUp',code:'ArrowUp',windowsVirtualKeyCode:38,nativeVirtualKeyCode:38,modifiers:1});
  await wait(async()=>getWrites()===writes+1&&!(await evaluate('bubblePageSaving')),'handle Alt+ArrowUp did not save');assert.equal(getSettings().bubblePageOrder.indexOf('week'),committed.bubblePageOrder.indexOf('week')-1);assert.equal(await evaluate('!!Sortable.active'),false,'keyboard reordering does not start a pointer drag');
  await publish({...committed,bubbleHiddenPages:original.bubbleHiddenPages,defaultBubblePage:original.defaultBubblePage});
  assert.deepEqual(await domOrder(),committed.bubblePageOrder);
  return {officialSortableLoaded:true,version:library.version,realPointerDrag:true,animatedReorder:success.animationObserved&&success.displacementObserved,noSettingsWritesDuringDrag:true,singleWriteOnDrop:true,dragPreservesVisibilityAndDefault:true,statusRenderDuringDragPreserved:success.statusObserved,saveFailureRestoresOrder:true,success,rejected,statusRenderPreservesOrder:true,handleClickDoesNotDrag:true,defaultVisibilityClicksDoNotDrag:true,handleAltArrowReorders:true,rightSideOrderButtonsRemoved:true,cardIconCount:controls.icons.reduce((sum,count)=>sum+count,0),resetIconCount:controls.resetIcons};
}
module.exports={checkBubbleSortUi};
