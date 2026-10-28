'use strict';

// The writer is deliberately explicit: normal chat has no persistence hook.
// Immutable JSONL revisions are prepared first; one atomic head replacement is
// the commit point. current/preinput/changes are repairable projections, never
// a reason to select the largest (possibly uncommitted) version on startup.
const nodeFs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { LIMITS } = require('./chat-policy.cjs');

const SCHEMA = 'codex-maid-memory/1';
const MODULES = Object.freeze({
  persona: { directory: 'persona', limit: LIMITS.persona, prefix: 'P', kinds: ['core', 'growth'] },
  userView: { directory: 'memory/user-view', limit: LIMITS.views, prefix: 'V', kinds: ['overall', 'impression', 'preference', 'habit', 'boundary'] },
  facts: { directory: 'memory/facts', limit: LIMITS.views, prefix: 'F', kinds: ['fact', 'relationship', 'plan', 'agreement'] },
});
const ACTIONS = new Set(['upsert', 'correct', 'withdraw', 'suspend', 'resume', 'pause-automatic', 'resume-automatic', 'relearn']);
const KINDS = new Set(['core', 'growth', 'overall', 'impression', 'preference', 'habit', 'boundary', 'fact', 'relationship', 'plan', 'agreement']);
const ENTRY_KEYS = new Set(['id', 'kind', 'content', 'certainty', 'subject', 'scope', 'recorded_at', 'valid_from', 'valid_to', 'last_supported_at', 'last_confirmed_at', 'sources', 'dependsOn', 'status', 'event_status', 'event_time', 'target_date', 'time_precision', 'time_expression', 'followup', 'importance', 'object_ids', 'relations', 'source_nature', 'speaker', 'replacement_refs', 'corrects', 'cancels']);
const STATUSES = new Set(['active', 'tentative', 'needs_review', 'withdrawn', 'suspended', 'corrected', 'superseded', 'conflict']);
const TERMINAL = new Set(['withdrawn', 'suspended', 'corrected', 'superseded']);
const clone = value => JSON.parse(JSON.stringify(value));
const hash = value => crypto.createHash('sha256').update(typeof value === 'string' ? value : stable(value)).digest('hex');
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function fail(code, message) { throw Object.assign(new Error(message), { code }); }
function object(value) { return value && typeof value === 'object' && !Array.isArray(value); }
function id(value, label = 'id') {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/.test(value)) fail('MEMORY_INPUT', `Invalid ${label}`);
  return value;
}
function timestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value) || !Number.isFinite(Date.parse(value))) fail('MEMORY_INPUT', 'An actual timestamp with timezone is required');
  return value;
}
function name(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 160 || /[\u0000-\u001f\u007f\u2028\u2029]/u.test(value)) fail('MEMORY_INPUT', 'Names must be nonempty single-line display text of at most 160 characters');
  return value;
}
function moduleInfo(module) { const result = Object.hasOwn(MODULES, module) && MODULES[module]; if (!result) fail('MEMORY_INPUT', 'Unknown memory module'); return result; }
function refOf(entry) { return `${entry.id}@${entry.rev}`; }
function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
}
function assertPlain(value) {
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint' || (typeof value === 'number' && !Number.isFinite(value))) fail('MEMORY_INPUT', 'Unsupported memory value');
  if (value && typeof value === 'object') {
    if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('MEMORY_INPUT', 'Only data objects are allowed');
    for (const [key, child] of Object.entries(value)) {
      if (['__proto__', 'prototype', 'constructor', 'reasoning', 'reasoning_text', 'reasoning_summary', 'access_token', 'apiKey', 'authToken', 'raw_event'].includes(key)) fail('MEMORY_INPUT', 'Internal protocol or credential fields are not memory');
      assertPlain(child);
    }
  }
}

class MemoryStore extends EventEmitter {
  constructor(options = {}) {
    super();
    if (!path.isAbsolute(options.projectRoot || '')) fail('MEMORY_ROOT', 'An explicit absolute project root is required');
    this.fs = options.fs || nodeFs;
    this.root = this.fs.realpathSync(options.projectRoot);
    if (!this.fs.statSync(this.root).isDirectory()) fail('MEMORY_ROOT', 'The selected project root is not a directory');
    this.clock = options.clock || (() => new Date().toISOString());
    this.countTokens = options.countTokens;
    this.resolveSource = options.resolveSource;
    this.isProcessAlive = options.isProcessAlive || processAlive;
    this.prepared = new Map();
    this.synced = new Map();
  }

