'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {productionClosure,stageRuntimeResources}=require('../scripts/chat-runtime-resources.cjs');
function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'挂件资源 独立目录 '));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const write=(relative,value)=>{const p=path.join(root,relative);fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,typeof value==='string'?value:JSON.stringify(value));};return{root,write};}
test('portable dependency closure retains nested versions and excludes development-only packages',t=>{
 const{root,write}=fixture(t);write('package.json',{dependencies:{runtime:'1'},devDependencies:{private:'1'}});write('node_modules/runtime/package.json',{name:'runtime',version:'1',dependencies:{shared:'1'},optionalDependencies:{missing:'1'}});write('node_modules/runtime/node_modules/shared/package.json',{name:'shared',version:'1'});write('node_modules/private/package.json',{name:'private',version:'1'});
 const closure=productionClosure(root);assert.deepEqual(closure.map(x=>x.manifest.name).sort(),['runtime','shared']);assert.ok(closure.some(x=>x.relative===path.join('runtime','node_modules','shared')));
});
test('staging binds pinned model bytes, copies notices and omits extra resource files',t=>{
 const{root,write}=fixture(t);const bytes=Buffer.from('synthetic model only'),sha256=crypto.createHash('sha256').update(bytes).digest('hex');write('package.json',{version:'9.8.7',dependencies:{runtime:'1'}});write('node_modules/runtime/package.json',{name:'runtime',version:'1',license:'MIT'});write('node_modules/runtime/LICENSE','synthetic dependency notice');write('src/chat-semantic-manifest.cjs','module.exports='+JSON.stringify({files:{'onnx/model.onnx':{size:bytes.length,sha256}}}));write('resources/chat-semantic/model/onnx/model.onnx',bytes.toString());write('resources/chat-semantic/private-note.txt','must not ship');
 const destination=path.join(root,'非默认运行目录 空格','resources'),manifest=stageRuntimeResources({root,resources:destination});assert.equal(manifest.version,'9.8.7');assert.equal(manifest.modelFiles.length,1);assert.equal(fs.readFileSync(path.join(destination,'node_modules/runtime/LICENSE'),'utf8'),'synthetic dependency notice');assert.equal(fs.existsSync(path.join(destination,'chat-semantic/private-note.txt')),false);
 write('resources/chat-semantic/model/onnx/model.onnx','changed');assert.throws(()=>stageRuntimeResources({root,resources:path.join(root,'other resources')}),/mismatch/);
 assert.throws(()=>stageRuntimeResources({root,resources:destination}),/fresh/);
});
test('dependency lookup never silently imports an ancestor npm installation',t=>{
 const{root,write}=fixture(t);write('node_modules/runtime/package.json',{name:'runtime',version:'1'});write('child/package.json',{dependencies:{runtime:'1'}});assert.throws(()=>productionClosure(path.join(root,'child')),/Missing production dependency/);
});
