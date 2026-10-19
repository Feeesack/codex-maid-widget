'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { create } = require('../src/interaction-audio.js');

const ROOT = path.resolve(__dirname, '..');
const DURATION = 6713 / 44100;
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);
const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };

// An in-memory audio graph and two one-byte sample IDs. Nothing touches an
// actual audio device, filesystem data directories, browser state or network.
function harness({ pendingDecode = false, pendingResume = false, pendingSuspend = false,
  samples = { press: 'AA==', release: 'AQ==' } } = {}) {
  let enabled = true;
  let selected = 'soft-spring';
  let milliseconds = 1000;
  let resolveResume;
  let rejectResume;
  let resolveSuspend;
  const resumePromise = pendingResume ? new Promise((resolve, reject) => { resolveResume = resolve; rejectResume = reject; }) : Promise.resolve();
  const suspendPromise = pendingSuspend ? new Promise(resolve => { resolveSuspend = resolve; }) : null;
  const sources = [];
  const gains = [];
  const decodes = [];
  const context = {
    state: pendingResume ? 'suspended' : 'running',
    currentTime: 10,
    destination: {},
    resumeCalls: 0,
    resume() { this.resumeCalls++; return resumePromise; },
    decodeAudioData(data) {
      const buffer = { name: ['press','release','pressB','releaseB'][new Uint8Array(data)[0]], duration: DURATION };
      let resolve;
      const promise = pendingDecode ? new Promise(done => { resolve = done; }) : Promise.resolve(buffer);
      decodes.push({ data, resolve: () => resolve(buffer) });
      return promise;
    },
    createBufferSource() {
      const source = {
        buffer: null,
        startedAt: null,
        stoppedAt: null,
        stops: [],
        disconnected: false,
        ended: false,
        connect(target) { this.target = target; },
        disconnect() { this.disconnected = true; },
        start(at) {
          assert.equal(this.startedAt, null, 'a source starts only once');
          this.startedAt = at;
        },
        stop(at = context.currentTime) { this.stops.push(at); this.stoppedAt = at; },
        audibleAt(at) {
          return context.state === 'running' && !this.disconnected && this.startedAt !== null
            && this.startedAt <= at && at < this.startedAt + this.buffer.duration
            && (this.stoppedAt === null || at < this.stoppedAt);
        },
      };
      sources.push(source);
      return source;
    },
    createGain() {
      const calls = [];
      const gain = {
        disconnected: false,
        calls,
        connect(target) { this.target = target; },
        disconnect() { this.disconnected = true; },
        gain: Object.fromEntries(['setValueAtTime', 'linearRampToValueAtTime', 'cancelScheduledValues', 'cancelAndHoldAtTime']
          .map(name => [name, (...args) => calls.push({ name, args })])),
      };
      gains.push(gain);
      return gain;
    },
  };
  if (pendingSuspend) context.suspend = () => suspendPromise;
  const audio = create({
    samples,
    preset: () => selected,
    enabled: () => enabled,
    makeContext: () => context,
    clock: () => milliseconds,
  });
  return {
    audio, context, sources, gains, decodes,
    setEnabled(value) { enabled = value; },
    setPreset(value) { selected = value; },
    setClock(value) { milliseconds = value; },
    resolveDecode() { for (const decode of decodes) decode.resolve(); },
    resumeNow() { context.state = 'running'; resolveResume(); },
    rejectResume() { rejectResume(new Error('Mock audio device unavailable')); },
    finishSuspend() { context.state = 'suspended'; resolveSuspend(); },
    advanceTo(at) {
      context.currentTime = at;
      for (const source of sources) {
        const endedAt = Math.min(source.startedAt + source.buffer.duration, source.stoppedAt ?? Infinity);
        if (!source.ended && source.startedAt !== null && endedAt <= at) {
          source.ended = true;
          source.onended?.();
        }
      }
    },
  };
}

test('predecoded clicks start synchronously and join release with a 40 ms audio-clock overlap', async () => {
  const h = harness();
  const preparation = h.audio.prepare();
  assert.equal(typeof preparation.then, 'function');
  await preparation;
  assert.equal(h.decodes.length, 2);
  assert.equal(h.sources.length, 0);
  h.audio.press();
  assert.equal(h.sources.length, 1, 'the cached path starts within press(), without a microtask');
  near(h.sources[0].startedAt, 10);
  h.context.currentTime = 10.02;
  h.audio.release();
  h.audio.release();
  assert.deepEqual(h.sources.map(source => source.buffer.name), ['press', 'release']);
  near(h.sources[1].startedAt, 10 + DURATION - .04);
  assert.equal(h.decodes.length, 2, 'samples are decoded once');
});

