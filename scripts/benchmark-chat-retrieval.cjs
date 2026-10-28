'use strict';
// Explicit offline benchmark. Every document has different synthetic content and
// is encoded by the production worker; vectors are never seeded or duplicated.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto'), { performance } = require('node:perf_hooks');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
function syntheticDocument(index) {
  const people = ['Mira', 'Theo', 'Noor', 'Lena', 'Arun', 'Iris', 'Emil', 'Sora'], cities = ['Kyoto', 'Oslo', 'Lima', 'Accra', 'Perth', 'Taipei', 'Quito', 'Dublin'];
  const foods = ['peanuts', 'oatmeal', 'walnuts', 'broccoli', 'mango', 'ginger', 'tomato', 'barley'], hobbies = ['pottery', 'rowing', 'violin', 'astronomy', 'skating', 'origami', 'chess', 'gardening'];
  const n = index + 1, a = index % 8, b = Math.floor(index / 8) % 8, c = Math.floor(index / 64) % 8, day = 1 + Math.floor(index / 512) % 28, year = 2020 + Math.floor(index / 14336), duration = 10 + index % 73;
  const statements = [
    `${people[a]} planned a ${duration}-minute ${hobbies[b]} session in ${cities[c]} on ${year}-11-${day}, then moved it from morning to evening; booking ${n} remains unconfirmed.`,
    `合成人物${people[a]}在${year}年11月${day}日去${cities[b]}学习${hobbies[c]}，练习${duration}分钟；第${n}项安排只在天气晴朗时有效。`,
    `${people[a]} cannot eat ${foods[b]} during the trip to ${cities[c]}; order ${n} substitutes rice, and the restriction lasts until November ${day}, ${year}.`,
    `编号${n}的读书讨论由${people[a]}在${cities[b]}主持，主题是${hobbies[c]}与城市生活；${year}年11月${day}日改为线上，尚未确认完成。`,
    `${people[a]}'s bicycle was repaired in ${cities[b]} after ${duration} minutes, while their friend practiced ${hobbies[c]}; receipt ${n} is dated ${year}-11-${day}.`,
    `合成花园${n}位于${cities[a]}，${people[b]}种了${foods[c]}；${year}年11月${day}日记录浇水${duration}分钟，没有声称已经收获。`,
    `On November ${day}, ${year}, ${people[a]} borrowed a book about ${hobbies[b]} in ${cities[c]}; loan ${n} was extended by ${duration} days and has not been returned.`,
    `第${n}次旅行由${people[a]}从${cities[b]}前往${cities[c]}，计划带${foods[a]}作为点心；${year}年11月${day}日将出发推迟${duration}分钟。`,
  ]; return statements[Math.floor(index / 8) % statements.length];
}
async function benchmark({ count = 100000, output, resourceRoot = path.resolve(__dirname, '../resources/chat-semantic') } = {}) {
  if (!path.isAbsolute(output || '') || !Number.isSafeInteger(count) || count < 1) throw new Error('Explicit absolute isolated output directory and positive count required');
  fs.mkdirSync(output, { recursive: true }); const isolated = fs.mkdtempSync(path.join(output, 'isolated-中文 空格-'));
  for (const key of ['HOME', 'USERPROFILE', 'CODEX_HOME', 'CODEX_MAID_HOME']) process.env[key] = path.join(isolated, key); os.homedir = () => path.join(isolated, 'HOME');
  const { createChatProject } = require('../src/chat-project.cjs'), { createConversation, commitCheckpoint } = require('../src/chat-archive.cjs'), { ChatHistory } = require('../src/chat-history.cjs');
  const project = createChatProject({ parentDir: isolated, userNickname: '合成规模验收' }), conversation = createConversation({ root: project.root, startedAt: '2026-10-27T01:00:00+08:00', timezone: 'Asia/Shanghai', nativeThreadId: 'synthetic-unique-scale' });
  const unique = new Set(), records = []; let sourceBytes = 0;
  for (let n = 0; n < count; n++) { const text = syntheticDocument(n); unique.add(hash(text)); sourceBytes += Buffer.byteLength(text); records.push({ turn: { id: `T${n + 1}`, observed_at: null } }, { id: `M${n + 1}`, turn_id: `T${n + 1}`, role: 'user', time: '2026-10-27T01:00:01+08:00', content: [{ text }] }, { turn_result: { id: `T${n + 1}`, observed_at: null, status: 'completed' } }); }
  if (unique.size !== count) throw new Error('BENCHMARK_DOCUMENTS_NOT_DISTINCT');
  const archive = commitCheckpoint({ root: project.root, conversation, sourceComplete: true, trigger: 'new-conversation', records }); records.length = 0;
  const sourceHashes = Object.fromEntries(['chat-history.cjs', 'chat-search.cjs', 'chat-semantic.cjs', 'chat-semantic-manifest.cjs', 'chat-history-worker.cjs'].map(file => [file, hash(fs.readFileSync(path.resolve(__dirname, '../src', file)))]));
  const history = new ChatHistory({ projectRoot: project.root, measure: Buffer.byteLength, semanticOptions: { resourceRoot } });
  const started = performance.now(); let lastLog = 0, maximumRss = 0, lastTick = started, maxMainLoopGapMs = 0;
  const append = value => { fs.appendFileSync(path.join(output, 'progress.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...value }) + '\n'); console.log(JSON.stringify(value)); };
  const poll = setInterval(() => { const now = performance.now(); maxMainLoopGapMs = Math.max(maxMainLoopGapMs, now - lastTick); lastTick = now; maximumRss = Math.max(maximumRss, process.memoryUsage().rss); if (now - lastLog >= 10000) { lastLog = now; const value = { stage: 'production-worker-indexing', elapsedSeconds: (now - started) / 1000, rssMiB: process.memoryUsage().rss / 2 ** 20, ...history.health() }; append(value); fs.writeFileSync(path.join(output, 'CURRENT.json'), JSON.stringify(value, null, 2)); } }, 10);
  append({ stage: 'prepared', documents: count, distinctTexts: unique.size, sourceBytes, archiveSha256: archive.sha256, sourceHashes });
  try {
    const indexed = await history.syncIndex({ waitSemantic: true }), buildMs = performance.now() - started;
    const durations = [], results = [];
    for (let n = 0; n < 30; n++) { const before = performance.now(), result = await history.searchRecords(n % 2 ? 'Which food restriction applies during the trip?' : '哪一次读书讨论改为线上？', history.beginTurn()); durations.push(performance.now() - before); results.push({ status: result.status, cards: result.cards.length, semantic: result.semantic }); }
    const db = history._open(), vectors = db.prepare('SELECT COUNT(*) n,COUNT(DISTINCT hex(embedding)) uniqueVectors FROM vectors WHERE dimensions=384').get(), p95 = [...durations].sort((a, b) => a - b)[Math.ceil(durations.length * 0.95) - 1];
    const resumeStart = performance.now(), resumed = await history.syncIndex({ waitSemantic: true }), resumeMs = performance.now() - resumeStart;
    const report = { at: new Date().toISOString(), passed: vectors.n === indexed.indexed && vectors.n >= count && history.health().pendingVectors === 0, syntheticOnly: true, documents: count, distinctTexts: unique.size, sourceBytes, sourceHashes, indexedFragments: indexed.indexed, vectors: vectors.n, distinctVectors: vectors.uniqueVectors, encodedTextWindows: history.health().encodedTextWindows, encoderCalls: history.health().encoderCalls, buildMs, documentsPerSecond: count * 1000 / buildMs, peakRssMiB: maximumRss / 2 ** 20, maxMainLoopGapMs, hotQueries: { samples: durations.length, p95Ms: p95, results }, unchangedSync: { elapsedMs: resumeMs, indexed: resumed.indexed, changedFiles: resumed.changedFiles }, hardware: { platform: process.platform, arch: process.arch, cpu: os.cpus()[0].model, logicalCpus: os.cpus().length, memoryGiB: os.totalmem() / 2 ** 30 }, limitations: ['Distinct generated multilingual content, not 100000 independently human-authored documents', 'Capacity/real encoding throughput is separate from held-out retrieval-quality evaluation', 'One Windows machine; no Mac native or all-hardware performance guarantee'] };
    fs.writeFileSync(path.join(output, 'RESULT.json'), JSON.stringify(report, null, 2) + '\n'); append({ stage: 'complete', passed: report.passed, vectors: vectors.n, distinctVectors: vectors.uniqueVectors, buildMs, p95Ms: p95 }); return report;
  } finally { clearInterval(poll); await history.close(); }
}
if (require.main === module) { const value = flag => { const n = process.argv.indexOf(flag); return n < 0 ? undefined : process.argv[n + 1]; }; benchmark({ output: value('--output') && path.resolve(value('--output')), count: Number(value('--count') || 100000), ...(value('--resources') ? { resourceRoot: path.resolve(value('--resources')) } : {}) }).catch(error => { console.error(error.code || error.message); process.exitCode = 1; }); }
module.exports = { benchmark, syntheticDocument };
