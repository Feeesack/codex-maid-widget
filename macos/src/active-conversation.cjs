'use strict';

// Passive observation only: no IPC connection, watcher, timer loop, Codex
// configuration, authentication, or conversation-content parser.
const fs = require('node:fs/promises');
const path = require('node:path');

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const ID = new RegExp(`^${UUID}$`, 'i');
const LOG_FILE = new RegExp(`^codex-desktop-(${UUID})-([1-9][0-9]*)-t0-i([1-9][0-9]*)-([0-2][0-9][0-5][0-9][0-5][0-9])-([0-9]+)\\.log$`, 'i');
const RECORD = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z)\s+(?:info|debug|trace|warning|error)\s+(?:\[[^\]\r\n]{1,100}\]\s+){0,3}(thread_stream_view_activity_changed|IAB_LIFECYCLE received browser sidebar owner sync|browser_sidebar_owner_sync|owner_sync(?:_received|_changed)?)\b(.*)$/;
const ROUTE = new RegExp(`^/(?:local|thread|threads)/(${UUID})(?:[/?#][^\\s]{0,256})?$`, 'i');
const MAX_LINE_BYTES = 8192;
const MAX_CARRY_BYTES = 8192;
const MAX_LOG_CANDIDATES = 128;
const unknown = reason => ({ status: 'unavailable', reason });
const numericId = value => typeof value === 'string' && /^[1-9][0-9]{0,9}$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : null;

