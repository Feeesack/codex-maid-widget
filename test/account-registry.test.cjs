'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const NOW = Date.UTC(2026, 9, 19, 0, 0, 0);
const KEY_A = 'a'.repeat(64), KEY_B = 'b'.repeat(64);
const seconds = millis => millis / 1000;
const bucket = (resetsAt, remainingPercent = 25, extra = {}) => ({
  id: 'codex', primary: { windowDurationMins: 300, remainingPercent, resetsAt, ...extra },
});

for (const source of ['../src/account-registry.cjs', '../macos/src/account-registry.cjs']) {
  const { AccountRegistry } = require(source);
  const title = `${source.includes('/macos/') ? 'macOS' : 'Windows'} account registry`;
  function fixture(t, content) {
    // Every persistence path is explicit and isolated; no data-home or profile
    // helper is loaded, and no authentication or rollout fixtures are needed.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maid-account-registry-isolated-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'accounts.json');
    if (content !== undefined) fs.writeFileSync(file, content);
    let now = NOW;
    return { dir, file, setNow: value => { now = value; }, registry: new AccountRegistry({ file, now: () => now }) };
  }

  test(`${title}: requires an explicit local file and millisecond clock`, t => {
    assert.throws(() => new AccountRegistry(), TypeError);
    const { registry } = fixture(t);
    assert.throws(() => registry.snapshot(null, NaN), TypeError);
    assert.throws(() => registry.snapshot(null, -1), TypeError);
    assert.equal(registry.snapshot().count, 0);
  });

  test(`${title}: stores only fingerprint and safe local fields`, t => {
    const { registry, file } = fixture(t);
    assert.equal(registry.observe({ key: 'private@example.test', buckets: [] }), false);
    assert.equal(fs.existsSync(file), false);
    assert.equal(registry.observe({ key: KEY_A.toUpperCase(), planType: 'Pro', accountId: 'private-id',
      email: 'private@example.test', token: 'private-token', buckets: [bucket(seconds(NOW) + 7200)] }), true);
    registry.observe({ key: KEY_A, buckets: [bucket(seconds(NOW) + 7200, 19)] });
    const snapshot = registry.snapshot(KEY_A);
    assert.equal(snapshot.count, 1);
    assert.equal(snapshot.accounts[0].current, true);
    assert.equal(snapshot.accounts[0].label, '昵称未读取 1 · 个人');
    assert.equal(snapshot.accounts[0].planType, 'pro');
    assert.equal(snapshot.accounts[0].planLabel, 'Pro');
    assert.equal(snapshot.accounts[0].scopeLabel, '个人');
    assert.equal(snapshot.accounts[0].remainingPercent, 19);
    assert.equal(JSON.stringify(snapshot).includes(KEY_A), false);
    const stored = fs.readFileSync(file, 'utf8');
    for (const value of ['private@example.test', 'private-id', 'private-token', 'accountId']) assert.equal(stored.includes(value), false);
    assert.equal(JSON.parse(stored).accounts[0].email, null, 'Unbound top-level email must never be retained');
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ['accounts.json']);
  });

  test(`${title}: rejects stale, failed and superseded observations`, t => {
    const { registry, file } = fixture(t);
    for (const extra of [{ status: 'offline' }, { status: 'partial' }, { stale: true }, { error: 'offline' }, { invalidated: true }]) {
      assert.equal(registry.observe({ key: KEY_A, buckets: [bucket(seconds(NOW) + 20)], ...extra }), false);
    }
    assert.equal(registry.snapshot().count, 0);
    assert.equal(fs.existsSync(file), false);
    assert.equal(registry.observe({ key: KEY_A, status: 'live', buckets: [] }), true);
  });

  test(`${title}: one login's separately fingerprinted personal and workspace scopes retain independent quotas`, t => {
    const { registry, file } = fixture(t);
    // The source hashes the complete login + plan + available workspace scope.
    // A shared prefix here emphasizes that registry must compare the full key.
    const personalKey = 'c'.repeat(63) + '1', workspaceKey = 'c'.repeat(63) + '2';
    const personalReset = seconds(NOW) + 30, workspaceReset = seconds(NOW) + 60;
    registry.observe({ key: personalKey, planType: 'pro', buckets: [bucket(personalReset, 12)] });
    registry.observe({ key: workspaceKey, planType: 'team', buckets: [bucket(workspaceReset, 80)] });
    let accounts = registry.snapshot(workspaceKey).accounts;
    assert.equal(accounts.length, 2);
    assert.deepEqual(accounts.map(account => [account.planType, account.scopeLabel, account.remainingPercent, account.current]),
      [['pro', '个人', 12, false], ['team', '工作空间', 80, true]]);
    assert.deepEqual(registry.due(NOW + 30000).map(account => account.id), ['account-1']);
    const restarted = new AccountRegistry({ file, now: () => NOW + 45000 });
    accounts = restarted.snapshot(personalKey).accounts;
    assert.equal(accounts[0].status, 'awaiting-confirmation');
    assert.equal(accounts[1].status, 'countdown');
    assert.equal(accounts[1].remainingPercent, 80);
    assert.deepEqual(restarted.due(NOW + 60000).map(account => account.id), ['account-2']);
    assert.deepEqual(restarted.due(NOW + 70000), []);
  });

  test(`${title}: safely retains future plan names without claiming a personal scope`, t => {
    const { registry } = fixture(t);
    registry.observe({ key: KEY_A, planType: 'pro-lite', buckets: [] });
    let account = registry.snapshot().accounts[0];
    assert.equal(account.planType, 'pro-lite');
    assert.equal(account.planLabel, '未知套餐（pro-lite）');
    assert.equal(account.scopeLabel, '未知范围');
    registry.observe({ key: KEY_B, planType: 'education', buckets: [] });
    account = registry.snapshot().accounts[1];
    assert.equal(account.planLabel, 'Education');
    assert.equal(account.scopeLabel, '工作空间');
  });

  test(`${title}: registers login without mistaking weekly or unknown windows for five hours`, t => {
    const { registry } = fixture(t);
    registry.observe({ key: KEY_A, planType: 'private@example.test', buckets: [
      bucket(seconds(NOW) + 20, 50, { windowDurationMins: 10080 }),
      { id: 'unknown', primary: { remainingPercent: 30, resetsAt: seconds(NOW) + 60 } },
    ] });
    const account = registry.snapshot().accounts[0];
    assert.equal(account.status, 'unknown');
    assert.equal(account.resetsAt, null);
    assert.equal(account.remainingPercent, null);
    assert.equal(account.elapsedPercent, null);
    assert.equal(account.planType, null);
    assert.equal(registry.nextDueAt(), null);
  });

  test(`${title}: chooses Codex and supports secondary five-hour windows deterministically`, t => {
    const { registry } = fixture(t);
    registry.observe({ key: KEY_A, buckets: [
      { id: 'model-z', primary: { windowDurationMins: 300, remainingPercent: 95, resetsAt: seconds(NOW) + 30 } },
      { id: 'codex', primary: { windowDurationMins: 10080, remainingPercent: 1, resetsAt: seconds(NOW) + 300000 },
        secondary: { windowDurationMins: 300, remainingPercent: 60, resetsAt: seconds(NOW) + 9000 } },
    ] });
    assert.equal(registry.snapshot().accounts[0].resetsAt, seconds(NOW) + 9000);
    assert.equal(registry.snapshot().accounts[0].remainingPercent, 60);
    registry.observe({ key: KEY_B, buckets: [
      { id: 'model-z', primary: { windowDurationMins: 300, usedPercent: 9, resetsAt: seconds(NOW) + 300 } },
      { id: 'model-a', primary: { windowDurationMins: 300, usedPercent: 80, resetsAt: seconds(NOW) + 600 } },
    ] });
    assert.equal(registry.snapshot().accounts[1].remainingPercent, 20);
    assert.equal(registry.snapshot().accounts[1].resetsAt, seconds(NOW) + 600);
  });

  test(`${title}: reuses only recorded deadlines and does not manufacture recurring windows`, t => {
    const { registry, setNow } = fixture(t);
    const reset = seconds(NOW) + 7200;
    registry.observe({ key: KEY_A, buckets: [bucket(reset)] });
    setNow(NOW + 1000);
    registry.observe({ key: KEY_A, buckets: [bucket(null, 10)] });
    let account = registry.snapshot().accounts[0];
    assert.equal(account.resetSource, 'estimated');
    assert.equal(account.resetsAt, reset);
    assert.equal(account.remainingPercent, 10);
    assert.equal(account.elapsedPercent > 60 && account.elapsedPercent < 61, true);
    setNow(NOW + 7200 * 1000);
    account = registry.snapshot().accounts[0];
    assert.equal(account.status, 'awaiting-confirmation');
    assert.equal(account.elapsedPercent, 100);
    assert.equal(account.remainingPercent, null);
    assert.equal(registry.due().length, 1);
    setNow(NOW + 20 * 60 * 60 * 1000);
    assert.equal(registry.due().length, 0);
    registry.observe({ key: KEY_A, buckets: [bucket(null)] });
    assert.equal(registry.snapshot().accounts[0].resetsAt, reset);
    assert.equal(registry.snapshot().accounts[0].status, 'awaiting-confirmation');
  });

  test(`${title}: never infers a fresh account deadline from percentages or invalid timestamp units`, t => {
    const { registry } = fixture(t);
    registry.observe({ key: KEY_A, buckets: [bucket(NOW + 5000, 10)] });
    assert.equal(registry.snapshot().accounts[0].resetsAt, null);
    assert.equal(registry.snapshot().accounts[0].remainingPercent, 10);
    registry.observe({ key: KEY_A, buckets: [bucket(seconds(NOW) + 7 * 3600)] });
    assert.equal(registry.snapshot().accounts[0].resetsAt, null);
    registry.observe({ key: KEY_A, buckets: [bucket(seconds(NOW) - 6 * 3600)] });
    assert.equal(registry.snapshot().accounts[0].resetsAt, null);
    registry.observe({ key: KEY_A, buckets: [bucket(seconds(NOW) + 18000)] });
    assert.equal(registry.snapshot().accounts[0].elapsedPercent, 0);
  });

  test(`${title}: due persists before delivery and survives restart with exactly-once local reminders`, t => {
    const { registry, file, setNow } = fixture(t);
    const reset = seconds(NOW) + 30;
    registry.observe({ key: KEY_A, buckets: [bucket(reset)] });
    assert.equal(registry.nextDueAt(), reset * 1000);
    assert.deepEqual(registry.due(NOW + 29999), []);
    setNow(NOW + 60000);
    const restarted = new AccountRegistry({ file, now: () => NOW + 60000 });
    assert.deepEqual(restarted.due(), [{ id: 'account-1', label: '昵称未读取 1', resetsAt: reset, estimated: true }]);
    assert.deepEqual(registry.snapshot().accounts[0].remainingPercent, null);
    assert.deepEqual(restarted.due(), []);
    assert.equal(restarted.nextDueAt(), null);
    const again = new AccountRegistry({ file, now: () => NOW + 100000 });
    assert.deepEqual(again.due(), []);
    again.observe({ key: KEY_A, buckets: [bucket(seconds(NOW) + 18000, 95)] });
    assert.equal(again.snapshot().accounts[0].remainingPercent, 95);
    assert.equal(again.due(NOW + 18000 * 1000).length, 1);
  });

  test(`${title}: never rings historical deadlines first encountered after expiry`, t => {
    const { registry, setNow } = fixture(t);
    registry.observe({ key: KEY_A, buckets: [bucket(seconds(NOW) - 20)] });
    assert.equal(registry.snapshot().accounts[0].status, 'awaiting-confirmation');
    assert.deepEqual(registry.due(), []);
    assert.equal(registry.nextDueAt(), null);
    setNow(NOW + 1000);
    registry.observe({ key: KEY_A, buckets: [bucket(seconds(NOW) - 20)] });
    assert.deepEqual(registry.due(), []);
  });

  test(`${title}: clock rollback cannot repeat consumed alarms and forward jumps consume each once`, t => {
    const { registry } = fixture(t);
    registry.observe({ key: KEY_A, buckets: [bucket(seconds(NOW) + 30)] });
    registry.observe({ key: KEY_B, buckets: [bucket(seconds(NOW) + 60)] });
    assert.equal(registry.due(NOW - 3 * 3600 * 1000).length, 0);
    assert.deepEqual(registry.due(NOW + 5 * 3600 * 1000).map(item => item.id), ['account-1', 'account-2']);
    assert.deepEqual(registry.due(NOW), []);
    assert.deepEqual(registry.due(NOW + 10 * 3600 * 1000), []);
  });

  test(`${title}: failed alarm persistence never returns events or consumes them in memory`, t => {
    const { registry, file } = fixture(t);
    const reset = seconds(NOW) + 30;
    registry.observe({ key: KEY_A, buckets: [bucket(reset)] });
    const backup = `${file}.saved`;
    fs.renameSync(file, backup);
    fs.mkdirSync(file);
    assert.throws(() => registry.due(NOW + 31000));
    assert.equal(registry.nextDueAt(), reset * 1000);
    fs.rmdirSync(file);
    fs.renameSync(backup, file);
    assert.equal(registry.due(NOW + 31000).length, 1);
    assert.equal(registry.due(NOW + 32000).length, 0);
  });

  test(`${title}: labels and removal persist without recycling local IDs`, t => {
    const { registry, file } = fixture(t);
    registry.observe({ key: KEY_A, buckets: [] });
    assert.equal(registry.rename('account-1', '  工作账号\u0000\n  '), true);
    assert.equal(registry.rename('missing', 'another'), false);
    assert.equal(registry.rename('account-1', null), false);
    assert.equal(new AccountRegistry({ file }).snapshot().accounts[0].label, '工作账号');
    assert.equal(registry.remove('account-1'), true);
    assert.equal(registry.remove('account-1'), false);
    registry.observe({ key: KEY_B, buckets: [] });
    assert.equal(registry.snapshot().accounts[0].id, 'account-2');
    assert.equal(registry.snapshot().accounts[0].label, '昵称未读取 2');
    assert.equal(registry.rename('account-2', '😀'.repeat(40)), true);
    assert.equal(Array.from(registry.snapshot().accounts[0].label).length, 32);
    registry.rename('account-2', '  ');
    assert.equal(registry.snapshot().accounts[0].label, '昵称未读取 2');
  });

  test(`${title}: only a bound canonical profile nickname produces local-only automatic labels`, t => {
    const { registry, file } = fixture(t);
    const reset = seconds(NOW) + 30;
    registry.observe({ key: KEY_A, planType: 'team', buckets: [bucket(reset)], presentation: {
      key: KEY_A, generation: 7, profileNickname: 'Feeesack', displayName: 'Fixture Account Name',
      email: 'fixture-alice@example.test', username: 'fixture-handle', workspaceName: 'Fixture Studio',
      token: 'fixture-private-token', accountId: 'fixture-raw-account-id', workspaceId: 'fixture-raw-workspace-id',
    } });
    const account = registry.snapshot(KEY_A).accounts[0];
    assert.equal(account.label, 'Feeesack · Fixture Studio');
    assert.equal(account.autoLabel, account.label);
    assert.equal(account.labelSource, 'nickname');
    assert.equal(account.userEdited, false);
    assert.equal(account.profileNickname, 'Feeesack');
    assert.equal(account.displayName, 'Fixture Account Name');
    assert.equal(account.email, 'fixture-alice@example.test');
    assert.equal(account.workspaceName, 'Fixture Studio');
    const stored = fs.readFileSync(file, 'utf8');
    for (const value of ['fixture-private-token', 'fixture-raw-account-id', 'fixture-raw-workspace-id', 'fixture-handle', 'generation', 'presentation']) {
      assert.equal(stored.includes(value), false);
    }
    for (const field of ['key', 'ordinal', 'generation', 'token', 'accountId', 'workspaceId', 'presentation']) assert.equal(field in account, false);
    assert.deepEqual(registry.due(NOW + 30000), [{ id: 'account-1', label: account.label, resetsAt: reset, estimated: true }]);
  });

  test(`${title}: account names emails and handles remain auxiliary and never substitute for a profile nickname`, t => {
    const { registry, file } = fixture(t);
    const email = 'fixture-very-long-personal-identifier@example.test';
    registry.observe({ key: KEY_A, planType: 'pro', buckets: [], presentation: {
      key: KEY_A, email, displayName: 'Fixture Account Name', accountName: 'Fixture Other Name', name: 'Fixture Name', username: 'fixture-handle',
    } });
    registry.observe({ key: KEY_B, planType: 'team', buckets: [], presentation: { key: KEY_B, profileNickname: 'Fixture Nickname' } });
    let accounts = registry.snapshot().accounts;
    assert.equal(accounts[0].label, '昵称未读取 1 · 个人');
    assert.equal(accounts[0].labelSource, 'fallback');
    assert.equal(accounts[0].profileNickname, null);
    assert.equal(accounts[0].email, email);
    assert.equal(accounts[0].displayName, 'Fixture Account Name');
    assert.equal(accounts[0].workspaceName, null);
    assert.equal(accounts[1].label, 'Fixture Nickname · 工作空间');
    assert.equal(accounts[1].workspaceName, null);
    accounts = new AccountRegistry({ file, now: () => NOW }).snapshot().accounts;
    assert.equal(accounts[0].label, '昵称未读取 1 · 个人');
    assert.equal(accounts[0].email, email);
    assert.equal(accounts[0].userEdited, false);
    assert.equal(accounts[1].label, 'Fixture Nickname · 工作空间');
    registry.observe({ key: KEY_B, planType: 'future-plan', buckets: [], presentation: { key: KEY_B, workspaceName: 'Fixture Exact Name' } });
    assert.equal(registry.snapshot().accounts[1].label, 'Fixture Nickname · Fixture Exact Name');
    registry.observe({ key: 'd'.repeat(64), planType: 'future-plan', buckets: [], presentation: { key: 'd'.repeat(64), displayName: 'Fixture Future' } });
    assert.equal(registry.snapshot().accounts[2].label, '昵称未读取 3');
  });

  test(`${title}: legacy defaults upgrade lazily while custom aliases and quota state survive`, t => {
    const base = { planType: 'pro', firstSeenAt: seconds(NOW) - 10, lastSeenAt: seconds(NOW),
      observedAt: seconds(NOW), remainingPercent: 20, confirmedResetsAt: seconds(NOW) + 100,
      resetSource: 'observed', alertedThrough: seconds(NOW) - 1000 };
    const legacy = JSON.stringify({ version: 1, nextOrdinal: 3, accounts: [
      { ...base, id: 'account-1', ordinal: 1, key: KEY_A, label: '账号 1' },
      { ...base, id: 'account-2', ordinal: 2, key: KEY_B, label: '保留的手动别名' },
    ] });
    const { registry, file } = fixture(t, legacy);
    assert.equal(fs.readFileSync(file, 'utf8'), legacy, 'Constructor migration must not write the ledger');
    let accounts = registry.snapshot().accounts;
    assert.equal(accounts[0].userEdited, false);
    assert.equal(accounts[1].userEdited, true);
    assert.equal(accounts[1].labelSource, 'manual');
    assert.equal(accounts[0].remainingPercent, 20);
    assert.equal(registry.nextDueAt(), NOW + 100000);
    registry.observe({ key: KEY_A, planType: 'pro', buckets: [], presentation: { key: KEY_A, profileNickname: 'Fixture Upgrade' } });
    registry.observe({ key: KEY_B, planType: 'pro', buckets: [], presentation: { key: KEY_B, profileNickname: 'Fixture Alias Candidate' } });
    accounts = registry.snapshot().accounts;
    assert.equal(accounts[0].label, 'Fixture Upgrade · 个人');
    assert.equal(accounts[1].label, '保留的手动别名');
    assert.equal(accounts[1].autoLabel, 'Fixture Alias Candidate · 个人');
    assert.equal(accounts[1].remainingPercent, 20);
    const persisted = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(persisted.version, 1);
    assert.equal(persisted.accounts[0].alertedThrough, base.alertedThrough);
    assert.equal(persisted.accounts[1].confirmedResetsAt, base.confirmedResetsAt);
    assert.equal(new AccountRegistry({ file, now: () => NOW }).snapshot().accounts[1].label, '保留的手动别名');
  });

  test(`${title}: version 0.3.30 automatic account-name and email labels migrate to unknown without replacing manual aliases`, t => {
    const base = { firstSeenAt: seconds(NOW) - 10, lastSeenAt: seconds(NOW), observedAt: seconds(NOW),
      remainingPercent: 20, confirmedResetsAt: seconds(NOW) + 100, resetSource: 'observed', alertedThrough: seconds(NOW) - 1000 };
    const old = JSON.stringify({ version: 1, nextOrdinal: 4, accounts: [
      { ...base, id: 'account-1', ordinal: 1, key: KEY_A, planType: 'pro', userEdited: false, labelSource: 'email',
        label: 'fixture-email@example.test · 个人', autoLabel: 'fixture-email@example.test · 个人', email: 'fixture-email@example.test' },
      { ...base, id: 'account-2', ordinal: 2, key: KEY_B, planType: 'team', userEdited: false, labelSource: 'displayName',
        label: 'Fixture Account Name · Fixture Workspace', autoLabel: 'Fixture Account Name · Fixture Workspace',
        displayName: 'Fixture Account Name', workspaceName: 'Fixture Workspace' },
      { ...base, id: 'account-3', ordinal: 3, key: 'c'.repeat(64), planType: 'pro', userEdited: true, labelSource: 'manual',
        label: '保留的 0.3.30 手动别名', autoLabel: 'Fixture Other Name · 个人', displayName: 'Fixture Other Name' },
    ] });
    const { registry, file } = fixture(t, old);
    assert.equal(fs.readFileSync(file, 'utf8'), old, 'Read migration must not write the real ledger');
    let accounts = registry.snapshot().accounts;
    assert.deepEqual(accounts.map(account => account.label), [
      '昵称未读取 1 · 个人', '昵称未读取 2 · Fixture Workspace', '保留的 0.3.30 手动别名',
    ]);
    assert.deepEqual(accounts.map(account => account.labelSource), ['fallback', 'fallback', 'manual']);
    assert.equal(accounts.every(account => account.profileNickname === null), true);
    assert.equal(accounts[0].email, 'fixture-email@example.test');
    assert.equal(accounts[1].displayName, 'Fixture Account Name');
    registry.observe({ key: KEY_A, planType: 'pro', buckets: [] });
    const restarted = new AccountRegistry({ file, now: () => NOW });
    accounts = restarted.snapshot().accounts;
    assert.equal(accounts[0].label, '昵称未读取 1 · 个人');
    assert.equal(accounts[1].label, '昵称未读取 2 · Fixture Workspace');
    assert.equal(accounts[2].label, '保留的 0.3.30 手动别名');
    assert.equal(restarted.rename('account-3', ''), true);
    assert.equal(restarted.snapshot().accounts[2].label, '昵称未读取 3 · 个人');
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).accounts[0].alertedThrough, base.alertedThrough);
  });

  test(`${title}: an explicit same-name alias stays manual until cleared to the latest automatic name`, t => {
    const { registry, file } = fixture(t);
    registry.observe({ key: KEY_A, planType: 'pro', buckets: [], presentation: { key: KEY_A, profileNickname: 'Fixture Alice' } });
    const original = registry.snapshot().accounts[0].label;
    assert.equal(registry.rename('account-1', original), true);
    assert.equal(registry.snapshot().accounts[0].userEdited, true);
    assert.equal(registry.snapshot().accounts[0].labelSource, 'manual');
    registry.observe({ key: KEY_A, planType: 'pro', buckets: [], presentation: { key: KEY_A, profileNickname: 'Fixture Renamed' } });
    assert.equal(registry.snapshot().accounts[0].label, original);
    assert.equal(registry.snapshot().accounts[0].autoLabel, 'Fixture Renamed · 个人');
    const restarted = new AccountRegistry({ file, now: () => NOW });
    assert.equal(restarted.snapshot().accounts[0].userEdited, true);
    assert.equal(restarted.snapshot().accounts[0].label, original);
    assert.equal(restarted.rename('account-1', '   '), true);
    assert.equal(restarted.snapshot().accounts[0].label, 'Fixture Renamed · 个人');
    assert.equal(restarted.snapshot().accounts[0].userEdited, false);
    assert.equal(restarted.snapshot().accounts[0].labelSource, 'nickname');
    restarted.rename('account-1', '账号 1');
    assert.equal(new AccountRegistry({ file, now: () => NOW }).snapshot().accounts[0].label, '账号 1');
    assert.equal(new AccountRegistry({ file, now: () => NOW }).snapshot().accounts[0].userEdited, true);
  });

  test(`${title}: missing or stale presentation never downgrades names or crosses account scopes`, t => {
    const { registry } = fixture(t);
    registry.observe({ key: KEY_A, planType: 'team', buckets: [], presentation: {
      key: KEY_A, profileNickname: 'Fixture Alice', displayName: 'Fixture Account Name', email: 'fixture-alice@example.test', workspaceName: 'Fixture Team A',
    } });
    const original = registry.snapshot().accounts[0];
    registry.observe({ key: KEY_A, planType: 'team', buckets: [] });
    registry.observe({ key: KEY_A, planType: 'team', buckets: [], presentation: { key: KEY_A, profileNickname: '', displayName: '', email: null, workspaceName: ' ' } });
    registry.observe({ key: KEY_A, planType: 'team', buckets: [], presentation: { key: KEY_B, profileNickname: 'Wrong Fixture Name', workspaceName: 'Wrong Fixture Team' } });
    assert.equal(registry.observe({ key: KEY_A, stale: true, buckets: [], presentation: { key: KEY_A, profileNickname: 'Stale Fixture Name' } }), false);
    assert.equal(registry.observe({ key: KEY_A, invalidated: true, buckets: [], presentation: { key: KEY_A, profileNickname: 'Invalid Fixture Name' } }), false);
    const after = registry.snapshot().accounts[0];
    for (const field of ['profileNickname', 'displayName', 'email', 'workspaceName', 'label', 'autoLabel', 'labelSource']) assert.equal(after[field], original[field]);
    registry.observe({ key: KEY_B, planType: 'team', buckets: [], presentation: { key: KEY_A, profileNickname: 'Wrong Fixture Name' } });
    assert.equal(registry.snapshot().accounts[1].label, '昵称未读取 2 · 工作空间');
    registry.observe({ key: KEY_B, planType: 'team', buckets: [], presentation: { key: KEY_B, profileNickname: 'Fixture Alice', workspaceName: 'Fixture Team B' } });
    assert.deepEqual(registry.snapshot().accounts.map(account => account.label), ['Fixture Alice · Fixture Team A', 'Fixture Alice · Fixture Team B']);
  });

  test(`${title}: presentation strips control and bidi characters and ignores identity-shaped non-email fields`, t => {
    const { registry } = fixture(t);
    registry.observe({ key: KEY_A, buckets: [], presentation: { key: KEY_A,
      profileNickname: '\u202eFixture\u0000 Nickname\u2069', displayName: '\u202eFixture\u0000 Alice\u2069',
      workspaceName: '\u200fFixture\n Studio', email: 'fixture@example.test',
    } });
    let account = registry.snapshot().accounts[0];
    assert.equal(account.displayName, 'Fixture Alice');
    assert.equal(account.profileNickname, 'Fixture Nickname');
    assert.equal(account.workspaceName, 'Fixture Studio');
    assert.equal(account.label, 'Fixture Nickname · Fixture Studio');
    registry.rename('account-1', '\u202e手动\u0000别名\u2069');
    assert.equal(registry.snapshot().accounts[0].label, '手动别名');
    registry.observe({ key: KEY_A, buckets: [], presentation: { key: KEY_A, profileNickname: '😀'.repeat(110), displayName: '😀'.repeat(110), workspaceName: '界'.repeat(110) } });
    account = registry.snapshot().accounts[0];
    assert.equal(Array.from(account.displayName).length, 96);
    assert.equal(Array.from(account.profileNickname).length, 96);
    assert.equal(Array.from(account.workspaceName).length, 96);
    registry.observe({ key: KEY_B, buckets: [], presentation: { key: KEY_B, email: 'fixture-bearer-token', accountId: 'fixture-raw-id', workspaceId: 'fixture-workspace-id' } });
    account = registry.snapshot().accounts[1];
    assert.equal(account.label, '昵称未读取 2');
    assert.equal(account.email, null);
    assert.equal(account.workspaceName, null);
  });

  test(`${title}: corrupt or oversized ledger remains untouched and never regenerates alarm history`, t => {
    const { registry, file } = fixture(t, '{ damaged');
    assert.equal(registry.snapshot().storageError, true);
    assert.throws(() => registry.observe({ key: KEY_A, buckets: [] }), { code: 'ACCOUNT_REGISTRY_UNAVAILABLE' });
    assert.equal(fs.readFileSync(file, 'utf8'), '{ damaged');
    fs.writeFileSync(file, ' '.repeat(1024 * 1024 + 1));
    const oversized = new AccountRegistry({ file });
    assert.equal(oversized.snapshot().storageError, true);
    assert.throws(() => oversized.observe({ key: KEY_A, buckets: [] }));
    assert.equal(fs.statSync(file).size, 1024 * 1024 + 1);
  });

  test(`${title}: bounds account growth and retains existing accounts at capacity`, t => {
    const { registry, file } = fixture(t);
    for (let index = 1; index <= 100; index += 1) {
      assert.equal(registry.observe({ key: index.toString(16).padStart(64, '0'), buckets: [] }), true);
    }
    assert.equal(registry.observe({ key: KEY_A, buckets: [] }), false);
    assert.equal(registry.snapshot().count, 100);
    assert.equal(registry.snapshot().maxAccounts, 100);
    assert.equal(new AccountRegistry({ file }).snapshot().count, 100);
    assert.equal(registry.observe({ key: '1'.padStart(64, '0'), planType: 'plus', buckets: [] }), true);
    assert.equal(registry.snapshot().accounts[0].planType, 'plus');
  });
}
