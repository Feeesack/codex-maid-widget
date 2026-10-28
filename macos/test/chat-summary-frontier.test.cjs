'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { SummaryTree, digest } = require('../src/chat-summary.cjs');
const { LIMITS } = require('../src/chat-policy.cjs');
const measure = value => Buffer.byteLength(value);
const nodeRef = node => `${node.id}@v${node.version}`;

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'maid-frontier-中文 空格 '));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return new SummaryTree({ projectRoot: root, countTokens: measure, resolveSource: () => true });
}
function leafContent(conversationId, marker = conversationId) {
  return { text: `Synthetic source ${marker}`, guide: 'read the original source', entries: [{ text: marker, refs: [`${conversationId}/M000001/P01`] }] };
}
function prime(data) {
  return { text: data.leaf.content.text, guide: 'read the complete L1', entries: data.leaf.content.entries.map(entry => ({ text: entry.text, refs: [`${data.leaf.ref}#${entry.id}`] })) };
}
function merge(data) {
  return { text: `Formal level ${data.level}`, guide: 'read direct children', entries: data.children.map(child => ({ text: child.content.entries.map(entry => entry.text).join(';'), refs: child.content.entries.map(entry => `${child.ref}#${entry.id}`) })) };
}
function request(index, options = {}) {
  const conversationId = `C-frontier-${index}`;
  return { conversationId, sourceFingerprint: digest({ index }), sourceComplete: true, content: leafContent(conversationId), compact: async data => prime(data), summarize: async data => merge(data), ...options };
}
function descendants(tree, reference = tree.state().root) {
  const node = tree.read(reference);
  return [node, ...node.children.flatMap(child => descendants(tree, child))];
}
function bytes(tree, reference) {
  return fs.readFileSync(path.join(tree.journal.root, 'memory', 'summaries', 'nodes', `${reference}.jsonl`));
}
function snapshotSealed(tree) {
  return new Map(descendants(tree).filter(node => node.status === 2).map(node => [nodeRef(node), bytes(tree, nodeRef(node))]));
}
function assertUnchanged(tree, snapshot) {
  for (const [reference, before] of snapshot) assert.deepEqual(bytes(tree, reference), before, reference);
}

test('one through seventeen sources append small primes and integrate every fourth leaf with level-correct children', async t => {
  const tree = fixture(t), primes = [], formal = [], leaves = [];
  const expectedFormal = new Map([[4, [2]], [8, [2, 3]], [12, [2, 3]], [16, [2, 3]]]);
  for (let index = 1; index <= 17; index++) {
    const before = index > 1 ? snapshotSealed(tree) : new Map(), priorCalls = formal.length, priorPrimes = primes.length;
    const result = await tree.publishLeaf(request(index, {
      compact: async data => { primes.push(data); assert.equal(data.inputLimit, LIMITS.node); assert.equal(data.outputLimit, 5000); return prime(data); },
      summarize: async data => { formal.push(data); assert.equal(data.inputLimit, LIMITS.parentInput); assert.equal(data.outputLimit, LIMITS.node); assert.ok(data.children.length >= 2 && data.children.length <= LIMITS.children); return merge(data); }
    }));
    leaves.push(result.leaf);
    const state = tree.state(), root = tree.read(result.root), nodes = descendants(tree), activeLeaves = nodes.filter(node => node.level === 1);
    assert.equal(state.layout, 'append-quarter/1'); assert.equal(root.level, index <= 4 ? 2 : index <= 16 ? 3 : 4); assert.equal(root.leaves, index);
    assert.deepEqual(activeLeaves.map(nodeRef), leaves); assert.equal(new Set(activeLeaves.map(nodeRef)).size, index);
    for (const node of nodes) {
      assert.ok([0, 1, 2].includes(node.status));
      if (node.level === 1) { assert.equal(node.status, 1); assert.equal(node.leaves, 1); assert.deepEqual(node.children, []); continue; }
      assert.ok(node.children.length >= 1 && node.children.length <= 4);
      const children = node.children.map(reference => tree.read(reference));
      assert.ok(children.every(child => child.level === node.level - 1));
      assert.equal(node.leaves, children.reduce((sum, child) => sum + child.leaves, 0));
      if (node.status === 2) { assert.equal(children.length, 4); assert.ok(children.every(child => child.level === 1 || child.status === 2)); }
    }
    assert.equal(root.status, index % 4 ? 0 : index === 4 || index === 16 ? 2 : 1);
    assert.deepEqual(formal.slice(priorCalls).map(data => data.level), expectedFormal.get(index) || []);
    assert.equal(primes.length - priorPrimes, index % 4 ? 1 : 0);
    const savedPrime = tree.readPrime(result.leaf);
    if (index % 4) {
      assert.equal(savedPrime.schema, 'codex-maid-leaf-prime/1'); assert.equal(savedPrime.leafRef, result.leaf); assert.equal(savedPrime.sourceFingerprint, digest({ index }));
      assert.equal(savedPrime.content.entries[0].id, 'I01'); assert.equal(savedPrime.content.entries[0].refs[0], `${result.leaf}#I01`);
      assert.equal(root.content.entries.filter(entry => entry.refs.includes(`${result.leaf}#I01`)).length, 1);
    } else assert.equal(savedPrime, null);
    assertUnchanged(tree, before);
  }
  assert.equal(primes.length, 13); assert.equal(formal.length, 7);
});

