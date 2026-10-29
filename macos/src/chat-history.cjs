'use strict';
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { createHash, randomUUID } = require('node:crypto');
const { ChatJournal } = require('./chat-journal.cjs');
const { terms, queryTerms, scriptGroup, explicitAliases, reciprocalRankFusion, rerankNear, evidenceDuplicate } = require('./chat-search.cjs');
const { SemanticEncoder, fingerprint: semanticFingerprint } = require('./chat-semantic.cjs');
const { tokens } = require('./chat-policy.cjs');
const fail = code => { throw Object.assign(new Error(code), { code }); };
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const tick = () => new Promise(resolve => setImmediate(resolve));
const safeRef = value => typeof value === 'string' && value.length <= 512 && !/[\0\r\n]/.test(value);
const SUMMARY_REF = /^((L[1-9]\d*-[a-f0-9-]{36})@v([1-9]\d*))(?:#(I\d+))?$/;

// Text is stored once, in the authoritative JSONL. This index stores only FTS
// postings, identities and exact UTF-8 source ranges, never a second body copy.
class ChatHistory {
  constructor({ projectRoot, memory, fs: io = fs, countTokens, measure = countTokens, Database, getNative = null, getAvailableTokens = () => 3000, worker = true, semanticOptions = {} } = {}) {
    this.journal = new ChatJournal(projectRoot, { fs: io }); this.io = io; this.memory = memory; this.measure = measure;
    this.Database = Database; this.getNative = getNative; this.getAvailableTokens = getAvailableTokens; this.turns = new WeakMap(); this.indexing = false; this.db = null;
    this.useWorker = worker && io === fs && !Database; this.workerPending = new Map();
    this.semanticOptions = semanticOptions; this.encoder = this.useWorker ? null : new SemanticEncoder(semanticOptions);
    this.healthState = { lexical: 'ready', semantic: 'loading', semanticReason: 'model-cold', index: 'partial', coverage: 'partial', indexedVectors: null, pendingVectors: null };
    this.vectorEpoch = 0; this.vectorCache = null; this.closed = false; this.closePromise = null;
    this.healthListeners = new Set(); this.lastPublishedHealth = null; this.bootstrapPromise = null; this.closeInFlight = false;
    this.onMemoryCommit = () => { this.healthState.index = this.healthState.coverage = 'partial'; this._notifyHealth(); this._scheduleSync(); };
    this.memory?.on?.('commit', this.onMemoryCommit);
  }
  onHealthChange(listener) {
    if (typeof listener !== 'function') fail('CHAT_HISTORY_HEALTH_LISTENER');
    if (!this.closed) this.healthListeners.add(listener);
    return () => this.healthListeners.delete(listener);
  }
  _notifyHealth() {
    if (this.closed) return;
    const health = this.health(), serialized = JSON.stringify(health);
    if (serialized === this.lastPublishedHealth) return; this.lastPublishedHealth = serialized;
    for (const listener of this.healthListeners) { try { listener({ ...health }); } catch {} }
  }
  initialize() {
    if (this.closed) return Promise.resolve({ status: 'unavailable', reason: 'closed' });
    if (!this.bootstrapPromise) this.bootstrapPromise = this.syncIndex({ isCancelled: () => this.closed }).catch(error => {
      if (!this.closed) { this.healthState.index = this.healthState.coverage = 'unavailable'; this.healthState.reason = 'index-initialization-failed'; this._notifyHealth(); }
      throw error;
    });
    return this.bootstrapPromise;
  }
  _scheduleSync() {
    if (this.closed) return; this.syncRequested = true;
    if (this.indexing || this.syncPromise || this.syncTimer) return;
    this.syncTimer = setTimeout(() => { this.syncTimer = null; if (!this.closed) this.syncIndex().catch(() => { this.healthState.index = this.healthState.coverage = 'partial'; }); }, 25); this.syncTimer.unref?.();
  }
  _workerRequest(method, args, timeoutMs = 1500) {
    if (!this.worker) {
      if (this.closed && !this.closeInFlight) this.closePromise = null;
      const { Worker } = require('node:worker_threads');
      this.worker = new Worker(path.join(__dirname, 'chat-history-worker.cjs'), { workerData: { projectRoot: this.journal.root, hasMemory: !!this.memory, semanticOptions: this.semanticOptions } }); this.worker.unref();
      this.worker.on('message', value => { if (value.health) { this.healthState = value.health; this._notifyHealth(); } const pending = this.workerPending.get(value.id); if (!pending) return; this.workerPending.delete(value.id); clearTimeout(pending.timer); value.error ? pending.reject(Object.assign(new Error(value.error), { code: value.error })) : pending.resolve(value.result); });
       this.worker.on('error', () => { for (const pending of this.workerPending.values()) { clearTimeout(pending.timer); pending.reject(Object.assign(new Error('CHAT_HISTORY_WORKER_FAILED'), { code: 'CHAT_HISTORY_WORKER_FAILED' })); } this.workerPending.clear(); this.worker = null; });
    }
    const id = randomUUID(); return new Promise((resolve, reject) => { const timer = setTimeout(() => { this.workerPending.delete(id); reject(Object.assign(new Error('CHAT_HISTORY_TIMEOUT'), { code: 'CHAT_HISTORY_TIMEOUT' })); }, timeoutMs); timer.unref?.(); this.workerPending.set(id, { resolve, reject, timer }); this.worker.postMessage({ id, method, args }); });
  }
  async _workerResult(method, input, turn, kind) {
    const { state, remaining } = this._budget(turn, kind), epoch = this.watermark();
    let result;
    if (this.indexing) result = { status: 'indexing', cards: [], reason: 'index-rebuilding' };
    else try { result = await this._workerRequest(method, { input, availableTokens: remaining }); }
    catch (error) { result = { status: error.code === 'CHAT_HISTORY_TIMEOUT' ? 'timeout' : 'unavailable', cards: [], reason: error.code || 'worker-unavailable' }; }
    if (this.watermark() !== epoch) result = { status: 'partial', cards: [], reason: 'saved-state-changed' };
    result.cards = result.cards.filter(card => { const row = this._row(card.ref); return (!row || this._effective(row, ['history', 'quote'].includes(input?.intent) ? 'history' : 'current')) && !state.delivered.has(`${card.ref}:${card.start}:${card.end}`); });
    return this._finish(turn, kind, result, remaining);
  }
  _open() {
    if (this.db) return this.db;
    if (this.closed && !this.closeInFlight) this.closePromise = null;
    const Database = this.Database || require('node:sqlite').DatabaseSync;
    this.db = new Database(this.journal.file('memory/search/index.sqlite', true));
    this.db.exec('PRAGMA busy_timeout=1000');
    const old = this.db.prepare("SELECT sql FROM sqlite_master WHERE name='postings'").get();
    if (old && !old.sql.includes('contentless_delete')) this.db.exec('DROP TABLE postings; DROP TABLE IF EXISTS refs; DROP TABLE IF EXISTS manifest; DROP TABLE IF EXISTS source_manifest; DROP TABLE IF EXISTS vectors;');
    if (!old) this.db.exec('PRAGMA journal_mode=WAL');
    this.db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS postings USING fts5(terms,content='',contentless_delete=1); CREATE TABLE IF NOT EXISTS refs(rowid INTEGER PRIMARY KEY,ref TEXT UNIQUE NOT NULL,kind TEXT NOT NULL,metadata TEXT NOT NULL,sourceKey TEXT NOT NULL); CREATE INDEX IF NOT EXISTS refs_source ON refs(sourceKey); CREATE TABLE IF NOT EXISTS manifest(id INTEGER PRIMARY KEY,watermark TEXT NOT NULL); CREATE TABLE IF NOT EXISTS source_manifest(sourceKey TEXT PRIMARY KEY,fingerprint TEXT NOT NULL); CREATE TABLE IF NOT EXISTS vectors(ref TEXT PRIMARY KEY,model TEXT NOT NULL,embedding BLOB NOT NULL,dimensions INTEGER NOT NULL,textHash TEXT NOT NULL); CREATE TABLE IF NOT EXISTS aliases(alias TEXT NOT NULL,canonical TEXT NOT NULL,ref TEXT NOT NULL,sourceKey TEXT NOT NULL,PRIMARY KEY(alias,canonical,ref)); CREATE TABLE IF NOT EXISTS index_config(key TEXT PRIMARY KEY,value TEXT NOT NULL);");
    return this.db;
  }
  watermark() {
    const archives = this.listConversations({ limit: 100 }).conversations.map(item => { const stat = this.io.statSync(this.journal.file(item.relativePath)); return [item.relativePath, stat.size, stat.mtimeMs]; });
    // Include later pages without reading any message body. A newly committed
    // archive must make the persistent index visibly partial before rebuild.
    let cursor = 100; while (archives.length === cursor) { const page = this.listConversations({ cursor, limit: 100 }); for (const item of page.conversations) { const stat = this.io.statSync(this.journal.file(item.relativePath)); archives.push([item.relativePath, stat.size, stat.mtimeMs]); } if (!page.nextCursor) break; cursor = page.nextCursor; }
    return digest(Buffer.from(JSON.stringify([this.memory?.getState().operationWatermark ?? 0, this.journal.read('memory/summaries/head.jsonl')?.revision ?? 0, this.journal.read('memory/recent/current.jsonl')?.version ?? 0, archives])));
  }
  listConversations({ cursor = 0, limit = 30 } = {}) {
    if (!Number.isSafeInteger(cursor) || cursor < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail('CHAT_HISTORY_PAGE');
    const base = this.journal.file('chat-history/.listing'); const directory = base && path.dirname(base); const entries = [];
    if (directory && this.io.existsSync(directory)) for (const date of this.io.readdirSync(directory).sort().reverse()) {
      if (!/^\d{4}-\d\d-\d\d$/.test(date)) continue;
      const marker = this.journal.file(`chat-history/${date}/.listing`); if (!marker) continue;
      for (const file of this.io.readdirSync(path.dirname(marker)).sort().reverse()) if (/^\d{4}-\d\d-\d\d_\d\d-\d\d-\d\d(?:-\d+)?\.jsonl$/.test(file)) {
        const relative = `chat-history/${date}/${file}`, metadata = this._header(relative);
        entries.push({ conversationId: metadata.conversation_id, title: file.slice(0, -6), startedAt: metadata.started_at, archiveDate: date, relativePath: relative });
      }
    }
    return { conversations: entries.slice(cursor, cursor + limit), total: entries.length, nextCursor: cursor + limit < entries.length ? cursor + limit : null };
  }
  _header(relative) {
    const file = this.journal.file(relative); if (!file) fail('CHAT_HISTORY_MISSING');
    const fd = this.io.openSync(file, 'r'), buffer = Buffer.alloc(16384); let size;
    try { size = this.io.readSync(fd, buffer, 0, buffer.length, 0); } finally { this.io.closeSync(fd); }
    const end = buffer.subarray(0, size).indexOf(10); if (end < 0) fail('CHAT_HISTORY_HEADER');
    const value = JSON.parse(buffer.subarray(0, end).toString('utf8')).meta;
    if (!value || value.schema !== 'codex-maid-chat/1' || !/^C-[\w-]+$/.test(value.conversation_id)) fail('CHAT_HISTORY_HEADER'); return value;
  }
  async *records(relative) {
    const file = this.journal.file(relative); if (!file) fail('CHAT_HISTORY_MISSING');
    const stream = this.io.createReadStream(file, { encoding: 'utf8', highWaterMark: 65536 });
    const lines = readline.createInterface({ input: stream, crlfDelay: Infinity }); let position = 0, count = 0;
    try { for await (const line of lines) {
      if (Buffer.byteLength(line) > 16 * 1024 * 1024) fail('CHAT_HISTORY_RECORD_TOO_LARGE');
      const length = Buffer.byteLength(line, 'utf8') + 1; yield { record: JSON.parse(line), line, offset: position, length }; position += length;
      if (++count % 64 === 0) await tick();
    } } finally { lines.close(); stream.destroy(); }
  }
  async readConversation({ conversationId, offset = 0, limit = 50 } = {}) {
    if (!/^C-[\w-]+$/.test(conversationId || '') || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail('CHAT_HISTORY_PAGE');
    const selected = this._conversation(conversationId); const output = []; let index = 0, bytes = 0, more = false, partial = false;
    for await (const { record } of this.records(selected.relativePath)) {
      if (!record.id) continue;
      if (index++ < offset) continue;
      let message = { ...record, text: record.content.filter(part => typeof part.text === 'string').map(part => part.text).join(''), reference: `${conversationId}/${record.id}` }, size = Buffer.byteLength(JSON.stringify(message));
      if (!output.length && size > 256 * 1024) {
        const excerpt = Array.from(message.text).slice(0, 16000).join('');
        message = { id: record.id, role: record.role, time: record.time, phase: record.phase, text: excerpt, content: [{ text: excerpt }], reference: message.reference, partial: true, continuation: { reference: message.reference, start: 16000, unit: 'unicode-code-point' } };
        size = Buffer.byteLength(JSON.stringify(message)); partial = true;
      }
      if (output.length >= limit || bytes + size > 256 * 1024) { more = true; break; }
      output.push(message); bytes += size;
    }
    return { ...selected, messages: output, offset, total: more ? null : index, nextOffset: more ? offset + output.length : null, partial: more || partial };
  }
  _conversation(id) {
    let cursor = 0; do { const page = this.listConversations({ cursor, limit: 100 }); const found = page.conversations.find(item => item.conversationId === id); if (found) return found; cursor = page.nextCursor; } while (cursor !== null);
    fail('CHAT_HISTORY_MISSING');
  }
  _readRange(location, budget = 65536) {
    if (!Number.isSafeInteger(location.offset) || !Number.isSafeInteger(location.length) || location.offset < 0 || location.length < 1 || location.length > budget) fail('CHAT_HISTORY_RANGE_BUDGET');
    const file = this.journal.file(location.path); if (!file) fail('CHAT_HISTORY_MISSING');
    const fd = this.io.openSync(file, 'r'), bytes = Buffer.alloc(location.length); let read;
    try { read = this.io.readSync(fd, bytes, 0, bytes.length, location.offset); } finally { this.io.closeSync(fd); }
    if (read !== bytes.length || digest(bytes) !== location.hash) fail('CHAT_HISTORY_SOURCE_CHANGED');
    return JSON.parse(`"${bytes.toString('utf8')}"`);
  }
  _effective(row, intent = 'current') {
    if (intent === 'quote') intent = 'history';
    if (row.kind === 'persona' || row.kind === 'userView' || row.kind === 'facts') return intent === 'history' || this.memory?.filterEvidence(row.ref, { intent }).allowed === true;
    if (row.kind === 'summary' && intent !== 'history') {
      const match = SUMMARY_REF.exec(row.ref);
      if (!match || this.journal.read('memory/summaries/head.jsonl')?.active?.[match[2]] !== match[1]) return false;
    }
    if (row.kind === 'original') {
      const source = row.ref.split('/').slice(0, 2).join('/');
      for (const module of ['persona', 'userView', 'facts']) if (this.memory?.getModule(module).exclusions.some(item => item.sourceRefs?.includes(source)) && intent !== 'history') return false;
    }
    if (intent !== 'history' && row.metadata?.sources?.length && !this._sourceRefsEffective(row.metadata.sources)) return false;
    return true;
  }
  _savedSummary(reference) {
    const match = SUMMARY_REF.exec(reference); if (!match) return null;
    const relative = `memory/summaries/nodes/${match[1]}.jsonl`;
    let node; try { node = this.journal.read(relative); } catch { return null; }
    if (!node || node.id !== match[2] || node.version !== Number(match[3]) || !Array.isArray(node.content?.entries)) return null;
    const entries = match[4] ? node.content.entries.filter(entry => entry.id === match[4]) : node.content.entries;
    if (!entries.length || entries.some(entry => !Array.isArray(entry.refs) || !entry.refs.length || entry.refs.some(ref => typeof ref !== 'string'))) return null;
    return { node, relative, nodeRef: match[1], entry: match[4] ? entries[0] : null, entries };
  }
  _sourceRefsEffective(refs, visited = new Set()) {
    for (const ref of refs) {
      if (visited.has(ref)) continue; visited.add(ref); if (visited.size > 512) return false;
      const source = /^(C-[\w-]+\/M\d+)/.exec(ref)?.[1];
      if (source && ['persona', 'userView', 'facts'].some(module => this.memory?.getModule(module).exclusions.some(item => item.sourceRefs?.includes(source)))) return false;
      if (/^[PVF]-/.test(ref) && !this.memory?.filterEvidence(ref).allowed) return false;
      const row = /^L/.test(ref) ? this._row(ref) : null;
      if (row?.metadata.sources && !this._sourceRefsEffective(row.metadata.sources, visited)) return false;
      if (!row && /^L/.test(ref)) {
        // Pending views intentionally cite immutable historical child versions
        // which may no longer have index rows. Validate that exact entry from
        // its saved node before following its provenance or accepting it.
        const saved = this._savedSummary(ref);
        if (!saved || !this._sourceRefsEffective(saved.entries.flatMap(entry => entry.refs), visited)) return false;
      }
    }
    return true;
  }
  _row(ref) { const row = this._open().prepare('SELECT ref,kind,metadata FROM refs WHERE ref=?').get(ref); return row ? { ...row, metadata: JSON.parse(row.metadata) } : null; }
  _summaryCorrections() {
    if (!this.memory) return [];
    if (typeof this.memory.summaryCorrections === 'function') return this.memory.summaryCorrections();
    return Object.values(this.memory.getState().modules).flatMap(snapshot => snapshot.entries).filter(entry => entry.maintenance?.kind === 'source-repair' && this.memory._effective(entry))
      .map(entry => ({ memoryRef: `${entry.id}@${entry.rev}`, text: entry.content, sourceRefs: [...new Set([...(entry.maintenance.repairSourceRefs || entry.maintenance.evidenceRefs || []), ...(entry.maintenance.previousSourceRefs || [])])].filter(ref => /^C-[\w-]+\/M\d+(?:\/P\d+)?$/.test(ref)) })).filter(item => item.sourceRefs.length);
  }
  resolveReference(reference, { start, end, maxBytes = 65536, intent = 'history' } = {}) {
    if (!safeRef(reference)) fail('CHAT_HISTORY_REFERENCE');
    let row = this._row(reference);
    if (!row && SUMMARY_REF.test(reference)) {
      const saved = this._savedSummary(reference); if (!saved) fail('CHAT_HISTORY_REFERENCE');
      row = { ref: reference, kind: 'summary', metadata: { path: saved.relative, ...(saved.entry ? { entry: saved.entry.id } : {}),
        ...this._metadata(saved.entry || saved.node.content), sources: saved.entries.flatMap(entry => entry.refs) } };
    }
    if (!row && /^C-[\w-]+\/M\d+(?:\/P\d+)?$/.test(reference)) {
      const candidates = this._open().prepare('SELECT ref,kind,metadata FROM refs WHERE ref LIKE ? ORDER BY rowid LIMIT 128').all(`${reference}%`);
      const selected = candidates.map(item => ({ ...item, metadata: JSON.parse(item.metadata) })).filter(item => item.metadata.sourceRef === reference || item.ref.startsWith(`${reference}/`) || item.ref.startsWith(`${reference}~`));
      if (!selected.length) fail('CHAT_HISTORY_REFERENCE');
      const pieces = []; let bytes = 0, first = null, last = 0, partial = candidates.length === 128;
      for (const item of selected) {
        if (!this._effective(item, intent) || item.metadata.image || end != null && item.metadata.start >= end || start != null && item.metadata.end <= start) continue;
        if (item.metadata.location.length > maxBytes - bytes) { partial = true; break; }
        const text = this._readRange(item.metadata.location, maxBytes - bytes), chars = Array.from(text), from = Math.max(0, (start ?? item.metadata.start) - item.metadata.start, last - item.metadata.start), to = Math.min(chars.length, (end ?? item.metadata.end) - item.metadata.start);
        if (to <= from) continue;
        bytes += Buffer.byteLength(text); pieces.push(chars.slice(from, to).join('')); first ??= item.metadata.start + from; last = item.metadata.start + to;
      }
      if (!pieces.length) fail('CHAT_HISTORY_REFERENCE');
      return { reference, ref: reference, text: pieces.join(''), start: first, end: last, unit: 'unicode-code-point', committed: true, metadata: { partial, continuation: partial ? last : null }, role: selected[0].metadata.role, time: selected[0].metadata.time };
    }
    if (!row || !this._effective(row, intent)) fail('CHAT_HISTORY_REFERENCE');
    if (row.metadata.image) {
      const image = row.metadata.image, file = this.journal.file(image.path); const stat = this.io.statSync(file);
      if (stat.size > 32 * 1024 * 1024 || stat.size !== image.size) fail('CHAT_HISTORY_IMAGE_CHANGED');
      const bytes = this.io.readFileSync(file); if (digest(bytes) !== image.sha256) fail('CHAT_HISTORY_IMAGE_CHANGED');
      return { reference: row.ref, ref: row.ref, metadata: row.metadata, image: { bytes, mime: image.mime, name: image.name } };
    }
    let text;
    if (row.metadata.location) text = this._readRange(row.metadata.location, maxBytes);
    else if (row.metadata.module) {
      const snapshot = row.metadata.moduleVersion ? this.memory.revision(row.metadata.module, row.metadata.moduleVersion).snapshot : this.memory.getModule(row.metadata.module);
      const item = snapshot.entries.find(entry => `${entry.id}@${entry.rev}` === reference); if (!item) fail('CHAT_HISTORY_SOURCE_CHANGED'); text = item.content;
    } else {
      let node = this.journal.read(row.metadata.path);
      if (['summary', 'handoff'].includes(row.kind) && !['history', 'quote'].includes(intent)) {
        const corrections = this._summaryCorrections();
        if (corrections.length) {
          const visible = row.kind === 'summary' ? node : { id: node.id, version: node.version, content: { text: node.modelView.summary.text, guide: '短交接', entries: [{ id: 'I01', text: node.modelView.summary.text, refs: node.sourceRefs }] } };
          const projected = new (require('./chat-summary.cjs').SummaryTree)({ projectRoot: this.journal.root, fs: this.io, countTokens: this.measure }).projectCurrent(visible, { corrections });
          node = row.kind === 'summary' ? projected : { ...node, modelView: { ...node.modelView, summary: { ...node.modelView.summary, text: projected.content.text } } };
        }
      }
      if (row.kind === 'handoff' && `${node?.id}@v${node?.version}` !== reference) fail('CHAT_HISTORY_SOURCE_CHANGED');
      text = row.metadata.entry ? node.content.entries.find(entry => entry.id === row.metadata.entry)?.text : node.content?.text ?? node.modelView?.summary?.text;
    }
    if (typeof text !== 'string' || Buffer.byteLength(text) > maxBytes) fail('CHAT_HISTORY_RANGE_BUDGET');
    const chars = Array.from(text), from = start ?? 0, to = end ?? chars.length;
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to <= from || to > chars.length) fail('CHAT_HISTORY_RANGE');
    return { reference: row.ref, ref: row.ref, kind: row.kind, text: chars.slice(from, to).join(''), role: row.metadata.role ?? null, time: row.metadata.time ?? null,
      start: (row.metadata.start || 0) + from, end: (row.metadata.start || 0) + to, unit: 'unicode-code-point', metadata: row.metadata, committed: true };
  }
  health() { return { ...this.healthState, ...(this.encoder ? this.encoder.status() : {}), vectorCoverage: this.healthState.pendingVectors === 0 ? 'ready' : 'partial' }; }
  _vectorCounts() {
    this.healthState.indexedVectors = this._open().prepare('SELECT COUNT(*) n FROM vectors WHERE dimensions>0 AND model=?').get(semanticFingerprint).n;
    this.healthState.pendingVectors = this._open().prepare('SELECT COUNT(*) n FROM refs LEFT JOIN vectors ON refs.ref=vectors.ref AND vectors.model=? WHERE vectors.ref IS NULL').get(semanticFingerprint).n;
    this._notifyHealth();
  }
  async rebuildIndex(options = {}) { return this.syncIndex({ ...options, rebuild: true }); }
  async updateIndex(options = {}) { return this.syncIndex(options); }
  _sources() {
    const result = []; let cursor = 0;
    do { const page = this.listConversations({ cursor, limit: 100 }); for (const item of page.conversations) {
      const stat = this.io.statSync(this.journal.file(item.relativePath)); result.push({ key: item.relativePath, fingerprint: `${stat.size}:${stat.mtimeMs}`, kind: 'archive', item });
    } cursor = page.nextCursor; } while (cursor !== null);
    for (const module of ['persona', 'userView', 'facts']) if (this.memory) result.push({ key: `memory:${module}`, fingerprint: String(this.memory.getModule(module).version), kind: 'memory', module });
    const tree = this.journal.read('memory/summaries/head.jsonl');
    for (const ref of Object.values(tree?.active || {})) { const relative = `memory/summaries/nodes/${ref}.jsonl`, stat = this.io.statSync(this.journal.file(relative)), node = this.journal.read(relative); result.push({ key: relative, fingerprint: `${stat.size}:${stat.mtimeMs}:${this._dependencySignature(node.content.entries.flatMap(entry => entry.refs || []))}`, kind: 'summary', ref }); }
    const recent = this.journal.read('memory/recent/current.jsonl');
    if (recent) result.push({ key: 'memory/recent/current.jsonl', fingerprint: `${recent.id}@v${recent.version}:${this._dependencySignature(recent.sourceRefs || [])}`, kind: 'handoff', recent });
    return result;
  }
  _dependencySignature(refs) {
    const modules = new Set(), visited = new Set(), pending = [...refs];
    while (pending.length && visited.size < 512) {
      const ref = pending.pop(); if (visited.has(ref)) continue; visited.add(ref);
      if (/^F-/.test(ref)) modules.add('facts'); else if (/^V-/.test(ref)) modules.add('userView'); else if (/^P-/.test(ref)) modules.add('persona');
      else if (/^L[1-9]\d*-[\w-]+@v\d+(?:#.+)?$/.test(ref)) {
        const node = this.journal.read(`memory/summaries/nodes/${ref.split('#')[0]}.jsonl`); if (node?.content?.entries) pending.push(...node.content.entries.flatMap(entry => entry.refs || []));
      }
    }
    return digest(Buffer.from(JSON.stringify([...modules].sort().map(module => [module, this.memory?.getModule(module).version || 0]))));
  }
  _metadata(entry) {
    const sources = (entry.sources || []).map(source => typeof source === 'string' ? source : source.type === 'chat' ? `${source.conversationId}/${source.messageId}` : source.type === 'operation' ? `O-${source.operationId}` : null).filter(Boolean);
    const important = typeof entry.importance === 'string' ? entry.importance : entry.importance?.category;
    const sourceTimes = (entry.sources || []).map(source => source.at).filter(value => Number.isFinite(Date.parse(value)));
    const discussedAt = entry.last_supported_at || entry.last_confirmed_at || sourceTimes.sort((a, b) => Date.parse(b) - Date.parse(a))[0] || null;
    return { sources, importance: sources.length && ['user_marked', 'notable'].includes(important) ? important : 'normal', importanceSources: sources, discussedAt,
      recordedAt: entry.recorded_at || null, eventTime: entry.event_time || null, eventStatus: entry.event_status || null, validFrom: entry.valid_from || null, validTo: entry.valid_to || null,
      factRefs: entry.id ? [`${entry.id}@${entry.rev}`] : (entry.refs || []).filter(ref => /^[PVF]-/.test(ref)), conflict: entry.event_status === 'disputed' };
  }
  _inheritMetadata(metadata, text) {
    const evidence = [];
    for (const ref of (metadata.sources || []).slice(0, 64)) {
      const exact = this._row(ref); if (exact) evidence.push(exact.metadata);
      else if (/^C-[\w-]+\/M\d+(?:\/P\d+)?$/.test(ref)) for (const row of this._open().prepare('SELECT metadata FROM refs WHERE ref LIKE ? ORDER BY rowid LIMIT 32').all(ref + '/%')) evidence.push(JSON.parse(row.metadata));
    }
    const times = evidence.map(item => item.discussedAt).filter(time => Number.isFinite(Date.parse(time)));
    if (!metadata.discussedAt && times.length) metadata.discussedAt = times.sort((a, b) => Date.parse(b) - Date.parse(a))[0];
    metadata.time ??= metadata.discussedAt;
    const importance = evidence.some(item => item.importance === 'user_marked') ? 'user_marked' : evidence.some(item => item.importance === 'notable') ? 'notable' : 'normal';
    if (metadata.importance === 'normal' && importance !== 'normal') { metadata.importance = importance; metadata.importanceSources = [...metadata.sources]; }
    metadata.factRefs = [...new Set([...(metadata.factRefs || []), ...evidence.flatMap(item => item.factRefs || [])])];
    metadata.claimRanges = [];
    for (const ref of (metadata.sources || []).slice(0, 16)) {
      if (!/^C-[\w-]+\/M\d+(?:\/P\d+)?(?:~\d+-\d+)?$/.test(ref)) continue;
      try {
        const source = this.resolveReference(ref, { intent: 'history', maxBytes: 65536 }), normalized = source.text.trim();
        // A sourced clause is only folded when its actual text occurs verbatim.
        // Semantic resemblance alone cannot prove that a negation is unchanged.
        const match = normalized && text.includes(normalized) || text.trim() && source.text.includes(text.trim());
        if (!match) continue;
        const claim = source.text.includes(text.trim()) ? text.trim() : normalized, index = source.text.indexOf(claim), start = source.start + Array.from(source.text.slice(0, index)).length;
        metadata.claimRanges.push({ sourceRef: source.metadata?.sourceRef || ref, start, end: start + Array.from(claim).length, textHash: digest(Buffer.from(claim)) });
      } catch {}
    }
    return metadata;
  }
  *_chunks(text) {
    const chars = Array.from(text), escapedOffsets = [0]; for (const char of chars) escapedOffsets.push(escapedOffsets.at(-1) + Buffer.byteLength(JSON.stringify(char).slice(1, -1)));
    for (let start = 0; start < chars.length;) {
      let end = Math.min(chars.length, start + 256);
      while (end > start + 1 && Buffer.byteLength(chars.slice(start, end).join('')) > 400) end--;
      // Prefer sentence boundaries, retaining a bounded overlapping tail.
      if (end < chars.length) for (let boundary = end; boundary > start + Math.floor((end - start) * 0.65); boundary--) if (/[。！？.!?\n]/u.test(chars[boundary - 1])) { end = boundary; break; }
      yield { text: chars.slice(start, end).join(''), start, end, total: chars.length, byteStart: escapedOffsets[start], byteEnd: escapedOffsets[end] };
      if (end === chars.length) break; start = end - Math.min(32, Math.floor((end - start) / 5));
    }
  }
  async *_documents(source) {
    if (source.kind === 'archive') {
      for await (const { record, line, offset } of this.records(source.key)) {
        if (!record.id || !['user', 'assistant'].includes(record.role)) continue;
        let scan = line.indexOf('"content":['); if (scan < 0) fail('CHAT_HISTORY_LOCATION');
        for (let part = 0; part < record.content.length; part++) {
          const content = record.content[part], base = `${source.item.conversationId}/${record.id}/P${String(part + 1).padStart(2, '0')}`;
          if (typeof content.text === 'string' && content.text.length) {
            const encoded = JSON.stringify(content.text), index = line.indexOf(encoded, scan); if (index < 0) fail('CHAT_HISTORY_LOCATION'); scan = index + encoded.length;
            const sourceOffset = offset + Buffer.byteLength(line.slice(0, index + 1));
            for (const chunk of this._chunks(content.text)) {
              const ref = chunk.start === 0 && chunk.end === chunk.total ? base : `${base}~${chunk.start}-${chunk.end}`;
              yield { ref, kind: 'original', text: chunk.text, metadata: { location: { path: source.key, offset: sourceOffset + chunk.byteStart, length: chunk.byteEnd - chunk.byteStart, hash: digest(Buffer.from(JSON.stringify(chunk.text).slice(1, -1))) }, sourceRef: base, sources: [`${source.item.conversationId}/${record.id}`], start: chunk.start, end: chunk.end, role: record.role, time: record.time, discussedAt: record.time, eventTime: null, importance: 'normal', turnId: record.turn_id, appendTo: record.append_to } };
            }
          } else if (content.image) yield { ref: base, kind: 'original', text: content.image.name || '图片', metadata: { image: content.image, role: record.role, time: record.time, discussedAt: record.time } };
        }
      }
    } else if (source.kind === 'memory') {
      const seen = new Set(); let offset = 0;
      do { const page = this.memory.history(source.module, { offset, limit: 100 }); for (const item of page.revisions) {
        const snapshot = this.memory.revision(source.module, item.revision).snapshot;
        for (const entry of snapshot.entries) { const ref = `${entry.id}@${entry.rev}`; if (seen.has(ref)) continue; seen.add(ref);
          yield { ref, kind: source.module, text: entry.content, metadata: { module: source.module, moduleVersion: item.revision, ...this._metadata(entry), time: entry.recorded_at } };
        }
      } offset = page.nextOffset; } while (offset !== null);
    } else if (source.kind === 'summary') {
      const node = this.journal.read(source.key);
      for (const entry of node.content.entries) yield { ref: `${source.ref}#${entry.id}`, kind: 'summary', text: entry.text, metadata: { path: source.key, entry: entry.id, ...this._metadata(entry), sources: entry.refs } };
    } else {
      const recent = source.recent; yield { ref: `${recent.id}@v${recent.version}`, kind: 'handoff', text: recent.modelView.summary.text, metadata: { path: source.key, ...this._metadata(recent.modelView.summary), sources: recent.sourceRefs } };
    }
  }
  _indexMetadata(doc, sourceKey) {
    doc.metadata.scriptGroup = scriptGroup(doc.text);
    for (const [a, b] of explicitAliases(doc.text)) for (const [alias, canonical] of [[a, b], [b, a]]) this._open().prepare('INSERT OR IGNORE INTO aliases(alias,canonical,ref,sourceKey) VALUES(?,?,?,?)').run(alias, canonical, doc.ref, sourceKey);
  }
  async _upgradeIndexMetadata(isCancelled) {
    const version = this._open().prepare("SELECT value FROM index_config WHERE key='metadata-analyzer'").get()?.value;
    if (version === '3') return;
    if (version === '2') {
      // Validate only persisted alias sources on this guard upgrade. Vectors,
      // all other postings and unchanged corpus metadata remain reusable.
      const rows = this._open().prepare('SELECT DISTINCT refs.ref,refs.kind,refs.metadata,refs.sourceKey FROM aliases JOIN refs ON aliases.ref=refs.ref').all();
      this._open().exec('DELETE FROM aliases');
      for (const row of rows) { if (isCancelled()) fail('CHAT_INDEX_CANCELLED'); try { const source = this.resolveReference(row.ref, { intent: 'history', maxBytes: 65536 }); if (!source.image) this._indexMetadata({ ...row, metadata: JSON.parse(row.metadata), text: source.text }, row.sourceKey); } catch {} await tick(); }
      this._open().prepare("INSERT OR REPLACE INTO index_config VALUES('metadata-analyzer','3')").run(); return;
    }
    let cursor = 0;
    for (;;) {
      if (isCancelled()) fail('CHAT_INDEX_CANCELLED');
      const rows = this._open().prepare('SELECT rowid,ref,kind,metadata,sourceKey FROM refs WHERE rowid>? ORDER BY rowid LIMIT 128').all(cursor);
      for (const row of rows) {
        cursor = row.rowid; const metadata = JSON.parse(row.metadata); if (metadata.scriptGroup) continue;
        try { const source = this.resolveReference(row.ref, { intent: 'history', maxBytes: 65536 }); if (source.image) metadata.scriptGroup = 'other';
          else { this._indexMetadata({ ...row, metadata, text: source.text }, row.sourceKey); }
          this._open().prepare('UPDATE refs SET metadata=? WHERE ref=?').run(JSON.stringify(metadata), row.ref);
        } catch { metadata.scriptGroup = 'other'; this._open().prepare('UPDATE refs SET metadata=? WHERE ref=?').run(JSON.stringify(metadata), row.ref); }
      }
      if (rows.length < 128) break; await tick();
    }
    this._open().prepare("INSERT OR REPLACE INTO index_config VALUES('metadata-analyzer','3')").run();
  }
  _queryTerms(query, intent) {
    const normalized = query.normalize('NFKC').toLowerCase(), expanded = [query];
    const keys = [...new Set([normalized, ...queryTerms(query)])];
    for (const key of keys.slice(0, 64)) {
      for (const pair of this._open().prepare('SELECT alias,canonical,ref FROM aliases WHERE alias=? LIMIT 8').all(key)) {
        const row = this._row(pair.ref); if (row && this._effective(row, intent)) expanded.push(pair.canonical); if (expanded.length >= 8) break;
      }
      if (expanded.length >= 8) break;
    }
    return [...new Set(expanded.flatMap(queryTerms))].slice(0, 64);
  }
  syncIndex({ isCancelled = () => false, rebuild = false, waitSemantic = false } = {}) {
    // A caller awaits coverage, not the fact that some older work is active.
    // Merge concurrent requirements and drain another pass after the current
    // snapshot so archives committed during a background save are included.
    const pending = this.pendingSync;
    this.pendingSync = { rebuild: rebuild || !!pending?.rebuild, waitSemantic: waitSemantic || !!pending?.waitSemantic,
      isCancelled: pending ? () => pending.isCancelled() || isCancelled() : isCancelled };
    if (!this.syncPromise) this.syncPromise = this._drainSync();
    return this.syncPromise;
  }
  async _drainSync() {
    let result;
    try {
      do {
        const options = this.pendingSync || {}; this.pendingSync = null;
        result = await this._performSync(options);
      } while (!this.closed && (this.pendingSync || this.syncRequested));
      return result;
    } finally { this.syncPromise = null; }
  }
  async _performSync({ isCancelled = () => false, rebuild = false, waitSemantic = false } = {}) {
    this.indexing = true;
    clearTimeout(this.syncTimer); this.syncTimer = null; this.syncRequested = false;
    this.healthState.index = this.healthState.coverage = 'indexing';
    this._notifyHealth();
    if (isCancelled()) { this.indexing = false; fail('CHAT_INDEX_CANCELLED'); }
    if (this.useWorker) {
      const timer = setInterval(() => { if (isCancelled()) this.worker?.postMessage({ cancel: true }); }, 20); timer.unref?.();
      try { return await this._workerRequest('syncIndex', { rebuild, waitSemantic }, 900000); } finally { clearInterval(timer); this.indexing = false; }
    }
    const db = this._open(), watermark = this.watermark(), sources = this._sources(), current = new Map(sources.map(source => [source.key, source])); let indexed = 0, changedFiles = 0, unchangedFiles = 0;
    this.encoder.warm().then(() => this._notifyHealth()); this.vectorEpoch++; this.vectorCache = null;
    db.exec('BEGIN');
    try {
      const oldSources = db.prepare('SELECT sourceKey,fingerprint FROM source_manifest').all();
      const remove = key => { if (rebuild) db.prepare('DELETE FROM vectors WHERE ref IN (SELECT ref FROM refs WHERE sourceKey=?)').run(key); db.prepare('DELETE FROM aliases WHERE sourceKey=?').run(key); db.prepare('DELETE FROM postings WHERE rowid IN (SELECT rowid FROM refs WHERE sourceKey=?)').run(key); db.prepare('DELETE FROM refs WHERE sourceKey=?').run(key); db.prepare('DELETE FROM source_manifest WHERE sourceKey=?').run(key); };
      for (const old of oldSources) if (rebuild || !current.has(old.sourceKey) || current.get(old.sourceKey).fingerprint !== old.fingerprint) remove(old.sourceKey);
      const insert = db.prepare('INSERT OR IGNORE INTO refs(ref,kind,metadata,sourceKey) VALUES(?,?,?,?)'), posting = db.prepare('INSERT INTO postings(rowid,terms) VALUES(?,?)');
      const oldMap = new Map(oldSources.map(source => [source.sourceKey, source.fingerprint]));
      for (const source of sources) {
        if (isCancelled()) fail('CHAT_INDEX_CANCELLED');
        if (!rebuild && oldMap.get(source.key) === source.fingerprint) { unchangedFiles++; continue; } changedFiles++;
        for await (const doc of this._documents(source)) {
          if (isCancelled()) fail('CHAT_INDEX_CANCELLED');
          doc.metadata.textHash = digest(Buffer.from(doc.text));
          this._indexMetadata(doc, source.key);
          if (doc.kind !== 'original') this._inheritMetadata(doc.metadata, doc.text);
          else if (!doc.metadata.image) doc.metadata.claimRanges = [{ sourceRef: doc.metadata.sourceRef, start: doc.metadata.start, end: doc.metadata.end, textHash: doc.metadata.textHash }];
          const result = insert.run(doc.ref, doc.kind, JSON.stringify(doc.metadata), source.key);
          if (result.changes) { posting.run(result.lastInsertRowid, terms(doc.text).join(' ')); indexed++; }
          if (indexed % 32 === 0) await tick();
        }
        db.prepare('INSERT OR REPLACE INTO source_manifest(sourceKey,fingerprint) VALUES(?,?)').run(source.key, source.fingerprint);
      }
      await this._upgradeIndexMetadata(isCancelled);
      // Revision histories can grow while most referenced text is unchanged.
      // Reuse only vectors whose exact reference and source text hash survive;
      // explicit rebuild still regenerates everything in the selected source.
      db.prepare("DELETE FROM vectors WHERE model<>? OR NOT EXISTS (SELECT 1 FROM refs WHERE refs.ref=vectors.ref AND json_extract(refs.metadata,'$.textHash')=vectors.textHash)").run(semanticFingerprint);
      db.prepare('INSERT OR REPLACE INTO manifest(id,watermark) VALUES(1,?)').run(watermark); db.exec('COMMIT');
      const status = this.watermark() === watermark ? 'ready' : 'partial'; this.healthState.index = this.healthState.coverage = status; this.healthState.sourceWatermark = watermark;
      this._vectorCounts(); const task = this._buildVectors(isCancelled); if (waitSemantic) { await task; if (this.encoder.state === 'ready') await this._loadVectorCache(); }
      return { status, indexed, changedFiles, unchangedFiles, watermark, ...this.health() };
    } catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); this.healthState.index = this.healthState.coverage = 'partial'; throw error; } finally { this.indexing = false; }
  }
  async _buildVectors(isCancelled = () => false) {
    const epoch = this.vectorEpoch;
    if (!await this.encoder.warm() || this.closed || epoch !== this.vectorEpoch) return;
    let inserted = 0, cursor = 0; this._vectorCounts();
    try {
      for (;;) {
        if (this.closed || epoch !== this.vectorEpoch || isCancelled()) break;
        const pending = this._open().prepare('SELECT refs.rowid,refs.ref,refs.kind,refs.metadata FROM refs LEFT JOIN vectors ON refs.ref=vectors.ref WHERE refs.rowid>? AND vectors.ref IS NULL ORDER BY refs.rowid LIMIT 16').all(cursor);
        if (!pending.length) break;
        cursor = pending.at(-1).rowid;
        const docs = []; for (const row of pending) {
          try { const value = this.resolveReference(row.ref, { intent: 'history', maxBytes: 65536 });
            if (value.image) { this._open().prepare('INSERT OR REPLACE INTO vectors VALUES(?,?,?,?,?)').run(row.ref, semanticFingerprint, Buffer.alloc(0), 0, JSON.parse(row.metadata).textHash); continue; }
            // Long memory entries are embedded in bounded windows and pooled;
            // the indexed reference still resolves to its complete real source.
            const chunks = [...this._chunks(value.text)].map(chunk => chunk.text); docs.push({ row, chunks });
          } catch { this._open().prepare('INSERT OR REPLACE INTO vectors VALUES(?,?,?,?,?)').run(row.ref, semanticFingerprint, Buffer.alloc(0), 0, JSON.parse(row.metadata).textHash); }
        }
        const batches = docs.flatMap((doc, index) => doc.chunks.map(text => ({ text, index }))), totals = docs.map(() => new Float32Array(384)), counts = docs.map(() => 0);
        for (let offset = 0; offset < batches.length; offset += 16) {
          if (this.closed || epoch !== this.vectorEpoch || isCancelled()) return;
          const batch = batches.slice(offset, offset + 16), embeddings = await this.encoder.encode(batch.map(item => item.text));
          this.healthState.encodedTextWindows = (this.healthState.encodedTextWindows || 0) + batch.length; this.healthState.encoderCalls = (this.healthState.encoderCalls || 0) + 1;
          embeddings.forEach((vector, n) => { const index = batch[n].index; for (let k = 0; k < vector.length; k++) totals[index][k] += vector[k]; counts[index]++; }); await tick();
        }
        if (this.closed || epoch !== this.vectorEpoch || isCancelled()) return;
        this._open().exec('BEGIN'); let added = 0;
        try {
          for (let index = 0; index < docs.length; index++) {
            const { row } = docs[index], total = totals[index], metadata = JSON.parse(row.metadata), stillCurrent = this._row(row.ref);
            const length = Math.sqrt(total.reduce((sum, value) => sum + value * value, 0)); if (length) for (let n = 0; n < total.length; n++) total[n] /= length;
            if (counts[index] && stillCurrent?.metadata.textHash === metadata.textHash) { this._open().prepare('INSERT OR REPLACE INTO vectors VALUES(?,?,?,?,?)').run(row.ref, semanticFingerprint, Buffer.from(total.buffer), total.length, metadata.textHash); inserted++; added++; }
          }
          this._open().exec('COMMIT');
        } catch (error) { if (this._open().isTransaction) this._open().exec('ROLLBACK'); throw error; }
        this.vectorCache = null; this.healthState.indexedVectors += added; this.healthState.pendingVectors = Math.max(0, this.healthState.pendingVectors - pending.length); this._notifyHealth(); await tick();
      }
    } catch { this.healthState.semanticReason = 'vector-build-failed'; }
    finally { if (!this.closed) { this._vectorCounts(); if (this.healthState.pendingVectors === 0) this._loadVectorCache(); } }
    return inserted;
  }
  _loadVectorCache() {
    if (this.vectorCache) return Promise.resolve(this.vectorCache);
    if (this.vectorCachePromise) return this.vectorCachePromise;
    const epoch = this.vectorEpoch;
    this.vectorCachePromise = (async () => {
      const result = []; let after = 0;
      for (;;) {
        if (this.closed || epoch !== this.vectorEpoch) return null;
        const rows = this._open().prepare('SELECT vectors.rowid AS vectorRowid,refs.ref,refs.kind,refs.metadata,vectors.embedding FROM vectors JOIN refs ON refs.ref=vectors.ref WHERE vectors.model=? AND vectors.dimensions=384 AND vectors.rowid>? ORDER BY vectors.rowid LIMIT 1000').all(semanticFingerprint, after);
        for (const row of rows) {
          const all = JSON.parse(row.metadata), bytes = row.embedding;
          const vector = bytes.byteOffset % 4 === 0 ? new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4) : new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
          // Keep only ranking fields hot. Exact ranges, dependency lists and
          // image metadata are read for the bounded finalists, not duplicated
          // for every one of a hundred thousand vectors in memory.
          result.push({ ref: row.ref, kind: row.kind, metadata: { scriptGroup: all.scriptGroup, textHash: all.textHash, time: all.time, discussedAt: all.discussedAt, eventTime: all.eventTime }, vector }); after = row.vectorRowid;
        }
        if (rows.length < 1000) break; await tick();
      }
      if (!this.closed && epoch === this.vectorEpoch) {
        const groups = { han: { count: 0, sum: new Float64Array(384) }, latin: { count: 0, sum: new Float64Array(384) } }, seen = new Set();
        for (const row of result) { const group = groups[row.metadata.scriptGroup]; if (!group || seen.has(row.metadata.textHash)) continue; seen.add(row.metadata.textHash); group.count++; for (let n = 0; n < 384; n++) group.sum[n] += row.vector[n]; }
        for (const group of Object.values(groups)) { group.mean = Float64Array.from(group.sum, value => value / Math.max(1, group.count)); group.normSquared = group.mean.reduce((sum, value) => sum + value * value, 0); }
        // Center only supported bilingual groups with enough independent texts.
        // Unknown scripts retain the unmodified cosine baseline for the whole
        // cache, so incomparable raw/centered scores are never mixed.
        const usable = this.semanticOptions.centering !== false && groups.han.count >= 4 && groups.latin.count >= 4 && result.every(row => groups[row.metadata.scriptGroup]);
        if (usable) for (let index = 0; index < result.length; index++) {
          const row = result[index]; row.meanDots = {};
          for (const key of ['han', 'latin']) { let dot = 0; for (let n = 0; n < 384; n++) dot += row.vector[n] * groups[key].mean[n]; row.meanDots[key] = dot; }
          const own = groups[row.metadata.scriptGroup]; if (own) row.centeredNorm = Math.sqrt(Math.max(1e-12, 1 - 2 * row.meanDots[row.metadata.scriptGroup] + own.normSquared));
          if (index % 2048 === 0) await tick();
        }
        if (!this.closed && epoch === this.vectorEpoch) { this.vectorCache = result; this.vectorCenters = usable ? groups : null; this.healthState.semanticRanking = usable ? 'language-centered-cosine' : 'cosine'; }
      }
      return this.vectorCache;
    })().catch(() => null).finally(() => { this.vectorCachePromise = null; });
    return this.vectorCachePromise;
  }
  async _semanticCandidates(query, { types, after, before, timeBasis = 'discussion', deadline = Date.now() + 1150 } = {}) {
    if (this.encoder.state !== 'ready') { this.encoder.warm(); return []; }
    if (!this.vectorCache) { this._loadVectorCache(); return []; }
    const [vector] = await this.encoder.encode([query], { query: true });
    const group = scriptGroup(query), centers = this.vectorCenters, queryCenter = centers?.[group], queryDots = {};
    if (queryCenter) for (const key of ['han', 'latin']) { let value = 0; for (let n = 0; n < 384; n++) value += vector[n] * centers[key].mean[n]; queryDots[key] = value; }
    const queryNorm = queryCenter ? Math.sqrt(Math.max(1e-12, 1 - 2 * queryDots[group] + queryCenter.normSquared)) : 1;
    const meanCross = {}; if (queryCenter) for (const key of ['han', 'latin']) meanCross[key] = centers[key].mean.reduce((sum, value, n) => sum + value * queryCenter.mean[n], 0);
    const best = []; let visited = 0;
    for (const row of this.vectorCache) {
      if (++visited % 2048 === 0) { await tick(); if (Date.now() >= deadline) { best.partial = true; break; } }
      const date = timeBasis === 'event' ? row.metadata.eventTime : row.metadata.discussedAt || row.metadata.time;
      if (types && !types.includes(row.kind) || after && (!date || Date.parse(date) < Date.parse(after)) || before && (!date || Date.parse(date) > Date.parse(before))) continue;
      let score = 0; for (let n = 0; n < vector.length; n++) score += vector[n] * row.vector[n];
      const rawCosine = score;
      if (queryCenter && row.centeredNorm) score = (score - queryDots[row.metadata.scriptGroup] - row.meanDots[group] + meanCross[row.metadata.scriptGroup]) / (queryNorm * row.centeredNorm);
      // E5's absolute cosine scale is not a confidence score. Preserve the
      // existing broad recall gate; centering only changes the semantic order.
      if (rawCosine < 0.72 || best.length >= 128 && score <= best.at(-1).similarity) continue;
      best.push({ ...row, vector: undefined, similarity: score }); best.sort((a, b) => b.similarity - a.similarity); if (best.length > 128) best.pop();
    }
    const finalists = best.map(item => { const row = this._row(item.ref); return row ? { ...row, similarity: item.similarity } : null; }).filter(Boolean);
    if (best.partial) finalists.partial = true; return finalists;
  }
  beginTurn({ id = randomUUID(), availableTokens = 3000 } = {}) {
    const state = { id, searches: 0, reads: 0, used: 0, delivered: new Set(), availableTokens }; const turn = Object.freeze({ id }); this.turns.set(turn, state); return turn;
  }
  _budget(turn, kind) {
    const state = this.turns.get(turn); if (!state || state[kind] >= (kind === 'searches' ? 2 : 1)) fail('CHAT_SEARCH_CALL_LIMIT');
    const available = Math.min(state.availableTokens, this.getAvailableTokens());
    return { state, remaining: Math.max(0, Math.min(kind === 'searches' ? 1200 : 1600, 3000 - state.used, available)) };
  }
  _finish(turn, kind, result, remaining) {
    const state = this.turns.get(turn); let size = tokens(result, this.measure);
    while (size > remaining && result.cards.length) { result.cards.pop(); if (kind === 'reads') result.status = 'partial'; size = tokens(result, this.measure); }
    state[kind]++;
    if (size > remaining) return { status: 'capacity', cards: [] };
    state.used += size; for (const card of result.cards) state.delivered.add(`${card.ref}:${card.start}:${card.end}`); return result;
  }
  async searchRecords(input, turn) {
    if (this.useWorker) return this._workerResult('searchRecords', input, turn, 'searches');
    if (typeof input === 'string') input = { queries: [input] };
    const { queries = typeof input?.query === 'string' ? [input.query] : undefined, intent = 'current', types, after, before, timeBasis = 'discussion' } = input || {};
    if (!Array.isArray(queries) || queries.length < 1 || queries.length > 3 || queries.some(query => typeof query !== 'string') || Array.from(queries.join('')).length > 256 || !['auto', 'current', 'history', 'quote'].includes(intent)) fail('CHAT_SEARCH_QUERY');
    if (!['discussion', 'event'].includes(timeBasis) || [after, before].some(value => value != null && !Number.isFinite(Date.parse(value)))) fail('CHAT_SEARCH_QUERY');
    const historical = intent === 'history' || intent === 'quote';
    const { state, remaining } = this._budget(turn, 'searches'), epoch = this.watermark(), lists = [], byRef = new Map(), exactTargets = new Set(), started = Date.now(); let partial = this.indexing;
    for (const query of queries) {
      const exact = safeRef(query) ? this._row(query) : null;
      if (exact && this._effective(exact, historical ? 'history' : 'current')) { byRef.set(exact.ref, exact); exactTargets.add(exact.ref); lists.push([exact.ref]); continue; }
      const match = this._queryTerms(query, intent === 'history' || intent === 'quote' ? 'history' : 'current').map(term => `"${term.replaceAll('"', '""')}"`).join(' OR '); if (!match) continue;
      const rows = this._open().prepare('SELECT ref,kind,metadata,bm25(postings) AS rank FROM postings JOIN refs ON refs.rowid=postings.rowid WHERE postings MATCH ? ORDER BY rank LIMIT 128').all(match);
      const valid = [];
      for (const row of rows) { row.metadata = JSON.parse(row.metadata); if (Date.now() - started > 1500) { partial = true; break; }
        const date = timeBasis === 'event' ? row.metadata.eventTime : row.metadata.discussedAt || row.metadata.time;
        if (!this._effective(row, historical ? 'history' : 'current') || types && !types.includes(row.kind) || after && (!date || Date.parse(date) < Date.parse(after)) || before && (!date || Date.parse(date) > Date.parse(before))) continue;
        byRef.set(row.ref, row); valid.push(row.ref); if (valid.length >= 30) break;
      }
      if (rows.length === 128 && valid.length < 30) partial = true; lists.push(valid);
    }
    let semanticReason = this.encoder.reason;
    try { for (const query of queries) {
      if (exactTargets.has(query)) continue;
      if (Date.now() - started > 1000) { partial = true; break; }
      const semantic = await this._semanticCandidates(query, { types, after, before, timeBasis, deadline: started + 1150 }); if (semantic.partial) partial = true; const valid = [];
      for (const row of semantic) if (this._effective(row, historical ? 'history' : 'current')) { byRef.set(row.ref, row); valid.push(row.ref); if (valid.length >= 30) break; }
      if (valid.length) lists.push(valid);
    } } catch { semanticReason = 'semantic-query-unavailable'; }
    const cards = [], selectedRows = [];
    const ranked = rerankNear(reciprocalRankFusion(lists), byRef, { historical: historical || !!after || !!before, timeBasis }); ranked.sort((a, b) => Number(exactTargets.has(b.ref)) - Number(exactTargets.has(a.ref)));
    for (const { ref } of ranked) {
      if (cards.length >= 4) break;
      const row = byRef.get(ref); if (selectedRows.some(selected => evidenceDuplicate(row, selected))) continue;
      try {
        if (row.metadata.image) { cards.push({ ref, image: true, time: row.metadata.time ?? null }); continue; }
        const value = this.resolveReference(ref, { intent: historical ? 'history' : 'current' });
        if (state.delivered.has(`${ref}:${value.start}:${value.end}`)) continue;
        const maximum = Math.max(32, Math.min(400, Math.floor(remaining / 6))), chars = Array.from(value.text);
        const needle = queries.flatMap(query => terms(query)).find(term => value.text.toLowerCase().includes(term)), hit = needle ? Array.from(value.text.slice(0, value.text.toLowerCase().indexOf(needle))).length : 0;
        const begin = Math.max(0, Math.min(chars.length - maximum, hit - 40)), text = chars.slice(begin, begin + maximum).join('');
        cards.push({ ref, text, start: value.start + begin, end: value.start + begin + Array.from(text).length, unit: value.unit, role: value.role, time: value.time, eventTime: row.metadata.eventTime, kind: row.kind, historical, ...(chars.length > maximum ? { partial: true } : {}) }); selectedRows.push(row);
      } catch { partial = true; }
    }
    if (this.watermark() !== epoch) return this._finish(turn, 'searches', { status: 'partial', cards: [], reason: 'saved-state-changed', semantic: this.encoder.state }, remaining);
    const coverage = this._open().prepare('SELECT watermark FROM manifest WHERE id=1').get()?.watermark;
    return this._finish(turn, 'searches', { status: partial || coverage !== epoch ? 'partial' : 'ready', cards, coverage: coverage ?? null, semantic: this.encoder.state, vectorCoverage: this.health().vectorCoverage, ...(this.encoder.reason || semanticReason ? { semanticReason: this.encoder.reason || semanticReason } : {}) }, remaining);
  }
  async readRecords({ references, reference, start, end, intent = 'current' } = {}, turn) {
    if (this.useWorker) return this._workerResult('readRecords', { references, reference, start, end, intent }, turn, 'reads');
    if (!references && reference) references = [{ ref: reference, ...(start !== undefined ? { start } : {}), ...(end !== undefined ? { end } : {}) }];
    if (!Array.isArray(references) || !references.length || references.length > 4) fail('CHAT_SEARCH_REFERENCES');
    const { state, remaining } = this._budget(turn, 'reads'), epoch = this.watermark(), cards = []; let bytes = 0, partial = false;
    for (const value of references) {
      const ref = typeof value === 'string' ? value : value.ref;
      try {
        const row = this._row(ref); if (row?.metadata.image && this._effective(row, intent)) { cards.push({ ref, image: true, metadata: row.metadata }); continue; }
        const source = this.resolveReference(ref, { ...(typeof value === 'object' ? value : {}), maxBytes: 65536 - bytes, intent });
        if (source.image) { cards.push({ ref, image: true, metadata: source.metadata }); continue; }
        bytes += Buffer.byteLength(source.text); if (!state.delivered.has(`${ref}:${source.start}:${source.end}`)) cards.push({ ref, text: source.text, start: source.start, end: source.end, unit: source.unit, time: source.time, role: source.role });
      } catch { partial = true; }
    }
    if (this.watermark() !== epoch) return this._finish(turn, 'reads', { status: 'partial', cards: [], reason: 'saved-state-changed' }, remaining);
    return this._finish(turn, 'reads', { status: partial ? 'partial' : 'ready', cards, coverage: epoch }, remaining);
  }
  async nativeRecords(input, turn) {
    if (typeof this.getNative !== 'function') return { status: 'unavailable', cards: [], reason: 'native-reader-unavailable' };
    const kind = input?.references || input?.reference ? 'reads' : 'searches', { remaining } = this._budget(turn, kind);
    const result = await this.getNative({ ...input, maximumBytes: 65536, maximumTokens: remaining, maximumReferences: 4 });
    if (!result || !Array.isArray(result.cards) || result.cards.length > 4) fail('CHAT_NATIVE_RETRIEVAL_INVALID');
    return this._finish(turn, kind, { status: result.status || 'partial', cards: result.cards }, remaining);
  }
  tools(turn) { return async ({ name, arguments: args }) => {
    if (typeof args === 'string') args = JSON.parse(args);
    if (name === 'search_records') {
      const result = await this.searchRecords(args, turn);
      if (!result.cards.length && (!args?.intent || args.intent === 'auto') && this.getNative && this.turns.get(turn).searches < 2) {
        const native = await this.nativeRecords(args, turn); return { ...native, historicalCoverage: result.coverage ?? null, source: 'current-native-thread' };
      }
      return result;
    }
    if (name === 'read_record') {
      const reference = args?.reference || (args?.references?.length === 1 ? args.references[0] : null);
      if (typeof reference === 'string' && !this._row(reference) && !/^C-[\w-]+\//.test(reference) && !SUMMARY_REF.test(reference) && this.getNative) return this.nativeRecords(args, turn);
      return this.readRecords(args, turn);
    }
    return fail('CHAT_TOOL_DENIED');
  }; }
  close() {
    if (this.closeInFlight) return this.closePromise;
    this.closed = true; this.healthListeners.clear(); clearTimeout(this.syncTimer); this.syncTimer = null; this.memory?.off?.('commit', this.onMemoryCommit); this.vectorEpoch++;
    this.closeInFlight = true;
    const worker = this.worker;
    if (worker) {
      this.closePromise = new Promise(resolve => {
        let settled = false;
        const finish = () => { if (settled) return; settled = true; clearTimeout(timeout); this.worker = null; this.db?.close(); this.db = null; this.closeInFlight = false; resolve(); };
        const timeout = setTimeout(() => { worker.terminate().catch(() => {}).finally(finish); }, 15000);
        worker.once('exit', finish); worker.once('error', finish);
        // The worker queues this behind any active indexing request, cancels
        // further work, waits for semantic warm/dispose, then exits itself.
        worker.postMessage({ id: randomUUID(), method: 'close' });
      });
      return this.closePromise;
    }
    this.closePromise = (async () => {
      try { await this.syncPromise; } catch {}
      try { await this.encoder?.close?.(); } catch {}
      this.db?.close(); this.db = null; this.closeInFlight = false;
    })();
    return this.closePromise;
  }
}
module.exports = { ChatHistory };
