'use strict';
const {test}=require('node:test'); const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {MaintenanceTask,STAGES}=require('../src/chat-maintenance.cjs');
function fixture(t, options={}) {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'maid-chat-task-中文 '));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 let now=1000;const task=new MaintenanceTask({projectRoot:root,clock:()=>now,...options});
 return {task,root,tick:n=>{now+=n;}};
}
const plan=STAGES.map(stage=>({stage,input:100,output:20}));
test('transaction stages are serial, stop/resume retains completed work and all budgets',t=>{
 const {task,tick}=fixture(t);
 task.begin({id:'task',sourceWatermark:'s1',operationWatermark:0,terminal:'completed',plan});
 task.resume({sourceWatermark:'s1',operationWatermark:0});
 const ready={quotaFresh:true,quotaAvailable:true};
 assert.throws(()=>task.reserve('batch-2',ready),/ORDER/);
 for(let i=1;i<=STAGES.length;i++) {
  task.reserve(`batch-${i}`,ready);tick(4);task.settle(`batch-${i}`,{status:'completed',artifactVersion:`v${i}`});
  if(i===1){task.stop();task.resume({sourceWatermark:'s1',operationWatermark:0});assert.equal(task.reserve('batch-1',ready).reuse,true);}
 }
 assert.equal(task.get().state,'completed'); assert.equal(task.get().used.calls,7);assert.equal(task.get().used.activeMs,28);
});
test('unknown is never replayed and reconciliation retains reservations',t=>{
 const {task,root}=fixture(t);const ready={quotaFresh:true,quotaAvailable:true};
 task.begin({id:'task',sourceWatermark:'s',operationWatermark:0,terminal:'failed',plan});
 task.resume({sourceWatermark:'s',operationWatermark:0});task.reserve('batch-1',ready);
 task.settle('batch-1',{status:'unknown'});
 const next=new MaintenanceTask({projectRoot:root});
 assert.throws(()=>next.resume({sourceWatermark:'s',operationWatermark:0}),/UNKNOWN/);
 task.settle('batch-1',{status:'completed',artifactVersion:'v1'});
 task.resume({sourceWatermark:'s',operationWatermark:0});assert.equal(task.get().used.calls,1);
});
test('400K synthetic plan is bounded; no input body reaches recovery metadata',t=>{
 const {task,root}=fixture(t);
 const batches=Array.from({length:14},()=>({stage:'archive',input:28572,output:1000}));
 const state=task.begin({id:'large',sourceWatermark:'source-400K',operationWatermark:0,terminal:'interrupted',plan:batches,kind:'subtask'});
 assert.equal(state.plan.length,14);assert.equal(state.used.calls,0);
 for(let i=0;i<8;i++) assert.equal(task.enqueue({id:String(i),text:'PRIVATE-SYNTHETIC-BODY'}).accepted,true);
 assert.equal(task.enqueue({id:'9',text:'keep editor'}).accepted,false);
 assert.equal(fs.readFileSync(path.join(root,'memory/maintenance/active.jsonl'),'utf8').includes('PRIVATE-SYNTHETIC-BODY'),false);
 assert.throws(()=>task.begin({id:'new',sourceWatermark:'s',operationWatermark:0,terminal:'completed',plan}),/ALREADY/);
});
test('an archive-only subtask cannot masquerade as an entire completed checkpoint',t=>{
 const {task}=fixture(t);const partial=[{stage:'archive',input:100,output:20}];
 assert.throws(()=>task.begin({id:'partial',sourceWatermark:'s',operationWatermark:0,terminal:'completed',plan:partial}),/STAGES_REQUIRED/);
 task.begin({id:'partial',sourceWatermark:'s',operationWatermark:0,terminal:'completed',plan:partial,kind:'subtask'});
 task.resume({sourceWatermark:'s',operationWatermark:0});task.reserve('batch-1',{quotaFresh:true,quotaAvailable:true});
 task.settle('batch-1',{status:'completed',artifactVersion:'v1'});
 assert.equal(task.get().state,'subtask-completed');assert.notEqual(task.get().state,'completed');
});
test('unknown terminal, invalid bounds, later baseline and retries fail closed',t=>{
 const {task}=fixture(t);const ready={quotaFresh:true,quotaAvailable:true};
 assert.throws(()=>task.begin({sourceWatermark:'s',operationWatermark:0,terminal:'unknown',plan}),/TERMINAL/);
 task.begin({id:'x',sourceWatermark:'s',operationWatermark:0,terminal:'completed',plan});
 assert.throws(()=>task.resume({sourceWatermark:'new',operationWatermark:0}),/BASELINE/);
 task.resume({sourceWatermark:'s',operationWatermark:0});
 for(let i=0;i<2;i++){task.reserve('batch-1',ready);task.settle('batch-1',{status:'failed'});task.resume({sourceWatermark:'s',operationWatermark:0});}
 assert.throws(()=>task.reserve('batch-1',ready),/BUDGET/);
});
