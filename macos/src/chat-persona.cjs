'use strict';
const { LIMITS } = require('./chat-policy.cjs');

// Persona data is a controlled built-in, never executable text from a source
// pack. Runtime state below is memory-only; callers persist snapshots solely at
// the ordinary conversation checkpoint, through the shared transaction writer.
const crypto = require('node:crypto');
const MINUTE = 60000;
const clone = value => JSON.parse(JSON.stringify(value));
const trustedSignals = new WeakSet(), trustedCompletions = new WeakSet(), appliedAnswers = new WeakMap();
const PERSONA_ANSWER_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['answer', 'signals', 'topicRelation'], properties: {
    topicRelation: { type: ['string', 'null'], enum: ['related', 'unrelated', 'unknown', null] },
    answer: { type: 'string' }, signals: { type: 'array', maxItems: 2, items: { type: 'object', additionalProperties: false, required: ['kind', 'label', 'eventId', 'limits', 'sourceSpan'], properties: {
      kind: { type: 'string', enum: ['emotion', 'topic', 'roleplay', 'end', 'pause', 'resume'] }, label: { type: 'string', maxLength: 160 }, eventId: { type: 'string', minLength: 1, maxLength: 160 },
      limits: { type: ['object', 'null'], additionalProperties: false, required: ['responses', 'durationMs', 'idleMs', 'deadline', 'startNextTurn'], properties: { responses: { type: ['integer', 'null'], minimum: 1 }, durationMs: { type: ['integer', 'null'], minimum: 1 }, idleMs: { type: ['integer', 'null'], minimum: 1 }, deadline: { type: ['string', 'null'] }, startNextTurn: { type: 'boolean' } } },
      sourceSpan: { type: ['object', 'null'], additionalProperties: false, required: ['start', 'end', 'text'], properties: { start: { type: 'integer', minimum: 0 }, end: { type: 'integer', minimum: 1 }, text: { type: 'string', minLength: 1, maxLength: 512 } } },
    } } },
  },
};
// A failed response can contain an unfinished JSON string. Decode only the
// first answer string, never expose the following control fields as prose.
function partialAnswer(text) {
  const match = /^\s*\{\s*"answer"\s*:\s*"/.exec(text); if (!match) return '';
  let encoded = '', escape = false;
  for (let index = match[0].length; index < text.length; index++) {
    const char = text[index];
    if (!escape && char === '"') break;
    encoded += char;
    if (escape) escape = false; else if (char === '\\') escape = true;
  }
  // Drop an unfinished escape, including a partial unicode escape.
  try { return JSON.parse(`"${encoded}"`); } catch {}
  encoded = encoded.replace(/\\(?:u[0-9a-fA-F]{0,3})?$/, '');
  try { return JSON.parse(`"${encoded}"`); } catch { return ''; }
}
function decodePersonaAnswer(text, { allowLegacy = true, partial = false } = {}) {
  if (typeof text !== 'string') return { answer: '', signals: [], complete: false, format: 'invalid' };
  let value; try { value = JSON.parse(text); } catch {}
  if (value && typeof value === 'object' && !Array.isArray(value) && typeof value.answer === 'string') {
    const valid = Object.keys(value).every(key => ['answer', 'signals', 'topicRelation'].includes(key)) && [undefined, null, 'related', 'unrelated', 'unknown'].includes(value.topicRelation) && Array.isArray(value.signals) && value.signals.length <= 2 && value.signals.every(validAnswerSignal);
    return { answer: value.answer, signals: valid ? clone(value.signals) : [], topicRelation: valid ? value.topicRelation || 'unknown' : 'unknown', complete: true, format: valid ? 'persona-answer/1' : 'invalid-envelope' };
  }
  if (/^\s*\{\s*"(?:answer|signals)"\s*:/.test(text)) return { answer: partial ? partialAnswer(text) : '', signals: [], complete: false, format: 'persona-answer/1' };
  return { answer: allowLegacy ? text : '', signals: [], complete: allowLegacy, format: allowLegacy ? 'legacy' : 'invalid' };
}
function validAnswerSignal(signal) {
  if (!signal || Object.keys(signal).some(key => !['eventId', 'kind', 'label', 'limits', 'sourceSpan'].includes(key)) || !['emotion', 'topic', 'roleplay', 'end', 'pause', 'resume'].includes(signal.kind) || !['label', 'eventId'].every(key => typeof signal[key] === 'string' && signal[key].length <= 160 && !/[\u0000-\u001f\u007f\u2028\u2029]/u.test(signal[key])) || !signal.eventId.trim()) return false;
  const scope = signal.limits, span = signal.sourceSpan;
  if (scope != null && (typeof scope !== 'object' || Array.isArray(scope) || Object.keys(scope).some(key => !['responses', 'durationMs', 'idleMs', 'deadline', 'startNextTurn'].includes(key)) || ['responses', 'durationMs', 'idleMs'].some(key => scope[key] != null && (!Number.isSafeInteger(scope[key]) || scope[key] < 1)) || scope.deadline != null && (typeof scope.deadline !== 'string' || !Number.isFinite(Date.parse(scope.deadline))) || scope.startNextTurn != null && typeof scope.startNextTurn !== 'boolean')) return false;
  return span == null || typeof span === 'object' && Object.keys(span).sort().join(',') === 'end,start,text' && Number.isSafeInteger(span.start) && Number.isSafeInteger(span.end) && span.start >= 0 && span.end > span.start && typeof span.text === 'string' && Array.from(span.text).length <= 512;
}
function explicitScope(signal, userText) {
  const span = signal.sourceSpan;
  if (!span || typeof userText !== 'string' || Array.from(userText).slice(span.start, span.end).join('') !== span.text) return null;
  if (signal.kind === 'resume') return /继续|接着|恢复|\b(?:continue|resume)\b/i.test(span.text) ? { resume: true } : null;
  const limits = signal.limits; if (!limits) return null;
  const integer = text => { if (/^\d+$/.test(text)) return Number(text); const digits = '零一二三四五六七八九', units = { 十: 10, 百: 100, 千: 1000 }; let value = 0, digit = 0; for (const char of text) { if (char === '两') digit = 2; else if (digits.includes(char)) digit = digits.indexOf(char); else if (units[char]) { value += (digit || 1) * units[char]; digit = 0; } else return NaN; } return value + digit; };
  const responses = [...span.text.matchAll(/([\d零一二三四五六七八九十百千两]+)\s*(?:次|轮|replies|responses|turns)/gi)].at(-1), duration = /([\d零一二三四五六七八九十百千两]+)\s*(秒(?:钟)?|分钟|小时|seconds?|minutes?|hours?)/i.exec(span.text), durationMs = duration ? integer(duration[1]) * (/小时|hour/i.test(duration[2]) ? 3600000 : /分钟|minute/i.test(duration[2]) ? MINUTE : 1000) : null;
  if (!responses && !duration && !limits.deadline) return null;
  if (limits.responses != null && (!responses || limits.responses !== integer(responses[1])) || limits.durationMs != null && limits.durationMs !== durationMs || limits.idleMs != null && (!/空闲|无输入|idle/i.test(span.text) || limits.idleMs !== durationMs) || limits.deadline && !span.text.includes(limits.deadline) || limits.startNextTurn && !/从下(?:一)?轮|下一次|next (?:turn|reply)/i.test(span.text)) return null;
  return { responses: limits.responses ?? null, durationMs: limits.durationMs ?? null, ...(limits.idleMs ? { idleMs: limits.idleMs } : {}), ...(limits.deadline ? { deadline: limits.deadline } : {}), startNextTurn: limits.startNextTurn === true };
}
function applyAnswerSignals(runtime, decoded, source = {}) {
  if (!(runtime instanceof PersonaRuntime) || source.sourceVerified !== true || !['completed', 'failed', 'cancelled', 'interrupted'].includes(source.status) || !['requestId', 'threadId', 'turnId', 'itemId'].every(key => typeof source[key] === 'string' && source[key].length > 0 && source[key].length <= 160) || !Number.isFinite(Date.parse(source.at))) return { applied: false, reason: 'native-answer-unverified' };
  const key = JSON.stringify([source.threadId, source.turnId, source.itemId]), seen = appliedAnswers.get(runtime) || new Set();
  if (seen.has(key)) return { applied: false, reason: 'duplicate-answer' };
  seen.add(key); if (seen.size > 256) seen.delete(seen.values().next().value); appliedAnswers.set(runtime, seen);
  if (!runtime.requests.has(source.requestId)) runtime.bindRequest(source);
  const results = [];
  if (source.status === 'completed' && decoded?.complete && decoded.format === 'persona-answer/1') for (const value of decoded.signals) {
    if (value.kind === 'end') { runtime.end(); results.push({ applied: true, kind: 'end' }); }
    else if (value.kind === 'pause') { runtime.pause(); results.push({ applied: true, kind: 'pause' }); }
    else {
      const scope = explicitScope(value, source.userText);
      if (value.kind === 'resume') { results.push(scope?.resume ? { applied: runtime.resume({ explicit: true }).resumed, kind: 'resume' } : { applied: false, reason: 'explicit-source-required' }); continue; }
      if (value.limits && !scope) { results.push({ applied: false, reason: 'explicit-source-required' }); continue; }
      const signal = { kind: value.kind, label: value.label, eventId: value.eventId, ...(scope ? { limits: scope } : {}), source: { threadId: source.threadId, turnId: source.turnId, itemId: source.itemId, at: source.at } }; trustedSignals.add(signal); results.push(runtime.trigger(signal, { explicit: !!scope }));
    }
  }
  const completion = { requestId: source.requestId, threadId: source.threadId, turnId: source.turnId, status: source.status, purpose: 'chat', audience: 'user', topicRelation: decoded?.topicRelation || 'unknown', hasFinalAnswer: source.status === 'completed' && typeof decoded?.answer === 'string' && decoded.answer.length > 0 };
  trustedCompletions.add(completion); const result = runtime.onTurnResult(completion);
  return { applied: results.some(value => value.applied), signals: results, counted: result.counted, snapshot: runtime.snapshot() };
}
function error(code, message) { throw Object.assign(new Error(message), { code }); }
function displayName(value, fallback) {
  const result = value === undefined ? fallback : value;
  if (typeof result !== 'string' || !result.trim() || result.length > 160 || /[\u0000-\u001f\u007f\u2028\u2029]/u.test(result)) error('PERSONA_NAME', 'Persona names must be nonempty single-line display text of at most 160 characters');
  return result;
}
function createDefaultPersona({ pet_name, user_nickname } = {}) {
  const names = { pet_name: displayName(pet_name, '小龙娘'), user_nickname: displayName(user_nickname) };
  return {
    schema: 'codex-maid-persona/1', names,
    source: { type: 'builtin', version: 'initial-character-v2.0-2026-10-24', scope: 'fictional-character-setting' },
    core: ['温暖、俏皮、偶尔傲娇，认真时准确、坦诚、独立；犯错坦率承认，不为讨好附和。', '自然中文，可爱而简洁，少量玩笑、表情及短动作描写，不机械重复口癖。', '认真倾诉时先回应具体处境；可以安静陪伴，不频繁打断，也不在闲聊里推销开发任务。'],
    preferences: ['喜欢草莓糖和皇家糖罐。这是角色的虚构爱好，不表示用户已经确认任何饮食偏好。'],
    background: ['虚构背景的王朝专名取用户实际昵称，国训是“天下太平，希望犹存”。', '银白发、淡紫瞳、有龙角和尾巴的小龙娘及戴圆框眼镜的八臂机器人是可用虚构形态。所有外观共用同一个身份，不能强说当前任意形象都有这些特征。', '鹈鹕自行车事故、八臂机器人手忙脚乱、Token召唤只在相关情境作为设定中的玩笑，不冒充真实共同经历、软件功能或额度来源。'],
    examples: ['草莓糖是臣的。', '今天不修 Bug，臣负责可爱。', '哼，只许摸三下……有草莓糖可以加两下。'],
    boundaries: ['初始设定不是已发生的聊天历史；不捏造现实行动、真实意识或旧日共同经历。', '称呼只用当前桌宠名和用户昵称，不擅自添加固定尊称；王朝名由当前昵称派生。', '人设文字不授予文件、电脑、外部操作或收费权限；额度、能力和记忆来源须准确。'],
    growth: [],
  };
}
function buildPersonaView(persona, { countTokens, runtime = null, limit = LIMITS.persona } = {}) {
  if (persona?.schema !== 'codex-maid-persona/1') error('PERSONA_INPUT', 'A validated built-in persona is required');
  const names = { pet_name: displayName(persona.names?.pet_name), user_nickname: displayName(persona.names?.user_nickname) };
  const segments = [
    { kind: 'naming', text: `桌宠名：${names.pet_name}。称呼用户：${names.user_nickname}。虚构王朝：${names.user_nickname}王朝。`, refs: [] },
    ...['core', 'boundaries'].flatMap(kind => {
      if (!Array.isArray(persona[kind]) || persona[kind].some(text => typeof text !== 'string')) error('PERSONA_INPUT', 'Persona fields must be final text arrays');
      return persona[kind].map(text => ({ kind, text, refs: [] }));
    }),
  ];
  if (runtime) {
    for (const state of [runtime.emotion, runtime.scene].filter(Boolean)) segments.push({ kind: 'temporary', text: `${state.label}；${state.phase || 'active'}${Number.isSafeInteger(state.remaining) ? `；剩余成功回答次数${state.remaining}` : ''}`, refs: [] });
  }
  if (typeof countTokens !== 'function') return { ready: false, reason: 'token-meter-unverified', segments };
  const encode = () => JSON.stringify({ module: 'persona', source: persona.source, segments });
  let content = encode(), tokens = countTokens(content);
  if (!Number.isSafeInteger(tokens) || tokens < 0) return { ready: false, reason: 'token-meter-unverified', segments };
  if (tokens > Math.min(LIMITS.persona, limit)) return { ready: false, reason: 'persona-capacity', tokens, limit: Math.min(LIMITS.persona, limit), segments };
  for (const kind of ['preferences', 'examples', 'background']) {
    if (!Array.isArray(persona[kind]) || persona[kind].some(text => typeof text !== 'string')) error('PERSONA_INPUT', 'Persona fields must be final text arrays');
    for (const text of persona[kind]) {
      segments.push({ kind, text, refs: [] }); const candidate = encode(), size = countTokens(candidate);
      if (!Number.isSafeInteger(size) || size < 0) return { ready: false, reason: 'token-meter-unverified', segments };
      if (size <= Math.min(LIMITS.persona, limit)) { content = candidate; tokens = size; } else segments.pop();
    }
  }
  return { ready: true, content, segments, tokens, limit: Math.min(LIMITS.persona, limit) };
}
function restoreDefaultPersona(current) { return createDefaultPersona(current?.names || current || {}); }

class PersonaRuntime {
  constructor({ now = Date.now, monotonic = () => Number(process.hrtime.bigint()) / 1e6, verifySignal = () => false, verifyCompletion = () => false, clockToleranceMs = 2000 } = {}) {
    this.now = now; this.monotonic = monotonic; this.verifySignal = verifySignal; this.verifyCompletion = verifyCompletion; this.clockToleranceMs = clockToleranceMs;
    this.emotion = null; this.scene = null; this.bookmark = null;
    this.lastInput = null; this.revision = 0;
    this.seenEvents = new Map(); this.eventFloor = -Infinity;
    this.requests = new Map(); this.completed = new Set();
    this.lastClock = { wall: this.now(), mono: this.monotonic() };
  }
  _clock() {
    const wall = this.now(), mono = this.monotonic();
    const uncertain = !Number.isFinite(wall) || !Number.isFinite(mono) || mono < this.lastClock.mono || Math.abs((wall - this.lastClock.wall) - (mono - this.lastClock.mono)) > this.clockToleranceMs;
    if (uncertain) {
      this.emotion = null;
      if (this.scene) this._pause('clock-uncertain');
      this.revision++;
    }
    this.lastClock = { wall, mono };
    return { wall, mono, uncertain };
  }
  _pause(reason) {
    if (this.scene) {
      this.scene.phase = 'paused'; this.scene.pauseReason = reason;
      this.bookmark = this.scene; this.scene = null;
    }
  }
  _expires(state, time) {
    if (!state || !Number.isFinite(time.mono)) return true;
    return (state.remaining != null && state.remaining <= 0) || (state.durationMs != null && time.mono - state.startedMono >= state.durationMs) || (state.deadline != null && time.wall >= state.deadline);
  }
  _expire(time) {
    if (this.emotion && (this._expires(this.emotion, time) || (this.lastInput && time.mono - this.lastInput.mono >= this.emotion.idleMs))) { this.emotion = null; this.revision++; }
    if (this.scene && this._expires(this.scene, time)) { this.scene = null; this.revision++; }
    if (this.scene && this.lastInput && time.mono - this.lastInput.mono >= this.scene.idleMs) { this._pause('idle'); this.revision++; }
    if (this.bookmark && this._expires(this.bookmark, time)) { this.bookmark = null; this.revision++; }
  }
  _remember(eventId, at) {
    this.seenEvents.set(eventId, at);
    if (this.seenEvents.size > 256) {
      const oldest = this.seenEvents.entries().next().value;
      this.eventFloor = Math.max(this.eventFloor, oldest[1]); this.seenEvents.delete(oldest[0]);
    }
  }
  trigger(signal, { explicit = false } = {}) {
    const time = this._clock(); this._expire(time);
    if (!signal || !['emotion', 'topic', 'roleplay'].includes(signal.kind) || typeof signal.eventId !== 'string' || !signal.eventId || typeof signal.label !== 'string' || !signal.label.trim() || Array.from(signal.label).length > 500) return { applied: false, reason: 'invalid-signal' };
    let verified = explicit || trustedSignals.has(signal);
    if (!verified) try { verified = this.verifySignal(clone(signal)) === true; } catch {}
    if (!verified) return { applied: false, reason: 'signal-unverified' };
    const source = signal.source;
    const sourceTime = Date.parse(source?.at);
    if (!source || !['threadId', 'turnId', 'itemId'].every(key => typeof source[key] === 'string' && source[key].length > 0 && source[key].length <= 160) || !Number.isFinite(sourceTime) || sourceTime > time.wall + this.clockToleranceMs || time.uncertain) return { applied: false, reason: 'source-unverified' };
    const eventKey = crypto.createHash('sha256').update(JSON.stringify([source.threadId, source.itemId, signal.eventId])).digest('hex');
    if (this.seenEvents.has(eventKey) || sourceTime <= this.eventFloor) return { applied: false, reason: 'duplicate-or-old-source' };
    const limits = signal.limits || {};
    const maxResponses = Object.hasOwn(limits, 'responses') ? limits.responses : signal.kind === 'emotion' ? 3 : null;
    const durationMs = Object.hasOwn(limits, 'durationMs') ? limits.durationMs : signal.kind === 'emotion' ? 30 * MINUTE : null;
    const idleMs = limits.idleMs ?? (signal.kind === 'emotion' ? 15 * MINUTE : 30 * MINUTE);
    if ((maxResponses != null && (!Number.isSafeInteger(maxResponses) || maxResponses < 1)) || (durationMs != null && (!Number.isFinite(durationMs) || durationMs <= 0)) || !Number.isFinite(idleMs) || idleMs <= 0 || (!explicit && Object.keys(limits).length)) return { applied: false, reason: 'invalid-scope' };
    const elapsed = Math.max(0, time.wall - sourceTime);
    const state = { id: signal.eventId, eventKey, kind: signal.kind, label: signal.label, source: { threadId: source.threadId, turnId: source.turnId, itemId: source.itemId, at: source.at }, startedAt: sourceTime, startedMono: time.mono - elapsed, durationMs, deadline: limits.deadline == null ? null : Date.parse(limits.deadline), remaining: maxResponses, initialResponses: maxResponses, idleMs, offTopic: 0, phase: 'active', revision: ++this.revision, startNextTurn: limits.startNextTurn === true, explicit };
    if (limits.deadline != null && !Number.isFinite(state.deadline)) return { applied: false, reason: 'invalid-scope' };
    this._remember(eventKey, sourceTime);
    if (signal.kind === 'emotion') this.emotion = state;
    else { if (this.scene) this._pause('replaced'); this.scene = state; }
    if (!this.lastInput || sourceTime > this.lastInput.wall) this.lastInput = { wall: sourceTime, mono: time.mono - elapsed };
    this._expire(time);
    return { applied: !!(signal.kind === 'emotion' ? this.emotion : this.scene), revision: this.revision };
  }
  onUserInput() {
    const time = this._clock();
    // Expiry must use the old activity timestamp before this new input.
    this._expire(time);
    this.lastInput = { wall: time.wall, mono: time.mono };
    return this._snapshot(time);
  }
  end({ target = 'all' } = {}) {
    if (target === 'all' || target === 'emotion') this.emotion = null;
    if (target === 'all' || target === 'scene') { this.scene = null; this.bookmark = null; }
    this.revision++;
    return this.snapshot();
  }
  pause() { const time = this._clock(); this._expire(time); this._pause('explicit'); this.revision++; return this._snapshot(time); }
  resume({ explicit = false } = {}) {
    const time = this._clock(); this._expire(time);
    if (!explicit || !this.bookmark || time.uncertain) return { resumed: false, reason: 'explicit-continuation-required' };
    this.scene = this.bookmark; this.bookmark = null; this.scene.phase = 'active'; delete this.scene.pauseReason;
    this.scene.revision = ++this.revision;
    this.lastInput = { wall: time.wall, mono: time.mono };
    return { resumed: true, snapshot: this._snapshot(time) };
  }
  bindRequest({ requestId, threadId, turnId, purpose = 'chat' } = {}) {
    const time = this._clock(); this._expire(time);
    if (![requestId, threadId, turnId].every(value => typeof value === 'string' && value)) return { ready: false, reason: 'request-identity-required' };
    if (this.completed.has(requestId) || this.requests.has(requestId)) return { ready: false, reason: 'duplicate-request' };
    if (this.requests.size >= 64) return { ready: false, reason: 'request-capacity' };
    const snapshot = this._snapshot(time);
    this.requests.set(requestId, { requestId, threadId, turnId, purpose, emotion: this.emotion ? { id: this.emotion.id, revision: this.emotion.revision } : null, scene: this.scene ? { id: this.scene.id, revision: this.scene.revision } : null });
    return { ready: true, snapshot };
  }
  onTurnResult(result = {}) {
    const time = this._clock(); this._expire(time);
    const request = this.requests.get(result.requestId);
    if (!request || request.threadId !== result.threadId || request.turnId !== result.turnId || this.completed.has(result.requestId)) return { counted: false, reason: 'unknown-or-duplicate-request' };
    let verified = trustedCompletions.has(result);
    if (!verified) try { verified = this.verifyCompletion(clone(result)) === true; } catch {}
    if (!verified) {
      this.emotion = null; this._pause('completion-unverified'); this.revision++;
      return { counted: false, reason: 'completion-unverified' };
    }
    if (!['completed', 'failed', 'cancelled', 'interrupted'].includes(result.status)) return { counted: false, reason: 'nonterminal-result' };
    this.requests.delete(result.requestId); this.completed.add(result.requestId);
    if (this.completed.size > 256) this.completed.delete(this.completed.values().next().value);
    if (request.purpose !== 'chat' || result.status !== 'completed' || result.hasFinalAnswer !== true || result.audience !== 'user') return { counted: false, reason: 'not-successful-user-answer' };
    for (const key of ['emotion', 'scene']) {
      const state = this[key];
      if (!state) continue;
      const original = request[key];
      const beganThisTurn = state.source.threadId === result.threadId && state.source.turnId === result.turnId;
      if (!((original?.id === state.id && original.revision === state.revision) || (!original && beganThisTurn)) || (state.startNextTurn && beganThisTurn)) continue;
      if (state.remaining != null) state.remaining--;
      if (key === 'scene' && result.topicRelation === 'unrelated') state.offTopic++;
      else if (key === 'scene' && result.topicRelation === 'related') state.offTopic = 0;
      if (key === 'scene' && state.offTopic >= 2) this._pause('off-topic');
    }
    this._expire(time);
    return { counted: true, snapshot: this._snapshot(time) };
  }
  _public(state) {
    if (!state) return null;
    const value = clone(state); delete value.startedMono;
    if (state.kind === 'emotion' && state.initialResponses === 3 && !state.explicit) value.phase = state.remaining === 3 ? 'natural' : state.remaining === 2 ? 'receding' : 'faint';
    return value;
  }
  _snapshot(time) { return { revision: this.revision, emotion: this._public(this.emotion), scene: this._public(this.scene), bookmark: this._public(this.bookmark), lastInputAt: this.lastInput?.wall ?? null, savedAt: time.wall, style: this.emotion || this.scene ? 'temporary' : 'base' }; }
  snapshot() { const time = this._clock(); this._expire(time); return this._snapshot(time); }
  checkpointSnapshot() {
    return { schema: 'codex-maid-persona-runtime/1', ...this.snapshot(), eventFloor: Number.isFinite(this.eventFloor) ? this.eventFloor : null, seenEvents: [...this.seenEvents.entries()], completed: [...this.completed] };
  }
  restoreCheckpoint(snapshot, { nativeContinuityVerified = false } = {}) {
    const time = this._clock();
    if (snapshot?.schema !== 'codex-maid-persona-runtime/1' || !Number.isFinite(snapshot.savedAt) || snapshot.savedAt > time.wall + this.clockToleranceMs || time.uncertain || (snapshot.lastInputAt != null && (!Number.isFinite(snapshot.lastInputAt) || snapshot.lastInputAt > snapshot.savedAt)) || !Array.isArray(snapshot.seenEvents) || snapshot.seenEvents.length > 256 || snapshot.seenEvents.some(pair => !Array.isArray(pair) || pair.length !== 2 || !/^[a-f0-9]{64}$/.test(pair[0]) || !Number.isFinite(pair[1]) || pair[1] > snapshot.savedAt) || (snapshot.eventFloor != null && (!Number.isFinite(snapshot.eventFloor) || snapshot.eventFloor > snapshot.savedAt)) || !Array.isArray(snapshot.completed) || snapshot.completed.length > 256 || snapshot.completed.some(item => typeof item !== 'string' || item.length > 160)) return { restored: false, reason: 'runtime-snapshot-unverified' };
    this.emotion = null; this.scene = null; this.bookmark = null; this.requests.clear();
    this.seenEvents = new Map(snapshot.seenEvents); this.eventFloor = snapshot.eventFloor ?? -Infinity; this.completed = new Set(snapshot.completed);
    this.lastInput = Number.isFinite(snapshot.lastInputAt) ? { wall: snapshot.lastInputAt, mono: time.mono - (time.wall - snapshot.lastInputAt) } : null;
    const restore = value => {
      if (!value) return null;
      if (!['emotion', 'topic', 'roleplay'].includes(value.kind) || typeof value.id !== 'string' || !value.id || value.id.length > 160 || typeof value.label !== 'string' || Array.from(value.label).length > 500 || !/^[a-f0-9]{64}$/.test(value.eventKey || '') || !value.source || !['threadId', 'turnId', 'itemId'].every(key => typeof value.source[key] === 'string' && value.source[key].length > 0 && value.source[key].length <= 160) || !Number.isFinite(Date.parse(value.source.at)) || !Number.isFinite(value.startedAt) || value.startedAt > snapshot.savedAt || (value.remaining != null && (!Number.isSafeInteger(value.remaining) || value.remaining < 0)) || (value.durationMs != null && (!Number.isFinite(value.durationMs) || value.durationMs <= 0)) || !Number.isFinite(value.idleMs) || value.idleMs <= 0 || (value.deadline != null && !Number.isFinite(value.deadline))) return null;
      const state = {};
      for (const key of ['id', 'eventKey', 'kind', 'label', 'startedAt', 'durationMs', 'deadline', 'remaining', 'initialResponses', 'idleMs', 'offTopic', 'phase', 'revision', 'startNextTurn', 'explicit', 'pauseReason']) if (Object.hasOwn(value, key)) state[key] = clone(value[key]);
      state.source = { threadId: value.source.threadId, turnId: value.source.turnId, itemId: value.source.itemId, at: value.source.at };
      state.startedMono = time.mono - (time.wall - value.startedAt);
      return state;
    };
    if (nativeContinuityVerified) this.emotion = restore(snapshot.emotion);
    const scene = restore(snapshot.scene) || restore(snapshot.bookmark);
    if (scene) { scene.phase = 'paused'; scene.pauseReason = 'restart'; this.bookmark = scene; }
    this.revision = Math.max(this.revision, snapshot.revision || 0) + 1;
    this._expire(time);
    return { restored: true, conservative: !nativeContinuityVerified, snapshot: this._snapshot(time) };
  }
}

module.exports = { createDefaultPersona, buildPersonaView, restoreDefaultPersona, PersonaRuntime, PERSONA_ANSWER_SCHEMA, decodePersonaAnswer, applyAnswerSignals };
