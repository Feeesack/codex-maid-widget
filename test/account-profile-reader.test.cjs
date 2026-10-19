'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const KEY = 'a'.repeat(64), OTHER_KEY = 'b'.repeat(64), SCOPE = 'fixture-workspace';
const TOKEN = 'fixture-access-token-value';
const PROFILE = 'https://chatgpt.com/backend-api/wham/profiles/me';
const ACCOUNTS = 'https://chatgpt.com/backend-api/wham/accounts/check';
const EMPTY = { profileNickname: null, workspaceName: null };
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });

for (const variant of ['', 'macos']) {
  const { AccountProfileReader } = require(path.join(__dirname, '..', variant, 'src/account-profile-reader.cjs'));
  const title = `${variant || 'Windows'} profile reader`;
  function fixture(t, options = {}) {
    // Constructor and all reads have an explicit isolated home and filesystem;
    // the fixture never loads an auth/data-home helper or the host's profile.
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'maid-profile-reader-isolated-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const file = path.join(directory, 'auth.json');
    const write = (tokens = {}) => fs.writeFileSync(file, JSON.stringify({ tokens: { access_token: TOKEN, account_id: SCOPE, ...tokens } }));
    write();
    const calls = [];
    const fetcher = options.fetch || (async (url, init) => {
      calls.push({ url, init });
      return url === PROFILE ? json({ profile: { display_name: 'Fixture Nickname', username: 'fixture-handle' } }) :
        json({ accounts: [{ id: SCOPE, structure: 'workspace', name: 'Fixture Team' }] });
    });
    const reader = new AccountProfileReader({ codexHome: directory, filesystem: fsp, fetch: fetcher, ...options });
    t.after(() => reader.close());
    return { directory, file, write, calls, reader };
  }

  test(`${title}: construction is inert and requires an explicit home`, () => {
    assert.throws(() => new AccountProfileReader(), TypeError);
    let reads = 0;
    const reader = new AccountProfileReader({ codexHome: path.join(os.tmpdir(), 'unused-isolated-fixture'),
      filesystem: { lstat: async () => { reads++; throw Error('not used'); }, open: async () => { reads++; throw Error('not used'); } },
      fetch: async () => { throw Error('not used'); } });
    assert.equal(reads, 0); reader.close();
  });

  test(`${title}: reads only fixed official GET endpoints and returns a nickname projection`, async t => {
    const { reader, file, calls } = fixture(t);
    const before = fs.readFileSync(file);
    const result = await reader.read({ key: KEY, scopeId: SCOPE, email: 'fixture@example.test' });
    assert.deepEqual(result, { profileNickname: 'Fixture Nickname', workspaceName: 'Fixture Team' });
    assert.deepEqual(calls.map(call => call.url).sort(), [PROFILE, ACCOUNTS].sort());
    for (const { init } of calls) {
      assert.equal(init.method, 'GET'); assert.equal(init.redirect, 'error'); assert.equal(init.credentials, 'omit');
      assert.equal(init.headers.Authorization, `Bearer ${TOKEN}`);
      assert.equal(init.headers['ChatGPT-Account-ID'], SCOPE);
    }
    assert.deepEqual(fs.readFileSync(file), before);
    assert.doesNotMatch(JSON.stringify(result), /fixture-access|fixture-handle|fixture-workspace|auth|token|account_id/);
    assert.doesNotMatch(JSON.stringify(reader.cached), /fixture-access|fixture-handle|access_token|refresh_token|id_token/);
    assert.equal(Object.keys(result).length, 2);
  });

  test(`${title}: cache binds the credential stamp, key and scope and expires without retaining credentials`, async t => {
    let now = 1000;
    const { reader, calls, write } = fixture(t, { now: () => now });
    await reader.read({ key: KEY, scopeId: SCOPE });
    await reader.read({ key: KEY, scopeId: SCOPE });
    assert.equal(calls.length, 2);
    now += 5 * 60 * 1000;
    await reader.read({ key: KEY, scopeId: SCOPE });
    assert.equal(calls.length, 4);
    await reader.read({ key: OTHER_KEY, scopeId: SCOPE });
    assert.equal(calls.length, 6);
    write({ access_token: 'fixture-replaced-access-token' });
    await reader.read({ key: OTHER_KEY, scopeId: SCOPE });
    assert.equal(calls.length, 8);
    assert.deepEqual(await reader.read({ key: OTHER_KEY, scopeId: 'other-fixture-scope' }), EMPTY);
    assert.equal(calls.length, 8);
    reader.invalidate();
    await reader.read({ key: KEY, scopeId: SCOPE });
    assert.equal(calls.length, 10);
  });

  test(`${title}: missing scope, credentials or access token never fall back to other token fields`, async t => {
    const { reader, calls, file, write } = fixture(t);
    for (const input of [{ key: KEY }, { scopeId: SCOPE }, { key: 'raw-email@example.test', scopeId: SCOPE }, { key: KEY, scopeId: 'https://other.test' }]) {
      assert.deepEqual(await reader.read(input), EMPTY);
    }
    assert.equal(calls.length, 0);
    for (const tokens of [{ account_id: undefined }, { account_id: 'wrong-fixture-scope' },
      { access_token: undefined, refresh_token: TOKEN, id_token: TOKEN }, { access_token: 'Bearer injected\nheader' }]) {
      write(tokens); reader.invalidate();
      assert.deepEqual(await reader.read({ key: KEY, scopeId: SCOPE }), EMPTY);
    }
    fs.unlinkSync(file); reader.invalidate();
    assert.deepEqual(await reader.read({ key: KEY, scopeId: SCOPE }), EMPTY);
    assert.equal(calls.length, 0);
  });

  test(`${title}: symlinks, oversized files and a changed file identity fail closed before HTTP`, async t => {
    const { file, calls, reader } = fixture(t);
    fs.writeFileSync(file, Buffer.alloc(1024 * 1024 + 1));
    assert.deepEqual(await reader.read({ key: KEY, scopeId: SCOPE }), EMPTY);
    assert.equal(calls.length, 0);
    const fake = new AccountProfileReader({ codexHome: path.dirname(file), filesystem: {
      lstat: async () => ({ isFile: () => true, isSymbolicLink: () => true, size: 10 }),
      open: async () => { throw Error('must not open a link'); },
    }, fetch: async () => { throw Error('must not request'); } });
    assert.deepEqual(await fake.read({ key: KEY, scopeId: SCOPE }), EMPTY); fake.close();
    fs.writeFileSync(file, JSON.stringify({ tokens: { access_token: TOKEN, account_id: SCOPE } }));
    let opened = false;
    const replaced = new AccountProfileReader({ codexHome: path.dirname(file), filesystem: {
      lstat: fsp.lstat.bind(fsp), open: async (...args) => {
        opened = true; const handle = await fsp.open(...args); const originalStat = handle.stat.bind(handle);
        handle.stat = async () => { const value = await originalStat(); value.ino += 1; return value; };
        return handle;
      },
    }, fetch: async () => { throw Error('must not request'); } });
    assert.deepEqual(await replaced.read({ key: KEY, scopeId: SCOPE }), EMPTY); assert.equal(opened, true); replaced.close();
  });

  test(`${title}: redirects, oversized and malformed responses are ignored without exposing server errors`, async t => {
    const cases = [
      async () => new Response('private-fixture-error', { status: 403 }),
      async () => ({ ok: true, redirected: true, body: new ReadableStream(), url: 'https://other.test' }),
      async () => ({ ok: true, redirected: false, body: new ReadableStream(), url: 'https://other.test' }),
      async () => new Response('x', { headers: { 'content-length': String(1024 * 1024 + 1) } }),
      async () => new Response('x'.repeat(1024 * 1024 + 1)),
      async () => new Response('{ damaged'),
      async () => { throw Error(`private-fixture-error-${TOKEN}`); },
    ];
    for (const fetcher of cases) {
      const { reader } = fixture(t, { fetch: fetcher });
      assert.deepEqual(await reader.read({ key: KEY, scopeId: SCOPE }), EMPTY);
    }
  });

  test(`${title}: concurrent requests share one lookup and both responses must remain credential-bound`, async t => {
    let requests = 0;
    const { reader, file } = fixture(t, { fetch: async url => {
      requests++; await new Promise(resolve => setTimeout(resolve, 5));
      return url === PROFILE ? json({ profile: { display_name: 'Fixture Nickname' } }) : json({ accounts: [] });
    } });
    const values = await Promise.all([reader.read({ key: KEY, scopeId: SCOPE }), reader.read({ key: KEY, scopeId: SCOPE })]);
    assert.equal(requests, 2); assert.equal(values[0].profileNickname, 'Fixture Nickname');
    assert.deepEqual(values[0], values[1]);
    reader.invalidate();
    const changed = fixture(t, { fetch: async url => {
      fs.writeFileSync(file, JSON.stringify({ tokens: { access_token: 'fixture-different-token', account_id: SCOPE } }));
      return url === PROFILE ? json({ profile: { display_name: 'Must Not Cross Credentials' } }) : json({ accounts: [] });
    } });
    // Bind this separate reader to the changed fixture's own credentials.
    const changedFile = changed.file;
    changed.reader.fetcher = async url => {
      fs.writeFileSync(changedFile, JSON.stringify({ tokens: { access_token: 'fixture-different-token', account_id: SCOPE } }));
      return url === PROFILE ? json({ profile: { display_name: 'Must Not Cross Credentials' } }) : json({ accounts: [] });
    };
    assert.deepEqual(await changed.reader.read({ key: KEY, scopeId: SCOPE }), EMPTY);
  });

  test(`${title}: timeout and invalidation drop late results even if a transport ignores abort`, async t => {
    let release;
    const pending = new Promise(resolve => { release = resolve; });
    const { reader } = fixture(t, { timeoutMs: 15, fetch: async () => pending });
    const start = Date.now();
    assert.deepEqual(await reader.read({ key: KEY, scopeId: SCOPE }), EMPTY);
    assert.equal(Date.now() - start < 500, true);
    release(json({ profile: { display_name: 'Late Fixture Nickname' } }));
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(reader.cached, null);
    reader.close();
    assert.deepEqual(await reader.read({ key: KEY, scopeId: SCOPE }), EMPTY);
    const next = fixture(t, { fetch: async () => new Promise(() => {}) });
    const lookup = next.reader.read({ key: KEY, scopeId: SCOPE });
    await new Promise(resolve => setTimeout(resolve, 5));
    next.reader.invalidate();
    assert.deepEqual(await lookup, EMPTY);
  });

  test(`${title}: the total deadline and invalidation also wake a hanging initial filesystem lookup`, async t => {
    const { directory } = fixture(t);
    const hungFilesystem = { lstat: async () => new Promise(() => {}), open: async () => { throw Error('must not open'); } };
    const timed = new AccountProfileReader({ codexHome: directory, filesystem: hungFilesystem, timeoutMs: 10,
      fetch: async () => { throw Error('must not fetch'); } });
    const start = Date.now();
    assert.deepEqual(await timed.read({ key: KEY, scopeId: SCOPE }), EMPTY);
    assert.equal(Date.now() - start < 500, true); timed.close();
    for (const action of ['invalidate', 'close']) {
      const reader = new AccountProfileReader({ codexHome: directory, filesystem: hungFilesystem,
        fetch: async () => { throw Error('must not fetch'); } });
      const pending = reader.read({ key: KEY, scopeId: SCOPE });
      reader[action]();
      assert.deepEqual(await pending, EMPTY); reader.close();
    }
  });

  test(`${title}: a retired scope's late filesystem error cannot erase a newer scope cache`, async t => {
    const { directory } = fixture(t);
    let rejectOld, reads = 0;
    const reader = new AccountProfileReader({ codexHome: directory, filesystem: {
      lstat: async (...args) => { reads++; return reads === 1 ? new Promise((_, reject) => { rejectOld = reject; }) : fsp.lstat(...args); },
      open: fsp.open.bind(fsp),
    }, fetch: async url => url === PROFILE ? json({ profile: { display_name: 'New Scope Fixture Nickname' } }) : json({ accounts: [] }) });
    const old = reader.read({ key: OTHER_KEY, scopeId: SCOPE });
    const fresh = await reader.read({ key: KEY, scopeId: SCOPE });
    assert.equal(fresh.profileNickname, 'New Scope Fixture Nickname');
    const cached = reader.cached;
    rejectOld(Error('retired fixture lookup')); await old;
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(reader.cached, cached); reader.close();
  });
}
