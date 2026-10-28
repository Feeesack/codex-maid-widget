'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {ChatSearch,reciprocalRankFusion}=require('../src/chat-search.cjs');
const meter=s=>Array.from(s).length;
function fixture(t){const docs=new Map([
 ['C-one/M1/P1',{ref:'C-one/M1/P1',kind:'original',text:'喜欢皇家草莓糖，但不要删除原图。',committed:true}],
 ['L1-one@v1#I01',{ref:'L1-one@v1#I01',kind:'summary',text:'共同谈论皇家糖罐和图像保护。',committed:true}],
 ['C-pending/M1/P1',{ref:'C-pending/M1/P1',kind:'original',text:'未提交草莓糖',committed:false}]]);
 let epoch='v1';const withdrawn=new Set();
 const search=new ChatSearch({readSource:r=>docs.get(r),isEffective:r=>!withdrawn.has(r),getWatermark:()=>epoch,countTokens:meter});
 t.after(()=>search.close());search.rebuild([...docs.values()]);return {search,withdrawn,docs,change:()=>{epoch='v2';}};}
test('cross-layer Chinese single/bigrams find originals without a root hit; FTS stores no body',t=>{
 const {search}=fixture(t);const turn=search.beginTurn('t');const result=search.search('草莓糖',turn);
 assert.ok(result.cards.some(c=>c.ref==='C-one/M1/P1'));assert.ok(result.cards.every(c=>!c.ref.includes('pending')));
 assert.equal(search.db.prepare('SELECT terms FROM postings LIMIT 1').get().terms,null);
 assert.equal(search.db.prepare('SELECT COUNT(*) AS n FROM refs').get().n,2);
 const quoted=search.read(result.cards[0].ref,turn);assert.equal(quoted.text,'喜欢皇家草莓糖，但不要删除原图。');
});
test('saved withdrawals filter results and reads immediately before reindex; totals and calls bounded',t=>{
 const {search,withdrawn,change}=fixture(t);const turn=search.beginTurn('t');const result=search.search('草莓糖',turn);
 withdrawn.add(result.cards[0].ref);change();assert.throws(()=>search.read(result.cards[0].ref,turn),/UNAVAILABLE/);
 const next=search.search('草莓糖',turn);assert.equal(next.cards.length,0);assert.ok(turn.used<=3000);
 assert.throws(()=>search.search('糖',turn),/CALL_LIMIT/);
});
test('standard RRF deduplicates each list without inventing semantic evidence',()=>{
 assert.equal(reciprocalRankFusion([['a','b','a'],['b','c']])[0].ref,'b');
});
test('tool budgets cannot be forged and invalid read modes cannot bypass effective filtering',t=>{
 const {search}=fixture(t);assert.throws(()=>search.search('糖',{searches:0,reads:0,used:0}),/CALL_LIMIT/);
 const turn=search.beginTurn('t'),result=search.search('草莓糖',turn);
 assert.throws(()=>{turn.used=0;},TypeError);
 assert.throws(()=>search.read(result.cards[0].ref,turn,{intent:'anything'}),/QUERY_INVALID/);
});
test('exact source IDs can be read directly and a failed rebuild preserves the previous index',t=>{
 const {search}=fixture(t),turn=search.beginTurn('direct');
 assert.equal(search.read('C-one/M1/P1',turn).text,'喜欢皇家草莓糖，但不要删除原图。');
 assert.throws(()=>search.rebuild([{ref:'bad',kind:'unsupported',text:'x',committed:true}]),/DOCUMENT_INVALID/);
 const result=search.search('草莓糖',search.beginTurn('after-failure'));
 assert.ok(result.cards.some(card=>card.ref==='C-one/M1/P1'));
});
