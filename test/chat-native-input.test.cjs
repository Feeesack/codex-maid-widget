'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {chooseImages,pasteImage,MAX_IMAGE_BYTES}=require('../src/chat-native-input.cjs');
const {sanitize}=require('../src/settings.cjs');
test('new model settings preserve explicit models and default to the requested medium setting',()=>{
  assert.equal(sanitize().chatModel,'gpt-6.1-sol');assert.equal(sanitize().chatReasoningEffort,'medium');
  assert.equal(sanitize({chatModel:'unavailable-custom-model',chatReasoningEffort:'high'}).chatModel,'unavailable-custom-model');
  assert.equal(sanitize({chatModel:'C:\\unsafe',chatReasoningEffort:'invented'}).chatModel,'gpt-6.1-sol');
});
test('cancelled image picker does not stage files',async()=>{
  let staged=false;const result=await chooseImages({dialog:{showOpenDialog:async()=>({canceled:true})},stageImages:()=>{staged=true;}});
  assert.equal(result.cancelled,true);assert.equal(staged,false);
});
test('native image selection sends original bytes and basename with no renderer path authority',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'maid-images-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const file=path.join(root,'中文 图片.png'),bytes=Buffer.from('synthetic-original');fs.writeFileSync(file,bytes);
  const result=await chooseImages({dialog:{showOpenDialog:async()=>({filePaths:[file]})},stageImages:input=>{assert.deepEqual(input.images[0].bytes,bytes);assert.equal(input.images[0].name,'中文 图片.png');assert.equal(Object.hasOwn(input.images[0],'path'),false);return{images:[{imageId:'opaque'}]};}});
  assert.equal(result.images[0].imageId,'opaque');
});
test('image count, symlink and total byte bounds reject without compression or staging',async()=>{
  const invoke=(filePaths,info)=>chooseImages({dialog:{showOpenDialog:async()=>({filePaths})},io:{lstatSync:()=>info,readFileSync:()=>Buffer.alloc(info.size)},stageImages:()=>assert.fail('must not stage')});
  await assert.rejects(invoke(Array(9).fill('fake.png'),{}),/8/);
  await assert.rejects(invoke(['fake.png'],{isFile:()=>true,isSymbolicLink:()=>true,size:1}),/无效/);
  await assert.rejects(invoke(['a.png','b.png'],{isFile:()=>true,isSymbolicLink:()=>false,size:MAX_IMAGE_BYTES/2+1}),/合计/);
});
test('clipboard image remains explicitly injected and empty clipboard has no side effects',async()=>{
  assert.deepEqual(await pasteImage({clipboard:{readImage:()=>({isEmpty:()=>true})},stageImages:()=>assert.fail('empty')}),{images:[],empty:true});
  const result=await pasteImage({clipboard:{readImage:()=>({isEmpty:()=>false,toPNG:()=>Buffer.from('synthetic-png')})},stageImages:input=>({name:input.images[0].name})});
  assert.equal(result.name,'clipboard.png');
});
