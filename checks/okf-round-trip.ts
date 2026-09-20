import assert from 'node:assert/strict';
import { parseKnowledge, serializeKnowledge, validateNative, validateOkf }
  from '../services/zz-core/dist/tenant-info/export.js';
const raw = ['---','type: ForeignType','title: t','description: d',
  'unknown_key: keep-me','nested:','  numbers: [1, 2]',
  'verified_against: subject-v3','---','','body'].join('\n');
const first = parseKnowledge(raw);
const second = parseKnowledge(serializeKnowledge(first));
assert.equal(second.type,'ForeignType');
assert.equal(second.unknown_key,'keep-me');
assert.deepEqual(second.nested,{numbers:[1,2]});
assert.equal(second.verified_against,'subject-v3');
assert.equal(second.verified,undefined);
assert.equal(second.zz_profile,'legacy-okf');
assert.equal(validateOkf(second).ok,true);
assert.equal(validateNative(second).ok,false);
assert.equal(validateOkf({...second,type:''}).ok,false);
console.log('okf-round-trip: ok');