test('release after a long hold starts immediately instead of waiting for a new timer', async () => {
  const h = harness();
  await h.audio.prepare();
  h.audio.press();
  h.advanceTo(10.7);
  h.setClock(1700);
  h.audio.release();
  assert.equal(h.sources.length, 2);
  near(h.sources[1].startedAt, 10.7);
});

test('a new press cancels a release that is still scheduled in the future', async () => {
  const h = harness();
  await h.audio.prepare();
  h.audio.press(); h.audio.release();
  const previousRelease = h.sources[1];
  h.context.currentTime = 10.03;
  h.audio.press();
  near(previousRelease.stoppedAt, 10.03);
  near(h.sources[2].startedAt, 10.03);
  assert.equal(previousRelease.audibleAt(10.12), false);
  h.audio.release();
  assert.deepEqual(h.sources.map(source => source.buffer.name), ['press', 'release', 'press', 'release']);
});

test('a new press fades an already playing release over 8 ms and cancels its old envelope', async () => {
  const h = harness();
  await h.audio.prepare();
  h.audio.press(); h.audio.release();
  const previousRelease = h.sources[1];
  h.advanceTo(previousRelease.startedAt + .01);
  assert.equal(previousRelease.audibleAt(h.context.currentTime), true);
  const now = h.context.currentTime;
  h.audio.press();
  near(previousRelease.stoppedAt, now + .008);
  assert.deepEqual(h.gains[1].calls.slice(-2), [
    { name: 'cancelAndHoldAtTime', args: [now] },
    { name: 'linearRampToValueAtTime', args: [0, now + .008] },
  ]);
  h.advanceTo(now + .009);
  assert.equal(previousRelease.disconnected, true);
  assert.equal(h.gains[1].disconnected, true);
});

test('a late decode starts only the newest gesture and honors its pending release once', async () => {
  const h = harness({ pendingDecode: true });
  h.audio.press(); h.audio.release();
  h.setClock(1020);
  h.audio.press(); h.audio.release(); h.audio.release();
  assert.equal(h.decodes.length, 2, 'pending decode work is shared');
  h.context.currentTime = 11;
  h.resolveDecode();
  await flush();
  assert.deepEqual(h.sources.map(source => source.buffer.name), ['press', 'release']);
  near(h.sources[0].startedAt, 11);
  near(h.sources[1].startedAt, 11 + DURATION - .04);
});

for (const reason of ['stop', 'mute']) {
  test(`${reason} invalidates a pending decode so it cannot replay a stale gesture`, async () => {
    const h = harness({ pendingDecode: true });
    h.audio.press(); h.audio.release();
    if (reason === 'mute') h.setEnabled(false);
    else h.audio.stop();
    h.resolveDecode();
    await flush();
    assert.equal(h.sources.length, 0);
    h.setEnabled(true);
    h.audio.press();
    assert.equal(h.sources.length, 1, 'the next current gesture can use the decoded cache');
  });
}

test('muting while a release is queued stops that queue and rejects muted input', async () => {
  const h = harness();
  await h.audio.prepare();
  h.audio.press(); h.audio.release();
  h.context.currentTime = 10.02;
  h.setEnabled(false);
  h.audio.release();
  near(h.sources[1].stoppedAt, 10.02);
  h.audio.press(); h.audio.release();
  assert.equal(h.sources.length, 2);
  h.advanceTo(10.2);
  assert.equal(h.sources.filter(source => source.audibleAt(10.2)).length, 0);
});

for (const [delay, expected] of [[300, 2], [300.001, 0]]) {
  test(`decode latency ${delay} ms ${expected ? 'meets' : 'exceeds'} the 300 ms gesture budget`, async () => {
    const h = harness({ pendingDecode: true });
    h.audio.press(); h.audio.release();
    h.setClock(1000 + delay);
    h.resolveDecode();
    await flush();
    assert.equal(h.sources.length, expected);
  });
}

