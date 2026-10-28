'use strict';
// Pure synthetic records only: this review never constructs a service, reads
// user directories, opens authentication files or invokes a model.
const test=require('node:test'),assert=require('node:assert/strict');
const {samplesFor}=require('../src/chat-dream-budget.cjs');
const now=2000000000,input={quota:{scope:'synthetic-review-scope',planType:'synthetic'},model:'synthetic-model',effort:'medium',now};
function synthetic(afterObservedAt){return {status:'adopted',adopted:true,calls:1,model:input.model,effort:input.effort,scope:input.quota.scope,planType:'synthetic',windowId:'synthetic-window',before:{scope:input.quota.scope,windowId:'synthetic-window',windowMinutes:300,observedAt:now-12000},startedAt:now-10000,finishedAt:now-1000,observation:{sameWindowChange:3,attribution:'shared',reason:null,at:now,afterObservedAt}};}
test('calibration excludes a cached in-flight reading retrieved after the task finished',()=>{
  assert.equal(samplesFor([synthetic(now-5000)],input).samples.length,0);
});
test('calibration requires an actual terminal reading time instead of treating retrieval time as the reading',()=>{
  assert.equal(samplesFor([synthetic(undefined)],input).samples.length,0);
  assert.equal(samplesFor([synthetic(now+1000)],input).samples.length,0);
  assert.equal(samplesFor([synthetic(now-500)],input).samples.length,1);
});
