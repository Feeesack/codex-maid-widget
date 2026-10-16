'use strict';

// This module never opens auth.json, sends prompts, or exposes account identifiers.
// Its app-server transport is deliberately restricted to these read-only methods.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');
const { createHash } = require('node:crypto');

const READ_METHODS = new Set(['initialize', 'account/read', 'account/rateLimits/read']);
const MAX_LINE = 4 * 1024 * 1024;
// First use streams complete rollouts; subsequent reads only process appended bytes.
// An explicit maxTailBytes may opt into approximate counts on constrained devices.
const DEFAULT_TAIL_BYTES = Number.POSITIVE_INFINITY;
const dateFormatters = new Map();
const numberOrNull = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const tokenNumber = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const textOrNull = value => typeof value === 'string' && value.length <= 160 ? value : null;

function normalizeWindow(value) {
  if (!value || typeof value !== 'object') return null;
  const used = numberOrNull(value.usedPercent);
  return {
    usedPercent: used,
    remainingPercent: used === null ? null : Math.max(0, Math.min(100, 100 - used)),
    windowDurationMins: numberOrNull(value.windowDurationMins),
    // The protocol uses Unix seconds; conversion to a countdown belongs to the UI.
    resetsAt: numberOrNull(value.resetsAt),
  };
}

function normalizeCredits(value) {
  if (!value || typeof value !== 'object') return null;
  return {
    hasCredits: typeof value.hasCredits === 'boolean' ? value.hasCredits : null,
    unlimited: typeof value.unlimited === 'boolean' ? value.unlimited : null,
    // This is a service credit balance, never a currency amount.
    balance: typeof value.balance === 'string' ? value.balance : null,
  };
}

function normalizeRateLimits(result) {
  if (!result || typeof result !== 'object') return [];
  const multi = result.rateLimitsByLimitId;
  // An explicitly present empty map is authoritative, and must not revive stale legacy data.
  const entries = multi && typeof multi === 'object' && !Array.isArray(multi)
    ? Object.entries(multi)
    : result.rateLimits ? [[result.rateLimits.limitId || 'codex', result.rateLimits]] : [];
  return entries.filter(([, value]) => value && typeof value === 'object').map(([key, value]) => ({
    id: textOrNull(value.limitId) || textOrNull(key) || 'codex',
    name: textOrNull(value.limitName) || textOrNull(value.limitId) || textOrNull(key) || 'Codex',
    primary: normalizeWindow(value.primary),
    secondary: normalizeWindow(value.secondary),
    credits: normalizeCredits(value.credits),
  }));
}

function normalizeAccount(result) {
  const account = result?.account;
  if (!account || typeof account !== 'object') return null;
  return { planType: textOrNull(account.planType), authMode: textOrNull(account.type) };
}

function dateKey(value, timeZone) {
  const date = value instanceof Date ? value : new Date(value);
  const key = timeZone || '';
  let formatter = dateFormatters.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      year: 'numeric', month: '2-digit', day: '2-digit', ...(timeZone ? { timeZone } : {}),
    });
    dateFormatters.set(key, formatter);
  }
  return formatter.format(date);
}

function normalizeAccountUsage(result, date) {
  const tokens = accountUsageRange(result, date, date);
  // Missing a day in the response is unknown, not proof of zero use.
  return tokens === null ? null : { tokens, turns: null, source: 'account', date, complete: true };
}

function calendarDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value ? parsed : null;
}

function weekRange(now, timeZone) {
  const endDate = dateKey(now, timeZone);
  const monday = calendarDate(endDate);
  monday.setUTCDate(monday.getUTCDate() - (monday.getUTCDay() + 6) % 7);
  return { startDate: monday.toISOString().slice(0, 10), endDate };
}

function safeSum(left, right) {
  return tokenNumber(left) !== null && tokenNumber(right) !== null && Number.isSafeInteger(left + right) ? left + right : null;
}

