import assert from 'node:assert/strict';
import { ArtifactRefSchema, SemanticPayloadSchema, semanticFields }
  from '../packages/contracts/dist/index.js';
const ref = {owner_id:'11111111-1111-4111-8111-111111111111',
  artifact_id:'22222222-2222-4222-8222-222222222222',revision:1,content_hash:'a'.repeat(64)};
assert.equal(ArtifactRefSchema.safeParse(ref).success, true);
for (const patch of [{owner_id:'o'},{content_hash:'abc'},{revision:0},{revision:-1},{revision:1.5}]) {
  assert.equal(ArtifactRefSchema.safeParse({...ref,...patch}).success, false);
}
assert.equal(ArtifactRefSchema.safeParse({...ref,revision:null}).success, true);
assert.deepEqual([...semanticFields], ['title','description','type','tags','body','resource','content_fields']);
const payload = {title:'t',description:'d',type:'Decision',tags:[],body:'b',resource:null,content_fields:{}};
assert.equal(SemanticPayloadSchema.safeParse(payload).success, true);
assert.equal(SemanticPayloadSchema.safeParse({...payload,tags:'not-an-array'}).success, false);
assert.equal(SemanticPayloadSchema.safeParse({...payload,body:42}).success, false);
console.log('tenant-information-contract: ok');
