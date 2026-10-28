'use strict';
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto'), { performance } = require('node:perf_hooks');
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
async function evaluate({ dataset, output, resourceRoot = path.resolve(__dirname, '../resources/chat-semantic'), centering = true, lexicalOnly = false } = {}) {
  if (!path.isAbsolute(dataset || '') || !path.isAbsolute(output || '')) throw new Error('Explicit absolute dataset and output paths required');
  const data = dataset.endsWith('.cjs') ? require(dataset) : JSON.parse(fs.readFileSync(dataset, 'utf8')); fs.mkdirSync(output, { recursive: true });
  const isolated = fs.mkdtempSync(path.join(output, 'isolated-中文 空格-'));
  for (const key of ['HOME', 'USERPROFILE', 'CODEX_HOME', 'CODEX_MAID_HOME']) process.env[key] = path.join(isolated, key); os.homedir = () => path.join(isolated, 'HOME');
  const { createChatProject } = require('../src/chat-project.cjs'), { createConversation, commitCheckpoint } = require('../src/chat-archive.cjs'), { MemoryStore } = require('../src/chat-memory.cjs'), { ChatHistory } = require('../src/chat-history.cjs');
  const project = createChatProject({ parentDir: isolated, userNickname: '合成检索评估' }), memory = new MemoryStore({ projectRoot: project.root, countTokens: Buffer.byteLength }); memory.initialize({ pet_name: '合成', user_nickname: '合成检索评估' });
  const documents = [...data.documents].sort((a, b) => Date.parse(a.time || '2026-10-20') - Date.parse(b.time || '2026-10-20')), byRef = new Map(), byId = new Map(), logicalIds = new Map();
  const conversation = createConversation({ root: project.root, startedAt: '2026-10-01T00:00:00+08:00', timezone: 'Asia/Shanghai', nativeThreadId: 'synthetic-quality-evaluation' });
  const records = documents.flatMap((doc, n) => {
    const id = `M${n + 1}`, ref = `${conversation.conversationId}/${id}/P01`; byRef.set(ref, doc.id); byId.set(doc.id, { ...doc, ref, messageId: id });
    return [{ turn: { id: `T${n + 1}`, observed_at: null } }, { id, turn_id: `T${n + 1}`, role: 'user', time: doc.time || '2026-10-20T12:00:00+08:00', content: [{ text: doc.text }] }, { turn_result: { id: `T${n + 1}`, observed_at: null, status: 'completed' } }];
  });
  commitCheckpoint({ root: project.root, conversation, sourceComplete: true, trigger: 'new-conversation', records });
  const preparation = new ChatHistory({ projectRoot: project.root, memory, measure: Buffer.byteLength, worker: false, semanticOptions: { resourceRoot: path.join(isolated, 'missing') } }); await preparation.syncIndex();
  memory.resolveSource = source => { const found = preparation.resolveReference(`${source.conversationId}/${source.messageId}/P01`, { intent: 'history' }); return { verified: found.committed, at: found.time, complete: true, originalTurnId: source.messageId.replace('M', 'T') }; };
  const patches = [];
  for (const doc of documents) {
    const parent = Array.isArray(doc.supersedes) ? doc.supersedes[0] : doc.supersedes, logical = parent ? logicalIds.get(parent) : `F-${doc.id}`; logicalIds.set(doc.id, logical || `F-${doc.id}`);
    const source = byId.get(doc.id); patches.push({ module: 'facts', action: parent ? 'correct' : 'upsert', automatic: false, payload: { entry: { id: logicalIds.get(doc.id), kind: 'fact', content: doc.text, last_supported_at: doc.time || '2026-10-20T12:00:00+08:00', sources: [{ type: 'chat', conversationId: conversation.conversationId, messageId: source.messageId, part: 'P01' }] } } });
  }
  memory.commitCheckpoint({ taskId: 'quality-facts', operationWatermark: memory.getState().operationWatermark, baseVersions: { facts: 1 }, sourceWatermark: 'quality-synthetic-source', patches }); await preparation.close();
  const history = new ChatHistory({ projectRoot: project.root, memory, measure: Buffer.byteLength, semanticOptions: { resourceRoot: lexicalOnly ? path.join(isolated, 'missing') : resourceRoot, centering } });
  const started = performance.now(), cases = [];
  try {
    await history.syncIndex({ waitSemantic: true });
    for (const query of data.queries) {
      const before = performance.now(), intent = query.intent === 'quote' ? 'history' : query.intent || 'current', result = await history.searchRecords({ query: query.text, intent, ...(query.after ? { after: query.after } : {}), ...(query.before ? { before: query.before } : {}) }, history.beginTurn());
      const ids = result.cards.map(card => { if (byRef.has(card.ref)) return byRef.get(card.ref); const row = history._row(card.ref); return row?.metadata.sources?.map(ref => byRef.get(ref) || byRef.get(ref + '/P01')).find(Boolean) || null; });
      const required = query.requiredEvidenceIds || [query.expected], forbidden = query.forbiddenEvidenceIds || [], valid = result.status === 'ready' && result.cards.length > 0;
      cases.push({ id: query.id, language: query.language, tags: query.tags, required, forbidden, returned: ids, firstCorrect: valid && required.includes(ids[0]), allRequired: valid && required.every(id => ids.includes(id)), anyRequired: valid && required.some(id => ids.includes(id)), observedRequired: required.every(id => ids.includes(id)), forbiddenReturned: forbidden.filter(id => ids.includes(id)), status: result.status, elapsedMs: performance.now() - before });
    }
    const summarize = items => ({ queries: items.length, top1: items.filter(item => item.firstCorrect).length, allRequiredAt4: items.filter(item => item.allRequired).length, anyRequiredAt4: items.filter(item => item.anyRequired).length, forbiddenCases: items.filter(item => item.forbiddenReturned.length).length });
    const report = { at: new Date().toISOString(), datasetHash: digest(fs.readFileSync(dataset)), syntheticOnly: true, productionWorker: true, centering, lexicalOnly, documents: documents.length, summary: summarize(cases), byLanguage: Object.fromEntries([...new Set(cases.map(item => item.language))].map(key => [key, summarize(cases.filter(item => item.language === key))])), elapsedMs: performance.now() - started, health: history.health(), cases,
      sourceHashes: Object.fromEntries(['chat-history.cjs', 'chat-search.cjs', 'chat-semantic.cjs', 'chat-semantic-manifest.cjs', 'chat-history-worker.cjs'].map(name => [name, digest(fs.readFileSync(path.resolve(__dirname, '../src', name)))])), limitations: ['Authored synthetic data; not natural longitudinal user experience', 'Forbidden source correctness uses formal MemoryStore corrections and current-source filtering; historical quote queries explicitly permit old sources'] };
    fs.writeFileSync(path.join(output, 'RESULT.json'), JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify({ summary: report.summary, byLanguage: report.byLanguage, health: report.health })); return report;
  } finally { await history.close(); }
}
if (require.main === module) { const arg = flag => { const at = process.argv.indexOf(flag); return at < 0 ? undefined : process.argv[at + 1]; }; evaluate({ dataset: arg('--dataset') && path.resolve(arg('--dataset')), output: arg('--output') && path.resolve(arg('--output')), centering: !process.argv.includes('--raw-cosine'), lexicalOnly: process.argv.includes('--lexical-only') }).catch(error => { console.error(error.code || error.message); process.exitCode = 1; }); }
module.exports = { evaluate };
