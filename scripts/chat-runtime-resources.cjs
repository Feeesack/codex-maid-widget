'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {createRequire}=require('node:module');
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
function locate(name,from,anchor){
  const reader=createRequire(path.join(from,'package.json'));
  for(const base of reader.resolve.paths(name)||[]){const relative=path.relative(anchor,base);if(relative.startsWith('..')||path.isAbsolute(relative))continue;const candidate=path.join(base,...name.split('/'),'package.json');if(fs.existsSync(candidate))return {folder:path.dirname(candidate),modules:base,manifest:JSON.parse(fs.readFileSync(candidate,'utf8'))};}
  throw new Error('Missing production dependency: '+name);
}
function productionClosure(root){
  const app=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8')),entries=new Map(),anchor=path.join(root,'node_modules');
  const visit=(name,from,optional=false)=>{
    let found;try{found=locate(name,from,anchor);}catch(error){if(optional)return;throw error;}
    const relative=path.relative(anchor,found.folder);
    if(relative.startsWith('..')||path.isAbsolute(relative))throw new Error('Dependency resolved outside the selected npm tree: '+name);
    if(entries.has(relative))return;
    for(let current=found.folder;current!==root;current=path.dirname(current))if(fs.lstatSync(current).isSymbolicLink())throw new Error('Linked production package is not a portable npm install: '+name);
    entries.set(relative,{relative,source:found.folder,manifest:found.manifest});
    const optionalNames=new Set(Object.keys(found.manifest.optionalDependencies||{}));
    for(const child of Object.keys({...found.manifest.dependencies,...found.manifest.optionalDependencies}).sort())visit(child,found.folder,optionalNames.has(child));
  };
  for(const name of Object.keys(app.dependencies||{}).sort())visit(name,root);
  return [...entries.values()].sort((a,b)=>a.relative.localeCompare(b.relative));
}
function copyPackage(source,target){
  fs.cpSync(source,target,{recursive:true,errorOnExist:false,force:false,filter:file=>{
    if(fs.lstatSync(file).isSymbolicLink())throw new Error('Link in production dependency');
    if(file===source)return true;
    const relative=path.relative(source,file),parts=relative.split(path.sep),name=parts.at(-1)||'';
    if(parts.some(part=>part==='node_modules'||part==='.git'))return false;
    // Type maps are development metadata and can push an otherwise valid
    // localized install over Windows' legacy path limit. Runtime JavaScript
    // and package notices remain; source maps are never loaded by the app.
    if(/\.d\.ts\.map$|\.map$/i.test(name))return false;
    return true;
  }});
}
function validateNativeTargets(dependencies,platform,arch){
  const onnx=dependencies.find(entry=>entry.manifest.name==='onnxruntime-node');if(!onnx)return;
  const architectures=arch==='universal'?['arm64','x64']:[arch];
  for(const target of architectures){
    if(!fs.existsSync(path.join(onnx.source,'bin','napi-v3',platform,target,'onnxruntime_binding.node')))throw new Error('Missing target ONNX CPU runtime: '+platform+'/'+target);
    if(!dependencies.some(entry=>entry.manifest.name==='@img/sharp-'+platform+'-'+target))throw new Error('Missing target Sharp runtime; install production dependencies for '+platform+'/'+target);
  }
}
function stageRuntimeResources({root,resources,platform=process.platform,arch=process.arch}={}){
  if(!path.isAbsolute(root||'')||!path.isAbsolute(resources||''))throw new Error('Explicit absolute runtime resource paths required');
  for(const name of ['node_modules','chat-semantic','chat-runtime-resources.json'])if(fs.existsSync(path.join(resources,name)))throw new Error('Runtime resource destination must be fresh: '+name);
  fs.mkdirSync(resources,{recursive:true});
  const dependencies=productionClosure(root),packages=[];
  validateNativeTargets(dependencies,platform,arch);
  const targetArch = ['arm64', 'x64'].includes(arch) ? arch : null;
  for(const entry of dependencies){
    const packageArch = entry.manifest.name.match(/(?:sharp|sharp-libvips)-darwin-(arm64|x64)$/)?.[1];
    if(targetArch && packageArch && packageArch !== targetArch) continue;
    copyPackage(entry.source,path.join(resources,'node_modules',entry.relative));
    packages.push({name:entry.manifest.name,version:entry.manifest.version,license:entry.manifest.license||'See package notices',path:'node_modules/'+entry.relative.replaceAll('\\','/')});
  }
  const model=path.join(root,'resources','chat-semantic');
  if(!fs.existsSync(model))throw new Error('Missing pinned local semantic resources; run the explicit preparation script before building');
  const semantic=require(path.join(root,'src','chat-semantic-manifest.cjs'));
  const files=[];
  if(fs.lstatSync(model).isSymbolicLink())throw new Error('Link in semantic resources');
  for(const [relative,expected] of Object.entries(semantic.files)){
    const parts=relative.split('/');if(parts.some(p=>!p||p==='.'||p==='..'))throw new Error('Unsafe semantic manifest path');
    const source=path.join(model,'model',...parts);
    for(let current=source;current!==model;current=path.dirname(current))if(fs.lstatSync(current).isSymbolicLink())throw new Error('Link in semantic resources');
    const bytes=fs.readFileSync(source);if(bytes.length!==expected.size||sha(bytes)!==expected.sha256)throw new Error('Pinned semantic resource mismatch');
    const target=path.join(resources,'chat-semantic','model',...parts);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,bytes);
    files.push({path:'chat-semantic/model/'+relative,size:bytes.length,sha256:expected.sha256});
  }
  fs.writeFileSync(path.join(resources,'chat-semantic','manifest.json'),JSON.stringify(semantic,null,2)+'\n');
  const manifest={schema:'codex-maid-runtime-resources/1',version:JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8')).version,platform,arch,packages,modelFiles:files};
  fs.writeFileSync(path.join(resources,'chat-runtime-resources.json'),JSON.stringify(manifest,null,2)+'\n');return manifest;
}
module.exports={productionClosure,stageRuntimeResources,validateNativeTargets};