test('a context resuming after the 300 ms budget cannot play a stale gesture', async () => {
  const h = harness({ pendingResume: true });
  h.audio.press(); h.audio.release();
  await flush();
  assert.ok(h.context.resumeCalls > 0);
  h.setClock(1301);
  h.resumeNow();
  await flush();
  h.context.currentTime += .001;
  assert.equal(h.sources.filter(source => source.audibleAt(h.context.currentTime)).length, 0);
});

test('an unavailable audio device rejects resume quietly without scheduling stale audio', async () => {
  const h = harness({ pendingResume: true });
  h.audio.press(); h.audio.release();
  await flush();
  assert.equal(h.context.resumeCalls, 1);
  h.rejectResume();
  await flush();
  assert.equal(h.sources.length, 0);
  h.audio.stop();
});

test('press waits for startup suspension before resuming and starting audio', async () => {
  const h = harness({ pendingSuspend: true, pendingResume: true });
  await h.audio.prepare();
  // Simulate the prewarm context still being reported as running until its
  // asynchronous suspend request completes. No source may slip into that gap.
  h.context.state = 'running';
  h.audio.press(); h.audio.release();
  await flush();
  assert.equal(h.sources.length, 0);
  assert.equal(h.context.resumeCalls, 0);
  h.finishSuspend();
  await flush();
  assert.equal(h.context.resumeCalls, 1);
  assert.equal(h.sources.length, 0);
  h.setClock(1100);
  h.resumeNow();
  await flush();
  assert.deepEqual(h.sources.map(source => source.buffer.name), ['press', 'release']);
});

test('synthetic rapid input keeps at most 8 audio voices and ended voices disconnect', async () => {
  const h = harness();
  await h.audio.prepare();
  for (let i = 0; i < 80; i++) {
    h.audio.press(); h.audio.release();
    assert.ok(h.sources.filter(source => !source.disconnected).length <= 8);
    assert.ok(h.gains.filter(gain => !gain.disconnected).length <= 8);
  }
  h.audio.stop();
  h.advanceTo(11);
  assert.equal(h.sources.filter(source => !source.disconnected).length, 0);
  assert.equal(h.gains.filter(gain => !gain.disconnected).length, 0);
});

test('browser module, encoded samples and source WAVs agree across both platforms', () => {
  for (const relative of ['src/interaction-audio.js', 'src/interaction-samples.js']) {
    assert.deepEqual(fs.readFileSync(path.join(ROOT, relative)), fs.readFileSync(path.join(ROOT, 'macos', relative)), relative);
  }
  const browser = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'src/interaction-audio.js'), 'utf8'), browser);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'src/interaction-samples.js'), 'utf8'), browser);
  assert.equal(typeof browser.MaidInteractionAudio.create, 'function');
  const samples = require('../src/interaction-samples.js');
  for (const name of ['press', 'release']) {
    const relative = `assets/audio/bubble-pop-${name}.wav`;
    const original = fs.readFileSync(path.join(ROOT, relative));
    assert.deepEqual(original, fs.readFileSync(path.join(ROOT, 'macos', relative)), relative);
    assert.deepEqual(Buffer.from(samples[name], 'base64'), original);
    assert.equal(browser.MaidInteractionSamples[name], samples[name]);
  }
  assert.notEqual(samples.press, samples.release, 'the gestures have distinct audio samples');
});

const TEST_BANK = { defaultId: 'soft-spring', presets: {
  'soft-spring': { press: 'AA==', release: 'AQ==' }, alternate: { press: 'Ag==', release: 'Aw==' },
} };
test('changing presets uses a matched new pair, cancels old voices and reuses per-preset decoding', async () => {
  const h = harness({samples:TEST_BANK});
  await h.audio.prepare();h.audio.press();h.audio.release();
  h.setPreset('alternate');h.audio.stop();await h.audio.prepare();
  assert.equal(h.sources[1].stoppedAt,10,'the old scheduled release is cancelled');
  h.audio.press();h.audio.release();
  assert.deepEqual(h.sources.slice(2).map(source=>source.buffer.name),['pressB','releaseB']);
  assert.equal(h.decodes.length,4);
  h.setPreset('soft-spring');h.audio.stop();h.audio.press();
  assert.equal(h.sources.at(-1).buffer.name,'press');assert.equal(h.decodes.length,4,'returning to a preset uses its decoded cache');
  h.setPreset('../../arbitrary');h.audio.stop();h.audio.press();
  assert.equal(h.sources.at(-1).buffer.name,'press','unknown choices use the fixed default');
});
test('switching presets while decoding cannot combine old press and new release or replay the old preset', async () => {
  const h=harness({samples:TEST_BANK,pendingDecode:true});
  h.audio.press();h.audio.release();h.setPreset('alternate');h.audio.stop();h.audio.press();h.audio.release();
  h.decodes[0].resolve();h.decodes[1].resolve();await flush();assert.equal(h.sources.length,0);
  h.decodes[2].resolve();h.decodes[3].resolve();await flush();
  assert.deepEqual(h.sources.map(source=>source.buffer.name),['pressB','releaseB']);
});
test('a changed selected preset alone also guards a late decode from the old gesture', async () => {
  const h=harness({samples:TEST_BANK,pendingDecode:true});
  h.audio.press();h.setPreset('alternate');h.resolveDecode();await flush();
  assert.equal(h.sources.length,0);
});

