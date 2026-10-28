'use strict';
const { randomUUID } = require('node:crypto');
const { ChatJournal } = require('./chat-journal.cjs');
const { within } = require('./chat-policy.cjs');
const { estimateDreamBudget } = require('./chat-dream-budget.cjs');
const fail = code => { throw Object.assign(new Error(code), { code }); };
const LIVE = new Set(['pending', 'running', 'unknown', 'candidate', 'paused']);
const STATES = new Set([...LIVE, 'adopted', 'failed', 'cancelled', 'discarded', 'no-change']);
const safeQuota = q => q && ({ authType: q.authType, windowMinutes: q.windowMinutes, observedAt: q.observedAt,
  scope: q.scope, windowId: q.windowId, remaining: q.remaining, weekBlocked: q.weekBlocked, planType: q.planType,
  resolutionPoints: Number.isFinite(q.resolutionPoints) ? Math.max(.01, q.resolutionPoints) : 1, attribution: 'shared' });

// Whole-window percentage points are estimation targets, never fixed token
// conversions or service-enforced limits. Reservations survive cancel/restart.
class DreamManager {
  constructor({ projectRoot, fs, clock = Date.now, countTokens } = {}) {
    this.journal = new ChatJournal(projectRoot, { fs }); this.clock = clock; this.countTokens = countTokens;
  }
  state() {
    const state = this.journal.read('memory/dreaming/state.jsonl');
    if (!state) return { schema: 'codex-maid-dream/2', jobs: [], automaticWindows: [] };
    if (!['codex-maid-dream/1', 'codex-maid-dream/2'].includes(state.schema) || !Array.isArray(state.jobs) || !Array.isArray(state.automaticWindows) ||
        state.jobs.some(j => !/^D-[a-f0-9-]{36}$/.test(j.id || '') || !['automatic', 'manual'].includes(j.mode) || j.limit !== (j.mode === 'automatic' ? 5 : 15) ||
          !Number.isSafeInteger(j.calls) || j.calls < 0 || j.calls > 1 || !Number.isFinite(j.reservedPoints) || j.reservedPoints < 0 || !STATES.has(j.status))) fail('CHAT_DREAM_STATE_INVALID');
    return state;
  }
  _write(state) { state.schema = 'codex-maid-dream/2'; this.journal.write('memory/dreaming/state.jsonl', state); }
  estimate({ quota, model, effort } = {}) {
    return estimateDreamBudget(this.state().jobs, { quota, model, effort, now: this.clock() });
  }
  readiness({ mode, quota, task, environment } = {}) {
    const missing = [], now = this.clock(), limit = mode === 'automatic' ? 5 : mode === 'manual' ? 15 : null;
    if (limit === null) missing.push('invalid-mode');
    if (task?.committed !== true || !['sourceWatermark', 'baseline', 'target'].every(k => typeof task[k] === 'string' && task[k].length > 0 && task[k].length <= 256)) missing.push('committed-task-required');
    if (!Number.isFinite(now)) missing.push('clock-unverified');
    if (!environment || environment.foreground || environment.maintenance || environment.recovering || environment.drafts) missing.push('foreground-priority');
    if (!quota || quota.authType !== 'chatgpt' || quota.windowMinutes !== 300 || !Number.isFinite(quota.observedAt) || now < quota.observedAt || now - quota.observedAt > 30000 ||
        typeof quota.scope !== 'string' || !quota.scope || typeof quota.windowId !== 'string' || !quota.windowId || !Number.isFinite(quota.remaining) || quota.remaining < 0 || quota.remaining > 100 || quota.weekBlocked !== false) missing.push('quota-unverified');
    const budget = { ...this.estimate({ quota, model: task?.model, effort: task?.effort }), targetPoints: limit };
    if (limit !== null && (budget.estimatedPoints > limit || quota?.remaining < budget.estimatedPoints + 2)) missing.push('estimated-budget-exhausted');
    if (mode === 'automatic' && (task?.necessary !== true || !Number.isSafeInteger(task.newCheckpoints) || task.newCheckpoints < 8 || !Number.isFinite(task.lastDreamOrInitAt) || now - task.lastDreamOrInitAt < 7 * 86400000 ||
        !Number.isFinite(environment?.lastInputAt) || now - environment.lastInputAt < 1800000 || !quota || quota.remaining < 30)) missing.push('automatic-threshold');
    return { ready: !missing.length, missing, limit, budget };
  }
  begin(input) {
    const old = this.state().jobs.find(j => j.sourceWatermark === input.task?.sourceWatermark);
    const ready = this.readiness(input);
    if (old) {
      if (old.calls === 0 && old.reservedPoints === 0 && old.status === 'failed' && old.baseline === input.task.baseline && old.mode === input.mode && old.target === input.task.target && ready.ready) {
        return this.journal.locked('memory/dreaming/write.lock', () => { const state = this.state(), job = state.jobs.find(j => j.id === old.id);
          if (job.calls || job.reservedPoints || job.status !== 'failed') fail('CHAT_DREAM_ALREADY_ACTIVE');
          Object.assign(job, { status: 'pending', scope: input.quota.scope, windowId: input.quota.windowId, before: safeQuota(input.quota), budget: ready.budget, reason: undefined });
          this._write(state); return { ...job, ready: true, reused: true }; });
      }
      return { ...old, reused: true, ready: false };
    }
    if (!ready.ready) return { ready: false, status: 'budget-not-ready', missing: ready.missing, limit: ready.limit, budget: ready.budget };
    return this.journal.locked('memory/dreaming/write.lock', () => {
      const state = this.state();
      if (state.jobs.some(j => LIVE.has(j.status))) fail('CHAT_DREAM_ALREADY_ACTIVE');
      if (input.mode === 'automatic' && state.automaticWindows.includes(input.quota.windowId)) fail('CHAT_DREAM_WINDOW_ALREADY_USED');
      const job = { id: `D-${randomUUID()}`, mode: input.mode, limit: ready.limit, status: 'pending', sourceWatermark: input.task.sourceWatermark,
        baseline: input.task.baseline, target: input.task.target, scope: input.quota.scope, windowId: input.quota.windowId, calls: 0, reservedPoints: 0,
        budget: ready.budget, createdAt: this.clock(), adopted: false, operationWatermark: input.task.operationWatermark,
        checkpointCount: input.task.checkpointCount || 0, model: input.task.model, effort: input.task.effort, planType: input.quota.planType,
        module: input.task.module, baseVersion: input.task.baseVersion,
        entryRefs: input.task.entryRefs, versions: input.task.versions, before: safeQuota(input.quota) };
      state.jobs.push(job); if (input.mode === 'automatic') state.automaticWindows.push(input.quota.windowId);
      this._write(state); return { ...job, ready: true };
    });
  }
  reserve(id, input, { modelInput } = {}) {
    const ready = this.readiness(input); if (!ready.ready) fail('CHAT_DREAM_BUDGET_NOT_READY'); within(modelInput, 8000, this.countTokens);
    return this.journal.locked('memory/dreaming/write.lock', () => {
      const state = this.state(), job = state.jobs.find(j => j.id === id); if (!job) fail('CHAT_DREAM_MISSING');
      if (job.mode !== input.mode || job.scope !== input.quota.scope || job.windowId !== input.quota.windowId || job.baseline !== input.task.baseline || job.target !== input.task.target || job.sourceWatermark !== input.task.sourceWatermark) fail('CHAT_DREAM_SCOPE_CHANGED');
      if (!['pending', 'paused'].includes(job.status) || job.calls >= 1) fail('CHAT_DREAM_CALL_LIMIT');
      if (job.reservedPoints + ready.budget.estimatedPoints > job.limit) fail('CHAT_DREAM_POINT_LIMIT');
      job.calls++; job.reservedPoints += ready.budget.estimatedPoints; job.status = 'running'; job.startedAt = this.clock(); job.before = safeQuota(input.quota);
      this._write(state); return { id, budget: job.budget, estimatedPoints: job.reservedPoints };
    });
  }
  update(id, patch) {
    return this.journal.locked('memory/dreaming/write.lock', () => {
      const state = this.state(), job = state.jobs.find(j => j.id === id); if (!job) fail('CHAT_DREAM_MISSING');
      if (Object.keys(patch).some(k => !['locator', 'observation', 'usage', 'reason', 'taskSnapshot', 'adoptionCheckpointId'].includes(k))) fail('CHAT_DREAM_PATCH');
      Object.assign(job, patch); this._write(state); return job;
    });
  }
  observe(id, after) {
    const job = this.state().jobs.find(j => j.id === id); if (!job) fail('CHAT_DREAM_MISSING'); const before = job.before, now = this.clock(); let reason = null;
    if (!after || after.scope !== job.scope || after.windowId !== job.windowId) reason = 'scope-or-window-changed';
    else if (!before || before.windowMinutes !== 300 || after.windowMinutes !== 300 || !Number.isFinite(after.observedAt) || now < after.observedAt || now - after.observedAt > 30000 || after.observedAt < (job.finishedAt ?? job.startedAt) || !Number.isFinite(after.remaining) || after.remaining < 0 || after.remaining > 100) reason = 'quota-unverified';
    else if (after.remaining > before.remaining) reason = 'quota-reset-or-correction';
    const delta = reason ? null : Math.max(0, before.remaining - after.remaining);
    if (Number.isFinite(job.observation?.sameWindowChange) && (delta === null || delta < job.observation.sameWindowChange)) {
      return this.update(id, { observation: { ...job.observation, latestAttempt: { reason: reason || 'lower-shared-observation', at: now }, latestAfterRemaining: after?.remaining ?? null } });
    }
    return this.update(id, { observation: { sameWindowChange: delta, attribution: reason ? 'unknown' : 'shared', beforeRemaining: before?.remaining ?? null,
      afterRemaining: after?.remaining ?? null, reason, targetExceeded: delta === null ? null : delta > job.limit,
      resolutionPoints: Math.max(before?.resolutionPoints || 1, Number.isFinite(after?.resolutionPoints) ? Math.max(.01, after.resolutionPoints) : 1),
      afterObservedAt: after?.observedAt ?? null, at: now, guarantee: false } });
  }
  settle(id, { status, candidate, resolveSource, baseline, reason, confirmedRevalidation = false } = {}) {
    if (!['candidate', 'failed', 'cancelled', 'unknown', 'no-change'].includes(status)) fail('CHAT_DREAM_STATUS_INVALID');
    return this.journal.locked('memory/dreaming/write.lock', () => {
      const state = this.state(), job = state.jobs.find(j => j.id === id), revalidating = confirmedRevalidation === true && job?.status === 'failed' && job.reason === 'CHAT_DREAM_CANDIDATE_INVALID' && job.calls === 1 && job.locator?.threadId && job.taskSnapshot;
      if (!job || !['running', 'unknown', 'pending', 'paused'].includes(job.status) && !revalidating) fail('CHAT_DREAM_NOT_RUNNING');
      if (confirmedRevalidation && (!revalidating || !['candidate', 'no-change', 'failed'].includes(status))) fail('CHAT_DREAM_REVALIDATION_INVALID');
      if (status === 'candidate') {
        if (baseline !== job.baseline || !candidate || typeof candidate.text !== 'string' || !Array.isArray(candidate.refs) || !candidate.refs.length || typeof resolveSource !== 'function' ||
            candidate.refs.some(r => typeof r !== 'string' || !r || r.length > 512 || /[\0\r\n]/.test(r) || !resolveSource(r))) fail('CHAT_DREAM_CANDIDATE_INVALID');
        const allowed = { text: candidate.text, refs: candidate.refs };
        if (candidate.schema === 'codex-maid-dream-candidate/2') Object.assign(allowed, { schema: candidate.schema, changes: candidate.changes,
          dependencies: candidate.dependencies, evidence: candidate.evidence, scope: candidate.scope, signal: candidate.signal, payloadBytes: candidate.payloadBytes });
        if (candidate.module) Object.assign(allowed, { module: candidate.module, segments: candidate.segments, baseVersion: candidate.baseVersion, operationWatermark: candidate.operationWatermark, versions: candidate.versions, entryRefs: candidate.entryRefs });
        if (candidate.schema === 'codex-maid-dream-candidate/2') {
          within({ text: candidate.text, changes: candidate.changes }, 2000, this.countTokens);
          if (!Array.isArray(candidate.dependencies) || candidate.dependencies.length > 8 || !Array.isArray(candidate.evidence) || candidate.evidence.length > 6) fail('CHAT_DREAM_CANDIDATE_INVALID');
        } else within(allowed, 1000, this.countTokens);
        const relative = `memory/dreaming/candidates/${job.id}.jsonl`, next = { jobId: id, baseline, sourceWatermark: job.sourceWatermark, ...allowed }, old = this.journal.read(relative);
        if (old && JSON.stringify(old) !== JSON.stringify(next)) fail('CHAT_DREAM_CANDIDATE_CONFLICT'); if (!old) this.journal.write(relative, next, { exclusive: true });
      }
      job.status = status; if (revalidating) job.revalidatedAt = this.clock(); else job.finishedAt = this.clock();
      if (reason) job.reason = reason; else if (revalidating) delete job.reason;
      this._write(state); return job;
    });
  }
  recover() {
    return this.journal.locked('memory/dreaming/write.lock', () => {
      const state = this.state(); let changed = false;
      for (const job of state.jobs) if (job.status === 'running') { job.status = 'unknown'; job.reason = 'interrupted-before-terminal-confirmation'; changed = true; }
      else if (['pending', 'paused'].includes(job.status)) { job.status = job.calls ? 'unknown' : 'failed'; job.reason = job.calls ? 'interrupted-before-terminal-confirmation' : 'interrupted-before-reservation'; changed = true; }
      if (changed) this._write(state); return state;
    });
  }
  discard(id, reason) {
    return this.journal.locked('memory/dreaming/write.lock', () => { const state = this.state(), job = state.jobs.find(j => j.id === id);
      if (!job || job.status !== 'candidate') fail('CHAT_DREAM_NOT_CANDIDATE'); job.status = 'discarded'; job.reason = reason; this._write(state); return job; });
  }
  adopt(id, { checkpointId, baseline, sourceWatermark, validateAndCommit } = {}) {
    if (!checkpointId || typeof validateAndCommit !== 'function') fail('CHAT_DREAM_CHECKPOINT_REQUIRED');
    return this.journal.locked('memory/dreaming/write.lock', () => {
      const state = this.state(), job = state.jobs.find(j => j.id === id);
      if (!job || job.status !== 'candidate' || job.baseline !== baseline || job.sourceWatermark !== sourceWatermark) fail('CHAT_DREAM_BASELINE_CHANGED');
      const candidate = this.journal.read(`memory/dreaming/candidates/${job.id}.jsonl`);
      const complete = result => {
        if (result?.committed !== true) fail('CHAT_DREAM_ADOPTION_FAILED');
        job.adopted = result.state !== 'discarded'; job.status = job.adopted ? 'adopted' : 'discarded'; job.checkpointId = checkpointId; job.revision = result.revision;
        if (result.applied) job.adoption = { state: result.state, applied: result.applied, invalidated: result.invalidated || [] };
        if (result.applied) job.benefit = { sample: 'observed', linkedScopes: new Set(result.applied.map(item => item.module)).size,
          adoptedChanges: result.applied.length, invalidatedChanges: result.invalidated?.length || 0, semanticQualityVerified: false };
        this._write(state); return job;
      };
      const result = validateAndCommit(candidate, { jobId: id, checkpointId, modelCallsAllowed: 0 });
      return result && typeof result.then === 'function' ? Promise.resolve(result).then(complete) : complete(result);
    });
  }
}
module.exports = { DreamManager };
