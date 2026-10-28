'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const variants = fs.existsSync(path.join(__dirname,'../macos/src/chat-history-manager.cjs')) ? ['', 'macos/'] : [''];
for (const variant of variants) {
  const root = path.join(__dirname,'..',variant);
  const {createChatProject} = require(path.join(root,'src/chat-project.cjs'));
  const {createConversation,commitCheckpoint} = require(path.join(root,'src/chat-archive.cjs'));
  const {ChatHistoryManager,MAX_STATS} = require(path.join(root,'src/chat-history-manager.cjs'));
  const {ChatJournal} = require(path.join(root,'src/chat-journal.cjs'));
  function fixture(t, options = {}) {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(),'maid-history-management-'));
    const parent = path.join(sandbox,'中文 自定义数据盘'); fs.mkdirSync(parent);
    const project = createChatProject({parentDir:parent,userNickname:'隔离测试'});
    const manager = new ChatHistoryManager({projectRoot:project.root,...options});
    t.after(async () => { await options.beforeCleanup?.(); fs.rmSync(sandbox,{recursive:true,force:true}); });
    return {sandbox,project,manager};
  }
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1kAAAAASUVORK5CYII=','base64');
  function archive(f, day = '2026-10-26', text = '合成归档正文', withImage = false) {
    const conversation = createConversation({root:f.project.root,startedAt:day + 'T12:00:00+08:00',timezone:'Asia/Shanghai',nativeThreadId:'synthetic-'+crypto.randomUUID()});
    const result = commitCheckpoint({root:f.project.root,conversation,sourceComplete:true,trigger:'new-conversation',records:[
      {turn:{id:'T1',observed_at:null}},
      {id:'M1',turn_id:'T1',role:'user',time:day+'T12:00:01+08:00',content:[{text},...(withImage ? [{image:{bytes:png,mime:'image/png',name:'synthetic.png'}}] : [])]},
      {id:'M2',turn_id:'T1',role:'assistant',phase:'final_answer',time:day+'T12:00:02+08:00',content:[{text:'合成回答'}]},
      {turn_result:{id:'T1',observed_at:null,status:'completed'}}
    ]});
    return {conversation,...result};
  }
  test(variant + 'history metadata organizes archives while preserving original bytes and pagination', t => {
    const f=fixture(t), first=archive(f), second=archive(f,'2026-10-27'), original=fs.readFileSync(first.file);
    let page=f.manager.list({limit:1}); assert.equal(page.total,2); assert.equal(page.nextCursor,1); assert.equal(page.conversations[0].conversationId,second.conversation.conversationId);
    page=f.manager.list({cursor:1,limit:1}); assert.equal(page.nextCursor,null); assert.equal(page.conversations[0].messageCount,2); assert.equal(page.conversations[0].attachmentCount,0);
    const id=first.conversation.conversationId, receipt=f.manager.update({conversationId:id,baseRevision:0,title:'计划 · Alpha',favorite:true,tags:['设计',' Terra ','terra'],hidden:true});
    assert.equal(receipt.metadataRevision,1); assert.deepEqual(receipt.tags,['设计','Terra']);
    assert.equal(f.manager.list().total,1); assert.equal(f.manager.list({hidden:'hidden'}).conversations[0].title,'计划 · Alpha');
    assert.equal(f.manager.list({hidden:'all',query:'alpha',favorite:true}).conversations[0].conversationId,id);
    assert.equal(f.manager.list({hidden:'all',query:'terra'}).total,1);
    assert.equal(f.manager.list({hidden:'all',query:id}).total,1);
    assert.equal(f.manager.list({hidden:'all',from:'2026-10-27',to:'2026-10-27'}).total,1);
    const overview=f.manager.overview({hidden:'all'}); assert.equal(overview.total,2); assert.equal(overview.hidden,1); assert.equal(overview.visible,1); assert.equal(overview.favorites,1); assert.equal(overview.statisticsComplete,true); assert.equal(overview.messageCount,4);
    const reopened=new ChatHistoryManager({projectRoot:f.project.root});
    assert.equal(reopened.list({hidden:'hidden'}).conversations[0].customTitle,'计划 · Alpha');
    reopened.update({conversationId:id,baseRevision:1,title:null,hidden:false});
    assert.equal(reopened.list().total,2); assert.equal(reopened.list({query:'alpha'}).total,0);
    assert.deepEqual(fs.readFileSync(first.file),original);
  });
  test(variant + 'history metadata rejects stale updates and unsafe input without changing originals', t => {
    const f=fixture(t), saved=archive(f), id=saved.conversation.conversationId, original=fs.readFileSync(saved.file);
    f.manager.update({conversationId:id,title:'已确认标题'});
    assert.throws(()=>f.manager.update({conversationId:id,baseRevision:0,title:'覆盖'}),{code:'CHAT_HISTORY_METADATA_STALE'});
    for(const input of [
      {conversationId:'../outside',title:'失败'}, {conversationId:id,title:'跨行\n标题'}, {conversationId:id,tags:Array(13).fill('太多')},
      {conversationId:id,favorite:'yes'}, {conversationId:id,hidden:true,relativePath:'outside'}, {conversationId:'C-missing',title:'失败'}
    ])assert.throws(()=>f.manager.update(input));
    for(const input of [{from:'2026-02-30'},{from:'2026-10-27',to:'2026-10-26'},{cursor:-1},{limit:101},{hidden:'deleted'},{query:'\0'}])assert.throws(()=>f.manager.list(input));
    assert.equal(f.manager.list().conversations[0].title,'已确认标题'); assert.deepEqual(fs.readFileSync(saved.file),original);
  });
  test(variant + 'large archive statistics stay explicitly unknown without a body scan', t => {
    const reads=[], io=new Proxy(fs,{get(target,key){if(key==='readSync')return (fd,buffer,offset,length,position)=>{reads.push(length);return target.readSync(fd,buffer,offset,length,position);};return target[key];}});
    const f=fixture(t,{fs:io}), saved=archive(f,'2026-10-26','仅在隔离数据中生成'.repeat(8000));
    assert.ok(fs.statSync(saved.file).size > MAX_STATS);
    const row=f.manager.list().conversations[0]; assert.equal(row.messageCount,null); assert.equal(row.attachmentCount,null); assert.equal(row.statsStatus,'unavailable');
    assert.equal(f.manager.overview().statisticsComplete,false); assert.equal(f.manager.overview().statisticsUnknown,1);
    assert.ok(reads.every(length=>length<=16384),'only bounded headers were read');
  });
  test(variant + 'attachment statistics and direct offline reads verify original hash and archive scope', t => {
    const f=fixture(t), saved=archive(f,'2026-10-26','合成图片原文',true), row=f.manager.list().conversations[0];
    assert.equal(row.messageCount,2);assert.equal(row.attachmentCount,1);
    const record=fs.readFileSync(saved.file,'utf8').split('\n').filter(Boolean).map(line=>JSON.parse(line)).find(item=>item.id==='M1');
    const image=record.content[1].image;assert.deepEqual(f.manager.readImage(image,row).bytes,png);
    assert.throws(()=>f.manager.readImage({...image,path:'project.json'},row),{code:'CHAT_HISTORY_IMAGE_CHANGED'});
    const file=path.join(f.project.root,image.path), corrupt=Buffer.from(png);corrupt[corrupt.length-1]^=1;fs.writeFileSync(file,corrupt);
    assert.throws(()=>f.manager.readImage(image,row),{code:'CHAT_HISTORY_IMAGE_CHANGED'});
  });
  test(variant + 'archive overview returns complete inventory beyond the first hundred rows', t => {
    const f=fixture(t), directory=path.join(f.project.root,'chat-history','2026-10-26');fs.mkdirSync(directory,{recursive:true});
    for(let index=0;index<205;index++) {
      const name=`2026-10-26_12-00-00-${index+1}.jsonl`,meta={schema:'codex-maid-chat/1',conversation_id:'C-synthetic-'+index,started_at:'2026-10-26T12:00:00+08:00'};
      fs.writeFileSync(path.join(directory,name),JSON.stringify({meta})+'\n');
    }
    const page=f.manager.list({cursor:200,limit:20}); assert.equal(page.total,205); assert.equal(page.conversations.length,5); assert.equal(page.nextCursor,null); assert.equal(page.overview.total,205);
  });
  test(variant + 'summary state is read only and metadata corruption is never silently replaced', t => {
    const f=fixture(t), saved=archive(f), journal=new ChatJournal(f.project.root), reference='L1-00000000-0000-0000-0000-000000000001@v1';
    journal.write('memory/summaries/head.jsonl',{conversations:{[saved.conversation.conversationId]:{ref:reference}}});
    journal.write(`memory/summaries/nodes/${reference}.jsonl`,{sentinel:'immutable summary'});
    const bytes=fs.readFileSync(journal.file(`memory/summaries/nodes/${reference}.jsonl`)), row=f.manager.list().conversations[0];
    assert.equal(row.summaryReference,reference); assert.equal(row.summaryStatus,'available');
    f.manager.update({conversationId:row.conversationId,favorite:true});assert.deepEqual(fs.readFileSync(journal.file(`memory/summaries/nodes/${reference}.jsonl`)),bytes);
    const file=journal.file('memory/history/metadata.jsonl'); fs.writeFileSync(file,'incomplete');
    assert.throws(()=>f.manager.update({conversationId:row.conversationId,title:'不能覆盖'}));assert.equal(fs.readFileSync(file,'utf8'),'incomplete');
  });
  test(variant + 'archive service browsing and organization work without a Codex connection', async t => {
    const {ChatService}=require(path.join(root,'src/chat-service.cjs'));
    let service;
    const f=fixture(t,{beforeCleanup:()=>service?.close()}), data=path.join(f.sandbox,'隔离 客户端资料');fs.mkdirSync(data);
    service=new ChatService({dataDir:data,autoConnect:false});
    const selection=service.selectDirectory(f.project.root,'resume');
    // The project already has an initialized memory store before resume.
    const {MemoryStore}=require(path.join(root,'src/chat-memory.cjs'));
    const memory=new MemoryStore({projectRoot:f.project.root,countTokens:value=>Buffer.byteLength(value)});memory.initialize({pet_name:'测试',user_nickname:'合成'});
    service.initialize({selectionId:selection.selectionId}); const saved=archive(f,'2026-10-26','合成离线聊天',true);
    let connectionCalls=0;service._ensureConnected=async()=>{connectionCalls++;throw Error('isolated offline connection');};service.connection={state:'auth-required',reason:'ACCOUNT_CHANGED'};
    const list=await service.listHistory();assert.equal(list.total,1);
    const page=await service.readHistory({conversationId:saved.conversation.conversationId,limit:1});
    assert.equal(page.messages.length,1);assert.match(page.messages[0].content[1].image.dataUrl,/^data:image\/png;base64,/);
    service.updateHistoryMetadata({conversationId:saved.conversation.conversationId,title:'离线整理',favorite:true});
    assert.equal((await service.historyOverview()).favorites,1);assert.equal(connectionCalls,0);
    await assert.rejects(service.resolveReference({reference:'native:synthetic'}));assert.equal(connectionCalls,1);
  });
}
