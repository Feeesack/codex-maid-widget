'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { watchAuthChanges } = require('../src/auth-change-watch.cjs');

test('metadata watcher notices replacing and deleting credentials without reading them', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'maid-auth-watch-'));
  const file = path.join(home, 'auth.json');
  fs.writeFileSync(file, 'test fixture only');
  let changes = 0;
  const stop = watchAuthChanges(home, () => changes++, {interval:25});
  t.after(() => { stop(); fs.rmSync(home, {recursive:true,force:true}); });
  const until = async wanted => {
    for (let i=0; i<60; i++) { if (changes>=wanted) return; await new Promise(resolve=>setTimeout(resolve,25)); }
    assert.fail('Expected a metadata change notification');
  };
  await new Promise(resolve=>setTimeout(resolve,50));
  fs.writeFileSync(file+'.tmp', 'replacement account fixture'); fs.renameSync(file+'.tmp',file);
  await until(1);
  fs.unlinkSync(file); await until(2);
  stop();
  const before=changes; fs.writeFileSync(file,'after stop');
  await new Promise(resolve=>setTimeout(resolve,80)); assert.equal(changes,before);
});
