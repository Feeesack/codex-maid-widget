'use strict';
const MAX_DEPTH = 128;
const MAX_KEY = 128;
const whitespace = character => character === ' ' || character === '\t' || character === '\r' || character === '\n';
const nonblank = character => !/\s/u.test(character);

// No summary, response ID, history or other value string is retained. The only
// decoded string held across chunks is an object key, bounded to 128 units.
function createEnvelope() {
  return { utf8Carry: [], stack: [], root: 'value', token: null, invalid: false, finished: false,
    responseIdPresent: false, responseIdNonempty: false, messageNonempty: false };
}

function completeValue(state) {
  const parent = state.stack[state.stack.length - 1];
  if (!parent) { state.root = 'done'; return; }
  if (parent.expect !== 'value' && parent.expect !== 'valueOrEnd') { state.invalid = true; return; }
  parent.expect = 'commaOrEnd'; parent.key = null;
}

function targetForValue(state) {
  const parent = state.stack[state.stack.length - 1];
  if (!parent) return { role: 'root', target: null };
  if (parent.role === 'root' && parent.kind === 'object' && parent.key === 'payload') {
    state.responseIdPresent = false; state.responseIdNonempty = false; state.messageNonempty = false;
    return { role: 'payload', target: null };
  }
  if (parent.role === 'payload' && parent.kind === 'object') {
    if (parent.key === 'compaction_response_id') {
      state.responseIdPresent = true; state.responseIdNonempty = false;
      return { role: 'other', target: 'response' };
    }
    if (parent.key === 'message') {
      state.messageNonempty = false;
      return { role: 'other', target: 'message' };
    }
  }
  return { role: 'other', target: null };
}

function stringCharacter(state, token, character) {
  if (token.key) {
    if (token.text.length + character.length > MAX_KEY) state.invalid = true;
    else token.text += character;
  } else if (token.target && nonblank(character)) token.nonempty = true;
}

function startString(state, key, target = null) {
  state.token = { kind: 'string', key, target, text: '', nonempty: false, escape: false, unicode: null };
}

function consumeString(state, character) {
  const token = state.token;
  if (token.unicode !== null) {
    if (!/^[0-9a-f]$/i.test(character)) { state.invalid = true; return; }
    token.unicode += character;
    if (token.unicode.length === 4) {
      stringCharacter(state, token, String.fromCharCode(parseInt(token.unicode, 16)));
      token.unicode = null;
    }
    return;
  }
  if (token.escape) {
    token.escape = false;
    if (character === 'u') { token.unicode = ''; return; }
    const escapes = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
    if (!Object.hasOwn(escapes, character)) { state.invalid = true; return; }
    stringCharacter(state, token, escapes[character]); return;
  }
  if (character === '\\') { token.escape = true; return; }
  if (character === '"') {
    state.token = null;
    if (token.key) {
      const parent = state.stack[state.stack.length - 1];
      parent.key = token.text; parent.expect = 'colon';
    } else {
      if (token.target === 'response') state.responseIdNonempty = token.nonempty;
      if (token.target === 'message') state.messageNonempty = token.nonempty;
      completeValue(state);
    }
    return;
  }
  if (character.charCodeAt(0) < 32) { state.invalid = true; return; }
  stringCharacter(state, token, character);
}

function numberCharacter(token, character) {
  const digit = /^[0-9]$/.test(character);
  switch (token.phase) {
    case 'sign': if (!digit) return -1; token.phase = character === '0' ? 'zero' : 'int'; return 1;
    case 'zero': if (digit) return -1; break;
    case 'int': if (digit) return 1; break;
    case 'dot': if (!digit) return -1; token.phase = 'frac'; return 1;
    case 'frac': if (digit) return 1; break;
    case 'exp': if (character === '+' || character === '-') { token.phase = 'expSign'; return 1; }
      if (!digit) return -1; token.phase = 'expDigits'; return 1;
    case 'expSign': if (!digit) return -1; token.phase = 'expDigits'; return 1;
    case 'expDigits': if (digit) return 1; return 0;
  }
  if (character === '.' && ['zero', 'int'].includes(token.phase)) { token.phase = 'dot'; return 1; }
  if ((character === 'e' || character === 'E') && ['zero', 'int', 'frac'].includes(token.phase)) { token.phase = 'exp'; return 1; }
  return 0;
}

