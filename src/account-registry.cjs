'use strict';

// A local ledger of quota observations and user-authorized display names. Only
// explicit, scope-bound presentation fields are retained alongside irreversible
// fingerprints. Authentication files, tokens and raw account IDs never enter it.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const WINDOW_MINUTES = 300;
const WINDOW_SECONDS = WINDOW_MINUTES * 60;
const MAX_ACCOUNTS = 100;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_TIMESTAMP = 253402300799;
const PLAN_LABELS = Object.freeze({ free: 'Free', go: 'Go', plus: 'Plus', pro: 'Pro', team: 'Team',
  business: 'Business', enterprise: 'Enterprise', edu: 'Education', education: 'Education' });
const PERSONAL_PLANS = new Set(['free', 'go', 'plus', 'pro']);
const WORKSPACE_PLANS = new Set(['team', 'business', 'enterprise', 'edu', 'education']);
const fingerprint = value => typeof value === 'string' && /^[a-fA-F0-9]{64}$/.test(value) ? value.toLowerCase() : null;
const timestamp = value => typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= MAX_TIMESTAMP ? value : null;
const percentage = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
// Retain safe future protocol plan names (for example a new pro variant), while
// never accepting account identity strings or guessing their workspace scope.
const planType = value => typeof value === 'string' && /^[a-z][a-z0-9_-]{0,31}$/i.test(value) ? value.toLowerCase() : null;
const planLabel = value => PLAN_LABELS[value] || (value && value !== 'unknown' ? `未知套餐（${value}）` : '未知套餐');
const scopeLabel = value => PERSONAL_PLANS.has(value) ? '个人' : WORKSPACE_PLANS.has(value) ? '工作空间' : '未知范围';

function cleanText(value, limit) {
  if (typeof value !== 'string') return null;
  const text = Array.from(value.normalize('NFC')
    .replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u206f\ufeff]/g, '')
    .trim()).slice(0, limit).join('');
  return text || null;
}

function labelFor(value, ordinal) {
  return cleanText(value, 32) || `账号 ${ordinal}`;
}

function emailFor(value) {
  // Display only an actual email value returned as such, never an account ID,
  // bearer token or another protocol field supplied in its place.
  const text = cleanText(value, 255);
  return text && Array.from(text).length <= 254 && /^[^\s@]{1,64}@[^\s@]{1,189}$/.test(text) ? text : null;
}

function automaticLabel(account) {
  // Profile display_name is a separate concept from account.name, email and
  // profile.username. Only the explicitly bound canonical field is a nickname.
  const display = account.profileNickname || `昵称未读取 ${account.ordinal}`;
  const scope = scopeLabel(account.planType);
  // A generic scope suffix is explicitly a category, not a guessed workspace
  // name. Only an actual returned workspaceName supplies a specific name.
  const suffix = account.workspaceName || (scope === '未知范围' ? null : scope);
  return { label: suffix ? `${display} · ${suffix}` : display, source: account.profileNickname ? 'nickname' : 'fallback' };
}

function refreshLabel(account) {
  const automatic = automaticLabel(account);
  account.autoLabel = automatic.label;
  if (account.userEdited) account.labelSource = 'manual';
  else { account.label = automatic.label; account.labelSource = automatic.source; }
  return account;
}

function selectWindow(buckets) {
  if (!Array.isArray(buckets)) return null;
  const candidates = [];
  for (const bucket of buckets.slice(0, 100)) {
    if (!bucket || typeof bucket !== 'object') continue;
    const bucketId = typeof bucket.id === 'string' ? bucket.id.slice(0, 160) : '';
    for (const kind of ['primary', 'secondary']) {
      const window = bucket[kind];
      if (window && typeof window === 'object' && window.windowDurationMins === WINDOW_MINUTES) {
        candidates.push({ bucketId, kind, window });
      }
    }
  }
  // The general Codex bucket wins. Other five-hour buckets have a stable order,
  // and primary precedes secondary; weekly or unknown windows never substitute.
  candidates.sort((a, b) => Number(b.bucketId === 'codex') - Number(a.bucketId === 'codex') ||
    (a.bucketId < b.bucketId ? -1 : a.bucketId > b.bucketId ? 1 : 0) ||
    Number(a.kind === 'secondary') - Number(b.kind === 'secondary'));
  return candidates[0]?.window || null;
}

