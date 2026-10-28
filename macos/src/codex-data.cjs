'use strict';

// This module never opens auth.json or sends prompts. Public snapshots contain no account identifiers.
// Its app-server transport is deliberately restricted to these read-only methods.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');
const { createHash } = require('node:crypto');
const { version: APP_VERSION } = require('../package.json');
const { environmentValue, codexCommandInvocation, findCodexCandidate } = require('./codex-cli.cjs');
const { MacBundleReader } = require('./macos-bundle.cjs');
const macBundleReader = new MacBundleReader();

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
  const workspace = [account?.workspaceId, account?.organizationId, account?.workspace?.id, account?.organization?.id]
    .find(value => typeof value === 'string' && value.trim());
  const plan = textOrNull(account?.planType)?.trim().toLowerCase() || '';
  // Internal correlation only. Public snapshots never contain raw identifiers;
  // the private registry uses this digest independently of local display metadata.
  // One login may have independent personal and workspace quota. Partition by
  // plan and by a protocol-provided workspace identity whenever available.
  return identity ? createHash('sha256').update(JSON.stringify([
    account.type || '', identity.trim().toLowerCase(), plan, workspace?.trim() || '',
  ])).digest('hex') : null;
}

function accountPresentationText(value, email = false) {
  if (typeof value !== 'string' || value.length > 512) return null;
  const text = value.replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '').trim();
  if (!text || Array.from(text).length > (email ? 254 : 120)) return null;
  // An explicitly returned, syntactically valid email may legitimately contain
  // a long hexadecimal local part. Never mistake that display address for a token.
  if (email) return /^[^@\s<>]+@[^@\s<>]+\.[^@\s<>]+$/u.test(text) ? text : null;
  // Names are display text, never an alternative route for credentials or opaque
  // token strings. Check only known name/email fields; do not retain the reply.
  if (/\b(?:Bearer|Basic)\s+\S|\bsk-[A-Za-z0-9_-]{12,}|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}|\b(?:access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key)\s*[:=]|(?:^|\s)[A-Za-z0-9_-]{48,}(?:$|\s)|\b[a-f0-9]{32,}\b/i.test(text)) return null;
  return text;
}

function accountPresentation(result, key, generation, profile = {}) {
  const account = result?.account;
  const first = (values, email = false) => values.map(value => accountPresentationText(value, email)).find(Boolean) || null;
  return {
    key, generation,
    profileNickname: accountPresentationText(profile?.profileNickname),
    displayName: first([account?.displayName, account?.name]),
    email: first([account?.email], true),
    workspaceName: first([profile?.workspaceName, account?.workspaceName, account?.workspace?.name, account?.workspace?.displayName,
      account?.organizationName, account?.organization?.name, result?.workspaceRouting?.workspaceName]),
  };
}

function authenticationError(error) {
  return error?.code === 'NOT_SIGNED_IN' || /unauthorized|unauthenticated|not logged|not authenticated|login required|authentication required|401/i.test(error?.message || '');
}

function friendlyError(error) {
  if (error?.code === 'ENOENT' || error?.code === 'CLI_MISSING') return '未找到 Codex CLI，请先安装并登录 Codex，或用 CODEX_MAID_CODEX_PATH 指定 Codex CLI 可执行文件。';
  if (error?.code === 'CLOSED') return '额度连接已关闭。';
  if (error?.code === 'TIMEOUT') return '读取 Codex 额度超时，请稍后刷新。';
  if (authenticationError(error)) {
    return 'Codex 尚未登录或登录已过期，请在 Codex 中重新登录。';
  }
  if (/api.key|bedrock|unsupported auth/i.test(error?.message || '')) return '当前登录方式不提供 ChatGPT 订阅额度，请使用 ChatGPT 账号登录 Codex。';
  if (['EACCES', 'EPERM'].includes(error?.code)) return 'Codex CLI 启动被系统拒绝，请检查应用权限，或用 CODEX_MAID_CODEX_PATH 指定可运行的 CLI。';
  if (['EXIT', 'ENOEXEC', 'EINVAL', 'UNKNOWN', 'EPIPE', 'ECONNRESET', 'ERR_STREAM_DESTROYED', 'ERR_STREAM_WRITE_AFTER_END', 'PROTOCOL', -32601, -32602].includes(error?.code)) return 'Codex CLI 未能正常启动额度服务，请打开或更新 Codex 后重试。';
  return '暂时无法读取 Codex 额度，请确认 Codex CLI 可用并稍后刷新。';
}

