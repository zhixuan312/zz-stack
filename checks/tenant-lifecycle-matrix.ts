import assert from 'node:assert/strict';
import { decideTransition } from '../services/zz-core/dist/tenant-info/policies.js';
const ctx = {artifact_class:'work_document',operation:'approve',actor_authorized:true,
  gate_declared:true,current_revision:2,expected_revision:2,
  record_digest:'a'.repeat(64),expected_record_digest:'a'.repeat(64),reason:'fixture'};
assert.equal(decideTransition(ctx).accepted,true);
assert.equal(decideTransition({...ctx,gate_declared:false}).code,'GATE_REFUSED');
assert.equal(decideTransition({...ctx,actor_authorized:false}).accepted,false);
assert.equal(decideTransition({...ctx,expected_revision:1}).accepted,false);
assert.equal(decideTransition({...ctx,expected_record_digest:'b'.repeat(64)}).accepted,false);
assert.equal(decideTransition({...ctx,artifact_class:'knowledge_concept'}).code,'INVALID_INPUT');
assert.equal(decideTransition({...ctx,artifact_class:'source',operation:'verify'}).code,'INVALID_INPUT');
assert.equal(decideTransition({...ctx,artifact_class:'source',operation:'revise'}).code,'SOURCE_IMMUTABLE');
assert.equal(decideTransition({...ctx,operation:'set_knowledge_status'}).accepted,false);
console.log('tenant-lifecycle-matrix: ok');
