'use strict';

// Read local thread metadata and numeric token events only. This module never
// reads authentication, prompt previews, messages, or the global desktop state.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');

const LIST_LIMIT = 30;
const PREFIX_BYTES = 64 * 1024;
const TAIL_BYTES = 2 * 1024 * 1024;
const MAX_METADATA_LINE = 128 * 1024;
const validId = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$/.test(value);
const tokenNumber = value => Number.isSafeInteger(value) && value >= 0;
const unavailable = reason => ({ status: 'unavailable', reason });
function selectionError(reason) {
  return Object.assign(new Error('无法选择此本地聊天，请刷新列表后重试。'), { code: reason });
}

// Windows may persist an ordinary local path in its extended namespace. Only
// drive and UNC aliases have a normal equivalent; device namespaces stay intact
// and must still pass the same trusted-root checks as every other path.
function windowsPathAlias(value) {
  if (typeof value !== 'string') return value;
  if (/^\\\\\?\\[a-zA-Z]:\\/.test(value)) return value.slice(4);
  const unc = /^\\\\\?\\UNC\\([^\\]+)\\([^\\]+)(\\.*)?$/i.exec(value);
  if (unc && unc.slice(1, 3).every(part => part !== '.' && part !== '..' && !/[\u0000-\u001f<>:"/|?*]/.test(part))) {
    return `\\\\${unc[1]}\\${unc[2]}${unc[3] || ''}`;
  }
  return value;
}

const canonicalPath = value => path.resolve(windowsPathAlias(value));

function inside(root, file) {
  const relative = path.relative(canonicalPath(root), canonicalPath(file));
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function workspaceLabel(cwd) {
  const flavor = /^[a-zA-Z]:[\\/]|^\\\\/.test(cwd) ? path.win32 : path;
  return flavor.basename(cwd.replace(/[\\/]+$/, '')) || flavor.parse(cwd).root || '工作区';
}

function plainTitle(value) {
  return typeof value === 'string' && value.trim()
    ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 160) : '未命名聊天';
}

// Locate one JSON object's field without deserializing other values. In
// particular, response_item/message lines are never passed to JSON.parse.
function stringEnd(text, start) {
  for (let index = start + 1; index < text.length; index++) {
    if (text[index] === '\\') index++;
    else if (text[index] === '"') return index + 1;
  }
  return -1;
}

function valueEnd(text, start) {
  if (text[start] === '"') return stringEnd(text, start);
  if (text[start] === '{' || text[start] === '[') {
    let depth = 0;
    for (let index = start; index < text.length; index++) {
      if (text[index] === '"') {
        index = stringEnd(text, index) - 1;
        if (index < 0) return -1;
      } else if (text[index] === '{' || text[index] === '[') depth++;
      else if ((text[index] === '}' || text[index] === ']') && --depth === 0) return index + 1;
    }
    return -1;
  }
  let index = start;
  while (index < text.length && !/[,}\]\s]/.test(text[index])) index++;
  return index > start ? index : -1;
}

function field(text, wanted, allowOpenObject = false) {
  let index = 0;
  while (/\s/.test(text[index] || '') && index < text.length) index++;
  if (text[index++] !== '{') return null;
  while (index < text.length) {
    while (/[\s,]/.test(text[index] || '') && index < text.length) index++;
    if (text[index] === '}') return null;
    if (text[index] !== '"') return null;
    const end = stringEnd(text, index);
    if (end < 0) return null;
    // Property names in these envelopes are short; avoid parsing arbitrary keys.
    const key = text.slice(index + 1, end - 1);
    index = end;
    while (/\s/.test(text[index] || '') && index < text.length) index++;
    if (text[index++] !== ':') return null;
    while (/\s/.test(text[index] || '') && index < text.length) index++;
    const start = index;
    // Session headers can contain large base_instructions after payload.id.
    // Its enclosing object need not be read in full to extract that ID.
    if (key === wanted && allowOpenObject && text[start] === '{') return text.slice(start);
    index = valueEnd(text, start);
    if (index < 0) return null;
    if (key === wanted) return text.slice(start, index);
  }
  return null;
}

function scalar(text) {
  if (text == null || text.length > 1024) return null;
  try { return JSON.parse(text); } catch { return null; }
}

function sessionIdentity(line) {
  if (scalar(field(line, 'type')) !== 'session_meta') return null;
  return scalar(field(field(line, 'payload', true) || '', 'id'));
}