test('adding the seventeenth leaf marks intermediate ancestors pending without rewriting their sealed sibling', async t => {
  const tree = fixture(t);
  for (let index = 1; index <= 16; index++) await tree.publishLeaf(request(index));
  const oldRoot = tree.state().root, previous = snapshotSealed(tree);
  const result = await tree.publishLeaf(request(17)), root = tree.read(result.root);
  assert.equal(root.level, 4); assert.equal(root.status, 0); assert.equal(root.children[0], oldRoot);
  const newL3 = tree.read(root.children[1]), newL2 = tree.read(newL3.children[0]);
  assert.equal(newL3.level, 3); assert.equal(newL3.status, 0); assert.equal(newL2.level, 2); assert.equal(newL2.status, 0); assert.deepEqual(newL2.children, [result.leaf]);
  assertUnchanged(tree, previous);
});

test('large primes append once to the root under forty thousand and fourth-leaf integration returns to twenty thousand', async t => {
  const tree = fixture(t); let compactCalls = 0, summaryCalls = 0;
  const padded = (value, target) => { value.text = ''; value.text = 'x'.repeat(target - measure(JSON.stringify(value))); return value; };
  for (let index = 1; index <= 8; index++) {
    const conversationId = `C-frontier-${index}`;
    const result = await tree.publishLeaf(request(index, {
      content: padded(leafContent(conversationId), LIMITS.node - 100),
      compact: async data => { compactCalls++; return padded(prime(data), 4800); },
      summarize: async data => { summaryCalls++; return padded(merge(data), LIMITS.node - 200); }
    }));
    const root = tree.read(result.root), size = measure(JSON.stringify(root.content));
    assert.ok(size <= (root.status === 0 ? 40000 : LIMITS.node));
    if (index === 7) { assert.equal(root.status, 0); assert.ok(size > 30000); }
    if (index % 4) assert.equal(root.content.entries.filter(entry => entry.refs.includes(`${result.leaf}#I01`)).length, 1);
  }
  assert.equal(compactCalls, 6); assert.equal(summaryCalls, 3);
});

