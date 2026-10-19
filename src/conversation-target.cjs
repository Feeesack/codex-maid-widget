'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { workspaceDisplay } = require('./conversation-display.cjs');

// The previous manual selection remains in its own file. A missing mode file
// opts into automatic detection without overwriting that remembered selection.
class ConversationTarget {
  constructor({ reader, detector, modeFile, filesystem = fs } = {}) {
    this.reader = reader;
    this.detector = detector;
    this.modeFile = modeFile;
    this.fs = filesystem;
    this.mode = null;
    this.selectedId = null;
    this.loading = null;
    this.writes = Promise.resolve();
    this.epoch = 0;
    this.revision = 0;
    this.signature = null;
  }

  async load() {
    if (this.mode) return this.mode;
    if (!this.loading) this.loading = (async () => {
      let mode = 'auto', handle;
      try {
        handle = await this.fs.open(this.modeFile, 'r');
        const info = await handle.stat();
        if (info.isFile() && info.size <= 4096) {
          const buffer = Buffer.alloc(info.size);
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
          const record = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
          if (record.version === 1) {
            if (record.mode === 'manual') mode = 'manual';
            if (typeof record.selectedId === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$/.test(record.selectedId)) this.selectedId = record.selectedId;
          }
        }
      } catch { /* Absent or invalid preference uses automatic selection. */ }
      finally { if (handle) await handle.close().catch(() => {}); }
      this.mode = mode;
      return mode;
    })();
    return this.loading;
  }

  async list() {
    await this.load();
    const listed = await this.reader.list();
    const selectedId = this.selectedId || listed.selectedId;
    const threads = Array.isArray(listed.threads) ? [...listed.threads] : [];
    if (selectedId && !threads.some(thread => thread.id === selectedId)) {
      const checked = await this.reader.resolveId(selectedId);
      if (checked?.status === 'ready') { threads.unshift({ id: selectedId, title: checked.title, workspaceLabel: workspaceDisplay(checked.cwd).label }); threads.length = Math.min(threads.length, 30); }
    }
    return { ...listed, threads, selectedId, selectionMode: this.mode };
  }

  select(id) {
    const task = this.writes.catch(() => {}).then(async () => {
      await this.load();
      if (id !== null && (typeof id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$/.test(id))) {
        throw new Error('无法选择此本地聊天，请刷新后重试。');
      }
      this.epoch++;
      // Validate before the single atomic commit. Keeping mode and the manual
      // ID together avoids a rejected save silently changing the target.
      if (id !== null && (await this.reader.resolveId(id))?.status !== 'ready') {
        throw new Error('无法选择此本地聊天，请刷新后重试。');
      }
      const selectionMode = id === null ? 'auto' : 'manual';
      const selectedId = id === null ? this.selectedId : id;
      const temporary = `${this.modeFile}.${randomUUID()}.tmp`;
      try {
        await this.fs.mkdir(path.dirname(this.modeFile), { recursive: true });
        await this.fs.writeFile(temporary, JSON.stringify({ version: 1, mode: selectionMode, selectedId }), { flag: 'wx', mode: 0o600 });
        await this.fs.rename(temporary, this.modeFile);
      } catch { throw new Error('无法保存对话选择，请重试。'); }
      finally { await this.fs.unlink(temporary).catch(() => {}); }
      this.mode = selectionMode;
      this.selectedId = selectedId;
      this.signature = null;
      this.epoch++;
      return { selectedId: id, selectionMode };
    });
    this.writes = task;
    return task;
  }

  stamp(result, selectionMode, versionKey = '') {
    const signature = JSON.stringify([selectionMode, result.status, result.threadId, result.cwd, result.rolloutPath, versionKey]);
    if (signature !== this.signature) { this.signature = signature; this.revision++; }
    return { ...result, selectionMode, selectionRevision: this.revision };
  }

  async resolve() {
    const selectionMode = await this.load(), epoch = this.epoch;
    let result, versionKey = '';
    try {
      if (selectionMode === 'manual') result = this.selectedId ? await this.reader.resolveId(this.selectedId) : await this.reader.resolve();
      else {
        const active = await this.detector.resolve();
        versionKey = active?.versionKey || '';
        result = active?.status === 'ready' ? await this.reader.resolveId(active.threadId) : { status: 'unavailable' };
      }
    } catch { result = { status: 'unavailable' }; }
    // An obsolete request must not disturb a newer target's revision.
    if (epoch !== this.epoch || selectionMode !== this.mode) return { status: 'unavailable', selectionMode: this.mode, selectionRevision: this.revision };
    return this.stamp(result || { status: 'unavailable' }, selectionMode, versionKey);
  }
}

module.exports = { ConversationTarget };