  _path(relative, createParents = false) {
    if (typeof relative !== 'string' || path.isAbsolute(relative) || relative.split(/[\\/]/).some(part => !part || part === '..' || part === '.')) fail('MEMORY_PATH', 'Memory paths must stay inside the selected project');
    const parts = relative.split(/[\\/]/);
    let current = this.root;
    for (let index = 0; index < parts.length; index++) {
      current = path.join(current, parts[index]);
      let stat;
      try { stat = this.fs.lstatSync(current); } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        if (index < parts.length - 1 && createParents) this.fs.mkdirSync(current);
        continue;
      }
      if (stat.isSymbolicLink()) fail('MEMORY_PATH', 'Memory storage cannot traverse symbolic links');
      if (index < parts.length - 1 && !stat.isDirectory()) fail('MEMORY_PATH', 'A memory directory is not a directory');
    }
    return current;
  }

  _jsonl(relative) {
    const bytes = this.fs.readFileSync(this._path(relative));
    try {
      const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      if (!decoded.endsWith('\n')) fail('MEMORY_CORRUPT', 'Incomplete memory JSONL');
      return decoded.slice(0, -1).split('\n').map(line => { if (!line) throw new Error('empty record'); return JSON.parse(line); });
    } catch (error) { if (error.code === 'MEMORY_CORRUPT') throw error; fail('MEMORY_CORRUPT', 'Memory data is damaged; existing bytes were preserved'); }
  }

  _head(allowMissing = false) {
    let records;
    try { records = this._jsonl('memory/head.jsonl'); } catch (error) {
      if (allowMissing && error.code === 'ENOENT') return null;
      throw error;
    }
    const head = records[0]?.head;
    if (records.length !== 1 || head?.schema !== SCHEMA || !Number.isSafeInteger(head.revision) || head.revision < 1 || !object(head.modules) || !object(head.operations)) fail('MEMORY_CORRUPT', 'The committed memory head is invalid');
    for (const [module, descriptor] of Object.entries(head.modules)) {
      moduleInfo(module);
      if (!object(descriptor) || !Number.isSafeInteger(descriptor.version) || descriptor.version < 1 || !/^[a-f0-9]{64}$/.test(descriptor.sha256 || '') || typeof descriptor.path !== 'string') fail('MEMORY_CORRUPT', 'Invalid committed revision reference');
      this._path(descriptor.path);
    }
    return head;
  }

  _snapshot(head, module) {
    moduleInfo(module);
    const descriptor = head.modules[module];
    if (!descriptor) fail('MEMORY_NOT_INITIALIZED', 'Memory has not been initialized');
    const file = this._path(descriptor.path);
    const bytes = this.fs.readFileSync(file);
    if (hash(bytes.toString('utf8')) !== descriptor.sha256) fail('MEMORY_CORRUPT', 'Committed memory revision does not match its receipt');
    const records = this._jsonl(descriptor.path);
    const snapshot = records[0]?.snapshot;
    if (records.length !== 1 || snapshot?.schema !== SCHEMA || snapshot.module !== module || snapshot.version !== descriptor.version || !Array.isArray(snapshot.entries) || !Array.isArray(snapshot.exclusions)) fail('MEMORY_CORRUPT', 'Committed memory revision is invalid');
    return snapshot;
  }

  _write(relative, bytes, exclusive = false) {
    const file = this._path(relative, true);
    if (exclusive) {
      const fd = this.fs.openSync(file, 'wx', 0o600);
      try { this.fs.writeFileSync(fd, bytes); this.fs.fsyncSync(fd); } finally { this.fs.closeSync(fd); }
      return;
    }
    const temporary = `${relative}.pending-${crypto.randomUUID()}`;
    const staged = this._path(temporary, true);
    const fd = this.fs.openSync(staged, 'wx', 0o600);
    try { this.fs.writeFileSync(fd, bytes); this.fs.fsyncSync(fd); } finally { this.fs.closeSync(fd); }
    this.fs.renameSync(staged, file);
  }

  _locked(callback) {
    const relative = 'memory/.writer.lock';
    const file = this._path(relative, true);
    const token = crypto.randomUUID();
    let fd;
    for (let attempt = 0; attempt < 2; attempt++) {
      try { fd = this.fs.openSync(file, 'wx', 0o600); break; } catch (error) {
        if (error.code !== 'EEXIST' || attempt > 0) throw error;
        let old;
        try { old = JSON.parse(this.fs.readFileSync(file, 'utf8')); } catch { fail('MEMORY_BUSY', 'Memory writer status needs local recovery'); }
        if (!Number.isSafeInteger(old.pid) || typeof old.token !== 'string' || this.isProcessAlive(old.pid)) fail('MEMORY_BUSY', 'Another memory writer is active');
        // Only a confirmed abandoned lock is removed; revisions are retained.
        if (this.fs.readFileSync(file, 'utf8') !== JSON.stringify(old)) fail('MEMORY_BUSY', 'Memory writer changed during recovery');
        this.fs.unlinkSync(file);
      }
    }
    try {
      this.fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, token }));
      this.fs.fsyncSync(fd);
      return callback();
    } finally {
      this.fs.closeSync(fd);
      try { if (JSON.parse(this.fs.readFileSync(file, 'utf8')).token === token) this.fs.unlinkSync(file); } catch {}
    }
  }

  _commit(head, updates, operation, result) {
    const revision = (head?.revision || 0) + 1;
    const next = head ? clone(head) : { schema: SCHEMA, revision: 0, operationWatermark: 0, modules: {}, operations: {}, growthByTurn: {} };
    const commitId = crypto.randomUUID();
    for (const [module, snapshot] of Object.entries(updates)) {
      snapshot.previous = head?.modules[module] ? clone(head.modules[module]) : null;
      const relative = `${moduleInfo(module).directory}/revisions/${commitId}.jsonl`;
      const bytes = `${JSON.stringify({ snapshot })}\n`;
      this._write(relative, bytes, true);
      next.modules[module] = { version: snapshot.version, path: relative, sha256: hash(bytes) };
    }
    next.revision = revision;
    if (operation) {
      next.operationWatermark++;
      next.operations[hash(operation.id)] = { id: operation.id, digest: operation.digest, revision, result: clone(result) };
    }
    this._write('memory/head.jsonl', `${JSON.stringify({ head: next })}\n`);
    const projections = [];
    for (const [module, snapshot] of Object.entries(updates)) {
      try {
        const directory = moduleInfo(module).directory;
        this._write(`${directory}/current.jsonl`, `${JSON.stringify({ snapshot })}\n`);
        this._write(`${directory}/exclusions.jsonl`, snapshot.exclusions.map(exclusion => JSON.stringify({ exclusion })).join('\n') + (snapshot.exclusions.length ? '\n' : ''));
        if (snapshot.preinput) this._write(`${directory}/preinput.jsonl`, `${JSON.stringify({ preinput: snapshot.preinput })}\n`);
        if (operation) {
          const journal = this._path(`${directory}/changes.jsonl`, true);
          this.fs.appendFileSync(journal, `${JSON.stringify({ change: { operationId: operation.id, revision, module, version: snapshot.version, at: snapshot.updatedAt, committedSnapshot: next.modules[module].path } })}\n`, { mode: 0o600 });
        }
        projections.push({ module, ready: true });
      } catch { projections.push({ module, ready: false }); }
    }
    let notified = true;
    try { this.emit('commit', { revision, operationWatermark: next.operationWatermark, modules: Object.keys(updates) }); } catch { notified = false; }
    return { ...clone(result), revision, operationWatermark: next.operationWatermark, projections, notified };
  }

  initialize({ pet_name, user_nickname, persona = {} } = {}) {
    name(pet_name); name(user_nickname); assertPlain(persona);
    return this._locked(() => {
      if (this._head(true)) fail('MEMORY_EXISTS', 'Existing memory must be restored explicitly');
      const at = timestamp(this.clock());
      const updates = {};
      for (const module of Object.keys(MODULES)) updates[module] = { schema: SCHEMA, module, version: 1, updatedAt: at, entries: [], exclusions: [], autoFormation: { paused: false, cutoff: null }, preinput: null, sourceWatermark: null };
      updates.persona.names = { pet_name, user_nickname };
      // A built-in baseline is data supplied by the persona module, not an AI
      // extraction or a fabricated C/M conversation.
      if (Object.keys(persona).length) updates.persona.baseline = clone(persona);
      return this._commit(null, updates, null, { saved: true, versions: { persona: 1, userView: 1, facts: 1 } });
    });
  }

  getModule(module) { return clone(this._snapshot(this._head(), module)); }
  operationReceipt(operationId) { id(operationId); const value = this._head().operations[hash(operationId)]; return value ? clone(value.result) : null; }
  summaryCorrections() {
    const head = this._head(), repairs = Object.values(head.sourceRepairs || {}), snapshots = new Map();
    return repairs.map(repair => {
      if (!snapshots.has(repair.module)) snapshots.set(repair.module, this._snapshot(head, repair.module));
      const entry = snapshots.get(repair.module).entries.find(item => item.id === repair.id), effective = entry && this._effective(entry);
      return { memoryRef: entry ? refOf(entry) : repair.memoryRef, text: effective ? entry.content : '相关正式条目当前已撤回或待复核，旧摘要不作为当前事实。', sourceRefs: clone(repair.sourceRefs) };
    });
  }
  history(module, { entryId, offset = 0, limit = 50 } = {}) {
    moduleInfo(module);
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail('MEMORY_INPUT', 'Invalid history page');
    const head = this._head(), revisions = [], seen = new Set(); let descriptor = head.modules[module];
    while (descriptor) {
      const snapshot = this._snapshot({ modules: { [module]: descriptor } }, module);
      if (!seen.has(snapshot.version) && (!entryId || snapshot.entries.some(entry => entry.id === entryId))) { revisions.push({ revision: snapshot.version, version: snapshot.version, recordedAt: snapshot.updatedAt }); seen.add(snapshot.version); }
      descriptor = snapshot.previous;
    }
    return { module, revisions: revisions.slice(offset, offset + limit), total: revisions.length, nextOffset: offset + limit < revisions.length ? offset + limit : null };
  }
  revision(module, revision) {
    moduleInfo(module); if (!Number.isSafeInteger(revision) || revision < 1) fail('MEMORY_INPUT', 'Invalid revision');
    let descriptor = this._head().modules[module];
    while (descriptor) { const snapshot = this._snapshot({ modules: { [module]: descriptor } }, module); if (snapshot.version === revision) return { module, revision, snapshot: clone(snapshot) }; descriptor = snapshot.previous; }
    fail('MEMORY_REVISION_MISSING', 'The committed revision is unavailable');
  }
  restore({ module, revision, operationId, baseVersion } = {}) {
    moduleInfo(module); id(operationId); const archived = this.revision(module, revision).snapshot;
    return this._locked(() => {
      const head = this._head(), current = this._snapshot(head, module), digest = hash({ module, revision, operationId, baseVersion });
      const receipt = head.operations[hash(operationId)]; if (receipt) { if (receipt.digest !== digest) fail('MEMORY_ID_CONFLICT', 'Operation content changed'); return { ...receipt.result, duplicate: true }; }
      if (current.version !== baseVersion) fail('MEMORY_STALE', 'Memory changed before restoration');
      const at = timestamp(this.clock()), restored = clone(archived); restored.version = current.version + 1; restored.updatedAt = at;
      if (module === 'persona') { restored.namingSavedAt = at; restored.baselineSavedAt = at; }
      restored.exclusions = clone(current.exclusions); restored.autoFormation = clone(current.autoFormation); restored.preinput = null;
      restored.entries = restored.entries.filter(entry => !current.exclusions.some(exclusion => exclusion.entryId === entry.id || exclusion.sourceRefs?.some(ref => entry.sources.some(source => `${source.conversationId}/${source.messageId}` === ref))));
      const restoredRefs = new Map();
      for (const entry of restored.entries) { const oldRef = refOf(entry), latest = current.entries.find(item => item.id === entry.id); entry.rev = Math.max(entry.rev, latest?.rev || 0) + 1; restoredRefs.set(oldRef, refOf(entry)); entry.recorded_at = at; entry.sources = [{ type: 'operation', operationId, at }]; }
      for (const entry of restored.entries) for (const key of ['dependsOn', 'corrects', 'cancels', 'replacement_refs']) if (Array.isArray(entry[key])) entry[key] = entry[key].map(ref => restoredRefs.get(ref) || ref);
      for (const entry of current.entries) if (entry.kind === 'boundary' && entry.certainty === 'explicit' && !TERMINAL.has(entry.status) && !restored.entries.some(item => item.id === entry.id)) restored.entries.push(clone(entry));
      const result = { saved: true, module, version: restored.version, restoredFrom: revision };
      return this._commit(head, { [module]: restored }, { id: operationId, digest }, result);
    });
  }
  restorePersonaDefaults({ operationId, baseVersion } = {}) {
    const { createDefaultPersona } = require('./chat-persona.cjs');
    return this.save({ module: 'persona', operationId, baseVersion, action: 'upsert', payload: { persona: createDefaultPersona(this.getModule('persona').names), resetGrowth: true } });
  }
  getState() {
    const head = this._head();
    return { revision: head.revision, operationWatermark: head.operationWatermark, modules: Object.fromEntries(Object.keys(MODULES).map(module => [module, clone(this._snapshot(head, module))])) };
  }
  scanMaintenance({ cursor = { module: 0, offset: 0 }, limit = 48 } = {}) {
    const modules = Object.keys(MODULES);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 64 || !object(cursor) || !Number.isSafeInteger(cursor.module) || cursor.module < 0 || cursor.module >= modules.length || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0) fail('MEMORY_INPUT', 'Invalid maintenance page');
    const head = this._head(), module = modules[cursor.module], snapshot = this._snapshot(head, module), entries = snapshot.entries.slice(cursor.offset, cursor.offset + limit);
    const atEnd = cursor.offset + entries.length >= snapshot.entries.length;
    return { module, entries: clone(entries), descriptor: clone(head.modules[module]), operationWatermark: head.operationWatermark,
      nextCursor: atEnd ? { module: (cursor.module + 1) % modules.length, offset: 0 } : { module: cursor.module, offset: cursor.offset + entries.length },
      cycleComplete: atEnd && cursor.module === modules.length - 1, moduleTotal: snapshot.entries.length };
  }
  maintenanceDependency(reference, { descriptor } = {}) {
    const match = /^([PVF]-[A-Za-z0-9_-]+)@(\d+)$/.exec(reference || ''); if (!match) fail('MEMORY_INPUT', 'Invalid maintenance reference');
    const module = Object.keys(MODULES).find(key => MODULES[key].prefix === match[1][0]), head = this._head();
    if (descriptor && (!object(descriptor) || typeof descriptor.path !== 'string' || !descriptor.path.startsWith(`${MODULES[module].directory}/revisions/`))) fail('MEMORY_INPUT', 'Invalid immutable maintenance snapshot');
    const selected = descriptor || head.modules[module], snapshot = this._snapshot({ modules: { [module]: selected } }, module), entry = snapshot.entries.find(item => refOf(item) === reference);
    if (!entry) fail('MEMORY_STALE', 'A maintenance dependency changed');
    const chats = new Set((entry.sources || []).filter(source => source.type === 'chat').map(source => `${source.conversationId}/${source.messageId}`));
    const exclusions = snapshot.exclusions.filter(item => item.entryId === entry.id || item.ref === reference || item.sourceRefs?.some(ref => chats.has(ref)));
    const safety = hash({ exclusions, paused: snapshot.autoFormation?.paused === true, names: module === 'persona' ? snapshot.names : null, baselineSavedAt: snapshot.baselineSavedAt || null });
    return { module, ref: reference, entry: clone(entry), descriptor: clone(selected), fingerprint: hash(entry), safety, effective: this._effective(entry) };
  }
  commitDreamCandidate({ operationId, checkpointId, dependencies, changes, at } = {}) {
    id(operationId, 'dream operation'); id(checkpointId, 'checkpoint');
    if (!Array.isArray(dependencies) || dependencies.length > 8 || !Array.isArray(changes) || changes.length > 4) fail('MEMORY_INPUT', 'Dream changes must be bounded');
    assertPlain({ dependencies, changes }); const digest = hash({ operationId, checkpointId, dependencies, changes });
    return this._locked(() => {
      const head = this._head(), receipt = head.operations[hash(operationId)];
      if (receipt) { if (receipt.digest !== digest) fail('MEMORY_ID_CONFLICT', 'Dream adoption changed on retry'); return { ...clone(receipt.result), duplicate: true }; }
      const current = new Map(), invalid = new Map(), snapshots = {}, updates = {}, applied = [], invalidated = [];
      for (const dependency of dependencies) {
        try {
          const value = this.maintenanceDependency(dependency.ref);
          if (!value.effective || value.fingerprint !== dependency.fingerprint || value.safety !== dependency.safety) invalid.set(dependency.ref, 'dependency-changed-or-excluded');
          else current.set(dependency.ref, value);
        } catch { invalid.set(dependency.ref, 'dependency-missing'); }
      }
      const now = timestamp(at || this.clock()), targetSet = new Set();
      for (const change of changes) {
        const refs = [...new Set([change.target, ...(change.refs || [])])], dependency = current.get(change.target);
        const reason = refs.map(ref => invalid.get(ref) || (!current.has(ref) ? 'dependency-not-declared' : null)).find(Boolean);
        if (reason || !dependency || change.evidenceInvalid) { invalidated.push({ ref: change.target, reason: change.evidenceInvalid ? 'evidence-changed' : reason || 'dependency-missing' }); continue; }
        const { module, entry } = dependency;
        if (targetSet.has(change.target) || ['core', 'boundary', 'overall'].includes(entry.kind) || !['organize', 'source-repair', 'link', 'canonical'].includes(change.kind) || typeof change.content !== 'string' || !change.content.trim()) { invalidated.push({ ref: change.target, reason: 'protected-or-invalid-target' }); continue; }
        targetSet.add(change.target);
        if (module !== 'facts' && this._snapshot(head, module).autoFormation?.paused) { invalidated.push({ ref: change.target, reason: 'automatic-formation-paused' }); continue; }
        const related = refs.filter(ref => ref !== change.target).map(ref => current.get(ref));
        // Rewording is subordinate to every known qualifier and numeric fact.
        // Similarity never proves equivalence; canonical links additionally
        // require exactly equal claims and matching object/time/status fields.
        const originals = [dependency, ...related];
        const protectedParts = originals.flatMap(item => (item.entry.content.match(/[^。！？.!?\n]+[。！？.!?]?/gu) || []).filter(text => /不|没|未|无|仅|只有|除非|但是|但|not\b|never\b|unless\b|except\b/i.test(text)));
        const numbers = originals.flatMap(item => item.entry.content.match(/\d+(?:[.:/年月日-]\d+)*/g) || []);
        if (change.kind === 'source-repair' && !this._sameRepairClaim(entry.content, change.content, entry)) { invalidated.push({ ref: change.target, reason: 'repair-subject-or-claim-changed' }); continue; }
        if (change.kind !== 'link' && !(change.kind === 'source-repair' && change.verbatim === true) && (protectedParts.some(text => !change.content.includes(text.trim())) || numbers.some(number => !change.content.includes(number)))) { invalidated.push({ ref: change.target, reason: 'qualifier-or-number-not-preserved' }); continue; }
        const old = snapshots[module] || (snapshots[module] = this._snapshot(head, module)), snapshot = updates[module] || (updates[module] = clone(old));
        let canonical = null;
        if (change.kind === 'canonical') {
          const peer = related[0];
          if (!peer || peer.module !== module || peer.entry.canonical_ref || changes.some(other => other.target === peer.ref) || !this._sameClaim(peer.entry, entry)) { invalidated.push({ ref: change.target, reason: 'canonical-equivalence-unproven' }); continue; }
          canonical = peer.ref;
        }
        const next = clone(entry); next.rev++; next.recorded_at = now;
        if (!next.last_supported_at) next.last_supported_at = entry.recorded_at;
        if (change.kind === 'organize' || change.kind === 'source-repair') next.content = change.content;
        next.memory_links = [...new Set([...(next.memory_links || []), ...related.map(item => item.ref)])];
        if (canonical) next.canonical_ref = canonical;
        const sources = originals.flatMap(item => item.entry.sources || []);
        if (change.kind === 'source-repair') for (const reference of change.repairSourceRefs || []) {
          const match = /^(C-[\w-]+)\/(M\d+)(?:\/(P\d+))?$/.exec(reference);
          if (match) sources.push({ type: 'chat', conversationId: match[1], messageId: match[2], ...(match[3] ? { part: match[3] } : {}) });
        }
        next.sources = [...new Map(sources.map(source => [stable(source), source])).values()];
        next.maintenance = { jobId: operationId, checkpointId, kind: change.kind, fromRefs: refs, evidenceRefs: clone(change.evidenceRefs || []),
          ...(change.kind === 'source-repair' ? { repairSourceRefs: clone(change.repairSourceRefs || change.evidenceRefs || []), previousSourceRefs: (entry.sources || []).filter(source => source.type === 'chat').map(source => `${source.conversationId}/${source.messageId}${source.part ? `/${source.part}` : ''}`) } : {}), at: now };
        if (change.kind === 'source-repair') {
          head.sourceRepairs ||= {};
          const sourceRefs = [...new Set([...(head.sourceRepairs[entry.id]?.sourceRefs || []), ...next.maintenance.repairSourceRefs, ...next.maintenance.previousSourceRefs])].filter(reference => /^C-[\w-]+\/M\d+(?:\/P\d+)?$/.test(reference));
          head.sourceRepairs[entry.id] = { id: entry.id, module, memoryRef: refOf(next), sourceRefs };
        }
        snapshot.entries[snapshot.entries.findIndex(item => item.id === entry.id)] = next;
        applied.push({ from: change.target, to: refOf(next), module, kind: change.kind });
      }
      // Do not exclude the original chat sources: they still support the new
      // revision. Invalidate only projections and assertions derived from an
      // old memory revision, including dependencies held in another module.
      const replaced = new Set(applied.map(item => item.from)), invalidatedDerived = [];
      for (const module of Object.keys(MODULES)) {
        const old = updates[module] || this._snapshot(head, module), affected = old.entries.filter(entry => !applied.some(item => item.to === refOf(entry)) &&
          (entry.dependsOn?.some(ref => replaced.has(ref)) || entry.kind === 'overall' && applied.some(item => item.module === module) && !entry.dependsOn?.length));
        if (!affected.length && !applied.some(item => item.module === module)) continue;
        const snapshot = updates[module] || (updates[module] = clone(old));
        for (const entry of snapshot.entries) if (affected.some(item => item.id === entry.id)) { entry.status = 'needs_review'; entry.invalidatedBy = operationId; invalidatedDerived.push(refOf(entry)); }
        if (snapshot.preinput) snapshot.preinput.segments = snapshot.preinput.segments.filter(segment => !segment.refs.some(ref => replaced.has(ref) || invalidatedDerived.includes(ref)));
      }
      for (const [module, snapshot] of Object.entries(updates)) {
        if (!applied.some(item => item.module === module) && !snapshot.entries.some(entry => entry.invalidatedBy === operationId)) { delete updates[module]; continue; }
        snapshot.version++; snapshot.updatedAt = now;
      }
      const result = { committed: true, state: applied.length ? invalidated.length ? 'partial' : 'adopted' : 'discarded', applied, invalidated,
        invalidatedDerived, revision: head.revision + 1, modelCallsAllowed: 0 };
      return this._commit(head, updates, { id: operationId, digest, at: now, type: 'dream' }, result);
    });
  }

  _entry(module, input, previous, source) {
    if (!object(input)) fail('MEMORY_INPUT', 'A structured memory entry is required');
    for (const key of Object.keys(input)) if (!ENTRY_KEYS.has(key)) fail('MEMORY_INPUT', 'Unsupported memory entry field');
    assertPlain(input);
    const entryId = input.id || previous?.id || `${moduleInfo(module).prefix}-${crypto.randomUUID()}`;
    if (!new RegExp(`^${moduleInfo(module).prefix}-[A-Za-z0-9_-]+$`).test(entryId)) fail('MEMORY_INPUT', 'Entry ID belongs to a different module');
    if (!KINDS.has(input.kind || previous?.kind) || !moduleInfo(module).kinds.includes(input.kind || previous?.kind) || typeof (input.content ?? previous?.content) !== 'string' || !(input.content ?? previous?.content).trim()) fail('MEMORY_INPUT', 'A module-owned memory kind and nonempty final content are required');
    const entry = { ...(previous ? clone(previous) : {}), ...clone(input), id: entryId, rev: (previous?.rev || 0) + 1, recorded_at: source.at };
    // These fields are trusted transaction results, never extraction or
    // management payload. A new ordinary revision reopens any old alias.
    delete entry.canonical_ref; delete entry.memory_links; delete entry.maintenance;
    entry.status = input.status || 'active';
    entry.certainty = input.certainty || (source.type === 'operation' || source.explicit ? 'explicit' : 'tentative');
    if (!STATUSES.has(entry.status) || !['explicit', 'supported', 'tentative'].includes(entry.certainty)) fail('MEMORY_INPUT', 'Invalid memory state');
    if (entry.valid_from != null) timestamp(entry.valid_from);
    if (entry.valid_to != null) timestamp(entry.valid_to);
    if (entry.last_supported_at != null) timestamp(entry.last_supported_at);
    if (entry.last_confirmed_at != null) timestamp(entry.last_confirmed_at);
    if (entry.event_status != null && !['proposed', 'accepted', 'in_progress', 'completed', 'cancelled', 'superseded', 'disputed', 'unknown'].includes(entry.event_status)) fail('MEMORY_INPUT', 'Unknown fact or agreement status');
    const sources = input.sources || [];
    if (!Array.isArray(sources)) fail('MEMORY_INPUT', 'Memory sources must be an array');
    entry.sources = source.type === 'operation' ? [{ type: 'operation', operationId: source.id, at: source.at }] : this._sources(sources);
    if (entry.kind === 'overall' && module !== 'userView') fail('MEMORY_INPUT', 'Overall user cognition belongs to userView');
    if (entry.kind === 'boundary' && module !== 'userView') fail('MEMORY_INPUT', 'Interaction boundaries belong to userView');
    if (entry.certainty === 'supported') {
      const independent = new Map(entry.sources.filter(item => item.type === 'chat' && item.eventId && item.localDate).map(item => [item.eventId, item.localDate]));
      if (independent.size < 3 || new Set(independent.values()).size < 2) fail('MEMORY_EVIDENCE', 'Supported impressions require three independent interactions over two local dates');
    }
    if (entry.dependsOn && (!Array.isArray(entry.dependsOn) || !entry.dependsOn.every(ref => typeof ref === 'string' && /^[PVF]-[A-Za-z0-9_-]+@\d+$/.test(ref)))) fail('MEMORY_INPUT', 'Invalid memory dependencies');
    return entry;
  }

  _sources(sources) {
    if (!Array.isArray(sources) || !sources.length) fail('MEMORY_EVIDENCE', 'Checkpoint changes require archived sources');
    return sources.map(source => {
      if (!object(source) || source.type !== 'chat' || !/^C-[A-Za-z0-9_-]+$/.test(source.conversationId || '') || !/^M\d+$/.test(source.messageId || '') || typeof this.resolveSource !== 'function') fail('MEMORY_EVIDENCE', 'An archived C/M source must be resolved before memory publication');
      const resolved = this.resolveSource(clone(source));
      if (resolved !== true && (!object(resolved) || resolved.verified !== true)) fail('MEMORY_EVIDENCE', 'An archived C/M source must be resolved before memory publication');
      const result = { type: 'chat', conversationId: source.conversationId, messageId: source.messageId };
      if (source.part != null) result.part = id(source.part, 'part');
      // Only the source adapter may attest independence, dates and complete
      // turn identity. Proposed model fields never manufacture extra evidence.
      if (object(resolved)) {
        if (resolved.eventId != null) result.eventId = id(resolved.eventId, 'event');
        if (resolved.localDate != null) { if (!/^\d{4}-\d\d-\d\d$/.test(resolved.localDate)) fail('MEMORY_INPUT', 'Invalid source date'); result.localDate = resolved.localDate; }
        if (resolved.originalTurnId != null) result.originalTurnId = id(resolved.originalTurnId, 'original turn');
        if (resolved.at != null) result.at = timestamp(resolved.at);
        result.complete = resolved.complete === true;
      }
      return result;
    });
  }

  _invalidate(snapshot, oldRef, operation, scope) {
    const prior = snapshot.entries.find(entry => refOf(entry) === oldRef);
    snapshot.exclusions.push({ ref: oldRef, entryId: prior?.id || null, sourceRefs: (prior?.sources || []).filter(source => source.type === 'chat').map(source => `${source.conversationId}/${source.messageId}`), operationId: operation.id, at: operation.at, scope: scope || 'source', sourceWatermark: snapshot.sourceWatermark });
    for (const entry of snapshot.entries) if (entry.kind === 'overall' && (!entry.dependsOn?.length || entry.dependsOn.includes(oldRef))) {
      entry.status = 'needs_review';
      entry.invalidatedBy = operation.id;
    }
  }

  _apply(snapshot, action, payload, operation, automatic = false) {
    if (!ACTIONS.has(action) || !object(payload)) fail('MEMORY_INPUT', 'Unsupported memory operation');
    const module = snapshot.module;
    if (payload.persona) {
      if (module !== 'persona' || automatic || action !== 'upsert') fail('MEMORY_INPUT', 'Persona core requires an explicit edit');
      const fields = ['core', 'preferences', 'background', 'examples', 'boundaries'];
      if (!object(payload.persona) || Object.keys(payload.persona).some(key => ![...fields, 'schema', 'names', 'source', 'growth'].includes(key))) fail('MEMORY_INPUT', 'Invalid persona core');
      const baseline = clone(snapshot.baseline || require('./chat-persona.cjs').createDefaultPersona(snapshot.names));
      for (const field of fields) if (payload.persona[field] !== undefined) {
        if (!Array.isArray(payload.persona[field]) || payload.persona[field].some(text => typeof text !== 'string')) fail('MEMORY_INPUT', 'Persona fields require text arrays');
        baseline[field] = clone(payload.persona[field]);
      }
      snapshot.baseline = baseline;
      snapshot.baselineSavedAt = operation.at;
      if (payload.resetGrowth === true) for (const entry of snapshot.entries) if (entry.kind === 'growth' && !TERMINAL.has(entry.status)) { this._invalidate(snapshot, refOf(entry), operation, 'source'); entry.status = 'withdrawn'; }
      if (!payload.entry && !payload.names) return;
    }
    if (['pause-automatic', 'resume-automatic'].includes(action)) {
      snapshot.autoFormation = { paused: action === 'pause-automatic', cutoff: snapshot.sourceWatermark, at: operation.at, operationId: operation.id };
      return;
    }
    if (action === 'relearn') {
      if (module !== 'userView') fail('MEMORY_INPUT', 'Relearn applies only to user impressions');
      for (const entry of snapshot.entries) if (entry.certainty !== 'explicit' && !TERMINAL.has(entry.status)) { this._invalidate(snapshot, refOf(entry), operation, 'source'); entry.status = 'withdrawn'; }
      return;
    }
    if (module === 'persona' && payload.names) {
      if (automatic) fail('MEMORY_INPUT', 'Automatic growth cannot replace core naming');
      snapshot.names = { pet_name: name(payload.names.pet_name ?? snapshot.names.pet_name), user_nickname: name(payload.names.user_nickname ?? snapshot.names.user_nickname) };
      if (operation.type === 'operation') snapshot.namingSavedAt = operation.at;
    }
    if (action === 'upsert' && payload.names && !payload.entry) return;
    const entryInput = payload.entry;
    const targetId = payload.id || entryInput?.id;
    const index = snapshot.entries.findIndex(entry => entry.id === targetId);
    const old = index >= 0 ? snapshot.entries[index] : null;
    if (action !== 'upsert' && !old) fail('MEMORY_INPUT', 'The target entry does not exist');
    if (automatic && snapshot.autoFormation.paused) fail('MEMORY_PAUSED', 'Automatic formation is paused');
    if (action === 'upsert' || action === 'correct') {
      const entry = this._entry(module, entryInput, old, operation);
      if (old && operation.type === 'chat' && old.certainty === 'explicit') {
        const latest = Math.max(...entry.sources.map(source => source.at ? Date.parse(source.at) : -Infinity));
        const previous = Math.max(...old.sources.map(source => source.at ? Date.parse(source.at) : Date.parse(old.recorded_at)));
        if (!Number.isFinite(latest) || latest <= previous) fail('MEMORY_STALE', 'An older or unverified chat source cannot overwrite a newer explicit requirement');
      }
      if (old && module === 'facts' && action !== 'correct' && old.event_time && entry.event_time && /T.*(?:Z|[+-]\d\d:\d\d)$/.test(old.event_time) && /T.*(?:Z|[+-]\d\d:\d\d)$/.test(entry.event_time) && Date.parse(entry.event_time) < Date.parse(old.event_time)) fail('MEMORY_TEMPORAL_CONFLICT', 'A late-arriving older event cannot replace a newer fact state');
      if (automatic) {
        if (module === 'persona' && entry.kind === 'core') fail('MEMORY_INPUT', 'Automatic growth cannot change the stable persona core');
        const sourceRefs = entry.sources.map(source => `${source.conversationId}/${source.messageId}`);
        if (snapshot.exclusions.some(exclusion => exclusion.entryId === entry.id || exclusion.sourceRefs?.some(ref => sourceRefs.includes(ref)) || exclusion.ref === refOf(entry) || (old && exclusion.ref === refOf(old)))) fail('MEMORY_EXCLUDED', 'A removed source or entry cannot be revived automatically');
        if (old?.certainty === 'explicit') fail('MEMORY_STALE', 'Automatic inference cannot overwrite a saved explicit requirement');
      }
      if (old) this._invalidate(snapshot, refOf(old), operation, 'source');
      if (entry.kind === 'overall') for (const other of snapshot.entries) if (other.kind === 'overall' && other.id !== entry.id && !TERMINAL.has(other.status)) other.status = 'superseded';
      if (index < 0) snapshot.entries.push(entry); else snapshot.entries[index] = entry;
    } else {
      this._invalidate(snapshot, refOf(old), operation, payload.scope);
      old.rev++;
      old.recorded_at = operation.at;
      if (automatic) fail('MEMORY_INPUT', 'Automatic lifecycle edits need explicit checkpoint entry data');
      old.status = action === 'withdraw' ? 'withdrawn' : action === 'suspend' ? 'suspended' : 'active';
      old.sources = [{ type: 'operation', operationId: operation.id, at: operation.at }];
    }
  }

  save(input = {}) {
    assertPlain(input);
    const operationId = id(input.operationId, 'operation ID');
    moduleInfo(input.module);
    const digest = hash(input);
    return this._locked(() => {
      const head = this._head();
      const receipt = head.operations[hash(operationId)];
      if (receipt) { if (receipt.digest !== digest) fail('MEMORY_ID_CONFLICT', 'An operation ID cannot be reused for different content'); return { ...clone(receipt.result), revision: receipt.revision, operationWatermark: head.operationWatermark, duplicate: true }; }
      const snapshot = this._snapshot(head, input.module);
      if (snapshot.version !== input.baseVersion) fail('MEMORY_STALE', 'Memory changed while this edit was being prepared');
      const operation = { id: operationId, digest, at: timestamp(input.at || this.clock()), type: 'operation' };
      this._apply(snapshot, input.action, input.payload || {}, operation);
      snapshot.version++; snapshot.updatedAt = operation.at;
      const result = { saved: true, module: input.module, version: snapshot.version, operationId, viewStatus: 'pending-sync' };
      return this._commit(head, { [input.module]: snapshot }, operation, result);
    });
  }

  commitCheckpoint(input = {}) {
    assertPlain(input);
    const taskId = id(input.taskId, 'checkpoint task');
    const digest = hash(input);
    if (!object(input.baseVersions) || !Array.isArray(input.patches) || !input.sourceWatermark) fail('MEMORY_INPUT', 'A checkpoint requires fixed versions and source coverage');
    return this._locked(() => {
      const head = this._head();
      const receipt = head.operations[hash(taskId)];
      if (receipt) { if (receipt.digest !== digest) fail('MEMORY_ID_CONFLICT', 'A checkpoint ID cannot be reused with different work'); return { ...clone(receipt.result), duplicate: true }; }
      if (head.operationWatermark !== input.operationWatermark) fail('MEMORY_STALE', 'A newer explicit save invalidated this checkpoint');
      const operation = { id: taskId, digest, at: timestamp(input.at || this.clock()), type: 'chat' };
      const updates = {};
      const growthByTurn = new Map(Object.entries(head.growthByTurn || {}));
      for (const patch of input.patches) {
          if (patch.payload?.persona || patch.payload?.resetGrowth) fail('MEMORY_INPUT', 'Built-in persona changes require an explicit management save');
        moduleInfo(patch.module);
        const snapshot = updates[patch.module] || this._snapshot(head, patch.module);
        if (snapshot.version !== input.baseVersions[patch.module]) fail('MEMORY_STALE', 'The checkpoint memory baseline changed');
        if (!['upsert', 'correct'].includes(patch.action)) fail('MEMORY_INPUT', 'Checkpoint patches require explicit final entry data');
        const sources = this._sources(patch.payload?.entry?.sources || patch.sources);
        if (patch.payload?.names) {
          if (patch.module !== 'persona' || patch.automatic !== false) fail('MEMORY_INPUT', 'Names require an explicit archived request');
          if (snapshot.namingSavedAt && !sources.some(source => source.at && Date.parse(source.at) > Date.parse(snapshot.namingSavedAt))) fail('MEMORY_STALE', 'An older source cannot replace newer saved names');
        }
        if (patch.automatic !== false && ['persona', 'userView'].includes(patch.module)) {
          const turn = patch.originalTurnId;
          if (!turn || typeof turn !== 'string' || sources.some(source => source.complete !== true || source.originalTurnId !== turn)) fail('MEMORY_EVIDENCE', 'Automatic persona/user growth needs the verified original complete turn identity');
          const count = (growthByTurn.get(turn) || 0) + 1;
          if (count > 3) fail('MEMORY_GROWTH_BUDGET', 'Persona and user impressions share three automatic changes per original complete turn');
          growthByTurn.set(turn, count);
        }
        this._apply(snapshot, patch.action, { ...patch.payload, ...(patch.payload.entry ? { entry: { ...patch.payload.entry, sources } } : {}) }, { ...operation, explicit: patch.automatic === false }, patch.automatic !== false);
        snapshot.sourceWatermark = clone(input.sourceWatermark);
        updates[patch.module] = snapshot;
      }
      head.growthByTurn = Object.fromEntries(growthByTurn);
      for (const snapshot of Object.values(updates)) { snapshot.version++; snapshot.updatedAt = operation.at; }
      return this._commit(head, updates, operation, { saved: true, taskId, versions: Object.fromEntries(Object.entries(updates).map(([module, value]) => [module, value.version])) });
    });
  }

  _tokens(content, limit) {
    if (typeof this.countTokens !== 'function') return { ready: false, reason: 'token-meter-unverified' };
    const tokens = this.countTokens(content);
    if (!Number.isSafeInteger(tokens) || tokens < 0) return { ready: false, reason: 'token-meter-unverified' };
    return tokens > limit ? { ready: false, reason: 'memory-capacity', tokens, limit } : { ready: true, tokens, limit };
  }

  _effective(entry, at = this.clock()) {
    if (TERMINAL.has(entry.status) || entry.status === 'conflict' || entry.status === 'needs_review') return false;
    const now = Date.parse(at);
    if (entry.valid_from && now < Date.parse(entry.valid_from)) return false;
    if (entry.valid_to && now >= Date.parse(entry.valid_to)) return false;
    if (entry.kind === 'boundary' || entry.certainty === 'explicit') return true;
    const days = entry.certainty === 'tentative' ? 30 : 90;
    const since = Date.parse(entry.last_supported_at || entry.recorded_at);
    return Number.isFinite(since) && now >= since && now - since < days * 86400000;
  }

  _sameClaim(left, right) {
    const fields = ['kind', 'subject', 'scope', 'object_ids', 'status', 'source_nature', 'speaker', 'event_status', 'event_time', 'target_date', 'time_precision', 'time_expression', 'followup', 'valid_from', 'valid_to', 'certainty', 'relations'];
    return fields.every(key => stable(left[key] ?? null) === stable(right[key] ?? null)) && left.content.normalize('NFKC').trim() === right.content.normalize('NFKC').trim();
  }
  _sameRepairClaim(before, after, entry = {}) {
    // Exact source quotation is necessary but not sufficient: another sentence
    // in the same message may describe a different person or object. The first
    // repair form is deliberately limited to punctuation/spacing and polarity
    // drift; names, numbers, actors and the remaining claim must match.
    const anchors = [entry.subject, ...(entry.object_ids || [])].filter(value => typeof value === 'string' && value && before.includes(value)).sort((a, b) => b.length - a.length);
    if (anchors.some(anchor => !after.includes(anchor))) return false;
    const skeleton = text => {
      for (const [index, anchor] of anchors.entries()) text = text.split(anchor).join(`身份锚${index}保留`);
      return text.normalize('NFKC').toLowerCase().replace(/(?:并非|不是|没有|未曾|\bnot\b|\bnever\b)|(?:不|没|未|无)(?=喜欢|爱|在|愿意|是|有|想|要|会|能|叫|允许|需要|接受|同意|做|去|使用|认识|知道|参加|完成)/gu, '').replace(/[\p{P}\p{Z}\s]/gu, '');
    };
    return !!skeleton(before) && skeleton(before) === skeleton(after);
  }
  _canonicalVisible(entry, effective) {
    return !entry.canonical_ref || !effective.some(other => refOf(other) === entry.canonical_ref && this._sameClaim(entry, other));
  }

  _authority(snapshot, segments) {
    return segments.map(segment => {
      const entries = snapshot.entries.filter(entry => segment.refs.includes(refOf(entry)) && entry.certainty === 'explicit');
      const next = { ...segment }; delete next.authority;
      if (entries.length) next.authority = entries.map(entry => ({ ref: refOf(entry), recordedAt: entry.recorded_at, sourceAt: [...new Set(entry.sources.map(source => source.at).filter(Boolean))] }));
      return next;
    });
  }

  publishPreinput(input = {}) {
    assertPlain(input); const info = moduleInfo(input.module);
    if (!Array.isArray(input.segments) || !input.segments.every(segment => object(segment) && typeof segment.text === 'string' && Array.isArray(segment.refs))) fail('MEMORY_INPUT', 'Preinput segments require final text and versioned source references');
    return this._locked(() => {
      const head = this._head(), snapshot = this._snapshot(head, input.module);
      if (snapshot.version !== input.baseVersion) fail('MEMORY_STALE', 'The preinput memory baseline changed');
      const active = snapshot.entries.filter(entry => this._effective(entry));
      const allowed = new Set(active.map(refOf));
      for (const segment of input.segments) for (const ref of segment.refs) if (!allowed.has(ref)) fail('MEMORY_STALE', 'The preinput includes an invalid memory revision');
      const refs = new Set(input.segments.flatMap(segment => segment.refs));
      for (const entry of active) if (['boundary', 'overall'].includes(entry.kind) && !refs.has(refOf(entry))) fail('MEMORY_CAPACITY', 'Required boundaries and overall cognition must not be omitted');
      const segments = this._authority(snapshot, clone(input.segments));
      if (input.module === 'userView' && !active.some(entry => entry.kind === 'overall')) segments.unshift({ kind: 'overall', text: '了解有限，尚不足以形成稳定性格认知。', refs: [] });
      const content = JSON.stringify({ module: input.module, version: snapshot.version, names: snapshot.names || undefined, segments });
      const budget = this._tokens(content, info.limit);
      if (!budget.ready) return budget;
      snapshot.preinput = { revision: (snapshot.preinput?.revision || 0) + 1, sourceVersion: snapshot.version, sourceWatermark: clone(input.sourceWatermark || snapshot.sourceWatermark), generatedAt: timestamp(this.clock()), entryRefs: active.map(refOf), segments, tokens: budget.tokens };
      return this._commit(head, { [input.module]: snapshot }, null, { ready: true, module: input.module, version: snapshot.version, viewRevision: snapshot.preinput.revision, tokens: budget.tokens });
    });
  }

  prepareForRequest(input = {}) {
    id(input.requestId, 'request');
    if (input.nativeContextVerified !== true) return { ready: false, reason: 'native-context-unverified' };
    const head = this._head();
    const modules = {};
    for (const module of Object.keys(MODULES)) {
      const snapshot = this._snapshot(head, module);
      if (!snapshot.preinput) return { ready: false, reason: 'preinput-unavailable', module };
      const active = snapshot.entries.filter(entry => this._effective(entry));
      const activeRefs = new Set(active.map(refOf));
      let segments = snapshot.preinput.segments.filter(segment => segment.kind !== 'naming' && segment.refs.every(ref => activeRefs.has(ref)));
      if (module === 'persona' && snapshot.baseline) {
        const { buildPersonaView } = require('./chat-persona.cjs');
        // Measure the final request projection while the builder selects
        // optional sections. Its own source/naming wrapper is replaced here,
        // so charging both wrappers would reject otherwise valid 10K views.
        const retained = segments.filter(segment => segment.refs.length);
        const naming = { kind: 'naming', text: `桌宠名：${snapshot.names.pet_name}。称呼用户：${snapshot.names.user_nickname}。虚构王朝：${snapshot.names.user_nickname}王朝。`, refs: [], authoritative: true, savedAt: snapshot.namingSavedAt ?? null };
        const projectedContent = baselineSegments => JSON.stringify({ module, version: snapshot.version, names: snapshot.names,
          ...(snapshot.baselineSavedAt ? { baselineSavedAt: snapshot.baselineSavedAt } : {}), segments: [naming, ...baselineSegments.filter(segment => segment.kind !== 'naming'), ...retained] });
        const envelope = this._tokens(projectedContent([]), moduleInfo(module).limit);
        if (!envelope.ready) return { ...envelope, module };
        const current = buildPersonaView({ ...snapshot.baseline, names: snapshot.names }, {
          countTokens: content => this.countTokens(projectedContent(JSON.parse(content).segments)), limit: moduleInfo(module).limit });
        if (!current.ready) return { ready: false, reason: current.reason, module };
        segments = [...current.segments.filter(segment => segment.kind !== 'naming'), ...retained];
      }
      if (module === 'persona' && snapshot.names) segments.unshift({ kind: 'naming', text: `桌宠名：${snapshot.names.pet_name}。称呼用户：${snapshot.names.user_nickname}。虚构王朝：${snapshot.names.user_nickname}王朝。`, refs: [], authoritative: true, savedAt: snapshot.namingSavedAt ?? null });
      const existing = new Set(segments.flatMap(segment => segment.refs));
      const covered = new Set(snapshot.preinput.entryRefs || (snapshot.preinput.sourceVersion === snapshot.version ? active.map(refOf) : []));
      for (const entry of active) if (!existing.has(refOf(entry)) && (entry.certainty === 'explicit' && !covered.has(refOf(entry)) || ['overall', 'boundary'].includes(entry.kind))) segments.push({ kind: entry.kind, text: entry.content, refs: [refOf(entry)], overlay: true, recordedAt: entry.recorded_at, sourceAt: entry.sources.map(source => source.at).filter(Boolean), ...(entry.valid_from ? { validFrom: entry.valid_from } : {}), ...(entry.valid_to ? { validTo: entry.valid_to } : {}) });
      segments = this._authority(snapshot, segments);
      if (module === 'userView' && !segments.some(segment => segment.kind === 'overall')) segments.unshift({ kind: 'overall', text: snapshot.entries.some(entry => entry.kind === 'overall') ? '有关总体认知的部分待整理；失效的旧概述不作为当前看法。' : '了解有限，尚不足以形成稳定性格认知。', refs: [] });
      const later = (input.laterNativeChanges || []).filter(change => change.module === module);
      if (later.some(change => change.verified !== true || typeof change.text !== 'string')) return { ready: false, reason: 'later-requirements-unverified', module };
      // Explicitly supplied later requirements follow stored overlays. Their
      // correctness must be proven by the native source adapter, not guessed.
      for (const change of later) segments.push({ kind: 'later-native-requirement', text: change.text, refs: [], laterThanSaved: true });
      const content = JSON.stringify({ module, version: snapshot.version, names: snapshot.names || undefined, ...(snapshot.baselineSavedAt ? { baselineSavedAt: snapshot.baselineSavedAt } : {}), segments });
      const budget = this._tokens(content, moduleInfo(module).limit);
      if (!budget.ready) return { ...budget, module };
      modules[module] = { content, tokens: budget.tokens, sourceVersion: snapshot.version, preinputRevision: snapshot.preinput.revision, viewStatus: snapshot.preinput.sourceVersion === snapshot.version ? 'ready' : 'saved-overrides-view' };
    }
    const prepared = { ready: true, requestId: input.requestId, revision: head.revision, operationWatermark: head.operationWatermark, modules };
    this.prepared.set(input.requestId, clone(prepared));
    // Bounded in-memory receipt cache. No user text is written per request.
    if (this.prepared.size > 64) this.prepared.delete(this.prepared.keys().next().value);
    return prepared;
  }

  markSynced({ requestId, operationWatermark } = {}) {
    const prepared = this.prepared.get(requestId);
    if (!prepared || prepared.operationWatermark !== operationWatermark) fail('MEMORY_STALE', 'Only the prepared request snapshot can be marked synchronized');
    this.synced.set(requestId, { operationWatermark, versions: Object.fromEntries(Object.entries(prepared.modules).map(([module, value]) => [module, value.sourceVersion])) });
    this.prepared.delete(requestId);
    if (this.synced.size > 64) this.synced.delete(this.synced.keys().next().value);
    return { synchronized: true, requestId, operationWatermark, pending: this._head().operationWatermark > operationWatermark, durability: 'runtime-until-next-checkpoint' };
  }

  filterEvidence(ref, { intent = 'current', at = this.clock() } = {}) {
    const match = /^([PVF]-[A-Za-z0-9_-]+)@(\d+)$/.exec(ref || '');
    if (!match) return { allowed: false, reason: 'unresolved-reference' };
    const module = Object.keys(MODULES).find(key => MODULES[key].prefix === match[1][0]);
    const snapshot = this.getModule(module), entry = snapshot.entries.find(item => item.id === match[1]);
    if (!entry || entry.rev !== Number(match[2])) return { allowed: false, reason: 'historical-revision-not-loaded', currentRef: entry ? refOf(entry) : null };
    const effective = this._effective(entry, at);
    return { allowed: intent === 'history' || effective, historical: !effective, status: entry.status, currentRef: refOf(entry), sourceWatermark: snapshot.sourceWatermark };
  }

  currentUserView({ at = this.clock() } = {}) {
    const snapshot = this.getModule('userView');
    const effective = snapshot.entries.filter(entry => this._effective(entry, at)), active = effective.filter(entry => this._canonicalVisible(entry, effective));
    const overall = active.find(entry => entry.kind === 'overall') || null;
    return { version: snapshot.version, sourceWatermark: snapshot.sourceWatermark, overall, overallStatus: overall ? 'ready' : snapshot.entries.some(entry => entry.kind === 'overall') ? 'needs-review' : 'limited-acquaintance', entries: active.filter(entry => entry.kind !== 'overall'), autoFormation: snapshot.autoFormation };
  }

  currentFacts({ at = this.clock() } = {}) {
    const snapshot = this.getModule('facts');
    const now = Date.parse(at);
    const effective = snapshot.entries.filter(entry => this._effective(entry, at));
    const entries = effective.filter(entry => this._canonicalVisible(entry, effective)).map(entry => {
      const value = clone(entry);
      const target = entry.target_date;
      let passed = false;
      if (typeof target === 'string' && /^\d{4}-\d\d$/.test(target)) passed = at.slice(0, 7) > target;
      else if (typeof target === 'string' && /^\d{4}-\d\d-\d\d$/.test(target)) passed = at.slice(0, 10) > target;
      else if (typeof target === 'string' && /T.*(?:Z|[+-]\d\d:\d\d)$/.test(target)) passed = Number.isFinite(Date.parse(target)) && now >= Date.parse(target);
      if (['plan', 'agreement'].includes(value.kind) && !['completed', 'cancelled', 'superseded'].includes(value.event_status) && passed && value.followup !== 'known') value.timeDisposition = 'target-passed-outcome-unknown';
      return value;
    });
    return { version: snapshot.version, sourceWatermark: snapshot.sourceWatermark, entries };
  }
}

module.exports = { MemoryStore, MODULES, SCHEMA };
