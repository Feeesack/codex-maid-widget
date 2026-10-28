'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
// Pure renderer presentation only: no data-home, native readers or account data.
const view = require('../src/chat-view.js');
const dictionary = require('../src/i18n-chat.js');
const english = value => dictionary[value] || value;

test('context and desktop registration recovery explain why sending is blocked without discarding the existing chat', () => {
  assert.match(view.readinessText({ initialized: true, ready: false, contextRecoveryRequired: true }), /原对话和输入已保留.*核对恢复.*明确选择/);
  assert.match(view.readinessText({ initialized: true, ready: false, desktopProject: { registrationRequired: true } }), /Codex 项目栏添加桌宠专用项目目录.*核对连接/);
});

test('native writer conflicts explain the recoverable desktop lock instead of exposing an RPC code', () => {
  assert.match(view.readinessText({ initialized: true, ready: false, connection: { state: 'error', reason: 'THREAD_WRITER_CONFLICT' } }), /当前聊天正被 Codex 客户端占用.*关闭该聊天/);
  assert.match(view.readinessText({ initialized: true, ready: false, connection: { state: 'error', reason: 'THREAD_NOT_LOADED' } }), /当前聊天尚未恢复.*重试连接/);
});

test('registration details show the selected directory in management while the bubble stays concise', () => {
  const directory = 'Z:\\自定义 数据目录\\桌宠 资料\\codex-maid-chat';
  const state = { initialized: true, ready: false, desktopProject: { registrationRequired: true }, project: { directory } };
  assert.ok(view.readinessText(state, english, { includeProjectDirectory: true }).includes(`Project directory：${directory}`));
  assert.equal(view.readinessText(state, english).includes(directory), false);
});

test('partial historical grouping is visible even when new chat is ready', () => {
  const state = { initialized: true, ready: true, desktopProject: { desktopRegistered: true, reconciliation: { needsReconciliation: true } } };
  assert.match(view.readinessText(state), /部分旧对话尚未归入桌宠项目.*重试/);
  assert.match(view.readinessText(state, english), /older conversations.*reconcile again/);
});

test('dream estimates and shared observations are distinguished without a hard-cap promise', () => {
  const result = view.dreamPresentation({ state: 'candidate', budget: { targetPoints: 15, estimatedPoints: 2.125, reservedPoints: 3, method: 'uncalibrated-small-task-allowance' },
    observation: { sameWindowChange: 4, attribution: 'shared' }, candidates: [{ jobId: 'synthetic', status: 'candidate', content: 'Synthetic correction' }] }, english);
  assert.deepEqual(result.metrics, [['Estimated task target', '15 percentage points'], ['Estimated usage', '2.13 percentage points'], ['Accumulated estimate', '3 percentage points'], ['Total change in this quota window', '4 percentage points']]);
  assert.match(result.observation, /other activity/);
  assert.match(result.estimateNote, /No comparable observations/);
  assert.equal(result.candidates[0].label, 'Awaiting verification at the next handoff');
  assert.doesNotMatch(JSON.stringify(result), /guaranteed|hard cap|Adopt after verification/);
});

test('local duplicate checks cannot promise that a memory revision will be adopted', () => {
  const result = view.dreamPresentation({ state: 'completed', result: { candidates: [{ ref: 'V-synthetic@1' }], duplicates: [{}], expired: [], invalidReferences: [] } }, english);
  assert.deepEqual(result.candidates, []);
  assert.ok(result.checks.includes('Duplicate entries：1'));
  assert.ok(result.checks.includes('Local check results do not directly modify saved memory.'));
  assert.doesNotMatch(JSON.stringify(result), /next handoff|Adopted/);
});

test('unknown dream execution requires reconciliation rather than a second run', () => {
  const result = view.dreamPresentation({ state: 'unknown', observation: { sameWindowChange: null, attribution: 'unknown' } }, english);
  assert.equal(result.unknown, true);
  assert.match(result.detail, /does not resend/);
  assert.deepEqual(result.metrics.at(-1), ['Total change in this quota window', 'Unknown']);
});

test('adopted and invalidated candidates remain distinct', () => {
  const result = view.dreamPresentation({ state: 'completed', candidates: [{ jobId: 'one', status: 'adopted', content: 'one' }, { jobId: 'two', status: 'discarded', content: 'two' }] }, english);
  assert.deepEqual(result.candidates.map(candidate => candidate.label), ['Adopted', 'No longer applicable']);
});