function inside(root, file) {
  const relative = path.relative(root, file);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function sameProcess(left, right) {
  return left?.pid === right?.pid && (left?.path || '') === (right?.path || '') &&
    (left?.startedAtMs ?? left?.startTimeMs ?? null) === (right?.startedAtMs ?? right?.startTimeMs ?? null);
}

function physicalFileKey(stat) {
  // MSIX exposes the same NTFS file through two different absolute paths. A
  // missing/zero/rounded inode or device is not evidence of a physical alias.
  const part = value => typeof value === 'bigint' ? value > 0n ? String(value) : null
    : Number.isSafeInteger(value) && value > 0 ? String(value) : null;
  const device = part(stat.dev), inode = part(stat.ino);
  const birth = typeof stat.birthtimeNs === 'bigint' && stat.birthtimeNs > 0n ? String(stat.birthtimeNs)
    : typeof stat.birthtimeMs === 'bigint' ? stat.birthtimeMs > 0n ? String(stat.birthtimeMs) : null
      : Number.isFinite(stat.birthtimeMs) && stat.birthtimeMs > 0 ? String(stat.birthtimeMs) : null;
  return device && inode && birth ? `${device}:${inode}:${birth}` : null;
}

function field(text, name) {
  // Only named primitive metadata is extracted. The remaining record is never
  // deserialized, copied into state, logged, or returned to a renderer.
  const match = new RegExp(`(?:^|\\s)${name}=(?:"([^"\\\\]{0,512})"|([^\\s]{1,512}))(?=\\s|$)`).exec(text);
  return match ? match[1] ?? match[2] : null;
}

function boolean(text, name) {
  const value = field(text, name);
  return value === 'true' ? true : value === 'false' ? false : null;
}

function metadata(line) {
  if (Buffer.byteLength(line) > MAX_LINE_BYTES) return null;
  const match = RECORD.exec(line);
  if (!match) return null;
  const at = Date.parse(match[1]);
  if (!Number.isFinite(at)) return null;
  const values = match[3];
  const activity = match[2] === 'thread_stream_view_activity_changed';
  const windowId = numericId(field(values, activity ? 'rendererWindowId' : 'windowId'));
  const webContentsId = numericId(field(values, activity ? 'rendererWebContentsId' : 'originWebContentsId'));
  if (windowId === null || webContentsId === null) return null;
  const conversationId = field(values, 'conversationId');
  if (activity) {
    const active = boolean(values, 'active');
    const visible = boolean(values, 'rendererWindowVisible');
    const focused = boolean(values, 'rendererWindowFocused');
    const appearance = field(values, 'rendererWindowAppearance');
    if (!ID.test(conversationId || '') || active === null || visible === null || focused === null || !appearance) return null;
    return { type: 'activity', at, windowId, webContentsId, threadId: conversationId.toLowerCase(), active, visible, focused,
      primary: appearance === 'primary' };
  }
  const route = field(values, 'ownerRoutePath');
  const thread = route && ROUTE.exec(route);
  return { type: 'route', at, windowId, webContentsId, threadId: thread ? thread[1].toLowerCase() : null,
    ownerId: ID.test(conversationId || '') ? conversationId.toLowerCase() : null,
    routeClass: thread ? 'thread' : route === '/' ? 'home' : 'other' };
}

function failure(reason) { return Object.assign(new Error('Local window metadata unavailable.'), { reason }); }

class ActiveConversationDetector {
  constructor({ logRoots = [], getProcesses = async () => ({ known: false, roots: [] }), filesystem = fs, now = Date.now,
    platform = process.platform, uid = process.getuid?.(), timeoutMs = 1500, dateDirectories = 3,
    maxFiles = 5, maxFileBytes = 2 * 1024 * 1024, maxTotalBytes = 4 * 1024 * 1024, futureSkewMs = 5000 } = {}) {
    this.logRoots = [...new Set(logRoots.filter(root => typeof root === 'string' && path.isAbsolute(root) && !root.includes('\0')).map(root => path.resolve(root)))];
    this.getProcesses = getProcesses;
    this.filesystem = filesystem;
    this.now = now;
    this.platform = platform;
    this.uid = uid;
    this.timeoutMs = timeoutMs;
    this.dateDirectories = Math.max(1, Math.min(3, dateDirectories));
    this.maxFiles = Math.max(1, Math.min(5, maxFiles));
    this.maxFileBytes = Math.min(2 * 1024 * 1024, maxFileBytes);
    this.maxTotalBytes = Math.min(4 * 1024 * 1024, maxTotalBytes);
    this.futureSkewMs = futureSkewMs;
    this.cache = null;
    this.pending = null;
    this.epoch = 0;
    this.lastNow = null;
    this.lastIdentity = null;
    this.stateVersion = 0;
  }

  _identity(value) {
    if (value !== this.lastIdentity) { this.lastIdentity = value; this.stateVersion++; }
    return `${value}:${this.stateVersion}`;
  }

  resolve() {
    if (this.pending) return this.pending;
    const epoch = ++this.epoch;
    let timer;
    const current = () => { if (epoch !== this.epoch) throw failure('cancelled'); };
    const timeout = new Promise(resolve => {
      timer = setTimeout(() => {
        if (epoch === this.epoch) { this.epoch++; this.cache = null; this._identity('unavailable:timeout'); }
        resolve(unknown('timeout'));
      }, this.timeoutMs);
    });
    const pending = Promise.race([this._resolve(current).catch(error => {
      if (epoch === this.epoch) { this.cache = null; this._identity(`unavailable:${error?.reason || 'logs-unavailable'}`); }
      return unknown(error?.reason || 'logs-unavailable');
    }), timeout]).finally(() => {
      clearTimeout(timer);
      if (this.pending === pending) this.pending = null;
    });
    this.pending = pending;
    return pending;
  }

  async _process(current) {
    const snapshot = await this.getProcesses();
    current();
    if (snapshot?.known !== true || !Array.isArray(snapshot.roots)) throw failure('process-unknown');
    if (snapshot.roots.length === 0) throw failure('desktop-missing');
    if (snapshot.roots.length !== 1) throw failure('multiple-desktops');
    const root = snapshot.roots[0];
    if (!Number.isSafeInteger(root?.pid) || root.pid <= 0) throw failure('process-unknown');
    return root;
  }

  _permissions(stat) {
    if (this.platform !== 'darwin') return true;
    return Number.isSafeInteger(this.uid) && stat.uid === this.uid && Number.isInteger(stat.mode) && (stat.mode & 0o022) === 0;
  }

  async _directory(directory, realRoot, current) {
    const stat = await this.filesystem.lstat(directory);
    current();
    if (!stat.isDirectory() || stat.isSymbolicLink() || !this._permissions(stat)) throw failure('unsafe-log-path');
    const real = await this.filesystem.realpath(directory);
    current();
    if (realRoot && !inside(realRoot, real)) throw failure('unsafe-log-path');
    return real;
  }

  async _files(process, now, current) {
    const found = new Map();
    const physical = new Map();
    const roots = new Set();
    let unsafe = false;
    for (const root of this.logRoots) {
      let realRoot;
      try { realRoot = await this._directory(root, null, current); }
      catch (error) {
        if (error?.reason === 'cancelled') throw error;
        if (error?.reason === 'unsafe-log-path') unsafe = true;
        continue;
      }
      if (roots.has(realRoot)) continue;
      roots.add(realRoot);
      for (let day = 0; day < this.dateDirectories; day++) {
        const date = new Date(now - day * 86400000);
        const pieces = [String(date.getUTCFullYear()), String(date.getUTCMonth() + 1).padStart(2, '0'), String(date.getUTCDate()).padStart(2, '0')];
        let directory = root;
        try {
          for (const piece of pieces) { directory = path.join(directory, piece); await this._directory(directory, realRoot, current); }
          const entries = await this.filesystem.readdir(directory, { withFileTypes: true });
          current();
          for (const entry of entries) {
            const match = LOG_FILE.exec(entry.name);
            if (!match || Number(match[2]) !== process.pid || Number(match[4].slice(0, 2)) > 23) continue;
            const filename = path.join(directory, entry.name);
            const stat = await this.filesystem.lstat(filename);
            current();
            if (!stat.isFile() || stat.isSymbolicLink() || !this._permissions(stat)) throw failure('unsafe-log-path');
            const real = await this.filesystem.realpath(filename);
            current();
            if (!inside(realRoot, real)) throw failure('unsafe-log-path');
            const logical = `${pieces.join('-')}:${match[1].toLowerCase()}:${match[3]}:${match[4]}:${match[5]}`;
            let physicalKey = physicalFileKey(stat);
            if (!physicalKey && Number.isInteger(stat.dev) && stat.dev > 0 && Number.isInteger(stat.ino) && stat.ino > 0) {
              // Some NTFS file IDs exceed Number's precision. Request exact
              // metadata instead of merging rounded values or reading bytes.
              const precise = await this.filesystem.lstat(filename, { bigint: true });
              current();
              if (!precise.isFile() || precise.isSymbolicLink() || Number(precise.size) !== stat.size) throw failure('log-changed');
              physicalKey = physicalFileKey(precise);
            }
            // Both the file identity and exact logical log segment must agree.
            // A hardlink under a different session/segment remains ambiguous.
            if (physicalKey && physical.get(physicalKey) === logical) continue;
            if (physicalKey) physical.set(physicalKey, logical);
            found.set(real, { filename: real, session: match[1].toLowerCase(), instance: Number(match[3]), segment: Number(match[5]),
              stat, key: `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`, date: pieces.join('-') });
            if (found.size > MAX_LOG_CANDIDATES) throw failure('log-limit');
          }
        } catch (error) {
          if (error?.reason) throw error;
          if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw failure('logs-unavailable');
        }
      }
    }
    if (found.size === 0) throw failure(unsafe ? 'unsafe-log-path' : 'logs-missing');
    const files = [...found.values()];
    if (new Set(files.map(file => file.session)).size !== 1) throw failure('ambiguous-session');
    if (new Set(files.map(file => file.instance)).size !== 1) throw failure('ambiguous-instance');
    // Rotation may create arbitrarily many old segments in a long-running
    // desktop. Bound the log input, never choose a conversation by recency.
    return files.sort((left, right) => left.date.localeCompare(right.date) || left.segment - right.segment).slice(-this.maxFiles);
  }

  async _read(file, previous, current, maxBytes = this.maxFileBytes) {
    const start = previous ? previous.offset : Math.max(0, file.stat.size - maxBytes);
    const length = file.stat.size - start;
    if (length < 0 || length > maxBytes) throw failure('log-limit');
    if (length === 0) return { events: [], state: { key: file.key, offset: file.stat.size, size: file.stat.size,
      mtimeMs: file.stat.mtimeMs, dropping: false, lastAt: previous?.lastAt ?? null } };
    let handle;
    try {
      handle = await this.filesystem.open(file.filename, 'r');
      current();
      const before = await handle.stat();
      current();
      if (!before.isFile() || `${before.dev}:${before.ino}:${before.birthtimeMs}` !== file.key || !this._permissions(before) || before.size < file.stat.size) throw failure('log-changed');
      const buffer = Buffer.alloc(length);
      let bytes = 0;
      while (bytes < length) {
        const result = await handle.read(buffer, bytes, length - bytes, start + bytes);
        current();
        if (!result.bytesRead) throw failure('log-changed');
        bytes += result.bytesRead;
      }
      const events = [];
      let dropping = previous?.dropping || (!previous && start > 0);
      let lastAt = previous?.lastAt ?? null;
      let offset = 0;
      for (let index = 0; index < buffer.length; index++) {
        if (buffer[index] !== 10) continue;
        if (!dropping && index - offset <= MAX_LINE_BYTES) {
          const event = metadata(buffer.subarray(offset, index).toString('utf8'));
          if (event) {
            if (lastAt !== null && event.at < lastAt) throw failure('clock-regressed');
            events.push(event); lastAt = event.at;
          }
        }
        dropping = false; offset = index + 1;
      }
      // Never cache raw partial lines. A small unfinished record is retried
      // from its byte offset on a later append; a huge record is drained.
      const pendingBytes = buffer.length - offset;
      const resumeOffset = !dropping && pendingBytes <= MAX_CARRY_BYTES ? start + offset : file.stat.size;
      if (pendingBytes > MAX_CARRY_BYTES) dropping = true;
      const after = await handle.stat();
      current();
      if (`${after.dev}:${after.ino}:${after.birthtimeMs}` !== file.key || after.size < file.stat.size) throw failure('log-changed');
      return { events, state: { key: file.key, offset: resumeOffset, size: file.stat.size, mtimeMs: file.stat.mtimeMs, dropping, lastAt } };
    } finally { await handle?.close().catch(() => {}); }
  }

  _apply(windows, event) {
    let window = windows.get(event.windowId);
    if (!window) { window = { classification: null, route: null, activity: null }; windows.set(event.windowId, window); }
    if (event.type === 'activity') {
      if (!window.classification || event.at >= window.classification.at) window.classification = event;
      if (!window.activity || event.at >= window.activity.at) window.activity = event;
      if (window.route && event.webContentsId === window.route.webContentsId && event.at >= window.route.at) {
        const matches = event.threadId === window.route.threadId || event.threadId === window.route.ownerId;
        if ((!event.active && matches) || (event.active && !matches)) window.route = null;
      }
    } else if (!window.route || event.at >= window.route.at) {
      window.route = event;
    }
  }

  async _resolve(current) {
    const now = this.now();
    if (!Number.isFinite(now)) throw failure('clock-regressed');
    if (this.lastNow !== null && now < this.lastNow) { this.lastNow = now; throw failure('clock-regressed'); }
    this.lastNow = now;
    const process = await this._process(current);
    const files = await this._files(process, now, current);
    current();
    const old = this.cache;
    const unchangedIdentity = old && sameProcess(old.process, process) && old.session === files[0].session;
    const rebuild = !unchangedIdentity || files.some(file => {
      const previous = old.files.get(file.filename);
      return previous && (previous.key !== file.key || file.stat.size < previous.size ||
        file.stat.size === previous.size && previous.mtimeMs !== file.stat.mtimeMs);
    }) || unchangedIdentity && [...old.files.keys()].some(filename => !files.some(file => file.filename === filename));
    const previousFiles = rebuild ? new Map() : old.files;
    const windows = rebuild ? new Map() : new Map([...old.windows].map(([id, value]) => [id, { ...value }]));
    let remaining = this.maxTotalBytes;
    const budgets = new Map();
    // Newest segments receive the fixed byte budget first. Replay only parsed
    // window/route metadata in timestamp order; insufficient evidence is still
    // unavailable. No latest-thread, rollout or conversation-content fallback.
    for (const file of [...files].reverse()) {
      const previous = previousFiles.get(file.filename);
      const bytes = previous ? (file.stat.size === previous.size ? 0 : file.stat.size - previous.offset)
        : Math.min(file.stat.size, this.maxFileBytes, remaining);
      if (bytes < 0 || bytes > this.maxFileBytes || bytes > remaining) throw failure('log-limit');
      budgets.set(file.filename, bytes); remaining -= bytes;
    }
    const nextFiles = new Map();
    const events = [];
    for (const file of files) {
      const previous = previousFiles.get(file.filename);
      if (previous && previous.size === file.stat.size) { nextFiles.set(file.filename, previous); continue; }
      const read = await this._read(file, previous, current, budgets.get(file.filename));
      current();
      events.push(...read.events); nextFiles.set(file.filename, read.state);
    }
    events.sort((left, right) => left.at - right.at);
    if (events.some(event => event.at > now + this.futureSkewMs)) throw failure('clock-regressed');
    if (!rebuild && events.some(event => event.at < old.latestAt)) throw failure('clock-regressed');
    for (const event of events) {
      this._apply(windows, event);
      if (windows.size > 32) throw failure('window-limit');
    }
    const check = await this._process(current);
    current();
    if (!sameProcess(process, check)) throw failure('process-changed');
    const candidates = [...windows.entries()].filter(([, window]) => {
      const { classification, route, activity } = window;
      if (!classification?.primary || !classification.visible || !route?.threadId || classification.webContentsId !== route.webContentsId) return false;
      if (activity && activity.webContentsId === route.webContentsId && activity.at >= route.at && !activity.active &&
        (activity.threadId === route.threadId || activity.threadId === route.ownerId)) return false;
      return true;
    });
    this.cache = { process, session: files[0].session, files: nextFiles, windows,
      latestAt: events.length ? events[events.length - 1].at : rebuild ? 0 : old.latestAt };
    // A second visible primary window can be showing Home or an unclassified
    // route. Its lack of a chat candidate does not prove the chat window is the
    // one the user is viewing; refuse every such multi-window ambiguity.
    const primaryWindows = [...windows.values()].filter(window => window.classification?.primary && window.classification.visible);
    if (primaryWindows.length > 1) {
      this._identity('unavailable:multiple-windows');
      return unknown('multiple-windows');
    }
    if (candidates.length !== 1) {
      const reason = candidates.length > 1 ? 'multiple-windows' : 'window-unconfirmed';
      this._identity(`unavailable:${reason}`);
      return unknown(reason);
    }
    const [windowId, window] = candidates[0];
    return { status: 'ready', threadId: window.route.threadId, source: 'app-window-log', windowId,
      versionKey: this._identity(`${process.pid}:${files[0].session}:${windowId}:${window.route.webContentsId}:${window.route.threadId}`) };
  }
}

module.exports = { ActiveConversationDetector };