function readLedger(file) {
  try {
    // Do not follow a registry symlink into an unrelated or authentication file.
    const info = fs.lstatSync(file);
    if (!info.isFile() || info.size > MAX_FILE_BYTES) throw new Error('Invalid account ledger');
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (value?.version !== 1 || !Array.isArray(value.accounts) || value.accounts.length > MAX_ACCOUNTS ||
        !Number.isSafeInteger(value.nextOrdinal) || value.nextOrdinal < 1) throw new Error('Invalid account ledger');
    const keys = new Set(), ids = new Set();
    const accounts = value.accounts.map(item => {
      if (!item || !fingerprint(item.key) || !Number.isSafeInteger(item.ordinal) || item.ordinal < 1 ||
          item.id !== `account-${item.ordinal}` || item.ordinal >= value.nextOrdinal ||
          !timestamp(item.firstSeenAt) || !timestamp(item.lastSeenAt) || keys.has(fingerprint(item.key)) || ids.has(item.id)) {
        throw new Error('Invalid account ledger');
      }
      keys.add(fingerprint(item.key)); ids.add(item.id);
      const confirmedResetsAt = timestamp(item.confirmedResetsAt);
      const storedLabel = cleanText(item.label, 384) || `账号 ${item.ordinal}`;
      // Version 1 gains optional naming fields. Old defaults can upgrade when a
      // verified observation arrives; every other legacy label is a user alias.
      const userEdited = typeof item.userEdited === 'boolean' ? item.userEdited :
        item.labelSource === 'manual' || storedLabel !== `账号 ${item.ordinal}`;
      return refreshLabel({
        id: item.id, ordinal: item.ordinal, key: fingerprint(item.key), label: labelFor(storedLabel, item.ordinal),
        profileNickname: cleanText(item.profileNickname, 96),
        displayName: cleanText(item.displayName, 96), email: emailFor(item.email), workspaceName: cleanText(item.workspaceName, 96),
        userEdited,
        planType: planType(item.planType), firstSeenAt: item.firstSeenAt, lastSeenAt: item.lastSeenAt,
        observedAt: timestamp(item.observedAt), remainingPercent: percentage(item.remainingPercent),
        confirmedResetsAt, resetSource: confirmedResetsAt ? item.resetSource === 'observed' ? 'observed' : 'estimated' : null,
        alertedThrough: timestamp(item.alertedThrough) || 0,
      });
    });
    return { accounts, nextOrdinal: value.nextOrdinal, storageError: false };
  } catch (error) {
    if (error.code === 'ENOENT') return { accounts: [], nextOrdinal: 1, storageError: false };
    // Preserve unreadable/corrupt data. Starting a replacement ledger here could
    // lose both user labels and the persistent notification deduplication state.
    return { accounts: [], nextOrdinal: 1, storageError: true };
  }
}

class AccountRegistry {
  constructor({ file, now = Date.now } = {}) {
    if (typeof file !== 'string' || !file || file.includes('\0') || typeof now !== 'function') {
      throw new TypeError('An explicit account registry file and clock are required');
    }
    this.file = path.resolve(file);
    this.now = now;
    Object.assign(this, readLedger(this.file));
  }

  _seconds(now) {
    const millis = now === undefined ? this.now() : now;
    if (typeof millis !== 'number' || !Number.isFinite(millis) || millis <= 0 || millis / 1000 > MAX_TIMESTAMP) {
      throw new TypeError('The account registry clock must return Unix milliseconds');
    }
    return millis / 1000;
  }

