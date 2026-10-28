'use strict';
const { randomUUID, createHash } = require('node:crypto');
const { ChatJournal } = require('./chat-journal.cjs');
const { ChatUsage } = require('./chat-usage.cjs');
const { DEFAULT_BUDGET } = require('./chat-maintenance.cjs');
const { tokens, LIMITS } = require('./chat-policy.cjs');

const fail = code => { throw Object.assign(new Error(code), { code }); };
const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));
function identifier(value) { if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(value)) fail('CHAT_GENERATION_ID'); return value; }
function validate(value, schema, depth = 0) {
  if (!schema || depth > 32) fail('CHAT_GENERATION_SCHEMA');
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('CHAT_GENERATION_OUTPUT');
    const properties = schema.properties || {};
    if (Object.keys(value).some(key => !Object.hasOwn(properties, key)) || (schema.required || []).some(key => !Object.hasOwn(value, key))) fail('CHAT_GENERATION_OUTPUT');
    for (const [key, item] of Object.entries(value)) validate(item, properties[key], depth + 1);
  } else if (schema.type === 'array') {
    if (!Array.isArray(value) || value.length < (schema.minItems || 0) || value.length > (schema.maxItems ?? 10000)) fail('CHAT_GENERATION_OUTPUT');
    for (const item of value) validate(item, schema.items, depth + 1);
  } else if (schema.type === 'string') {
    if (typeof value !== 'string' || value.length < (schema.minLength || 0) || value.length > (schema.maxLength ?? 1000000)) fail('CHAT_GENERATION_OUTPUT');
  } else if (schema.type === 'boolean') { if (typeof value !== 'boolean') fail('CHAT_GENERATION_OUTPUT'); }
  else if (schema.type === 'integer') { if (!Number.isSafeInteger(value)) fail('CHAT_GENERATION_OUTPUT'); }
  else if (schema.type === 'number') { if (!Number.isFinite(value)) fail('CHAT_GENERATION_OUTPUT'); }
  else if (schema.type === 'null') { if (value !== null) fail('CHAT_GENERATION_OUTPUT'); }
  else fail('CHAT_GENERATION_SCHEMA');
  if (schema.enum && !schema.enum.includes(value)) fail('CHAT_GENERATION_OUTPUT');
  return value;
}
function safeUsage(value) {
  const output = {};
  for (const key of ['inputTokens', 'cachedInputTokens', 'outputTokens', 'reasoningOutputTokens', 'totalTokens']) if (Number.isSafeInteger(value?.[key]) && value[key] >= 0) output[key] = value[key];
  return output;
}