test('runtime master gain raises both phases while preserving the existing per-preset level ratio', async () => {
  const h=harness({samples:{defaultId:'soft-spring',presets:{'soft-spring':{press:'AA==',release:'AQ==',gain:.5},original:{press:'Ag==',release:'Aw==',gain:1}}}});
  h.setPreset('original');await h.audio.prepare();h.audio.press();h.audio.release();
  for(const node of h.gains)near(node.calls.find(call=>call.name==='linearRampToValueAtTime').args[0],1.4);
  h.setPreset('soft-spring');h.audio.stop();await h.audio.prepare();h.audio.press();h.audio.release();
  for(const node of h.gains.slice(2))near(node.calls.find(call=>call.name==='linearRampToValueAtTime').args[0],.7);
});

test('bubble press receives its separate boost while release uses only the shared master gain', async () => {
  const h=harness({samples:{defaultId:'bubble-pop',presets:{'bubble-pop':{press:'AA==',release:'AQ==',gain:.5}}}});
  h.setPreset('bubble-pop');await h.audio.prepare();h.audio.press();h.audio.release();
  near(h.gains[0].calls.find(call=>call.name==='linearRampToValueAtTime').args[0],1.12);
  near(h.gains[1].calls.find(call=>call.name==='linearRampToValueAtTime').args[0],.7);
  near(h.sources[1].startedAt,h.sources[0].startedAt+DURATION-.04);
  h.setPreset('unknown-preset');h.audio.stop();h.audio.press();h.audio.release();
  near(h.gains[2].calls.find(call=>call.name==='linearRampToValueAtTime').args[0],1.12);
  near(h.gains[3].calls.find(call=>call.name==='linearRampToValueAtTime').args[0],.7);
});

test('preset gain is still clamped before the runtime master and role factors are applied', async () => {
  for(const [gain,expected] of [[-2,0],[0,0],[.25,.35],[1,1.4],[2,1.4],[NaN,.7],[Infinity,.7],[undefined,.7],['1',.7]]) {
    const h=harness({samples:{defaultId:'soft-spring',presets:{'soft-spring':{press:'AA==',release:'AQ==',gain}}}});
    await h.audio.prepare();h.audio.press();h.audio.release();
    for(const node of h.gains)near(node.calls.find(call=>call.name==='linearRampToValueAtTime').args[0],expected);
  }
});

test('a preset switch cannot apply bubble press gain to a different gesture or mix its release', async () => {
  const h=harness({samples:{defaultId:'bubble-pop',presets:{'bubble-pop':{press:'AA==',release:'AQ==',gain:.5},'soft-spring':{press:'Ag==',release:'Aw==',gain:.5}}}});
  h.setPreset('bubble-pop');await h.audio.prepare();h.audio.press();
  h.setPreset('soft-spring');h.audio.release();assert.equal(h.sources.length,1,'old release cannot follow a changed selector');
  await h.audio.prepare();h.audio.press();h.audio.release();
  assert.deepEqual(h.sources.slice(1).map(source=>source.buffer.name),['pressB','releaseB']);
  for(const node of h.gains.slice(1))near(node.calls.find(call=>call.name==='linearRampToValueAtTime').args[0],.7);
});