test('same fingerprints are idempotent and sealed conversation revisions replace their logical leaf without rewriting history', async t => {
  const tree = fixture(t); let compactCalls = 0;
  const options = { compact: async data => { compactCalls++; return prime(data); }, content: leafContent('C-frontier-1', 'obsolete synthetic claim') }, firstRequest = request(1, options);
  const first = await tree.publishLeaf(firstRequest), again = await tree.publishLeaf(firstRequest);
  assert.equal(again.reused, true); assert.equal(again.leaf, first.leaf); assert.equal(compactCalls, 1); assert.equal(tree.state().revision, 1);
  for (let index = 2; index <= 4; index++) await tree.publishLeaf(request(index));
  const sealedRoot = tree.state().root, before = snapshotSealed(tree), firstBytes = bytes(tree, first.leaf);
  assert.match(JSON.stringify(tree.read(sealedRoot).content), /obsolete synthetic claim/);
  const revised = await tree.publishLeaf({ ...firstRequest, sourceFingerprint: digest('revised source'), content: leafContent(firstRequest.conversationId, 'changed source') });
  const root = tree.read(revised.root), oldRoot = tree.read(sealedRoot);
  assert.notEqual(revised.leaf, first.leaf); assert.notEqual(root.id, oldRoot.id); assert.equal(root.leaves, 4); assert.equal(root.status, 2); assert.equal(revised.integrated, true);
  assert.equal(compactCalls, 1); assert.equal(tree.readPrime(revised.leaf), null); assert.equal(tree.read(revised.leaf).supersedes, first.leaf);
  assert.deepEqual(descendants(tree).filter(node => node.level === 1).map(nodeRef), [revised.leaf, ...oldRoot.children.slice(1)]);
  assert.equal(tree.state().active[oldRoot.id], undefined); assert.equal(tree.state().active[tree.read(first.leaf).id], undefined);
  assert.doesNotMatch(JSON.stringify(root.content), /obsolete synthetic claim/); assert.match(JSON.stringify(root.content), /changed source/);
  assert.deepEqual(bytes(tree, first.leaf), firstBytes); assertUnchanged(tree, before);
  const mapping = tree.state().conversations[firstRequest.conversationId];
  assert.equal(mapping.ref, revised.leaf); assert.ok(JSON.stringify(mapping).includes(first.leaf));
  await assert.rejects(tree.publishLeaf(firstRequest), /SOURCE_ALREADY_SUPERSEDED/);
});

test('a revision in a pending branch regenerates its path once across failure and retry while retaining one logical leaf per conversation', async t => {
  const tree = fixture(t);
  for (let index = 1; index <= 7; index++) await tree.publishLeaf(request(index, index === 6 ? { content: leafContent('C-frontier-6', 'obsolete pending claim') } : {}));
  const before = tree.state(), oldRoot = tree.read(before.root), oldL2 = tree.read(oldRoot.children[1]), oldLeaf = before.conversations['C-frontier-6'].ref;
  const oldFiles = new Map(descendants(tree).map(node => [nodeRef(node), bytes(tree, nodeRef(node))]));
  assert.equal(oldRoot.status, 0); assert.match(JSON.stringify(oldRoot.content), /obsolete pending claim/);
  const cache = new Map(), paidLevels = []; let interrupted = true, compactCalls = 0;
  const revision = request(6, { sourceFingerprint: digest('pending source corrected'), content: leafContent('C-frontier-6', 'corrected pending claim'),
    compact: async data => { compactCalls++; return prime(data); },
    summarize: async data => { const key = digest(data); if (!cache.has(key)) { paidLevels.push(data.level); cache.set(key, merge(data)); } if (data.level === 3 && interrupted) { interrupted = false; throw new Error('synthetic-revision-after-completed-ancestor'); } return cache.get(key); }
  });
  await assert.rejects(tree.publishLeaf(revision), /synthetic-revision-after-completed-ancestor/); assert.deepEqual(tree.state(), before); assertUnchanged(tree, oldFiles);
  const done = await tree.publishLeaf(revision), current = tree.read(done.root), currentL2 = tree.read(current.children[1]);
  assert.deepEqual(paidLevels, [2, 3]); assert.equal(compactCalls, 1); assert.equal(tree.readPrime(done.leaf).leafRef, done.leaf); assert.equal(done.integrated, true);
  assert.equal(current.leaves, 7); assert.equal(current.status, 1); assert.equal(currentL2.status, 1); assert.equal(currentL2.leaves, 3); assert.equal(current.children[0], oldRoot.children[0]);
  assert.notEqual(current.id, oldRoot.id); assert.notEqual(currentL2.id, oldL2.id);
  for (const reference of [before.root, nodeRef(oldL2), oldLeaf]) assert.equal(tree.state().active[tree.read(reference).id], undefined);
  const currentLeaves = descendants(tree).filter(node => node.level === 1); assert.equal(currentLeaves.length, 7); assert.equal(currentLeaves.filter(node => node.conversationId === 'C-frontier-6').length, 1);
  assert.doesNotMatch(JSON.stringify(current.content), /obsolete pending claim/); assert.match(JSON.stringify(current.content), /corrected pending claim/); assertUnchanged(tree, oldFiles);
});

