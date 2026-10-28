'use strict';
const { tokens } = require('./chat-policy.cjs');

function terms(text) {
  if(typeof text!=='string')throw new Error('CHAT_SEARCH_TEXT_INVALID');
  const result=[];
  for(const word of text.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}_]+/gu)||[]) {
    const runs=word.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+|[^\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+/gu)||[];
    for(const run of runs) {
      if(/^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(run)) {
        const chars=Array.from(run);result.push(...chars);
        for(let i=0;i+1<chars.length;i++)result.push(chars[i]+chars[i+1]);
      } else result.push(run);
    }
  }
  return result;
}
// Query-only stop words avoid promoting ubiquitous grammatical matches over a
// real semantic paraphrase. Stored postings and original text stay unchanged.
const QUERY_STOP_WORDS = new Set('a an the i me my mine we our you your he she it they is are was were be been am do does did to of in on at for and or that this these those what which who when where why how please can could would should have has had with as from by about want find'.split(' '));
function queryTerms(text) {
  const all = [...new Set(terms(text))], pairs = all.some(term => /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]{2}$/u.test(term));
  const filtered = all.filter(term => !QUERY_STOP_WORDS.has(term) && (!pairs || !/^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]$/u.test(term)));
  return filtered.slice(0, 64);
}
function scriptGroup(text) {
  const han = (text.match(/[\p{Script=Han}]/gu) || []).length, latin = (text.match(/[A-Za-z]/g) || []).length;
  return han * 2 > latin ? 'han' : latin ? 'latin' : 'other';
}
function explicitAliases(text) {
  const result = [], pattern = /[“"「]([^”"」\n]{1,40})[”"」]\s*(?:也叫|又名|昵称是|也称为|also known as|aka)\s*[“"「]([^”"」\n]{1,40})[”"」]/giu;
  for (const match of text.matchAll(pattern)) {
    const before = text.slice(Math.max(0, match.index - 40), match.index), after = text.slice(match.index + match[0].length, match.index + match[0].length + 80).split(/[。！!;；\n]/u)[0];
    if (/maybe|perhaps|might|可能|也许|假如|不确定|不是|并非/iu.test(before) || /[?？]|错误|错了|不对|猜测|推测|尚未确认|未确认|不确定|并非|不是|传闻|听说|据说|incorrect|wrong|unconfirmed|uncertain|guess|speculat|rumou?r|not\b|may\b|might\b/iu.test(after)) continue;
    const a = match[1].trim().normalize('NFKC').toLowerCase(), b = match[2].trim().normalize('NFKC').toLowerCase(); if (a && b && a !== b) result.push([a, b]); if (result.length === 8) break;
  }
  return result;
}
function reciprocalRankFusion(lists,k=60) {
  if(!Number.isFinite(k)||k<1)throw new Error('CHAT_RRF_INVALID');
  const scores=new Map();
  for(const list of lists){const seen=new Set();list.forEach((ref,i)=>{if(!seen.has(ref)){seen.add(ref);scores.set(ref,(scores.get(ref)||0)+1/(k+i+1));}});}
  return [...scores].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0])).map(([ref,score])=>({ref,score}));
}

