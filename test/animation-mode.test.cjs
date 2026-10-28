'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Production renderer functions only, with memory-only DOM/media/audio doubles.
// No main process, data directory resolver, profile or authentication is loaded.
function harness(folder, animationMode, systemReduced, sound = true) {
  const source = fs.readFileSync(path.join(__dirname,'..',folder,'src/widget.js'),'utf8');
  const nodes = new Map();
  for (const id of ['widget','character','bubble-motion','remaining']) {
    const classes = new Set();
    nodes.set(id,{textContent:'',style:{},offsetWidth:228,getAnimations:() => [],classList:{
      add:(...names) => names.forEach(name => classes.add(name)),remove:(...names) => names.forEach(name => classes.delete(name)),contains:name => classes.has(name),
    }});
  }
  let now = 0, nextFrame = 1;
  const media = {matches:systemReduced,listeners:[],addEventListener(_event,callback) {this.listeners.push(callback);}};
  const audio = [], frames = new Map();
  const context = {
    $:id => nodes.get(id),current:{settings:{animationMode,sound},snapshot:{buckets:[{id:'fixture',primary:{remainingPercent:82}}]}},
    matchMedia:() => media,performance:{now:() => now},reveal() {},
    queueMicrotask:callback=>callback(),drainAccountResetNotices() {},
    requestAnimationFrame(callback) {const id = nextFrame++;frames.set(id,callback);return id;},
    cancelAnimationFrame(id) {frames.delete(id);},
    interactionSound:{press() {if(context.current.settings.sound) audio.push('press');},release() {if(context.current.settings.sound) audio.push('release');},stop() {audio.push('stop');}},
  };
  const section = (from,to) => {
    const start = source.indexOf(from), end = source.indexOf(to,start);
    assert.ok(start >= 0 && end > start,'production function boundaries must remain available');
    return source.slice(start,end);
  };
  vm.runInNewContext(`let displayed = null, animationId, interactionHeld = false, interactionPressedAt = 0, interactionWasMoving = false;
    ${section('function selectedBucket()', 'function countdown()')}
    ${section('function clearBounceMotion(', 'const themeCache =')}
    ${section('function pressInteraction(', 'function accountAlarmBounce(')}
    globalThis.subject = {pressInteraction,releaseInteraction,bounce,roll,clearBounceMotion,
      get held() {return interactionHeld;}};`,context);
  return {context,nodes,audio,frames,...context.subject,subject:context.subject,
    motion(reduced) {media.matches = reduced;for(const listener of media.listeners) listener({matches:reduced});},
    time(value) {now = value;},frame(value) {now = value;const batch = [...frames];frames.clear();for(const [,callback] of batch) callback(value);},
    pressed() {return ['character','bubble-motion'].map(id => nodes.get(id).classList.contains('interaction-pressed'));},
  };
}

for (const folder of ['', 'macos/']) {
  const platform = folder || 'Windows';
  test(`${platform}: obsolete animation settings and system reduce never suppress press/release animation or change mute`, () => {
    for (const mode of [undefined,'system','full','reduced']) for (const systemReduced of [false,true]) for (const sound of [false,true]) {
      const h = harness(folder,mode,systemReduced,sound);
      h.pressInteraction();assert.deepEqual(h.pressed(),[true,true]);
      h.time(40);h.releaseInteraction();assert.deepEqual(h.pressed(),[false,false]);
      assert.deepEqual(h.audio,sound ? ['press','release'] : []);
      assert.equal(h.context.current.settings.sound,sound);
    }
  });
  test(`${platform}: live system changes retain held gestures and numeric animation`, () => {
    const h = harness(folder,'reduced',false);
    h.roll(82);h.frame(650);
    h.pressInteraction();assert.deepEqual(h.pressed(),[true,true]);
    h.motion(true);assert.deepEqual(h.pressed(),[true,true]);assert.equal(h.subject.held,true);
    assert.deepEqual(h.audio,['press']);
    h.roll(45);assert.equal(h.frames.size,1,'quota rolling still schedules animation');
    h.frame(975);assert.ok(Number(h.nodes.get('remaining').textContent)>45&&Number(h.nodes.get('remaining').textContent)<82,'quota uses an intermediate animated value');
    h.motion(false);assert.deepEqual(h.pressed(),[true,true]);
    h.frame(1300);assert.equal(h.nodes.get('remaining').textContent,'45');assert.equal(h.frames.size,0);
    h.releaseInteraction();assert.deepEqual(h.pressed(),[false,false]);assert.deepEqual(h.audio,['press','release']);
  });
  test(`${platform}: animation has no system or saved-policy gate while moving and hidden protections remain`, () => {
    const source = fs.readFileSync(path.join(__dirname,'..',folder,'src/widget.js'),'utf8');
    const css = fs.readFileSync(path.join(__dirname,'..',folder,'src/widget.css'),'utf8');
    assert.doesNotMatch(source,/animationMode|prefers-reduced-motion|motionPreference|isMotionReduced|applyMotionPolicy/);
    assert.doesNotMatch(css,/prefers-reduced-motion|data-reduced-motion|data-animation-mode/);
    assert.match(css,/animation:breathe 5s/);assert.match(css,/animation:quotaShimmer 4\.2s/);
    assert.match(css,/\.hidden-bubble \.quota-shimmer \.quota-value\{animation-play-state:paused\}/);
    assert.match(css,/\.widget\.is-moving \.character img\{animation:none\}/);
    const h = harness(folder,'reduced',true);
    h.context.current.visualPose = {moving:true};h.pressInteraction();assert.deepEqual(h.pressed(),[false,false],'native moving pose still avoids a new bounce');
    h.releaseInteraction();delete h.context.current.visualPose;
    h.pressInteraction();h.clearBounceMotion(true);assert.deepEqual(h.pressed(),[true,true],'drag pose updates preserve compression');
    h.time(40);h.releaseInteraction();assert.deepEqual(h.pressed(),[false,false]);
  });
}
