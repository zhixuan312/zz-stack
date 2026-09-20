import assert from 'node:assert/strict';
import { planCorpora, textFixture } from '../scripts/tenant-info/inventory.ts';
const expected = { primary_current:150000, primary_evidence:150000,
  primary_history:150000, other_team_a:150000, other_team_b:150000,
  shared_current:15000, shared_evidence:15000 };
const full = planCorpora(1);
assert.deepEqual(Object.keys(full).sort(), Object.keys(expected).sort());
for (const [key, count] of Object.entries(expected)) {
  assert.deepEqual(full[key], {records:count, one_mib:count/1500});
  assert.deepEqual(planCorpora(0.1)[key], {records:count/10, one_mib:count/15000});
}
for (const scale of [0.002, 0.01]) {
  assert.throws(() => planCorpora(scale),
    (e: unknown) => e instanceof Error && 'code' in e && e.code === 'FRACTIONAL_FIXTURE_COUNT');
}
for (const language of ['en','zh','mixed'] as const) {
  const req = {seed:1,ordinal:7,bytes:4096,language};
  const a = textFixture(req), b = textFixture(req);
  assert.equal(a, b);
  assert.equal(Buffer.byteLength(a, 'utf8'), 4096);
  assert.notEqual(a, textFixture({...req,ordinal:8}));
}
assert.equal(Buffer.byteLength(textFixture({seed:1,ordinal:0,bytes:1048576,language:'mixed'}),'utf8'),1048576);
console.log('tenant-info-corpus-shape: ok');
