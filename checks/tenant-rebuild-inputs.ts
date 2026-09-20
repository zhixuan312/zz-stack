import assert from 'node:assert/strict';
import { needsRederive } from '../packages/indexing/dist/tenant-rebuild.js';
import { derivationFingerprint } from '../packages/indexing/dist/tenant-analysis.js';
const base = {content_hash:'a'.repeat(64),record_format:1,parser:1,analyzer:1,passage:1,projection:1};
const first = derivationFingerprint(base);
assert.equal(needsRederive(first,first),false);
for (const key of ['record_format','parser','analyzer','passage','projection']) {
  const next = derivationFingerprint({...base,[key]:2});
  assert.equal(needsRederive(first,next),true);
}
assert.equal(needsRederive(null,first),true);
console.log('tenant-rebuild-inputs: ok');