function accountUsageRange(result, startDate, endDate) {
  if (!Array.isArray(result?.dailyUsageBuckets)) return null;
  const start = calendarDate(startDate);
  const end = calendarDate(endDate);
  if (!start || !end || start > end) return null;
  const days = new Map();
  for (const row of result.dailyUsageBuckets) {
    // Malformed dates cannot be assigned to this week with confidence.
    if (!calendarDate(row?.startDate)) return null;
    if (row.startDate < startDate || row.startDate > endDate) continue;
    const count = tokenNumber(row.tokens);
    if (count === null || (days.has(row.startDate) && days.get(row.startDate) !== count)) return null;
    // Identical duplicate buckets represent the same day, never additional usage.
    days.set(row.startDate, count);
  }
  let total = 0;
  for (const day = new Date(start); day <= end; day.setUTCDate(day.getUTCDate() + 1)) {
    const key = day.toISOString().slice(0, 10);
    if (!days.has(key)) return null;
    total = safeSum(total, days.get(key));
    if (total === null) return null;
  }
  return total;
}

function accountFingerprint(result) {
  const account = result?.account;
  const identity = [account?.accountId, account?.id, account?.email].find(value => typeof value === 'string' && value.trim());
  // Used only in memory to notice a switch; identifiers never enter a snapshot or disk.
  return identity ? createHash('sha256').update(`${account.type || ''}\0${identity.trim().toLowerCase()}`).digest('hex') : null;
}

function authenticationError(error) {
  return error?.code === 'NOT_SIGNED_IN' || /unauthorized|unauthenticated|not logged|not authenticated|login required|authentication required|401/i.test(error?.message || '');
}

function friendlyError(error) {
  if (error?.code === 'ENOENT' || error?.code === 'CLI_MISSING') return '未找到 Codex CLI，请先安装并登录 Codex，或用 CODEX_MAID_CODEX_PATH 指定 codex.exe。';
  if (error?.code === 'CLOSED') return '额度连接已关闭。';
  if (error?.code === 'TIMEOUT') return '读取 Codex 额度超时，请稍后刷新。';
  if (authenticationError(error)) {
    return 'Codex 尚未登录或登录已过期，请在 Codex 中重新登录。';
  }
  if (/api.key|bedrock|unsupported auth/i.test(error?.message || '')) return '当前登录方式不提供 ChatGPT 订阅额度，请使用 ChatGPT 账号登录 Codex。';
  return '暂时无法读取 Codex 额度，请确认 Codex CLI 可用并稍后刷新。';
}

function findCodexExecutable(explicitPath) {
  if (explicitPath) {
    if (/[\r\n\0]/.test(explicitPath)) throw Object.assign(new Error('Invalid executable path'), { code: 'CLI_MISSING' });
    return explicitPath;
  }
  const names = process.platform === 'win32' ? ['codex.exe', 'codex.cmd', 'codex.bat'] : ['codex'];
  for (const directory of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    for (const name of names) {
      const candidate = path.join(directory.replace(/^"|"$/g, ''), name);
      try { if (fs.statSync(candidate).isFile()) return candidate; } catch { /* next PATH entry */ }
    }
  }
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    const desktopCli = path.join(process.env.LOCALAPPDATA, 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe');
    try { if (fs.statSync(desktopCli).isFile()) return desktopCli; } catch { /* absent */ }
  }
  throw Object.assign(new Error('Codex CLI not found'), { code: 'CLI_MISSING' });
}

