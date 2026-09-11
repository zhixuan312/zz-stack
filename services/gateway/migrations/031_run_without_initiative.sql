-- A run can exist before an initiative does, and until now it could not be recorded.
--
-- zz.run's unique key is (initiative_id, skill_version_id, caller_session), and 017's backfill
-- required an initiative — "events with no run identifier are left unattached rather than
-- invented". That was right about invention and wrong about which events it excluded. A block
-- usage skill's work happens BEFORE any document is written: an agent loads
-- `using-casebox`, makes twenty-two calls against casebox, and only later opens an
-- initiative if the work turns into one. Every one of those calls carries the step and the
-- caller session; none carries an initiative. So the skill had 22 stamped calls, 11 loads,
-- 3 sessions — and no run at all, which reads in every query as a skill nobody ever used.
--
-- Postgres treats NULLs as distinct in a unique constraint, so the existing key does not
-- dedupe initiative-less rows: a reconcile pass would insert the same run again every time it
-- ran. This partial index is what makes those rows upsertable.
--
-- skill_version_id is required here and deliberately. A run attached to neither an initiative
-- nor a skill version is a caller session and nothing more — there is no question the
-- evaluation track could ask of it — and admitting those would fill the table with rows that
-- answer nothing.
create unique index if not exists run_no_initiative
  on zz.run (skill_version_id, caller_session)
  where initiative_id is null;
