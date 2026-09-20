import assert from 'node:assert/strict';
import { canonicalHash, isNoOp } from '../services/zz-core/dist/tenant-info/policies.js';
const base = {title:'t',description:'d',type:'Decision',tags:['b','a'],
  body:'line\n',resource:null,content_fields:{x:1,y:2}};
const h = canonicalHash(base);
assert.match(h,/^[0-9a-f]{64}$/);
assert.equal(canonicalHash({...base,tags:['a','b','a']}),h);
assert.equal(canonicalHash({...base,body:'line\r\n'}),h);
assert.equal(canonicalHash({...base,content_fields:{y:2,x:1}}),h);
for (const patch of [{description:'d2'},{title:'t2'},{type:'Fact'},
  {tags:['a','c']},{resource:'asset:one'},{body:'line'},{content_fields:{x:2,y:2}}]) {
  assert.notEqual(canonicalHash({...base,...patch}),h);
}
assert.equal(isNoOp(base,base),true);
assert.equal(isNoOp(base,{...base,description:'changed'}),false);
console.log('tenant-revision-boundary: ok');
