-- 002_store_carry_repair.sql — what the store carry left that the target says cannot be there.
--
-- The carry (Phase 6) kept every store file as a `doc` row, which is why its own rehearsal
-- criterion was "doc's rows carried at the same count". Two kinds of row it carried cannot stand
-- in the target's shape, and both are REPAIRS of the carry's own output rather than a change to
-- what the spec asks for:
--
--   1. A `_versions/<stem>.v<N>.md` row is the frozen copy of revision N of `<stem>.md`, and the
--      carry ALSO wrote that revision as a `doc_revision` row. The bytes are therefore held twice
--      — verified equal on every one of the 336 rows before this file was written — and the
--      duplicate has no revision of its own, so it carries `status = 'approved'` with
--      `approved_revision` null: it is one of the rows `doc_current_revision_required` refuses.
--      It is deleted here, and its delete is GUARDED on the duplication still holding: a row
--      whose bytes are NOT in its parent's revision is left exactly where it is.
--
--   2. `doc.content_hash` is a declared projection of `doc_revision[current_revision]`, and every
--      live write keeps it equal to that row's hash. The carry wrote the OLD store's value
--      instead — the hash of the JSON projection `indexDoc` built, a claim about re-deriving a row
--      that no longer exists (scripts/store-migration/model.ts said so at the time). 1,225 rows
--      disagreed with their own current revision. Backfilled here, so the projection is true and
--      the column means one thing.
--
-- With both done, every row satisfies `doc_current_revision_required` and the constraint is
-- VALIDATED — the target declares it as a check, not as `not valid`, and a deployment whose rows
-- satisfy it can enforce it from here on.
--
-- DELIBERATE: the delete's precondition is repeated as a query in the rehearsal's always-run
-- invariants (`scripts/rehearse/invariants.ts`) rather than as a join beside this file. A join
-- would have to name `_versions/` in a `.ts` file, and `checks/store-retired.ts` refuses exactly
-- that — rightly, since the rule it enforces is "no code reaches the store", and a document row
-- that survived this file is already reported by the invariant on
-- `doc_current_revision_required`: a leftover frozen copy is approved with no approved revision.
--
-- DELIBERATE: no transaction control in this file. The runner applies it and its ledger row in
-- one transaction (services/gateway/src/db.ts), and the rehearsal's join expectations rely on the
-- ledger's `applied_at` being the migration's own `now()`.

-- 1. The frozen copies the carry carried twice.
delete from zz.doc v
 where v.path like '\_versions/%'
   and exists (
     select 1
       from zz.doc parent
       join zz.doc_revision r on r.doc_id = parent.id
      where parent.initiative_id = v.initiative_id
        and parent.path = regexp_replace(v.path, '^_versions/(.+)\.v\d+\.md$', '\1') || '.md'
        and r.revision = (regexp_replace(v.path, '^_versions/.+\.v(\d+)\.md$', '\1'))::int
        and r.content_state = 'retained'
        and r.body = v.body);

-- 2. The projection the carry left describing a world that is gone.
update zz.doc d
   set content_hash = r.content_hash
  from zz.doc_revision r
 where r.doc_id = d.id
   and r.revision = d.current_revision
   and d.content_hash is distinct from r.content_hash;

-- 3. Every row satisfies it now, so it is enforced rather than merely declared.
alter table zz.doc validate constraint doc_current_revision_required;
