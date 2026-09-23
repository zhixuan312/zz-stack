import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { validateMigrationNames } from '../scripts/tenant-info/inventory.ts';
const slug = 'artifacts_revisions_events_and_scoped_search';
// THE REAL DIRECTORY IS ASKED ABOUT A SLUG IT STILL HAS. This asserted that
// `070_artifacts_revisions_events_and_scoped_search.sql` was in it, exactly once, with no
// prefix collision -- task acceptance, that a file had landed correctly named. It landed, and
// then 001..074 were squashed into 001_init.sql, so that filename is gone and the question is
// answered by history rather than by this directory. The half that still means something is the
// half that stays true for ever: every prefix in the directory is unique, and a slug it carries
// is carried once. Asked of `init`, which 001_init.sql names, so it is a live reading of a live
// directory rather than a constant this file could have written down.
const existing = readdirSync('services/gateway/migrations').filter(f => f.endsWith('.sql'));
assert.equal(validateMigrationNames(existing,'init').ok,true);
const mine = `070_${slug}.sql`;
assert.equal(validateMigrationNames(['069_previous.sql',mine],slug).ok,true);
assert.equal(validateMigrationNames(['069_previous.sql',mine,'071_future.sql'],slug).ok,true);
assert.equal(validateMigrationNames(['069_previous.sql',mine,'070_collision.sql'],slug).ok,false);
assert.equal(validateMigrationNames(['069_previous.sql'],slug).ok,false);
assert.equal(validateMigrationNames([mine,`071_${slug}.sql`],slug).ok,false);
console.log('tenant-migration-shape: ok');
