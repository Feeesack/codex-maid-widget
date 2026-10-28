'use strict';
const {createHash}=require('node:crypto');
const {TERMINAL}=require('./chat-policy.cjs');
const {normalizeRecords}=require('./chat-archive.cjs');
const {decodePersonaAnswer}=require('./chat-persona.cjs');
function fingerprint(value){return createHash('sha256').update(JSON.stringify(value)).digest('hex');}
function identity(value){return typeof value==='string'&&value.length>0&&value.length<=512&&!/[\0\r\n]/.test(value);}

// Only the dedicated client's own thread can be read. Callers freeze their
// source/operation watermark before this operation; a known terminal cutoff is
// required, so a partial page or a newly active request cannot masquerade as a
// complete checkpoint. This never writes a temporary body/recovery log.
async function collectOwnHistory(transport,{threadId,cutoffTurnId,isFrozen,maxPages=128,maxBytes=64*1024*1024}={}) {
  if(!identity(threadId)||!identity(cutoffTurnId)||typeof isFrozen!=='function'||isFrozen(threadId)!==true||
      !Number.isSafeInteger(maxPages)||maxPages<1||maxPages>512||!Number.isSafeInteger(maxBytes)||maxBytes<1)throw new Error('CHAT_SOURCE_FREEZE_REQUIRED');
  const metadata=await transport.readOwnThread(threadId);
  if(!['idle','notLoaded'].includes(metadata.status))throw new Error('CHAT_SOURCE_NOT_TERMINAL');
  const turns=[],cursors=new Set(),ids=new Set();let cursor=null,bytes=0,complete=false;
  for(let page=0;page<maxPages;page++) {
    if(!isFrozen(threadId))throw new Error('CHAT_SOURCE_FREEZE_CHANGED');
    const result=await transport.readOwnThread(threadId,{kind:'thread/turns/list',cursor,limit:50});
    if(result.threadId!==threadId||result.sourceRecoveryVerified!==true||!Array.isArray(result.data))throw new Error('CHAT_SOURCE_RECOVERY_UNVERIFIED');
    bytes+=Buffer.byteLength(JSON.stringify(result.data),'utf8');
    if(bytes>maxBytes)throw new Error('CHAT_SOURCE_READ_BUDGET');
    for(const turn of result.data) {
      if(!identity(turn?.id)||ids.has(turn.id)||!TERMINAL.has(turn.status)||turn.fullItems!==true||!Array.isArray(turn.items))throw new Error('CHAT_SOURCE_INCOMPLETE');
      ids.add(turn.id);turns.push(turn);
    }
    if(result.complete===true&&result.nextCursor===null){complete=true;break;}
    if(!identity(result.nextCursor)||cursors.has(result.nextCursor))throw new Error('CHAT_SOURCE_PAGINATION_INVALID');
    cursors.add(result.nextCursor);cursor=result.nextCursor;
  }
  if(!complete)throw new Error('CHAT_SOURCE_PAGE_BUDGET');
  if(turns.at(-1)?.id!==cutoffTurnId||!isFrozen(threadId))throw new Error('CHAT_SOURCE_CUTOFF_CHANGED');
  const after=await transport.readOwnThread(threadId);
  if(!['idle','notLoaded'].includes(after.status))throw new Error('CHAT_SOURCE_NOT_TERMINAL');
  return {threadId,cutoffTurnId,turns,complete:true,fingerprint:fingerprint({threadId,cutoffTurnId,turns})};
}

