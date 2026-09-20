import assert from 'node:assert/strict';
import { manifestHash, commitFilename } from '../services/zz-core/dist/tenant-info/record.js';
const tx = '33333333-3333-4333-8333-333333333333';
const m = {format_version:1,owner_id:'11111111-1111-4111-8111-111111111111',
  sequence:1,transaction_id:tx,idempotency_key:'fixture',request_hash:'a'.repeat(64),
  actor:'fixture',at:'2026-09-20T00:00:00Z',previous_commit_hash:null,
  file_changes:[],source_captures:[],revisions:[],events:[]};
const h = manifestHash(m);
assert.match(h,/^[0-9a-f]{64}$/);
assert.equal(manifestHash({...m,manifest_hash:'b'.repeat(64)}),h);
assert.equal(manifestHash(Object.fromEntries(Object.entries(m).reverse())),h);
assert.notEqual(manifestHash({...m,actor:'another-actor'}),h);
assert.notEqual(manifestHash({...m,previous_commit_hash:'c'.repeat(64)}),h);
assert.equal(commitFilename(1,tx),`1-${tx}.json`);
assert.throws(() => commitFilename(0,tx));
console.log('tenant-record-durability: ok');