// Calibrated on the checked-in retrieval-ranking sample set. RRF remains the
// primary order: metadata may only reorder within 1.8% of a group's anchor.
const NEAR_RRF_RATIO = 0.018;
function rerankNear(results, byRef, { historical = false, nearRatio = NEAR_RRF_RATIO, timeBasis = 'discussion' } = {}) {
  const rank = value => ({ user_marked: 2, notable: 1, normal: 0 }[value] || 0);
  const output = [];
  for (let first = 0; first < results.length;) {
    let end = first + 1; const anchor = results[first].score;
    while (end < results.length && (anchor - results[end].score) / anchor <= nearRatio) end++;
    output.push(...results.slice(first, end).sort((a, b) => {
      const left = byRef.get(a.ref)?.metadata || {}, right = byRef.get(b.ref)?.metadata || {};
      const importance = rank(right.importance) - rank(left.importance); if (importance) return importance;
      if (!historical) { const time = Date.parse(timeBasis === 'event' ? right.eventTime : right.discussedAt) - Date.parse(timeBasis === 'event' ? left.eventTime : left.discussedAt); if (Number.isFinite(time) && time) return time; }
      return b.score - a.score || a.ref.localeCompare(b.ref);
    })); first = end;
  }
  return output;
}
function evidenceDuplicate(candidate, selected) {
  const a = candidate.metadata || {}, b = selected.metadata || {};
  if (a.conflict || b.conflict || a.eventStatus === 'disputed' || b.eventStatus === 'disputed') return false;
  // Exact fact identities include the revision; changed/contradictory facts are
  // intentionally kept. A whole message identity never collapses all its facts.
  if (a.factRefs?.length && b.factRefs?.length) return a.factRefs.length === b.factRefs.length && a.factRefs.every(ref => b.factRefs.includes(ref));
  if (a.textHash && a.textHash === b.textHash && a.sources?.some(ref => b.sources?.includes(ref))) return true;
  if ((a.claimRanges || []).some(left => (b.claimRanges || []).some(right => left.sourceRef === right.sourceRef && left.start === right.start && left.end === right.end && left.textHash === right.textHash))) return true;
  if (a.sourceRef !== b.sourceRef || !a.sourceRef || !Number.isFinite(a.start) || !Number.isFinite(b.start)) return false;
  const overlap = Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
  return overlap >= 0.8 * Math.min(a.end - a.start, b.end - b.start);
}

