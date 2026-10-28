'use strict';
const { randomUUID, createHash } = require('node:crypto');
const { ChatJournal } = require('./chat-journal.cjs');
const { LIMITS, within } = require('./chat-policy.cjs');
function digest(value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function ref(node) { return `${node.id}@v${node.version}`; }
function stableNodeId(level, children) { const hex = digest({ level, children }).slice(0, 32); return `L${level}-${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`; }

// A published leaf represents exactly one C, regardless of source batches.
// Model generation is injected and must be dispatched by MaintenanceTask.
class SummaryTree {
  constructor({ projectRoot, fs, countTokens, resolveSource } = {}) {
    this.journal = new ChatJournal(projectRoot, { fs });
    this.countTokens = countTokens; this.resolveSource = resolveSource;
  }
  state() { return this.journal.read('memory/summaries/head.jsonl') || { schema:'codex-maid-tree/1',revision:0,root:null,conversations:{},active:{} }; }
  read(reference) {
    if (typeof reference !== 'string' || !/^L[1-9]\d*-[a-f0-9-]{36}@v[1-9]\d*$/.test(reference)) throw new Error('CHAT_SUMMARY_REF_INVALID');
    const node=this.journal.read(`memory/summaries/nodes/${reference}.jsonl`);
    if(!node || ref(node)!==reference) throw new Error('CHAT_SUMMARY_MISSING');
    if (node.status !== undefined && (![0, 1, 2].includes(node.status) || node.level === 1 && node.status !== 1)) throw new Error('CHAT_SUMMARY_STATUS_INVALID');
    // Older trees have immutable files without an integration-state field.
    // Infer their already-published state without rewriting those files.
    return node.status === undefined ? { ...node, status: node.level === 1 ? 1 : node.leaves === LIMITS.children ** (node.level - 1) ? 2 : 1 } : node;
  }
  readPrime(leafRef) {
    if (typeof leafRef !== 'string' || !/^L1-[a-f0-9-]{36}@v[1-9]\d*$/.test(leafRef)) throw new Error('CHAT_SUMMARY_REF_INVALID');
    return this.journal.read(`memory/summaries/primes/${leafRef}.jsonl`);
  }
  projectCurrent(reference, { corrections = [], nodeLimit = 128 } = {}) {
    const original = typeof reference === 'string' ? this.read(reference) : reference, watermark = digest(corrections);
    reference = ref(original);
    if (!corrections.length || original.currentProjectionWatermark === watermark) return original;
    const cache = new Map([[reference, original]]), visited = new Set(), matches = new Map(); let partial = false;
    const sameSource = (left, right) => left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
    const affected = (value, trail = new Set()) => {
      if (/^C-/.test(value)) return corrections.filter(item => item.sourceRefs.some(source => sameSource(source, value)));
      if (!/^L[1-9]\d*-[a-f0-9-]{36}@v[1-9]\d*(?:#I\d+)?$/.test(value) || trail.has(value)) { partial = true; return corrections; }
      if (matches.has(value)) return matches.get(value);
      const [nodeRef, entryId] = value.split('#'); let node = cache.get(nodeRef);
      if (!node) {
        if (visited.size >= nodeLimit) { partial = true; return corrections; }
        try { node = this.read(nodeRef); cache.set(nodeRef, node); } catch { partial = true; return corrections; }
      }
      visited.add(nodeRef);
      if (node.currentProjectionWatermark === watermark) return [];
      const entries = entryId ? node.content.entries.filter(entry => entry.id === entryId) : node.content.entries;
      if (!entries.length) { partial = true; return corrections; }
      const nextTrail = new Set(trail).add(value), result = [...new Map(entries.flatMap(entry => entry.refs.flatMap(ref => affected(ref, nextTrail))).map(item => [item.memoryRef, item])).values()];
      matches.set(value, result); return result;
    };
    const node = structuredClone(original); let changed = false;
    node.content.entries = node.content.entries.map(entry => {
      const related = [...new Map(entry.refs.flatMap(ref => affected(ref)).map(item => [item.memoryRef, item])).values()];
      if (!related.length) return entry; changed = true;
      // This is a derived current-use projection, not a rewritten historical
      // summary. Exact wording remains available through immutable references.
      let text = `本项旧摘要涉及已确认的来源表达纠偏，旧表述不作当前事实；请核对原文及正式修订 ${related.map(item => item.memoryRef).join('、')}。`;
      for (const item of related.slice(0, 4)) {
        const addition = ` 当前正式修订：${item.text}（${item.memoryRef}；原文${item.sourceRefs.join('、')}）`;
        if (Buffer.byteLength(text + addition) <= 1600) text += addition;
      }
      return { ...entry, text };
    });
    if (!changed) return original;
    node.content.text = node.content.entries.map(entry => entry.text).join('\n');
    node.content.guide = partial ? '部分来源链达到有界核对上限；涉及纠偏的旧表述须回源核对。' : '来源表达已有正式纠偏；当前投影保留原节点与条目引用以供回查。';
    try { within(node.content, original.integration?.rootView ? LIMITS.root : LIMITS.node, this.countTokens); }
    catch {
      node.content = { text: '本摘要含来源纠偏，当前容量不足以安全提供完整投影；请查阅原文及正式记忆。', guide: '部分待核对，历史摘要原件保留。',
        entries: [{ id: 'I01', text: '旧摘要暂不作为当前事实；请按原引用回查。', refs: [reference] }] }; partial = true;
    }
    node.currentProjection = { derived: true, partial, visitedNodes: visited.size, originalRef: reference, watermark };
    return node;
  }
  validateContent(content, sources, {leaf=false,conversationId,limit=LIMITS.node}={}) {
    if(!content || typeof content.text!=='string' || typeof content.guide!=='string' || !content.guide ||
        !Array.isArray(content.entries) || !content.entries.length) throw new Error('CHAT_SUMMARY_CONTENT_INVALID');
    const cleaned={text:content.text,guide:content.guide,entries:content.entries.map((entry,index)=>{
      if(!entry || typeof entry.text!=='string' || !entry.text || !Array.isArray(entry.refs) || !entry.refs.length ||
          entry.refs.some(r=>typeof r!=='string')) throw new Error('CHAT_SUMMARY_SOURCE_REQUIRED');
      const normalized=entry.refs.map(r=>!leaf&&/^(L[1-9]\d*-[a-f0-9-]{36}@v[1-9]\d*)\/(I\d+)$/.test(r)?r.replace(/\/(I\d+)$/,'#$1'):r);
      for(const r of normalized) {
        if(leaf) {
          if(!r.startsWith(`${conversationId}/M`) || typeof this.resolveSource!=='function' || !this.resolveSource(r)) throw new Error('CHAT_SUMMARY_SOURCE_UNRESOLVED');
        } else if(!sources.some(child=>{
          const childRef=typeof child==='string'?child:ref(child);
          if(r===childRef)return true;
          if(typeof child==='string')return false;
          return child.content.entries.some(entry=>r===`${childRef}#${entry.id}`);
        })) throw new Error('CHAT_SUMMARY_DIRECT_CHILD_REQUIRED');
      }
      return {id:`I${String(index+1).padStart(2,'0')}`,text:entry.text,refs:[...new Set(normalized)]};
    })};
    within(cleaned,limit,this.countTokens); return cleaned;
  }
  async publishLeaf({ conversationId, sourceFingerprint, content, sourceComplete, summarize, recoverLeafId, currentProjection, projectionWatermark, compact }) {
    if (typeof compact === 'function') return this._publishFrontierLeaf({ conversationId, sourceFingerprint, content, sourceComplete, summarize, compact, currentProjection, projectionWatermark });
    if(!/^C-[a-zA-Z0-9-]+$/.test(conversationId||'') || !/^[a-f0-9]{64}$/.test(sourceFingerprint||'') || sourceComplete!==true)
      throw new Error('CHAT_SUMMARY_COMPLETE_SOURCE_REQUIRED');
    const old=this.state(), state=structuredClone(old), writes=[];
    const prior=state.conversations[conversationId];
    if(prior && prior.sourceFingerprint===sourceFingerprint) return {reused:true,root:state.root,leaf:prior.ref};
    const validated=this.validateContent(content,[],{leaf:true,conversationId}), preparationPath=`memory/summaries/prepared/${conversationId}-${sourceFingerprint}.jsonl`;
    const prepared=this.journal.read(preparationPath);
    if(prepared&&(prepared.sourceFingerprint!==sourceFingerprint||prepared.baseRevision!==old.revision||!/^L1-[a-f0-9-]{36}$/.test(prepared.leafId)))throw new Error('CHAT_SUMMARY_PREPARATION_CHANGED');
    const recovered=!prior&&!prepared&&typeof recoverLeafId==='function'?recoverLeafId({conversationId,sourceFingerprint,content:validated,old}):null;
    if(recovered&&!/^L1-[a-f0-9-]{36}$/.test(recovered))throw new Error('CHAT_SUMMARY_PREPARATION_INVALID');
    const leafId=prior?this.read(prior.ref).id:prepared?.leafId||recovered||`L1-${randomUUID()}`;
    if(!prepared)this.journal.write(preparationPath,{sourceFingerprint,baseRevision:old.revision,leafId},{exclusive:true});
    const leaf={id:leafId,level:1,version:prior?this.read(prior.ref).version+1:1,conversationId,
      sourceFingerprint,children:[],leaves:1,content:validated};
    const save=node=>{writes.push(node);state.active[node.id]=ref(node);return node;};
    const get=r=>writes.find(n=>ref(n)===r)||this.read(r);
    const parent=async(children,previous)=>{
      if(children.length<1||children.length>LIMITS.children) throw new Error('CHAT_SUMMARY_BRANCH_BUDGET');
      const level=children[0].level+1;
      if(children.some(c=>c.level!==level-1)) throw new Error('CHAT_SUMMARY_LEVEL_INVALID');
      const refs=children.map(ref);
      const visible=typeof currentProjection==='function'?children.map(child=>currentProjection(child)):children;
      within(visible.map(c=>c.content),LIMITS.parentInput,this.countTokens);
      const next={id:previous?.id||stableNodeId(level,refs),level,version:(previous?.version||0)+1,
        children:refs,leaves:children.reduce((n,c)=>n+c.leaves,0),...(projectionWatermark?{currentProjectionWatermark:projectionWatermark}:{})};
      let output;
      if(children.length===1) {
        // Structural single-child reuse, with explicit direct-child provenance.
        output={text:visible[0].content.text,guide:`${refs[0]}: ${visible[0].content.guide}`,
          entries:visible[0].content.entries.map(e=>({text:e.text,refs:[`${refs[0]}#${e.id}`]}))};
      } else {
        if(typeof summarize!=='function') throw new Error('CHAT_SUMMARY_GENERATOR_UNREADY');
        output=await summarize({level,children:visible.map(c=>({ref:ref(c),content:c.content})),inputLimit:LIMITS.parentInput,outputLimit:LIMITS.node});
      }
      next.content=this.validateContent(output,children);return save(next);
    };
    save(leaf);
    const branch=async(level)=>level===1?leaf:parent([await branch(level-1)]);
    const append=async(node)=>{
      if(node.level===1) return parent([node,leaf]);
      const children=node.children.map(get), last=children.at(-1);
      if(last.leaves<4**(last.level-1)) children[children.length-1]=await append(last);
      else if(children.length<4) children.push(await branch(node.level-1));
      else return parent([node,await branch(node.level)]);
      return parent(children,node);
    };
    const replace=async(node)=>{
      if(node.id===leaf.id) return leaf;
      if(node.level===1) return node;
      const children=node.children.map(get);let changed=false;
      for(let i=0;i<children.length;i++) {const next=await replace(children[i]);if(ref(next)!==ref(children[i])){children[i]=next;changed=true;}}
      return changed?parent(children,node):node;
    };
    const root=!old.root?leaf:prior?await replace(this.read(old.root)):await append(this.read(old.root));
    state.root=ref(root);state.conversations[conversationId]={ref:ref(leaf),sourceFingerprint};state.revision++;
    // A delayed generation can never overwrite a newer published tree.
    this.journal.locked('memory/summaries/write.lock',()=>{
      if(this.state().revision!==old.revision) throw new Error('CHAT_SUMMARY_BASELINE_CHANGED');
      for(const node of writes) this.journal.write(`memory/summaries/nodes/${ref(node)}.jsonl`,node,{exclusive:true});
      this.journal.write('memory/summaries/head.jsonl',state);
    });
    return {reused:false,root:state.root,leaf:ref(leaf),updated:writes.map(ref)};
  }
  async _publishFrontierLeaf({ conversationId, sourceFingerprint, content, sourceComplete, summarize, compact, currentProjection, projectionWatermark }) {
    if (!/^C-[a-zA-Z0-9-]+$/.test(conversationId || '') || !/^[a-f0-9]{64}$/.test(sourceFingerprint || '') || sourceComplete !== true) throw new Error('CHAT_SUMMARY_COMPLETE_SOURCE_REQUIRED');
    const old = this.state(), prior = old.conversations[conversationId];
    if (prior?.sourceFingerprint === sourceFingerprint) return { reused: true, root: old.root, leaf: prior.ref, frontier: true };
    if (prior?.history?.some(item => item.sourceFingerprint === sourceFingerprint)) throw new Error('CHAT_SUMMARY_SOURCE_ALREADY_SUPERSEDED');
    const validated = this.validateContent(content, [], { leaf: true, conversationId });
    const preparedPath = `memory/summaries/frontier-prepared/${conversationId}-${sourceFingerprint}.jsonl`, prepared = this.journal.read(preparedPath);
    if (prepared && (prepared.baseRevision !== old.revision || prepared.contentDigest !== digest(validated))) throw new Error('CHAT_SUMMARY_PREPARATION_CHANGED');
    const legacyPrepared = !prior && this.journal.read(`memory/summaries/prepared/${conversationId}-${sourceFingerprint}.jsonl`);
    const leafId = prepared?.leafId || (legacyPrepared?.baseRevision === old.revision ? legacyPrepared.leafId : null) || stableNodeId(1, [conversationId, sourceFingerprint, String(old.revision)]);
    if (!/^L1-[a-f0-9-]{36}$/.test(leafId)) throw new Error('CHAT_SUMMARY_PREPARATION_INVALID');
    if (!prepared) this.journal.write(preparedPath, { schema: 'codex-maid-frontier-prepared/1', baseRevision: old.revision, contentDigest: digest(validated), leafId }, { exclusive: true });
    const state = structuredClone(old), writes = new Map(); state.layout = 'append-quarter/1';
    const leaf = { id: leafId, level: 1, version: 1, conversationId, sourceFingerprint, children: [], leaves: 1, status: 1, content: validated, ...(prior ? { supersedes: prior.ref } : {}) };
    const save = node => { writes.set(ref(node), node); state.active[node.id] = ref(node); return node; };
    const get = reference => writes.get(reference) || this.read(reference);
    // New parents already incorporate projected children. Their references
    // may point at this transaction's unpublished nodes, so projecting them
    // again through the on-disk reader would invent unresolved provenance.
    const visible = node => node.level > 1 && writes.has(ref(node)) ? node : typeof currentProjection === 'function' ? currentProjection(node) : node;
    const immutable = (relative, value) => {
      const existing = this.journal.read(relative);
      if (existing) { if (digest(existing) !== digest(value)) throw new Error('CHAT_SUMMARY_IMMUTABLE_CONFLICT'); return; }
      this.journal.write(relative, value, { exclusive: true });
    };
    const primes = new Map();
    const primeFor = async child => {
      const childRef = ref(child); if (primes.has(childRef)) return primes.get(childRef);
      let prime = this.readPrime(childRef);
      if (prime) {
        if (prime.leafRef !== childRef || prime.sourceFingerprint !== child.sourceFingerprint) throw new Error('CHAT_SUMMARY_PRIME_CHANGED');
        if (digest(this.validateContent(prime.content, [child], { limit: LIMITS.leafPrime })) !== digest(prime.content)) throw new Error('CHAT_SUMMARY_PRIME_CHANGED');
      } else {
        const output = await compact({ leaf: { ref: childRef, content: visible(child).content }, inputLimit: LIMITS.node, outputLimit: LIMITS.leafPrime });
        prime = { schema: 'codex-maid-leaf-prime/1', leafRef: childRef, sourceFingerprint: child.sourceFingerprint, content: this.validateContent(output, [child], { limit: LIMITS.leafPrime }) };
        // Independent immutable artifact: retain completed generation on any
        // later parent/head failure. Structural children still reference L1.
        immutable(`memory/summaries/primes/${childRef}.jsonl`, prime);
      }
      primes.set(childRef, prime); return prime;
    };
    const copyChild = child => ({ text: child.content.text, guide: child.content.guide,
      entries: child.content.entries.map(entry => ({ text: entry.text, refs: [`${ref(child)}#${entry.id}`] })) });
    const combine = (pieces, limit) => {
      const combined = { text: pieces.map(piece => piece.text).join('\n'), guide: '按保存的来源和待整合条目回查；待整合副本不改变结构层级。',
        entries: pieces.flatMap(piece => piece.entries).map((entry, index) => ({ id: `I${String(index + 1).padStart(2, '0')}`, text: entry.text, refs: [...entry.refs] })) };
      within(combined, limit, this.countTokens); return combined;
    };
    const pending = async (children, previous, isRoot) => {
      const level = children[0].level + 1;
      if (children.length > LIMITS.children || children.some(child => child.level !== level - 1)) throw new Error('CHAT_SUMMARY_LEVEL_INVALID');
      if (previous?.status === 2) throw new Error('CHAT_SUMMARY_SEALED');
      let integration, nextContent;
      if (level === 2) {
        const tail = []; for (const child of children) { const prime = await primeFor(child); tail.push({ leafRef: ref(child), content: prime.content }); }
        integration = { rootView: isRoot, baseContent: null, baseChildren: [], tail };
        nextContent = combine(tail.map(item => item.content), isRoot ? LIMITS.root : LIMITS.node);
      } else {
        // Keep the last formal body together with its historical child
        // versions. Changing structural pointers never relabels its sources.
        let baseContent = previous?.integration?.baseContent || (previous ? previous.content : null);
        let baseChildren = previous?.integration?.baseChildren || (previous ? previous.children : []);
        if (!previous) { baseContent = copyChild(visible(children[0])); baseChildren = [ref(children[0])]; }
        const tail = previous?.integration?.tail ? [...previous.integration.tail] : [];
        if (isRoot && !tail.some(item => item.leafRef === ref(leaf))) {
          const prime = await primeFor(leaf); tail.push({ leafRef: ref(leaf), content: prime.content });
        }
        // A new upper root's first child is the old sealed root; the pending
        // new L1 lives in another child and is appended exactly once.
        integration = { rootView: isRoot, baseContent, baseChildren, tail };
        nextContent = isRoot ? combine([baseContent, ...tail.map(item => item.content)], LIMITS.root) : previous?.content || this.validateContent(copyChild(visible(children[0])), children);
      }
      return save({ id: previous?.id || stableNodeId(level, children.map(ref)), level, version: (previous?.version || 0) + 1,
        children: children.map(ref), leaves: children.reduce((sum, child) => sum + child.leaves, 0), status: 0, content: nextContent, integration });
    };
    const formal = async (children, previous, isRoot) => {
      const level = children[0].level + 1, projected = children.map(visible);
      if (previous?.status === 2) throw new Error('CHAT_SUMMARY_SEALED');
      if (children.length > LIMITS.children || children.some(child => child.level !== level - 1)) throw new Error('CHAT_SUMMARY_LEVEL_INVALID');
      within(projected.map(child => child.content), LIMITS.parentInput, this.countTokens);
      if (children.length > 1 && typeof summarize !== 'function') throw new Error('CHAT_SUMMARY_GENERATOR_UNREADY');
      const output = children.length === 1 ? copyChild(projected[0]) : await summarize({ level, children: projected.map(child => ({ ref: ref(child), content: child.content })), inputLimit: LIMITS.parentInput, outputLimit: LIMITS.node });
      const clean = this.validateContent(output, children), sealed = children.length === LIMITS.children && children.every(child => child.level === 1 || child.status === 2);
      return save({ id: previous?.id || stableNodeId(level, children.map(ref)), level, version: (previous?.version || 0) + 1,
        children: children.map(ref), leaves: children.reduce((sum, child) => sum + child.leaves, 0), status: sealed ? 2 : 1, content: clean,
        ...(projectionWatermark ? { currentProjectionWatermark: projectionWatermark } : {}) });
    };
    save(leaf);
    const oldRoot = old.root ? this.read(old.root) : null;
    // Every fourth leaf closes its L2. No prime is generated for that leaf;
    // all ancestors on that path are regenerated from direct children.
    const integrate = !!prior || (oldRoot ? (oldRoot.leaves + 1) % LIMITS.children === 0 : false);
    const make = (children, previous, isRoot) => integrate ? formal(children, previous, isRoot) : pending(children, previous, isRoot);
    const branch = async level => level === 1 ? leaf : make([await branch(level - 1)], null, false);
    const append = async (node, isRoot = true) => {
      if (node.level === 1) return make([node, leaf], null, isRoot);
      if (node.status === 2 || node.leaves === LIMITS.children ** (node.level - 1)) return make([node, await branch(node.level)], null, isRoot);
      const children = node.children.map(get), last = children.at(-1);
      if (last.level > 1 && last.status !== 2 && last.leaves < LIMITS.children ** (last.level - 1)) children[children.length - 1] = await append(last, false);
      else if (children.length < LIMITS.children) children.push(await branch(node.level - 1));
      else throw new Error('CHAT_SUMMARY_BRANCH_BUDGET');
      return make(children, node, isRoot);
    };
    const replace = async (node, isRoot = true) => {
      if (ref(node) === prior.ref) { delete state.active[node.id]; return { node: leaf, changed: true }; }
      if (node.level === 1) return { node, changed: false };
      const children = node.children.map(get); let changed = false;
      for (let index = 0; index < children.length; index++) {
        const next = await replace(children[index], false); if (next.changed) { children[index] = next.node; changed = true; }
      }
      if (!changed) return { node, changed: false };
      // A changed source replaces its current logical position. Sealed bytes
      // remain historical; a distinct ancestor identity carries the revision.
      // Regenerate this path so no obsolete base/tail remains current.
      if (node.level === 2 && children.length < LIMITS.children) await primeFor(leaf);
      const identity = stableNodeId(node.level, ['source-revision', ref(node), ...children.map(ref)]);
      const revised = await formal(children, { ...node, id: identity, version: 0, status: 1 }, isRoot);
      delete state.active[node.id]; return { node: revised, changed: true };
    };
    let root;
    if (prior) {
      const revised = await replace(oldRoot); if (!revised.changed) throw new Error('CHAT_SUMMARY_CURRENT_LEAF_MISSING'); root = revised.node;
      if (root.level === 1) root = await pending([root], null, true);
    } else root = oldRoot ? await append(oldRoot) : await pending([leaf], null, true);
    state.root = ref(root); state.revision++;
    state.conversations[conversationId] = { ref: ref(leaf), sourceFingerprint, ...(prior ? { history: [...(prior.history || []), { ref: prior.ref, sourceFingerprint: prior.sourceFingerprint }] } : {}) };
    this.journal.locked('memory/summaries/write.lock', () => {
      if (this.state().revision !== old.revision) throw new Error('CHAT_SUMMARY_BASELINE_CHANGED');
      for (const node of writes.values()) immutable(`memory/summaries/nodes/${ref(node)}.jsonl`, node);
      this.journal.write('memory/summaries/head.jsonl', state);
    });
    return { reused: false, frontier: true, integrated: root.status !== 0, root: state.root, leaf: ref(leaf), prime: primes.has(ref(leaf)) ? ref(leaf) : null, updated: [...writes.keys()] };
  }
}

// Sources may be ranges of one long message; the ranges remain internal and do
// not create additional formal L1 nodes. The supplied meter is exact for tests
// or verified for the selected runtime model, never a fixed character divisor.
function* batchIterator(parts,{countTokens,limit=LIMITS.sourceBatch,carry=''}={}) {
  within(carry,limit,countTokens);
  let batch=[];
  for(const part of parts) {
    if(typeof part.ref!=='string'||typeof part.text!=='string') throw new Error('CHAT_SOURCE_INVALID');
    let offset=0;const chars=Array.from(part.text);
    if(!chars.length) continue;
    while(offset<chars.length) {
      let low=1,high=Math.min(chars.length-offset,limit*4),fit=0;
      while(low<=high) {
        const length=Math.floor((low+high)/2),candidate={ref:part.ref,start:offset,end:offset+length,unit:'unicode-code-point',text:chars.slice(offset,offset+length).join('')};
        try {within({carry,parts:[...batch,candidate]},limit,countTokens);fit=length;low=length+1;}
        catch(error) {if(!String(error.message).includes('BUDGET'))throw error;high=length-1;}
      }
      if(!fit) {if(batch.length){yield batch;batch=[];continue;}throw new Error('CHAT_SOURCE_WINDOW_TOO_SMALL');}
      batch.push({ref:part.ref,start:offset,end:offset+fit,unit:'unicode-code-point',text:chars.slice(offset,offset+fit).join('')});offset+=fit;
      if(offset<chars.length){yield batch;batch=[];}
    }
  }
  if(batch.length)yield batch;
}
function sourceBatches(parts,options){return [...batchIterator(parts,options)];}
async function sourceBatchesAsync(parts,options){const output=[];for(const batch of batchIterator(parts,options)){output.push(batch);await new Promise(resolve=>setImmediate(resolve));}return output;}
module.exports={SummaryTree,sourceBatches,sourceBatchesAsync,digest};