test('revising a legacy single-L1 root promotes one pending L2 without introducing an extra conversation leaf', async t => {
  const tree = fixture(t), initial = request(1, { compact: undefined }), first = await tree.publishLeaf(initial), oldBytes = bytes(tree, first.root);
  assert.equal(tree.read(first.root).level, 1);
  const revised = await tree.publishLeaf(request(1, { sourceFingerprint: digest('legacy root revision'), content: leafContent('C-frontier-1', 'corrected legacy source'), summarize: async () => { throw new Error('single child must not buy a parent generation'); } }));
  const root = tree.read(revised.root); assert.equal(root.level, 2); assert.equal(root.status, 0); assert.equal(root.leaves, 1); assert.deepEqual(root.children, [revised.leaf]); assert.equal(revised.integrated, false);
  assert.equal(tree.readPrime(revised.leaf).leafRef, revised.leaf); assert.equal(Object.keys(tree.state().conversations).length, 1); assert.equal(tree.state().active[tree.read(first.leaf).id], undefined);
  assert.match(JSON.stringify(root.content), /corrected legacy source/); assert.deepEqual(bytes(tree, first.root), oldBytes);
});

test('invalid or oversized primes never publish a partial head or bypass direct L1 provenance', async t => {
  const tree = fixture(t); let calls = 0;
  await assert.rejects(tree.publishLeaf(request(1, { compact: async () => { calls++; throw new Error('synthetic-compact-failure'); } })), /synthetic-compact-failure/);
  assert.equal(tree.state().root, null); assert.equal(tree.state().revision, 0);
  await assert.rejects(tree.publishLeaf(request(1, { compact: async data => ({ ...prime(data), text: 'x'.repeat(5001) }) })), /BUDGET/);
  assert.equal(tree.state().root, null);
  await assert.rejects(tree.publishLeaf(request(1, { compact: async data => ({ ...prime(data), entries: [{ text: 'invalid shortcut', refs: data.leaf.content.entries[0].refs }] }) })), /DIRECT_CHILD/);
  assert.equal(tree.state().root, null);
  const done = await tree.publishLeaf(request(1)); assert.equal(tree.read(done.root).leaves, 1); assert.equal(calls, 1);
});

test('a fourth-leaf seal failure retains the old tree and retries exactly the same prepared child identities', async t => {
  const tree = fixture(t);
  for (let index = 1; index <= 3; index++) await tree.publishLeaf(request(index));
  const before = tree.state(), oldBytes = bytes(tree, before.root), cache = new Map(); let paid = 0, interrupted = true, compactCalls = 0;
  const fourth = request(4, {
    compact: async () => { compactCalls++; throw new Error('fourth leaf must not compact'); },
    summarize: async data => { const key = digest(data); if (!cache.has(key)) { paid++; cache.set(key, merge(data)); } if (interrupted) { interrupted = false; throw new Error('synthetic-after-completed-seal'); } return cache.get(key); }
  });
  await assert.rejects(tree.publishLeaf(fourth), /synthetic-after-completed-seal/);
  assert.deepEqual(tree.state(), before); assert.deepEqual(bytes(tree, before.root), oldBytes);
  const done = await tree.publishLeaf(fourth);
  assert.equal(paid, 1); assert.equal(compactCalls, 0); assert.equal(tree.read(done.root).status, 2); assert.equal(tree.read(done.root).leaves, 4); assert.equal(tree.readPrime(done.leaf), null);
});

