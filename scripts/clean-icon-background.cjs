'use strict';
// Remove only the connected outer black matte; preserve the illustration pixels.
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const root=path.resolve(__dirname,'..');
app.setPath('userData',fs.mkdtempSync(path.join(os.tmpdir(),'maid-icon-alpha-')));
app.whenReady().then(async()=>{
 const win=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
 try {
  await win.loadURL('about:blank');
  const original=fs.readFileSync(path.join(root,'assets/app-icon-original.png')).toString('base64');
  const result=await win.webContents.executeJavaScript(`(async()=>{
   const image=new Image();image.src='data:image/png;base64,${original}';await image.decode();
   const width=image.naturalWidth,height=image.naturalHeight;
   const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;
   const context=canvas.getContext('2d',{willReadFrequently:true});context.drawImage(image,0,0);
   const pixels=context.getImageData(0,0,width,height),data=pixels.data;
   const mask=new Uint8Array(width*height),queue=new Int32Array(width*height);let head=0,tail=0;
   const visit=index=>{
    if(mask[index])return;
    const p=index*4;
    if(Math.max(data[p],data[p+1],data[p+2])>244)return;
    mask[index]=1;queue[tail++]=index;
   };
   for(let x=0;x<width;x++){visit(x);visit((height-1)*width+x)}
   for(let y=0;y<height;y++){visit(y*width);visit(y*width+width-1)}
   while(head<tail){const i=queue[head++],x=i%width,y=Math.floor(i/width);if(x)visit(i-1);if(x+1<width)visit(i+1);if(y)visit(i-width);if(y+1<height)visit(i+width)}
   let transparent=0,antialiased=0;
   for(let i=0;i<mask.length;i++)if(mask[i]){
    const p=i*4,m=Math.max(data[p],data[p+1],data[p+2]);
    if(m<=24){data[p]=data[p+1]=data[p+2]=data[p+3]=0;transparent++}
    else{
     // Undo the original black-matte blend along the pale tile's boundary.
     data[p]=Math.round(data[p]*255/m);data[p+1]=Math.round(data[p+1]*255/m);data[p+2]=Math.round(data[p+2]*255/m);data[p+3]=m;antialiased++;
    }
   }
   const before=context.getImageData(0,0,width,height).data;let changedInteriorPixels=0;
   for(let i=0;i<mask.length;i++)if(!mask[i]){const p=i*4;if(data[p]!==before[p]||data[p+1]!==before[p+1]||data[p+2]!==before[p+2]||data[p+3]!==before[p+3])changedInteriorPixels++}
   context.putImageData(pixels,0,0);
   return{png:canvas.toDataURL('image/png').split(',')[1],metrics:{width,height,externalPixels:tail,transparentPixels:transparent,antialiasedPixels:antialiased,changedInteriorPixels,cornerAlpha:[data[3],data[(width-1)*4+3],data[((height-1)*width)*4+3],data[(width*height-1)*4+3]]}};
  })()`);
  if(result.metrics.changedInteriorPixels||result.metrics.cornerAlpha.some(a=>a!==0))throw Error('Icon alpha cleanup failed verification');
  fs.writeFileSync(path.join(root,'assets/app-icon-master.png'),Buffer.from(result.png,'base64'));
  console.log(JSON.stringify(result.metrics));
 }finally{win.destroy()}
 app.exit(0);
}).catch(error=>{console.error(error.message);app.exit(1)});
