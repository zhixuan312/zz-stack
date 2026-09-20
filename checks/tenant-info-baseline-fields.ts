import assert from 'node:assert/strict';
import { validateBaseline } from '../scripts/tenant-info/baseline.ts';
const hash = 'a'.repeat(64), sha = 'b'.repeat(40);
const fields = ['captured_at','review_reference_sha','checkout_sha','runtime_image_digest',
  'tool_schema_sha256','migration_head','postgres_version','extensions','database_locale',
  'collation_provider','collation_version','compose_project','volume_ids','owner_inventory',
  'file_manifest_hash','counts','edit_surface'];
const good = { status:'complete', captured_at:'2026-09-20T00:00:00Z',
  review_reference_sha:sha, checkout_sha:sha, runtime_image_digest:`sha256:${hash}`,
  tool_schema_sha256:hash, migration_head:'069', postgres_version:'16.15',
  extensions:[{name:'citext',version:'fixture'}], database_locale:'C.UTF-8',
  collation_provider:'libc', collation_version:null, compose_project:'isolated-fixture',
  volume_ids:{artifacts:'fixture-a',credentials:'fixture-c'},
  owner_inventory:[{owner_id:'11111111-1111-4111-8111-111111111111',files:0}],
  file_manifest_hash:hash, counts:[{name:'tagged',value:0,query:'SELECT 0 AS tagged'}],
  edit_surface:[{path:'package.json',task:'I-1',change:'modified',exists:true,
    coverage:'command-registration',evidence:'fixture inspection'}],
  measurement_evidence:Object.fromEntries(fields.map(f => [f,{kind:'synthetic-test',locator:f}])) };
assert.equal(validateBaseline(good).ok, true);
for (const field of fields) {
  const bad: Record<string, unknown> = structuredClone(good);
  delete bad[field];
  assert.equal(validateBaseline(bad).ok, false, `missing ${field}`);
}
const missingQuery = structuredClone(good);
missingQuery.counts[0].query = '';
assert.equal(validateBaseline(missingQuery).ok, false);
assert.equal(validateBaseline({...good, database_url:'postgres://u:secret@host/db'}).ok, false);
console.log('tenant-info-baseline-fields: ok');
