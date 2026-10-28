'use strict';
const fs = require('node:fs');
const path = require('node:path');

const SOURCE = 'https://codex-reset.com/';
const ENDPOINT = SOURCE + 'api/forecast';
const INTERVAL = 120000;
const MAX_BYTES = 65536;
const MAX_AGE = 15 * 60000;
const empty = () => ({ source: SOURCE, probability24h: null, probability48h: null, confidence: null,
  lastResetAt: null, updatedAt: null, fetchedAt: null, signal: null });
function timestamp(value) {
  if (typeof value !== 'string' || value.length > 64 || !/^\d{4}-\d\d-\d\dT/.test(value)) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}
function probability(value) { return Number.isInteger(value) && value >= 0 && value <= 100 ? value : null; }
function sourceUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.port && ['x.com', 'twitter.com'].includes(url.hostname) && !url.username && !url.password
      && /^\/thsottiaux\/status\/\d+$/.test(url.pathname) ? url.origin + url.pathname : null;
  } catch { return null; }
}
function observationDetails(value, id, at) {
  const deadlineAt = timestamp(value?.deadlineAt);
  if (!deadlineAt || !id || Date.parse(deadlineAt) < Date.parse(at) || Date.parse(deadlineAt) - Date.parse(at) > 24 * 3600000) return null;
  try {
    const url = new URL(value.sourceUrl);
    if (url.origin !== 'https://codex-reset.com' || url.username || url.password || url.search || url.hash
      || !/^\/assets\/[A-Za-z0-9/_-]+\/home-countdown\.js$/.test(url.pathname)) return null;
    return { deadlineAt, deadlineKind: 'observation', deadlineSource: url.href,
      deadlineQuote: typeof value.quote === 'string' ? value.quote.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 160) : null };
  } catch { return null; }
}
function normalizeForecast(value, now = Date.now()) {
  const updatedAt = timestamp(value?.updated_at);
  let p24 = probability(value?.probabilities?.rounded_24h), p48 = probability(value?.probabilities?.rounded_48h);
  if (!updatedAt || Date.parse(updatedAt) > now + 5 * 60000) throw new Error('Invalid forecast');
  const probabilitiesValid = p24 !== null && p48 !== null && p48 >= p24;
  if (!probabilitiesValid) p24 = p48 = null;
  const last = timestamp(value.last_reset_at);
  const lastResetAt = last && Date.parse(last) <= now + 5 * 60000 ? last : null;
  const alert = value.latest_alert, at = timestamp(alert?.source_at);
  const end = timestamp(alert?.window?.end_at), target = timestamp(alert?.window?.target_at);
  const deadline = target || end;
  const active = alert?.kind === 'watch' && ['active', 'expired'].includes(alert.state) && at && Date.parse(at) <= now + 60000
    && now - Date.parse(at) <= 48 * 3600000 && (!lastResetAt || Date.parse(at) > Date.parse(lastResetAt))
    && (!deadline || Date.parse(deadline) >= Date.parse(at));
  if (!probabilitiesValid && !active) throw new Error('Invalid forecast');
  const id = typeof alert?.id === 'string' && /^[A-Za-z0-9:_-]{1,100}$/.test(alert.id) ? alert.id : null;
  const pending = ['done', 'on_its_way'].includes(alert?.pending) ? alert.pending : null;
  // The canonical Alert score wins. The site's optional promise-score extension
  // is accepted only for the very same official post, and is never a cadence %.
  const extensionScore = value.official_signal?.tweet_id === id ? value.probabilities?.commitment_floor_percent : null;
  const score = [83, 93].includes(alert?.score) ? alert.score : [83, 93].includes(extensionScore) ? extensionScore : null;
  // Only documented Alert fields cross into the renderer/cache. A watch,
  // including Tibo's own completion statement, is never a confirmed reset.
  const signal = active ? { id, at, state: alert.state, pending, score, kind: pending ? 'pending' : score === 93 ? 'promise' : 'watch', url: sourceUrl(alert.url),
    summary: typeof alert.summary === 'string' ? alert.summary.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 280) : '',
    deadlineAt: deadline, deadlineKind: deadline ? 'announcement' : null, deadlineQuote: null, deadlineSource: null } : null;
  return { ...empty(), probability24h: p24, probability48h: p48,
    confidence: ['low', 'medium', 'high'].includes(value.confidence) ? value.confidence : null,
    lastResetAt, updatedAt, signal };
}
function retryDelay(value, now) {
  if (typeof value !== 'string' || !value.trim()) return INTERVAL;
  const seconds = /^\d+(?:\.\d+)?$/.test(value.trim()) ? Number(value) * 1000 : Date.parse(value) - now;
  return Number.isFinite(seconds) ? Math.max(INTERVAL, Math.min(2147483647, seconds)) : INTERVAL;
}
async function readText(response, limit = MAX_BYTES) {
  if (Number(response.headers?.get('content-length')) > limit) throw new Error('Oversize forecast');
  if (response.body?.getReader) {
    const reader = response.body.getReader(); let size = 0; const chunks = [];
    try {
      while (true) {
        const { value, done } = await reader.read(); if (done) break;
        size += value.byteLength;
        if (size > limit) throw new Error('Oversize forecast');
        chunks.push(Buffer.from(value));
      }
      return Buffer.concat(chunks).toString('utf8');
    } finally { await reader.cancel().catch(() => {}); }
  }
  const text = await response.text();
  if (Buffer.byteLength(text) > limit) throw new Error('Oversize forecast');
  return text;
}
async function readJson(response) { return JSON.parse(await readText(response)); }
class ResetForecast {
  constructor({ file, fetch: request, version = '0', onChange = () => {}, now = Date.now, io = fs, demo = false, announcementReader } = {}) {
    this.file = file; this.fetch = request; this.now = now; this.io = io; this.onChange = onChange; this.demo = demo;
    this.userAgent = `Codex-Maid-Widget/${version} (+https://github.com/Feeesack/codex-maid-widget)`;
    this.announcementReader = announcementReader;
    this.value = empty(); this.enabled = false; this.closed = false; this.failed = false; this.nextAttempt = 0; this.expires = 0; this.generation = 0;
    if (demo) {
      const time = now();
      this.value = { ...empty(), probability24h: 22, probability48h: 39, confidence: 'low',
        lastResetAt: new Date(time - 2 * 86400000).toISOString(), updatedAt: new Date(time).toISOString(), fetchedAt: new Date(time).toISOString() };
    } else if (file) {
      try {
        if (io.statSync(file).size > MAX_BYTES) throw new Error('Oversize cache');
        const saved = JSON.parse(io.readFileSync(file, 'utf8'));
        const normalized = normalizeForecast(saved.data, now());
        if (normalized.signal && saved.siteDeadline?.id === normalized.signal.id && saved.siteDeadline?.at === normalized.signal.at) {
          const details = observationDetails(saved.siteDeadline, normalized.signal.id, normalized.signal.at);
          if (details && !normalized.signal.deadlineAt) Object.assign(normalized.signal, details);
        }
        const fetchedAt = timestamp(saved.fetchedAt);
        if (!fetchedAt || Date.parse(fetchedAt) > now() + 60000) throw new Error('Invalid cache');
        this.value = { ...normalized, fetchedAt }; this.expires = Date.parse(saved.expiresAt) || 0;
        // Restored bytes are historical until a fresh public GET succeeds.
        this.failed = true;
      } catch { /* A missing or malformed public cache never blocks startup. */ }
    }
  }
  snapshot() {
    const now = this.now(), data = { ...this.value, signal: this.value.signal ? { ...this.value.signal } : null };
    const stale = this.failed || !data.updatedAt || now - Date.parse(data.updatedAt) > MAX_AGE || (this.expires > 0 && now >= this.expires);
    const status = !this.enabled ? 'disabled' : this.demo ? 'demo' : !data.updatedAt ? (this.failed ? 'offline' : 'connecting') : stale ? 'stale' : 'live';
    if (!['live', 'stale', 'demo'].includes(status) || (data.signal && now - Date.parse(data.signal.at) > 48 * 3600000)) data.signal = null;
    return { ...data, status };
  }
  setEnabled(enabled) {
    if (this.closed || this.enabled === !!enabled) return;
    this.enabled = !!enabled; clearTimeout(this.timer);
    if (!this.enabled) { this.generation++; this.controller?.abort(); this.inFlight = null; this.onChange(); return; }
    if (!this.demo) void this.refresh();
    this.onChange();
  }
  async refresh() {
    if (this.closed || !this.enabled || this.demo) return this.snapshot();
    if (this.inFlight) return this.inFlight;
    if (this.now() < this.nextAttempt) { this.schedule(); return this.snapshot(); }
    const generation = this.generation;
    this.nextAttempt = this.now() + INTERVAL;
    this.controller = new AbortController();
    const controller = this.controller, timeout = setTimeout(() => controller.abort(), 8000);
    const task = (async () => {
      try {
        if (typeof this.fetch !== 'function') throw new Error('Unavailable transport');
        const response = await this.fetch(ENDPOINT, { method: 'GET', credentials: 'omit', redirect: 'error', signal: controller.signal,
          headers: { Accept: 'application/json', 'User-Agent': this.userAgent } });
        if (this.closed || !this.enabled || generation !== this.generation) return this.snapshot();
        if (response.status === 429 || response.status === 503) {
          this.nextAttempt = this.now() + retryDelay(response.headers?.get('retry-after'), this.now());
        }
        if (!response.ok) throw new Error('Unavailable forecast');
        const data = await readJson(response), now = this.now();
        if (this.closed || !this.enabled || generation !== this.generation) return this.snapshot();
        const value = normalizeForecast(data, now);
        if (value.signal?.state === 'active' && !value.signal.deadlineAt && /^\d{1,30}$/.test(value.signal.id || '')) {
          try {
            this.announcementReader ||= new (require('./reset-announcement.cjs').ResetAnnouncement)({ now: this.now,
              fetch: async (url, options) => {
                const extra = await this.fetch(url, { ...options,
                  headers: { Accept: 'text/html, application/javascript, text/plain', 'User-Agent': this.userAgent } });
                if (extra.status === 429 || extra.status === 503) this.nextAttempt = Math.max(this.nextAttempt,
                  this.now() + retryDelay(extra.headers?.get('retry-after'), this.now()));
                if (!extra.ok) throw new Error('Unavailable announcement metadata');
                return readText(extra, 256 * 1024);
              } });
            const extra = await this.announcementReader.deadlineFor({ id: value.signal.id, at: value.signal.at, signal: controller.signal });
            const details = observationDetails(extra, value.signal.id, value.signal.at);
            if (details) Object.assign(value.signal, details);
          } catch { /* Optional site metadata failure keeps the explicit signal, without inventing a deadline. */ }
        }
        if (this.closed || !this.enabled || generation !== this.generation) return this.snapshot();
        this.value = { ...value, fetchedAt: new Date(now).toISOString() }; this.failed = false;
        this.expires = Date.parse(response.headers?.get('x-published-expires-at')) || Date.parse(value.updatedAt) + MAX_AGE;
        if (this.file) try {
          // The cache contains public, bounded fields only. No account, quota,
          // local paths, credentials or arbitrary API extension fields persist.
          const cacheData = { updated_at: value.updatedAt, probabilities: { rounded_24h: value.probability24h, rounded_48h: value.probability48h },
            confidence: value.confidence, last_reset_at: value.lastResetAt, latest_alert: value.signal ? { kind: 'watch',
              id: value.signal.id, state: value.signal.state, score: value.signal.score, pending: value.signal.pending,
              source_at: value.signal.at, summary: value.signal.summary, url: value.signal.url,
              window: value.signal.deadlineKind === 'announcement' && value.signal.deadlineAt ? { end_at: value.signal.deadlineAt } : null } : null };
          this.io.mkdirSync(path.dirname(this.file), { recursive: true });
          const siteDeadline = value.signal?.deadlineKind === 'observation' ? { id: value.signal.id, at: value.signal.at,
            deadlineAt: value.signal.deadlineAt, quote: value.signal.deadlineQuote, sourceUrl: value.signal.deadlineSource } : null;
          this.io.writeFileSync(this.file + '.tmp', JSON.stringify({ data: cacheData, siteDeadline, fetchedAt: this.value.fetchedAt, expiresAt: new Date(this.expires).toISOString() }));
          this.io.renameSync(this.file + '.tmp', this.file);
        } catch { /* Read-only/custom data directories still display live data. */ }
      } catch {
        if (!this.closed && this.enabled && generation === this.generation) this.failed = true;
      } finally { clearTimeout(timeout); }
      if (!this.closed && this.enabled && generation === this.generation) { this.onChange(); this.schedule(); }
      return this.snapshot();
    })();
    this.inFlight = task;
    try { return await task; } finally { if (this.inFlight === task) this.inFlight = null; }
  }
  schedule() {
    clearTimeout(this.timer);
    if (!this.closed && this.enabled && !this.demo) {
      this.timer = setTimeout(() => void this.refresh(), Math.max(1000, this.nextAttempt - this.now())); this.timer.unref?.();
    }
  }
  close() { this.closed = true; this.generation++; clearTimeout(this.timer); this.controller?.abort(); }
}
module.exports = { ResetForecast, normalizeForecast, retryDelay, SOURCE, ENDPOINT, INTERVAL };
