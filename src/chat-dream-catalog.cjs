'use strict';
const { createHash } = require('node:crypto');
const { terms } = require('./chat-search.cjs');
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const originalRef = source => source.type === 'chat' ? `${source.conversationId}/${source.messageId}${source.part ? `/${source.part}` : ''}` : null;
const keyOf = ref => ref.split('@')[0];

// This is a derived, resumable directory of references and short index terms,
// not another archive of conversation bodies. The persisted metadata directory
// grows with the archive; only the comparison queue (192) and each scan page
// (48) are bounded. Snapshots are still read one whole module at a time.
class DreamCatalog {
  constructor({ journal, memory, history, tree, handoff, clock = Date.now, measure } = {}) {
    Object.assign(this, { journal, memory, history, tree, handoff, clock, measure });
  }
  state() {
    const value = this.journal.read('memory/dreaming/catalog.jsonl');
    if (!value) return { schema: 'codex-maid-dream-catalog/1', cursor: { module: 0, offset: 0 }, cycles: 0, scanned: 0, entries: {}, queue: [], signals: [] };
    if (value.schema !== 'codex-maid-dream-catalog/1' || !value.cursor || !value.entries || Array.isArray(value.entries) || !Array.isArray(value.signals)) throw Object.assign(new Error('CHAT_DREAM_CATALOG_INVALID'), { code: 'CHAT_DREAM_CATALOG_INVALID' });
    return value;
  }
  _save(value) { this.journal.write('memory/dreaming/catalog.jsonl', value); }
  scan({ pages = 1 } = {}) {
    if (!Number.isInteger(pages) || pages < 1 || pages > 4) throw new Error('CHAT_DREAM_CATALOG_PAGE_LIMIT');
    const state = this.state();
    for (let page = 0; page < pages; page++) {
      const result = this.memory.scanMaintenance({ cursor: state.cursor, limit: 48 });
      for (const entry of result.entries) {
        const ref = `${entry.id}@${entry.rev}`, sources = (entry.sources || []).map(originalRef).filter(Boolean);
        if (!sources.length || ['core', 'boundary', 'overall'].includes(entry.kind) || !this.memory.filterEvidence(ref).allowed) { delete state.entries[entry.id]; continue; }
        const importance = typeof entry.importance === 'string' ? entry.importance : entry.importance?.category;
        state.entries[entry.id] = { module: result.module, ref, kind: entry.kind, terms: [...new Set(terms(entry.content))].slice(0, 24),
          objects: [...new Set([...(entry.object_ids || []), ...(typeof entry.subject === 'string' ? [entry.subject] : [])])].slice(0, 8),
          sources: sources.slice(0, 8), importance: ['user_marked', 'notable'].includes(importance) ? importance : 'normal',
          fingerprint: hash({ content: entry.content, sources: entry.sources, rev: entry.rev }), seenAt: this.clock() };
        state.queue = [...(state.queue || []).filter(id => id !== entry.id), entry.id].slice(-192);
      }
      state.cursor = result.nextCursor; state.scanned += result.entries.length;
      if (result.cycleComplete) state.cycles++;
    }
    this._save(state); return state;
  }
  recordSignals({ checkpointId, sourceWatermark, signals = [], allowedSources = new Set() } = {}) {
    if (!Array.isArray(signals)) return { recorded: 0 };
    const state = this.state(); let recorded = 0;
    for (const signal of signals.slice(0, 8)) {
      if (!signal || !['duplicate', 'drift', 'distributed'].includes(signal.kind) || typeof signal.topic !== 'string' || !signal.topic.trim() || signal.topic.length > 160 ||
          !Array.isArray(signal.targets) || !signal.targets.length || signal.targets.length > 4 || !Array.isArray(signal.sources) || !signal.sources.length || signal.sources.length > 6 ||
          signal.sources.some(ref => typeof ref !== 'string' || !allowedSources.has(ref))) continue;
      const targets = [...new Set(signal.targets)];
      if (targets.some(ref => { try { return !this.memory.maintenanceDependency(ref).effective; } catch { return true; } })) continue;
      if (signal.kind !== 'drift' && targets.length < 2) continue;
      const identity = hash({ kind: signal.kind, targets: [...targets].sort(), sources: [...signal.sources].sort() });
      if (state.signals.some(item => item.id === identity)) continue;
      state.signals.push({ id: identity, checkpointId, sourceWatermark, kind: signal.kind, topic: signal.topic, targets,
        sources: [...new Set(signal.sources)], at: this.clock(), status: 'pending' }); recorded++;
    }
    this._save(state); return { recorded };
  }
  health() { const state = this.state(); return { scanned: state.scanned, catalogued: Object.keys(state.entries).length, scanComplete: state.cycles > 0, cycles: state.cycles,
    nextCursor: state.cursor, comparisonWindow: (state.queue || []).length, comparisonLimit: 192, metadataScope: 'all-discovered',
    availableTasks: state.signals.filter(item => item.status === 'pending').length, necessity: 'verified-checkpoint-signals-only' }; }
  select({ mode, target, jobs = [] } = {}) {
    const state = this.scan({ pages: mode === 'manual' ? 4 : 1 }), priorities = { user_marked: 3, notable: 2, normal: 1 }, choices = [];
    for (const signal of state.signals.filter(item => item.status === 'pending')) {
      const items = signal.targets.map(ref => state.entries[keyOf(ref)]).filter(item => item?.ref && signal.targets.includes(item.ref));
      choices.push({ refs: signal.targets, signal, priority: Math.max(1, ...items.map(item => priorities[item.importance] || 1)) * 10 + (signal.kind === 'drift' ? 3 : 1) });
    }
    if (mode === 'manual') {
      const items = (state.queue || []).map(id => state.entries[id]).filter(Boolean).sort((a, b) => (priorities[b.importance] || 1) - (priorities[a.importance] || 1) || a.seenAt - b.seenAt || a.ref.localeCompare(b.ref));
      for (const item of items) {
        const related = items.filter(other => other.ref !== item.ref && (item.objects.some(object => other.objects.includes(object)) || item.sources.some(ref => other.sources.includes(ref)) || item.terms.filter(term => other.terms.includes(term)).length >= 2)).slice(0, 3);
        choices.push({ refs: [item.ref, ...related.map(other => other.ref)], signal: null, priority: priorities[item.importance] || 1 });
      }
    }
    for (const choice of choices.sort((a, b) => b.priority - a.priority || (a.signal?.at || 0) - (b.signal?.at || 0))) {
      let dependencies;
      try { dependencies = choice.refs.map(ref => this.memory.maintenanceDependency(ref)); if (dependencies.some(item => !item.effective)) continue; } catch { continue; }
      const sourceWatermark = hash({ targets: dependencies.map(item => keyOf(item.ref)).sort(),
        sources: [...new Set([...dependencies.flatMap(item => item.entry.sources || []).map(originalRef).filter(Boolean), ...(choice.signal?.sources || [])])].sort() });
      if (jobs.some(job => job.sourceWatermark === sourceWatermark && job.calls > 0)) continue;
      return { committed: true, target, sourceWatermark, baseline: hash(dependencies.map(item => [item.ref, item.fingerprint, item.safety])),
        necessary: !!choice.signal, signal: choice.signal, dependencies,
        entries: dependencies.map(item => ({ ...item.entry, module: item.module })), entryRefs: dependencies.map(item => item.ref),
        module: dependencies[0].module, baseVersion: dependencies[0].descriptor.version,
        operationWatermark: this.memory.getState().operationWatermark, model: null, effort: null };
    }
    return null;
  }
  async materialize(task) {
    const evidence = [], seen = new Set(); let bytes = 0;
    const add = (reference, text, kind, extra = {}) => {
      const existing = evidence.find(item => item.ref === reference);
      if (existing) { existing.supports = [...new Set([...(existing.supports || []), ...(extra.supports || [])])]; return; }
      if (seen.has(reference) || typeof text !== 'string' || !text || Buffer.byteLength(text) > 1600 || evidence.length >= 6 || bytes + Buffer.byteLength(text) > 3200) return;
      seen.add(reference); bytes += Buffer.byteLength(text); evidence.push({ id: `E${evidence.length + 1}`, ref: reference, text, kind, hash: hash(text), ...extra });
    };
    for (const dependency of task.dependencies) {
      for (const source of (dependency.entry.sources || []).slice(0, 4)) {
        const reference = originalRef(source); if (!reference) continue;
        try { const resolved = await this.history.resolveReference(reference, { maxBytes: 2048 }); if (resolved?.text) add(reference, resolved.text, 'original', { start: resolved.start || 0, end: resolved.end, role: resolved.role, supports: [dependency.ref] }); } catch {}
      }
    }
    // A same-checkpoint signal can point at newly archived evidence that is
    // not yet a stored entry source. Resolve it separately, and attest only
    // claims whose visible sentence identifies the existing claim. A model's
    // signal itself does not make a message evidence for an arbitrary target.
    for (const reference of (task.signal?.sources || []).slice(0, 6)) {
      try {
        const resolved = await this.history.resolveReference(reference, { maxBytes: 2048 });
        const sentences = resolved.text.match(/[^。！？.!?\n]+[。！？.!?]?/gu) || [];
        const supports = task.dependencies.filter(item => sentences.some(sentence => this.memory._sameRepairClaim(item.entry.content, sentence, item.entry) ||
          [item.entry.subject, ...(item.entry.object_ids || [])].filter(value => typeof value === 'string' && value.length >= 2 && item.entry.content.includes(value)).some(value => sentence.includes(value)))).map(item => item.ref);
        if (supports.length) add(reference, resolved.text, 'original', { start: resolved.start || 0, end: resolved.end, role: resolved.role, supports });
      } catch {}
    }
    const tree = this.tree.state();
    const conversationIds = new Set(task.dependencies.flatMap(item => item.entry.sources || []).filter(source => source.type === 'chat').map(source => source.conversationId));
    for (const conversationId of [...conversationIds].slice(0, 3)) {
      const reference = tree.conversations[conversationId]?.ref; if (!reference) continue;
      try { const node = this.tree.read(reference); for (const entry of node.content.entries.slice(0, 2)) add(`${reference}#${entry.id}`, entry.text, 'summary', { supports: task.dependencies.filter(item => item.entry.sources.some(source => source.conversationId === conversationId)).map(item => item.ref) }); } catch {}
    }
    try {
      const recent = this.handoff.current();
      if (recent && (recent.sourceRefs || []).some(ref => [...conversationIds].some(id => ref.startsWith(`${id}/`)))) add(`${recent.id}@v${recent.version}`, recent.modelView.summary.text, 'handoff', { supports: task.entryRefs });
    } catch {}
    for (const dependency of task.dependencies) add(dependency.ref, dependency.entry.content, 'memory', { supports: [dependency.ref] });
    return { ...task, evidence, scope: { modules: [...new Set(task.dependencies.map(item => item.module))], checkpoints: conversationIds.size },
      snapshot: { schema: 'codex-maid-dream-task/2', dependencies: task.dependencies.map(({ entry, ...dependency }) => dependency), evidence: evidence.map(({ text, ...value }) => value),
        scope: { modules: [...new Set(task.dependencies.map(item => item.module))], checkpoints: conversationIds.size }, signal: task.signal } };
  }
  async restore(snapshot, { tolerant = false } = {}) {
    const evidence = [];
    for (const item of snapshot.evidence) {
      try {
      let text;
      if (item.kind === 'memory') { const dependency = snapshot.dependencies.find(value => value.ref === item.ref); text = this.memory.maintenanceDependency(item.ref, { descriptor: dependency.descriptor }).entry.content; }
      else if (item.kind === 'summary') { const [nodeRef, entryId] = item.ref.split('#'); text = this.tree.read(nodeRef).content.entries.find(entry => entry.id === entryId)?.text; }
      else if (item.kind === 'handoff') { const current = this.handoff.current(); if (`${current?.id}@v${current?.version}` === item.ref) text = current.modelView.summary.text; }
      else { const value = await this.history.resolveReference(item.ref, { maxBytes: 2048 }); text = value.text; }
      if (typeof text !== 'string' || hash(text) !== item.hash) throw Object.assign(new Error('CHAT_DREAM_EVIDENCE_CHANGED'), { code: 'CHAT_DREAM_EVIDENCE_CHANGED' });
      evidence.push({ ...item, text });
      } catch (error) {
        if (!tolerant) throw error;
        evidence.push({ ...item, invalid: true });
      }
    }
    return evidence;
  }
  settleSignal(id, adoption) {
    if (!id) return; const state = this.state(), signal = state.signals.find(item => item.id === id);
    if (signal) { signal.status = adoption; this._save(state); }
  }
}
module.exports = { DreamCatalog, hash };
