-- Deleting an initiative failed, and the two guards that made it fail are both correct.
--
-- zz.run's foreign key was ON DELETE SET NULL, so removing an initiative turned its runs into
-- initiative-less runs. 031's partial unique index — (skill_version_id, caller_session) where
-- initiative_id is null, which is what makes reconcile idempotent for a block-usage run that
-- happens before any document exists — then refused two runs from the same session:
--
--   ERROR: duplicate key value violates unique constraint "run_no_initiative"
--   CONTEXT: UPDATE ONLY "zz"."run" SET "initiative_id" = NULL
--
-- So an initiative with two runs in one caller session could not be deleted at all, and the
-- error named an index nobody was writing to. Found deleting a test initiative; it would have
-- met the first person who tried to remove real work.
--
-- CASCADE, not SET NULL. A run is a record of work ON an initiative — orphaning it invents a
-- row that claims to be a block-usage run that happened before any document, which is a
-- different thing entirely and exactly what 031 admitted rows for. Nothing is lost: zz.event
-- holds every call, and reconcileRuns() derives runs from it, so the honest rows come back on
-- the next pass and the invented ones do not.
alter table zz.run drop constraint if exists run_initiative_id_fkey;
alter table zz.run add constraint run_initiative_id_fkey
  foreign key (initiative_id) references zz.initiative (id) on delete cascade;
