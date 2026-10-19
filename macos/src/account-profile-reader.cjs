'use strict';

// User-authorized, read-only profile lookup. Credentials remain function-local;
// caches contain only the projected nickname/workspace name and file metadata.
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { projectProfileMetadata } = require('./account-profile.cjs');

const MAX_BYTES = 1024 * 1024;
const CACHE_MS = 5 * 60 * 1000;
const PROFILE_URL = 'https://chatgpt.com/backend-api/wham/profiles/me';
const ACCOUNTS_URL = 'https://chatgpt.com/backend-api/wham/accounts/check';
const empty = () => ({ profileNickname: null, workspaceName: null });
const validKey = value => typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
const validScope = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,160}$/.test(value);
const fileStamp = value => [value.dev, value.ino, value.size, value.mtimeMs, value.ctimeMs].join(':');
const validFile = value => value?.isFile() && !value.isSymbolicLink?.() && Number.isSafeInteger(value.size) && value.size > 0 && value.size <= MAX_BYTES;

async function readCredentials(filesystem, file, expectedStamp, scopeId, signal) {
  let descriptor, buffer;
  try {
    signal.throwIfAborted();
    descriptor = await filesystem.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const before = await descriptor.stat();
    if (!validFile(before) || fileStamp(before) !== expectedStamp) return null;
    buffer = Buffer.alloc(MAX_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      signal.throwIfAborted();
      const result = await descriptor.read(buffer, size, buffer.length - size, size);
      if (!result.bytesRead) break;
      size += result.bytesRead;
    }
    const after = await descriptor.stat(), pathAfter = await filesystem.lstat(file);
    if (size > MAX_BYTES || size !== before.size || !validFile(pathAfter) ||
        fileStamp(after) !== expectedStamp || fileStamp(pathAfter) !== expectedStamp) return null;
    signal.throwIfAborted();
    const parsed = JSON.parse(buffer.subarray(0, size).toString('utf8'));
    const accountId = parsed?.tokens?.account_id;
    const token = parsed?.tokens?.access_token;
    // No fallback to id_token, refresh_token, an API key, or another identity.
    if (accountId !== scopeId || typeof token !== 'string' ||
        !/^[A-Za-z0-9._~+/-]{8,16384}={0,2}$/.test(token)) return null;
    return token;
  } catch { return null; }
  finally {
    buffer?.fill(0);
    if (descriptor) { try { await descriptor.close(); } catch {} }
  }
}

async function readJson(fetcher, url, token, scopeId, signal) {
  let response, reader;
  try {
    signal.throwIfAborted();
    response = await fetcher(url, { method: 'GET', redirect: 'error', credentials: 'omit', cache: 'no-store', signal,
      headers: { Authorization: `Bearer ${token}`, 'ChatGPT-Account-ID': scopeId, Accept: 'application/json', originator: 'Codex Desktop' } });
    // Even injected transports may not follow redirects or change destination.
    if (!response?.ok || response.redirected || (response.url && response.url !== url)) return null;
    const length = response.headers?.get('content-length');
    if (length !== null && length !== undefined && (!/^\d+$/.test(length) || Number(length) > MAX_BYTES)) return null;
    if (!response.body || typeof response.body.getReader !== 'function') return null;
    reader = response.body.getReader();
    const chunks = []; let size = 0;
    while (true) {
      signal.throwIfAborted();
      const part = await reader.read();
      if (part.done) break;
      if (!(part.value instanceof Uint8Array)) return null;
      size += part.value.byteLength;
      if (size > MAX_BYTES) return null;
      chunks.push(Buffer.from(part.value));
    }
    signal.throwIfAborted();
    return JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
  } catch { return null; }
  finally {
    try { if (reader) await reader.cancel(); else await response?.body?.cancel(); } catch {}
    try { reader?.releaseLock(); } catch {}
  }
}