class ChatSearch {
  constructor({readSource,isEffective=()=>false,getWatermark=()=>null,countTokens,Database}={}) {
    if(typeof readSource!=='function')throw new Error('CHAT_SEARCH_SOURCE_REQUIRED');
    this.readSource=readSource;this.isEffective=isEffective;this.getWatermark=getWatermark;this.countTokens=countTokens;
    this.turns=new WeakMap();
    const DatabaseSync=Database||require('node:sqlite').DatabaseSync;
    // Derived index contains token postings and references; FTS has no content
    // table and never holds a second readable copy of archived message bodies.
    this.db=new DatabaseSync(':memory:');this.rebuild([]);
  }
  rebuild(documents) {
    if(!Array.isArray(documents))throw new Error('CHAT_SEARCH_DOCUMENTS_INVALID');
    this.db.exec('BEGIN');let row=0;
    try {
      this.db.exec("DROP TABLE IF EXISTS postings; DROP TABLE IF EXISTS refs; CREATE VIRTUAL TABLE postings USING fts5(terms,content=''); CREATE TABLE refs(rowid INTEGER PRIMARY KEY,ref TEXT UNIQUE NOT NULL,kind TEXT NOT NULL);");
      const insert=this.db.prepare('INSERT INTO postings(rowid,terms) VALUES(?,?)');
      const ref=this.db.prepare('INSERT INTO refs(rowid,ref,kind) VALUES(?,?,?)');
      for(const doc of documents) {
        if(!doc || doc.committed!==true || doc.internalBatch===true)continue;
        if(typeof doc.ref!=='string'||!['original','summary','persona','userView','facts'].includes(doc.kind)||typeof doc.text!=='string')throw new Error('CHAT_SEARCH_DOCUMENT_INVALID');
        row++;ref.run(row,doc.ref,doc.kind);insert.run(row,terms(doc.text).join(' '));
      }
      this.db.exec('COMMIT');this.indexedWatermark=this.getWatermark();return {indexed:row,backend:'sqlite-fts5-bm25',semantic:'not-configured'};
    } catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  beginTurn(id) {
    if(typeof id!=='string'||!id)throw new Error('CHAT_SEARCH_TURN_REQUIRED');
    const state={searches:0,reads:0,used:0,delivered:new Set()};
    const turn=Object.freeze({id,get searches(){return state.searches;},get reads(){return state.reads;},get used(){return state.used;}});
    this.turns.set(turn,state);return turn;
  }
  _fit(value,budget) { return tokens(value,this.countTokens)<=budget; }
  search(query,turn,{intent='current'}={}) {
    const state=turn&&this.turns.get(turn);
    if(!state||state.searches>=2)throw new Error('CHAT_SEARCH_CALL_LIMIT');
    if(typeof query!=='string'||Array.from(query).length>256||!['current','history'].includes(intent))throw new Error('CHAT_SEARCH_QUERY_INVALID');
    // Validate metering before mutating the turn's tool budget.
    tokens('',this.countTokens);state.searches++;
    const epoch=this.getWatermark();const queryTerms=[...new Set(terms(query))].slice(0,64);
    const hasCjkPairs=queryTerms.some(s=>/^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]{2}$/u.test(s));
    const preferred=hasCjkPairs?queryTerms.filter(s=>!/^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]$/u.test(s)):queryTerms;
    const match=preferred.map(s=>`"${s.replaceAll('"','""')}"`).join(' OR ');
    const rows=match?this.db.prepare('SELECT refs.ref,refs.kind,bm25(postings) AS rank FROM postings JOIN refs ON refs.rowid=postings.rowid WHERE postings MATCH ? ORDER BY rank LIMIT 64').all(match):[];
    const cards=[];const max=Math.min(1200,3000-state.used);
    for(const row of rows){
      if(cards.length>=4)break;
      if(!this.isEffective(row.ref,{intent}))continue;
      const source=this.readSource(row.ref);
      if(!source||source.committed!==true||typeof source.text!=='string')continue;
      const card={ref:row.ref,kind:row.kind,time:source.time??null,historical:intent==='history'||row.kind==='original',snippet:''};
      const chars=Array.from(source.text);const normalized=source.text.toLowerCase();
      const needle=queryTerms.find(term=>normalized.includes(term));const start=needle?Math.max(0,Array.from(source.text.slice(0,normalized.indexOf(needle))).length-50):0;
      let low=0,high=Math.min(500,chars.length-start),fit=null;
      while(low<=high){const n=Math.floor((low+high)/2),candidate={...card,snippet:chars.slice(start,start+n).join(''),excerpt:true,start,unit:'unicode-code-point'};
        if(this._fit({cards:[...cards,candidate],coverage:this.indexedWatermark,semantic:'not-configured'},max)){fit=candidate;low=n+1;}else high=n-1;}
      if(fit&&fit.snippet)cards.push(fit);
    }
    // Management saves invalidate results even while an index rebuild lags.
    if(this.getWatermark()!==epoch)throw new Error('CHAT_SEARCH_BASELINE_CHANGED');
    const result={cards:cards.filter(c=>this.isEffective(c.ref,{intent})),coverage:this.indexedWatermark,semantic:'not-configured'};
    if(this.getWatermark()!==epoch)throw new Error('CHAT_SEARCH_BASELINE_CHANGED');
    const used=tokens(result,this.countTokens);if(used>max)throw new Error('CHAT_SEARCH_BUDGET_EXCEEDED');
    state.used+=used;for(const c of result.cards)state.delivered.add(c.ref);return result;
  }
  read(reference,turn,{start=0,end,intent='current'}={}) {
    const state=turn&&this.turns.get(turn);
    if(!state||state.reads>=1)throw new Error('CHAT_SEARCH_CALL_LIMIT');
    if(!['current','history'].includes(intent))throw new Error('CHAT_SEARCH_QUERY_INVALID');
    tokens('',this.countTokens);
    // A caller with an exact, project-scoped stable reference need not search
    // first. readSource and the effective-state resolver are the authority.
    if(typeof reference!=='string'||!this.isEffective(reference,{intent}))throw new Error('CHAT_SEARCH_REFERENCE_UNAVAILABLE');
    const epoch=this.getWatermark(),source=this.readSource(reference);
    if(source?.committed!==true||typeof source.text!=='string')throw new Error('CHAT_SEARCH_REFERENCE_UNAVAILABLE');
    const chars=Array.from(source.text);end=end??Math.min(chars.length,start+1200);
    if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||end<start||end>chars.length)throw new Error('CHAT_SEARCH_RANGE_INVALID');
    const result={ref:reference,role:source.role??null,time:source.time??null,start,end,unit:'unicode-code-point',excerpt:start>0||end<chars.length,text:chars.slice(start,end).join(''),historical:intent==='history'};
    const used=tokens(result,this.countTokens);
    if(used>Math.min(1600,3000-state.used))throw new Error('CHAT_SEARCH_BUDGET_EXCEEDED');
    if(this.getWatermark()!==epoch||!this.isEffective(reference,{intent}))throw new Error('CHAT_SEARCH_BASELINE_CHANGED');
    state.used+=used;state.reads++;return result;
  }
  close(){this.db.close();}
}
module.exports={ChatSearch,terms,queryTerms,scriptGroup,explicitAliases,reciprocalRankFusion,rerankNear,evidenceDuplicate,NEAR_RRF_RATIO};
