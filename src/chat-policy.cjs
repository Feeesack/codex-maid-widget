'use strict';

// Pure policy. A byte count is never presented as a token count. The caller must
// supply a tokenizer verified for the actual model before using token budgets.
const LIMITS = Object.freeze({ body: 400000, bytes: 1048576, turns: 1200,
  soft: 0.90, hard: 0.95, node: 20000, root: 40000, leafPrime: 5000, sourceBatch: 30000, children: 4,
  parentInput: 80000, persona: 10000, views: 10000, handoff: 5000,
  handoffSummary: 3000, handoffOriginal: 2000, growth: 8000, search: 3000 });
const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'interrupted']);
function finite(value) { return Number.isFinite(value) && value >= 0; }
function tokens(content, countTokens) {
  if (typeof countTokens !== 'function') throw new Error('CHAT_TOKENIZER_UNVERIFIED');
  const count = countTokens(typeof content === 'string' ? content : JSON.stringify(content));
  if (!Number.isSafeInteger(count) || count < 0) throw new Error('CHAT_TOKEN_COUNT_INVALID');
  return count;
}
function within(content, limit, countTokens) {
  const size = tokens(content, countTokens);
  if (size > limit) throw new Error('CHAT_CONTENT_BUDGET_EXCEEDED');
  return size;
}

class SessionBudget {
  constructor({ threadId, countTokens, state } = {}) {
    if (typeof threadId !== 'string' || !threadId) throw new Error('CHAT_THREAD_REQUIRED');
    this.threadId = threadId; this.countTokens = countTokens;
    this.body = state?.body ?? 0; this.bytes = state?.bytes ?? 0;
    this.turns = state?.turns ?? 0;
    if (![this.body, this.bytes, this.turns].every(finite)) throw new Error('CHAT_BUDGET_STATE_INVALID');
    this.messages = new Set(state?.messages || []); this.completed = new Set(state?.completed || []);
    this.compactions = new Set(state?.compactions || []); this.reasons = new Set(state?.reasons || []);
    // A newly available meter cannot retroactively meter an earlier unknown
    // segment. Preserve the byte/turn fallback until the whole source is recounted.
    this.bodyReliable = typeof countTokens === 'function' && (!state || state.bodyUnit === 'tokens' && state.bodyReliable !== false);
    this.observation = null;
  }
  addMessage({ threadId, id, text }) {
    if (threadId !== this.threadId) return false;
    if (typeof id !== 'string' || !id || typeof text !== 'string') throw new Error('CHAT_MESSAGE_INVALID');
    if (this.messages.has(id)) return false;
    const count = this.countTokens ? tokens(text, this.countTokens) : null;
    this.messages.add(id); this.bytes += Buffer.byteLength(text, 'utf8');
    if (count !== null) this.body += count;
    this.check(); return true;
  }
  complete({ threadId, turnId, status }) {
    if (threadId !== this.threadId || status !== 'completed') return false;
    if (typeof turnId !== 'string' || !turnId) throw new Error('CHAT_TURN_REQUIRED');
    if (this.completed.has(turnId)) return false;
    this.completed.add(turnId); this.turns++; this.check(); return true;
  }
  compact({ threadId, id, status }) {
    if (threadId !== this.threadId || status !== 'completed' || !id || this.compactions.has(id)) return false;
    this.compactions.add(id); this.observation = null; return true;
  }
  observe({ threadId, used, window, hardWindow, at, scope, model }) {
    if (threadId !== this.threadId) return false;
    if (!finite(used) || !finite(window) || window === 0 || scope !== 'current-context' ||
        !Number.isFinite(at) || typeof model !== 'string' || !model) {
      this.observation = null; return false;
    }
    const effective = finite(hardWindow) && hardWindow > 0 ? Math.min(window, hardWindow) : window;
    this.observation = { used, window: effective, at, model };
    this.check(); return true;
  }
  check() {
    const reliable = this.bodyReliable && typeof this.countTokens === 'function';
    if (reliable ? this.body >= LIMITS.body : this.bytes >= LIMITS.bytes) this.reasons.add('body');
    if (!reliable && this.turns >= LIMITS.turns) this.reasons.add('turns');
    if (this.observation && this.observation.used >= LIMITS.soft * this.observation.window) this.reasons.add('context');
    return { pending: this.reasons.size > 0, reasons: [...this.reasons] };
  }
  beforeSend({ inputTokens, outputReserve, maintenanceReserve, now = Date.now(), maxAgeMs = 30000, model } = {}) {
    const o = this.observation;
    if (![inputTokens, outputReserve, maintenanceReserve].every(finite) || !o ||
        !Number.isFinite(now) || !finite(maxAgeMs) || now < o.at || now - o.at > maxAgeMs || model !== o.model)
      return { allowed: false, reason: 'window-unverified', ...this.check() };
    if (o.used >= LIMITS.hard * o.window) this.reasons.add('protection');
    if (o.used + inputTokens + outputReserve + maintenanceReserve > o.window) this.reasons.add('capacity');
    const state = this.check();
    return { allowed: !state.pending, reason: state.pending ? 'handoff-required' : null, ...state };
  }
  snapshot() { return { threadId: this.threadId, body: this.body, bodyUnit: this.bodyReliable && typeof this.countTokens === 'function' ? 'tokens' : 'unknown', bodyReliable: this.bodyReliable,
    bytes: this.bytes, turns: this.turns, messages: [...this.messages], completed: [...this.completed],
    compactions: [...this.compactions], reasons: [...this.reasons] }; }
}

function assembleStartup({ root = '', persona = '', opinions = '', facts = '',
  handoff = { summary: '', originals: '', refs: [] }, window, otherTokens, countTokens } = {}) {
  if (!finite(window) || window <= 0 || !finite(otherTokens)) throw new Error('CHAT_WINDOW_UNVERIFIED');
  const blocks = { root, persona, opinions, facts };
  let size = 0;
  for (const [name, text] of Object.entries(blocks)) {
    if (typeof text !== 'string') throw new Error('CHAT_STARTUP_INVALID');
    size += within(text, name === 'root' ? LIMITS.root : name === 'persona' ? LIMITS.persona : LIMITS.views, countTokens);
  }
  within(handoff.summary, LIMITS.handoffSummary, countTokens);
  within(handoff.originals, LIMITS.handoffOriginal, countTokens);
  const handoffText = JSON.stringify(handoff);
  const allowance = Math.min(LIMITS.handoff, Math.max(0, Math.floor(LIMITS.soft * window - otherTokens - size - LIMITS.growth)));
  within(handoffText, allowance, countTokens);
  const content = JSON.stringify({ ...blocks, handoff });
  const total = tokens(content, countTokens);
  // Includes role/structure packaging supplied by the caller in otherTokens.
  if (total + otherTokens + LIMITS.growth > LIMITS.soft * window) throw new Error('CHAT_STARTUP_REPAIR_REQUIRED');
  return { content, tokens: total, handoffAllowance: allowance };
}

module.exports = { LIMITS, TERMINAL, tokens, within, SessionBudget, assembleStartup };