function spawnCodex(executable, args, options) {
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(executable)) {
    // npm's Windows shim cannot be spawned directly. Refuse shell metacharacters in its path.
    if (/["&|<>^%!\r\n]/.test(executable)) throw Object.assign(new Error('Unsupported shim path'), { code: 'CLI_MISSING' });
    const quoted = [executable, ...args].map(value => `"${value}"`).join(' ');
    return spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${quoted}"`], options);
  }
  return spawn(executable, args, options);
}

class ReadOnlyAppServer {
  constructor(options = {}) {
    options = { ...options, codexPath: options.codexPath || process.env.CODEX_MAID_CODEX_PATH };
    this.options = options;
    this.pending = new Map();
    this.sequence = 0;
    this.child = null;
    this.connecting = null;
    this.closed = false;
  }

  async connect() {
    if (this.closed) throw Object.assign(new Error('Closed'), { code: 'CLOSED' });
    if (this.connecting) return this.connecting;
    if (this.child) return;
    const connecting = this.start();
    this.connecting = connecting;
    try { await connecting; } finally { if (this.connecting === connecting) this.connecting = null; }
  }

  async start() {
    const executable = findCodexExecutable(this.options.codexPath);
    const env = { ...process.env };
    if (this.options.codexHome) env.CODEX_HOME = this.options.codexHome;
    const child = spawnCodex(executable, [
      'app-server', '--listen', 'stdio://',
      // Process-local analytics override; never rewrites the user's config.
      // This client only sends the account-read methods above, never thread/start.
      '-c', 'analytics.enabled=false',
    ], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env, cwd: os.tmpdir() });
    this.child = child;
    let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      if (this.child !== child) return;
      buffer += chunk;
      if (buffer.length > MAX_LINE && !buffer.includes('\n')) {
        this.disconnect(Object.assign(new Error('Protocol message too large'), { code: 'PROTOCOL' }));
        return;
      }
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.length > MAX_LINE) continue;
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.method && message.id !== undefined) {
          // No auth refresh, tool calls, elicitation, or other server request is supported.
          child.stdin.write(`${JSON.stringify({ id: message.id, error: { code: -32601, message: 'Read-only quota client' } })}\n`);
          continue;
        }
        const pending = this.pending.get(message.id);
        if (!pending) continue;
        clearTimeout(pending.timer);
        this.pending.delete(message.id);
        if (message.error) pending.reject(Object.assign(new Error(message.error.message || 'App-server error'), { code: message.error.code }));
        else pending.resolve(message.result);
      }
    });
    // Drain without retaining stderr: it may contain private filesystem paths or account data.
    child.stderr.on('data', () => {});
    child.stdin.on('error', () => {});
    child.on('error', error => { if (this.child === child) this.disconnect(error); });
    child.on('exit', () => { if (this.child === child) this.disconnect(Object.assign(new Error('App-server exited'), { code: 'EXIT' })); });
    try {
      await this.request('initialize', { clientInfo: { name: 'codex_maid_widget', title: 'Codex Maid Widget', version: '0.3.3' } });
      if (this.child !== child) throw Object.assign(new Error('Connection superseded'), { code: 'INVALIDATED' });
      child.stdin.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`);
    } catch (error) { if (this.child === child) this.disconnect(error); throw error; }
  }

  request(method, params = {}) {
    if (!READ_METHODS.has(method)) return Promise.reject(new Error('Only quota read methods are allowed'));
    const child = this.child;
    if (!child) return Promise.reject(new Error('Not connected'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const error = Object.assign(new Error('Codex quota request timed out'), { code: 'TIMEOUT' });
        this.disconnect(error);
      }, this.options.timeoutMs || 12000);
      this.pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`, error => {
        if (error && this.child === child) this.disconnect(error);
      });
    });
  }

  disconnect(error = Object.assign(new Error('Closed'), { code: 'CLOSED' })) {
    const child = this.child;
    this.child = null;
    this.connecting = null;
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(error); }
    this.pending.clear();
    if (child) { child.stdin.destroy(); child.kill(); }
  }

  close() { this.closed = true; this.disconnect(); }
}

// Incremental reader: scans file metadata, but only reads changed logs. Content is
// discarded immediately; cached records contain numeric counters, dates and opaque turn IDs.
class LocalUsageReader {
  constructor(codexHome, options = {}) {
    this.root = path.join(codexHome, 'sessions');
    this.archiveRoot = path.join(codexHome, 'archived_sessions');
    this.timeZone = options.timeZone;
    this.maxTailBytes = options.maxTailBytes || DEFAULT_TAIL_BYTES;
    this.files = new Map();
    this.inflight = null;
  }

