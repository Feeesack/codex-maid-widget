'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

for (const variant of ['', 'macos']) {
  const { profileNickname, workspaceName, projectProfileMetadata } = require(path.join(__dirname, '..', variant, 'src/account-profile.cjs'));
  test(`${variant || 'Windows'}: actual profile nickname is separate from name, email and handle`, () => {
    const result = {name:'Account Name',email:'fixture@example.test',profile:{display_name:'Fixture Nickname',username:'account_handle'}};
    assert.equal(profileNickname(result),'Fixture Nickname');
    assert.equal(profileNickname({profile_details:{display_name:'Page Nickname',username:'other_handle'}},'profile-page'),'Page Nickname');
    assert.equal(profileNickname({display_name:'Unscoped Display Name'}),null);
    for (const payload of [{name:'Account Name'},{email:'fixture@example.test'},{profile:{username:'account_handle'}},{profile_details:{name:'Not a Nickname'}}]) assert.equal(profileNickname(payload),null);
  });
  test(`${variant || 'Windows'}: workspace metadata must identify exactly the selected workspace`, () => {
    const payload={accounts:{first:{account:{account_id:'workspace-a',structure:'workspace',name:'Selected Team'}},second:{account:{account_id:'workspace-b',structure:'workspace',name:'Other Team'}}}};
    assert.equal(workspaceName(payload,'workspace-a'),'Selected Team');
    assert.equal(workspaceName(payload,'missing'),null);
    assert.equal(workspaceName({accounts:{x:payload.accounts.first,y:payload.accounts.first}},'workspace-a'),null);
    assert.equal(workspaceName({accounts:{x:{account:{account_id:'workspace-a',structure:'personal',name:'Personal'}}}},'workspace-a'),null);
    const desktop={accounts:[{id:'workspace-a',structure:'workspace',name:'Desktop Selected Team'},
      {id:'workspace-b',structure:'workspace',name:'Desktop Other Team'}]};
    assert.equal(workspaceName(desktop,'workspace-a'),'Desktop Selected Team');
    assert.equal(workspaceName({accounts:[desktop.accounts[0],desktop.accounts[0]]},'workspace-a'),null);
    assert.equal(workspaceName({accounts:[{id:'workspace-a',structure:'personal',name:'Personal'}]},'workspace-a'),null);
    assert.equal(workspaceName({accounts:[{id:'workspace-a',name:'Unconfirmed Structure'}]},'workspace-a'),null);
    const projected=projectProfileMetadata({profile:{profile:{display_name:'Fixture Nick'}},accounts:payload,scopeId:'workspace-a'});
    assert.deepEqual(projected,{profileNickname:'Fixture Nick',workspaceName:'Selected Team'});
    assert.doesNotMatch(JSON.stringify(projected),/workspace-a|account_id|username|email/);
  });
  test(`${variant || 'Windows'}: the display projection rejects malformed values and credential-like strings`, () => {
    for (const display_name of [null,{},[],42,'x'.repeat(513),'Bearer synthetic-secret','access_token=synthetic-secret']) assert.equal(profileNickname({profile:{display_name}}),null);
    assert.equal(profileNickname({profile:{display_name:'\u202e Fixture\n Nick \u2069'}}),'Fixture Nick');
    assert.equal(profileNickname({name:'Feeesack',username:'fajiawang944'}),null);
  });
}
