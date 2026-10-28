'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {ChatJournal}=require('../src/chat-journal.cjs');
function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'maid-journal-中文 '));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return {root,journal:new ChatJournal(root)};}
test('portable project paths reject traversal, Windows alternate streams and device names',t=>{
 const {journal}=fixture(t);for(const relative of ['../out','/absolute','C:/outside','memory/a:stream','memory/NUL.jsonl','memory/trailing.','memory/a\\b'])assert.throws(()=>journal.file(relative,true),/PATH_UNSAFE/);
});
test('a JSON null or corrupt journal cannot become an empty default and erase reserved work',t=>{
 const {root,journal}=fixture(t);fs.writeFileSync(path.join(root,'state.jsonl'),'null\n');
 assert.throws(()=>journal.read('state.jsonl'),/JOURNAL_INVALID/);assert.equal(fs.readFileSync(path.join(root,'state.jsonl'),'utf8'),'null\n');
});
test('asynchronous work holds the project lock until resolution and releases it on rejection',async t=>{
 const {journal}=fixture(t);let finish;const running=journal.locked('work.lock',()=>new Promise(resolve=>{finish=resolve;}));
 assert.throws(()=>journal.locked('work.lock',()=>{}),/BUSY/);finish(7);assert.equal(await running,7);
 await assert.rejects(journal.locked('work.lock',async()=>{throw Error('synthetic failure');}),/synthetic/);
 assert.equal(journal.locked('work.lock',()=>8),8);
});