function startValue(state, character) {
  const { role, target } = targetForValue(state);
  if (character === '{' || character === '[') {
    if (state.stack.length >= MAX_DEPTH) { state.invalid = true; return; }
    state.stack.push({ kind: character === '{' ? 'object' : 'array', role,
      expect: character === '{' ? 'keyOrEnd' : 'valueOrEnd', key: null });
  } else if (character === '"') startString(state, false, target);
  else if (character === '-' || /^[0-9]$/.test(character)) {
    state.token = { kind: 'number', phase: character === '-' ? 'sign' : character === '0' ? 'zero' : 'int' };
  } else if (['t', 'f', 'n'].includes(character)) {
    state.token = { kind: 'literal', word: character === 't' ? 'true' : character === 'f' ? 'false' : 'null', index: 1 };
  } else state.invalid = true;
}

function consumeText(state, text) {
  for (const character of text) {
    if (state.invalid) return;
    const token = state.token;
    if (token?.kind === 'string') { consumeString(state, character); continue; }
    if (token?.kind === 'literal') {
      if (character !== token.word[token.index++]) { state.invalid = true; continue; }
      if (token.index === token.word.length) { state.token = null; completeValue(state); }
      continue;
    }
    if (token?.kind === 'number') {
      const consumed = numberCharacter(token, character);
      if (consumed < 0) { state.invalid = true; continue; }
      if (consumed) continue;
      state.token = null; completeValue(state);
    }
    if (whitespace(character)) continue;
    const parent = state.stack[state.stack.length - 1];
    if (!parent) {
      if (state.root === 'done') state.invalid = true;
      else startValue(state, character);
      continue;
    }
    if (parent.expect === 'colon') {
      if (character !== ':') state.invalid = true; else parent.expect = 'value';
    } else if (parent.expect === 'commaOrEnd') {
      if (character === ',') parent.expect = parent.kind === 'object' ? 'key' : 'value';
      else if (character === (parent.kind === 'object' ? '}' : ']')) { state.stack.pop(); completeValue(state); }
      else state.invalid = true;
    } else if (parent.expect === 'key' || parent.expect === 'keyOrEnd') {
      if (character === '"') startString(state, true);
      else if (parent.expect === 'keyOrEnd' && character === '}') { state.stack.pop(); completeValue(state); }
      else state.invalid = true;
    } else if (parent.expect === 'valueOrEnd' && character === ']') { state.stack.pop(); completeValue(state); }
    else startValue(state, character);
  }
}

function consumeEnvelope(state, buffer) {
  if (state.finished || state.invalid) return;
  // Plain data survives the counter's structuredClone cache snapshots. Hold at
  // most three undecoded UTF-8 bytes, never a summary or other value string.
  const bytes = state.utf8Carry.length ? Buffer.concat([Buffer.from(state.utf8Carry), buffer]) : buffer;
  let lead = bytes.length - 1;
  while (lead >= 0 && bytes.length - lead <= 4 && (bytes[lead] & 0xc0) === 0x80) lead--;
  const first = bytes[lead];
  const expected = first >= 0xc2 && first <= 0xdf ? 2 : first >= 0xe0 && first <= 0xef ? 3 : first >= 0xf0 && first <= 0xf4 ? 4 : 0;
  const incomplete = expected > bytes.length - lead;
  const end = incomplete ? lead : bytes.length;
  state.utf8Carry = incomplete ? Array.from(bytes.subarray(lead)) : [];
  consumeText(state, bytes.subarray(0, end).toString('utf8'));
}

function finishEnvelope(state) {
  if (!state.finished) {
    if (state.utf8Carry.length) consumeText(state, Buffer.from(state.utf8Carry).toString('utf8'));
    state.utf8Carry = [];
    if (state.token?.kind === 'number' && ['zero', 'int', 'frac', 'expDigits'].includes(state.token.phase)) {
      state.token = null; completeValue(state);
    }
    state.finished = true;
  }
  const valid = !state.invalid && !state.token && state.stack.length === 0 && state.root === 'done';
  return { valid, responseIdPresent: valid && state.responseIdPresent,
    responseIdNonempty: valid && state.responseIdNonempty, messageNonempty: valid && state.messageNonempty };
}

module.exports = { createEnvelope, consumeEnvelope, finishEnvelope };
