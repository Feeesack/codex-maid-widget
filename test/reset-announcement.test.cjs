'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const EPOCH = Date.parse('2026-10-22T14:00:00.000Z');
const iso = delta => new Date(EPOCH + delta).toISOString();
const ID = '123456789012345', REPLY = '123456789012346';
const PAGE = 'https://codex-reset.com/zh/';
function publicFiles(hash = 'hash-a', deadline = iso(3 * 3600000), changes = {}) {
  const base = 'https://codex-reset.com/assets/' + hash + '/';
  const deadlines = { [ID]: deadline }, quotes = { [ID]: { text: 'Lands before the announced target', source_id: REPLY } };
  const values = {
    page: `<script src="/assets/analytics.js"></script><script type="module" src="/assets/${hash}/app.js"></script>`,
    app: 'async function init() { const { createHome } = await import("./home.js"); return createHome(); }',
    home: 'import { createHomeCountdown } from "./home-countdown.js"; export function createHome() {}',
    countdown: `export const OBSERVATION_DEADLINES = Object.freeze(${JSON.stringify(deadlines)});\nexport const OBSERVATION_QUOTES = Object.freeze(${JSON.stringify(quotes)});`,
    ...changes,
  };
  return new Map([[PAGE, values.page], [base + 'app.js', values.app], [base + 'home.js', values.home], [base + 'home-countdown.js', values.countdown]]);
}
function setup(ResetAnnouncement, files = publicFiles(), request) {
  let now = EPOCH;
  const calls = [];
  const adapter = new ResetAnnouncement({ now: () => now, fetch: async (url, options) => {
    calls.push({ url, options });
    if (request) return request(url, options);
    if (!files.has(url)) throw new Error('Unexpected isolated URL: ' + url);
    return files.get(url);
  } });
  return { adapter, calls, files, setTime(delta) { now = EPOCH + delta; } };
}
const signal = changes => ({ id: ID, at: iso(-60000), ...changes });

