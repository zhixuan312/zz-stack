import assert from 'node:assert/strict';
import { assessAcceptance } from '../scripts/tenant-info/verify.ts';
const ids=['AC-1.1','AC-2.1','AC-2.2','AC-3.1','AC-4.1','AC-5.1','AC-5.2',
  'AC-6.1','AC-6.2','AC-7.1','AC-7.2','AC-8.1','AC-8.2'];
const binding={source_tree_sha256:'a'.repeat(64),spec_body_sha256:'b'.repeat(64),
  plan_body_sha256:'c'.repeat(64),runtime_image_digest:`sha256:${'d'.repeat(64)}`,
  dependency_lock_sha256:'e'.repeat(64),corpus_hash:'f'.repeat(64),qrels_hash:'0'.repeat(64)};
const criteria=Object.fromEntries(ids.map(id=>[id,{method:id==='AC-6.1'?'human':id==='AC-8.2'?'agent-review':'command',
  status:'passed',exit_code:id==='AC-6.1'||id==='AC-8.2'?null:0,evidence_ids:[id]}]));
const files=['baseline.json','extension-features.json','qrels-approval.json','classification.json',
  'migration.json','parity.json','restore.json','cutover-rehearsal.json','benchmark.json'];
const prerequisites=Object.fromEntries(files.map(id=>[id,{applicable:true,status:'passed',evidence_ids:[id]}]));
const evidence=[...ids,...files].map(id=>({id,sha256:'1'.repeat(64),verified:true,binding}));
const gate={verdict:'PASSED',discovered_ids:['fixture-check'],executed_ids:['fixture-check'],
  skipped_ids:[],failed_ids:[],binding};
const good={criteria,prerequisites,gate,binding,evidence};
assert.equal(assessAcceptance(good).ready,true);
const failed=structuredClone(good);
for (const id of ids) failed.criteria[id].status='failed';
assert.equal(assessAcceptance(failed).structure_valid,true);
assert.equal(assessAcceptance(failed).ready,false);
const missing=structuredClone(good); delete missing.criteria['AC-8.2'];
assert.equal(assessAcceptance(missing).ready,false);
const wrongMethod=structuredClone(good); wrongMethod.criteria['AC-6.1'].method='command';
assert.equal(assessAcceptance(wrongMethod).ready,false);
const stale=structuredClone(good); stale.gate.binding={...binding,source_tree_sha256:'2'.repeat(64)};
assert.equal(assessAcceptance(stale).ready,false);
const unverified=structuredClone(good); unverified.evidence[0].verified=false;
assert.equal(assessAcceptance(unverified).ready,false);
const blocked=structuredClone(good); blocked.prerequisites['restore.json'].status='blocked';
assert.equal(assessAcceptance(blocked).ready,false);
const exit=structuredClone(good); exit.criteria['AC-1.1'].exit_code=1;
assert.equal(assessAcceptance(exit).ready,false);
assert.equal(assessAcceptance({...good,gate:{...gate,executed_ids:[]}}).ready,false);
console.log('acceptance-covers-every-criterion: ok');