  async listFiles(directory = this.root) {
    let entries;
    try { entries = await fsp.readdir(directory, { withFileTypes: true }); } catch { return []; }
    const groups = await Promise.all(entries.map(async entry => {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) return this.listFiles(target);
      return entry.isFile() && entry.name.endsWith('.jsonl') ? [target] : [];
    }));
    return groups.flat();
  }

  read(now = new Date()) {
    if (this.inflight) return this.inflight;
    const inflight = this.readSnapshot(now).finally(() => { if (this.inflight === inflight) this.inflight = null; });
    this.inflight = inflight;
    return inflight;
  }

  async readSnapshot(now) {
    const today = dateKey(now, this.timeZone);
    const range = weekRange(now, this.timeZone);
    const paths = (await Promise.all([this.listFiles(), this.listFiles(this.archiveRoot)])).flat();
    const existing = new Set(paths);
    for (const filename of this.files.keys()) if (!existing.has(filename)) this.files.delete(filename);
    // A bounded batch avoids hundreds of open descriptors on large installations.
    for (let start = 0; start < paths.length; start += 12) {
      await Promise.all(paths.slice(start, start + 12).map(async filename => {
        let stat;
        try { stat = await fsp.stat(filename); } catch { return; }
        let state = this.files.get(filename);
        // A Monday rollout still belongs in a Sunday weekly total. File mtime is
        // not an activity date: imported/archived logs can also retain an old mtime.
        if (state && state.offset === stat.size && state.mtimeMs === stat.mtimeMs) return;
        if (!state || stat.size < state.offset || (state.offset === stat.size && stat.mtimeMs !== state.mtimeMs)) {
          state = { offset: 0, carry: '', decoder: new StringDecoder('utf8'), previousTotal: null, days: new Map(), active: null, lastTurn: null, complete: true, sessionId: null, sawSessionMeta: false };
          if (stat.size > this.maxTailBytes) {
            state.offset = stat.size - this.maxTailBytes;
            state.skipFirst = true;
            state.complete = false;
            // The tail may omit session_meta. Read just the first bounded header to
            // recognize copied files; never use a replayed parent's session ID.
            try {
              const handle = await fsp.open(filename, 'r');
              try {
                const header = Buffer.alloc(64 * 1024);
                const { bytesRead } = await handle.read(header, 0, header.length, 0);
                const firstLine = header.subarray(0, bytesRead).toString('utf8').split('\n', 1)[0];
                const metadata = JSON.parse(firstLine);
                if (metadata.type === 'session_meta') {
                  state.sessionId = textOrNull(metadata.payload?.id);
                  state.sawSessionMeta = true;
                }
              } finally { await handle.close(); }
            } catch { /* Long or unavailable header: retain the per-file fallback. */ }
            // Later metadata in a tail can describe an inherited parent. Never use
            // it as this file's identity if the real header could not be read.
            state.sawSessionMeta = true;
          }
          this.files.set(filename, state);
        }
        try {
          await this.readFile(filename, state, stat.size);
          state.mtimeMs = stat.mtimeMs;
        } catch { state.complete = false; }
      }));
    }
    let tokens = 0;
    let turns = 0;
    let observed = false;
    let complete = true;
    let weeklyTokens = 0;
    let weeklyTurns = 0;
    let weeklyObserved = false;
    let weeklyComplete = true;
    let lastTurn = null;
    const sessions = new Map();
    for (const [filename, state] of this.files) {
      const key = state.sessionId ? `session:${state.sessionId}` : `file:${filename}`;
      const recordedTokens = [...state.days.values()].reduce((sum, day) => sum + BigInt(day.tokens ?? 0), 0n);
      const previous = sessions.get(key);
      // A copied rollout must not count twice. Prefer the version containing the
      // greatest observed usage, rather than whichever copy was touched last.
      if (!previous || recordedTokens > previous.recordedTokens) sessions.set(key, { state, recordedTokens });
    }
    for (const { state } of sessions.values()) {
      const day = state.days.get(today);
      if (day) { tokens = safeSum(tokens, day.tokens); turns = safeSum(turns, day.turns); observed = true; complete &&= state.complete; }
      for (const [key, activity] of state.days) {
        if (key < range.startDate || key > range.endDate) continue;
        weeklyTokens = safeSum(weeklyTokens, activity.tokens);
        weeklyTurns = safeSum(weeklyTurns, activity.turns);
        weeklyObserved = true;
      }
      // A bounded tail may have omitted activity in this week, so totals remain
      // explicitly partial even if other files provide some observed usage.
      weeklyComplete &&= state.complete;
      if (state.lastTurn && (!lastTurn || state.lastTurn.timestamp > lastTurn.timestamp)) lastTurn = state.lastTurn;
    }
    return {
      today: observed && tokens !== null && turns !== null ? { tokens, turns, source: 'local', scope: 'device', date: today, complete } : null,
      weekly: weeklyObserved && weeklyTokens !== null && weeklyTurns !== null ? {
        tokens: weeklyTokens, turns: weeklyTurns, source: 'local', scope: 'device', ...range, complete: weeklyComplete,
      } : null,
      lastTurn: lastTurn ? { ...lastTurn, scope: 'device' } : null,
    };
  }

  async readFile(filename, state, end) {
    if (state.offset >= end) return;
    const stream = fs.createReadStream(filename, { start: state.offset, end: end - 1, highWaterMark: 64 * 1024 });
    for await (const chunk of stream) {
      state.offset += chunk.length;
      state.carry += state.decoder.write(chunk);
      let newline;
      while ((newline = state.carry.indexOf('\n')) >= 0) {
        const line = state.carry.slice(0, newline);
        state.carry = state.carry.slice(newline + 1);
        if (state.skipFirst) { state.skipFirst = false; continue; }
        this.consumeLine(state, line);
      }
      if (state.carry.length > MAX_LINE) {
        state.carry = ''; state.skipFirst = true; state.complete = false;
        // A dropped oversized header must not let replayed metadata claim its identity.
        state.sawSessionMeta = true;
      }
    }
  }

  consumeLine(state, line) {
    if (!state.sawSessionMeta && line.includes('"session_meta"')) {
      try {
        const metadata = JSON.parse(line);
        if (metadata.type === 'session_meta') {
          state.sessionId = textOrNull(metadata.payload?.id);
          state.sawSessionMeta = true;
          return;
        }
      } catch { /* Not a complete metadata line. */ }
    }
    // Ignore messages and tool output without parsing or retaining their text.
    if (!line.includes('"token_count"') && !line.includes('"task_started"') && !line.includes('"task_complete"')) return;
    let event;
    try { event = JSON.parse(line); } catch { state.complete = false; return; }
    if (event.type !== 'event_msg' || !event.payload) return;
    const payload = event.payload;
    const timestamp = new Date(event.timestamp);
    if (!Number.isFinite(timestamp.getTime())) return;
    const dayKey = dateKey(timestamp, this.timeZone);
    let day = state.days.get(dayKey);
    if (!day) { day = { tokens: 0, turns: 0 }; state.days.set(dayKey, day); }
    if (payload.type === 'task_started') {
      state.active = { id: payload.turn_id || null, tokens: 0, timestamp: timestamp.toISOString() };
      day.turns = safeSum(day.turns, 1);
      if (day.turns === null) state.complete = false;
      return;
    }
    if (payload.type === 'task_complete') {
      if (state.active && (!payload.turn_id || !state.active.id || state.active.id === payload.turn_id)) {
        state.lastTurn = state.active.tokens === null ? null : { tokens: state.active.tokens, timestamp: timestamp.toISOString() };
        state.active = null;
      }
      return;
    }
    if (payload.type !== 'token_count') return;
    const total = tokenNumber(payload.info?.total_token_usage?.total_tokens);
    if (total === null) return;
    // token_count repeats the cumulative total on rate-limit updates. Count each delta once.
    let delta;
    if (state.previousTotal === null) {
      // Forked sessions can inherit a parent's cumulative total. Only their first
      // recorded increment belongs to this file; never count the inherited baseline.
      const last = tokenNumber(payload.info?.last_token_usage?.total_tokens);
      delta = last ?? (state.complete ? total : 0);
      if (last !== null && last < total) state.complete = false;
    }
    else delta = total >= state.previousTotal ? total - state.previousTotal : (tokenNumber(payload.info?.last_token_usage?.total_tokens) || 0);
    state.previousTotal = total;
    day.tokens = safeSum(day.tokens, delta);
    if (state.active) state.active.tokens = safeSum(state.active.tokens, delta);
    if (day.tokens === null || state.active?.tokens === null) state.complete = false;
  }
}