test('retrieval health does not turn missing semantic coverage into ready', () => {
  assert.deepEqual(view.searchPresentation('ready', english), [['Lexical search', 'Ready'], ['Semantic search', 'Lexical fallback'], ['Index coverage', 'Ready']]);
  assert.deepEqual(view.searchPresentation({ lexical: 'ready', semantic: 'loading', index: 'partial' }, english), [['Lexical search', 'Ready'], ['Semantic search', 'Loading'], ['Index coverage', 'Partial coverage']]);
  assert.deepEqual(view.searchPresentation({ lexical: 'ready', semantic: 'ready', index: 'ready' }, english), [['Lexical search', 'Ready'], ['Semantic search', 'Ready'], ['Index coverage', 'Ready']]);
  assert.deepEqual(view.searchPresentation({ lexical: 'ready', semantic: 'ready', index: 'ready', pendingVectors: 3, vectorCoverage: 'partial' }, english), [['Lexical search', 'Ready'], ['Semantic search', 'Partial coverage'], ['Index coverage', 'Ready']]);
});

test('normal readiness no longer claims an unverified generation hard limit', () => {
  assert.equal(view.readinessText({ initialized: true, ready: false }, english), 'Sending is unavailable. Check readiness for details.');
});
test('saved pending memory is waiting for the next message, not an unverified feature', () => {
  const result=view.memorySyncPresentation({initialized:true,ready:true,memory:{pendingSync:true}},english);
  assert.equal(result.state,'pending-next-request');assert.equal(result.label,'Waiting for the next message');assert.match(result.detail,/Memory is saved/);assert.doesNotMatch(result.detail,/lost|Not verified/);
});
test('memory sync distinguishes disconnected, restored checking, acknowledged and confirmed failure', () => {
  const base={initialized:true,ready:true,connection:{state:'ready'},memory:{pendingSync:false}};
  assert.equal(view.memorySyncPresentation({...base,ready:false,connection:{state:'idle'}},english).label,'Not connected');
  assert.equal(view.memorySyncPresentation({...base,ready:false,unknownExecution:true},english).label,'Checking');
  assert.equal(view.memorySyncPresentation(base,english).label,'Synced with a request');
  assert.match(view.memorySyncPresentation(base,english).detail,/does not guarantee/);
  assert.equal(view.memorySyncPresentation({...base,memory:{sync:{state:'failed',confirmed:false}}},english).label,'Checking');
  assert.equal(view.memorySyncPresentation({...base,memory:{sync:{state:'failed',confirmed:true}}},english).label,'Synchronization failed');
  assert.equal(view.memorySyncPresentation({...base,memory:{pendingSync:true,sync:{state:'synced',confirmed:true}}},english).label,'Waiting for the next message');
});
test('partial candidate adoption, scan coverage and synthetic benefit are explicit', () => {
  const result=view.dreamPresentation({state:'partial',catalog:{scanned:40,total:120,scanComplete:false},budget:{sampleCount:3},benefit:{sample:'synthetic',beforeDuplicateItems:5,afterDuplicateItems:2,linkedScopes:2},candidates:[{jobId:'D-synthetic',content:'Synthetic organization',sources:['F-one@1','C-one/M1'],scope:{modules:['facts']},adoption:{state:'partial',applied:[{ref:'F-one@2'}],invalidated:[{ref:'F-two@1'}]}}]},english);
  assert.equal(result.candidates[0].label,'Partly adopted; remaining items are no longer applicable');assert.equal(result.candidates[0].sources.length,2);assert.match(result.coverage.join(' '),/40 \/ 120/);assert.match(result.coverage.join(' '),/remain unchecked/);assert.match(result.estimateNote,/3/);assert.match(result.benefits.join(' '),/synthetic/);assert.match(result.benefits.join(' '),/do not guarantee/);
  assert.deepEqual(view.dreamPresentation({benefit:{sample:'unknown',beforeDuplicateItems:3,afterDuplicateItems:0}},english).benefits,[]);
});
test('shared calibration and adoption counters never imply exact task cost or answer-quality gains', () => {
  const result=view.dreamPresentation({budget:{method:'shared-window-high-water-plus-margin',sampleCount:5,calibration:{attribution:'shared',exactTaskCostKnown:false}},benefit:{sample:'observed',modelCalls:4,candidates:2,adopted:1,unknown:1,adoptionRate:.5,semanticBenefitVerified:false}},english);
  assert.match(result.estimateNote,/Comparable observations：5/);assert.match(result.estimateNote,/cannot establish this task/);assert.match(result.benefits.join(' '),/Model requests sent：4/);assert.match(result.benefits.join(' '),/Candidate adoption rate：50%/);assert.match(result.benefits.join(' '),/do not guarantee better replies/);
});
