'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { EventEmitter } = require('node:events');

// No filesystem, profile, Electron or data-home dependency is loaded by this
// renderer helper. Its bridge and all DOM/IME events are isolated fixtures.
const flush = async () => { for (let index = 0; index < 10; index++) await Promise.resolve(); };
function deferred() { let resolve; return { promise: new Promise(done => { resolve = done; }), get resolve() { return resolve; } }; }
function fixture(connect, bridge = () => true) {
  const document = new EventEmitter(), window = new EventEmitter(), calls = [];
  for (const target of [document, window]) { target.addEventListener = target.on.bind(target); target.removeEventListener = target.off.bind(target); }
  document.activeElement = null; document.hasFocus = () => true;
  const input = { focusCalls: 0, value: '未发送草稿', selectionStart: 2, selectionEnd: 4,
    closest() { return this; }, focus() { this.focusCalls++; document.activeElement = this; } };
  const other = { closest() { return null; } };
  const control = connect({ window, document, maid: { setWidgetInputActive(active, source) { calls.push({ active, source }); return bridge(active, source); } } });
  return { document, window, input, other, calls, control,
    click() { document.emit('pointerdown', { target: input }); document.activeElement = input; document.emit('focusin', { target: input }); },
  };
}
for (const [name, directory] of [['Windows', '..'], ['macOS mirror', '../macos']]) {
  const { connect } = require(path.join(__dirname, directory, 'src/widget-input-focus.js'));
  test(name + ': pointer editing and continuous IME input acquire one native lease and preserve selection', async () => {
    const pending = deferred(), h = fixture(connect, active => active ? pending.promise : true);
    h.click(); h.document.emit('compositionstart');
    for (let count = 0; count < 20; count++) h.document.emit('input', { target: h.input });
    h.document.emit('focusout', { target: h.input, relatedTarget: null });
    pending.resolve(true); await flush();
    assert.deepEqual(h.calls, [{ active: true, source: 'pointer' }]);
    assert.equal(h.input.focusCalls, 0); assert.equal(h.input.selectionStart, 2); assert.equal(h.input.selectionEnd, 4);
    h.document.emit('compositionend'); h.window.emit('blur'); await flush();
    assert.equal(h.calls.length, 1);
    // Returning to the editor reasserts the native child focus without a
    // detach/attach visibility transition.
    h.click(); pending.resolve(true); await flush();
    assert.equal(h.calls.length, 2); assert.equal(h.calls.at(-1).active, true);
    h.document.emit('focusout', { target: h.input, relatedTarget: null });
    assert.deepEqual(h.calls.at(-1), { active: false, source: 'blur' });
    h.control.dispose();
  });
  test(name + ': Tab enters an editor, transient native blur keeps the lease, and later genuine blur releases it', async () => {
    const pending = deferred(), h = fixture(connect, active => active ? pending.promise : true);
    h.document.emit('focusout', { target: h.other, relatedTarget: h.input });
    h.document.emit('keydown', { key: 'Tab' }); h.document.emit('focusin', { target: h.input });
    assert.deepEqual(h.calls, [{ active: true, source: 'focus' }]);
    h.document.activeElement = h.input; h.window.emit('blur'); pending.resolve(true); await flush();
    assert.equal(h.calls.length, 1); assert.equal(h.input.focusCalls, 0);
    h.click(); pending.resolve(true); await flush(); assert.equal(h.calls.length, 2);
    h.document.emit('focusout', { target: h.input, relatedTarget: null });
    assert.equal(h.calls.length, 3);
    h.control.dispose();
  });
  test(name + ': clicking another control cancels a late native detach and never refocuses after it completes', async () => {
    const pending = deferred(), h = fixture(connect, active => active ? pending.promise : true);
    h.click(); h.document.emit('pointerdown', { target: h.other }); h.document.activeElement = h.other;
    pending.resolve(true); await flush();
    assert.equal(h.input.focusCalls, 0); assert.equal(h.calls.length, 2); assert.equal(h.calls[1].active, false);
    h.control.dispose();
  });
}
