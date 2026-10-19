'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// These renderer tests only evaluate the account UI's actual functions with
// deterministic DOM/clock doubles. They never import data-home or Codex readers.
class Element {
  constructor(tag = 'div') {
    this.tagName = tag; this.children = []; this.style = {}; this.attributes = {}; this.listeners = {}; this.hidden = false;
    const classes = new Set();
    this.classList = {toggle(name, value) { if (value) classes.add(name); else classes.delete(name); }, add(...names) {for (const name of names) classes.add(name);},remove(...names) {for (const name of names) classes.delete(name);},contains(name) {return classes.has(name);}};
  }
  append(...nodes) { for (const node of nodes) { node.parentElement = this; this.children.push(node); } }
  setAttribute(key, value) { this.attributes[key] = value; }
  removeAttribute(key) { delete this.attributes[key]; }
  querySelectorAll(tag) { return this.children.flatMap(child => [...(child.tagName === tag ? [child] : []), ...child.querySelectorAll(tag)]); }
  addEventListener(name, listener) { this.listeners[name] = listener; }
  focus() {} select() {}
  remove() { this.parentElement.children.splice(this.parentElement.children.indexOf(this), 1); }
  insertBefore(node, before) { if (node.parentElement) node.remove(); node.parentElement = this; this.children.splice(before ? this.children.indexOf(before) : this.children.length, 0, node); }
}
function harness(folder = '') {
  const source = fs.readFileSync(path.join(__dirname, '..', folder, 'src/widget.js'), 'utf8');
  const nodes = new Map(['account-list', 'accounts-empty', 'accounts-feedback'].map(id => [id, new Element()]));
  let clock = 2000000000, pending;
  class Clock extends Date { static now() { return clock * 1000; } }
  const noises = [], notices = [];
  const context = {
    document: { createElement: tag => new Element(tag) },
    $: id => nodes.get(id), Date: Clock, setTimeout() {}, clearTimeout() {},
    current: {settings: {accountResetAlerts: true}}, window: {maid: {listAccounts: () => new Promise(resolve => { pending = resolve; })}},
    accountAlarmBounce: () => noises.push('four-bounce-alarm'), notice: text => notices.push(text), reveal() {},
  };
  vm.runInNewContext(`const accountCards = new Map(), accountResetEvents = new Map(); let accountRequest = 0, accountFeedbackTimer, hideTimer;
    ${source.slice(source.indexOf('function accountElement('), source.indexOf('function reveal('))}
    globalThis.subject = {renderAccounts, updateAccountTimers, refreshAccounts, handleAccountReset, accountCards};`, context);
  return {...context.subject, context, nodes, noises, notices, advance: seconds => {clock += seconds;}, reply: value => pending(value)};
}
for (const folder of ['', 'macos']) {
  const platform = folder || 'Windows';
  test(`${platform}: account timers distinguish cycle progress, observed quota and unknown deadlines`, () => {
    const h = harness(folder);
    h.renderAccounts({accounts: [{id:'one',label:'账号 1',current:true,planType:'pro',planLabel:'Pro',scopeLabel:'个人',resetsAt:2000009000,remainingPercent:23,observedAt:1999999999}, {id:'two',label:'账号 2',planType:'team',planLabel:'Team',scopeLabel:'工作空间',resetsAt:null}]});
    const first = h.accountCards.get('one'), second = h.accountCards.get('two');
    assert.equal(first.bar.style.width, '50%');
    assert.equal(first.track.attributes['aria-valuenow'], '50');
    assert.match(first.countdown.textContent, /02:30:00/);
    assert.match(first.remaining.textContent, /上次剩余 23%/);
    assert.equal(first.plan.textContent, 'Pro · 个人');
    assert.equal(second.plan.textContent, 'Team · 工作空间');
    assert.equal(second.track.attributes['aria-valuenow'], undefined);
    assert.match(second.countdown.textContent, /未知/);
    h.advance(10000); h.updateAccountTimers();
    assert.equal(first.bar.style.width, '100%');
    assert.equal(first.countdown.textContent, '预计已重置，待登录确认');
    assert.equal(first.account.remainingPercent, 23, 'local clock must not fabricate or overwrite observed quota');
  });
  test(`${platform}: keyed refreshes preserve unfinished alias edits and only render names as text`, () => {
    const h = harness(folder), account = {id:'one',label:'<img src=x>',labelSource:'manual',userEdited:true,resetsAt:2000009000};
    h.renderAccounts({accounts:[account]});
    const entry = h.accountCards.get('one');
    entry.card.querySelectorAll('button')[0].listeners.click();
    entry.input.value = '正在编辑';
    h.renderAccounts({accounts:[{...account,label:'new server label'}]});
    assert.equal(h.accountCards.get('one'), entry);
    assert.equal(entry.input.value, '正在编辑');
    assert.equal(entry.editor.hidden, false);
    assert.equal(entry.name.textContent, 'new server label');
    assert.equal(entry.card.querySelectorAll('img').length, 0);
    h.renderAccounts({accounts:[],storageError:true});
    assert.equal(h.nodes.get('accounts-empty').hidden, false);
    assert.match(h.nodes.get('accounts-empty').textContent, /原文件已保留/);
  });
  test(`${platform}: a delayed list response cannot restore a removed or renamed account`, async () => {
    const h = harness(folder), pending = h.refreshAccounts();
    h.renderAccounts({accounts:[{id:'new',label:'新的别名'}]});
    h.reply({accounts:[{id:'old',label:'过时别名'}]});
    await pending;
    assert.deepEqual([...h.accountCards.keys()], ['new']);
  });
  test(`${platform}: genuine profile nicknames stay distinct from account names and aliases restore nickname naming`, async () => {
    const h = harness(folder), calls = [];
    const user = '虚构昵称 <img src=x>', accountName = 'not_the_nickname', email = 'only-fixture@example.invalid', workspace = '隔离测试工作空间名称';
    let account = {id:'one',label:`${user} · ${workspace}`,autoLabel:`${user} · ${workspace}`,labelSource:'nickname',userEdited:false,profileNickname:user,displayName:accountName,email,workspaceName:workspace,planLabel:'Team',scopeLabel:'工作空间'};
    h.context.window.maid.renameAccount = async (id, label) => {
      calls.push([id,label]); account = {...account,label:label || account.autoLabel,labelSource:label ? 'manual' : 'nickname',userEdited:!!label}; return {accounts:[account]};
    };
    h.renderAccounts({accounts:[account]});
    const entry = h.accountCards.get('one');
    assert.equal(entry.name.textContent, account.label);
    assert.ok(entry.name.title.includes(user) && entry.name.title.includes(email) && entry.name.title.includes(workspace));
    assert.ok(entry.name.title.includes(`资料昵称：${user}`) && entry.name.title.includes(`账户资料名称：${accountName}`));
    assert.ok(!entry.name.textContent.includes(email) && !entry.name.textContent.includes(accountName));
    assert.equal(entry.plan.textContent, `Team · 工作空间 · ${workspace}`);
    assert.equal(entry.plan.title, entry.name.title);
    entry.card.querySelectorAll('button')[0].listeners.click();
    assert.equal(entry.input.value, ''); assert.equal(entry.input.placeholder, account.autoLabel);
    entry.input.value = '主力 <img src=x>';
    await entry.editor.listeners.submit({preventDefault(){}});
    assert.equal(entry.name.textContent, '主力 <img src=x>'); assert.equal(entry.card.querySelectorAll('img').length, 0);
    account = {...account,displayName:'更新后的虚构账户资料名称'}; h.renderAccounts({accounts:[account]});
    assert.equal(entry.name.textContent, '主力 <img src=x>', 'metadata refresh must preserve the final manual label');
    entry.card.querySelectorAll('button')[0].listeners.click(); assert.equal(entry.input.value, '主力 <img src=x>');
    entry.input.value = '   '; await entry.editor.listeners.submit({preventDefault(){}});
    assert.deepEqual(calls,[['one','主力 <img src=x>'],['one','']]);
    assert.equal(entry.name.textContent, account.autoLabel); assert.equal(entry.account.userEdited, false);
    assert.match(h.nodes.get('accounts-feedback').textContent,/恢复自动/);
    h.renderAccounts({accounts:[{...account,workspaceName:null}]});
    assert.equal(entry.plan.textContent, 'Team · 工作空间'); assert.match(entry.name.title,/工作空间名称：未读取/);
  });
  test(`${platform}: email, handles and account names never substitute for an unread profile nickname`, async () => {
    const h = harness(folder), email = 'never-a-nickname@example.invalid', handle = '@not_a_nickname';
    for (const labelSource of ['email','displayName','nickname','fallback',undefined]) {
      const account = {id:'one',label:labelSource==='displayName' ? handle : email,autoLabel:email,labelSource,userEdited:false,profileNickname:null,displayName:handle,email,scopeLabel:'工作空间'};
      h.renderAccounts({accounts:[account]});
      const entry = h.accountCards.get('one');
      assert.equal(entry.name.textContent,'昵称未读取 · 工作空间');
      assert.match(entry.name.title,/资料昵称：未读取/); assert.ok(entry.name.title.includes(`账户资料名称：${handle}`)); assert.ok(entry.name.title.includes(`邮箱：${email}`));
      entry.card.querySelectorAll('button')[0].listeners.click();
      assert.equal(entry.input.value,''); assert.equal(entry.input.placeholder,'昵称未读取 · 工作空间');
      entry.input.value='';
      h.context.window.maid.renameAccount = async () => ({accounts:[{...account,label:'昵称未读取 1 · 工作空间',autoLabel:'昵称未读取 1 · 工作空间',labelSource:'fallback'}]});
      await entry.editor.listeners.submit({preventDefault(){}});
      assert.equal(entry.name.textContent,'昵称未读取 1 · 工作空间');
      assert.ok(!entry.name.textContent.includes(email) && !entry.name.textContent.includes(handle));
    }
    h.renderAccounts({accounts:[{id:'one',label:email,labelSource:'manual',userEdited:true,email}]});
    assert.equal(h.accountCards.get('one').name.textContent,email,'an explicit manual alias remains the user’s choice');
  });
  test(`${platform}: reset events deduplicate and run the dedicated widget alarm once`, () => {
    const h = harness(folder), event = {id:'one',label:'账号 1',resetsAt:2000000000};
    h.handleAccountReset(event); h.handleAccountReset(event);
    assert.equal(h.notices.length, 1);
    assert.deepEqual(h.noises, ['four-bounce-alarm']);
    assert.match(h.notices[0], /预计已重置.*登录确认/);
    h.handleAccountReset({...event,resetsAt:2000018000});
    assert.deepEqual(h.noises, ['four-bounce-alarm','four-bounce-alarm']);
    h.context.current.settings.accountResetAlerts = false;
    h.handleAccountReset({...event,resetsAt:2000036000});
    assert.equal(h.notices.length, 2);
  });
  test(`${platform}: production alarm helpers separate four-bounce animation from one sound and honor interruption`, () => {
    const source = fs.readFileSync(path.join(__dirname, '..', folder, 'src/widget.js'), 'utf8');
    const nodes = new Map(['character','bubble-motion'].map(id=>[id,new Element()]));
    let soundAttempts = 0;
    const wrapper = new Element();
    const context = { $: id=>id==='widget'?wrapper:nodes.get(id),current:{settings:{sound:true}},reveal() {},AudioContext:class {constructor() {soundAttempts++;throw Error('isolated sound fixture');}} };
    vm.runInNewContext(`let audio,interactionHeld=false,interactionSound={stop(){}}; ${source.match(/^function clearBounceMotion\([^\n]+$/m)[0]} ${source.match(/^function clearBounce\(\).+$/m)[0]}
      ${source.slice(source.indexOf('function startBounce('),source.indexOf('function bounce('))}
      ${source.slice(source.indexOf('function accountAlarmBounce('),source.indexOf('function render(value)'))}
      globalThis.subject={accountAlarmBounce,clearBounce};`,context);
    const alarm = context.subject;
    alarm.accountAlarmBounce();
    assert.ok([...nodes.values()].every(node=>node.classList.contains('account-alarm-bounce')&&!node.classList.contains('bounce')));
    assert.equal(soundAttempts,1,'one alarm starts one sound, independently of its CSS iteration count');
    alarm.accountAlarmBounce();
    assert.equal(soundAttempts,2,'a second alarm still starts one sound');
    context.current.settings.sound = false;
    alarm.accountAlarmBounce(); assert.equal(soundAttempts,2,'mute suppresses the whole alarm sound');
    nodes.get('character').classList.add('interaction-pressed');
    alarm.clearBounce(); assert.ok([...nodes.values()].every(node=>!node.classList.contains('account-alarm-bounce')&&!node.classList.contains('interaction-pressed')));
    context.current.visualPose = {moving:true};
    alarm.accountAlarmBounce(); assert.ok([...nodes.values()].every(node=>!node.classList.contains('account-alarm-bounce')));
    delete context.current.visualPose; context.current.settings.animationMode = 'reduced';
    alarm.accountAlarmBounce(); assert.ok([...nodes.values()].every(node=>node.classList.contains('account-alarm-bounce')),'obsolete animation preference cannot suppress account alarms');
    assert.equal(soundAttempts,2);
  });
  test(`${platform}: long automatic names stay bounded in the reset notice`, () => {
    const h = harness(folder);
    h.handleAccountReset({id:'long-label',label:'虚构用户'.repeat(70),resetsAt:2000000000});
    assert.ok(Array.from(h.notices[0]).length < 80);
    assert.match(h.notices[0], /…的五小时额度预计已重置/);
    assert.deepEqual(h.noises,['four-bounce-alarm']);
  });
  test(`${platform}: settings retain account page and explicit alert opt-out`, () => {
    const {sanitize} = require(path.join(__dirname, '..', folder, 'src/settings.cjs'));
    assert.equal(sanitize().accountResetAlerts, true);
    assert.equal(sanitize({accountResetAlerts:false,mode:'accounts'}).accountResetAlerts, false);
    assert.equal(sanitize({mode:'accounts'}).mode, 'accounts');
    assert.equal(sanitize({accountResetAlerts:'false'}).accountResetAlerts, true);
  });
  test(`${platform}: the sandbox bridge exposes local account IPC and removable reset subscription`, async () => {
    const calls = [], listeners = new Map(); let bridge;
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', folder, 'src/preload.cjs'), 'utf8'), {require(id) {
      assert.equal(id, 'electron');
      return {contextBridge:{exposeInMainWorld(name, value) {assert.equal(name, 'maid'); bridge = value;}}, ipcRenderer:{invoke(...args) {calls.push(args);},on(name, listener) {listeners.set(name, listener);}, removeListener(name, listener) {assert.equal(listeners.get(name), listener);listeners.delete(name);}}};
    }});
    await bridge.listAccounts(); await bridge.renameAccount('one','主力'); await bridge.removeAccount('two');
    assert.deepEqual(calls, [['list-accounts'],['rename-account','one','主力'],['remove-account','two']]);
    let event; const off = bridge.onAccountReset(value => {event = value;});
    listeners.get('account-reset')({}, {id:'one'}); assert.equal(event.id, 'one');
    off(); assert.equal(listeners.has('account-reset'), false);
  });
}
