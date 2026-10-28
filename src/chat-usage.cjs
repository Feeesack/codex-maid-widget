'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { ChatJournal } = require('./chat-journal.cjs');

const FIELDS = ['inputTokens', 'cachedInputTokens', 'outputTokens', 'reasoningOutputTokens', 'totalTokens'];
const KINDS = new Set(['chat', 'maintenance', 'dream']);
const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'interrupted', 'unknown', 'not-executed', 'invalid-output']);
const digest = value => createHash('sha256').update(String(value)).digest('hex');
const text = (value, limit = 256) => typeof value === 'string' && value.length > 0 && value.length <= limit && !/[\u0000-\u001f]/.test(value) ? value : null;
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const emptyTokens = () => Object.fromEntries(FIELDS.map(key => [key, null]));
function safeTokens(value) { return Object.fromEntries(FIELDS.map(key => [key, count(value?.[key])])); }
function mergeTokens(previous, incoming) {
  return Object.fromEntries(FIELDS.map(key => [key, previous?.[key] == null ? incoming[key] : incoming[key] == null ? previous[key] : Math.max(previous[key], incoming[key])]));
}
function completeness(tokens) { return ['inputTokens','outputTokens','totalTokens'].every(key => tokens[key] !== null) ? 'complete' : FIELDS.some(key => tokens[key] !== null) ? 'partial' : 'missing'; }
function sumRows(rows) {
  const result = { requests: rows.length, tokens: emptyTokens() };
  for (const key of FIELDS) { const values = rows.map(row => row.tokens[key]).filter(value => value !== null); if (values.length) { const total=values.reduce((sum,value)=>sum+value,0);result.tokens[key]=Number.isSafeInteger(total)?total:null; } }
  return result;
}
function instant(value, fallback) { const time = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN; return Number.isFinite(time) && time >= 0 ? new Date(time).toISOString() : fallback; }
function rangeTime(value, end = false) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > 40 || !/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(value)) throw Object.assign(new Error('CHAT_USAGE_FILTER'), {code:'CHAT_USAGE_FILTER'});
  const day = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const result = Date.parse(day ? value + (end ? 'T23:59:59.999Z' : 'T00:00:00.000Z') : value);
  if (!Number.isFinite(result)||day&&new Date(result).toISOString().slice(0,10)!==value) throw Object.assign(new Error('CHAT_USAGE_FILTER'), {code:'CHAT_USAGE_FILTER'});
  return result;
}