function contextEvent(line) {
  const type = scalar(field(line, 'type'));
  if (type === 'compacted') return unavailable('context-compacted');
  if (line.length > MAX_METADATA_LINE) return null;
  if (type !== 'event_msg') return null;
  const payload = field(line, 'payload');
  const payloadType = scalar(field(payload || '', 'type'));
  if (payloadType === 'context_compacted') return unavailable('context-compacted');
  if (!payload || payloadType !== 'token_count') return null;
  const info = field(payload, 'info');
  if (!info || info === 'null') return null;
  const usedTokens = scalar(field(field(info, 'last_token_usage') || '', 'total_tokens'));
  const windowTokens = scalar(field(info, 'model_context_window'));
  // The desktop uses last.totalTokens / modelContextWindow, without the CLI's
  // baseline deduction. Never substitute cumulative usage or a model default.
  if (!tokenNumber(usedTokens) || !tokenNumber(windowTokens) || windowTokens === 0) return unavailable('context-missing');
  const used = Math.min(usedTokens, windowTokens);
  return { status: 'ready', usedTokens: used, windowTokens, percent: used / windowTokens * 100 };
}

class ConversationReader {
  constructor({ codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), selectionFile = null,
    filesystem = fs, timeoutMs = 1500, selectionTimeoutMs = 2000 } = {}) {
    this.codexHome = canonicalPath(codexHome);
    this.selectionFile = selectionFile ? canonicalPath(selectionFile) : null;
    if (this.selectionFile && (this.selectionFile === this.codexHome || inside(this.codexHome, this.selectionFile))) {
      throw new Error('Conversation selection must be stored outside Codex data.');
    }
    this.selectedId = null;
    this.selectionLoaded = false;
    this.selectionLoadPromise = null;
    this.filesystem = filesystem;
    this.timeoutMs = timeoutMs;
    this.selectionTimeoutMs = selectionTimeoutMs;
    this.selectionEpoch = 0;
    this.selectionController = null;
    this.compactionCounter = null;
  }

  _deadline(operation, onTimeout, milliseconds = this.timeoutMs) {
    let timer;
    const timeout = new Promise((resolve, reject) => {
      timer = setTimeout(() => { try { resolve(onTimeout()); } catch (error) { reject(error); } }, milliseconds);
    });
    return Promise.race([operation(), timeout]).finally(() => clearTimeout(timer));
  }

  async _selected() {
    if (this.selectionLoaded) return this.selectedId;
    if (!this.selectionLoadPromise) {
      this.selectionLoadPromise = (async () => {
        if (this.selectionFile) {
          try {
            const stat = await this.filesystem.stat(this.selectionFile);
            if (stat.size <= 4096) {
              const saved = JSON.parse(await this.filesystem.readFile(this.selectionFile, 'utf8'));
              if (saved.version === 1 && validId(saved.selectedId)) this.selectedId = saved.selectedId;
            }
          } catch { /* Missing or damaged widget preferences do not select a thread. */ }
        }
        this.selectionLoaded = true;
      })();
    }
    await this.selectionLoadPromise;
    return this.selectedId;
  }

  async _database() {
    let DatabaseSync;
    try { ({ DatabaseSync } = require('node:sqlite')); } catch { return unavailable('sqlite-unavailable'); }
    let entries, home;
    try {
      home = canonicalPath(await this.filesystem.realpath(this.codexHome));
      entries = (await this.filesystem.readdir(home, { withFileTypes: true }))
        .filter(entry => entry.isFile() && /^state_\d+\.sqlite$/.test(entry.name))
        .map(entry => entry.name).sort((left, right) => Number(right.match(/\d+/)[0]) - Number(left.match(/\d+/)[0]));
    } catch { return unavailable('no-local-data'); }
    // A newer schema is authoritative. Falling back to an older database after
    // a lock/corruption/schema failure could silently show an obsolete thread.
    for (const entry of entries.slice(0, 1)) {
      let db;
      try {
        const filename = canonicalPath(await this.filesystem.realpath(path.join(home, entry)));
        if (!inside(home, filename)) continue;
        db = new DatabaseSync(filename, { readOnly: true, timeout: 150 });
        const columns = new Set(db.prepare('PRAGMA table_info(threads)').all().map(column => column.name));
        if (!['id', 'cwd', 'rollout_path'].every(column => columns.has(column))) { db.close(); return unavailable('local-schema-unsupported'); }
        return { db, columns };
      } catch { try { db?.close(); } catch {} }
    }
    return unavailable('no-local-data');
  }

  _query({ db, columns }, id = null) {
    // Every returned column is explicit. Never select first_user_message,
    // preview, creator identity, model provider credentials, or whole rows.
    const selected = ['id', 'cwd', 'rollout_path'];
    for (const column of ['title', 'name']) {
      if (columns.has(column)) selected.push(column);
    }
    const conditions = [];
    if (columns.has('archived')) conditions.push('COALESCE(archived, 0) = 0');
    if (columns.has('source')) conditions.push("LOWER(COALESCE(source, '')) IN ('', 'cli', 'vscode', 'exec', 'appserver', 'desktop', 'local', '\"cli\"', '\"vscode\"', '\"exec\"', '\"appserver\"')");
    for (const column of ['source', 'thread_source']) {
      if (columns.has(column)) conditions.push(`LOWER(COALESCE(${column}, '')) NOT LIKE '%subagent%'`);
    }
    if (columns.has('agent_role')) conditions.push("COALESCE(agent_role, '') = ''");
    if (id !== null) conditions.push('id = ?');
    const order = columns.has('updated_at_ms') ? (columns.has('updated_at') ? 'COALESCE(updated_at_ms, updated_at * 1000, 0)' : 'COALESCE(updated_at_ms, 0)')
      : columns.has('updated_at') ? 'COALESCE(updated_at, 0)' : 'id';
    const sql = `SELECT ${selected.join(', ')} FROM threads${conditions.length ? ` WHERE ${conditions.join(' AND ')}` : ''} ORDER BY ${order} DESC, id DESC LIMIT ${id === null ? 120 : 1}`;
    return id === null ? db.prepare(sql).all() : db.prepare(sql).all(id);
  }

  async _rollout(row) {
    if (!validId(row?.id) || typeof row.cwd !== 'string' || row.cwd.includes('\0') ||
      typeof row.rollout_path !== 'string' || row.rollout_path.includes('\0')) return null;
    const cwd = windowsPathAlias(row.cwd), rollout = windowsPathAlias(row.rollout_path);
    if (!path.isAbsolute(cwd) || !path.isAbsolute(rollout)) return null;
    const filename = canonicalPath(rollout);
    if (!filename.endsWith('.jsonl')) return null;
    const roots = [path.join(this.codexHome, 'sessions'), path.join(this.codexHome, 'archived_sessions')];
    const lexicalRoot = roots.find(root => inside(root, filename));
    if (!lexicalRoot) return null;
    try {
      const [home, root, actual, stat] = await Promise.all([
        this.filesystem.realpath(this.codexHome), this.filesystem.realpath(lexicalRoot), this.filesystem.realpath(filename), this.filesystem.stat(filename),
      ]);
      if (!inside(home, root) || !inside(root, actual) || !stat.isFile()) return null;
      return { status: 'ready', threadId: row.id, cwd, rolloutPath: canonicalPath(actual) };
    } catch { return null; }
  }

  async _lookup(id) {
    if (!validId(id)) return unavailable('selection-missing');
    const source = await this._database();
    if (!source.db) return source;
    try {
      const row = this._query(source, id)[0];
      const selection = await this._rollout(row);
      return selection ? { ...selection, title: plainTitle(row.name || row.title) } : unavailable('selection-expired');
    } catch { return unavailable('local-data-busy'); }
    finally { source.db.close(); }
  }

  list() {
    return this._deadline(() => this._list(), () => ({ ...unavailable('local-data-timeout'), threads: [], selectedId: null }));
  }

  async _list() {
    const selectedId = await this._selected();
    const source = await this._database();
    if (!source.db) return { ...source, threads: [], selectedId: null };
    try {
      const threads = [];
      for (const row of this._query(source)) {
        if (await this._rollout(row)) threads.push({ id: row.id, title: plainTitle(row.name || row.title), workspaceLabel: workspaceLabel(row.cwd) });
        if (threads.length >= LIST_LIMIT) break;
      }
      let current = threads.some(thread => thread.id === selectedId) ? selectedId : null;
      if (selectedId && !current) {
        const row = this._query(source, selectedId)[0];
        if (await this._rollout(row)) {
          threads.unshift({ id: row.id, title: plainTitle(row.name || row.title), workspaceLabel: workspaceLabel(row.cwd) });
          threads.length = Math.min(threads.length, LIST_LIMIT);
          current = selectedId;
        }
      }
      return { status: 'ready', threads, selectedId: current };
    } catch { return { ...unavailable('local-data-busy'), threads: [], selectedId: null }; }
    finally { source.db.close(); }
  }

  select(id) {
    const epoch = ++this.selectionEpoch;
    this.selectionController?.abort();
    const controller = new AbortController();
    this.selectionController = controller;
    const assertCurrent = () => {
      if (controller.signal.aborted || epoch !== this.selectionEpoch) throw selectionError('selection-superseded');
    };
    return this._deadline(() => this._select(id, assertCurrent, controller.signal), () => {
      if (epoch === this.selectionEpoch) this.selectionEpoch++;
      controller.abort();
      throw selectionError('selection-timeout');
    }, this.selectionTimeoutMs).finally(() => {
      if (this.selectionController === controller) this.selectionController = null;
    });
  }

  async _select(id, assertCurrent, signal) {
    assertCurrent();
    if (!validId(id)) throw selectionError('selection-missing');
    const listed = await this._list();
    assertCurrent();
    if (!listed.threads.some(thread => thread.id === id)) throw selectionError('selection-expired');
    const checked = await this._lookup(id);
    assertCurrent();
    if (checked.status !== 'ready') throw selectionError(checked.reason);
    if (this.selectionFile) {
      const temporary = `${this.selectionFile}.${process.pid}.${randomUUID()}.tmp`;
      try {
        assertCurrent();
        await this.filesystem.mkdir(path.dirname(this.selectionFile), { recursive: true });
        assertCurrent();
        await this.filesystem.writeFile(temporary, JSON.stringify({ version: 1, selectedId: id }), { flag: 'wx', mode: 0o600, signal });
        assertCurrent();
        await this.filesystem.rename(temporary, this.selectionFile);
        assertCurrent();
      } catch (error) {
        await this.filesystem.rm(temporary, { force: true }).catch(() => {});
        assertCurrent();
        throw selectionError(error?.code === 'selection-superseded' ? error.code : 'selection-save-failed');
      }
    }
    assertCurrent();
    this.selectedId = id;
    this.selectionLoaded = true;
    return { status: 'ready', selectedId: id };
  }

  resolve() {
    return this._deadline(() => this._resolve(), () => unavailable('local-data-timeout'));
  }

  // Resolve an observed desktop ID without loading or changing the user's
  // remembered manual choice. Reuse the same metadata/path checks and budget.
  resolveId(id) {
    return this._deadline(() => this._lookup(id), () => unavailable('local-data-timeout'));
  }

  async _resolve() {
    const selection = await this._lookup(await this._selected());
    if (selection.status !== 'ready') return selection;
    const { title, ...safeSelection } = selection;
    return safeSelection;
  }

  readContext(selection) {
    return this._deadline(() => this._readContext(selection), () => unavailable('context-timeout'));
  }

  readCompactions(selection) {
    let active = true;
    return this._deadline(async () => {
      if (selection?.status !== 'ready' || !validId(selection.threadId)) return unavailable('selection-missing');
      const checked = await this._lookup(selection.threadId);
      if (!active) return unavailable('compaction-timeout');
      if (checked.status !== 'ready') return checked;
      if (checked.rolloutPath !== selection.rolloutPath || checked.cwd !== selection.cwd) return unavailable('selection-changed');
      if (!this.compactionCounter) {
        const { CompactionCounter } = require('./compaction-counter.cjs');
        this.compactionCounter = new CompactionCounter({ filesystem: this.filesystem, sessionIdentity,
          recordType: prefix => scalar(field(prefix, 'type')) });
      }
      return this.compactionCounter.read(checked);
    }, () => { active = false; return unavailable('compaction-timeout'); }).finally(() => { active = false; });
  }

  async _readContext(selection) {
    if (selection?.status !== 'ready' || !validId(selection.threadId)) return unavailable('selection-missing');
    const checked = await this._lookup(selection.threadId);
    if (checked.status !== 'ready') return checked;
    if (checked.rolloutPath !== selection.rolloutPath || checked.cwd !== selection.cwd) return unavailable('selection-changed');
    let handle;
    try {
      handle = await this.filesystem.open(checked.rolloutPath, 'r');
      const stat = await handle.stat();
      if (!stat.isFile()) return unavailable('rollout-missing');
      const prefix = Buffer.alloc(Math.min(stat.size, PREFIX_BYTES));
      const first = await handle.read(prefix, 0, prefix.length, 0);
      let identity = null;
      for (const line of prefix.subarray(0, first.bytesRead).toString('utf8').split('\n')) {
        identity = sessionIdentity(line);
        if (identity != null) break;
      }
      if (identity !== checked.threadId) return unavailable('session-mismatch');
      const offset = Math.max(0, stat.size - TAIL_BYTES);
      const tail = Buffer.alloc(stat.size - offset);
      const read = await handle.read(tail, 0, tail.length, offset);
      const lines = tail.subarray(0, read.bytesRead).toString('utf8').split('\n');
      if (offset > 0) lines.shift();
      // Only complete records are authoritative while Codex is appending.
      if (read.bytesRead > 0 && tail[read.bytesRead - 1] !== 10) lines.pop();
      for (let index = lines.length - 1; index >= 0; index--) {
        const usage = contextEvent(lines[index]);
        if (usage) return usage;
      }
      return unavailable('context-missing');
    } catch { return unavailable('rollout-unavailable'); }
    finally { await handle?.close().catch(() => {}); }
  }
}

module.exports = { ConversationReader };
