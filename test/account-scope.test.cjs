'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

for (const variant of ['', 'macos']) {
  const { CodexDataSource } = require(path.join(__dirname, '..', variant, 'src/codex-data.cjs'));
  test(`${variant || 'Windows'}: one login partitions personal, workspace and protocol workspace scopes`, async () => {
    let account = { type: 'chatgpt', email: 'fixture@example.test', planType: 'pro' };
    const source = new CodexDataSource({
      localReader: { read: async () => ({}) },
      server: { connect: async () => {}, disconnect() {}, close() {},
        request: async method => method === 'account/read' ? { account } : {
          rateLimits: { primary: { windowDurationMins: 300, resetsAt: 1900000000, usedPercent: 30 } },
        } },
    });
    const personal = await source.read(), personalKey = source.accountIdentity;
    account = { ...account, planType: 'team' };
    const workspace = await source.read(), workspaceKey = source.accountIdentity;
    assert.notEqual(personalKey, workspaceKey); assert.equal(workspace.accountChanged, true);
    assert.equal(personal.account.planType, 'pro'); assert.equal(workspace.account.planType, 'team');
    account = { ...account, workspaceId: 'fixture-workspace-a' };
    await source.read(); const firstWorkspace = source.accountIdentity;
    account = { ...account, workspaceId: 'fixture-workspace-b' };
    const second = await source.read(); assert.notEqual(source.accountIdentity, firstWorkspace);
    assert.equal(second.accountChanged, true);
    const repeated = source.accountIdentity; await source.read(); assert.equal(source.accountIdentity, repeated);
    assert.doesNotMatch(JSON.stringify([personal, workspace, second]), /fixture|[a-f0-9]{64}/);
    source.close();
  });
}