  _commit(accounts, nextOrdinal = this.nextOrdinal) {
    if (this.storageError) {
      const error = new Error('账号记录文件不可用，已保留原文件。');
      error.code = 'ACCOUNT_REGISTRY_UNAVAILABLE';
      throw error;
    }
    const data = JSON.stringify({ version: 1, nextOrdinal, accounts }, null, 2);
    if (Buffer.byteLength(data) > MAX_FILE_BYTES) throw new Error('Account ledger size limit reached');
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${process.pid}.${randomUUID()}.tmp`;
    let descriptor;
    try {
      descriptor = fs.openSync(temporary, 'wx', 0o600);
      fs.writeFileSync(descriptor, data);
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor); descriptor = undefined;
      fs.renameSync(temporary, this.file);
    } catch (error) {
      if (descriptor !== undefined) { try { fs.closeSync(descriptor); } catch {} }
      try { fs.unlinkSync(temporary); } catch {}
      throw error;
    }
    // A failed write must leave the in-memory alarm eligible for a later retry.
    this.accounts = accounts;
    this.nextOrdinal = nextOrdinal;
  }

  observe(input, now) {
    const key = fingerprint(input?.key);
    if (!key || input.stale || input.error || input.invalidated || (input.status !== undefined && input.status !== 'live')) return false;
    const seconds = this._seconds(now);
    const accounts = this.accounts.map(account => ({ ...account }));
    let account = accounts.find(item => item.key === key);
    let nextOrdinal = this.nextOrdinal;
    const isNew = !account;
    if (isNew) {
      if (accounts.length >= MAX_ACCOUNTS || !Number.isSafeInteger(nextOrdinal + 1)) return false;
      account = {
        id: `account-${nextOrdinal}`, ordinal: nextOrdinal, key, label: labelFor(null, nextOrdinal),
        profileNickname: null, displayName: null, email: null, workspaceName: null, userEdited: false,
        autoLabel: labelFor(null, nextOrdinal), labelSource: 'fallback',
        planType: null, firstSeenAt: seconds, lastSeenAt: seconds, observedAt: null, remainingPercent: null,
        confirmedResetsAt: null, resetSource: null, alertedThrough: 0,
      };
      accounts.push(account); nextOrdinal += 1;
    }
    account.lastSeenAt = seconds;
    account.planType = planType(input.planType) || account.planType;
    const presentation = input.presentation;
    if (presentation && typeof presentation === 'object' && !Array.isArray(presentation) && presentation.key === input.key) {
      // The source/main also bind generation before supplying presentation.
      // Missing or invalid values never erase names verified for this same key.
      account.profileNickname = cleanText(presentation.profileNickname, 96) || account.profileNickname;
      account.displayName = cleanText(presentation.displayName, 96) || account.displayName;
      account.email = emailFor(presentation.email) || account.email;
      account.workspaceName = cleanText(presentation.workspaceName, 96) || account.workspaceName;
    }
    refreshLabel(account);
    const window = selectWindow(input.buckets);
    if (window) {
      account.observedAt = seconds;
      account.remainingPercent = percentage(window.remainingPercent);
      if (account.remainingPercent === null && percentage(window.usedPercent) !== null) {
        account.remainingPercent = 100 - window.usedPercent;
      }
      const reset = timestamp(window.resetsAt);
      // Reject unit mistakes and implausible future deadlines. An observation
      // can arrive just after its boundary, but cannot imply a recurring timer.
      const validReset = reset !== null && reset >= seconds - WINDOW_SECONDS && reset <= seconds + WINDOW_SECONDS + 60;
      if (validReset) {
        const previouslyTracked = account.confirmedResetsAt === reset;
        account.confirmedResetsAt = reset;
        account.resetSource = 'observed';
        // Only a deadline observed while pending creates an alarm. Restoring a
        // previously pending record after sleep/restart is handled by due().
        if (reset <= seconds && !previouslyTracked) account.alertedThrough = Math.max(account.alertedThrough, reset);
      } else if (account.confirmedResetsAt !== null) {
        account.resetSource = 'estimated';
      }
    } else if (account.confirmedResetsAt !== null) {
      account.resetSource = 'estimated';
    }
    this._commit(accounts, nextOrdinal);
    return true;
  }

  snapshot(currentKey, now) {
    const seconds = this._seconds(now), current = fingerprint(currentKey);
    return {
      accounts: this.accounts.map(account => {
        const resetsAt = account.confirmedResetsAt;
        const expired = resetsAt !== null && resetsAt <= seconds;
        return {
          id: account.id, label: account.label, autoLabel: account.autoLabel, labelSource: account.labelSource,
          userEdited: account.userEdited, profileNickname: account.profileNickname,
          displayName: account.displayName, email: account.email, workspaceName: account.workspaceName,
          planType: account.planType,
          planLabel: planLabel(account.planType), scopeLabel: scopeLabel(account.planType), current: !!current && account.key === current,
          firstSeenAt: account.firstSeenAt, lastSeenAt: account.lastSeenAt, observedAt: account.observedAt,
          remainingPercent: expired ? null : account.remainingPercent,
          resetsAt, resetSource: resetsAt === null ? null : account.resetSource,
          status: resetsAt === null ? 'unknown' : expired ? 'awaiting-confirmation' : 'countdown',
          windowDurationMins: WINDOW_MINUTES,
          elapsedPercent: resetsAt === null ? null : Math.max(0, Math.min(100, (seconds - (resetsAt - WINDOW_SECONDS)) / WINDOW_SECONDS * 100)),
        };
      }),
      count: this.accounts.length, maxAccounts: MAX_ACCOUNTS, storageError: this.storageError,
    };
  }

  rename(id, label) {
    if (typeof label !== 'string') return false;
    const account = this.accounts.find(item => item.id === id);
    if (!account) return false;
    const manual = cleanText(label, 32);
    const renamed = refreshLabel({ ...account, ...(manual ? { label: manual } : {}), userEdited: !!manual });
    if (renamed.label === account.label && renamed.labelSource === account.labelSource && renamed.userEdited === account.userEdited) return true;
    this._commit(this.accounts.map(item => item.id === id ? renamed : { ...item }));
    return true;
  }

  remove(id) {
    if (!this.accounts.some(item => item.id === id)) return false;
    this._commit(this.accounts.filter(item => item.id !== id).map(item => ({ ...item })));
    return true;
  }

  nextDueAt() {
    const pending = this.accounts.filter(account => account.confirmedResetsAt !== null && account.confirmedResetsAt > account.alertedThrough);
    return pending.length ? Math.min(...pending.map(account => account.confirmedResetsAt)) * 1000 : null;
  }

  due(now) {
    const seconds = this._seconds(now);
    const pending = this.accounts.filter(account => account.confirmedResetsAt !== null &&
      account.confirmedResetsAt > account.alertedThrough && account.confirmedResetsAt <= seconds)
      .sort((a, b) => a.confirmedResetsAt - b.confirmedResetsAt || a.ordinal - b.ordinal);
    if (!pending.length) return [];
    const ids = new Set(pending.map(account => account.id));
    this._commit(this.accounts.map(account => ids.has(account.id) ?
      { ...account, alertedThrough: Math.max(account.alertedThrough, account.confirmedResetsAt) } : { ...account }));
    return pending.map(account => ({ id: account.id, label: account.label, resetsAt: account.confirmedResetsAt, estimated: true }));
  }
}

module.exports = { AccountRegistry };
