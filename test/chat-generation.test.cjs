'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { ChatGeneration } = require('../src/chat-generation.cjs');
const { LIMITS } = require('../src/chat-policy.cjs');
const schema = { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false };
function fixture(t, generate) { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'maid-generation-')); t.after(() => fs.rmSync(root, { recursive: true, force: true })); const worker = new ChatGeneration({ projectRoot: root, countTokens: text => Buffer.byteLength(text), runtime: { generate } }); worker.begin({ id: 'task', sourceWatermark: 'source' }); return { root, worker }; }
test('maintenance reserves before dispatch, persists only allowed final JSON and reuses exact batches', async t => {
  let calls = 0; const { worker, root } = fixture(t, async input => { calls++; assert.equal(worker.task('task').used.calls, 1); assert.equal(input.model, 'gpt-6.1-sol'); assert.equal(input.effort, 'medium'); return { status: 'completed', finalText: '{"text":"final"}', reasoning: 'PRIVATE_REASONING', usage: { inputTokens: 10, raw: 'PRIVATE_RAW' } }; });
  const input = { taskId: 'task', batchId: 'one', stage: 'memory', instructions: 'extract', input: 'PRIVATE_PROMPT', outputSchema: schema };
  assert.equal((await worker.request(input)).output.text, 'final'); assert.equal((await worker.request(input)).reused, true); assert.equal(calls, 1);
  const files = []; const walk = directory => { for (const item of fs.readdirSync(directory, { withFileTypes: true })) item.isDirectory() ? walk(path.join(directory, item.name)) : files.push(fs.readFileSync(path.join(directory, item.name), 'utf8')); }; walk(root);
  assert.ok(files.every(text => !/PRIVATE_REASONING|PRIVATE_RAW|PRIVATE_PROMPT/.test(text)));
});
test('unknown execution is never replayed after restart or a new request', async t => {
  let calls = 0; const { worker, root } = fixture(t, async () => { calls++; throw Object.assign(new Error('offline'), { executionState: 'unknown' }); });
  const input = { taskId: 'task', batchId: 'one', stage: 'memory', instructions: 'extract', input: '', outputSchema: schema };
  await assert.rejects(worker.request(input)); await assert.rejects(worker.request(input), /UNKNOWN/);
  const reopened = new ChatGeneration({ projectRoot: root, countTokens: text => Buffer.byteLength(text), runtime: { generate: async () => { calls++; } } }); await assert.rejects(reopened.request(input), /UNKNOWN/); assert.equal(calls, 1);
});
test('unexpected output keys and exceeded input budget cannot be adopted', async t => {
  const { worker } = fixture(t, async () => ({ status: 'completed', finalText: '{"text":"x","reasoning":"never stored"}' }));
  const input = { taskId: 'task', batchId: 'one', stage: 'memory', instructions: 'extract', input: '', outputSchema: schema };
  await assert.rejects(worker.request({ ...input, inputLimit: 1 }), /BUDGET/); assert.equal(worker.task('task').used.calls, 0);
  await assert.rejects(worker.request(input), /OUTPUT/); assert.equal(worker.task('task').batches.one.status, 'invalid-output');
});
test('maintenance can return expanded node content above 6K while rejecting output beyond 20K',async t=>{
 let calls=0;const {worker}=fixture(t,async input=>{calls++;assert.equal(input.maxOutputTokens,LIMITS.node);return{status:'completed',finalText:JSON.stringify({text:'x'.repeat(calls===1?12000:LIMITS.node)})};});
 const input={taskId:'task',batchId:'expanded',stage:'tree',instructions:'synthetic expanded parent',input:'synthetic children',outputSchema:schema,maxOutputTokens:LIMITS.node};
 const first=await worker.request(input);assert.equal(first.output.text.length,12000);assert.equal(worker.task('task').used.output,LIMITS.node);
 await assert.rejects(worker.request({...input,batchId:'expanded-over'}),/OUTPUT_BUDGET/);assert.equal(worker.task('task').batches['expanded-over'].status,'invalid-output');assert.equal(calls,2);
 await assert.rejects(worker.request({...input,batchId:'parameter-over',maxOutputTokens:LIMITS.node+1}),/INPUT/);assert.equal(calls,2);
});

test('strict provider schemas retain optional local cache compatibility and never replay completed or unknown requests', async t => {
  let calls = 0, wire;
  const { worker } = fixture(t, async input => { calls++; wire = input.outputSchema; return { status: 'completed', finalText: '{"text":"old-result"}' }; });
  const local = { ...schema, properties: { ...schema.properties, signals: { type: 'array', items: { type: 'string' } } } }, strict = { ...local, required: ['text', 'signals'] };
  const input = { taskId: 'task', batchId: 'optional', stage: 'memory', instructions: 'extract', input: '', outputSchema: local };
  await worker.request(input);
  assert.equal((await worker.request({ ...input, providerOutputSchema: strict })).reused, true); assert.equal(calls, 1);
  await worker.request({ ...input, batchId: 'new-strict', providerOutputSchema: strict }); assert.deepEqual(wire.required, ['text', 'signals']); assert.equal(calls, 2);
  worker.runtime.generate = async () => { calls++; throw Object.assign(new Error('synthetic unknown'), { executionState: 'unknown' }); };
  await assert.rejects(worker.request({ ...input, batchId: 'unknown' }));
  await assert.rejects(worker.request({ ...input, batchId: 'unknown', providerOutputSchema: strict }), /UNKNOWN/); assert.equal(calls, 3);
});