test('an active gesture retains its resolved release level even if bank metadata changes', async () => {
  const samples={defaultId:'bubble-pop',presets:{'bubble-pop':{press:'AA==',release:'AQ==',gain:.5}}};
  const h=harness({samples});h.setPreset('bubble-pop');await h.audio.prepare();h.audio.press();
  samples.presets['bubble-pop'].gain=.1;h.audio.release();
  near(h.gains[0].calls.find(call=>call.name==='linearRampToValueAtTime').args[0],1.12);
  near(h.gains[1].calls.find(call=>call.name==='linearRampToValueAtTime').args[0],.7);
});
test('the PCM sound bank contains four mirrored pairs and the separate duck bank is available', () => {
  const crypto=require('node:crypto'),catalog=require('../src/interaction-sound-catalog.js'),samples=require('../src/interaction-samples.js');
  const manifest=JSON.parse(fs.readFileSync(path.join(ROOT,'assets/audio/manifest.json'),'utf8'));
  const publicPresets=catalog.presets.filter(preset=>!preset.separateBank);
  assert.equal(catalog.presets.length,5);assert.equal(publicPresets.length,4);
  assert.equal(catalog.defaultId,'bubble-pop');assert.equal(catalog.presets[0].id,'bubble-pop');
  assert.equal(samples.defaultId,'bubble-pop');assert.equal(manifest.defaultId,'bubble-pop');
  assert.equal(catalog.presets.find(preset=>preset.id==='original').label,'经典啾啾');
  assert.deepEqual(publicPresets.map(preset=>preset.id),['bubble-pop','soft-spring','original','wood-tap']);
  assert.deepEqual(catalog.presets.filter(preset=>preset.separateBank).map(preset=>preset.id),['dsh-original']);
  assert.deepEqual(Object.keys(samples.presets).sort(),publicPresets.map(preset=>preset.id).sort());
  assert.deepEqual(manifest.presets.map(preset=>preset.id),publicPresets.map(preset=>preset.id));
  assert.equal(Object.hasOwn(samples.presets,'dsh-original'),false);
  assert.deepEqual(fs.readFileSync(path.join(ROOT,'src/interaction-sound-catalog.js')),fs.readFileSync(path.join(ROOT,'macos/src/interaction-sound-catalog.js')));
  const hashes=new Set();
  for(const preset of publicPresets){const entry=manifest.presets.find(value=>value.id===preset.id);assert.ok(entry);
    for(const role of ['press','release']){const clip=entry.clips[role],file=fs.readFileSync(path.join(ROOT,'assets/audio',clip.file));
      assert.deepEqual(file,fs.readFileSync(path.join(ROOT,'macos/assets/audio',clip.file)));
      assert.deepEqual(Buffer.from(samples.presets[preset.id][role],'base64'),file);
      const hash=crypto.createHash('sha256').update(file).digest('hex');assert.equal(hash,clip.sha256);assert.equal(hashes.has(hash),false,'the library contains genuinely different clips');hashes.add(hash);
      assert.equal(file.toString('ascii',0,4),'RIFF');assert.equal(file.toString('ascii',8,12),'WAVE');assert.equal(clip.sampleRate,44100);assert.equal(clip.channels,1);assert.equal(clip.bitsPerSample,16);
    }
  }
  const expectedFiles=[...manifest.presets.flatMap(preset=>Object.values(preset.clips).map(clip=>clip.file)),...manifest.licenseFiles,'manifest.json','DSH-PROVENANCE.txt'].sort();
  for(const relative of ['assets/audio','macos/assets/audio']){
    assert.deepEqual(fs.readdirSync(path.join(ROOT,relative)).sort(),expectedFiles,'public assets contain only selected WAVs, manifest and required notices');
  }
  assert.deepEqual(Object.keys(manifest.sources).sort(),['impact-sounds','interface-sounds','project-original']);
});

test('PCM sample generation stays current alongside the bundled original DSH pair', () => {
  const {prepareInteractionAudio}=require('../scripts/prepare-interaction-audio.cjs');
  assert.deepEqual(prepareInteractionAudio({check:true}),{presets:4,clips:8,modules:2,check:true});
  for(const relative of ['src/local-interaction-samples.js','macos/src/local-interaction-samples.js']){
    const local=require(path.join(ROOT,relative));
    assert.deepEqual(Object.keys(local.presets),['dsh-original'],'release builds include the original duck bank');
    const browser=vm.createContext({});
    vm.runInContext(fs.readFileSync(path.join(ROOT,relative),'utf8'),browser);
    assert.deepEqual(Object.keys(browser.MaidLocalInteractionSamples.presets),['dsh-original']);
  }
});
