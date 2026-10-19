'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createHash } = require('node:crypto');

const now = new Date('2026-10-19T04:00:00Z');
const limits = { rateLimits: { limitId: 'codex', primary: { usedPercent: 40, windowDurationMins: 300, resetsAt: now.getTime() / 1000 + 3600 } } };
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

for (const variant of ['', 'macos']) {
  const { CodexDataSource, normalizeAccount } = require(path.join(__dirname, '..', variant, 'src/codex-data.cjs'));
  const label = variant || 'Windows';
  function fixture(extra = {}) {
    let account = { type: 'chatgpt', email: 'fixture-person@example.test', planType: 'pro', ...extra };
    let routing = {}, readAccount, readLimits, readProfile, connectError;
    const profileCalls = [];
    const source = new CodexDataSource({
      codexHome: path.join(__dirname, '..', 'tmp', 'isolated-account-presentation', label),
      now: () => now,
      profileReader: {
        async read(input) { profileCalls.push(input); return readProfile ? readProfile(input) : {}; },
        invalidate() {}, close() {},
      },
      // Inject both the local reader and server: no environment-only isolation,
      // data-home resolution, authentication files or real Codex process exists.
      localReader: { read: async () => ({ today: null, weekly: null, lastTurn: null }) },
      server: {
        async connect() { if (connectError) throw connectError; }, disconnect() {}, close() {},
        async request(method, params) {
          if (method === 'account/read') {
            assert.equal(params.refreshToken, false);
            return readAccount ? readAccount() : { account, workspaceRouting: routing };
          }
          assert.equal(method, 'account/rateLimits/read');
          return readLimits ? readLimits() : limits;
        },
      },
    });
    return { source,
      account(value) { account = value; }, routing(value) { routing = value; },
      readAccount(value) { readAccount = value; }, readLimits(value) { readLimits = value; },
      readProfile(value) { readProfile = value; }, profileCalls,
      connectError(value) { connectError = value; },
    };
  }

  test(`${label}: presentation is private, short text and available only after live quota`, async t => {
    const f = fixture({ displayName: ' \u202e小林\n\0 ', email: 'person@example.test', workspaceName: ' \u2066工程组\u2069 ' });
    t.after(() => f.source.close());
    assert.equal(f.source.accountPresentation, null);
    const snapshot = await f.source.read(), presentation = f.source.accountPresentation;
    assert.equal(snapshot.status, 'live');
    assert.deepEqual(presentation, { key: f.source.accountIdentity, generation: snapshot.generation,
      profileNickname: null, displayName: '小林', email: 'person@example.test', workspaceName: '工程组' });
    assert.deepEqual(snapshot.account, { planType: 'pro', authMode: 'chatgpt' });
    assert.deepEqual(normalizeAccount({ account: { name: 'No public name', email: 'person@example.test', planType: 'pro', type: 'chatgpt' } }), snapshot.account);
    assert.equal(Object.hasOwn(snapshot, 'accountPresentation'), false);
    assert.equal(Object.prototype.propertyIsEnumerable.call(f.source, 'accountPresentation'), false);
    assert.doesNotMatch(JSON.stringify(snapshot), /person@example|小林|工程组|[a-f0-9]{64}/);
    assert.doesNotMatch(JSON.stringify(f.source), /person@example|小林|工程组/);
  });

  test(`${label}: profile nickname is explicit, scoped and private; account names remain auxiliary`, async t => {
    const f = fixture({ name: 'Account Name' }); t.after(() => f.source.close());
    f.routing({ chatgptAccountId: 'fixture-scope' });
    f.readProfile(async () => ({ profileNickname: 'Profile Nickname', workspaceName: 'Profile Workspace' }));
    const snapshot = await f.source.read();
    assert.equal(f.source.accountPresentation.profileNickname, 'Profile Nickname');
    assert.equal(f.source.accountPresentation.displayName, 'Account Name');
    assert.equal(f.source.accountPresentation.workspaceName, 'Profile Workspace');
    assert.deepEqual(f.profileCalls[0], { key: f.source.accountIdentity, scopeId: 'fixture-scope', email: 'fixture-person@example.test' });
    assert.equal(Object.prototype.propertyIsEnumerable.call(f.source, 'accountProfileReader'), false);
    assert.doesNotMatch(JSON.stringify(snapshot), /Profile Nickname|Profile Workspace|fixture-person/);
    f.readProfile(async () => { throw new Error('Synthetic unavailable metadata'); });
    assert.equal((await f.source.read()).status, 'live');
    assert.equal(f.source.accountPresentation.profileNickname, null);
    assert.equal(f.source.accountPresentation.displayName, 'Account Name');
  });

  test(`${label}: an invalidated pending profile cannot label the next account`, async t => {
    const f = fixture(); t.after(() => f.source.close());
    const pending = deferred(), started = deferred();
    f.readProfile(() => { started.resolve(); return pending.promise; });
    const oldRead = f.source.read(); await started.promise;
    f.source.invalidate();
    f.account({ type: 'chatgpt', email: 'next@example.test', planType: 'team' });
    f.readProfile(async () => ({ profileNickname: 'Next Nickname', workspaceName: 'Next Team' }));
    await f.source.read(); const current = f.source.accountPresentation;
    pending.resolve({ profileNickname: 'Stale Nickname', workspaceName: 'Stale Team' });
    assert.equal((await oldRead).invalidated, true);
    assert.equal(f.source.accountPresentation, current);
    assert.equal(current.profileNickname, 'Next Nickname');
  });

  test(`${label}: auxiliary email never invents a nickname or workspace name and does not change account keys`, async t => {
    const f = fixture({ email: 'fixture-person@example.test', workspaceId: 'synthetic-workspace-id' });
    t.after(() => f.source.close());
    f.routing({ chatgptAccountId: 'synthetic-routing-id', backendOrigin: 'synthetic-origin' });
    await f.source.read();
    const expected = createHash('sha256').update(JSON.stringify(['chatgpt', 'fixture-person@example.test', 'pro', 'synthetic-workspace-id'])).digest('hex');
    assert.equal(f.source.accountIdentity, expected, 'Naming must preserve the existing fingerprint algorithm');
    assert.equal(f.source.accountPresentation.displayName, null);
    assert.equal(f.source.accountPresentation.profileNickname, null);
    assert.equal(f.source.accountPresentation.email, 'fixture-person@example.test');
    assert.equal(f.source.accountPresentation.workspaceName, null);
    f.routing({ chatgptAccountId: 'another-routing-id', workspaceName: 'Remote team' });
    await f.source.read();
    assert.equal(f.source.accountIdentity, expected);
    assert.equal(f.source.accountPresentation.workspaceName, 'Remote team');
  });

  test(`${label}: only explicit text name fields can become presentation`, async t => {
    const f = fixture({ displayName: {}, name: 'Future User', workspaceName: ['Not text'], workspace: { name: 'Future Workspace' } });
    t.after(() => f.source.close());
    await f.source.read();
    assert.equal(f.source.accountPresentation.displayName, 'Future User');
    assert.equal(f.source.accountPresentation.workspaceName, 'Future Workspace');
    for (const value of [123, false, {}, [], null, 'x'.repeat(121)]) {
      f.account({ type: 'chatgpt', accountId: 'synthetic-account', planType: 'pro', displayName: value, email: value, workspaceName: value });
      await f.source.read();
      assert.equal(f.source.accountPresentation.displayName, null);
      assert.equal(f.source.accountPresentation.email, null);
      assert.equal(f.source.accountPresentation.workspaceName, null);
    }
  });

  test(`${label}: full valid email addresses remain auxiliary metadata rather than nicknames`, async t => {
    const email = 'a'.repeat(48) + '@example.test';
    const f = fixture({email}); t.after(() => f.source.close());
    const snapshot = await f.source.read();
    assert.equal(f.source.accountPresentation.email,email);
    assert.equal(f.source.accountPresentation.displayName,null);
    assert.equal(f.source.accountPresentation.profileNickname,null);
    assert.doesNotMatch(JSON.stringify(snapshot), /example\.test|[a]{48}/);
  });
  test(`${label}: credentials, invalid email and unbounded text cannot enter name fields`, async t => {
    const f = fixture({ accountId: 'synthetic-account' }); t.after(() => f.source.close());
    const rejected = ['Bearer synthetic-value', 'sk-proj-' + 'q'.repeat(40),
      'eyJhbGciOiJIUzI1NiJ9.c3ludGhldGljcGF5bG9hZA.c3ludGhldGljc2lnbmF0dXJl',
      'access_token=synthetic', 'refresh-token: synthetic', 'A'.repeat(60), 'b'.repeat(64), 'x'.repeat(513)];
    for (const value of rejected) {
      f.account({ type: 'chatgpt', accountId: 'synthetic-account', planType: 'pro', displayName: value, email: value, workspaceName: value });
      await f.source.read();
      assert.equal(f.source.accountPresentation.displayName, null);
      assert.equal(f.source.accountPresentation.email, null);
      assert.equal(f.source.accountPresentation.workspaceName, null);
    }
    f.account({ type: 'chatgpt', accountId: 'synthetic-account', email: 'not an email', name: 'User', organization: { name: 'Org' } });
    await f.source.read();
    assert.equal(f.source.accountPresentation.email, null);
    assert.equal(f.source.accountPresentation.workspaceName, 'Org');
  });

  test(`${label}: a pending quota read exposes no previous account presentation`, async t => {
    const f = fixture({ name: 'Account A' }); t.after(() => f.source.close());
    await f.source.read();
    const pending = deferred(), started = deferred();
    f.account({ type: 'chatgpt', accountId: 'account-b', email: 'b@example.test', planType: 'team', name: 'Account B' });
    f.readLimits(() => { started.resolve(); return pending.promise; });
    const reading = f.source.read(); await started.promise;
    assert.equal(f.source.accountPresentation, null);
    pending.resolve(limits); const snapshot = await reading;
    assert.equal(snapshot.accountChanged, true);
    assert.equal(f.source.accountPresentation.displayName, 'Account B');
    assert.equal(f.source.accountPresentation.key, f.source.accountIdentity);
    assert.equal(f.source.accountPresentation.generation, snapshot.generation);
  });

  for (const stage of ['connect', 'account', 'quota', 'expired-auth', 'empty-quota', 'signed-out']) {
    test(`${label}: ${stage} failure or partial result clears presentation`, async t => {
      const f = fixture({ name: 'Previous User' }); t.after(() => f.source.close());
      await f.source.read(); assert.ok(f.source.accountPresentation);
      if (stage === 'connect') f.connectError(new Error('Synthetic connect failure'));
      if (stage === 'account') f.readAccount(() => { throw new Error('Synthetic account failure'); });
      if (stage === 'quota') f.readLimits(() => { throw new Error('Synthetic quota failure'); });
      if (stage === 'expired-auth') f.readLimits(() => { throw Object.assign(new Error('Unauthorized'), { code: 'NOT_SIGNED_IN' }); });
      if (stage === 'empty-quota') f.readLimits(() => ({ rateLimitsByLimitId: {} }));
      if (stage === 'signed-out') f.account(null);
      const result = await f.source.read();
      assert.notEqual(result.status, 'live'); assert.equal(f.source.accountPresentation, null);
    });
  }

  for (const oldStage of ['account', 'quota']) for (const rejectOld of [false, true]) {
    test(`${label}: a superseded old ${oldStage} ${rejectOld ? 'failure' : 'reply'} cannot replace or clear new account presentation`, async t => {
      const f = fixture({ name: 'Initial User' }); t.after(() => f.source.close());
      await f.source.read();
      const old = deferred(), started = deferred();
      const waitForOld = () => { started.resolve(); return old.promise; };
      if (oldStage === 'account') f.readAccount(waitForOld); else f.readLimits(waitForOld);
      const oldReading = f.source.read(); await started.promise;
      f.source.invalidate(); assert.equal(f.source.accountPresentation, null);
      f.readAccount(null); f.readLimits(null);
      f.account({ type: 'chatgpt', accountId: 'new-account', email: 'new@example.test', name: 'New User', workspaceName: 'New Workspace' });
      await f.source.read(); const current = f.source.accountPresentation;
      if (rejectOld) old.reject(new Error('Synthetic late failure'));
      else old.resolve(oldStage === 'account' ? { account: { type: 'chatgpt', email: 'old@example.test', name: 'Old User' } } : limits);
      assert.equal((await oldReading).invalidated, true);
      assert.equal(f.source.accountPresentation, current); assert.equal(current.displayName, 'New User');
      assert.equal(current.workspaceName, 'New Workspace');
    });
  }

  test(`${label}: close during a pending quota read clears presentation permanently`, async () => {
    const f = fixture({ name: 'Previous User' });
    await f.source.read();
    const pending = deferred(), started = deferred();
    f.readLimits(() => { started.resolve(); return pending.promise; });
    const reading = f.source.read(); await started.promise; f.source.close();
    assert.equal(f.source.accountPresentation, null);
    pending.resolve(limits); assert.equal((await reading).invalidated, true);
    assert.equal(f.source.accountPresentation, null);
    assert.equal((await f.source.read()).status, 'offline');
    assert.equal(f.source.accountPresentation, null);
  });
}
