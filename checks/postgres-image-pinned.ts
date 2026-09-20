import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateImageInputs } from '../testing/tenant-info/deployment.ts';
const lock = JSON.parse(readFileSync('deploy/postgres/versions.lock.json','utf8'));
const dockerfile = readFileSync('deploy/postgres/Dockerfile','utf8');
const config = readFileSync('deploy/postgres/postgresql.conf','utf8');
assert.equal(validateImageInputs({lock,dockerfile,config}).ok, true);
for (const postgres_version of ['16.15','18.6','19.0','17.bad']) {
  assert.equal(validateImageInputs({lock:{...lock,postgres_version},dockerfile,config}).ok, false);
}
const other = `sha256:${lock.base_image_digest.endsWith('a') ? 'b'.repeat(64) : 'a'.repeat(64)}`;
assert.equal(validateImageInputs({lock:{...lock,base_image_digest:other},dockerfile,config}).ok, false);
assert.equal(validateImageInputs({lock:{...lock,pg_textsearch_tag:'main'},dockerfile,config}).ok, false);
assert.equal(validateImageInputs({lock,dockerfile,config:"shared_preload_libraries = ''\n"}).ok, false);
console.log('postgres-image-pinned: ok');
