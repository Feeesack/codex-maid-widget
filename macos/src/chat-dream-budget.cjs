'use strict';
// Shared quota observations are evidence about the entire measurement interval,
// never exact attribution to one task. No token-to-percentage exchange is used.
const TERMINAL=new Set(['candidate','adopted','partial','discarded','no-change','failed','cancelled']);
const DAYS=14*86400000;
const finite=value=>typeof value==='number'&&Number.isFinite(value);
function samplesFor(jobs,{quota,model,effort,now=Date.now()}={}){
  const samples=[],rejected={};const reject=reason=>{rejected[reason]=(rejected[reason]||0)+1;};
  // Without a verified current opaque scope there is no proof of account continuity.
  if(typeof quota?.scope!=='string'||!quota.scope)return {samples,rejected:{'current-scope-unverified':1}};
  for(const job of (Array.isArray(jobs)?jobs:[]).slice(-256)){
    const observation=job.observation,before=job.before;
    if(!TERMINAL.has(job.status)||!job.calls){reject('no-confirmed-terminal');continue;}
    if(model&&job.model!==model||effort&&job.effort!==effort||quota?.scope&&job.scope!==quota.scope||quota?.planType&&job.planType&&job.planType!==quota.planType){reject('different-cohort');continue;}
    if(!finite(observation?.at)||observation.at>now||now-observation.at>DAYS){reject('expired-or-clock');continue;}
    if(observation.attribution!=='shared'||observation.reason||!finite(observation.sameWindowChange)||observation.sameWindowChange<0||observation.sameWindowChange>100){reject('invalid-observation');continue;}
    if(!before||before.scope!==job.scope||before.windowId!==job.windowId||before.windowMinutes!==300||!finite(before.observedAt)||!finite(job.startedAt)||!finite(job.finishedAt)||before.observedAt>job.startedAt||job.startedAt-before.observedAt>30000||job.finishedAt<job.startedAt||observation.at<job.finishedAt){reject('missing-paired-window');continue;}
    if(!finite(observation.afterObservedAt)||observation.afterObservedAt<job.finishedAt||observation.afterObservedAt>observation.at){reject('terminal-observation-unverified');continue;}
    const resolution=finite(observation.resolutionPoints)?Math.max(.01,observation.resolutionPoints):1;
    if(observation.sameWindowChange<resolution){reject('below-observation-resolution');continue;}
    if(finite(job.finishedAt)&&observation.at-job.finishedAt>30000||finite(job.startedAt)&&observation.at-job.startedAt>180000){reject('observation-lag');continue;}
    samples.push({points:observation.sameWindowChange,at:observation.at,resolution});
  }
  return {samples:samples.slice(-12),rejected};
}
function estimateDreamBudget(jobs,input={}){
  const{samples,rejected}=samplesFor(jobs,input),points=samples.map(s=>s.points).sort((a,b)=>a-b);
  const high=points.at(-1),predicted=Math.max(3,high===undefined?0:high*1.5+1);
  return {mode:'estimate',estimatedPoints:Math.ceil(predicted*10)/10,guarantee:false,
    method:samples.length?'shared-window-high-water-plus-margin':'uncalibrated-small-task-allowance',sampleCount:samples.length,
    confidence:samples.length>=5?'observed-shared-envelope':samples.length?'limited-shared-observations':'uncalibrated',
    calibration:{attribution:'shared',exactTaskCostKnown:false,accountContinuityRequired:true,currentScopeVerified:!!input.quota?.scope,observationResolutionPoints:samples.length?Math.max(...samples.map(s=>s.resolution)):1,highWaterPoints:high??null,medianPoints:points.length?points[Math.floor((points.length-1)/2)]:null,windowPairs:samples.length,ignoredSamples:rejected,validityDays:14,hiddenReasoningBoundKnown:false},
    inputLimit:8000,candidateLimit:2000,visibleOutputTarget:2000,calls:1,timeoutMs:120000,hiddenReasoningHardLimit:false};
}
function dreamBenefit(jobs){
  const all=Array.isArray(jobs)?jobs:[],paid=all.filter(j=>j.calls>0),candidates=paid.filter(j=>['candidate','adopted','partial','discarded'].includes(j.status)),adopted=candidates.filter(j=>j.adopted||['adopted','partial'].includes(j.status));
  const usage={inputTokens:0,outputTokens:0,reasoningOutputTokens:0},observations=paid.map(j=>j.observation).filter(o=>o?.attribution==='shared'&&finite(o.sameWindowChange));
  for(const job of paid)for(const key of Object.keys(usage))if(Number.isSafeInteger(job.usage?.[key])&&job.usage[key]>=0)usage[key]+=job.usage[key];
  return {tasks:all.length,modelCalls:paid.reduce((n,j)=>n+j.calls,0),candidates:candidates.length,adopted:adopted.length,partial:adopted.filter(j=>j.status==='partial'||j.adoption?.state==='partial').length,noChange:paid.filter(j=>j.status==='no-change').length,discarded:candidates.filter(j=>j.status==='discarded').length,unknown:all.filter(j=>j.status==='unknown').length,adoptionRate:candidates.length?adopted.length/candidates.length:null,estimatedPointsReserved:paid.reduce((n,j)=>n+(finite(j.reservedPoints)?j.reservedPoints:0),0),sharedObservationCount:observations.length,sharedWindowHighWater:observations.length?Math.max(...observations.map(o=>o.sameWindowChange)):null,exactCostAttribution:false,usage,semanticBenefitVerified:false};
}
module.exports={estimateDreamBudget,samplesFor,dreamBenefit};
