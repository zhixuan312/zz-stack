import assert from 'node:assert/strict';
import { requestHash, classifyCommitOutcome } from '../services/zz-core/dist/tenant-info/mutations.js';
const req = {operation:'revise',idempotency_key:'k',artifact_id:'22222222-2222-4222-8222-222222222222',
  expected_etag:'1:1',payload:{title:'t',body:'b'},cause_refs:[]};
assert.match(requestHash(req),/^[0-9a-f]{64}$/);
assert.equal(requestHash(req),requestHash(Object.fromEntries(Object.entries(req).reverse())));
assert.notEqual(requestHash(req),requestHash({...req,payload:{title:'t',body:'changed'}}));
assert.notEqual(requestHash(req),requestHash({...req,expected_etag:'1:2'}));
assert.equal(classifyCommitOutcome({publication:'absent',durable:false}),false);
assert.equal(classifyCommitOutcome({publication:'published',durable:false}),'unknown');
assert.equal(classifyCommitOutcome({publication:'uncertain',durable:false}),'unknown');
assert.equal(classifyCommitOutcome({publication:'published',durable:true}),true);
console.log('tenant-kernel-codes: ok');