function nativeArchiveRecords(source,{conversation,clientOperations=new Map(),displayedItems=new Set(),loadedVersions=new Map(),decodeAnswers=false}={}) {
  if(source?.complete!==true||source.threadId!==conversation?.nativeThreadId||!Array.isArray(source.turns)||
      source.turns.at(-1)?.id!==source.cutoffTurnId)throw new Error('CHAT_SOURCE_INCOMPLETE');
  const records=[],messages=new Map(),seenItems=new Set();let t=0,m=0;
  for(const turn of source.turns){
    if(!TERMINAL.has(turn.status)||turn.fullItems!==true)throw new Error('CHAT_SOURCE_NOT_TERMINAL');
    const turnId=`T${String(++t).padStart(6,'0')}`;
    const known=loadedVersions.get(turn.id);
    const record={turn:{id:turnId,native_turn_id:turn.id,observed_at:known?.observedAt??null}};
    if(known?.requestedModel!==undefined)record.turn.requested_model=known.requestedModel;
    if(known?.personaVersion!==undefined)record.turn.persona_version=known.personaVersion;
    if(known?.memoryViewVersions!==undefined)record.turn.memory_view_versions=known.memoryViewVersions;
    records.push(record);
    for(const item of turn.items){
      if(!identity(item?.id)||seenItems.has(item.id)||!['user','assistant'].includes(item.role)||!Array.isArray(item.content))throw new Error('CHAT_SOURCE_ITEM_INVALID');
      seenItems.add(item.id);
      if(item.turnId!==turn.id)throw new Error('CHAT_SOURCE_TURN_ASSOCIATION');
      if(item.role==='assistant'){
        if(turn.status==='completed'&&item.phase==='commentary')continue;
        if(turn.status==='completed'&&item.phase!=='final_answer')throw new Error('CHAT_SOURCE_PHASE_UNKNOWN');
        if(turn.status!=='completed'&&!displayedItems.has(item.id))throw new Error('CHAT_SOURCE_DISPLAY_UNKNOWN');
      }
      if(item.role==='user'&&item.contentComplete!==true)throw new Error('CHAT_SOURCE_IMAGE_UNAVAILABLE');
      const visibleContent=decodeAnswers&&item.role==='assistant' ? [{text:decodePersonaAnswer(item.content.map(part=>typeof part.text==='string'?part.text:'').join(''),{partial:turn.status!=='completed'}).answer}] : item.content;
      if(decodeAnswers&&item.role==='assistant'&&visibleContent.every(part=>typeof part.text==='string'&&!part.text.length))continue;
      const message={id:`M${String(++m).padStart(6,'0')}`,native_message_id:item.id,turn_id:turnId,
        time:null,role:item.role,content:visibleContent.map(part=>{
          if(typeof part?.text==='string'&&Object.keys(part).length===1)return {text:part.text};
          if(part?.image?.originalAvailable===true&&Buffer.isBuffer(part.image.bytes))return {image:{bytes:part.image.bytes,mime:part.image.mime,size:part.image.size,sha256:part.image.sha256}};
          throw new Error('CHAT_SOURCE_CONTENT_UNAVAILABLE');
        })};
      if(item.role==='assistant'){
        message.phase=turn.status==='completed'?'final_answer':item.phase??null;
        if(turn.status!=='completed')message.displayed=true;
      }
      const operation=item.clientId?clientOperations.get(item.clientId):null;
      if(operation){
        if(operation.turnId!==turn.id||operation.delivered!==true)throw new Error('CHAT_SOURCE_DELIVERY_UNKNOWN');
        if(operation.observedAt!==undefined)message.time=operation.observedAt;
        if(operation.kind==='steer'){
          const target=operation.appendToClientId?messages.get(operation.appendToClientId):null;
          if(target&&target.turnId!==turn.id)throw new Error('CHAT_SOURCE_APPEND_TARGET_INVALID');
          message.append_to=target?.id??null;
          message.delivery='steer';
        }else if(operation.kind!=='send')throw new Error('CHAT_SOURCE_OPERATION_INVALID');
      }
      if(item.clientId){
        if(messages.has(item.clientId))throw new Error('CHAT_SOURCE_CLIENT_ID_COLLISION');
        messages.set(item.clientId,{id:message.id,turnId:turn.id});
      }
      records.push(message);
    }
    records.push({turn_result:{id:turnId,observed_at:null,status:turn.status,source_event:'native-history-turn'}});
  }
  // Reuse the final storage allowlist before returning even an in-memory draft.
  // normalizeRecords does not write files or retain any reasoning/tool fields.
  normalizeRecords(records,conversation);
  return records;
}
module.exports={collectOwnHistory,nativeArchiveRecords};