// All requests and clocks are injected. This suite never opens a network
// connection, reads a data directory or evaluates the downloaded fixture JS.
for (const variant of ['..', '../macos']) {
  const { ResetAnnouncement } = require(variant + '/src/reset-announcement.cjs');
  test(`${variant}: discovers the four-resource chain and reads only published JSON corrections`, async () => {
    const env = setup(ResetAnnouncement), value = await env.adapter.deadlineFor(signal());
    assert.deepEqual(value, { deadlineAt: iso(3 * 3600000), quote: 'Lands before the announced target',
      sourceUrl: 'https://codex-reset.com/assets/hash-a/home-countdown.js', replyId: REPLY, kind: 'observation' });
    assert.deepEqual(env.calls.map(call => call.url), [...env.files.keys()]);
    for (const call of env.calls) assert.deepEqual(call.options, { method: 'GET', credentials: 'omit', redirect: 'error' });
    assert.equal(JSON.stringify(env.calls).includes(ID), false);
  });

  test(`${variant}: publisher's literal text/source_id keys are safely normalized without accepting code`, async () => {
    const files = publicFiles(), script = [...files.keys()].at(-1);
    files.set(script, files.get(script).replace('"text":', 'text:').replace('"source_id":', 'source_id:'));
    assert.ok(await setup(ResetAnnouncement, files).adapter.deadlineFor(signal()));
    files.set(script, files.get(script).replace('text:"Lands before the announced target"', 'text:(() => "unsafe")()'));
    assert.equal(await setup(ResetAnnouncement, files).adapter.deadlineFor(signal()), null);
  });

  test(`${variant}: successful metadata is reused for thirty minutes and discovers a changed asset hash`, async () => {
    const files = publicFiles(), env = setup(ResetAnnouncement, files);
    await env.adapter.deadlineFor(signal()); assert.equal(env.calls.length, 4);
    env.setTime(29 * 60000); await env.adapter.deadlineFor(signal()); assert.equal(env.calls.length, 4);
    const next = publicFiles('hash-b', iso(4 * 3600000));
    for (const [key, value] of next) files.set(key, value);
    env.setTime(30 * 60000);
    const value = await env.adapter.deadlineFor(signal());
    assert.equal(env.calls.length, 8); assert.equal(value.deadlineAt, iso(4 * 3600000));
    assert.equal(value.sourceUrl, 'https://codex-reset.com/assets/hash-b/home-countdown.js');
  });

  test(`${variant}: a new signal can refresh missing metadata after two minutes without invalidating cached IDs`, async () => {
    const files = publicFiles(), env = setup(ResetAnnouncement, files), otherId = '987654321098765';
    assert.ok(await env.adapter.deadlineFor(signal()));
    assert.equal(await env.adapter.deadlineFor(signal({ id: otherId })), null); assert.equal(env.calls.length, 4);
    env.setTime(120000);
    const next = publicFiles('hash-b');
    for (const [key, value] of next) files.set(key, value.replaceAll(ID, otherId));
    const value = await env.adapter.deadlineFor(signal({ id: otherId }));
    assert.equal(value.sourceUrl, 'https://codex-reset.com/assets/hash-b/home-countdown.js');
    assert.equal(env.calls.length, 8);
    env.setTime(120001); assert.equal(await env.adapter.deadlineFor(signal()), null); assert.equal(env.calls.length, 8);
    const retry = setup(ResetAnnouncement, publicFiles());
    assert.ok(await retry.adapter.deadlineFor(signal())); retry.files.set(PAGE, 'temporary broken page'); retry.setTime(120000);
    assert.equal(await retry.adapter.deadlineFor(signal({ id: otherId })), null);
    assert.ok(await retry.adapter.deadlineFor(signal())); assert.equal(retry.calls.length, 5);
  });

  test(`${variant}: request AbortSignal is forwarded and canceled discovery cannot populate the cache`, async () => {
    const files = publicFiles(), controller = new AbortController();
    const env = setup(ResetAnnouncement, files, async (url, options) => {
      assert.equal(options.signal, controller.signal);
      if (url.endsWith('home-countdown.js')) controller.abort();
      return files.get(url);
    });
    assert.equal(await env.adapter.deadlineFor(signal({ signal: controller.signal })), null);
    assert.equal(env.calls.length, 4);
    assert.equal(await env.adapter.deadlineFor(signal()), null); assert.equal(env.calls.length, 4);
    env.setTime(120000);
    const next = new AbortController();
    const recovered = setup(ResetAnnouncement, files);
    assert.ok(await recovered.adapter.deadlineFor(signal({ signal: next.signal })));
    assert.ok(recovered.calls.every(call => call.options.signal === next.signal));
    const aborted = new AbortController(); aborted.abort();
    assert.equal(await recovered.adapter.deadlineFor(signal({ signal: aborted.signal })), null);
    assert.equal(recovered.calls.length, 4);
  });

  test(`${variant}: concurrent callers share discovery and unknown IDs never inherit another deadline`, async () => {
    const env = setup(ResetAnnouncement);
    const [first, second] = await Promise.all([env.adapter.deadlineFor(signal()), env.adapter.deadlineFor(signal())]);
    assert.deepEqual(first, second); assert.equal(env.calls.length, 4);
    first.quote = 'mutated'; assert.equal((await env.adapter.deadlineFor(signal())).quote, 'Lands before the announced target');
    assert.equal(await env.adapter.deadlineFor(signal({ id: '987654321098765' })), null);
    assert.equal(env.calls.length, 4);
  });

  test(`${variant}: missing or irregular imports fail quietly and retry no faster than two minutes`, async () => {
    const env = setup(ResetAnnouncement, publicFiles('hash-a', iso(1000), { app: 'export const changedLayout = true;' }));
    assert.equal(await env.adapter.deadlineFor(signal()), null); assert.equal(env.calls.length, 2);
    env.setTime(119999); assert.equal(await env.adapter.deadlineFor(signal()), null); assert.equal(env.calls.length, 2);
    env.setTime(120000); assert.equal(await env.adapter.deadlineFor(signal()), null); assert.equal(env.calls.length, 4);
  });

  test(`${variant}: network/abort/nontext failures are isolated and later discovery recovers`, async () => {
    for (const failure of [new Error('fixture offline'), Object.assign(new Error('aborted'), { name: 'AbortError' }), false, { text: 'not a string' }]) {
      let failed = true;
      const files = publicFiles(), env = setup(ResetAnnouncement, files, async url => {
        if (failed) { if (failure instanceof Error) throw failure; return failure; }
        return files.get(url);
      });
      assert.equal(await env.adapter.deadlineFor(signal()), null); assert.equal(env.calls.length, 1);
      failed = false; env.setTime(120000);
      assert.ok(await env.adapter.deadlineFor(signal())); assert.equal(env.calls.length, 5);
    }
    assert.equal(await new ResetAnnouncement({ now: () => EPOCH }).deadlineFor(signal()), null);
  });

  test(`${variant}: expired metadata is discarded after a failed refresh`, async () => {
    const files = publicFiles(), env = setup(ResetAnnouncement, files);
    assert.ok(await env.adapter.deadlineFor(signal()));
    files.set(PAGE, 'changed document without a module'); env.setTime(1800000);
    assert.equal(await env.adapter.deadlineFor(signal()), null);
    env.setTime(1800001); assert.equal(await env.adapter.deadlineFor(signal()), null);
    assert.equal(env.calls.length, 5);
  });

  test(`${variant}: only the exact matching, past announcement and a zero-to-24h target are accepted`, async () => {
    const env = setup(ResetAnnouncement);
    for (const input of [undefined, {}, signal({ id: false }), signal({ id: '../' + ID }), signal({ id: '1234' }),
      signal({ at: iso(1) }), signal({ at: 'bad' }), signal({ at: '2026-02-30T14:00:00Z' })]) {
      assert.equal(await env.adapter.deadlineFor(input), null);
    }
    assert.equal(env.calls.length, 0);
    for (const [deadline, at, allowed] of [[iso(-1), iso(-60000), true], [iso(0), iso(0), true],
      [iso(24 * 3600000), iso(0), true], [iso(24 * 3600000 + 1), iso(0), false], [iso(-60001), iso(-60000), false]]) {
      const check = setup(ResetAnnouncement, publicFiles('hash-a', deadline));
      assert.equal(!!(await check.adapter.deadlineFor(signal({ at }))), allowed);
    }
  });

  test(`${variant}: already reached target remains available as observation without inventing a new window`, async () => {
    const env = setup(ResetAnnouncement, publicFiles('hash-a', iso(-1000)));
    const value = await env.adapter.deadlineFor(signal());
    assert.equal(value.deadlineAt, iso(-1000)); assert.equal(value.kind, 'observation');
    assert.equal(Object.hasOwn(value, 'confirmed'), false);
  });

  test(`${variant}: cross-origin, credentials, redirects, queries and unexpected paths are never requested`, async () => {
    const targets = ['http://codex-reset.com/assets/hash-a/app.js', 'https://evil.invalid/assets/hash-a/app.js',
      'https://codex-reset.com:8443/assets/hash-a/app.js', 'https://u:p@codex-reset.com/assets/hash-a/app.js',
      '/assets/hash-a/app.js?next=other', '/assets/hash-a/app.js#data', '/not-assets/hash-a/app.js',
      '/assets/hash-a/app.js/extra', '/assets/hash-a/app.js\\evil'];
    for (const target of targets) {
      const env = setup(ResetAnnouncement, publicFiles('hash-a', iso(1000), { page: `<script type="module" src="${target}"></script>` }));
      assert.equal(await env.adapter.deadlineFor(signal()), null); assert.equal(env.calls.length, 1);
    }
    const env = setup(ResetAnnouncement, publicFiles('hash-a', iso(1000), { app: 'await import("https://evil.invalid/assets/hash-a/home.js")' }));
    assert.equal(await env.adapter.deadlineFor(signal()), null); assert.equal(env.calls.length, 2);
  });

  test(`${variant}: asset traversal and directory changes cannot broaden the import chain`, async () => {
    for (const home of ['../another/home.js', '/assets/hash-b/home.js', './home.js?fresh=1']) {
      const env = setup(ResetAnnouncement, publicFiles('hash-a', iso(1000), { app: `await import(${JSON.stringify(home)})` }));
      assert.equal(await env.adapter.deadlineFor(signal()), null); assert.equal(env.calls.length, 2);
    }
    const env = setup(ResetAnnouncement, publicFiles('hash-a', iso(1000), { home: 'import { createHomeCountdown } from "../other/home-countdown.js";' }));
    assert.equal(await env.adapter.deadlineFor(signal()), null); assert.equal(env.calls.length, 3);
  });

  test(`${variant}: ambiguous entry scripts and import declarations do not pick arbitrary resources`, async () => {
    const extra = '<script type="module" src="/assets/hash-b/app.js"></script>';
    const files = publicFiles(); files.set(PAGE, files.get(PAGE) + extra);
    const env = setup(ResetAnnouncement, files);
    assert.equal(await env.adapter.deadlineFor(signal()), null); assert.equal(env.calls.length, 1);
    const check = setup(ResetAnnouncement, publicFiles('hash-a', iso(1000), { app: 'await import("./home.js"); await import("/assets/hash-b/home.js");' }));
    assert.equal(await check.adapter.deadlineFor(signal()), null); assert.equal(check.calls.length, 2);
  });

  test(`${variant}: quoted and commented lookalike imports/assignments are ignored`, async () => {
    for (const app of ['// await import("./home.js");', 'const decoy = \'import("./home.js")\';', 'const decoy = `import("./home.js")`;']) {
      const env = setup(ResetAnnouncement, publicFiles('hash-a', iso(1000), { app }));
      assert.equal(await env.adapter.deadlineFor(signal()), null); assert.equal(env.calls.length, 2);
    }
    const files = publicFiles(), script = [...files.keys()].at(-1);
    files.set(script, '/*' + files.get(script) + '*/');
    assert.equal(await setup(ResetAnnouncement, files).adapter.deadlineFor(signal()), null);
    const page = '<!-- <script type="module" src="/assets/decoy/app.js"></script> -->';
    const accepted = publicFiles(); accepted.set(PAGE, page + accepted.get(PAGE));
    assert.ok(await setup(ResetAnnouncement, accepted).adapter.deadlineFor(signal()));
  });

  test(`${variant}: JSON expressions, getters and malformed source never execute or supply a deadline`, async () => {
    const attacks = [
      `export const OBSERVATION_DEADLINES = Object.freeze({"${ID}": (() => { throw new Error('must not run'); })()});`,
      `export const OBSERVATION_DEADLINES = Object.freeze({get "${ID}"() { throw new Error('must not run'); }});`,
      `export const OBSERVATION_DEADLINES = Object.freeze({'${ID}':'${iso(1000)}'});`,
      'export const OBSERVATION_DEADLINES = Object.freeze({',
    ];
    for (const countdown of attacks) {
      const env = setup(ResetAnnouncement, publicFiles('hash-a', iso(1000), { countdown }));
      assert.equal(await env.adapter.deadlineFor(signal()), null);
    }
    const files = publicFiles(), script = [...files.keys()].at(-1);
    files.set(script, files.get(script) + '\nthrow new Error("Never execute public JS");');
    assert.ok(await setup(ResetAnnouncement, files).adapter.deadlineFor(signal()));
  });

  test(`${variant}: missing/duplicate JSON exports and invalid reply or quote data return null`, async () => {
    const scriptFor = (deadlines, quotes) => `export const OBSERVATION_DEADLINES = Object.freeze(${JSON.stringify(deadlines)});\nexport const OBSERVATION_QUOTES = Object.freeze(${JSON.stringify(quotes)});`;
    const cases = [scriptFor([], {}), scriptFor({ [ID]: '2026-02-30T00:00:00Z' }, {}),
      scriptFor({ [ID]: iso(1000) }, {}),
      ...[null, false, { text: 'quote', source_id: 'not-numeric' }, { text: 'quote', source_id: 12345678 }, { text: 'x'.repeat(281), source_id: REPLY },
        { text: ' ', source_id: REPLY }, { text: 'bad\u0000quote', source_id: REPLY }].map(quote => scriptFor({ [ID]: iso(1000) }, { [ID]: quote }))];
    const normal = publicFiles(), normalScript = normal.get([...normal.keys()].at(-1));
    cases.push(normalScript + '\n' + normalScript, normalScript.replace('OBSERVATION_QUOTES', 'CHANGED_NAME'));
    for (const countdown of cases) assert.equal(await setup(ResetAnnouncement, publicFiles('hash-a', iso(1000), { countdown })).adapter.deadlineFor(signal()), null);
  });

  test(`${variant}: every resource and JSON source has a 256KiB UTF-8 bound`, async () => {
    for (const key of ['page', 'app', 'home', 'countdown']) for (const oversized of [' '.repeat(256 * 1024 + 1), '中'.repeat(100000)]) {
      const env = setup(ResetAnnouncement, publicFiles('hash-a', iso(1000), { [key]: oversized }));
      assert.equal(await env.adapter.deadlineFor(signal()), null);
      assert.equal(env.calls.length, ['page', 'app', 'home', 'countdown'].indexOf(key) + 1);
    }
  });
}
