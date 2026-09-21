-- A SourceArtifact has no content revision, and zz.artifact had nowhere to put that.
--
-- 070 declared `current_revision integer not null check (current_revision > 0)`. An immutable
-- source has no revision at all, and the rest of this platform already had a representation for
-- that and used it everywhere: `ArtifactRefSchema` accepts `revision: null` and resolves it only
-- to a source, and `services/zz-core/src/tenant-info/transitions.ts` refuses every lifecycle
-- operation on `head.revision === null` for exactly that reason. The projection had nothing legal
-- to write, and the insert was refused:
--
--     new row for relation "artifact" violates check constraint
--     "artifact_current_revision_check"
--
-- Found by restoring a production backup into the built PostgreSQL 17 image and replaying a real
-- owner store through it. No offline check could see it: every suite that exercises sources runs
-- against the file-backed record, and every suite that exercises this table built its fixtures
-- from work documents, which always have a revision.
--
-- WHY THIS IS A NEW MIGRATION RATHER THAN AN EDIT TO 070. 070 is already applied on this
-- deployment — it ran on the first boot after the PostgreSQL 17 cutover, with the constraint as
-- written above. Editing an applied migration changes what a FRESH install creates while leaving
-- every existing deployment on the old shape, and nothing reports the divergence: two databases
-- that both say "070 applied" and disagree about what that means. The applied file stays as it
-- was applied; this one carries the correction forward, and a fresh install reaches the same end
-- state by running both.
--
-- NO EXTENSION REQUIRED. This touches one constraint on one table and needs nothing the cluster
-- does not already have, so it carries no `requires-extension` directive and is not deferred.

alter table zz.artifact
  alter column current_revision drop not null;

alter table zz.artifact
  drop constraint if exists artifact_current_revision_check;

-- Still refuses zero and negatives, which are not revision numbers in this model: revisions
-- start at 1. Null is the one additional value, and it means "this artifact is a source".
alter table zz.artifact
  add constraint artifact_current_revision_check
  check (current_revision is null or current_revision > 0);
