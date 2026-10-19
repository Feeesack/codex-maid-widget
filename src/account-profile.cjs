'use strict';

// Pure display-data projection. This module never reads credentials, files,
// browser storage or chat content, and performs no network requests.
function displayText(value) {
  if (typeof value !== 'string' || value.length > 512) return null;
  const text = value.normalize('NFC').replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2066-\u206f\ufeff]/g, '').trim();
  if (!text || Array.from(text).length > 96) return null;
  if (/\b(?:Bearer|Basic)\s+\S|\bsk-[A-Za-z0-9_-]{12,}|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}|\b(?:access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key)\s*[:=]/i.test(text)) return null;
  return text;
}

function profileNickname(payload, kind = 'profile-summary') {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  // These are the actual profile nickname fields. Account name, email and
  // profile.username (@handle) are intentionally never used as substitutes.
  const value = kind === 'profile-page' ? payload.profile_details?.display_name
    : kind === 'profile-summary' ? payload.profile?.display_name : null;
  return displayText(value);
}

function workspaceName(payload, scopeId) {
  if (!payload || typeof payload !== 'object' || typeof scopeId !== 'string' ||
      !/^[a-zA-Z0-9_-]{1,160}$/.test(scopeId)) return null;
  const accounts = payload.accounts;
  if (!accounts || typeof accounts !== 'object') return null;
  // The desktop /wham/accounts/check DTO is a flat array keyed by `id`.
  // Older ChatGPT accounts/check responses use a map of { account } records.
  const entries = Array.isArray(accounts) ? accounts : Object.values(accounts).map(value => value?.account);
  if (entries.length > 100) return null;
  const matched = entries.filter(account => account && typeof account === 'object' &&
    (Array.isArray(accounts) ? account.id === scopeId : account.account_id === scopeId));
  if (matched.length !== 1 || typeof matched[0].structure !== 'string' || matched[0].structure === 'personal') return null;
  return displayText(matched[0].name);
}

function projectProfileMetadata({ profile, profileKind, accounts, scopeId } = {}) {
  return { profileNickname: profileNickname(profile, profileKind), workspaceName: workspaceName(accounts, scopeId) };
}

module.exports = { profileNickname, workspaceName, projectProfileMetadata };
