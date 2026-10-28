'use strict';

// Archive organization is project-local metadata. Original JSONL and immutable
// summary nodes remain authoritative and are never rewritten by this module.
const fs = require('node:fs');
const path = require('node:path');
const {createHash} = require('node:crypto');
const { ChatJournal } = require('./chat-journal.cjs');
const SCHEMA = 'codex-maid-history-metadata/1';
const METADATA = 'memory/history/metadata.jsonl';
const MAX_METADATA = 2 * 1024 * 1024;
const MAX_STATS = 64 * 1024;
const ID = /^C-[\w-]+$/;
const SUMMARY = /^L1-[a-f0-9-]{36}@v[1-9]\d*$/;
const fail = code => { throw Object.assign(new Error(code), { code }); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const searchText = value => String(value ?? '').normalize('NFKC').toLowerCase();

function line(value, maximum, code) {
  if (typeof value !== 'string' || value.length > maximum || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value)) fail(code);
  return value.trim();
}
function date(value) {
  if (value === undefined || value === '') return '';
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\d$/.test(value) || !Number.isFinite(Date.parse(value + 'T00:00:00Z')) || new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) !== value) fail('CHAT_HISTORY_FILTER');
  return value;
}
function metadata(value, stored = false) {
  if (!object(value)) fail('CHAT_HISTORY_METADATA_INVALID');
  const allowed = ['title','favorite','tags','hidden',...(stored ? ['revision','updatedAt'] : [])];
  if (Object.keys(value).some(key => !allowed.includes(key))) fail('CHAT_HISTORY_METADATA_INVALID');
  const result = {};
  if (value.title !== undefined) result.title = value.title === null ? null : line(value.title, 160, 'CHAT_HISTORY_TITLE') || null;
  for (const key of ['favorite','hidden']) if (value[key] !== undefined) { if (typeof value[key] !== 'boolean') fail('CHAT_HISTORY_METADATA_INVALID'); result[key] = value[key]; }
  if (value.tags !== undefined) {
    if (!Array.isArray(value.tags) || value.tags.length > 12) fail('CHAT_HISTORY_TAGS');
    const tags = value.tags.map(tag => line(tag, 32, 'CHAT_HISTORY_TAGS')).filter(Boolean), seen = new Set();
    result.tags = tags.filter(tag => { const normalized = searchText(tag); if (seen.has(normalized)) return false; seen.add(normalized); return true; });
  }
  if (stored) {
    if (!Number.isSafeInteger(value.revision) || value.revision < 1 || typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt))) fail('CHAT_HISTORY_METADATA_INVALID');
    result.revision = value.revision; result.updatedAt = value.updatedAt;
  }
  return result;
}

