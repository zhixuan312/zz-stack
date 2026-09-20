import assert from 'node:assert/strict';
import { validateIsolationObservation } from '../testing/tenant-info/isolation.ts';
const owner='11111111-1111-4111-8111-111111111111';
const state={stats:{documents:40,terms:120},results:[{owner_id:owner,
  artifact_id:'22222222-2222-4222-8222-222222222222',revision:1,score:-1.25}]};
const good={owner_id:owner,query:'distinctive',before:state,after:structuredClone(state),
  forbidden_metadata:[]};
assert.equal(validateIsolationObservation(good).ok,true);
assert.equal(validateIsolationObservation({...good,before:{...state,results:[]}}).ok,false);
const leaked=structuredClone(good); leaked.after.stats.documents=5040;
assert.equal(validateIsolationObservation(leaked).ok,false);
const score=structuredClone(good); score.after.results[0].score=-2;
assert.equal(validateIsolationObservation(score).ok,false);
assert.equal(validateIsolationObservation({...good,forbidden_metadata:['private-title']}).ok,false);
console.log('tenant-isolation-statistics: ok');
