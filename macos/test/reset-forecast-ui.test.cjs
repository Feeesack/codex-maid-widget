'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Renderer-only: deterministic DOM, clock and IPC doubles. No production main,
// data-home function, network provider, account reader or filesystem storage runs.
const now = Date.parse('2026-10-22T12:00:00.000Z');
const forecast = {status:'live',source:'https://codex-reset.com/',probability24h:37.4,probability48h:62.7,confidence:'medium',lastResetAt:'2026-10-20T12:00:00.000Z',updatedAt:'2026-10-22T11:55:00.000Z',fetchedAt:'2026-10-22T11:56:00.000Z',signal:{kind:'promise',state:'active',deadlineAt:'2026-10-22T14:00:00.000Z',at:'2026-10-22T11:00:00.000Z',summary:'Tibo says <img src=x onerror=alert(1)>',url:'https://x.com/tibo/status/123'}};
function harness(folder) {
  const base = path.join(__dirname,'..',folder,'src'), source = fs.readFileSync(path.join(base,'widget.js'),'utf8');
  const nodes = new Map();
  const $ = id => {
    if (!nodes.has(id)) {
      const classes = new Set();
      nodes.set(id,{textContent:'',title:'',attributes:{},listeners:{},
        setAttribute(key,value) {this.attributes[key]=value;},addEventListener(key,value) {this.listeners[key]=value;},
        classList:{toggle(key,on) {on ? classes.add(key) : classes.delete(key);},contains:key => classes.has(key)}});
    }
    return nodes.get(id);
  };
  let clock=now;
  class Clock extends Date {static now() {return clock;}}
  const calls = [], notices = [];
  const context = {Date:Clock,$,reveal() {},clearTimeout() {},notice:value => notices.push(value),
    window:{maid:{refreshResetForecast:async () => {calls.push('refresh');return forecast;},openResetSource:async () => {calls.push('source');}}}};
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(base,'i18n.js'),'utf8'),context);
  context.window.MaidI18n=context.MaidI18n;
  vm.runInContext(fs.readFileSync(path.join(base,'i18n-widget.js'),'utf8'),context);
  vm.runInContext(`let current={resetForecast:${JSON.stringify(forecast)}},mode='resetForecast',resetForecastPending=false,resetForecastGeneration=0,hideTimer;
    const t=(...args)=>window.MaidI18n.t(...args),locale=()=>window.MaidI18n.getLocale();
    ${source.slice(source.indexOf('function resetForecastTime('),source.indexOf('function visibleBubblePages('))}
    ${source.slice(source.indexOf("$('reset-source').addEventListener('click'"),source.indexOf("$('conversation-select').addEventListener('change'"))}
    globalThis.subject={renderResetForecast,updateResetForecastDeadline,refreshResetForecast,state:()=>current,
      broadcast:value=>{current={resetForecast:value};renderResetForecast(value);},
      language:value=>window.MaidI18n.setLocale(value)};`,context);
  return {...context.subject,advance:milliseconds=>{clock+=milliseconds;},nodes,$,calls,notices,maid:context.window.maid,source};
}
for (const folder of ['']) {
  const platform = 'macOS';
  test(`${platform}: forecast labels distinguish prediction, signal and confirmed history in both languages`, () => {
    const h = harness(folder);h.renderResetForecast();
    assert.equal(h.$('reset-probability-24').textContent,'37%');assert.equal(h.$('reset-probability-48').textContent,'63%');
    assert.equal(h.$('reset-signal').textContent,'Tibo 承诺重置');
    assert.ok(h.$('reset-signal').title.includes('<img src=x onerror=alert(1)>'),'source text is plain title text');
    assert.match(h.$('reset-signal').title,/不代表额度已重置/);
    assert.match(h.$('reset-last-confirmed').textContent,/上次重置/);
    assert.equal(h.$('reset-confidence').textContent,'置信度：中');
    assert.match(h.$('bubble').title,/第三方预测 · 非到账保证/);
    h.language('en');h.renderResetForecast();
    for(const node of h.nodes.values())assert.doesNotMatch(node.textContent,/[\u3400-\u9fff]/);
    assert.equal(h.$('reset-signal').textContent,'Tibo promises a reset');
    assert.equal(h.$('reset-confidence').textContent,'Confidence: Med');
    assert.match(h.$('reset-last-confirmed').textContent,/Last reset/);
    assert.match(h.$('bubble').title,/Third-party forecast · no guarantee/);
  });
  test(`${platform}: public promise gets primary countdown, pending time and confirmation-safe expiration`, () => {
    const h=harness(folder);h.renderResetForecast();
    assert.equal(h.$('reset-announcement').hidden,false);
    assert.equal(h.$('resetForecast-view').classList.contains('forecast-announcement'),true);
    assert.equal(h.$('reset-deadline').textContent,'02:00:00');
    assert.equal(h.$('reset-deadline-label').textContent,'公告截止 · 待确认');
    h.advance(62000);h.updateResetForecastDeadline();assert.equal(h.$('reset-deadline').textContent,'01:58:58');
    h.advance(2*3600e3);h.updateResetForecastDeadline();
    assert.equal(h.$('reset-deadline').textContent,'00:00:00');assert.equal(h.$('reset-deadline-label').textContent,'已到公告时间 · 待确认');
    assert.equal(h.$('resetForecast-view').classList.contains('forecast-announcement'),true,'zero cannot demote a promise or imply quota arrival');
    h.renderResetForecast({...forecast,signal:{...forecast.signal,deadlineAt:null,pending:'on_its_way'}});
    assert.equal(h.$('reset-signal').textContent,'重置正在路上');assert.equal(h.$('reset-deadline').textContent,'时间待公布');
    h.renderResetForecast({...forecast,signal:{...forecast.signal,state:'expired'}});
    assert.equal(h.$('reset-signal').textContent,'承诺窗口已过');assert.equal(h.$('reset-deadline-label').textContent,'承诺窗口已过 · 待确认');
    h.language('en');h.renderResetForecast({...forecast,signal:{...forecast.signal,state:'expired'}});
    assert.equal(h.$('reset-deadline-label').textContent,'Promise window passed · unconfirmed');
    h.renderResetForecast({...forecast,signal:null});
    assert.equal(h.$('reset-announcement').hidden,true);assert.equal(h.$('resetForecast-view').classList.contains('forecast-announcement'),false);
  });
  test(`${platform}: cached signals stay marked unverified and malformed data never becomes a new reset`, () => {
    const h = harness(folder);
    for(const status of ['stale','offline']) {
      h.renderResetForecast({...forecast,status});
      assert.equal(h.$('reset-signal').textContent,'缓存信号 · 待核实');
      assert.equal(h.$('reset-deadline-label').textContent,'缓存截止 · 待核实');
      assert.equal(h.$('reset-announcement').hidden,false);
      assert.equal(h.$('resetForecast-view').classList.contains('forecast-stale'),true);
    }
    for(const status of ['disabled','connecting']) {
      h.renderResetForecast({...forecast,status});assert.equal(h.$('reset-signal').textContent,'信号待联网核实');assert.equal(h.$('reset-announcement').hidden,true);
    }
    h.renderResetForecast({...forecast,status:'stale'});assert.match(h.$('reset-forecast-status').textContent,/缓存.*请核实/);
    for(const signal of [null,{...forecast.signal,at:'2026-10-23T12:00:00.000Z'},{...forecast.signal,at:'invalid'}]) {
      h.renderResetForecast({...forecast,signal});assert.equal(h.$('reset-signal').textContent,'暂无新信号');
    }
    h.renderResetForecast({...forecast,signal:{...forecast.signal,at:'2026-10-19T00:00:00.000Z',deadlineAt:'2026-10-22T11:59:00.000Z'}});
    assert.equal(h.$('reset-announcement').hidden,false,'provider retains pending promises until withdrawal or confirmation');
    assert.equal(h.$('reset-deadline-label').textContent,'已到公告时间 · 待确认');
    assert.match(h.$('reset-signal').title,/公告窗口/);
    h.renderResetForecast({status:'offline',probability24h:NaN,probability48h:101,lastResetAt:'bad'});
    assert.equal(h.$('reset-probability-24').textContent,'--');assert.equal(h.$('reset-probability-48').textContent,'--');
    assert.equal(h.$('reset-last-confirmed').textContent,'上次重置：--');
    assert.equal(h.$('reset-confidence').textContent,'置信度：未知');
    assert.doesNotMatch(h.source,/reset[^\n]*\.innerHTML\s*=/i);
  });
  test(`${platform}: observation deadlines remain distinct from announcement deadlines and work without probabilities`, () => {
    const h=harness(folder), data={...forecast,probability24h:null,probability48h:null,signal:{...forecast.signal,deadlineKind:'observation',deadlineQuote:'Manual observation <b>by evening</b>'}};
    h.broadcast(data);assert.equal(h.$('reset-deadline-label').textContent,'观察截止 · 待确认');
    assert.equal(h.$('reset-probability-24').textContent,'--');assert.equal(h.$('reset-announcement').hidden,false);
    assert.match(h.$('reset-announcement').title,/观察窗口/);assert.match(h.$('reset-announcement').title,/<b>by evening<\/b>/);
    h.advance(2*3600e3);h.updateResetForecastDeadline();assert.equal(h.$('reset-deadline-label').textContent,'已到观察时间 · 待确认');
    h.language('en');h.renderResetForecast({...data,signal:{...data.signal,state:'expired'}});
    assert.equal(h.$('reset-signal').textContent,'Observation window passed');
    assert.equal(h.$('reset-deadline-label').textContent,'Observation window passed · unconfirmed');
  });
  test(`${platform}: Tibo reporting completion remains distinct from a confirmed quota reset`, () => {
    const h=harness(folder),data={...forecast,signal:{...forecast.signal,kind:'pending',pending:'done'}};
    h.broadcast(data);assert.equal(h.$('reset-signal').textContent,'Tibo 表示已重置');
    assert.equal(h.$('reset-deadline').textContent,'仍待核实');assert.equal(h.$('reset-deadline-label').textContent,'Tibo 自述 · 待确认');
    h.advance(3*3600e3);h.updateResetForecastDeadline();assert.equal(h.$('reset-deadline').textContent,'仍待核实');
    h.language('en');h.renderResetForecast(data);assert.equal(h.$('reset-signal').textContent,'Tibo reports a reset');
    assert.equal(h.$('reset-deadline').textContent,'Still unverified');assert.equal(h.$('reset-deadline-label').textContent,'Tibo report · unconfirmed');
    h.renderResetForecast({...data,status:'stale'});assert.equal(h.$('reset-signal').textContent,'Cached signal · verify');
    assert.equal(h.$('reset-deadline-label').textContent,'Cached report · verify online');
    assert.equal(h.$('reset-announcement').hidden,false);
  });
  test(`${platform}: refresh deduplicates, preserves broadcasts over delayed replies and recovers from failure`, async () => {
    const h = harness(folder);let resolve;
    h.maid.refreshResetForecast=()=>{h.calls.push('refresh');return new Promise(done=>{resolve=done;});};
    const pending=h.refreshResetForecast();await h.refreshResetForecast();assert.deepEqual(h.calls,['refresh']);
    assert.equal(h.$('resetForecast-view').attributes['aria-busy'],'true');assert.equal(h.$('reset-forecast-status').textContent,'正在刷新…');
    h.broadcast({...forecast,probability24h:99});resolve({...forecast,probability24h:1});await pending;
    assert.equal(h.$('reset-probability-24').textContent,'99%');assert.equal(h.state().resetForecast.probability24h,99);
    assert.equal(h.$('resetForecast-view').attributes['aria-busy'],'false');
    h.maid.refreshResetForecast=async()=>{throw new Error('synthetic network failure');};await h.refreshResetForecast();
    assert.equal(h.state().resetForecast.status,'stale');assert.match(h.$('reset-forecast-status').textContent,/缓存/);
    h.maid.refreshResetForecast=async()=>forecast;await h.refreshResetForecast();assert.equal(h.state().resetForecast.status,'live');
  });
  test(`${platform}: source button uses the fixed IPC and stops the enclosing bubble action`, async () => {
    const h = harness(folder);let stopped=0;
    h.$('reset-source').listeners.click({stopPropagation() {stopped++;}});await Promise.resolve();
    assert.equal(stopped,1);assert.deepEqual(h.calls,['source']);
    h.maid.openResetSource=async()=>{throw new Error('synthetic shell failure');};
    h.$('reset-source').listeners.click({stopPropagation() {}});await Promise.resolve();
    assert.match(h.notices.at(-1),/暂未打开/);
  });
  test(`${platform}: upgrading seven-page preferences appends only the forecast page`, () => {
    const {sanitize}=require(path.join(__dirname,'..',folder,'src/settings.cjs'));
    const order=['week','phrase','quota','conversation','lastTurn','accounts','today'];
    const hidden=['phrase','conversation','accounts'];
    const next=sanitize({bubblePageOrder:order,bubbleHiddenPages:hidden,mode:'today',defaultBubblePage:'week',phrases:['保留台词'],activeCharacterId:'custom-kept',sound:false});
    assert.deepEqual(next.bubblePageOrder,[...order,'resetForecast']);assert.deepEqual(next.bubbleHiddenPages,hidden);
    assert.equal(next.defaultBubblePage,'week');assert.equal(next.mode,'today');
    assert.deepEqual(next.phrases,['保留台词']);assert.equal(next.activeCharacterId,'custom-kept');assert.equal(next.sound,false);
    assert.equal(sanitize({...next,mode:'resetForecast',defaultBubblePage:'resetForecast'}).defaultBubblePage,'resetForecast');
  });
}