function findCodexExecutable(explicitPath, options = {}) {
  return findCodexCandidate(explicitPath, { homedir: os.homedir(), readBundle: bundle => macBundleReader.read(bundle), ...options });
}

function spawnCodex(executable, args, options) {
  const invocation = codexCommandInvocation(executable, args, { env: options.env });
  return spawn(invocation.file, invocation.args, { ...options, ...(invocation.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}) });
}

class ReadOnlyAppServer {
  constructor(options = {}) {
    options = { ...options, codexPath: options.codexPath || environmentValue(options.env || process.env, 'CODEX_MAID_CODEX_PATH', options.platform) };
    this.options = options;
    this.pending = new Map();
    this.sequence = 0;
    this.child = null;
    this.connecting = null;
    this.closed = false;
    this.generation = 0;
    this.discovery = null;
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
    const generation = this.generation;
    const discovery = new AbortController(); this.discovery = discovery;
    const startupMs = Math.min(30000, Math.max(1, this.options.startupTimeoutMs || 20000));
    const deadline = Date.now() + startupMs;
    const attempts = Math.min(64, Math.max(1, this.options.maxStartupAttempts || 32));
    const timeoutError = () => Object.assign(new Error('Codex CLI startup timed out'), { code: 'TIMEOUT' });
    const interrupted = () => this.closed ? Object.assign(new Error('Closed'), { code: 'CLOSED' })
      : generation !== this.generation ? Object.assign(new Error('Connection superseded'), { code: 'INVALIDATED' })
      : discovery.signal.aborted || Date.now() >= deadline ? timeoutError() : null;
    const timer = setTimeout(() => {
      discovery.abort();
      if (generation === this.generation && this.discovery === discovery) this.releaseChild(this.child, timeoutError());
    }, startupMs);
    const excludedPaths = new Set(this.options.excludedPaths || []);
    let lastError;
    try {
      for (let attempt = 0; attempt < attempts; attempt++) {
        const interruption = interrupted(); if (interruption) throw interruption;
        let executable;
        try {
          executable = await require('./codex-cli.cjs').resolveCodexExecutable(this.options.codexPath, {
            ...this.options, excludedPaths, signal: discovery.signal,
            find: (explicit, excluded) => findCodexExecutable(explicit, { ...this.options, ...excluded, excludedPaths }),
          });
        } catch (error) {
          throw interrupted() || (error?.code === 'CLI_MISSING' && lastError ? lastError : error);
        }
        const stopped = interrupted(); if (stopped) throw stopped;
        try {
          const connected = await this.startCandidate(executable, Math.min(this.options.timeoutMs || 12000, Math.max(1, deadline - Date.now())));
          const cancelled = interrupted();
          if (cancelled) { this.releaseChild(connected, cancelled); throw cancelled; }
          if (this.child !== connected) throw Object.assign(new Error('App-server exited during startup'), { code: 'EXIT' });
          return;
        } catch (error) {
          const cancelled = interrupted(); if (cancelled) throw cancelled;
          // Only launch/initialize failures may select another automatically
          // discovered CLI. Login and later account RPCs never use this path.
          if (this.options.codexPath || authenticationError(error) || /api.key|bedrock|unsupported auth/i.test(error?.message || '') || !new Set([
            'ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'ENOEXEC', 'EINVAL', 'UNKNOWN', 'EXIT', 'TIMEOUT',
            'EPIPE', 'ECONNRESET', 'ERR_STREAM_DESTROYED', 'ERR_STREAM_WRITE_AFTER_END', 'PROTOCOL', 'CLI_MISSING', -32601, -32602,
          ]).has(error?.code)) throw error;
          lastError = error;
          excludedPaths.add(executable);
        }
      }
      throw lastError || timeoutError();
    } finally {
      clearTimeout(timer);
      if (this.discovery === discovery) this.discovery = null;
    }
  }