// Only native token counters and request metadata are retained. Never prompts,
// replies, hidden reasoning, credentials, account identities or shared quotas.
class ChatUsage {
  constructor({ projectRoot, fs: io = fs, clock = Date.now, readLimit = 20000 } = {}) {
    this.journal = new ChatJournal(projectRoot, {fs:io}); this.io = io; this.clock = clock;
    this.readLimit = Math.max(100, Math.min(100000, Number.isSafeInteger(readLimit) ? readLimit : 20000));
    this.error = null;
  }
  _index() {
    const file = this.journal.file('memory/usage/index.jsonl');
    if (file && this.io.existsSync(file) && this.io.statSync(file).size > 16 * 1024 * 1024) throw new Error('CHAT_USAGE_INDEX_LIMIT');
    const value = this.journal.read('memory/usage/index.jsonl');
    if (!value) return {schema:'codex-maid-usage-index/1',startedAt:instant(this.clock()),records:{},turns:{},threadTotals:{},backfill:null};
    if (value.schema !== 'codex-maid-usage-index/1' || !value.records || !value.turns || !value.threadTotals || Object.keys(value.records).length > 100000) throw new Error('CHAT_USAGE_INDEX_INVALID');
    return value;
  }
  _record(key) {
    if (!/^[a-f0-9]{64}$/.test(key || '')) throw new Error('CHAT_USAGE_ID');
    const file=this.journal.file('memory/usage/requests/'+key+'.jsonl');if(file&&this.io.existsSync(file)&&this.io.statSync(file).size>32768)throw new Error('CHAT_USAGE_RECORD_LIMIT');
    const value = this.journal.read('memory/usage/requests/' + key + '.jsonl');
    if (value && (value.schema !== 'codex-maid-usage/1' || value.id !== key || !KINDS.has(value.kind) || !value.tokens)) throw new Error('CHAT_USAGE_RECORD_INVALID');
    if (value) value.tokens = safeTokens(value.tokens);
    return value;
  }
  _save(index, row) {
    row.completeness = completeness(row.tokens); row.updatedAt = instant(this.clock());
    if(row.completeness==='complete'&&(row.counterReset||row.kind==='chat'&&!row.freshThread&&!row.baseline))row.completeness='partial';
    row.durationMs = row.endedAt ? Math.max(0, Date.parse(row.endedAt) - Date.parse(row.startedAt)) : null;
    this.journal.write('memory/usage/requests/' + row.id + '.jsonl', row);
    index.records[row.id] = {startedAt:row.startedAt,kind:row.kind,model:row.model,status:row.status,imported:row.imported===true};
    if (row.threadKey && row.turnKey) index.turns[row.turnKey] = row.id;
    this.journal.write('memory/usage/index.jsonl', index);
    return row.id;
  }
  _safe(work) { try { return work(); } catch { this.error = 'CHAT_USAGE_RECORDING_UNAVAILABLE'; return null; } }
  recover() {
    return this._safe(()=>this.journal.locked('memory/usage/write.lock',()=>{
      const index=this._index();let recovered=0;
      for(const [id,meta]of Object.entries(index.records))if(meta.status==='running'){
        const row=this._record(id);if(row?.status==='running'){row.status='unknown';row.endedAt=null;this._save(index,row);recovered++;}
      }
      return recovered;
    }));
  }
  begin(input = {}) {
    return this._safe(() => this.journal.locked('memory/usage/write.lock', () => {
      if (!KINDS.has(input.kind) || !text(input.id)) throw new Error('CHAT_USAGE_INPUT');
      const index = this._index(), threadKey = text(input.threadId) ? digest(input.threadId) : null;
      const turnKey = threadKey && text(input.turnId) ? digest(input.threadId + '/' + input.turnId) : null;
      const key = turnKey && index.turns[turnKey] || digest(input.kind + ':' + input.id), old = this._record(key);
      if (old) return key;
      const row = {schema:'codex-maid-usage/1',id:key,kind:input.kind,stage:text(input.stage,80),model:text(input.model,160),effort:text(input.effort,40),
        startedAt:instant(input.startedAt,instant(this.clock())),endedAt:null,status:'running',tokens:emptyTokens(),completeness:'missing',durationMs:null,
        conversationId:text(input.conversationId),imported:input.imported===true,threadKey,turnKey,
        baseline:threadKey ? index.threadTotals[threadKey] || (input.freshThread ? emptyTokens() : null) : null,freshThread:input.freshThread===true,measurement:'native-token-usage'};
      return this._save(index,row);
    }));
  }
  bind(id, {threadId,turnId,freshThread=false} = {}) {
    if (!id || !text(threadId)) return id;
    return this._safe(() => this.journal.locked('memory/usage/write.lock', () => {
      const index=this._index(),row=this._record(id); if(!row)return null;
      const threadKey=digest(threadId),turnKey=text(turnId)?digest(threadId+'/'+turnId):null;
      if(row.threadKey&&row.threadKey!==threadKey||row.turnKey&&turnKey&&row.turnKey!==turnKey)return null;
      if(turnKey&&index.turns[turnKey]&&index.turns[turnKey]!==id)return index.turns[turnKey];
      row.threadKey=threadKey;if(turnKey)row.turnKey=turnKey;
      if(row.baseline===null)row.baseline=index.threadTotals[threadKey]||null;
      row.freshThread ||= freshThread;return this._save(index,row);
    }));
  }
  forTurn(threadId,turnId) { if(!text(threadId)||!text(turnId))return null;return this._safe(()=>this._index().turns[digest(threadId+'/'+turnId)]||null); }
  observe({id,threadId,turnId,last,total} = {}) {
    return this._safe(() => this.journal.locked('memory/usage/write.lock', () => {
      const index=this._index(),threadKey=text(threadId)?digest(threadId):null,turnKey=threadKey&&text(turnId)?digest(threadId+'/'+turnId):null;
      const key=turnKey&&index.turns[turnKey]||id;if(!key)return null;
      const row=this._record(key);if(!row||row.threadKey&&threadKey&&row.threadKey!==threadKey||row.turnKey&&turnKey&&row.turnKey!==turnKey)return null;
      if(threadKey)row.threadKey=threadKey;if(turnKey)row.turnKey=turnKey;
      const current=safeTokens(total),sample=safeTokens(last),derived=emptyTokens();
      for(const field of FIELDS){
        const baseline=row.baseline?.[field];
        if(current[field]!==null&&(baseline!==null&&baseline!==undefined||row.freshThread)){
          const previous=baseline??0;if(current[field]>=previous)derived[field]=current[field]-previous;else row.counterReset=true;
        }
      }
      const incoming=Object.fromEntries(FIELDS.map(field=>[field,derived[field]??sample[field]]));
      row.tokens=mergeTokens(row.tokens,incoming);
      row.measurement=FIELDS.some(field=>derived[field]!==null)?'native-cumulative-delta':'native-last-usage';
      if(threadKey&&FIELDS.some(field=>current[field]!==null))index.threadTotals[threadKey]=mergeTokens(index.threadTotals[threadKey],current);
      return this._save(index,row);
    }));
  }
  settle(id, {status='completed',endedAt,tokens,threadId,turnId} = {}) {
    if(!id)return null;
    if(threadId)this.bind(id,{threadId,turnId});
    return this._safe(() => this.journal.locked('memory/usage/write.lock', () => {
      const index=this._index(),row=this._record(id);if(!row)return null;
      if(tokens)row.tokens=mergeTokens(row.tokens,safeTokens(tokens));
      if(TERMINAL.has(status)){if(row.status==='running'||row.status==='unknown'||row.status===status){row.status=status==='invalid-output'?'failed':status;row.endedAt=status==='unknown'?null:instant(endedAt,row.endedAt||instant(this.clock()));}}
      return this._save(index,row);
    }));
  }
  backfillLegacy() {
    return this._safe(() => {
      const initial=this._index();if(initial.backfill)return initial.backfill;
      let imported=0,visited=0,truncated=false;
      const folder=this.journal.file('memory/maintenance/generation/placeholder.jsonl');
      if(folder&&this.io.existsSync(path.dirname(folder))){
        const files=this.io.readdirSync(path.dirname(folder)).filter(name=>/^[A-Za-z0-9_-]+\.jsonl$/.test(name));truncated=files.length>128;
        for(const name of files.slice(0,128)){
          const relative='memory/maintenance/generation/'+name,file=this.journal.file(relative);
          if(this.io.statSync(file).size>2*1024*1024){truncated=true;continue;}
          const task=this.journal.read(relative);if(task?.schema!=='codex-maid-generation/1'||!task.batches)continue;
          for(const [batchId,batch]of Object.entries(task.batches).slice(0,512)){
            if(batch.usageRecordId&&this._record(batch.usageRecordId))continue;
            if(++visited>20000){truncated=true;break;}if(!FIELDS.some(field=>count(batch.usage?.[field])!==null))continue;
            const id=this.begin({id:task.id+'/'+batchId,kind:'maintenance',stage:batch.stage,model:task.model,effort:task.effort,startedAt:batch.startedAt,threadId:batch.threadId,imported:true});
            this.settle(id,{status:batch.status,endedAt:batch.finishedAt,tokens:batch.usage});imported++;
          }
        }
      }
      const dreamFile=this.journal.file('memory/dreaming/state.jsonl');
      if(dreamFile&&this.io.existsSync(dreamFile)&&this.io.statSync(dreamFile).size<=8*1024*1024){
        const state=this.journal.read('memory/dreaming/state.jsonl'),jobs=Array.isArray(state?.jobs)?state.jobs:[];if(jobs.length>5000)truncated=true;
        for(const job of jobs.slice(-5000))if(text(job.id)&&FIELDS.some(field=>count(job.usage?.[field])!==null)){
          const id=this.begin({id:job.id,kind:'dream',stage:'dream',model:job.model,effort:job.effort,startedAt:job.startedAt||job.createdAt,threadId:job.locator?.threadId,turnId:job.locator?.turnId,imported:true});
          this.settle(id,{status:['candidate','adopted','no-change','discarded'].includes(job.status)?'completed':job.status,endedAt:job.finishedAt,tokens:job.usage});imported++;
        }
      }
      return this.journal.locked('memory/usage/write.lock',()=>{const index=this._index();index.backfill={at:instant(this.clock()),imported,truncated};this.journal.write('memory/usage/index.jsonl',index);return index.backfill;});
    });
  }
  list(input = {}) {
    const allowed=['from','to','kind','model','page','pageSize'];
    if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!allowed.includes(key)))throw Object.assign(new Error('CHAT_USAGE_FILTER'),{code:'CHAT_USAGE_FILTER'});
    const from=rangeTime(input.from),to=rangeTime(input.to,true),kind=input.kind&&input.kind!=='all'?input.kind:null,model=input.model&&input.model!=='all'?text(input.model,160):null;
    const page=input.page??1,pageSize=input.pageSize??25;
    if(from!==null&&to!==null&&from>to||kind&&!KINDS.has(kind)||input.model&&input.model!=='all'&&!model||!Number.isSafeInteger(page)||page<1||!Number.isSafeInteger(pageSize)||pageSize<1||pageSize>100)throw Object.assign(new Error('CHAT_USAGE_FILTER'),{code:'CHAT_USAGE_FILTER'});
    this.backfillLegacy();
    const index=this._index(),matches=Object.entries(index.records).filter(([,row])=>{const at=Date.parse(row.startedAt);return(from===null||at>=from)&&(to===null||at<=to)&&(!kind||row.kind===kind)&&(!model||row.model===model);}).sort((a,b)=>b[1].startedAt.localeCompare(a[1].startedAt)||a[0].localeCompare(b[0]));
    const rows=matches.slice(0,this.readLimit).map(([id])=>this._record(id)).filter(Boolean);
    const groups=key=>{const map=new Map();for(const row of rows){const value=key(row);if(!map.has(value))map.set(value,[]);map.get(value).push(row);}return [...map].map(([value,group])=>({...sumRows(group),value}));};
    const summary={...sumRows(rows),completed:rows.filter(row=>row.status==='completed').length,failed:rows.filter(row=>['failed','not-executed'].includes(row.status)).length,cancelled:rows.filter(row=>['cancelled','interrupted'].includes(row.status)).length,unknown:rows.filter(row=>row.status==='unknown').length,active:rows.filter(row=>row.status==='running').length,
      measuredRequests:rows.filter(row=>row.completeness==='complete').length,partialRequests:rows.filter(row=>row.completeness==='partial').length,missingRequests:rows.filter(row=>row.completeness==='missing').length,coverageStartedAt:index.startedAt};
    const publicRow=row=>Object.fromEntries(['id','kind','stage','model','effort','startedAt','endedAt','durationMs','status','tokens','completeness','imported','conversationId','measurement'].map(key=>[key,row[key]??null]));
    return {summary,byDay:groups(row=>row.startedAt.slice(0,10)).map(({value,...rest})=>({day:value,...rest})).sort((a,b)=>a.day.localeCompare(b.day)),byModel:groups(row=>row.model||'unknown').map(({value,...rest})=>({model:value,...rest})),byKind:groups(row=>row.kind).map(({value,...rest})=>({kind:value,...rest})),
      records:rows.slice((page-1)*pageSize,page*pageSize).map(publicRow),pagination:{page,pageSize,total:rows.length,pages:Math.ceil(rows.length/pageSize)},coverage:{startedAt:index.startedAt,foregroundHistoricalBackfill:false,importedRecords:Object.values(index.records).filter(row=>row.imported).length,truncated:matches.length>this.readLimit||index.backfill?.truncated===true,readLimit:this.readLimit},
      attribution:'companion-only-native-tokens',recordingError:this.error,timezone:'UTC',limits:{readLimit:this.readLimit,maxPageSize:100}};
  }
}
module.exports={ChatUsage,safeTokens,FIELDS};