class CodexDataSource {
  constructor(options = {}) {
    this.options = options;
    this.now = options.now || (() => new Date());
    this.server = options.server || new ReadOnlyAppServer(options);
    this.local = options.localReader || new LocalUsageReader(options.codexHome || process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), options);
    this.inflight = null;
    this.closed = false;
    this.revision = 0;
    this.accountIdentity = null;
    this.generation = 0;
  }

  read() {
    if (this.inflight) return this.inflight;
    const revision = this.revision;
    const inflight = this.readSnapshot(revision).finally(() => { if (this.inflight === inflight) this.inflight = null; });
    this.inflight = inflight;
    return inflight;
  }

  invalidate() {
    this.revision++;
    this.generation++;
    this.accountIdentity = null;
    this.inflight = null;
    this.server.disconnect?.(Object.assign(new Error('Account state changed'), { code: 'INVALIDATED' }));
    // Device-wide usage is independent of login. Keep the incremental log cache.
    return this.generation;
  }

  async readSnapshot(revision) {
    const now = new Date(this.now());
    const base = {
      status: 'offline', updatedAt: now.toISOString(), account: null, buckets: [], today: null, weekly: null, lastTurn: null,
      generation: this.generation, accountChanged: false, clearPrevious: true,
    };
    const superseded = () => ({ ...base, account: null, buckets: [], generation: this.generation, clearPrevious: true, invalidated: true });
    if (this.closed) return { ...base, error: friendlyError({ code: 'CLOSED' }) };
    const localPromise = Promise.resolve().then(() => this.local.read(now)).catch(() => ({ today: null, weekly: null, lastTurn: null }));
    try {
      // Each app-server starts from the current local login. Reusing an authenticated
      // transport could continue reporting a previous account after a desktop switch.
      this.server.disconnect?.();
      await this.server.connect();
      if (revision !== this.revision) return superseded();
      const accountResult = await this.server.request('account/read', { refreshToken: false });
      if (revision !== this.revision) return superseded();
      base.account = normalizeAccount(accountResult);
      if (!base.account) throw Object.assign(new Error('Not signed in'), { code: 'NOT_SIGNED_IN' });
      const identity = accountFingerprint(accountResult);
      base.accountChanged = !!(this.accountIdentity && identity && this.accountIdentity !== identity);
      base.clearPrevious = !identity || !this.accountIdentity || base.accountChanged;
      if (base.accountChanged) this.generation++;
      this.accountIdentity = identity;
      base.generation = this.generation;
      const [limits] = await Promise.allSettled([this.server.request('account/rateLimits/read')]);
      const local = await localPromise;
      if (revision !== this.revision) return superseded();
      base.lastTurn = local.lastTurn || null;
      base.today = local.today || null;
      base.weekly = local.weekly || null;
      if (limits.status === 'fulfilled') {
        base.buckets = normalizeRateLimits(limits.value);
        base.status = base.buckets.length ? 'live' : 'partial';
        if (!base.buckets.length) {
          base.clearPrevious = true;
          base.error = '当前账号未返回可显示的额度窗口。';
        }
      } else {
        if (authenticationError(limits.reason)) {
          base.account = null;
          base.clearPrevious = true;
          this.accountIdentity = null;
        }
        base.status = base.today || base.weekly || base.lastTurn ? 'partial' : 'offline';
        base.error = friendlyError(limits.reason);
      }
      return base;
    } catch (error) {
      const local = await localPromise;
      if (revision !== this.revision) return superseded();
      // Without a confirmed identity, never allow the main process to revive a
      // previous account's quota as stale. Device token totals can remain visible.
      this.accountIdentity = null;
      return {
        ...base, today: local.today || null, weekly: local.weekly || null, lastTurn: local.lastTurn || null,
        account: null, clearPrevious: true,
        status: local.today || local.weekly || local.lastTurn ? 'partial' : 'offline', error: friendlyError(error),
      };
    } finally {
      // Reads in one revision share an inflight promise. Only invalidate/close
      // can supersede that read, and both advance the revision before replacing
      // its transport. A late old read must never close the newer connection.
      // Each refresh already reconnects to the current login; retaining this
      // read-only app-server between refreshes serves no purpose.
      if (revision === this.revision) this.server.disconnect?.();
    }
  }

  close() { this.closed = true; this.revision++; this.server.close(); }
}

module.exports = {
  CodexDataSource, ReadOnlyAppServer, LocalUsageReader,
  normalizeWindow, normalizeCredits, normalizeRateLimits, normalizeAccount, normalizeAccountUsage,
  friendlyError, dateKey, weekRange, findCodexExecutable,
};
