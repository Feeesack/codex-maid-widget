'use strict';

// Compatibility with the site's published observation corrections. This reads
// bounded public source as data; no JavaScript from the site is ever executed.
const ORIGIN = 'https://codex-reset.com';
const PAGE = ORIGIN + '/zh/';
const MAX_BYTES = 256 * 1024;
const SUCCESS_TTL = 30 * 60000;
const FAILURE_TTL = 2 * 60000;
const ID = /^\d{5,25}$/;
function isoTime(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value)) return NaN;
  const time = Date.parse(value);
  const canonical = value.replace(/(?:\.(\d{1,3}))?Z$/, (_, fraction = '') => '.' + fraction.padEnd(3, '0') + 'Z');
  return Number.isFinite(time) && new Date(time).toISOString() === canonical ? time : NaN;
}

function assetUrl(value, base, name) {
  if (typeof value !== 'string' || value.length > 512 || /[\s\\]/.test(value)) return null;
  try {
    const url = new URL(value, base);
    return url.origin === ORIGIN && url.protocol === 'https:' && !url.port && !url.username && !url.password
      && !url.search && !url.hash && /^\/assets\/(?:[A-Za-z0-9_-]+\/){0,3}[A-Za-z0-9_-]+\.js$/.test(url.pathname)
      && url.pathname.endsWith('/' + name) ? url.href : null;
  } catch { return null; }
}
function appAsset(page) {
  const found = new Set();
  for (const match of page.replace(/<!--[\s\S]*?-->/g, '').matchAll(/<script\b([^>]*)>/gi)) {
    const attributes = match[1];
    const type = attributes.match(/(?:^|\s)type\s*=\s*(["'])module\1/i);
    const src = attributes.match(/(?:^|\s)src\s*=\s*(["'])([^"']+)\1/i);
    const url = type && src && assetUrl(src[2], PAGE, 'app.js');
    if (url) found.add(url);
  }
  return found.size === 1 ? [...found][0] : null;
}

// A small lexer is sufficient for the two named import declarations and JSON
// exports. It skips comments and quoted/template strings so lookalike code in
// those regions cannot provide an import or an assignment.
function tokens(source) {
  const result = [];
  let index = 0;
  while (index < source.length) {
    const start = index, ch = source[index], next = source[index + 1];
    if (/\s/.test(ch)) { index++; continue; }
    if (ch === '/' && next === '/') { index += 2; while (index < source.length && source[index] !== '\n') index++; continue; }
    if (ch === '/' && next === '*') {
      const end = source.indexOf('*/', index + 2); if (end < 0) return null; index = end + 2; continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      index++;
      while (index < source.length && source[index] !== ch) {
        if (source[index] === '\\') index++;
        index++;
      }
      if (index >= source.length) return null;
      index++;
      result.push({ kind: ch === '`' ? 'template' : 'string', value: source.slice(start + 1, index - 1), start, end: index });
      continue;
    }
    if (/[A-Za-z_$]/.test(ch)) {
      index++; while (index < source.length && /[A-Za-z0-9_$]/.test(source[index])) index++;
      result.push({ kind: 'word', value: source.slice(start, index), start, end: index }); continue;
    }
    result.push({ kind: 'punct', value: ch, start, end: ++index });
  }
  return result;
}
function importedAsset(source, base, name, dynamic) {
  const list = tokens(source); if (!list) return null;
  const found = new Set();
  for (let index = 0; index < list.length; index++) {
    if (list[index].kind !== 'word' || list[index].value !== 'import') continue;
    let target;
    if (dynamic && list[index + 1]?.value === '(' && list[index + 2]?.kind === 'string' && list[index + 3]?.value === ')') {
      target = list[index + 2].value;
    } else if (!dynamic && list[index + 1]?.value === '{') {
      let cursor = index + 2;
      while (cursor < list.length && list[cursor].value !== '}' && list[cursor].value !== ';') cursor++;
      if (list[cursor]?.value === '}' && list[cursor + 1]?.value === 'from' && list[cursor + 2]?.kind === 'string') target = list[cursor + 2].value;
    }
    const url = target && assetUrl(target, base, name);
    if (url) found.add(url);
  }
  return found.size === 1 ? [...found][0] : null;
}
function jsonExport(source, list, name) {
  const prefix = ['export', 'const', name, '=', 'Object', '.', 'freeze', '(', '{'];
  const found = [];
  for (let index = 0; index < list.length; index++) {
    if (!prefix.every((value, offset) => list[index + offset]?.value === value && list[index + offset]?.kind !== 'string')) continue;
    const first = index + prefix.length - 1;
    let depth = 0, end = first;
    for (; end < list.length; end++) {
      if (list[end].kind !== 'punct') continue;
      if (list[end].value === '{') depth++;
      if (list[end].value === '}' && --depth === 0) break;
    }
    if (end >= list.length || list[end + 1]?.value !== ')' || list[end + 2]?.value !== ';') return null;
    let json = source.slice(list[first].start, list[end].end);
    if (name === 'OBSERVATION_QUOTES') {
      // The publisher leaves these two property names unquoted. Convert only
      // those literal object keys; expressions, getters and identifier values
      // still fail JSON.parse and can never run.
      for (let cursor = end - 1; cursor > first; cursor--) {
        const token = list[cursor];
        if (token.kind !== 'word' || !['text', 'source_id'].includes(token.value)
          || list[cursor + 1]?.value !== ':' || !['{', ','].includes(list[cursor - 1]?.value)) continue;
        const start = token.start - list[first].start, finish = token.end - list[first].start;
        json = json.slice(0, start) + JSON.stringify(token.value) + json.slice(finish);
      }
    }
    try { found.push(JSON.parse(json)); } catch { return null; }
  }
  return found.length === 1 && found[0] && !Array.isArray(found[0]) && typeof found[0] === 'object' ? found[0] : null;
}
function metadata(source, sourceUrl) {
  const list = tokens(source); if (!list) return null;
  const deadlines = jsonExport(source, list, 'OBSERVATION_DEADLINES');
  const quotes = jsonExport(source, list, 'OBSERVATION_QUOTES');
  if (!deadlines || !quotes) return null;
  const entries = new Map();
  for (const [id, value] of Object.entries(deadlines)) {
    if (!ID.test(id) || !Number.isFinite(isoTime(value))) return null;
    const quote = quotes[id];
    if (!quote || typeof quote !== 'object' || Array.isArray(quote) || typeof quote.source_id !== 'string' || !ID.test(quote.source_id)
      || typeof quote.text !== 'string' || !quote.text.trim() || quote.text.length > 280 || /[\u0000-\u001f\u007f]/.test(quote.text)) return null;
    entries.set(id, { deadlineAt: new Date(isoTime(value)).toISOString(), quote: quote.text.trim(), sourceUrl,
      replyId: quote.source_id, kind: 'observation' });
  }
  return entries;
}

class ResetAnnouncement {
  // fetch is an injected requestText(url, options) => Promise<string>. The
  // caller owns User-Agent, abort/timeouts and bounded streaming; this adapter
  // repeats URL, method and decoded-size checks before using the public text.
  constructor({ fetch, now = Date.now } = {}) {
    this.fetch = fetch; this.now = now; this.entries = null; this.freshUntil = 0; this.nextAttempt = 0; this.inFlight = null;
  }
  async text(url, signal) {
    if (signal?.aborted) throw new Error('Canceled public source');
    const text = await this.fetch(url, { method: 'GET', credentials: 'omit', redirect: 'error', ...(signal ? { signal } : {}) });
    if (signal?.aborted || typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_BYTES) throw new Error('Invalid public source');
    return text;
  }
  async load(signal, id) {
    if (this.inFlight) return this.inFlight;
    if (this.now() < this.freshUntil && this.entries?.has(id)) return this.entries;
    if (this.now() < this.nextAttempt) return this.now() < this.freshUntil ? this.entries : null;
    if (this.now() >= this.freshUntil) this.entries = null;
    this.nextAttempt = this.now() + FAILURE_TTL;
    const task = (async () => {
      try {
        if (typeof this.fetch !== 'function') return null;
        const app = appAsset(await this.text(PAGE, signal)); if (!app) return null;
        const home = importedAsset(await this.text(app, signal), app, 'home.js', true); if (!home) return null;
        // Imports must stay in the exact published asset directory; a changed
        // layout fails quietly until this narrow adapter is deliberately updated.
        if (new URL(home).pathname.slice(0, -'home.js'.length) !== new URL(app).pathname.slice(0, -'app.js'.length)) return null;
        const countdown = importedAsset(await this.text(home, signal), home, 'home-countdown.js', false); if (!countdown) return null;
        if (new URL(countdown).pathname.slice(0, -'home-countdown.js'.length) !== new URL(home).pathname.slice(0, -'home.js'.length)) return null;
        const entries = metadata(await this.text(countdown, signal), countdown); if (!entries || signal?.aborted) return null;
        this.entries = entries; this.freshUntil = this.now() + SUCCESS_TTL;
        return entries;
      } catch { return null; }
    })();
    this.inFlight = task;
    try { return await task; } finally { if (this.inFlight === task) this.inFlight = null; }
  }
  async deadlineFor({ id, at, signal } = {}) {
    const time = isoTime(at);
    if (signal?.aborted || typeof id !== 'string' || !ID.test(id) || !Number.isFinite(time) || time > this.now()) return null;
    const entries = await this.load(signal, id), entry = entries?.get(id);
    if (signal?.aborted) return null;
    if (!entry) return null;
    const duration = Date.parse(entry.deadlineAt) - time;
    return duration >= 0 && duration <= 86400000 ? { ...entry } : null;
  }
}

module.exports = { ResetAnnouncement };
