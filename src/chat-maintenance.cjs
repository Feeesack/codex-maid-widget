'use strict';
const { randomUUID } = require('node:crypto');
const { ChatJournal } = require('./chat-journal.cjs');
const { LIMITS, TERMINAL } = require('./chat-policy.cjs');
const STAGES = Object.freeze(['archive', 'memory', 'tree', 'handoff', 'validate', 'load', 'switch']);
// Engineering bounds, not a conversion from tokens to plan percentage. Runtime
// automation remains disabled until the conformance matrix has been verified.
// Conservative UTF-8 upper-bound accounting includes JSON/schema wrapping and
// recursive carry. These finite limits accommodate the 1 MiB fallback source.
const DEFAULT_BUDGET = Object.freeze({ calls: 96, input: 3000000, output: LIMITS.node * 32, activeMs: 900000, queue: 8 });
function limitsValid(value) { return value && Object.keys(DEFAULT_BUDGET).every(k => Number.isSafeInteger(value[k]) && value[k] > 0); }
function safeId(id) { if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw new Error('CHAT_TASK_ID_INVALID'); return id; }

class MaintenanceTask {
  constructor({ projectRoot, fs, clock = () => Date.now(), budget = DEFAULT_BUDGET } = {}) {
    if (!limitsValid(budget)) throw new Error('CHAT_TASK_LIMITS_REQUIRED');
    this.journal = new ChatJournal(projectRoot, { fs }); this.clock = clock;
    this.budget = { ...budget }; this.queue = [];
  }
  get() {
    const task=this.journal.read('memory/maintenance/active.jsonl');
    if(!task)return null;
    if(task.schema!=='codex-maid-maintenance/1'||!['checkpoint','subtask'].includes(task.kind)||!limitsValid(task.limits)||
       !task.used||!['calls','input','output','activeMs'].every(k=>Number.isSafeInteger(task.used[k])&&task.used[k]>=0)||
       !Array.isArray(task.plan)||!task.plan.length||task.plan.some(p=>!STAGES.includes(p.stage)||!['pending','inflight','unknown','completed','failed'].includes(p.state)||
         !Number.isSafeInteger(p.attempts)||p.attempts<0||p.attempts>2||!Number.isSafeInteger(p.input)||p.input<0||!Number.isSafeInteger(p.output)||p.output<0))throw new Error('CHAT_TASK_STATE_INVALID');
    return task;
  }
  begin({ id = randomUUID(), sourceWatermark, operationWatermark, terminal, plan, kind = 'checkpoint' }) {
    safeId(id);
    if (!TERMINAL.has(terminal)) throw new Error('CHAT_TERMINAL_UNVERIFIED');
    if (typeof sourceWatermark !== 'string' || !/^[a-zA-Z0-9_:@./-]{1,200}$/.test(sourceWatermark) || !Number.isSafeInteger(operationWatermark) || operationWatermark < 0 || !Array.isArray(plan) || !plan.length ||
        plan.some(p => !STAGES.includes(p.stage) || !Number.isSafeInteger(p.input) || p.input < 0 ||
          p.input > (p.stage === 'tree' && p.parent ? LIMITS.parentInput : LIMITS.sourceBatch) ||
          !Number.isSafeInteger(p.output) || p.output < 0 || p.output > LIMITS.node)) throw new Error('CHAT_TASK_PLAN_INVALID');
    if (plan.some((p,i) => i > 0 && STAGES.indexOf(p.stage) < STAGES.indexOf(plan[i-1].stage))) throw new Error('CHAT_STAGE_ORDER');
    if (!['checkpoint','subtask'].includes(kind) || kind === 'checkpoint' && STAGES.some(stage => !plan.some(p => p.stage === stage))) throw new Error('CHAT_CHECKPOINT_STAGES_REQUIRED');
    const safePlan = plan.map((p,i) => ({ id: `batch-${i + 1}`, stage: p.stage, input: p.input, output: p.output,
      state: 'pending', attempts: 0 }));
    if (safePlan.length > this.budget.calls || safePlan.reduce((s,p)=>s+p.input,0)>this.budget.input ||
        safePlan.reduce((s,p)=>s+p.output,0)>this.budget.output) throw new Error('CHAT_TASK_BUDGET_EXCEEDED');
    return this.journal.locked('memory/maintenance/write.lock', () => {
      const old=this.get();
      if (old && old.id === id) {
        if (old.sourceWatermark !== sourceWatermark || old.operationWatermark !== operationWatermark || old.kind !== kind ||
            JSON.stringify(old.plan.map(p=>({stage:p.stage,input:p.input,output:p.output}))) !== JSON.stringify(safePlan.map(p=>({stage:p.stage,input:p.input,output:p.output})))) throw new Error('CHAT_TASK_BASELINE_CHANGED');
        return old;
      }
      if (old && old.sourceWatermark === sourceWatermark) throw new Error('CHAT_TASK_SOURCE_ALREADY_PLANNED');
      if (old && !['completed','subtask-completed'].includes(old.state)) throw new Error('CHAT_TASK_ALREADY_ACTIVE');
      const task={schema:'codex-maid-maintenance/1',id,kind,state:'paused',sourceWatermark,operationWatermark,
        limits:this.budget,used:{calls:0,input:0,output:0,activeMs:0},plan:safePlan,startedAt:this.clock()};
      this.journal.write('memory/maintenance/active.jsonl',task); return task;
    });
  }
  enqueue(value) {
    if (this.queue.length >= this.budget.queue) return {accepted:false,reason:'queue-full'};
    if (!value || typeof value.id !== 'string' || typeof value.text !== 'string') throw new Error('CHAT_INPUT_INVALID');
    if (this.queue.some(i=>i.id===value.id)) return {accepted:true,duplicate:true};
    // Unsent body lives only here, never in the task metadata or a recovery log.
    this.queue.push({...value}); return {accepted:true};
  }
  takeQueued() { return this.queue.shift() || null; }
  update(work) {
    return this.journal.locked('memory/maintenance/write.lock',()=>{
      const task=this.get(); if(!task) throw new Error('CHAT_TASK_MISSING');
      const result=work(task); this.journal.write('memory/maintenance/active.jsonl',task); return result ?? task;
    });
  }
  resume({ sourceWatermark, operationWatermark }) {
    return this.update(task=>{
      if(task.sourceWatermark!==sourceWatermark || task.operationWatermark!==operationWatermark) throw new Error('CHAT_TASK_BASELINE_CHANGED');
      if(task.plan.some(p=>p.state==='inflight'||p.state==='unknown')) throw new Error('CHAT_EXECUTION_UNKNOWN');
      if(['completed','subtask-completed'].includes(task.state)) return task;
      if(task.used.activeMs>=task.limits.activeMs) throw new Error('CHAT_TASK_TIME_EXHAUSTED');
      task.state='running';
    });
  }
  stop() { return this.update(task=>{task.state='paused';}); }
  reserve(batchId, { quotaFresh = false, quotaAvailable = false } = {}) {
    return this.update(task=>{
      if(task.state!=='running'||!quotaFresh||!quotaAvailable) throw new Error('CHAT_TASK_NOT_READY');
      const batch=task.plan.find(p=>p.id===batchId); if(!batch) throw new Error('CHAT_BATCH_MISSING');
      if(batch.state==='completed') return {reuse:true};
      if(batch.state==='unknown'||batch.state==='inflight') throw new Error('CHAT_EXECUTION_UNKNOWN');
      if(task.plan.some(p=>p.state==='inflight'||p.state==='unknown')) throw new Error('CHAT_TASK_SERIAL_ONLY');
      const earliest=task.plan.find(p=>p.state!=='completed'); if(earliest!==batch) throw new Error('CHAT_STAGE_ORDER');
      if(batch.attempts>=2 || task.used.calls+1>task.limits.calls || task.used.input+batch.input>task.limits.input ||
          task.used.output+batch.output>task.limits.output || task.used.activeMs>=task.limits.activeMs) throw new Error('CHAT_TASK_BUDGET_EXCEEDED');
      // Reserve before dispatch. Unknown execution retains the complete reserve.
      task.used.calls++;task.used.input+=batch.input;task.used.output+=batch.output;
      batch.attempts++;batch.state='inflight';batch.dispatchedAt=this.clock(); return {reuse:false,batch:{...batch}};
    });
  }
  settle(batchId, { status, artifactVersion } = {}) {
    return this.update(task=>{
      const batch=task.plan.find(p=>p.id===batchId);
      if(!batch||!['inflight','unknown'].includes(batch.state)) throw new Error('CHAT_BATCH_NOT_INFLIGHT');
      if(!['completed','failed','unknown'].includes(status)) throw new Error('CHAT_BATCH_STATUS_INVALID');
      if(batch.state==='inflight') {
        const elapsed=this.clock()-batch.dispatchedAt;
        if(!Number.isFinite(elapsed)||elapsed<0) { task.state='paused';batch.state='unknown';return; }
        task.used.activeMs+=elapsed;
      }
      batch.state=status;
      if(status==='completed') {
        if(typeof artifactVersion!=='string'||!/^[a-zA-Z0-9_:@./-]{1,200}$/.test(artifactVersion)) throw new Error('CHAT_ARTIFACT_REQUIRED');
        batch.artifactVersion=artifactVersion;
      } else task.state='paused';
      if(task.used.activeMs>=task.limits.activeMs) task.state='paused';
      if(task.plan.every(p=>p.state==='completed')) task.state=task.kind==='checkpoint'?'completed':'subtask-completed';
    });
  }
}
module.exports={MaintenanceTask,DEFAULT_BUDGET,STAGES};
