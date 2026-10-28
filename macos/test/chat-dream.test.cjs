'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { DreamManager } = require('../src/chat-dream.cjs');
const meter = value => Buffer.byteLength(value);
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'maid-dream-中文 空格 '));
  t.after(() => fs.rmSync(root, { recursive: true, force: true })); let now = 1000000000;
  const input = { mode: 'automatic', quota: { authType: 'chatgpt', windowMinutes: 300, observedAt: now, scope: 'synthetic-scope', windowId: 'synthetic-window', remaining: 80, weekBlocked: false },
    task: { committed: true, sourceWatermark: 's1', baseline: 'v1', target: 'task1', necessary: true, newCheckpoints: 8, lastDreamOrInitAt: 0 },
    environment: { foreground: false, maintenance: false, recovering: false, drafts: false, lastInputAt: now - 1800001 } };
  const options = { projectRoot: root, clock: () => now, countTokens: meter };
  return { d: new DreamManager(options), input, root, options, advance: ms => { now += ms; } };
}
test('uncalibrated one-call allowance is an estimate with no invented token exchange or hard guarantee', t => {
  const { d, input } = fixture(t); const ready = d.readiness(input);
  assert.equal(ready.ready, true); assert.equal(ready.limit, 5); assert.equal(ready.budget.estimatedPoints, 3);
  assert.equal(ready.budget.guarantee, false); assert.equal(ready.budget.hiddenReasoningHardLimit, false);
  assert.equal(ready.budget.method, 'uncalibrated-small-task-allowance'); assert.equal(ready.budget.visibleOutputTarget, 2000);
});
test('automatic thresholds and manual bypass never bypass fresh quota, weekly limits or foreground drafts', t => {
  const { d, input } = fixture(t), sparse = { ...input, task: { ...input.task, newCheckpoints: 1, lastDreamOrInitAt: 999999999 } };
  assert.equal(d.readiness(sparse).ready, false); assert.equal(d.readiness({ ...sparse, mode: 'manual' }).ready, true);
  for (const environment of [{ foreground: true }, { maintenance: true }, { recovering: true }, { drafts: true }]) assert.equal(d.readiness({ ...input, environment: { ...input.environment, ...environment } }).ready, false);
  for (const quota of [{ observedAt: input.quota.observedAt - 30001 }, { windowMinutes: 10080 }, { weekBlocked: true }, { remaining: null }, { scope: null }]) assert.equal(d.readiness({ ...input, quota: { ...input.quota, ...quota } }).ready, false);
});
test('one task cannot split, upgrade mode or clear reservations across restart, cancel or a new window', t => {
  const { d, input, options } = fixture(t), job = d.begin(input); assert.equal(d.begin({ ...input, mode: 'manual' }).id, job.id);
  assert.throws(() => d.begin({ ...input, mode: 'manual', task: { ...input.task, target: 'another', sourceWatermark: 'other-source' } }), /ALREADY_ACTIVE/);
  assert.throws(() => d.reserve(job.id, { ...input, mode: 'manual' }, { modelInput: 'x' }), /SCOPE/);
  d.reserve(job.id, input, { modelInput: 'x' }); const reopened = new DreamManager(options); reopened.recover();
  assert.equal(reopened.state().jobs[0].status, 'unknown'); assert.equal(reopened.state().jobs[0].reservedPoints, 3);
  assert.throws(() => reopened.reserve(job.id, input, { modelInput: 'x' }), /CALL/);
  assert.equal(reopened.begin({ ...input, quota: { ...input.quota, windowId: 'next' } }).id, job.id);
});
test('shared-window change raises future estimates without claiming model attribution; reset leaves unknown', t => {
  const { d, input } = fixture(t), job = d.begin(input); d.reserve(job.id, input, { modelInput: 'x' });
  d.settle(job.id, { status: 'no-change' }); d.observe(job.id, { ...input.quota, remaining: 76 });
  assert.equal(d.state().jobs[0].observation.sameWindowChange, 4); assert.equal(d.state().jobs[0].observation.attribution, 'shared');
  assert.equal(d.estimate({ quota: input.quota }).estimatedPoints, 7); assert.equal(d.estimate().sampleCount, 0); assert.equal(d.readiness(input).ready, false); assert.equal(d.readiness({ ...input, mode: 'manual' }).ready, true);
  d.observe(job.id, { ...input.quota, windowId: 'next' }); assert.equal(d.state().jobs[0].observation.sameWindowChange, 4);
  assert.equal(d.state().jobs[0].observation.latestAttempt.reason, 'scope-or-window-changed'); assert.equal(d.state().jobs[0].reservedPoints, 3);
});
test('source candidates remain separate until matching next checkpoint adoption and cannot carry hidden nested content', t => {
  const { d, input } = fixture(t), job = d.begin(input); d.reserve(job.id, input, { modelInput: 'x' });
  assert.throws(() => d.settle(job.id, { status: 'candidate', baseline: 'v1', candidate: { text: 'x', refs: [{ ref: 'C-one/M1', reasoning: 'forbidden' }] }, resolveSource: () => true }), /CANDIDATE_INVALID/);
  d.settle(job.id, { status: 'candidate', baseline: 'v1', candidate: { text: '有来源整理', refs: ['C-one/M1'] }, resolveSource: () => true });
  assert.equal(d.state().jobs[0].adopted, false);
  assert.throws(() => d.adopt(job.id, { checkpointId: 'cp', baseline: 'v2', sourceWatermark: 's1', validateAndCommit: () => ({ committed: true }) }), /BASELINE/);
  const adopted = d.adopt(job.id, { checkpointId: 'cp', baseline: 'v1', sourceWatermark: 's1', validateAndCommit: (_candidate, budget) => { assert.equal(budget.modelCallsAllowed, 0); return { committed: true, revision: 'view-2' }; } });
  assert.equal(adopted.adopted, true); assert.equal(adopted.reservedPoints, 3);
});
test('corrupt stored state is never replaced with an empty budget ledger', t => {
  const { d } = fixture(t); d.journal.write('memory/dreaming/state.jsonl', { schema: 'broken', jobs: [] });
  assert.throws(() => d.recover(), /STATE_INVALID/); assert.equal(d.journal.read('memory/dreaming/state.jsonl').schema, 'broken');
});
test('a crash before reservation can resume the same ID without clearing a dispatched reservation', t => {
  const { d, input, options } = fixture(t), pending = d.begin(input), reopened = new DreamManager(options);
  reopened.recover(); assert.equal(reopened.state().jobs[0].status, 'failed'); assert.equal(reopened.state().jobs[0].reason, 'interrupted-before-reservation');
  const resumed = reopened.begin({ ...input, quota: { ...input.quota, scope: 'new-anonymous-connection' } });
  assert.equal(resumed.id, pending.id); assert.equal(resumed.ready, true); assert.equal(resumed.calls, 0);
  reopened.reserve(resumed.id, { ...input, quota: { ...input.quota, scope: 'new-anonymous-connection' } }, { modelInput: 'synthetic' });
  const next = new DreamManager(options); next.recover(); assert.equal(next.state().jobs[0].status, 'unknown'); assert.equal(next.state().jobs[0].calls, 1);
});
test('source identity cannot be split by renaming a task and an unreserved automatic task cannot be upgraded to manual', t => {
 const { d,input,options }=fixture(t),pending=d.begin(input),reopened=new DreamManager(options);reopened.recover();
 const manual=reopened.begin({...input,mode:'manual'});assert.equal(manual.id,pending.id);assert.equal(manual.ready,false);assert.equal(manual.limit,5);assert.equal(manual.budget.targetPoints,5);
 const automatic=reopened.begin(input);assert.equal(automatic.ready,true);reopened.reserve(automatic.id,input,{modelInput:'x'});reopened.settle(automatic.id,{status:'no-change'});
 const renamed=reopened.begin({...input,task:{...input.task,target:'renamed'}});assert.equal(renamed.id,pending.id);assert.equal(renamed.calls,1);assert.equal(renamed.ready,false);
});
