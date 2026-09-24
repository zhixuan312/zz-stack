import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { validateMigrationNames } from '../scripts/tenant-info/inventory.ts';
const slug = 'artifacts_revisions_events_and_scoped_search';
// The real directory is asked about a slug it still has: every prefix in it is unique, and a
// slug it carries is carried once. Asked of `init`, which 001_init.sql names, so this reads a
// live directory rather than a constant written down here.
const existing = readdirSync('services/gateway/migrations').filter(f => f.endsWith('.sql'));
assert.equal(validateMigrationNames(existing,'init').ok,true);
const mine = `070_${slug}.sql`;
assert.equal(validateMigrationNames(['069_previous.sql',mine],slug).ok,true);
assert.equal(validateMigrationNames(['069_previous.sql',mine,'071_future.sql'],slug).ok,true);
assert.equal(validateMigrationNames(['069_previous.sql',mine,'070_collision.sql'],slug).ok,false);
assert.equal(validateMigrationNames(['069_previous.sql'],slug).ok,false);
assert.equal(validateMigrationNames([mine,`071_${slug}.sql`],slug).ok,false);
console.log('tenant-migration-shape: ok');
