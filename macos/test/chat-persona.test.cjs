'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createDefaultPersona, buildPersonaView, restoreDefaultPersona, PersonaRuntime } = require('../src/chat-persona.cjs');
const { LIMITS } = require('../src/chat-policy.cjs');

function fixture(options = {}) {
  let wall = Date.parse('2026-10-26T10:00:00+08:00'), mono = 0;
  const runtime = new PersonaRuntime({ now: () => wall, monotonic: () => mono, verifySignal: () => true, verifyCompletion: () => true, ...options });
  const advance = ms => { wall += ms; mono += ms; };
  const signal = (kind = 'emotion', eventId = 'E-first', limits) => ({ kind, eventId, label: kind === 'emotion' ? '小得意' : '侦探故事', source: { threadId: 'thread-one', turnId: 'turn-1', itemId: eventId, at: new Date(wall).toISOString() }, ...(limits ? { limits } : {}) });
  let sequence = 0;
  const reply = (extra = {}) => {
    sequence++;
    const input = { requestId: `request-${sequence}`, threadId: 'thread-one', turnId: `turn-${sequence}`, ...extra };
    assert.equal(runtime.bindRequest(input).ready, true);
    const result = { ...input, status: 'completed', hasFinalAnswer: true, audience: 'user', ...extra };
    return { result, completion: runtime.onTurnResult(result) };
  };
  return { runtime, signal, advance, reply, jumpWall: ms => { wall += ms; } };
}
test('default persona uses only configured names, derived kingdom, and the specified fictional baseline', () => {
  const persona = createDefaultPersona({ user_nickname: '星河 ${notCode()} 中文' });
  const view = buildPersonaView(persona, { countTokens: text => Array.from(text).length });
  assert.equal(persona.names.pet_name, '小龙娘'); assert.equal(view.ready, true);
  assert.match(view.content, /星河 \$\{notCode\(\)\} 中文王朝/);
  assert.match(view.content, /草莓糖/); assert.match(view.content, /皇家糖罐/);
  assert.doesNotMatch(view.content, /小知|XiaoZhi|QWQ|陛下/);
  assert.match(view.content, /不冒充真实共同经历/);
  assert.equal(persona.growth.length, 0);
});
test('persona defaults do not derive a nickname from accounts, environment, or an empty field', () => {
  assert.throws(() => createDefaultPersona(), { code: 'PERSONA_NAME' });
  assert.throws(() => createDefaultPersona({ user_nickname: ' ' }), { code: 'PERSONA_NAME' });
  assert.throws(() => createDefaultPersona({ user_nickname: 'one\ntwo' }), { code: 'PERSONA_NAME' });
});
test('default, restored and rendered persona names share initialization display limits', () => {
  const invalid = [...Array.from({ length: 32 }, (_, index) => `前${String.fromCharCode(index)}后`), '前\u007f后', '前\u2028后', '前\u2029后', '名'.repeat(161), '🙂'.repeat(81)];
  for (const value of invalid) for (const field of ['pet_name', 'user_nickname']) {
    const names = { pet_name: '名字', user_nickname: '昵称', [field]: value };
    assert.throws(() => createDefaultPersona(names), { code: 'PERSONA_NAME' });
    assert.throws(() => restoreDefaultPersona({ names }), { code: 'PERSONA_NAME' });
    const persona = createDefaultPersona({ user_nickname: '昵称' }); persona.names = names;
    assert.throws(() => buildPersonaView(persona, { countTokens: () => 1 }), { code: 'PERSONA_NAME' });
  }
  const names = { pet_name: '名'.repeat(160), user_nickname: '🙂'.repeat(80) };
  assert.deepEqual(createDefaultPersona(names).names, names);
  assert.deepEqual(restoreDefaultPersona({ names }).names, names);
});
test('restoring default preserves current naming and does not mutate prior growth or history', () => {
  const old = createDefaultPersona({ pet_name: '晴', user_nickname: '流星' }); old.growth.push('旧兴趣');
  const restored = restoreDefaultPersona(old);
  assert.deepEqual(restored.names, old.names); assert.deepEqual(restored.growth, []);
  assert.deepEqual(old.growth, ['旧兴趣']);
});
test('unverified token measurement blocks view readiness and over-budget core is never truncated', () => {
  const persona = createDefaultPersona({ user_nickname: '昵称' });
  assert.equal(buildPersonaView(persona).reason, 'token-meter-unverified');
  assert.equal(buildPersonaView(persona, { countTokens: () => 1.1 }).reason, 'token-meter-unverified');
  persona.core.push('必要核心'.repeat(LIMITS.persona));
  const over = buildPersonaView(persona, { countTokens: text => Array.from(text).length });
  assert.equal(over.reason, 'persona-capacity'); assert.ok(over.segments.some(segment => segment.text.length > LIMITS.persona));
});
test('persona view uses the shared expanded cap and a caller can reserve its actual envelope', () => {
  const persona = createDefaultPersona({ user_nickname: '昵称' });
  persona.core = ['x'.repeat(7000)]; persona.preferences = []; persona.background = []; persona.examples = []; persona.boundaries = [];
  const original = JSON.stringify(persona), meter = text => Buffer.byteLength(text, 'utf8');
  const ready = buildPersonaView(persona, { countTokens: meter });
  assert.equal(ready.ready, true); assert.equal(ready.limit, 10000); assert.ok(ready.tokens > 7000);
  assert.equal(buildPersonaView(persona, { countTokens: meter, limit: 6500 }).reason, 'persona-capacity');
  const clamped = buildPersonaView(persona, { countTokens: meter, limit: 20000 }); assert.equal(clamped.limit, 10000);
  assert.equal(JSON.stringify(persona), original);
});
test('unverified natural emotion signals leave the basic style active', () => {
  const { signal } = fixture();
  const runtime = new PersonaRuntime();
  assert.equal(runtime.trigger(signal()).reason, 'signal-unverified'); assert.equal(runtime.snapshot().style, 'base');
});
test('three complete successful user answers fade and end a natural emotion, including its triggering turn', () => {
  const { runtime, signal, reply } = fixture(); runtime.onUserInput();
  assert.equal(runtime.trigger(signal()).applied, true); assert.equal(runtime.snapshot().emotion.phase, 'natural');
  reply(); assert.equal(runtime.snapshot().emotion.remaining, 2); assert.equal(runtime.snapshot().emotion.phase, 'receding');
  reply(); assert.equal(runtime.snapshot().emotion.remaining, 1); assert.equal(runtime.snapshot().emotion.phase, 'faint');
  reply(); assert.equal(runtime.snapshot().emotion, null);
});
test('duplicate completion, failures, cancellations, tool and maintenance tasks do not consume answers', () => {
  const { runtime, signal, reply } = fixture(); runtime.trigger(signal());
  const first = reply({ status: 'failed' }); assert.equal(first.completion.counted, false);
  assert.equal(runtime.onTurnResult(first.result).counted, false);
  reply({ status: 'cancelled' }); reply({ purpose: 'maintenance' }); reply({ audience: 'tool' });
  assert.equal(runtime.snapshot().emotion.remaining, 3);
  const successful = reply(); assert.equal(runtime.snapshot().emotion.remaining, 2);
  runtime.onTurnResult(successful.result); assert.equal(runtime.snapshot().emotion.remaining, 2);
});
test('old activity expires before a returning user input can refresh it', () => {
  const { runtime, signal, advance } = fixture(); runtime.onUserInput(); runtime.trigger(signal());
  advance(16 * 60000); assert.equal(runtime.onUserInput().emotion, null);
});
test('ordinary inputs do not renew a source, and the total thirty-minute limit remains', () => {
  const { runtime, signal, advance } = fixture(); const old = signal(); runtime.trigger(old);
  for (let index = 0; index < 6; index++) { advance(5 * 60000); runtime.onUserInput(); }
  assert.equal(runtime.snapshot().emotion, null);
  assert.equal(runtime.trigger(old).reason, 'duplicate-or-old-source');
});
test('roleplay continues beyond three answers, pauses after idle, and resumes only explicitly', () => {
  const { runtime, signal, reply, advance } = fixture(); runtime.onUserInput(); runtime.trigger(signal('roleplay'));
  for (let index = 0; index < 5; index++) reply();
  assert.equal(runtime.snapshot().scene.kind, 'roleplay');
  advance(31 * 60000); assert.equal(runtime.onUserInput().scene, null); assert.equal(runtime.snapshot().bookmark.kind, 'roleplay');
  assert.equal(runtime.resume().resumed, false); assert.equal(runtime.resume({ explicit: true }).resumed, true);
});
test('an explicit ten-minute scope does not gain a new duration after pause', () => {
  const { runtime, signal, advance } = fixture(); runtime.trigger(signal('roleplay', 'E-short', { durationMs: 10 * 60000 }), { explicit: true });
  advance(5 * 60000); runtime.pause(); advance(7 * 60000);
  assert.equal(runtime.resume({ explicit: true }).resumed, false); assert.equal(runtime.snapshot().bookmark, null);
});
test('explicit response counts and next-turn start override the default without resetting it', () => {
  const { runtime, signal, reply } = fixture();
  runtime.trigger(signal('emotion', 'E-next', { responses: 2, startNextTurn: true }), { explicit: true });
  reply(); assert.equal(runtime.snapshot().emotion.remaining, 2);
  reply(); assert.equal(runtime.snapshot().emotion.remaining, 1);
  reply(); assert.equal(runtime.snapshot().emotion, null);
});
test('two verified unrelated completed user answers pause an active topic; unknown is not unrelated', () => {
  const { runtime, signal, reply } = fixture(); runtime.trigger(signal('topic'));
  reply({ topicRelation: 'unrelated' }); reply({ topicRelation: 'unknown' });
  assert.equal(runtime.snapshot().scene.offTopic, 1);
  reply({ topicRelation: 'related' }); assert.equal(runtime.snapshot().scene.offTopic, 0);
  reply({ topicRelation: 'unrelated' }); reply({ topicRelation: 'unrelated' });
  assert.equal(runtime.snapshot().scene, null); assert.equal(runtime.snapshot().bookmark.phase, 'paused');
});
test('ending or replacing a state cannot be undone by an old callback or a repeated source', () => {
  const { runtime, signal } = fixture(); const first = signal(); runtime.trigger(first);
  runtime.bindRequest({ requestId: 'old-request', threadId: 'thread-one', turnId: 'turn-1' });
  runtime.end(); runtime.trigger(signal('emotion', 'E-new'));
  const before = runtime.snapshot().emotion.remaining;
  runtime.onTurnResult({ requestId: 'old-request', threadId: 'thread-one', turnId: 'turn-1', status: 'completed', hasFinalAnswer: true, audience: 'user' });
  assert.equal(runtime.snapshot().emotion.remaining, before);
  assert.equal(runtime.trigger(first).reason, 'duplicate-or-old-source');
});
test('unverified completion stops natural emotion and pauses scenes rather than invent exact counts', () => {
  const { runtime, signal, reply } = fixture({ verifyCompletion: () => false });
  runtime.trigger(signal()); runtime.trigger(signal('roleplay', 'E-role'));
  assert.equal(reply().completion.reason, 'completion-unverified');
  assert.equal(runtime.snapshot().emotion, null); assert.equal(runtime.snapshot().scene, null);
});
test('wall-clock rollback or forward jumps do not extend running emotions or resume scenes', () => {
  const { runtime, signal, jumpWall } = fixture(); runtime.trigger(signal()); runtime.trigger(signal('roleplay', 'E-role'));
  jumpWall(-60 * 60000); const snapshot = runtime.snapshot();
  assert.equal(snapshot.emotion, null); assert.equal(snapshot.scene, null); assert.equal(snapshot.bookmark.phase, 'paused');
});
test('checkpoint restore preserves remaining answers only with verified native continuity and always pauses scenes', () => {
  const { runtime, signal, reply, advance } = fixture(); runtime.trigger(signal()); reply(); reply();
  runtime.trigger(signal('roleplay', 'E-role')); const checkpoint = runtime.checkpointSnapshot();
  advance(1000);
  const fresh = fixture(); fresh.advance(1000);
  assert.equal(fresh.runtime.restoreCheckpoint(checkpoint).conservative, true);
  assert.equal(fresh.runtime.snapshot().emotion, null); assert.equal(fresh.runtime.snapshot().scene, null);
  assert.equal(fresh.runtime.snapshot().bookmark.phase, 'paused');
  const continued = fixture(); continued.advance(1000);
  continued.runtime.restoreCheckpoint(checkpoint, { nativeContinuityVerified: true });
  assert.equal(continued.runtime.snapshot().emotion.remaining, 1);
  assert.equal(continued.runtime.trigger(signal('roleplay', 'E-role')).applied, false);
});
test('restart after elapsed deadlines cannot revive an emotion or an expired explicit scene', () => {
  const { runtime, signal } = fixture(); runtime.trigger(signal()); runtime.trigger(signal('roleplay', 'E-short', { durationMs: 10 * 60000 }), { explicit: true });
  const checkpoint = runtime.checkpointSnapshot();
  const fresh = fixture(); fresh.advance(40 * 60000);
  fresh.runtime.restoreCheckpoint(checkpoint, { nativeContinuityVerified: true });
  assert.equal(fresh.runtime.snapshot().emotion, null); assert.equal(fresh.runtime.snapshot().bookmark, null);
});
test('PersonaRuntime performs no file IO and both platform sources remain identical', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/chat-persona.cjs'), 'utf8');
  assert.doesNotMatch(source, /require\(['"](?:node:)?fs['"]\)/);
  assert.equal(source, fs.readFileSync(path.join(__dirname, '../../src/chat-persona.cjs'), 'utf8'));
});

test('runtime snapshots project only allowed source metadata and reject unsafe restored times', () => {
  const { runtime, signal } = fixture();
  const input = signal(); input.source.reasoning = 'must not be retained'; input.source.access_token = 'synthetic-never-written';
  runtime.trigger(input);
  const checkpoint = runtime.checkpointSnapshot();
  assert.doesNotMatch(JSON.stringify(checkpoint), /reasoning|access_token|must not be retained/);
  const malformed = { ...checkpoint, lastInputAt: checkpoint.savedAt + 1000 };
  const fresh = fixture();
  assert.equal(fresh.runtime.restoreCheckpoint(malformed).restored, false);
});

test('same-answer schema hides controls and trusts only a verified native terminal once', () => {
  const {decodePersonaAnswer,applyAnswerSignals,PERSONA_ANSWER_SCHEMA}=require('../src/chat-persona.cjs');
  const now=Date.parse('2026-10-26T10:00:00+08:00'), runtime=new PersonaRuntime({now:()=>now,monotonic:()=>0});
  const decoded=decodePersonaAnswer(JSON.stringify({answer:'你好。',signals:[{kind:'emotion',label:'小得意',eventId:'one'}]}));
  assert.equal(PERSONA_ANSWER_SCHEMA.properties.signals.maxItems,2); assert.equal(decoded.answer,'你好。');
  const source={requestId:'r',threadId:'t',turnId:'u',itemId:'i',at:new Date(now).toISOString(),status:'completed'};
  assert.equal(applyAnswerSignals(runtime,decoded,source).applied,false);
  const result=applyAnswerSignals(runtime,decoded,{...source,sourceVerified:true}); assert.equal(result.applied,true); assert.equal(result.counted,true); assert.equal(result.snapshot.emotion.remaining,2);
  assert.equal(applyAnswerSignals(runtime,decoded,{...source,sourceVerified:true}).reason,'duplicate-answer');
  assert.equal(applyAnswerSignals(runtime,decoded,{...source,itemId:'failed',requestId:'failed',status:'interrupted',sourceVerified:true}).applied,false);
  assert.equal(decodePersonaAnswer('{"answer":"半句\\n原文\\u12',{partial:true}).answer,'半句\n原文');
  assert.equal(decodePersonaAnswer('{"answer":"\\\\',{partial:true}).answer,'\\');
  assert.equal(decodePersonaAnswer('旧纯文本').answer,'旧纯文本');
  assert.equal(decodePersonaAnswer('{"answer":"可见","signals":[{"kind":"emotion","label":"x","eventId":"e","reasoning":"禁止"}]}').signals.length,0);
});

test('same-answer explicit limits and resume require exact current user spans; topic relation counts only successful replies',()=>{
 const {decodePersonaAnswer,applyAnswerSignals}=require('../src/chat-persona.cjs');let wall=Date.parse('2026-10-26T10:00:00Z'),mono=0,sequence=0;const runtime=new PersonaRuntime({now:()=>wall,monotonic:()=>mono});
 const apply=(signal,userText='',topicRelation='unknown')=>{const n=++sequence;return applyAnswerSignals(runtime,decodePersonaAnswer(JSON.stringify({answer:'合成回答',signals:signal?[signal]:[],topicRelation})),{requestId:`r${n}`,threadId:'thread',turnId:`turn${n}`,itemId:`item${n}`,at:new Date(wall).toISOString(),status:'completed',sourceVerified:true,userText});};
 const userText='🙂演十分钟',span={start:1,end:Array.from(userText).length,text:'演十分钟'},limits={responses:null,durationMs:600000,idleMs:null,deadline:null,startNextTurn:false};
 const bounded={kind:'roleplay',eventId:'roleplay',label:'侦探故事',limits,sourceSpan:span};assert.equal(apply(bounded,'无关原话').applied,false);assert.equal(apply(bounded,userText).applied,true);assert.equal(runtime.snapshot().scene.durationMs,600000);
 apply(null,'','unrelated');assert.equal(runtime.snapshot().scene.offTopic,1);apply(null,'','unrelated');assert.equal(runtime.snapshot().scene,null);assert.ok(runtime.snapshot().bookmark);
 const resumeText='继续刚才的故事',resume={kind:'resume',eventId:'resume',label:'继续',limits:null,sourceSpan:{start:0,end:Array.from(resumeText).length,text:resumeText}};assert.equal(apply(resume,'你好').applied,false);assert.equal(apply(resume,resumeText).applied,true);
 wall+=601000;mono+=601000;assert.equal(runtime.snapshot().scene,null);assert.equal(runtime.snapshot().bookmark,null);
 const countText='从下一轮开始得意三次',counts={kind:'emotion',eventId:'count',label:'小得意',limits:{responses:3,durationMs:null,idleMs:null,deadline:null,startNextTurn:true},sourceSpan:{start:0,end:Array.from(countText).length,text:countText}};assert.equal(apply(counts,countText).snapshot.emotion.remaining,3);assert.equal(apply(null).snapshot.emotion.remaining,2);
 const malformed={...counts,eventId:'wrong',limits:{...counts.limits,responses:300}};assert.equal(apply(malformed,countText).applied,false);
});
