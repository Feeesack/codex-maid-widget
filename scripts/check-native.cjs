'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const root = path.join(__dirname,'..');
const home = fs.mkdtempSync(path.join(os.tmpdir(),'codex-maid-native-'));
const controlPath = path.join(home,'control.json');
// Simulate the user's former 60% preference rather than only testing a fresh profile.
fs.writeFileSync(path.join(home,'settings.json'),JSON.stringify({scale:0.6,mirror:true,opacity:0.8,sound:false,phrases:['保留我的台词']}));
const importFile=path.join(home,'测试导入.png'), invalidFile=path.join(home,'损坏图片.png'), gifFile=path.join(home,'动图.gif'), webpFile=path.join(home,'网页图.webp');
fs.copyFileSync(path.join(root,'docs','screenshots','widget-demo.png'),importFile);
fs.writeFileSync(invalidFile,'not an image');
const sleep = ms => new Promise(r=>setTimeout(r,ms));
async function until(callback,ms=10000){const end=Date.now()+ms;while(Date.now()<end){if(await callback())return;await sleep(100);}throw new Error('Native app did not reach expected state');}
(async()=>{
  const exe = require('electron');
  let errors='';
  const args = [path.join(__dirname,'native-check.cjs'),'--demo'];
  const opts={cwd:root,env:{...process.env,CODEX_MAID_HOME:home,CODEX_MAID_TEST_IMPORT:JSON.stringify([importFile,invalidFile,gifFile,webpFile])},windowsHide:true,stdio:['ignore','ignore','pipe']};
  const child=spawn(exe,args,opts); child.stderr.on('data',x=>errors+=x);
  let second;
  try{
    await until(()=>fs.existsSync(controlPath));
    const bounds=JSON.parse(fs.readFileSync(path.join(home,'native-window.json'),'utf8'));
    assert.equal(bounds.width,228);assert.equal(bounds.height,288);
    const migrated=JSON.parse(fs.readFileSync(path.join(home,'settings.json'),'utf8'));
    assert.equal(migrated.scale,1);assert.equal(migrated.sizeBaseline,2);
    // With no saved position startup places her on the right; orientation is
    // derived from that position rather than retaining the old edge-only bit.
    assert.equal(migrated.mirror,false);assert.equal(migrated.opacity,0.8);
    assert.equal(migrated.sound,false);
    assert.deepEqual(migrated.phrases,['保留我的台词']);
    const target=JSON.parse(fs.readFileSync(controlPath,'utf8'));
    const url=`http://127.0.0.1:${target.port}`;
    const headers={Authorization:'Bearer '+target.token,'Content-Type':'application/json'};
    assert.equal((await fetch(url+'/status')).status,403);
    assert.equal((await fetch(url+'/status',{headers:{...headers,Origin:'https://example.com'}})).status,403);
    await until(async()=>{const data=await(await fetch(url+'/status',{headers})).json();return data.status==='demo';});
    const status=await(await fetch(url+'/status',{headers})).json();
    assert.equal(status.buckets[0].primary.remainingPercent,82);
    assert.equal(Object.hasOwn(status,'token'),false);
    for(const action of ['bounce','hide','show','refresh'])assert.equal((await fetch(url+'/action',{method:'POST',headers,body:JSON.stringify({action})})).status,200);
    assert.equal((await fetch(url+'/action',{method:'POST',headers,body:'{"action":"unknown"}'})).status,400);
    await until(()=>fs.existsSync(path.join(home,'gallery-check.json')));
    const gallery=JSON.parse(fs.readFileSync(path.join(home,'gallery-check.json'),'utf8'));
    assert.equal(gallery.ok,true,gallery.error);
    const galleryStatus=await(await fetch(url+'/status',{headers})).json();
    assert.equal(galleryStatus.activeCharacterId,'lilac-dragon');assert.equal(galleryStatus.characterCount,4);
    // A rejected second instance must not remove the first instance's endpoint.
    second=spawn(exe,args,opts);second.stderr.on('data',x=>errors+=x);
    await new Promise((resolve,reject)=>{second.once('exit',resolve);second.once('error',reject);setTimeout(()=>reject(new Error('Second instance did not exit')),5000).unref();});
    assert.equal(fs.existsSync(controlPath),true);
    assert.equal((await fetch(url+'/status',{headers})).status,200);
    console.log('PASS: production main, sandboxed gallery import/select/rename/remove IPC, persistent selection, smaller window, saved size migration, native tray, authenticated loopback, controls, single-instance endpoint persistence.');
  }finally{second?.kill();child.kill();}
})().catch(error=>{console.error(error);process.exitCode=1;});
