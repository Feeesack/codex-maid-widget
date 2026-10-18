'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), vm = require('node:vm'), fs = require('node:fs'), path = require('node:path');
for (const folder of ['', 'macos/']) {
  test(folder + 'presence: late initial IPC cannot override a newer visibility event', async () => {
    let resolve, listener, queries = 0; const classes = new Set();
    const body = { classList: { toggle(key, value) { value ? classes.add(key) : classes.delete(key); } }, inert: false };
    const context = { window: {}, document: { body } };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', folder, 'src/presence.js'), 'utf8'), context);
    const initial = new Promise(done => { resolve = done; });
    const ready = context.window.MaidPresence.connect({ getState() { queries++; return initial; }, onPresence(fn) { listener = fn; }, pointerRegion() {} });
    listener({ visible: false, animate: true });
    resolve({ windowContainment: { enabled: false, visible: true } }); await ready;
    assert.equal(queries, 1); assert.equal(classes.has('presence-hidden'), true); assert.equal(body.inert, true);
    listener({ visible: true, animate: true });
    assert.equal(classes.has('presence-hidden'), false); assert.equal(classes.has('presence-instant'), false); assert.equal(body.inert, false);
  });
}
