'use strict';
// Paired local samples. Sources and optional private audio are documented separately.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MaidInteractionAudio = api;
})(globalThis, function () {
  // Runtime mix only: retain each preset's source bytes and 0..1 gain contract.
  const MASTER_GAIN = 1.4;
  const BUBBLE_PRESS_GAIN = 1.6;
  function withLocalSamples(samples, local) {
    return { ...samples, presets: { ...samples.presets, ...local?.presets } };
  }
  function create({ samples, enabled, preset = () => samples.defaultId || 'soft-spring', makeContext = () => new AudioContext(), clock = () => performance.now(),
    bytes = value => Uint8Array.from(atob(value), character => character.charCodeAt(0)) }) {
    const bank = samples.presets || { 'soft-spring': samples };
    const defaultId = Object.hasOwn(bank, samples.defaultId) ? samples.defaultId : Object.keys(bank)[0];
    const decoded = new Map(), loading = new Map();
    const selectedId = () => { const id = preset(); return Object.hasOwn(bank, id) ? id : defaultId; };
    let context, suspending, generation = 0, gesture;
    const voices = new Set();
    function prepare(id = selectedId()) {
      if (!enabled()) return null;
      try {
        if (!context) {
          context = makeContext();
          // Decode on startup without keeping an idle audio device active.
          if (!gesture && context.suspend) suspending = context.suspend().catch(() => {}).finally(() => { suspending = null; });
        }
        if (!loading.has(id)) loading.set(id, Promise.all(['press', 'release'].map(name =>
          context.decodeAudioData(bytes(bank[id][name]).buffer))).then(values => {
          const buffers = { press: values[0], release: values[1] };
          decoded.set(id, buffers);
          return buffers;
        }).catch(() => { loading.delete(id); return null; }));
        return loading.get(id);
      } catch { return null; }
    }
    function retire(voice) {
      if (voice.retired) return;
      voice.retired = true;
      const now = context.currentTime;
      try {
        if (voice.at > now || context.state === 'suspended') voice.source.stop(now);
        else {
          if (voice.gain.gain.cancelAndHoldAtTime) voice.gain.gain.cancelAndHoldAtTime(now);
          else {
            voice.gain.gain.cancelScheduledValues(now);
            voice.gain.gain.setValueAtTime(voice.gain.gain.value, now);
          }
          voice.gain.gain.linearRampToValueAtTime(0, now + .008);
          voice.source.stop(now + .008);
        }
      } catch { /* Already ended. */ }
    }
    function stop() {
      generation++; gesture = null;
      for (const voice of voices) retire(voice);
    }
    function play(name, at, buffers, level) {
      const source = context.createBufferSource(), gain = context.createGain();
      source.buffer = buffers[name]; source.connect(gain); gain.connect(context.destination);
      // The PCM files also have short fades; this envelope keeps source stealing quiet.
      gain.gain.setValueAtTime(0, at);
      gain.gain.linearRampToValueAtTime(level, at + .003);
      gain.gain.setValueAtTime(level, at + Math.max(.003, source.buffer.duration - .008));
      gain.gain.linearRampToValueAtTime(0, at + source.buffer.duration);
      const voice = { source, gain, at, retired: false };
      voices.add(voice);
      source.onended = () => { voices.delete(voice); source.disconnect(); gain.disconnect(); };
      source.start(at);
      // Bounded even for synthetic input faster than the audio render quantum.
      if (voices.size > 8) {
        const oldest = voices.values().next().value;
        try { oldest.source.stop(); } catch {}
        oldest.source.disconnect(); oldest.gain.disconnect(); voices.delete(oldest);
      }
      return at + source.buffer.duration;
    }
    function scheduleRelease(value) {
      if (value.releaseScheduled || value.token !== generation || value.presetId !== selectedId() || !enabled()) return;
      value.releaseScheduled = true;
      // DSH's overlap: join the tail of the press on the audio clock, not a JS timer.
      play('release', Math.max(context.currentTime, value.pressEnd - .04), value.buffers, value.level);
    }
    function begin(value) {
      const buffers = decoded.get(value.presetId);
      if (!buffers || value.token !== generation || value.presetId !== selectedId() || !enabled() || clock() - value.requestedAt > 300) return;
      value.buffers = buffers;
      const presetLevel = Number.isFinite(bank[value.presetId].gain) ? Math.max(0, Math.min(1, bank[value.presetId].gain)) : .5;
      value.level = presetLevel * MASTER_GAIN;
      // Resolve the press balance from this gesture's fixed preset, never the
      // live selector, so a switch cannot change a pending pair's mix.
      const pressLevel = value.level * (value.presetId === 'bubble-pop' ? BUBBLE_PRESS_GAIN : 1);
      value.pressEnd = play('press', context.currentTime, buffers, pressLevel);
      if (value.released) scheduleRelease(value);
    }
    function press() {
      stop();
      if (!enabled()) return;
      const value = gesture = { token: generation, presetId: selectedId(), requestedAt: clock(), released: false };
      const ready = prepare(value.presetId);
      if (decoded.has(value.presetId) && !suspending && context.state !== 'suspended') begin(value);
      else if (ready) Promise.all([ready, suspending]).then(async () => {
        if (value.token !== generation || !enabled() || clock() - value.requestedAt > 300) return;
        if (context.state === 'suspended') await context.resume();
        begin(value);
      }).catch(() => {});
    }
    function release() {
      if (!enabled()) { stop(); return; }
      const value = gesture;
      if (!value || value.released) return;
      value.released = true;
      if (value.pressEnd !== undefined) scheduleRelease(value);
    }
    return { prepare, press, release, stop };
  }
  return { create, withLocalSamples };
});