test('an ancestor integration interruption keeps lower results reusable and leaves the published tree untouched', async t => {
  const tree = fixture(t);
  for (let index = 1; index <= 7; index++) await tree.publishLeaf(request(index));
  const before = tree.state(), sealed = snapshotSealed(tree), cache = new Map(), paidLevels = []; let interrupted = true;
  const eighth = request(8, { summarize: async data => {
    const key = digest(data); if (!cache.has(key)) { paidLevels.push(data.level); cache.set(key, merge(data)); }
    if (data.level === 3 && interrupted) { interrupted = false; throw new Error('synthetic-after-completed-ancestor'); }
    return cache.get(key);
  } });
  await assert.rejects(tree.publishLeaf(eighth), /synthetic-after-completed-ancestor/); assert.deepEqual(tree.state(), before); assertUnchanged(tree, sealed);
  const done = await tree.publishLeaf(eighth); assert.deepEqual(paidLevels, [2, 3]); assert.equal(tree.read(done.root).status, 1); assert.equal(tree.read(done.root).leaves, 8); assertUnchanged(tree, sealed);
});

test('a crash after an immutable node write can retry without changing bytes or repeating completed compaction', async t => {
  const tree = fixture(t); await tree.publishLeaf(request(1));
  const before = tree.state(), oldBytes = bytes(tree, before.root), directory = path.join(tree.journal.root, 'memory', 'summaries', 'nodes'), initialFiles = fs.readdirSync(directory).length;
  const write = tree.journal.write.bind(tree.journal), cache = new Map(); let interrupted = true, paid = 0;
  tree.journal.write = (relative, value, options) => { const result = write(relative, value, options); if (interrupted && relative.startsWith('memory/summaries/nodes/')) { interrupted = false; throw new Error('synthetic-after-node-write'); } return result; };
  const second = request(2, { compact: async data => { const key = digest(data); if (!cache.has(key)) { paid++; cache.set(key, prime(data)); } return cache.get(key); } });
  await assert.rejects(tree.publishLeaf(second), /synthetic-after-node-write/);
  assert.deepEqual(tree.state(), before); assert.deepEqual(bytes(tree, before.root), oldBytes); assert.ok(fs.readdirSync(directory).length > initialFiles);
  const partial = new Map(fs.readdirSync(directory).map(name => [name, fs.readFileSync(path.join(directory, name))]));
  const done = await tree.publishLeaf(second); assert.equal(paid, 1); assert.equal(tree.read(done.root).leaves, 2);
  for (const [name, content] of partial) assert.deepEqual(fs.readFileSync(path.join(directory, name)), content);
});

test('a partial legacy L2 transitions by priming its existing leaves and seals without rewriting legacy files', async t => {
  const tree = fixture(t), originals = [];
  for (let index = 1; index <= 2; index++) originals.push(await tree.publishLeaf(request(index, { compact: undefined })));
  const oldRoot = tree.state().root, oldFiles = new Map(descendants(tree).map(node => [nodeRef(node), bytes(tree, nodeRef(node))]));
  assert.equal(tree.read(oldRoot).level, 2); assert.equal(tree.read(oldRoot).status, 1);
  assert.equal(JSON.parse(oldFiles.get(oldRoot).toString()).status, undefined);
  const primed = [], third = await tree.publishLeaf(request(3, { compact: async data => { primed.push(data.leaf.ref); return prime(data); } }));
  assert.deepEqual(primed, [...originals.map(result => result.leaf), third.leaf]);
  const pending = tree.read(third.root); assert.equal(pending.status, 0); assert.equal(pending.leaves, 3); assert.equal(pending.content.entries.length, 3);
  for (const reference of primed) assert.equal(tree.readPrime(reference).leafRef, reference);
  const fourth = await tree.publishLeaf(request(4, { compact: async () => { throw new Error('fourth legacy-transition leaf must not compact'); } }));
  assert.equal(tree.read(fourth.root).status, 2); assert.equal(tree.read(fourth.root).leaves, 4); assert.equal(tree.readPrime(fourth.leaf), null);
  assertUnchanged(tree, oldFiles);
});

