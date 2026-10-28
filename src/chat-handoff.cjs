'use strict';
const { randomUUID } = require('node:crypto');
const { ChatJournal } = require('./chat-journal.cjs');
const { LIMITS, tokens, within } = require('./chat-policy.cjs');

// Ranges use decoded Unicode code points, not file bytes, UTF-16 offsets or
// tokens. Exact quotations always come from committed JSONL, never a model.
function quote(part, start, end) {
  return { ref:part.ref,role:part.role,time:part.time??null,unit:'unicode-code-point',start,end,
    excerpt:true,text:Array.from(part.text).slice(start,end).join('') };
}
function latestOriginals(parts,{countTokens,limit=LIMITS.handoffOriginal}={}) {
  if(!Array.isArray(parts))throw new Error('CHAT_ORIGINALS_INVALID');
  if(!parts.length)return [];
  for(const p of parts)if(!p || typeof p.text!=='string'||typeof p.ref!=='string'||!['user','assistant'].includes(p.role))throw new Error('CHAT_ORIGINALS_INVALID');
  const meaningful=parts.filter(p=>p.text.length);
  if(!meaningful.length)throw new Error('CHAT_ORIGINALS_EMPTY');
  let selected=[];
  for(let i=meaningful.length-1;i>=0;i--) {
    const p=meaningful[i],length=Array.from(p.text).length;
    const whole=quote(p,0,length);whole.excerpt=false;
    if(tokens([whole,...selected],countTokens)<=limit){selected.unshift(whole);continue;}
    // A long latest answer must not erase the latest question, or vice versa.
    // Keep exact start and end ranges where possible, including late negation.
    if(new Set(selected.map(item=>item.ref)).size>=2)break;
    const available=Math.max(0,limit-tokens(selected,countTokens));
    const partLimit=Math.floor(available/(i>0&&selected.length===0?2:1));
    let low=1,high=length,fit=null;
    while(low<=high){
      const n=Math.floor((low+high)/2),head=Math.floor(n*.4),tail=n-head;
      const ranges=head>0?[quote(p,0,head),quote(p,length-tail,length)]:[quote(p,length-tail,length)];
      if(tokens(ranges,countTokens)<=partLimit && tokens([...ranges,...selected],countTokens)<=limit){fit=ranges;low=n+1;}
      else high=n-1;
    }
    if(fit) selected=[...fit,...selected];
    else if(!selected.length)throw new Error('CHAT_ORIGINALS_REPAIR_REQUIRED');
  }
  if(!selected.length)throw new Error('CHAT_ORIGINALS_REPAIR_REQUIRED');
  within(selected,limit,countTokens);return selected;
}

class HandoffStore {
  constructor({projectRoot,fs,countTokens,resolveSource}={}) {
    this.journal=new ChatJournal(projectRoot,{fs});this.countTokens=countTokens;this.resolveSource=resolveSource;
  }
  current(){return this.journal.read('memory/recent/current.jsonl');}
  read(reference){
    if(typeof reference!=='string'||!/^R-[a-f0-9-]{36}@v[1-9]\d*$/.test(reference))throw new Error('CHAT_HANDOFF_REF_INVALID');
    for(const name of ['current','previous']) {
      const value=this.journal.read(`memory/recent/${name}.jsonl`);
      if(value&&`${value.id}@v${value.version}`===reference)return value;
    }
    // Older builds may already have written versions: preserve and resolve
    // them, without continuing an unbounded automatic snapshot series.
    const saved=this.journal.read(`memory/recent/pinned/${reference}.jsonl`)||this.journal.read(`memory/recent/versions/${reference}.jsonl`);
    if(!saved||`${saved.id}@v${saved.version}`!==reference)throw new Error('CHAT_HANDOFF_REFERENCE_MISSING');
    return saved;
  }
  pin(reference){
    return this.journal.locked('memory/recent/write.lock',()=>{
      const value=this.read(reference),relative=`memory/recent/pinned/${reference}.jsonl`,old=this.journal.read(relative);
      if(!old)this.journal.write(relative,value,{exclusive:true});
      return value;
    });
  }
  publish({taskId,baseVersion=0,sourceWatermark,operationWatermark,summary,originals,hasHistory=true,sourceRefs,complete}) {
    if(complete!==true || typeof taskId!=='string'||!taskId||typeof sourceWatermark!=='string'||!sourceWatermark||!Number.isSafeInteger(operationWatermark)||operationWatermark<0||!Number.isSafeInteger(baseVersion)||baseVersion<0||
        typeof summary!=='string'||!Array.isArray(originals)||!Array.isArray(sourceRefs)||
        (hasHistory&&!originals.length)||!sourceRefs.length||sourceRefs.some(r=>typeof r!=='string'||!r)) throw new Error('CHAT_HANDOFF_SOURCE_REQUIRED');
    if(typeof this.resolveSource!=='function'||[...sourceRefs,...originals.map(o=>o.ref)].some(r=>!this.resolveSource(r)))throw new Error('CHAT_HANDOFF_SOURCE_UNRESOLVED');
    // Text supplied as an original is re-read/verified against its exact source.
    for(const original of originals){
      const source=this.resolveSource(original.ref);
      if(typeof source?.text!=='string'||original.unit!=='unicode-code-point'||!Number.isSafeInteger(original.start)||!Number.isSafeInteger(original.end)||
         original.start<0||original.end<=original.start||original.end>Array.from(source.text).length||original.role!==source.role||
         (original.time??null)!==(source.time??null)||
         Array.from(source.text).slice(original.start,original.end).join('')!==original.text)throw new Error('CHAT_HANDOFF_QUOTE_MISMATCH');
    }
    const summaryView={text:summary,refs:sourceRefs};
    within(summaryView,LIMITS.handoffSummary,this.countTokens);
    within(originals,LIMITS.handoffOriginal,this.countTokens);
    const modelView={summary:summaryView,originals};within(modelView,LIMITS.handoff,this.countTokens);
    return this.journal.locked('memory/recent/write.lock',()=>{
      const old=this.current();
      if(old?.taskId===taskId){if(old.sourceWatermark!==sourceWatermark||old.operationWatermark!==operationWatermark)throw new Error('CHAT_HANDOFF_BASELINE_CHANGED');return old;}
      if((old?.version||0)!==baseVersion)throw new Error('CHAT_HANDOFF_BASELINE_CHANGED');
      const next={schema:'codex-maid-handoff/1',id:old?.id||`R-${randomUUID()}`,version:baseVersion+1,taskId,
        sourceWatermark,operationWatermark,sourceRefs,modelView,tokens:tokens(modelView,this.countTokens)};
      // Exactly two ordinary recovery snapshots. Versions used by a lasting
      // citation must be pinned explicitly before they leave this pair.
      if(old)this.journal.write('memory/recent/previous.jsonl',old);
      this.journal.write('memory/recent/current.jsonl',next);return next;
    });
  }
}
module.exports={latestOriginals,HandoffStore};