  async startCandidate(executable, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    const env = { ...(this.options.env || process.env) };
    if (this.options.codexHome) {
      for (const key of Object.keys(env)) if (key.toUpperCase() === 'CODEX_HOME') delete env[key];
      env.CODEX_HOME = this.options.codexHome;
    }
    const child = (this.options.spawn || spawnCodex)(executable, [
      'app-server', '--listen', 'stdio://',
      // Process-local analytics override; never rewrites the user's config.
      // This client only sends the account-read methods above, never thread/start.
      '-c', 'analytics.enabled=false',
    ], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env, cwd: os.tmpdir() });
    this.child = child;
    let failure;
    const fail = error => {
      if (this.child !== child) return;
      failure = error;
      this.releaseChild(child, error);
    };
    let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      if (this.child !== child) return;
      buffer += chunk;
      if (buffer.length > MAX_LINE && !buffer.includes('\n')) {
        fail(Object.assign(new Error('Protocol message too large'), { code: 'PROTOCOL' }));
        return;
      }
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.length > MAX_LINE) continue;
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (!message || typeof message !== 'object' || Array.isArray(message)) {
          fail(Object.assign(new Error('Invalid protocol message'), { code: 'PROTOCOL' })); return;
        }
        if (message.method && message.id !== undefined) {
          // No auth refresh, tool calls, elicitation, or other server request is supported.
          this.write(child, `${JSON.stringify({ id: message.id, error: { code: -32601, message: 'Read-only quota client' } })}\n`);
          continue;
        }
        const pending = this.pending.get(message.id);
        if (!pending || pending.child !== child) continue;
        clearTimeout(pending.timer);
        this.pending.delete(message.id);
        if (message.error) pending.reject(Object.assign(new Error(message.error.message || 'App-server error'), { code: message.error.code }));
        else pending.resolve(message.result);
      }
    });
    // Drain without retaining stderr: it may contain private filesystem paths or account data.
    child.stderr.on('data', () => {});
    child.stdin.on('error', fail);
    child.stdout.on('error', fail);
    child.stderr.on('error', () => {});
    child.on('error', fail);
    child.on('exit', () => fail(Object.assign(new Error('App-server exited'), { code: 'EXIT' })));
    try {
      await this.request('initialize', { clientInfo: { name: 'codex_maid_widget', title: 'Codex Maid Widget', version: APP_VERSION } }, timeoutMs);
      if (this.child !== child) throw failure || Object.assign(new Error('Connection superseded'), { code: 'INVALIDATED' });
      await this.notifyInitialized(child, Math.max(1, deadline - Date.now()));
      if (this.child !== child) throw failure || Object.assign(new Error('App-server exited during startup'), { code: 'EXIT' });
      return child;
    } catch (error) { this.releaseChild(child, error); throw error; }
  }

  notifyInitialized(child, timeoutMs) {
    // This notification has no RPC response. Wait for the pipe write callback
    // before calling startup successful, keeping it under the same cleanup as
    // initialize so close/invalidation cannot strand this promise.
    const id = Symbol('initialized');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.releaseChild(child,
        Object.assign(new Error('Codex CLI initialization timed out'), { code: 'TIMEOUT' })), timeoutMs);
      const pending = { resolve, reject, timer, child };
      this.pending.set(id, pending);
      const written = this.write(child, `${JSON.stringify({ method: 'initialized', params: {} })}\n`, error => {
        if (this.pending.get(id) !== pending) return;
        if (error) { this.releaseChild(child, error); return; }
        clearTimeout(timer); this.pending.delete(id); resolve();
      });
      if (!written && this.pending.get(id) === pending) {
        clearTimeout(timer); this.pending.delete(id);
        reject(Object.assign(new Error('App-server pipe unavailable'), { code: 'EXIT' }));
      }
    });
  }

  write(child, value, completed) {
    if (this.child !== child) return false;
    try {
      child.stdin.write(value, error => { if (error) this.releaseChild(child, error); completed?.(error); });
      return this.child === child;
    } catch (error) { this.releaseChild(child, error); completed?.(error); return false; }
  }

  request(method, params = {}, timeoutMs = this.options.timeoutMs || 12000) {
    if (!READ_METHODS.has(method)) return Promise.reject(new Error('Only quota read methods are allowed'));
    const child = this.child;
    if (!child) return Promise.reject(new Error('Not connected'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const error = Object.assign(new Error('Codex quota request timed out'), { code: 'TIMEOUT' });
        this.releaseChild(child, error);
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, child });
      this.write(child, `${JSON.stringify({ id, method, params })}\n`);
    });
  }

  releaseChild(child, error) {
    if (!child || this.child !== child) return;
    this.child = null;
    for (const [id, request] of this.pending) {
      if (request.child !== child) continue;
      clearTimeout(request.timer); this.pending.delete(id); request.reject(error);
    }
    try { child.stdin.destroy(); } catch {} try { child.kill(); } catch {}
  }

  disconnect(error = Object.assign(new Error('Closed'), { code: 'CLOSED' })) {
    this.generation++;
    this.discovery?.abort(); this.discovery = null;
    this.connecting = null;
    this.releaseChild(this.child, error);
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
    // Local presentation is intentionally absent from public snapshots and from
    // accidental source serialization. Only the main process reads this field.
    Object.defineProperty(this, 'accountPresentation', { value: null, writable: true, enumerable: false });
    Object.defineProperty(this, 'accountProfileReader', { value: options.profileReader ||
      (options.profileMetadata ? new (require('./account-profile-reader.cjs').AccountProfileReader)({
        codexHome: options.codexHome || process.env.CODEX_HOME || path.join(os.homedir(), '.codex'),
        fetch: options.profileFetch,
      }) : null), writable: true, enumerable: false });
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
    this.accountPresentation = null;
    this.accountProfileReader?.invalidate?.();
    this.inflight = null;
    this.server.disconnect?.(Object.assign(new Error('Account state changed'), { code: 'INVALIDATED' }));
    // Device-wide usage is independent of login. Keep the incremental log cache.
    return this.generation;
  }

  async readSnapshot(revision) {
    if (revision === this.revision) this.accountPresentation = null;
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
      if (base.status === 'live' && !base.error && identity) {
        let profile = {};
        if (this.accountProfileReader) {
          try {
            profile = await this.accountProfileReader.read({ key: identity,
              scopeId: accountResult?.workspaceRouting?.chatgptAccountId, email: accountResult?.account?.email });
          } catch { /* Optional profile metadata can never invalidate live quota. */ }
          if (revision !== this.revision || this.closed) return superseded();
        }
        this.accountPresentation = accountPresentation(accountResult, identity, base.generation, profile);
      }
      return base;
    } catch (error) {
      const local = await localPromise;
      if (revision !== this.revision) return superseded();
      // Without a confirmed identity, never allow the main process to revive a
      // previous account's quota as stale. Device token totals can remain visible.
      this.accountIdentity = null;
      this.accountPresentation = null;
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

  close() { this.closed = true; this.revision++; this.accountPresentation = null; this.accountProfileReader?.close?.(); this.server.close(); }
}

module.exports = {
  CodexDataSource, ReadOnlyAppServer, LocalUsageReader,
  normalizeWindow, normalizeCredits, normalizeRateLimits, normalizeAccount, normalizeAccountUsage,
  friendlyError, dateKey, weekRange, findCodexExecutable,
};
