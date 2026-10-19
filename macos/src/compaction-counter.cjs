'use strict';
const fs = require('node:fs/promises');
const { createHash } = require('node:crypto');
const { createEnvelope, consumeEnvelope, finishEnvelope } = require('./compaction-envelope.cjs');
const unavailable = reason => ({ status: 'unavailable', reason });
const hash = buffer => createHash('sha256').update(buffer).digest('hex');
const fileKey = stat => `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;

// Count committed rollout envelopes, never summaries or nested message text.
// Only explicit reads do work. The rollout itself is the durable record; this
// small in-memory cache can be reconstructed after a widget restart.
class CompactionCounter {
  constructor({ filesystem = fs, sessionIdentity, recordType, now = () => performance.now(),
    maxBytes = 16 * 1024 * 1024, chunkBytes = 256 * 1024, budgetMs = 250, timeoutMs = 750, maxEntries = 8 } = {}) {
    this.fs = filesystem;
    this.sessionIdentity = sessionIdentity;
    this.recordType = recordType;
    this.now = now;
    this.maxBytes = Math.max(1, Math.min(16 * 1024 * 1024, maxBytes));
    this.chunkBytes = Math.max(1, Math.min(256 * 1024, chunkBytes));
    this.budgetMs = budgetMs;
    this.timeoutMs = timeoutMs;
    this.maxEntries = Math.max(1, Math.min(8, maxEntries));
    this.cache = new Map();
    this.pending = new Map();
  }

  read(selection) {
    if (selection?.status !== 'ready' || typeof selection.threadId !== 'string' || typeof selection.rolloutPath !== 'string') {
      return Promise.resolve(unavailable('selection-missing'));
    }
    const key = `${selection.threadId}\0${selection.rolloutPath}`;
    if (this.pending.has(key)) return this.pending.get(key);
    let active = true, timer;
    const guard = () => { if (!active) throw Error('expired'); };
    const timeout = new Promise(resolve => { timer = setTimeout(() => { active = false; resolve(unavailable('compaction-timeout')); }, this.timeoutMs); });
    const request = Promise.race([this.scan(selection, key, guard).catch(() => unavailable('compaction-unavailable')), timeout])
      .finally(() => { active = false; clearTimeout(timer); if (this.pending.get(key) === request) this.pending.delete(key); });
    this.pending.set(key, request);
    return request;
  }

  async bytes(handle, length, position, guard) {
    const buffer = Buffer.alloc(length);
    let offset = 0;
    while (offset < length) {
      const { bytesRead } = await handle.read(buffer, offset, length - offset, position + offset);
      guard();
      if (!bytesRead) throw Error('short read');
      offset += bytesRead;
    }
    return buffer;
  }

  consume(state, buffer) {
    let start = 0;
    while (start < buffer.length) {
      const newline = buffer.indexOf(10, start), end = newline < 0 ? buffer.length : newline;
      const alreadyCompacted = state.kind === 'compacted';
      if (!state.kind && !state.unsupported) {
        const room = 4096 - state.prefix.length;
        const copied = Math.min(end - start, room);
        state.prefix = Buffer.concat([state.prefix, buffer.subarray(start, start + copied)]);
        const kind = this.recordType(state.prefix.toString('utf8'));
        if (typeof kind === 'string' && kind) {
          state.kind = kind;
          if (kind === 'compacted') {
            state.envelope = createEnvelope();
            consumeEnvelope(state.envelope, state.prefix);
            consumeEnvelope(state.envelope, buffer.subarray(start + copied, end));
          }
          state.prefix = Buffer.alloc(0);
        }
        else if (state.prefix.length >= 4096) { state.unsupported = true; state.prefix = Buffer.alloc(0); }
      }
      if (alreadyCompacted) consumeEnvelope(state.envelope, buffer.subarray(start, end));
      state.partial = true;
      if (newline < 0) break;
      if (!state.kind && state.prefix.toString('utf8').trim()) state.unsupported = true;
      if (state.kind === 'compacted') {
        const metadata = finishEnvelope(state.envelope);
        if (!metadata.valid) state.unsupported = true;
        else if (!metadata.responseIdPresent) state.legacyUnknown = true;
        else if (metadata.responseIdNonempty) state.count++;
      }
      state.envelope = null;
      state.kind = null; state.prefix = Buffer.alloc(0); state.partial = false;
      start = newline + 1;
    }
  }

  async scan(selection, key, guard) {
    const begun = this.now();
    let handle;
    try {
      handle = await this.fs.open(selection.rolloutPath, 'r'); guard();
      const stat = await handle.stat(); guard();
      if (!stat.isFile() || !Number.isSafeInteger(stat.size) || stat.size < 1) return unavailable('rollout-missing');
      const header = await this.bytes(handle, Math.min(stat.size, 64 * 1024), 0, guard);
      let identity = null;
      for (const line of header.toString('utf8').split('\n')) { identity = this.sessionIdentity(line); if (identity !== null) break; }
      if (identity !== selection.threadId) return unavailable('session-mismatch');
      const cached = this.cache.get(key);
      let reusable = cached && cached.key === fileKey(stat) && stat.size >= cached.size &&
        (stat.size !== cached.size || stat.mtimeMs === cached.mtimeMs);
      if (reusable && cached.offset > 0) {
        const anchor = await this.bytes(handle, Math.min(256, cached.offset), Math.max(0, cached.offset - 256), guard);
        reusable = hash(anchor) === cached.anchor;
      }
      const state = reusable ? { ...cached, prefix: Buffer.from(cached.prefix), envelope: cached.envelope ? structuredClone(cached.envelope) : null }
        : { key: fileKey(stat), count: 0, offset: 0, kind: null, prefix: Buffer.alloc(0), partial: false, unsupported: false };
      let readBytes = 0;
      while (state.offset < stat.size && readBytes < this.maxBytes && this.now() - begun < this.budgetMs) {
        const length = Math.min(this.chunkBytes, stat.size - state.offset, this.maxBytes - readBytes);
        const buffer = await this.bytes(handle, length, state.offset, guard);
        this.consume(state, buffer);
        state.offset += length; readBytes += length;
      }
      const after = await handle.stat(); guard();
      if (fileKey(after) !== fileKey(stat) || after.size < stat.size || after.size === stat.size && after.mtimeMs !== stat.mtimeMs) {
        this.cache.delete(key); return unavailable('rollout-changed');
      }
      if (state.unsupported) { this.cache.delete(key); return unavailable('record-format-unsupported'); }
      const anchor = await this.bytes(handle, Math.min(256, state.offset), Math.max(0, state.offset - 256), guard);
      state.anchor = hash(anchor); state.size = stat.size; state.mtimeMs = stat.mtimeMs;
      guard();
      this.cache.delete(key); this.cache.set(key, state);
      while (this.cache.size > this.maxEntries) this.cache.delete(this.cache.keys().next().value);
      return { status: 'ready', count: state.count, complete: state.offset === after.size && !state.partial && !state.legacyUnknown,
        ...(state.legacyUnknown ? { incompleteReason: 'legacy-records' } : {}) };
    } finally { await handle?.close().catch(() => {}); }
  }
}

module.exports = { CompactionCounter };
