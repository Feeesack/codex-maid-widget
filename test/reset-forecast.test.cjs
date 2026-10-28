'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const EPOCH = Date.parse('2026-10-22T14:00:00.000Z');
const ANNOUNCEMENT_ASSET = 'https://codex-reset.com/assets/mock-public/home-countdown.js';
const stamp = delta => new Date(EPOCH + delta).toISOString();
const fixture = changes => ({
  updated_at: stamp(0), probabilities: { rounded_24h: 22, rounded_48h: 39 },
  confidence: 'low', last_reset_at: stamp(-2 * 86400000), official_signal: null,
  latest_alert: null, ...changes,
});
const watch = changes => ({
  id: '1234', kind: 'watch', state: 'active', source_at: stamp(-60000),
  summary: 'Public reset announcement', url: 'https://x.com/thsottiaux/status/1234',
  score: null, window: null, corrected: false, ...changes,
});
function memoryIo(initial = {}) {
  const files = new Map(Object.entries(initial));
  const calls = [];
  const io = {
    statSync(file) { calls.push(['stat', file]); if (!files.has(file)) throw new Error('ENOENT'); return { size: Buffer.byteLength(files.get(file)) }; },
    readFileSync(file) { calls.push(['read', file]); if (!files.has(file)) throw new Error('ENOENT'); return files.get(file); },
    mkdirSync(file, options) { calls.push(['mkdir', file, options]); },
    writeFileSync(file, value) { calls.push(['write', file]); files.set(file, value); },
    renameSync(from, to) { calls.push(['rename', from, to]); files.set(to, files.get(from)); files.delete(from); },
  };
  return { io, files, calls };
}
function response(data = fixture(), { status = 200, headers = {}, body } = {}) {
  const values = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), String(value)]));
  return { status, ok: status >= 200 && status < 300, headers: { get: key => values.get(key.toLowerCase()) ?? null },
    text: async () => typeof data === 'string' ? data : JSON.stringify(data), ...(body ? { body } : {}) };
}
// Every runtime dependency is injected here. The production module cannot reach
// the host's real data directories, environment, timers or network from tests.
function harness(variant, { fetch: request = async () => response(), io = memoryIo().io, file, demo = false, version = '0.4.1',
  announcementReader = { deadlineFor: async () => null } } = {}) {
  let time = EPOCH, timerId = 0;
  const timers = new Map(), network = [], changes = [], announcementCalls = [], announcementSignals = [];
  const context = { module: { exports: {} }, Buffer, URL, AbortController,
    process: { env: Object.freeze({}) },
    require(name) { if (name === 'node:fs') return io; if (name === 'node:path') return path; throw new Error('Unexpected dependency: ' + name); },
    setTimeout(callback, delay) { const id = { value: ++timerId, unref() {} }; timers.set(id, { callback, at: time + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, variant, 'src/reset-forecast.cjs'), 'utf8'), context,
    { filename: variant + '/src/reset-forecast.cjs' });
  const api = context.module.exports;
  const client = new api.ResetForecast({ file, io, demo, version, now: () => time,
    announcementReader: { deadlineFor: input => {
      announcementCalls.push({ id: input.id, at: input.at }); announcementSignals.push(input.signal);
      return announcementReader.deadlineFor(input);
    } },
    fetch: (...args) => { network.push(args); return request(...args); }, onChange: () => changes.push(time) });
  return { ...api, client, network, timers, changes, announcementCalls, announcementSignals,
    setTime(delta) { time = EPOCH + delta; },
    async advance(delta) {
      time += delta;
      const due = [...timers.entries()].filter(([, timer]) => timer.at <= time);
      for (const [id, timer] of due) if (timers.delete(id)) timer.callback();
      await flush();
    },
  };
}
async function flush() { for (let count = 0; count < 12; count++) await Promise.resolve(); }
async function start(env) { env.client.setEnabled(true); await env.client.refresh(); return env.client.snapshot(); }
const plain = value => JSON.parse(JSON.stringify(value));

for (const variant of ['..', '../macos']) {
  test(`${variant}: documented probabilities preserve zero and reject invalid/unknown payloads`, () => {
    const env = harness(variant);
    assert.equal(env.normalizeForecast(fixture({ probabilities: { rounded_24h: 0, rounded_48h: 0 } }), EPOCH).probability24h, 0);
    for (const invalid of [null, false, {}, { p24: 22, p48: 39 },
      fixture({ updated_at: 'invalid' }), fixture({ updated_at: stamp(6 * 60000) }),
      ...[false, '22', null, NaN, Infinity, -1, 101, 22.5].map(value => fixture({ probabilities: { rounded_24h: value, rounded_48h: 39 } })),
      fixture({ probabilities: { rounded_24h: 40, rounded_48h: 39 } }),
      fixture({ probabilities: { raw_24h: 0.22, raw_48h: 0.39 } })]) {
      assert.throws(() => env.normalizeForecast(invalid, EPOCH), /Invalid forecast/);
    }
    assert.equal(env.normalizeForecast(fixture({ confidence: 'unexpected', last_reset_at: 'bad date' }), EPOCH).confidence, null);
    assert.equal(env.normalizeForecast(fixture({ last_reset_at: stamp(600000) }), EPOCH).lastResetAt, null);
    env.client.close();
  });

  test(`${variant}: arbitrary classifier internals never become an active signal or output extension`, () => {
    const env = harness(variant);
    const value = env.normalizeForecast(fixture({
      official_signal: { kind: 'signal', score: 99, window: { end_at: stamp(60000) } },
      mode: 'announced', signal_score: { value: 93 }, latest_alert: { kind: 'unknown', state: 'active' },
      account: 'fixture-private-account', secret: 'fixture-private-token',
    }), EPOCH);
    assert.equal(value.signal, null);
    assert.equal(JSON.stringify(value).includes('fixture-private'), false);
    assert.equal(value.source, 'https://codex-reset.com/');
    env.client.close();
  });

  test(`${variant}: watch is distinct from confirmed reset; no deadline is invented`, () => {
    const env = harness(variant);
    for (const pending of ['done', 'on_its_way']) {
      const value = env.normalizeForecast(fixture({ latest_alert: watch({ pending }) }), EPOCH);
      assert.equal(value.signal.deadlineAt, null);
      assert.equal(value.lastResetAt, stamp(-2 * 86400000));
    }
    for (const alert of [watch({ kind: 'reset', state: 'confirmed' }), watch({ state: 'unknown' }),
      watch({ source_at: stamp(-49 * 3600000) }), watch({ source_at: stamp(2 * 60000) }),
      watch({ source_at: 'invalid' }), watch({ window: { end_at: stamp(-120000) } })]) {
      assert.equal(env.normalizeForecast(fixture({ latest_alert: alert }), EPOCH).signal, null);
    }
    assert.equal(env.normalizeForecast(fixture({ last_reset_at: stamp(-30000), latest_alert: watch() }), EPOCH).signal, null);
    assert.equal(env.normalizeForecast(fixture({ last_reset_at: stamp(-60000), latest_alert: watch() }), EPOCH).signal, null);
    assert.equal(env.normalizeForecast(fixture({ latest_alert: watch({ window: { end_at: stamp(60000) } }) }), EPOCH).signal.deadlineAt, stamp(60000));
    for (const alert of [watch({ state: 'expired' }), watch({ window: { end_at: stamp(-1000) } }),
      watch({ window: { end_at: stamp(60000), target_at: stamp(-1000) } })]) {
      const value = env.normalizeForecast(fixture({ latest_alert: alert }), EPOCH);
      assert.ok(value.signal); assert.equal(value.lastResetAt, stamp(-2 * 86400000));
    }
    env.client.close();
  });

  test(`${variant}: explicit signals survive unavailable cadence probabilities without inventing percentages`, () => {
    const env = harness(variant);
    for (const probabilities of [undefined, {}, { rounded_24h: '22', rounded_48h: 39 },
      { rounded_24h: 40, rounded_48h: 39 }, { rounded_24h: 22.5, rounded_48h: 39 },
      { rounded_24h: 0, rounded_48h: null }]) {
      const value = env.normalizeForecast(fixture({ probabilities, latest_alert: watch({ score: 93 }) }), EPOCH);
      assert.equal(value.probability24h, null); assert.equal(value.probability48h, null);
      assert.equal(value.signal.kind, 'promise'); assert.equal(value.signal.score, 93);
      assert.equal(value.lastResetAt, stamp(-2 * 86400000));
    }
    env.client.close();
  });

  test(`${variant}: canonical signal scores and pending state outrank the same-post extension`, () => {
    const env = harness(variant);
    const normalized = changes => env.normalizeForecast(fixture({ probabilities: { rounded_24h: 22, rounded_48h: 39, commitment_floor_percent: 93 },
      official_signal: { tweet_id: '1234' }, latest_alert: watch(), ...changes }), EPOCH).signal;
    for (const score of [83, 93]) {
      const direct = normalized({ latest_alert: watch({ score }) });
      assert.equal(direct.score, score); assert.equal(direct.kind, score === 93 ? 'promise' : 'watch');
    }
    assert.equal(normalized({}).score, 93); assert.equal(normalized({}).kind, 'promise');
    for (const tweet_id of ['different-post', 1234, null]) assert.equal(normalized({ official_signal: { tweet_id } }).score, null);
    for (const score of [0, 82, 90, 94, '93']) assert.equal(normalized({ probabilities: { rounded_24h: 22, rounded_48h: 39, commitment_floor_percent: score } }).score, null);
    for (const pending of ['done', 'on_its_way']) {
      const signal = normalized({ latest_alert: watch({ score: 93, pending }) });
      assert.equal(signal.pending, pending); assert.equal(signal.kind, 'pending');
      assert.equal(signal.deadlineAt, null); assert.equal(signal.deadlineKind, null);
    }
    env.client.close();
  });

  test(`${variant}: fresh zero cadence after a deadline is not confirmation; later reset evidence withdraws the signal`, async () => {
    let payload = fixture({ latest_alert: watch({ score: 93, window: { target_at: stamp(60000) } }) });
    const env = harness(variant, { fetch: async () => response(payload) });
    assert.equal((await start(env)).signal.score, 93);
    env.setTime(120000);
    payload = fixture({ updated_at: stamp(120000), probabilities: { rounded_24h: 0, rounded_48h: 0 }, latest_alert: watch({ score: 93, state: 'expired', window: { target_at: stamp(60000) } }) });
    await env.client.refresh();
    let snapshot = env.client.snapshot();
    assert.equal(snapshot.signal.state, 'expired'); assert.equal(snapshot.signal.score, 93);
    assert.equal(snapshot.probability24h, 0); assert.equal(snapshot.lastResetAt, stamp(-2 * 86400000));
    env.setTime(240000);
    payload = fixture({ updated_at: stamp(240000), last_reset_at: stamp(180000), latest_alert: watch({ score: 93 }) });
    await env.client.refresh(); snapshot = env.client.snapshot();
    assert.equal(snapshot.signal, null); assert.equal(snapshot.lastResetAt, stamp(180000));
    env.setTime(360000);
    payload = fixture({ updated_at: stamp(360000), last_reset_at: stamp(180000), latest_alert: watch({ kind: 'reset', state: 'confirmed', source_at: stamp(300000) }) });
    await env.client.refresh(); assert.equal(env.client.snapshot().signal, null);
    assert.equal(env.client.snapshot().lastResetAt, stamp(180000)); env.client.close();
  });

  test(`${variant}: documented API windows take priority and never invoke optional announcement discovery`, async () => {
    const env = harness(variant, { fetch: async () => response(fixture({ latest_alert: watch({ window: { target_at: stamp(60000), end_at: stamp(120000) } }) })),
      announcementReader: { deadlineFor: async () => { throw new Error('API window should bypass supplemental discovery'); } } });
    const value = await start(env);
    assert.equal(value.signal.deadlineAt, stamp(60000)); assert.equal(value.signal.deadlineKind, 'announcement');
    assert.equal(value.signal.deadlineQuote, null); assert.equal(value.signal.deadlineSource, null);
    assert.equal(env.announcementCalls.length, 0); assert.equal(env.network.length, 1); env.client.close();
  });

  test(`${variant}: only active numeric post IDs without API windows ask the injected deadline reader`, async () => {
    for (const alert of [watch({ id: 'not-numeric' }), watch({ id: '1234567890123456789012345678901' }),
      watch({ state: 'expired' }), watch({ kind: 'reset', state: 'confirmed' })]) {
      const env = harness(variant, { fetch: async () => response(fixture({ latest_alert: alert })) });
      await start(env); assert.equal(env.announcementCalls.length, 0); assert.equal(env.network.length, 1); env.client.close();
    }
    const env = harness(variant, { fetch: async () => response(fixture({ latest_alert: watch() })),
      announcementReader: { deadlineFor: async () => ({ deadlineAt: stamp(60000), quote: 'Public site observation', sourceUrl: ANNOUNCEMENT_ASSET }) } });
    const value = await start(env);
    assert.deepEqual(env.announcementCalls, [{ id: '1234', at: stamp(-60000) }]);
    assert.equal(env.announcementSignals[0], env.network[0][1].signal);
    assert.equal(value.signal.deadlineAt, stamp(60000)); assert.equal(value.signal.deadlineKind, 'observation');
    assert.equal(value.signal.deadlineQuote, 'Public site observation'); assert.equal(value.signal.deadlineSource, ANNOUNCEMENT_ASSET);
    assert.equal(value.lastResetAt, stamp(-2 * 86400000)); assert.equal(env.network.length, 1); env.client.close();
  });

  test(`${variant}: missing, invalid, implausible or failed supplemental deadlines retain the clear signal`, async () => {
    for (const supplemental of [null, { deadlineAt: 'invalid' }, { deadlineAt: stamp(-120000) },
      { deadlineAt: stamp(25 * 3600000) }, new Error('fixture supplemental offline')]) {
      const env = harness(variant, { fetch: async () => response(fixture({ latest_alert: watch({ score: 93 }) })),
        announcementReader: { deadlineFor: async () => { if (supplemental instanceof Error) throw supplemental; return supplemental; } } });
      const value = await start(env);
      assert.equal(value.status, 'live'); assert.equal(value.signal.score, 93);
      assert.equal(value.signal.kind, 'promise'); assert.equal(value.signal.deadlineAt, null);
      assert.equal(value.signal.deadlineKind, null); assert.equal(value.lastResetAt, stamp(-2 * 86400000));
      assert.equal(env.announcementCalls.length, 1); env.client.close();
    }
  });

  test(`${variant}: supplemental provenance and quote remain bounded public metadata`, async () => {
    for (const sourceUrl of ['https://evil.invalid/assets/mock-public/home-countdown.js',
      'http://codex-reset.com/assets/mock-public/home-countdown.js',
      'https://codex-reset.com/', ANNOUNCEMENT_ASSET + '?token=fixture-private',
      'https://user:password@codex-reset.com/assets/mock-public/home-countdown.js']) {
      const env = harness(variant, { fetch: async () => response(fixture({ latest_alert: watch({ score: 93 }) })),
        announcementReader: { deadlineFor: async () => ({ deadlineAt: stamp(60000), sourceUrl, quote: 'ignored invalid provenance' }) } });
      const value = await start(env); env.client.close();
      assert.equal(value.signal.deadlineAt, null); assert.equal(value.signal.score, 93);
    }
    const env = harness(variant, { fetch: async () => response(fixture({ latest_alert: watch({ score: 93 }) })),
      announcementReader: { deadlineFor: async () => ({ deadlineAt: stamp(60000), sourceUrl: ANNOUNCEMENT_ASSET,
        quote: 'Public observation\n\u0000' + 'x'.repeat(300), private_account: 'fixture-private' }) } });
    const value = await start(env); env.client.close();
    assert.equal(value.signal.deadlineQuote.length, 160); assert.equal(/[\u0000-\u001f\u007f]/.test(value.signal.deadlineQuote), false);
    assert.equal(JSON.stringify(value).includes('fixture-private'), false);
  });

  test(`${variant}: concurrent refreshes share the in-flight supplemental reader too`, async () => {
    let finish;
    const env = harness(variant, { fetch: async () => response(fixture({ latest_alert: watch({ score: 93 }) })),
      announcementReader: { deadlineFor: () => new Promise(resolve => { finish = resolve; }) } });
    env.client.setEnabled(true); const first = env.client.refresh(), second = env.client.refresh();
    await flush(); assert.equal(env.network.length, 1); assert.equal(env.announcementCalls.length, 1);
    finish({ deadlineAt: stamp(60000), quote: 'Public observation', sourceUrl: ANNOUNCEMENT_ASSET });
    await Promise.all([first, second]);
    assert.equal(env.client.snapshot().signal.deadlineAt, stamp(60000));
    await env.client.refresh(); assert.equal(env.network.length, 1); assert.equal(env.announcementCalls.length, 1); env.client.close();
  });

  test(`${variant}: supplemental timeout preserves a promise while aborting its transport`, async () => {
    let requestSignal;
    const env = harness(variant, { fetch: async (url, options) => { requestSignal = options.signal; return response(fixture({ latest_alert: watch({ score: 93 }) })); },
      announcementReader: { deadlineFor: () => new Promise((resolve, reject) => requestSignal.addEventListener('abort', () => reject(new Error('fixture metadata timeout')), { once: true })) } });
    env.client.setEnabled(true); const pending = env.client.refresh(); await flush();
    await env.advance(8000); await pending;
    const value = env.client.snapshot(); assert.equal(requestSignal.aborted, true);
    assert.equal(value.status, 'live'); assert.equal(value.signal.score, 93); assert.equal(value.signal.deadlineAt, null);
    assert.equal(value.lastResetAt, stamp(-2 * 86400000)); env.client.close();
  });

  test(`${variant}: old metadata completing after disable/re-enable cannot replace the newer generation or cache`, async () => {
    const memory = memoryIo(), file = 'Z:\\mock-only 隔离\\forecast.json', finishes = [];
    let requests = 0;
    const env = harness(variant, { io: memory.io, file,
      fetch: async () => response(fixture({ updated_at: stamp(requests++ === 0 ? 0 : 120000), latest_alert: watch({ score: 93 }) })),
      announcementReader: { deadlineFor: () => new Promise(resolve => finishes.push(resolve)) } });
    env.client.setEnabled(true); const old = env.client.refresh(); await flush();
    assert.equal(finishes.length, 1); env.client.setEnabled(false);
    env.setTime(120000); env.client.setEnabled(true); const current = env.client.refresh(); await flush();
    assert.equal(finishes.length, 2);
    finishes[1]({ deadlineAt: stamp(240000), quote: 'newer', sourceUrl: ANNOUNCEMENT_ASSET }); await current;
    const saved = memory.files.get(file);
    finishes[0]({ deadlineAt: stamp(60000), quote: 'older', sourceUrl: ANNOUNCEMENT_ASSET }); await old;
    assert.equal(env.client.snapshot().signal.deadlineAt, stamp(240000)); assert.equal(env.client.snapshot().signal.deadlineQuote, 'newer');
    assert.equal(memory.files.get(file), saved); assert.equal(env.network.length, 2); env.client.close();
  });

  test(`${variant}: closing during supplemental discovery prevents late cache writes and rescheduling`, async () => {
    let finish;
    const memory = memoryIo(), file = 'Z:\\mock-only 隔离\\forecast.json';
    const env = harness(variant, { io: memory.io, file, fetch: async () => response(fixture({ latest_alert: watch() })),
      announcementReader: { deadlineFor: () => new Promise(resolve => { finish = resolve; }) } });
    env.client.setEnabled(true); const pending = env.client.refresh(); await flush(); env.client.close();
    finish({ deadlineAt: stamp(60000), quote: 'late', sourceUrl: ANNOUNCEMENT_ASSET }); await pending;
    assert.equal(memory.files.has(file), false); assert.equal(env.timers.size, 0); assert.equal(env.client.snapshot().updatedAt, null);
  });

  test(`${variant}: disabling before a delayed API body completes never starts optional announcement discovery`, async () => {
    let finishBody;
    const memory = memoryIo(), file = 'Z:\\mock-only 隔离\\forecast.json';
    const env = harness(variant, { io: memory.io, file, fetch: async () => ({ ...response(),
      text: () => new Promise(resolve => { finishBody = resolve; }) }) });
    env.client.setEnabled(true); const pending = env.client.refresh(); await flush();
    env.client.setEnabled(false); finishBody(JSON.stringify(fixture({ latest_alert: watch({ score: 93 }) }))); await pending;
    assert.equal(env.announcementCalls.length, 0); assert.equal(env.client.snapshot().status, 'disabled');
    assert.equal(memory.files.has(file), false); assert.equal(env.timers.size, 0); env.client.close();
  });

  test(`${variant}: obsolete throttled responses cannot delay a new enabled generation`, async () => {
    let finishOld, requests = 0;
    const env = harness(variant, { fetch: () => ++requests === 1 ? new Promise(resolve => { finishOld = resolve; })
      : Promise.resolve(response(fixture({ updated_at: stamp(requests === 2 ? 120000 : 240000) }))) });
    env.client.setEnabled(true); const old = env.client.refresh(); env.client.setEnabled(false);
    env.setTime(120000); env.client.setEnabled(true); await env.client.refresh();
    assert.equal(env.client.snapshot().status, 'live');
    finishOld(response({}, { status: 429, headers: { 'retry-after': '3600' } })); await old;
    env.setTime(240000); await env.client.refresh();
    assert.equal(env.network.length, 3); assert.equal(env.client.snapshot().status, 'live'); env.client.close();
  });

  test(`${variant}: signal text is bounded and only public Tibo HTTPS post links survive`, () => {
    const env = harness(variant);
    const normalized = env.normalizeForecast(fixture({ latest_alert: watch({ summary: ' hello\n\u0000' + 'x'.repeat(400), url: 'https://x.com/thsottiaux/status/1234?tracking=private#hash' }) }), EPOCH);
    assert.equal(normalized.signal.summary.length, 280);
    assert.equal(/[\u0000-\u001f\u007f]/.test(normalized.signal.summary), false);
    assert.equal(normalized.signal.url, 'https://x.com/thsottiaux/status/1234');
    for (const url of ['http://x.com/thsottiaux/status/1', 'https://x.com.evil.invalid/thsottiaux/status/1',
      'https://x.com:8443/thsottiaux/status/1',
      'https://example.invalid/', 'https://user:password@x.com/thsottiaux/status/1', 'https://x.com/other/status/1',
      'javascript:alert(1)', 'file:///private']) {
      assert.equal(env.normalizeForecast(fixture({ latest_alert: watch({ url }) }), EPOCH).signal.url, null);
    }
    env.client.close();
  });

  test(`${variant}: fetch is a keyless fixed-origin GET with identifying UA and no personal payload`, async () => {
    const cache = memoryIo(), file = path.join(os.tmpdir(), 'mock-only 中文 data', 'forecast.json');
    const env = harness(variant, { io: cache.io, file });
    const snapshot = await start(env);
    assert.equal(snapshot.status, 'live');
    assert.equal(env.network.length, 1);
    const [url, options] = env.network[0];
    assert.equal(url, 'https://codex-reset.com/api/forecast');
    assert.equal(options.method, 'GET'); assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Accept, 'application/json');
    assert.equal(options.headers['User-Agent'], 'Codex-Maid-Widget/0.4.1 (+https://github.com/Feeesack/codex-maid-widget)');
    assert.deepEqual(Object.keys(options.headers).sort(), ['Accept', 'User-Agent']);
    assert.equal('body' in options, false); assert.equal('Cookie' in options.headers, false); assert.equal('Authorization' in options.headers, false);
    assert.equal(JSON.stringify([url, options]).includes(file), false);
    assert.equal(cache.files.has(file), true);
    env.client.close();
  });

  test(`${variant}: concurrent manual refreshes share one request and respect two-minute cooldown`, async () => {
    let resolve;
    const env = harness(variant, { fetch: () => new Promise(done => { resolve = done; }) });
    env.client.setEnabled(true);
    const first = env.client.refresh(), second = env.client.refresh();
    assert.equal(env.network.length, 1);
    resolve(response()); await Promise.all([first, second]);
    await env.client.refresh(); assert.equal(env.network.length, 1);
    env.setTime(119999); await env.client.refresh(); assert.equal(env.network.length, 1);
    env.setTime(120000);
    const next = env.client.refresh(); assert.equal(env.network.length, 2);
    resolve(response(fixture({ updated_at: stamp(120000) }))); await next;
    assert.equal(env.client.snapshot().status, 'live');
    env.client.close();
  });

  test(`${variant}: eight-second timeout aborts transport and allows later recovery`, async () => {
    let attempts = 0;
    const env = harness(variant, { fetch: (url, options) => {
      if (++attempts > 1) return Promise.resolve(response(fixture({ updated_at: stamp(120000) })));
      return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    } });
    env.client.setEnabled(true);
    const pending = env.client.refresh();
    await env.advance(7999); assert.equal(env.network[0][1].signal.aborted, false);
    await env.advance(1); await pending;
    assert.equal(env.network[0][1].signal.aborted, true); assert.equal(env.client.snapshot().status, 'offline');
    env.setTime(120000); await env.client.refresh();
    assert.equal(env.client.snapshot().status, 'live'); assert.equal(env.network.length, 2);
    env.client.close();
  });

  test(`${variant}: disabled/closed clients never poll and late responses cannot revive them`, async () => {
    let resolve;
    const env = harness(variant, { fetch: () => new Promise(done => { resolve = done; }) });
    await env.client.refresh(); assert.equal(env.network.length, 0);
    env.client.setEnabled(true); const pending = env.client.refresh();
    env.client.setEnabled(false); assert.equal(env.network[0][1].signal.aborted, true);
    resolve(response()); await pending;
    assert.equal(env.client.snapshot().status, 'disabled'); assert.equal(env.client.snapshot().updatedAt, null);
    assert.equal(env.timers.size, 0);
    env.client.close(); env.client.setEnabled(true); await env.client.refresh();
    assert.equal(env.network.length, 1);
  });

  test(`${variant}: 429 and 503 honour both Retry-After forms and recover after cooldown`, async () => {
    for (const status of [429, 503]) for (const retry of ['600', new Date(EPOCH + 600000).toUTCString()]) {
      let attempts = 0;
      const env = harness(variant, { fetch: async () => ++attempts === 1 ? response({}, { status, headers: { 'Retry-After': retry } }) : response(fixture({ updated_at: stamp(600000) })) });
      assert.equal((await start(env)).status, 'offline');
      env.setTime(599999); await env.client.refresh(); assert.equal(env.network.length, 1);
      env.setTime(600000); await env.client.refresh(); assert.equal(env.network.length, 2);
      assert.equal(env.client.snapshot().status, 'live'); env.client.close();
    }
    const env = harness(variant);
    for (const retry of [null, '', 'invalid', '0', '-1', new Date(EPOCH - 60000).toUTCString()]) assert.equal(env.retryDelay(retry, EPOCH), 120000);
    assert.equal(env.retryDelay('99999999999999999', EPOCH), 2147483647);
    env.client.close();
  });

  test(`${variant}: offline refresh retains cached signal for explicit stale presentation until recovery`, async () => {
    let attempts = 0;
    const env = harness(variant, { fetch: async () => {
      if (++attempts === 2) throw new Error('fixture offline');
      return response(fixture({ updated_at: stamp(attempts === 1 ? 0 : 240000), latest_alert: watch() }));
    } });
    assert.ok((await start(env)).signal);
    env.setTime(120000); await env.client.refresh();
    let value = env.client.snapshot();
    assert.equal(value.status, 'stale'); assert.equal(value.probability24h, 22); assert.ok(value.signal);
    assert.equal(value.signal.id, '1234'); assert.equal(value.lastResetAt, stamp(-2 * 86400000));
    env.setTime(240000); await env.client.refresh(); value = env.client.snapshot();
    assert.equal(value.status, 'live'); assert.ok(value.signal); env.client.close();
  });

  test(`${variant}: published expiration and model age mark snapshots stale immediately`, async () => {
    const env = harness(variant, { fetch: async () => response(fixture({ latest_alert: watch() }), { headers: {
      'x-published-checked-at': stamp(-60000), 'x-published-expires-at': stamp(90000),
    } }) });
    assert.equal((await start(env)).status, 'live');
    env.setTime(90000); assert.equal(env.client.snapshot().status, 'stale'); assert.ok(env.client.snapshot().signal);
    env.client.close();
    const old = harness(variant, { fetch: async () => response(fixture({ updated_at: stamp(-16 * 60000), latest_alert: watch() })) });
    assert.equal((await start(old)).status, 'stale'); assert.ok(old.client.snapshot().signal); old.client.close();
  });

  test(`${variant}: deadline passing keeps an unconfirmed announcement while source age eventually expires`, async () => {
    const env = harness(variant, { fetch: async () => response(fixture({ latest_alert: watch({ window: { end_at: stamp(60000) } }) })) });
    assert.ok((await start(env)).signal); env.setTime(60000);
    assert.equal(env.client.snapshot().status, 'live'); assert.ok(env.client.snapshot().signal);
    assert.equal(env.client.snapshot().signal.deadlineAt, stamp(60000));
    assert.equal(env.client.snapshot().lastResetAt, stamp(-2 * 86400000));
    const clone = env.client.snapshot(); clone.probability24h = 99;
    assert.equal(env.client.snapshot().probability24h, 22);
    env.setTime(49 * 3600000); assert.equal(env.client.snapshot().signal, null); env.client.close();
  });

  test(`${variant}: malformed, oversize and redirect-failed responses never replace last good data`, async () => {
    for (const result of [() => response('{bad json'), () => response(fixture(), { headers: { 'content-length': '65537' } }),
      () => response(' '.repeat(65537)), () => response({}, { status: 302 }),
      () => response(fixture({ probabilities: { rounded_24h: false, rounded_48h: 80 } }))]) {
      let attempts = 0;
      const env = harness(variant, { fetch: async () => ++attempts === 1 ? response() : result() });
      await start(env); env.setTime(120000); await env.client.refresh();
      assert.equal(env.client.snapshot().status, 'stale'); assert.equal(env.client.snapshot().probability24h, 22); env.client.close();
    }
  });

  test(`${variant}: bounded streaming response cancels readers after overflow`, async () => {
    let canceled = 0, reads = 0;
    const env = harness(variant, { fetch: async () => response('', { body: { getReader: () => ({
      async read() { reads++; return { done: false, value: Buffer.alloc(40000, 32) }; },
      async cancel() { canceled++; },
    }) } }) });
    assert.equal((await start(env)).status, 'offline'); assert.equal(reads, 2); assert.equal(canceled, 1); env.client.close();
  });

  test(`${variant}: UTF-8 streaming chunks parse successfully and copied signal objects stay isolated`, async () => {
    const bytes = Buffer.from(JSON.stringify(fixture({ latest_alert: watch({ summary: '重置通知 / reset 公告' }) })), 'utf8');
    const chunks = [bytes.subarray(0, 103), bytes.subarray(103, bytes.length - 4), bytes.subarray(bytes.length - 4)];
    let index = 0, canceled = 0;
    const env = harness(variant, { fetch: async () => response('', { body: { getReader: () => ({
      async read() { return index < chunks.length ? { done: false, value: chunks[index++] } : { done: true }; },
      async cancel() { canceled++; },
    }) } }) });
    const value = await start(env);
    assert.equal(value.status, 'live'); assert.equal(value.signal.summary, '重置通知 / reset 公告');
    value.signal.summary = 'mutated snapshot';
    assert.equal(env.client.snapshot().signal.summary, '重置通知 / reset 公告');
    assert.equal(canceled, 1); env.client.close();
  });

  test(`${variant}: cache roundtrip stores only bounded public fields and restores as stale`, async () => {
    const file = path.join(os.tmpdir(), 'mock-only 用户 profile', 'data with spaces', 'forecast.json');
    const memory = memoryIo();
    const env = harness(variant, { io: memory.io, file, fetch: async () => response(fixture({
      latest_alert: watch(), account_id: 'fixture-private-id', auth_token: 'fixture-private-token',
      internal_extension: { ignored: true },
    }), { headers: { 'x-published-expires-at': stamp(180000) } }) });
    await start(env); env.client.close();
    const bytes = memory.files.get(file), stored = JSON.parse(bytes);
    assert.equal(bytes.includes('fixture-private'), false); assert.equal(bytes.includes('internal_extension'), false);
    assert.equal(stored.expiresAt, stamp(180000)); assert.equal(stored.data.latest_alert.kind, 'watch');
    assert.equal(memory.files.has(file + '.tmp'), false);
    const restored = harness(variant, { io: memory.io, file, fetch: async () => { throw new Error('offline fixture'); } });
    assert.equal(restored.client.snapshot().status, 'disabled');
    const snapshot = await start(restored);
    assert.equal(snapshot.status, 'stale'); assert.equal(snapshot.probability24h, 22); assert.equal(snapshot.signal.id, '1234');
    restored.client.close();
  });

  test(`${variant}: cache roundtrip preserves observation provenance, promise score, pending state and unavailable percentages`, async () => {
    const file = 'Z:\\mock-only 中文 data\\forecast.json', memory = memoryIo();
    const env = harness(variant, { io: memory.io, file,
      fetch: async () => response(fixture({ probabilities: {}, latest_alert: watch({ score: 93, pending: 'on_its_way' }), arbitrary_private: 'fixture-private' })),
      announcementReader: { deadlineFor: async () => ({ deadlineAt: stamp(60000), quote: '网站观察时限 / site observation', sourceUrl: ANNOUNCEMENT_ASSET }) } });
    const live = await start(env); env.client.close();
    assert.equal(live.signal.deadlineKind, 'observation');
    const saved = JSON.parse(memory.files.get(file));
    assert.equal(saved.data.latest_alert.window, null);
    assert.equal(saved.siteDeadline.id, '1234'); assert.equal(saved.siteDeadline.at, stamp(-60000));
    assert.equal(JSON.stringify(saved).includes('fixture-private'), false);
    const restored = harness(variant, { io: memory.io, file, fetch: async () => { throw new Error('fixture offline'); } });
    const stale = await start(restored); restored.client.close();
    assert.equal(stale.status, 'stale'); assert.equal(stale.probability24h, null); assert.equal(stale.probability48h, null);
    assert.equal(stale.signal.kind, 'pending'); assert.equal(stale.signal.pending, 'on_its_way'); assert.equal(stale.signal.score, 93);
    assert.equal(stale.signal.deadlineKind, 'observation'); assert.equal(stale.signal.deadlineAt, stamp(60000));
    assert.equal(stale.signal.deadlineQuote, live.signal.deadlineQuote); assert.equal(stale.signal.deadlineSource, ANNOUNCEMENT_ASSET);
    assert.equal(stale.lastResetAt, live.lastResetAt);
    for (const patch of [{ id: 'different-post' }, { at: stamp(-120000) }, { sourceUrl: 'https://evil.invalid/assets/mock-public/home-countdown.js' }]) {
      const changed = plain(saved); Object.assign(changed.siteDeadline, patch);
      const mismatched = harness(variant, { io: memoryIo({ [file]: JSON.stringify(changed) }).io, file,
        fetch: async () => { throw new Error('fixture offline'); } });
      const value = await start(mismatched); mismatched.client.close();
      assert.equal(value.status, 'stale'); assert.equal(value.signal.score, 93);
      assert.equal(value.signal.deadlineAt, null); assert.equal(value.signal.deadlineKind, null);
    }
  });

  test(`${variant}: expired cached signal remains pending while fresh reset evidence clears it`, async () => {
    const file = 'Z:\\mock-only 用户 data\\forecast.json';
    const cacheData = { data: fixture({ latest_alert: watch({ state: 'expired', score: 93, pending: 'done', window: { end_at: stamp(-1000) } }) }),
      fetchedAt: stamp(0), expiresAt: stamp(180000) };
    let fresh = false;
    const env = harness(variant, { io: memoryIo({ [file]: JSON.stringify(cacheData) }).io, file,
      fetch: async () => { if (!fresh) throw new Error('fixture offline'); return response(fixture({ updated_at: stamp(120000), last_reset_at: stamp(60000), latest_alert: watch({ score: 93 }) })); } });
    let value = await start(env);
    assert.equal(value.status, 'stale'); assert.equal(value.signal.state, 'expired'); assert.equal(value.signal.pending, 'done');
    assert.equal(value.signal.deadlineAt, stamp(-1000)); assert.equal(value.lastResetAt, stamp(-2 * 86400000));
    fresh = true; env.setTime(120000); await env.client.refresh(); value = env.client.snapshot();
    assert.equal(value.status, 'live'); assert.equal(value.signal, null); assert.equal(value.lastResetAt, stamp(60000)); env.client.close();
  });

  test(`${variant}: missing/corrupt/future/oversize cache and IO failures do not break startup or live data`, async () => {
    const file = path.join(os.tmpdir(), 'mock-only cache', 'forecast.json');
    for (const bytes of [undefined, '{malformed', ' '.repeat(65537), JSON.stringify({ data: fixture(), fetchedAt: stamp(120000) }),
      JSON.stringify({ data: fixture({ probabilities: {} }), fetchedAt: stamp(0) })]) {
      const memory = memoryIo(bytes === undefined ? {} : { [file]: bytes });
      const env = harness(variant, { io: memory.io, file });
      assert.equal(env.client.snapshot().updatedAt, null); assert.equal((await start(env)).status, 'live'); env.client.close();
    }
    for (const operation of ['statSync', 'readFileSync', 'mkdirSync', 'writeFileSync', 'renameSync']) {
      const memory = memoryIo({ [file]: JSON.stringify({ data: fixture(), fetchedAt: stamp(0) }) });
      memory.io[operation] = () => { throw new Error('fixture EACCES'); };
      const env = harness(variant, { io: memory.io, file });
      assert.equal((await start(env)).status, 'live'); env.client.close();
    }
  });

  test(`${variant}: custom data directory with Chinese/spaces uses real isolated atomic cache only`, async () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'maid-reset-隔离 '));
    const file = path.join(temporary, '自定义 data', '重置 forecast.json');
    try {
      const env = harness(variant, { io: fs, file });
      assert.equal((await start(env)).status, 'live'); env.client.close();
      assert.equal(fs.existsSync(file), true); assert.equal(fs.existsSync(file + '.tmp'), false);
      assert.deepEqual(fs.readdirSync(path.dirname(file)), ['重置 forecast.json']);
      const restored = harness(variant, { io: fs, file, fetch: async () => { throw new Error('fixture offline'); } });
      assert.equal((await start(restored)).status, 'stale'); assert.equal(restored.client.snapshot().probability48h, 39); restored.client.close();
    } finally {
      assert.equal(path.dirname(path.resolve(temporary)), path.resolve(os.tmpdir()));
      assert.ok(path.basename(temporary).startsWith('maid-reset-隔离 '));
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  });

  test(`${variant}: custom non-default Windows drive cache is resolved solely from the injected path`, async () => {
    const file = path.win32.join('Z:\\', '自定义数据 user', 'Maid Profile', 'reset.json');
    const memory = memoryIo();
    const env = harness(variant, { io: memory.io, file });
    assert.equal((await start(env)).status, 'live'); env.client.close();
    assert.equal(memory.files.has(file), true);
    const paths = memory.calls.flatMap(call => call.slice(1).filter(item => typeof item === 'string'));
    assert.ok(paths.length > 0);
    assert.ok(paths.every(item => item.startsWith('Z:\\')));
    assert.ok(paths.includes(file + '.tmp'));
    assert.equal(env.network.some(args => JSON.stringify(args).includes(file)), false);
  });

  test(`${variant}: demo stays local without touching real or mocked IO`, async () => {
    const memory = memoryIo();
    const env = harness(variant, { demo: true, io: memory.io, file: path.join(os.tmpdir(), 'mock-only demo', 'cache.json') });
    const snapshot = await start(env);
    assert.equal(snapshot.status, 'demo'); assert.equal(snapshot.probability24h, 22);
    assert.equal(env.network.length, 0); assert.equal(memory.calls.length, 0); assert.equal(env.timers.size, 0);
    assert.deepEqual(plain(snapshot.signal), null); env.client.close();
  });
}
