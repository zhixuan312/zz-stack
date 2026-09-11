-- WHEN EACH SKILL VERSION BEGAN, so a document can be attributed to the one that wrote it.
--
-- `zz.doc.produced_by_run_id` is the mechanical record and it is the best answer where it
-- exists — but it only began being written on 2026-08-31, and forty of sm-intent's
-- eighty-one documents predate it. Their version was never recorded anywhere, and a mean
-- over "the documents we happen to have a run link for" is a mean over an accident.
--
-- The version history is knowable. A skill declares its version in its own frontmatter, and
-- the catalog's history says exactly when each value first appeared. A document written
-- between two of those moments was written by the version in force at the time — which is
-- not a guess but the only version that existed.
--
-- IT IS VALIDATED, NOT ASSUMED. sm-select is the only document-producing skill that has ever
-- changed version (1.0 → 1.1). Every one of the twenty-nine selection.md documents whose
-- version IS recorded falls after that boundary and is recorded as 1.1; every unrecorded one
-- falls before it, the two groups separated by two and a half days. The window predicts the
-- record on every row where both exist, which is what makes it safe where only one does.
--
-- `released_at` already existed and said 2026-08-31 for every row — the moment the rows were
-- created, not the moment the versions began. That is worse than absent: a column that reads
-- as a release date and records an import date.
--
-- WHY NOT A COLUMN ON zz.doc. The same reason there is no `skill_version` there: the run is
-- the record and this is the fallback for documents older than it, so both are derived at
-- read time from facts already stored. A stamp written onto every document would be a third
-- copy, and the one nobody re-derives when the first two are corrected.

-- Versions that documents fall into but nothing ever served, so no row was created for them.
-- By NAME, so this runs the same against production's own uuids.
insert into zz.skill_version (skill_id, version)
select k.id, v.version
  from (values ('sm-select','1.0'), ('sm-build','1.0')) as v(skill, version)
  join zz.skill k on k.name = v.skill
 where not exists (
   select 1 from zz.skill_version sv where sv.skill_id = k.id and sv.version = v.version)
;

-- When each version first appeared in the catalog, from that file's own history.
-- Pre-1.0 (`version: 1`) is deliberately absent: no document on either deployment was
-- written before 2026-08-27, so no row could ever resolve to it, and creating one would be
-- inventing a period nothing can fall in.
update zz.skill_version sv
   set released_at = t.at
  from (values
    ('sm-intent', '1.0', timestamptz '2026-08-23 00:07:10+08'),
    ('sm-spec',   '1.0', timestamptz '2026-08-23 00:07:10+08'),
    ('sm-select', '1.0', timestamptz '2026-08-23 00:07:10+08'),
    ('sm-select', '1.1', timestamptz '2026-08-30 16:57:28+08'),
    ('sm-plan',   '1.0', timestamptz '2026-08-23 00:07:10+08'),
    ('sm-verify', '1.0', timestamptz '2026-08-23 00:07:10+08'),
    ('sm-build',  '1.0', timestamptz '2026-08-23 00:07:10+08'),
    ('sm-build',  '1.1', timestamptz '2026-08-30 16:57:28+08'),
    ('sm-build',  '1.2', timestamptz '2026-08-30 18:08:11+08')
  ) as t(skill, version, at)
  join zz.skill k on k.name = t.skill
 where sv.skill_id = k.id and sv.version = t.version
;
