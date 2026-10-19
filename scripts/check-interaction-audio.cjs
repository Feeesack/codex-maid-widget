'use strict';
// Static shipped audio only. Silent output, isolated data, no main/profile code.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {pathToFileURL}=require('node:url');
const fixture=fs.mkdtempSync(path.join(os.tmpdir(),'maid-audio-engine-'));
for(const name of ['codex','maid','appdata','localappdata','temp','userdata'])fs.mkdirSync(path.join(fixture,name));
process.env.CODEX_HOME=path.join(fixture,'codex');process.env.CODEX_MAID_HOME=path.join(fixture,'maid');process.env.HOME=process.env.USERPROFILE=fixture;
process.env.APPDATA=path.join(fixture,'appdata');process.env.LOCALAPPDATA=path.join(fixture,'localappdata');process.env.TEMP=process.env.TMP=path.join(fixture,'temp');
const {app,BrowserWindow}=require('electron');app.setPath('userData',path.join(fixture,'userdata'));
const root=path.resolve(__dirname,'..'),runtime=path.resolve(process.env.CODEX_MAID_RUNTIME_ROOT||root),output=path.resolve(process.env.CODEX_MAID_AUDIO_REPORT||path.join(root,'tmp/audio-engine-check.json'));
let win;const watchdog=setTimeout(()=>{console.error('Silent audio engine check timed out');app.exit(1);},15000);
app.whenReady().then(async()=>{try{
 const html=path.join(fixture,'audio.html');
 fs.writeFileSync(html,'<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src file:; connect-src \'none\'"><script src="'+pathToFileURL(path.join(runtime,'src/interaction-samples.js')).href+'"></script><script src="'+pathToFileURL(path.join(runtime,'src/local-interaction-samples.js')).href+'"></script><script src="'+pathToFileURL(path.join(runtime,'src/interaction-audio.js')).href+'"></script>');
 win=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,offscreen:true,backgroundThrottling:false}});await win.loadFile(html);
 const result=await win.webContents.executeJavaScript(`(async()=>{
 const context=new AudioContext(),sink=context.createGain(),starts=[],decoded=[],ended=[];let selected=MaidInteractionSamples.defaultId,decodeOrdinal=0,startupSuspension;
 sink.gain.value=0;sink.connect(context.destination);
 const wrapper={get currentTime(){return context.currentTime},get state(){return context.state},destination:sink,
  suspend:()=>startupSuspension=context.suspend(),resume:()=>context.resume(),createGain:()=>context.createGain(),
  decodeAudioData:bytes=>{const id=selected,role=decodeOrdinal++%2?'release':'press';return context.decodeAudioData(bytes).then(buffer=>{const data=buffer.getChannelData(0);decoded.push({id,role,duration:buffer.duration,channels:buffer.numberOfChannels,nonSilent:data.some(value=>Math.abs(value)>.0001),finite:data.every(Number.isFinite),first:data[0],last:data[data.length-1]});return buffer;});},
  createBufferSource(){const source=context.createBufferSource(),start=source.start.bind(source),id=selected;source.start=at=>{starts.push({id,at});start(at)};source.addEventListener('ended',()=>ended.push(id));return source;}};
 const bank=MaidInteractionAudio.withLocalSamples(MaidInteractionSamples,MaidLocalInteractionSamples);
 const player=MaidInteractionAudio.create({samples:bank,preset:()=>selected,enabled:()=>true,makeContext:()=>wrapper});
 const cases=[];for(const id of Object.keys(bank.presets)){
  selected=id;player.stop();await player.prepare();
  // Decode readiness does not imply audio-device readiness. Let the real idle
  // suspend/resume finish before issuing a fresh cached gesture, so a slow
  // device startup cannot correctly expire that gesture's 300 ms safety guard.
  const readyAt=performance.now();await startupSuspension;
  if(context.state==='suspended')await context.resume();
  if(context.state!=='running')throw new Error('Silent audio context did not become ready');
  const startupReadyMs=performance.now()-readyAt,contextStateAtPress=context.state;
  const first=starts.length,finished=ended.length;player.press();const synchronousPressStarts=starts.length-first;player.release();
  const duration=decoded.filter(sample=>sample.id===id).reduce((total,sample)=>total+sample.duration,0);
  const deadline=performance.now()+duration*1000+2000;
  while(ended.length-finished<2&&performance.now()<deadline)await new Promise(resolve=>setTimeout(resolve,20));
  cases.push({id,starts:starts.slice(first),ended:ended.length-finished,synchronousPressStarts,contextStateAtPress,startupReadyMs});
 }
 player.stop();await context.close();return {decoded,cases,privateIds:Object.keys(MaidLocalInteractionSamples.presets),outputGain:sink.gain.value};})()`,true);
 const manifest=JSON.parse(fs.readFileSync(path.join(runtime,'assets/audio/manifest.json'),'utf8'));
 assert.equal(result.cases.length,manifest.presets.length+result.privateIds.length);assert.equal(manifest.presets.length,4);assert.equal(result.outputGain,0);
 assert.deepEqual(result.privateIds,result.privateIds.length?['dsh-original']:[]);
 for(const entry of result.cases){assert.equal(entry.contextStateAtPress,'running');assert.equal(entry.synchronousPressStarts,1,entry.id+' cached press starts synchronously');assert.equal(entry.starts.length,2,entry.id+' starts');assert.equal(entry.ended,2,entry.id+' ended');assert.ok(entry.starts.every(source=>source.id===entry.id));
  const unordered=result.decoded.filter(sample=>sample.id===entry.id),samples=['press','release'].map(role=>unordered.find(sample=>sample.role===role)),expected=manifest.presets.find(preset=>preset.id===entry.id);assert.equal(unordered.length,2);assert.ok(samples.every(Boolean));
  for(let index=0;index<2;index++){const sample=samples[index];assert.equal(sample.nonSilent,true);assert.equal(sample.finite,true);
   if(expected){const clip=expected.clips[index?'release':'press'];assert.equal(sample.channels,1);assert.ok(Math.abs(sample.duration-clip.durationMs/1000)<.001);assert.ok(Math.abs(sample.first)<.0001&&Math.abs(sample.last)<.0001);}
   else {assert.equal(entry.id,'dsh-original');assert.equal(sample.channels,2,'DSH decoded channels');assert.ok(Math.abs(sample.duration-[.238020833,.108166667][index])<.03,'DSH decoded duration');}
  }
  assert.ok(Math.abs((entry.starts[1].at-entry.starts[0].at)-(samples[0].duration-.04))<.002);
 }
 const proof={ok:true,soundPresetCount:result.cases.length,publicSoundPresetCount:manifest.presets.length,privateDshIncluded:result.privateIds.includes('dsh-original'),legacyOriginalIncluded:result.cases.some(entry=>entry.id==='original'),realChromiumDecode:true,allPairsRenderedToEnd:true,startupSuspendResumeSettled:true,cachedPressStartsSynchronously:true,tailOverlapMs:40,physicalOutputGain:0,realSoundPlayed:false,realAuthenticationRead:false,realUserSettingsRead:false,cases:result.cases.map(entry=>({id:entry.id,started:entry.starts.length,ended:entry.ended,contextStateAtPress:entry.contextStateAtPress,startupReadyMs:entry.startupReadyMs,synchronousPressStarts:entry.synchronousPressStarts,decoded:result.decoded.filter(sample=>sample.id===entry.id).map(({role,duration,channels})=>({role,duration,channels}))}))};
 fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,JSON.stringify(proof,null,2)+'\n',{flag:'wx'});console.log('PASS: '+proof.soundPresetCount+' shipped audio pairs decode and finish with a 40ms overlap through a muted output.');
 clearTimeout(watchdog);win.destroy();app.quit();
}catch(error){console.error('Silent audio engine check failed: '+error.message);app.exit(1);}});
