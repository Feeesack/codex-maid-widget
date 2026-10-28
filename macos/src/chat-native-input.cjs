'use strict';
const fs = require('node:fs');
const path = require('node:path');
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
async function chooseImages({dialog,window,stageImages,io=fs}) {
  const result=await dialog.showOpenDialog(window,{properties:['openFile','multiSelections'],filters:[{name:'Images',extensions:['png','jpg','jpeg','webp','gif']}]});
  if(result.canceled||!result.filePaths?.length)return {cancelled:true,images:[]};
  if(result.filePaths.length>8)throw new Error('每次最多选择8张图片。');
  const images=result.filePaths.map(file=>{
    const info=io.lstatSync(file);
    if(!info.isFile()||info.isSymbolicLink()||info.size>MAX_IMAGE_BYTES)throw new Error('图片无效或超过4MiB。');
    const bytes=io.readFileSync(file);
    if(bytes.length!==info.size)throw new Error('图片读取期间发生变化，请重试。');
    const extension=path.extname(file).toLowerCase();
    return {bytes,name:path.basename(file),mime:({'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.gif':'image/gif'})[extension]};
  });
  if(images.reduce((sum,image)=>sum+image.bytes.length,0)>MAX_IMAGE_BYTES)throw new Error('图片原件合计不得超过4MiB；不会自动压缩。');
  return stageImages({images});
}
async function pasteImage({clipboard,stageImages}) {
  const image=clipboard.readImage();
  if(image.isEmpty())return {images:[],empty:true};
  const bytes=image.toPNG();
  if(bytes.length>MAX_IMAGE_BYTES)throw new Error('图片无效或超过4MiB。');
  return stageImages({images:[{bytes,mime:'image/png',name:'clipboard.png'}]});
}
module.exports={chooseImages,pasteImage,MAX_IMAGE_BYTES};
