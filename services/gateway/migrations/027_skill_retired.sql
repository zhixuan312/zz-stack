-- A skill that no longer ships, but still owns what it wrote.
--
-- register-skills only ever inserted and updated, so a skill renamed or absorbed into another
-- stayed in zz.skill looking exactly like one still being served. casebox-stg-usage sat there for a
-- week after its content moved into using-casebox's references.
--
-- DELETING IT IS WRONG, and the database said so before anyone did: zz.run references its
-- skill_version, and `doc.produced_by_run_id -> run.skill_version_id` is the chain that answers
-- WHICH VERSION WROTE THIS DOCUMENT. Remove the row and every document that skill produced falls
-- back to the released_at "era" window and is silently re-attributed to whichever skill happens
-- to be current. Wrong provenance, permanently, with nothing to notice it by.
--
-- So retirement is a FACT TO RECORD, not a row to remove. One boolean, written by the one tool
-- that can know it — register-skills compares the registry against the catalog on every run —
-- and read by everything else. Without it each reader has to diff the catalog itself, and
-- loop-eval's first run proved what that costs: it reported five casebox skills NOT CONSULTED when
-- casebox publishes four, because the fifth was a ghost the query had no way to see.
alter table zz.skill add column if not exists retired boolean not null default false;

-- The one we already know about. register-skills sets this for anything else that goes missing,
-- and clears it if a name ever comes back.
update zz.skill set retired = true where name = 'casebox-stg-usage';

comment on column zz.skill.retired is
  'No longer in the catalog. Kept because zz.run and zz.doc attribute documents to its versions.';
