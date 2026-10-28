'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createChatProject } = require('../src/chat-project.cjs'), { createConversation, commitCheckpoint } = require('../src/chat-archive.cjs'), { MemoryStore } = require('../src/chat-memory.cjs'), { ChatHistory } = require('../src/chat-history.cjs');
function fixture(t, text) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'maid-history-')), project = createChatProject({ parentDir: sandbox, userNickname: '测试' }), measure = value => Buffer.byteLength(value);
  const memory = new MemoryStore({ projectRoot: project.root, countTokens: measure }); memory.initialize({ pet_name: '龙', user_nickname: '测试' });
  const conversation = createConversation({ root: project.root, startedAt: '2026-10-26T12:00:00+08:00', timezone: 'Asia/Shanghai', nativeThreadId: 'own-thread' });
  commitCheckpoint({ root: project.root, conversation, sourceComplete: true, trigger: 'new-conversation', records: [{ turn: { id: 'T1', observed_at: null } }, { id: 'M1', turn_id: 'T1', role: 'user', time: '2026-10-26T12:00:01+08:00', content: [{ text }] }, { turn_result: { id: 'T1', observed_at: null, status: 'completed' } }] });
  const history = new ChatHistory({ projectRoot: project.root, memory, measure, semanticOptions: { resourceRoot: path.join(sandbox, "missing-model") } }); t.after(async () => { await history.close(); fs.rmSync(sandbox, { recursive: true, force: true }); }); return { sandbox, project, memory, conversation, history };
}
test('persistent contentless index returns exact Unicode/escaped source ranges and survives reopen', async t => {
  const text = '🙂中文 "引号"\\换行\n皇家糖罐\t末尾不要取消。'.repeat(70), f = fixture(t, text); const result = await f.history.rebuildIndex(); assert.equal(result.status, 'ready');
  const turn = f.history.beginTurn(), search = await f.history.searchRecords({ queries: ['皇家糖罐', '取消'] }, turn); assert.ok(search.cards.length); assert.ok(search.cards.length <= 4);
  for (const card of search.cards) assert.equal(Array.from(text).slice(card.start, card.end).join(''), card.text);
  assert.equal(f.history.db.prepare('SELECT terms FROM postings LIMIT 1').get().terms, null);
  await f.history.close(); const resolved = f.history.resolveReference(search.cards[0].ref); assert.equal(resolved.text, search.cards[0].text);
  const next = await f.history.searchRecords({ queries: ['皇家糖罐'] }, turn); assert.ok(next.cards.every(card => !search.cards.some(old => old.ref === card.ref && old.start === card.start && old.end === card.end)));
});
test('exact references and bounded read share the same turn budget; native reads use it too', async t => {
  const f = fixture(t, '保留图像和最后否定，不要删除。'.repeat(100)); await f.history.rebuildIndex();
  const turn = f.history.beginTurn({ availableTokens: 900 }); const result = await f.history.readRecords({ reference: `${f.conversation.conversationId}/M1/P01`, start: 0, end: 20 }, turn); assert.equal(result.cards[0].text, '保留图像和最后否定，不要删除。保留图像和');
  await assert.rejects(f.history.readRecords({ references: [result.cards[0].ref] }, turn), /CALL_LIMIT/);
  f.history.getNative = async () => ({ cards: [{ ref: 'own-native', text: '只读活动thread' }], status: 'ready' });
  const small = f.history.beginTurn({ availableTokens: 100 }); const native = await f.history.nativeRecords({ query: '记录' }, small); assert.ok(Buffer.byteLength(JSON.stringify(native)) <= 100);
});
test('new saved exclusions invalidate original hits immediately without rebuilding', async t => {
  const f = fixture(t, '旧咖啡偏好'); await f.history.rebuildIndex();
  f.memory.save({ module: 'userView', operationId: 'create', baseVersion: 1, action: 'upsert', payload: { entry: { id: 'V-pref', kind: 'preference', content: '旧咖啡偏好' } } });
  const current = f.memory.getModule('userView'); current.entries[0].sources = [{ type: 'chat', conversationId: f.conversation.conversationId, messageId: 'M1' }];
  // Inject a source-resolved checkpoint to exercise the actual shared exclusion.
  f.memory.resolveSource = () => true; f.memory.commitCheckpoint({ taskId: 'checkpoint', operationWatermark: f.memory.getState().operationWatermark, baseVersions: { userView: 2 }, sourceWatermark: 'source', patches: [{ module: 'userView', action: 'upsert', automatic: false, payload: { entry: { id: 'V-new', kind: 'preference', content: '旧咖啡偏好', sources: current.entries[0].sources } } }] });
  f.memory.save({ module: 'userView', operationId: 'withdraw', baseVersion: 3, action: 'withdraw', payload: { id: 'V-new' } });
  const result = await f.history.searchRecords('咖啡', f.history.beginTurn()); assert.equal(result.cards.length, 0);
});

test('large first messages return a bounded excerpt and cannot trap pagination at the same offset',async t=>{
 const f=fixture(t,'原文🙂'.repeat(40000)); const page=await f.history.readConversation({conversationId:f.conversation.conversationId});
 assert.equal(page.messages.length,1); assert.equal(page.messages[0].partial,true); assert.equal(page.total,1); assert.ok(Buffer.byteLength(JSON.stringify(page))<256*1024);
 const empty=await f.history.readConversation({conversationId:f.conversation.conversationId,offset:1}); assert.equal(empty.messages.length,0);
});
test('capacity responses consume call permissions and native single-reference reads use the read slot',async t=>{
 const f=fixture(t,'测试'); await f.history.rebuildIndex(); const turn=f.history.beginTurn({availableTokens:0});
 await f.history.searchRecords('测试',turn); await f.history.searchRecords('测试',turn); await assert.rejects(f.history.searchRecords('测试',turn),/CALL_LIMIT/);
 f.history.getNative=async()=>({status:'ready',cards:[]}); const native=f.history.beginTurn(); await f.history.tools(native)({name:'read_record',arguments:{reference:'native-1'}}); await assert.rejects(f.history.tools(native)({name:'read_record',arguments:{reference:'native-2'}}),/CALL_LIMIT/);
});

test('one MiB indexing yields within 100ms and bounded first-query p95 stays below 1.5s on a populated persistent index',async t=>{
 const {performance}=require('node:perf_hooks'),f=fixture(t,'合成检索性能资料，保留最后否定。'.repeat(24000));let last=performance.now(),maxGap=0,samples=0;
 const timer=setInterval(()=>{const now=performance.now();maxGap=Math.max(maxGap,now-last);last=now;samples++;},5);
 try{await f.history.rebuildIndex();}finally{clearInterval(timer);maxGap=Math.max(maxGap,performance.now()-last);}
 const durations=[];for(let index=0;index<20;index++){const start=performance.now();const found=await f.history.searchRecords({queries:['检索','否定']},f.history.beginTurn());assert.ok(found.cards.length);durations.push(performance.now()-start);}
 durations.sort((a,b)=>a-b);const p95=durations[Math.ceil(durations.length*.95)-1];t.diagnostic(JSON.stringify({indexMaxEventLoopGapMs:maxGap,indexTimerSamples:samples,queryP95Ms:p95,sourceBytes:Buffer.byteLength('合成检索性能资料，保留最后否定。'.repeat(24000))}));assert.ok(samples>1);assert.ok(maxGap<100,`index gap ${maxGap}`);assert.ok(p95<1500,`query p95 ${p95}`);
});