class AccountProfileReader {
  constructor({ codexHome, filesystem = fs, fetch: fetcher = globalThis.fetch, now = Date.now, timeoutMs = 1800 } = {}) {
    if (typeof codexHome !== 'string' || !codexHome || codexHome.includes('\0') || !filesystem ||
        typeof filesystem.lstat !== 'function' || typeof filesystem.open !== 'function' ||
        typeof fetcher !== 'function' || typeof now !== 'function' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new TypeError('An explicit Codex home and valid profile-reader dependencies are required');
    }
    this.file = path.join(path.resolve(codexHome), 'auth.json');
    // Production uses 1800 ms; a local diagnostic may explicitly allow up to 5 s.
    this.filesystem = filesystem; this.fetcher = fetcher; this.now = now; this.timeoutMs = Math.min(timeoutMs, 5000);
    this.cached = null; this.inflight = null; this.identity = null; this.closed = false; this.revision = 0; this.controllers = new Set();
  }

  async read({ key, scopeId } = {}) {
    if (this.closed || !validKey(key) || !validScope(scopeId)) return empty();
    const identity = `${key.toLowerCase()}:${scopeId}`;
    if (this.identity !== identity) { this.invalidate(); this.identity = identity; }
    const revision = this.revision, controller = new AbortController();
    this.controllers.add(controller);
    let timer;
    const expired = new Promise(resolve => {
      controller.signal.addEventListener('abort', () => resolve(empty()), { once: true });
      timer = setTimeout(() => controller.abort(), this.timeoutMs);
    });
    // The same deadline and invalidation signal cover the first filesystem
    // operation as well as credentials, both requests and final verification.
    const lookup = this._read(identity, scopeId, revision, controller).catch(() => empty());
    try {
      const value = await Promise.race([lookup, expired]);
      return controller.signal.aborted || revision !== this.revision || this.closed ? empty() : { ...value };
    } finally {
      clearTimeout(timer); this.controllers.delete(controller);
    }
  }

  async _read(identity, scopeId, revision, controller) {
    const current = () => !controller.signal.aborted && revision === this.revision && !this.closed && this.identity === identity;
    let info;
    try { info = await this.filesystem.lstat(this.file); }
    catch { if (current()) this.cached = null; return empty(); }
    if (!current()) return empty();
    if (!validFile(info)) { this.cached = null; return empty(); }
    const stamp = fileStamp(info), signature = `${identity}:${stamp}`;
    const now = this.now();
    if (this.cached?.signature === signature && Number.isFinite(now) && now >= this.cached.at && now - this.cached.at < CACHE_MS) return { ...this.cached.value };
    if (this.inflight?.signature === signature) return { ...await this.inflight.promise };
    if (this.inflight) this.inflight.controller.abort();
    const lookup = (async () => {
      const token = await readCredentials(this.filesystem, this.file, stamp, scopeId, controller.signal);
      if (!token || !current()) return empty();
      const [profile, accounts] = await Promise.all([
        readJson(this.fetcher, PROFILE_URL, token, scopeId, controller.signal),
        readJson(this.fetcher, ACCOUNTS_URL, token, scopeId, controller.signal),
      ]);
      if (!current()) return empty();
      const after = await this.filesystem.lstat(this.file);
      if (!validFile(after) || fileStamp(after) !== stamp) return empty();
      return projectProfileMetadata({ profile, profileKind: 'profile-summary', accounts, scopeId });
    })().catch(() => empty());
    const promise = lookup.then(value => {
      if (!current()) return empty();
      this.cached = { signature, at: this.now(), value: { ...value } };
      return value;
    }).finally(() => {
      if (this.inflight?.promise === promise) this.inflight = null;
    });
    this.inflight = { signature, promise, controller };
    return { ...await promise };
  }

  invalidate() {
    this.revision += 1; this.cached = null; this.inflight = null; this.identity = null;
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear();
  }

  close() { this.closed = true; this.invalidate(); }
}

module.exports = { AccountProfileReader };