test('current correction of a pending root preserves its other entries when the projected content exceeds twenty thousand', async t => {
  const tree = fixture(t); let last;
  for (let index = 1; index <= 7; index++) last = await tree.publishLeaf(request(index, {
    compact: async data => ({ text: 'p'.repeat(2000), guide: 'exact L1 evidence', entries: [{ text: 'p'.repeat(2000), refs: [`${data.leaf.ref}#I01`] }] }),
    summarize: async data => ({ text: 'f'.repeat(8000), guide: 'four complete children', entries: [{ text: 'f'.repeat(8000), refs: data.children.map(child => `${child.ref}#I01`) }] })
  }));
  const before = bytes(tree, last.root), head = tree.state(), original = tree.read(last.root);
  assert.equal(original.status, 0); assert.ok(measure(JSON.stringify(original.content)) > LIMITS.node);
  const corrections = [{ memoryRef: 'F-frontier-correction@2', text: 'Corrected synthetic detail for the final source.', sourceRefs: ['C-frontier-7/M000001/P01'] }];
  const projected = tree.projectCurrent(last.root, { corrections }), size = measure(JSON.stringify(projected.content));
  assert.equal(projected.currentProjection.partial, false); assert.ok(size > LIMITS.node); assert.ok(size <= LIMITS.root); assert.equal(projected.content.entries.length, original.content.entries.length);
  assert.equal(projected.content.entries[0].text, 'f'.repeat(8000)); assert.ok(projected.content.entries.filter(entry => entry.text === 'p'.repeat(2000)).length >= 2);
  assert.match(projected.content.text, /Corrected synthetic detail/); assert.deepEqual(bytes(tree, last.root), before); assert.deepEqual(tree.state(), head);
});

test('the seventeenth branch keeps its original content when an unrelated old-source correction projects unpublished ancestors', async t => {
  const tree = fixture(t); let first;
  for (let index = 1; index <= 16; index++) {
    const result = await tree.publishLeaf(request(index, index === 1 ? { content: leafContent('C-frontier-1', 'obsolete first-source claim') } : {}));
    if (index === 1) first = result.leaf;
  }
  const oldBytes = bytes(tree, first), sealed = snapshotSealed(tree);
  const corrections = [{ memoryRef: 'F-old-correction@2', text: 'Corrected claim applies only to the first source.', sourceRefs: ['C-frontier-1/M000001/P01'] }];
  const marker = 'Seventeenth source retains its unrelated original claim.';
  const result = await tree.publishLeaf(request(17, {
    content: leafContent('C-frontier-17', marker), projectionWatermark: digest(corrections), currentProjection: node => tree.projectCurrent(node, { corrections })
  }));
  const root = tree.read(result.root), rightL3 = tree.read(root.children[1]), rightL2 = tree.read(rightL3.children[0]);
  assert.equal(root.level, 4); assert.equal(rightL3.level, 3); assert.equal(rightL2.level, 2);
  for (const value of [tree.read(result.leaf).content, tree.readPrime(result.leaf).content, rightL2.content, rightL3.content]) {
    assert.match(JSON.stringify(value), /Seventeenth source retains its unrelated original claim/);
    assert.doesNotMatch(JSON.stringify(value), /F-old-correction|Corrected claim applies only/);
  }
  const startup = tree.projectCurrent(result.root, { corrections }), oldSource = tree.projectCurrent(first, { corrections });
  assert.match(JSON.stringify(startup.content), /Seventeenth source retains its unrelated original claim/);
  assert.match(JSON.stringify(startup.content), /Corrected claim applies only to the first source/);
  assert.match(JSON.stringify(oldSource.content), /F-old-correction@2/); assert.doesNotMatch(JSON.stringify(oldSource.content), /obsolete first-source claim/);
  assert.equal(tree.read(first).content.entries[0].text, 'obsolete first-source claim'); assert.deepEqual(bytes(tree, first), oldBytes); assertUnchanged(tree, sealed);
});
