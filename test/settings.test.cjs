'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { DEFAULTS, sanitize, snapBounds, constrainPosition, widgetDimensions, readSettings, writeSettings } = require('../src/settings.cjs');
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
test('lilac dragon is the new default while saved character choices survive',()=>{
  assert.equal(sanitize().activeCharacterId,'lilac-dragon');
  for(const activeCharacterId of ['mint-maid','lilac-dragon','custom-saved-character']) {
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
test('weekly content and Codex-follow preferences survive saving and reopening settings',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'maid-week-settings-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const file=path.join(dir,'settings.json');
  writeSettings(file,sanitize({mode:'week',followCodex:false}));
  const restored=readSettings(file);
  assert.equal(restored.mode,'week');assert.equal(restored.followCodex,false);
});
test('left edge snap mirrors on a negative-coordinate monitor',()=>{
  const p=snapBounds({x:-1910,y:102,width:380,height:480},{x:-1920,y:0,width:1920,height:1080});
  assert.deepEqual(p,{x:-1920,y:102,mirror:true});
});
test('right/bottom snap and disconnected display recovery remain in work area',()=>{
  const area={x:0,y:0,width:1920,height:1040};
  assert.deepEqual(snapBounds({x:1530,y:550,width:380,height:480},area),{x:1540,y:560,mirror:false});
  assert.deepEqual(constrainPosition({x:8000,y:-200,width:380,height:480},area),{x:1540,y:0});
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
