import assert from 'node:assert/strict';
import { resolveCorpora } from '../services/zz-core/dist/tenant-info/retrieval.js';
const A='11111111-1111-4111-8111-111111111111', B='22222222-2222-4222-8222-222222222222';
const P='33333333-3333-4333-8333-333333333333';
const registry = [
  {corpus_key:'team-a-current',owner_id:A,scope:'current',audience:'private',index_name:'a_current'},
  {corpus_key:'team-a-history',owner_id:A,scope:'history',audience:'private',index_name:'a_history'},
  {corpus_key:'team-b-current',owner_id:B,scope:'current',audience:'private',index_name:'b_current'},
  {corpus_key:'platform-private',owner_id:P,scope:'current',audience:'private',index_name:'p_private'},
  {corpus_key:'shared-current',owner_id:P,scope:'current',audience:'published',index_name:'p_shared'}];
const context={owner_id:A,shared_allowed:true};
const keys = (request: object) => resolveCorpora(context,request,registry).map(x => x.corpus_key).sort();
assert.deepEqual(keys({}),['shared-current','team-a-current']);
assert.deepEqual(keys({scopes:['history']}),['team-a-history']);
assert.deepEqual(keys({scopes:['current','history']}),['shared-current','team-a-current','team-a-history']);
assert.deepEqual(resolveCorpora({...context,shared_allowed:false},{},registry).map(x=>x.corpus_key),['team-a-current']);
assert.throws(()=>resolveCorpora(context,{scopes:[]},registry));
assert.throws(()=>resolveCorpora(context,{scopes:['everything']},registry));
assert.throws(()=>resolveCorpora(context,{owner_id:B,index_name:'b_current'},registry));
console.log('tenant-scope-predicates: ok');