// All model work goes through the dedicated runtime. This ledger contains
// reservations/identities, never prompts, source bodies or protocol events.
class ChatGeneration {
  constructor({ runtime, projectRoot, fs, measure, countTokens = measure, model = 'gpt-6.1-sol', effort = 'medium', clock = Date.now, monotonic = () => Number(process.hrtime.bigint()) / 1e6, limits = DEFAULT_BUDGET, onProgress = () => {}, usageLedger } = {}) {
    if (typeof runtime?.generate !== 'function' || typeof countTokens !== 'function') fail('CHAT_GENERATION_DEPENDENCY');
    this.runtime = runtime; this.journal = new ChatJournal(projectRoot, { fs }); this.countTokens = countTokens;
    this.usageLedger = usageLedger || new ChatUsage({projectRoot,fs,clock});
    this.model = model; this.effort = effort; this.clock = clock; this.monotonic = monotonic; this.limits = { ...DEFAULT_BUDGET, ...limits }; this.onProgress = onProgress;
    for (const key of ['calls', 'input', 'output', 'activeMs']) if (!Number.isSafeInteger(this.limits[key]) || this.limits[key] < 1) fail('CHAT_GENERATION_LIMITS');
    this.controllers = new Map(); this.stopped = false;
  }
  _path(id) { return `memory/maintenance/generation/${identifier(id)}.jsonl`; }
  task(id) {
    const task = this.journal.read(this._path(id));
    if (task && (task.schema !== 'codex-maid-generation/1' || task.id !== id || !task.used || !task.batches || !task.limits)) fail('CHAT_GENERATION_LEDGER_INVALID');
    return task;
  }
  begin({ id = randomUUID(), sourceWatermark, operationWatermark = 0 } = {}) {
    identifier(id);
    if (typeof sourceWatermark !== 'string' || !sourceWatermark || !Number.isSafeInteger(operationWatermark)) fail('CHAT_GENERATION_BASELINE');
    return this.journal.locked('memory/maintenance/generation.lock', () => {
      const old = this.task(id);
      if (old) { if (old.sourceWatermark !== sourceWatermark) fail('CHAT_GENERATION_BASELINE'); return old; }
      const task = { schema: 'codex-maid-generation/1', id, sourceWatermark, operationWatermark, model: this.model, effort: this.effort,
        limits: this.limits, used: { calls: 0, input: 0, output: 0, activeMs: 0 }, batches: {}, createdAt: this.clock() };
      this.journal.write(this._path(id), task); return task;
    });
  }
  stop() { this.stopped = true; for (const controller of this.controllers.values()) controller.abort(); }
  resume() { this.stopped = false; }
  output(taskId, batchId) {
    const task = this.task(taskId), candidates = [task?.batches[`${batchId}-repair`], task?.batches[batchId]], batch = candidates.find(value => value?.status === 'completed');
    if (!batch?.artifact) fail('CHAT_GENERATION_RESULT_MISSING');
    const output = this.journal.read(batch.artifact)?.output;
    if (batch.outputDigest && fingerprint(output) !== batch.outputDigest) fail('CHAT_GENERATION_RESULT_CHANGED');
    return clone(output);
  }
  async request({ taskId, batchId, stage, instructions, input, outputSchema, providerOutputSchema, maxOutputTokens = LIMITS.node, inputLimit = LIMITS.sourceBatch, signal } = {}) {
    identifier(taskId); identifier(batchId);
    if (this.stopped || signal?.aborted) fail('CHAT_MAINTENANCE_STOPPED');
    if (typeof instructions !== 'string' || !instructions || !Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > LIMITS.node) fail('CHAT_GENERATION_INPUT');
    const serializedInput = typeof input === 'string' ? input : JSON.stringify(input);
    const envelope = { instructions, input: serializedInput, outputSchema }, inputCount = tokens(providerOutputSchema ? { ...envelope, outputSchema: providerOutputSchema } : envelope, this.countTokens);
    if (inputCount > inputLimit) fail('CHAT_GENERATION_INPUT_BUDGET');
    const digest = fingerprint({ envelope, maxOutputTokens, model: this.model, effort: this.effort });
    const reservation = this.journal.locked('memory/maintenance/generation.lock', () => {
      const task = this.task(taskId); if (!task) fail('CHAT_GENERATION_TASK_MISSING');
      const old = task.batches[batchId];
      if (old && old.fingerprint !== digest) fail('CHAT_GENERATION_BATCH_CHANGED');
      if (old?.status === 'completed') return { reuse: true, artifact: old.artifact };
      if (old && ['inflight', 'unknown', 'invalid-output'].includes(old.status)) fail('CHAT_EXECUTION_UNKNOWN');
      if (Object.values(task.batches).some(batch => ['inflight', 'unknown'].includes(batch.status))) fail('CHAT_GENERATION_SERIAL_ONLY');
      if ((old?.attempts || 0) >= 2 || task.used.calls + 1 > task.limits.calls || task.used.input + inputCount > task.limits.input ||
          task.used.output + maxOutputTokens > task.limits.output || task.used.activeMs >= task.limits.activeMs) fail('CHAT_GENERATION_TASK_BUDGET');
      const batch = { fingerprint: digest, stage, status: 'inflight', attempts: (old?.attempts || 0) + 1, input: inputCount, output: maxOutputTokens, startedAt: this.clock() };
      task.batches[batchId] = batch; task.used.calls++; task.used.input += inputCount; task.used.output += maxOutputTokens;
      this.journal.write(this._path(taskId), task); return { reuse: false, remainingMs: task.limits.activeMs - task.used.activeMs, attempt: batch.attempts };
    });
    if (reservation.reuse) { const output = this.output(taskId, batchId); validate(output, outputSchema); if (tokens(output, this.countTokens) > maxOutputTokens) fail('CHAT_GENERATION_OUTPUT_BUDGET'); return { status: 'completed', output, reused: true }; }
    const controller = new AbortController(), key = `${taskId}/${batchId}`; this.controllers.set(key, controller);
    const usageId = this.usageLedger.begin({id:key+'/'+reservation.attempt,kind:'maintenance',stage,model:this.model,effort:this.effort,freshThread:true});
    const abort = () => controller.abort(); signal?.addEventListener('abort', abort, { once: true });
    const started = this.monotonic(), timer = setTimeout(abort, Math.min(reservation.remainingMs, 120000)); timer.unref?.();
    this.onProgress({ taskId, stage, batchId, status: 'running' });
    let result, output, status = 'unknown', usageExecutionState;
    try {
      result = await this.runtime.generate({ projectRoot: this.journal.root, purpose: 'maintenance', model: this.model, effort: this.effort,
        instructions, input: serializedInput, outputSchema: providerOutputSchema || outputSchema, maxOutputTokens, signal: controller.signal,
        onEvent:event=>{if(event.type==='locator')this.usageLedger.bind(usageId,{...event,freshThread:true});else if(event.type==='usage')this.usageLedger.observe({id:usageId,...event});} });
      status = result?.status;
      if (status !== 'completed') { if (!['failed', 'cancelled'].includes(status)) status = 'unknown'; fail(status === 'unknown' ? 'CHAT_EXECUTION_UNKNOWN' : 'CHAT_GENERATION_FAILED'); }
      try { output = validate(JSON.parse(result.finalText), outputSchema); if (tokens(output, this.countTokens) > maxOutputTokens) fail('CHAT_GENERATION_OUTPUT_BUDGET'); }
      catch (error) { status = 'invalid-output'; throw error; }
      return { status: 'completed', output, reused: false, usage: safeUsage(result.usage) };
    } catch (error) {
      usageExecutionState = error.executionState;
      if (error.executionState === 'not-executed') status = 'failed';
      if (error.executionState === 'unknown') status = 'unknown';
      throw error;
    } finally {
      clearTimeout(timer); signal?.removeEventListener('abort', abort); this.controllers.delete(key);
      this.journal.locked('memory/maintenance/generation.lock', () => {
        const task = this.task(taskId), batch = task.batches[batchId];
        const elapsed = this.monotonic() - started;
        task.used.activeMs += Number.isFinite(elapsed) && elapsed >= 0 ? Math.ceil(elapsed) : reservation.remainingMs;
        batch.status = status; batch.finishedAt = this.clock(); batch.usage = safeUsage(result?.usage); batch.usageRecordId = usageId;
        if (output && status === 'completed') {
          const artifact = `memory/maintenance/results/${taskId}-${batchId}.jsonl`;
          this.journal.write(artifact, { output }); batch.artifact = artifact; batch.outputDigest = fingerprint(output);
        }
        if (typeof result?.threadId === 'string') batch.threadId = result.threadId;
        if (typeof result?.requestId === 'string') batch.requestId = result.requestId;
        this.journal.write(this._path(taskId), task);
      });
      this.usageLedger.settle(usageId,{status:usageExecutionState==='not-executed'?'not-executed':status,tokens:result?.usage,threadId:result?.threadId,turnId:result?.turnId});
      this.onProgress({ taskId, stage, batchId, status });
    }
  }
  // Only an explicit native reconciliation can resolve an interrupted dispatch.
  reconcile({ taskId, batchId, status, finalText, outputSchema } = {}) {
    if (!['completed', 'failed', 'cancelled'].includes(status)) fail('CHAT_GENERATION_RECONCILE');
    return this.journal.locked('memory/maintenance/generation.lock', () => {
      const task = this.task(taskId), batch = task?.batches[batchId];
      if (!batch || !['unknown', 'inflight'].includes(batch.status)) fail('CHAT_GENERATION_RECONCILE');
      if (status === 'completed') {
        const output = validate(JSON.parse(finalText), outputSchema);
        if (tokens(output, this.countTokens) > batch.output) fail('CHAT_GENERATION_OUTPUT_BUDGET');
        batch.artifact = `memory/maintenance/results/${taskId}-${batchId}.jsonl`; this.journal.write(batch.artifact, { output }); batch.outputDigest = fingerprint(output);
      }
      batch.status = status; this.journal.write(this._path(taskId), task); this.usageLedger.settle(batch.usageRecordId,{status}); return clone(batch);
    });
  }
}
module.exports = { ChatGeneration, validate, fingerprint, safeUsage };
