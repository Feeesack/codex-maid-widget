'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ids = ['quota', 'conversation', 'accounts', 'today', 'week', 'lastTurn', 'phrase'];
function harness(folder, settings = {}) {
  const source = fs.readFileSync(path.join(__dirname, '..', folder, 'src/widget.js'), 'utf8');
  const start = source.indexOf('function visibleBubblePages('), end = source.indexOf('function renderConversation(', start);
  const bindingStart = source.indexOf("for (const [id, direction] of [['previous-page'"), bindingEnd = source.indexOf('let talkPointer', bindingStart);
  const dragStart = source.indexOf("for (const target of [$('character'), $('bubble')])"), dragEnd = source.indexOf('let toolbarHideTimer', dragStart);
  assert.ok(start >= 0 && end > start && bindingStart >= 0 && bindingEnd > bindingStart && dragStart >= 0 && dragEnd > dragStart);
  const nodes = new Map(), writes = [], reads = [], drags = [];
  let stopped = 0, refreshes = 0;
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, { id, attributes: {}, listeners: {}, disabled: false,
      setAttribute(name, value) { this.attributes[name] = value; },
      addEventListener(name, listener) { this.listeners[name] = listener; },
      click() { if (!this.disabled) this.listeners.click({ detail: 0, stopPropagation() { stopped++; } }); },
    });
    return nodes.get(id);
  };
  const context = { $: node, window: { addEventListener() {}, maid: {
    setSettings(patch) { writes.push(patch); return Promise.resolve({ settingsRevision: writes.length }); },
    drag(phase) { drags.push(phase); },
  } }, document: { addEventListener() {} }, fitTokenLabels() {}, nextPhrase() {}, renderConversation() {},
    reveal() {}, updateAccountTimers() {}, notice() {}, clearTimeout() {},
    inspectConversation() { reads.push('conversation'); }, refreshAccounts() { reads.push('accounts'); },
    doRefresh() { refreshes++; },
  };
  vm.runInNewContext(`const modes=${JSON.stringify(ids)};let current={settings:${JSON.stringify({ mode: 'quota', defaultBubblePage: 'week', ...settings })}};
    let mode='quota',conversationRequest=0,conversationPending=false,conversationVisible=false;
    let modeWriteGeneration=0,modeWritePending=0,lastSettingsRevision=-1;
    ${source.slice(start, end)}
    ${source.slice(bindingStart, bindingEnd)}
    ${source.slice(dragStart, dragEnd)}
    globalThis.subject={setMode,visibleBubblePages,defaultBubblePage,updatePageNavigation,
      mode:()=>mode,settings:()=>current.settings,
      replaceSettings:value=>{current={settings:{...current.settings,...value}};setMode(mode,false);}};`, context);
  return { ...context.subject, nodes, writes, reads, drags, get stopped() { return stopped; }, get refreshes() { return refreshes; },
    click: id => node(id).click() };
}

for (const folder of ['', 'macos']) {
  const platform = folder || 'Windows';
  test(`${platform}: previous and next follow visible order, wrap and never rewrite the independent startup default`, () => {
    const h = harness(folder, { bubblePageOrder: ['week', 'phrase', 'quota', 'conversation', 'accounts', 'today', 'lastTurn'], bubbleHiddenPages: ['accounts', 'today', 'lastTurn'] });
    h.setMode('week', false);
    assert.deepEqual(h.reads, []);
    for (const page of ['phrase', 'quota', 'conversation', 'week']) { h.click('next-page'); assert.equal(h.mode(), page); }
    for (const page of ['conversation', 'quota', 'phrase', 'week']) { h.click('previous-page'); assert.equal(h.mode(), page); }
    assert.equal(h.reads.filter(value => value === 'conversation').length, 2, 'only explicit entry in either direction reads a conversation');
    assert.ok(h.writes.every(patch => Object.keys(patch).length === 1 && Object.hasOwn(patch, 'mode')));
    assert.equal(h.settings().defaultBubblePage, 'week');
    assert.equal(h.stopped, 8, 'each arrow stops the enclosing bubble click');
    assert.equal(h.refreshes, 0); assert.deepEqual(h.drags, []);
    assert.match(h.nodes.get('previous-page').attributes['aria-label'], /^上一页：对话状态$/);
    assert.match(h.nodes.get('next-page').title, /^下一页：女仆$/);
  });
  test(`${platform}: a single visible page disables both arrows and passive fallback never reads or writes`, () => {
    const h = harness(folder, { bubbleHiddenPages: ids.filter(id => id !== 'conversation'), defaultBubblePage: 'conversation' });
    h.setMode('conversation', false);
    for (const id of ['previous-page', 'next-page']) {
      assert.equal(h.nodes.get(id).disabled, true);
      assert.equal(h.nodes.get(id).attributes['aria-disabled'], 'true');
      assert.match(h.nodes.get(id).title, /仅一页/);
      h.click(id);
    }
    assert.equal(h.mode(), 'conversation'); assert.deepEqual(h.reads, []); assert.deepEqual(h.writes, []);
    h.replaceSettings({ bubbleHiddenPages: ['conversation'], defaultBubblePage: 'week' });
    assert.equal(h.mode(), 'week'); assert.deepEqual(h.reads, []); assert.deepEqual(h.writes, []);
    assert.equal(h.nodes.get('previous-page').disabled, false); assert.equal(h.nodes.get('next-page').disabled, false);
  });
  test(`${platform}: SVG arrow targets do not begin bubble dragging or refresh on pointer release`, () => {
    const h = harness(folder); h.setMode('quota', false);
    for (const id of ['previous-page', 'next-page']) {
      const target = { closest: selector => selector.includes('button') ? h.nodes.get(id) : null };
      h.nodes.get('bubble').listeners.pointerdown({ button: 0, pointerId: 1, target });
      h.nodes.get('bubble').listeners.pointerup({ button: 0, pointerId: 1, target });
      h.click(id);
    }
    assert.deepEqual(h.drags, []); assert.equal(h.refreshes, 0); assert.equal(h.stopped, 2);
  });
}
