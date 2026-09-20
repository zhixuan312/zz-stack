import assert from 'node:assert/strict';
import { rrf, budgets, resultKey } from '../services/zz-core/dist/tenant-info/retrieval.js';
assert.deepEqual(budgets(1),{exact:5,lexical:200,fuzzy:100,graph:50});
assert.deepEqual(budgets(15),{exact:50,lexical:300,fuzzy:150,graph:75});
assert.deepEqual(budgets(50),{exact:50,lexical:1000,fuzzy:500,graph:200});
for (const n of [0,51,1.5,NaN]) assert.throws(()=>budgets(n));
const lists=[{lane:'lexical',corpus:'private',keys:['a','b']},
  {lane:'lexical',corpus:'shared',keys:['a','c']},
  {lane:'exact',corpus:'private',keys:['b']}];
const scored=rrf(lists);
assert.deepEqual(scored.map(x=>x.key).sort(),['a','b','c']);
const scores=new Map(scored.map(x=>[x.key,x.score]));
assert.ok(Math.abs(scores.get('a')! - 1/61)<1e-12);
assert.ok(Math.abs(scores.get('b')! - (1/62+1/61))<1e-12);
assert.ok(Math.abs(scores.get('c')! - 1/62)<1e-12);
assert.equal(scored[0].key,'b');
assert.deepEqual(rrf([...lists].reverse()),scored);
const ties=[{lane:'exact',corpus:'private',keys:['a','b']},
  {lane:'lexical',corpus:'private',keys:['b','a']}];
assert.deepEqual(rrf(ties).map(x=>x.key),['a','b']);
assert.deepEqual(rrf([...ties].reverse()),rrf(ties));
const row={owner_id:'11111111-1111-4111-8111-111111111111',
  artifact_id:'22222222-2222-4222-8222-222222222222',revision:1,content_hash:'a'.repeat(64),scope:'history'};
assert.notEqual(resultKey(row),resultKey({...row,revision:2}));
assert.notEqual(resultKey(row),resultKey({...row,owner_id:'33333333-3333-4333-8333-333333333333'}));
assert.equal(resultKey({...row,scope:'current'}),resultKey({...row,scope:'current',revision:2}));
console.log('tenant-fusion-arithmetic: ok');