class ChatHistoryManager {
  constructor({projectRoot, fs:io = fs, clock = Date.now} = {}) {
    this.journal = new ChatJournal(projectRoot, {fs:io}); this.io = io; this.clock = clock; this.stats = new Map();
  }
  _saved() {
    const file = this.journal.file(METADATA);
    if (!file || !this.io.existsSync(file)) return {schema:SCHEMA,revision:0,items:{}};
    if (this.io.statSync(file).size > MAX_METADATA) fail('CHAT_HISTORY_METADATA_INVALID');
    const value = this.journal.read(METADATA);
    if (!object(value) || value.schema !== SCHEMA || !Number.isSafeInteger(value.revision) || value.revision < 0 || !object(value.items) || Object.keys(value).some(key => !['schema','revision','items'].includes(key))) fail('CHAT_HISTORY_METADATA_INVALID');
    for (const [id,item] of Object.entries(value.items)) { if (!ID.test(id)) fail('CHAT_HISTORY_METADATA_INVALID'); metadata(item, true); }
    return value;
  }
  _header(relative) {
    const file = this.journal.file(relative); if (!file) fail('CHAT_HISTORY_MISSING');
    const descriptor = this.io.openSync(file, 'r'), buffer = Buffer.alloc(16384); let size;
    try { size = this.io.readSync(descriptor, buffer, 0, buffer.length, 0); } finally { this.io.closeSync(descriptor); }
    const end = buffer.subarray(0, size).indexOf(10); if (end < 0) fail('CHAT_HISTORY_HEADER');
    let record; try { record = JSON.parse(buffer.subarray(0,end).toString('utf8')); } catch { fail('CHAT_HISTORY_HEADER'); }
    if (record?.meta?.schema !== 'codex-maid-chat/1' || !ID.test(record.meta.conversation_id || '')) fail('CHAT_HISTORY_HEADER');
    return record.meta;
  }
  _inventory() {
    const marker = this.journal.file('chat-history/.listing'), entries = [], ids = new Set();
    if (!marker || !this.io.existsSync(path.dirname(marker))) return entries;
    for (const day of this.io.readdirSync(path.dirname(marker)).sort().reverse()) {
      if (!/^\d{4}-\d\d-\d\d$/.test(day)) continue;
      const directoryMarker = this.journal.file(`chat-history/${day}/.listing`); if (!directoryMarker) continue;
      for (const name of this.io.readdirSync(path.dirname(directoryMarker)).sort().reverse()) {
        if (!/^\d{4}-\d\d-\d\d_\d\d-\d\d-\d\d(?:-\d+)?\.jsonl$/.test(name)) continue;
        const relativePath = `chat-history/${day}/${name}`, header = this._header(relativePath), stat = this.io.statSync(this.journal.file(relativePath));
        if (ids.has(header.conversation_id)) fail('CHAT_HISTORY_MAPPING_CONFLICT'); ids.add(header.conversation_id);
        entries.push({conversationId:header.conversation_id,title:name.slice(0,-6),startedAt:typeof header.started_at === 'string' ? header.started_at : null,archiveDate:day,relativePath,archiveBytes:stat.size,statKey:`${stat.size}:${stat.mtimeMs}`});
      }
    }
    return entries;
  }
  _summaryMap() {
    try { return this.journal.read('memory/summaries/head.jsonl')?.conversations || {}; }
    catch { return {}; }
  }
  _stats(item, inspect = false) {
    const cached = this.stats.get(item.conversationId);
    if (cached?.statKey === item.statKey) return cached;
    const unavailable = {messageCount:null,attachmentCount:null,statsStatus:'unavailable',statKey:item.statKey};
    // A list request never scans a large chat body. Small files may be counted
    // once within this fixed per-archive byte budget; larger counts stay unknown.
    if (!inspect || item.archiveBytes > MAX_STATS) return unavailable;
    let result = unavailable;
    try {
      const file = this.journal.file(item.relativePath), descriptor = this.io.openSync(file,'r'), bytes = Buffer.alloc(MAX_STATS + 1); let size;
      try { size = this.io.readSync(descriptor,bytes,0,bytes.length,0); } finally { this.io.closeSync(descriptor); }
      if (size > MAX_STATS || size !== item.archiveBytes || bytes[size - 1] !== 10) return unavailable;
      let messageCount = 0, attachmentCount = 0;
      for (const text of bytes.subarray(0,size).toString('utf8').split('\n').filter(Boolean)) {
        const row = JSON.parse(text); if (!row.id) continue;
        if (!['user','assistant'].includes(row.role) || !Array.isArray(row.content)) return unavailable;
        messageCount++; attachmentCount += row.content.filter(part => object(part.image)).length;
      }
      result = {messageCount,attachmentCount,statsStatus:'available',statKey:item.statKey};
    } catch {}
    this.stats.set(item.conversationId,result); return result;
  }
  _decorate(item, saved, summaries, inspect = false) {
    const entry = saved.items[item.conversationId] || {}, reference = summaries[item.conversationId]?.ref;
    const summaryReference = typeof reference === 'string' && SUMMARY.test(reference) ? reference : null;
    let summaryStatus = 'unavailable';
    if (summaryReference) { const file = this.journal.file(`memory/summaries/nodes/${summaryReference}.jsonl`); summaryStatus = file && this.io.existsSync(file) ? 'available' : 'missing'; }
    const stats = this._stats(item,inspect), {statKey,...output} = item;
    return {...output,originalTitle:item.title,title:entry.title || item.title,customTitle:entry.title || null,favorite:entry.favorite === true,tags:entry.tags || [],hidden:entry.hidden === true,metadataRevision:entry.revision || 0,metadataUpdatedAt:entry.updatedAt || null,messageCount:stats.messageCount,attachmentCount:stats.attachmentCount,statsStatus:stats.statsStatus,summaryReference,summaryStatus};
  }
  _filters(input = {}) {
    if (!object(input) || Object.keys(input).some(key => !['cursor','limit','query','from','to','favorite','hidden'].includes(key))) fail('CHAT_HISTORY_FILTER');
    const cursor = input.cursor ?? 0, limit = input.limit ?? 20, query = input.query === undefined ? '' : line(input.query,256,'CHAT_HISTORY_FILTER');
    const from = date(input.from), to = date(input.to), favorite = input.favorite ?? false, hidden = input.hidden ?? 'visible';
    if (!Number.isSafeInteger(cursor) || cursor < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100 || typeof favorite !== 'boolean' || !['visible','hidden','all'].includes(hidden) || from && to && from > to) fail('CHAT_HISTORY_FILTER');
    return {cursor,limit,query,from,to,favorite,hidden};
  }
  _matches(item, filters) {
    return (!filters.query || searchText([item.title,item.originalTitle,item.conversationId,...item.tags].join(' ')).includes(searchText(filters.query))) &&
      (!filters.from || item.archiveDate >= filters.from) && (!filters.to || item.archiveDate <= filters.to) &&
      (!filters.favorite || item.favorite) && (filters.hidden === 'all' || (filters.hidden === 'hidden' ? item.hidden : !item.hidden));
  }
  _overview(items, filtered) {
    const known = items.filter(item => item.statsStatus === 'available'), dates = items.map(item => item.archiveDate).sort();
    return {total:items.length,visible:items.filter(item => !item.hidden).length,hidden:items.filter(item => item.hidden).length,favorites:items.filter(item => item.favorite).length,matching:filtered.length,archiveBytes:items.reduce((sum,item) => sum + item.archiveBytes,0),messageCount:known.reduce((sum,item) => sum + item.messageCount,0),attachmentCount:known.reduce((sum,item) => sum + item.attachmentCount,0),statisticsComplete:known.length === items.length,statisticsKnown:known.length,statisticsUnknown:items.length - known.length,firstDate:dates[0] || null,lastDate:dates.at(-1) || null};
  }
  list(input = {}) {
    const filters = this._filters(input), saved = this._saved(), summaries = this._summaryMap(), inventory = this._inventory();
    const all = inventory.map(item => this._decorate(item,saved,summaries)), matching = all.filter(item => this._matches(item,filters));
    const selectedIds = new Set(matching.slice(filters.cursor,filters.cursor + filters.limit).map(item => item.conversationId));
    const counted = inventory.map((item,index) => selectedIds.has(item.conversationId) ? this._decorate(item,saved,summaries,true) : all[index]);
    const conversations = counted.filter(item => selectedIds.has(item.conversationId));
    return {conversations,total:matching.length,nextCursor:filters.cursor + filters.limit < matching.length ? filters.cursor + filters.limit : null,overview:this._overview(counted,counted.filter(item => this._matches(item,filters)))};
  }
  overview(input = {}) {
    const filters = this._filters(input), saved = this._saved(), summaries = this._summaryMap();
    const items = this._inventory().map(item => this._decorate(item,saved,summaries));
    return this._overview(items,items.filter(item => this._matches(item,filters)));
  }
  decorate(item) {
    const stat = this.io.statSync(this.journal.file(item.relativePath));
    return {...item,...this._decorate({...item,archiveBytes:stat.size,statKey:`${stat.size}:${stat.mtimeMs}`},this._saved(),this._summaryMap(),true)};
  }
  readImage(image, {conversationId,archiveDate}) {
    if (!object(image) || !ID.test(conversationId || '') || !/^\d{4}-\d\d-\d\d$/.test(archiveDate || '') ||
        typeof image.path !== 'string' || !image.path.startsWith(`chat-history/${archiveDate}/attachments/${conversationId}/`) ||
        !/^image\/(?:png|jpeg|gif|webp)$/.test(image.mime || '') || !Number.isSafeInteger(image.size) || image.size < 1 || image.size > 32 * 1024 * 1024 || !/^[a-f0-9]{64}$/.test(image.sha256 || '')) fail('CHAT_HISTORY_IMAGE_CHANGED');
    const file = this.journal.file(image.path); if (!file || this.io.statSync(file).size !== image.size) fail('CHAT_HISTORY_IMAGE_CHANGED');
    const bytes = this.io.readFileSync(file);
    if (createHash('sha256').update(bytes).digest('hex') !== image.sha256) fail('CHAT_HISTORY_IMAGE_CHANGED');
    return {bytes,mime:image.mime};
  }
  update(input) {
    if (!object(input) || Object.keys(input).some(key => !['conversationId','baseRevision','title','favorite','tags','hidden'].includes(key)) || !ID.test(input.conversationId || '')) fail('CHAT_HISTORY_METADATA_INVALID');
    const {conversationId,baseRevision,...patch} = input, normalized = metadata(patch);
    if (!Object.keys(normalized).length || baseRevision !== undefined && (!Number.isSafeInteger(baseRevision) || baseRevision < 0)) fail('CHAT_HISTORY_METADATA_INVALID');
    if (!this._inventory().some(item => item.conversationId === conversationId)) fail('CHAT_HISTORY_MISSING');
    return this.journal.locked('memory/history/metadata.lock',() => {
      const value = this._saved(), prior = value.items[conversationId] || {revision:0};
      if (baseRevision !== undefined && baseRevision !== prior.revision) fail('CHAT_HISTORY_METADATA_STALE');
      const entry = {title:null,favorite:false,tags:[],hidden:false,...prior,...normalized,revision:prior.revision + 1,updatedAt:new Date(this.clock()).toISOString()};
      value.revision++; value.items[conversationId] = entry;
      if (Buffer.byteLength(JSON.stringify(value),'utf8') > MAX_METADATA) fail('CHAT_HISTORY_METADATA_LIMIT');
      this.journal.write(METADATA,value);
      return {saved:true,conversationId,title:entry.title,favorite:entry.favorite,tags:entry.tags,hidden:entry.hidden,metadataRevision:entry.revision,updatedAt:entry.updatedAt};
    });
  }
}
module.exports = {ChatHistoryManager,MAX_STATS};
