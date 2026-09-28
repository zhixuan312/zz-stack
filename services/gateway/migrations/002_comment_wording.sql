-- 002_comment_wording.sql — three comments that said something the schema does not.
--
-- `zz.team.slug` was described as a team's "artifact-store directory name" and
-- `zz.eval_run.team_id` as the team "whose artifact store its document subjects were resolved
-- against". The volume those named is retired: a team's slug addresses it in a URL and in every
-- document path, and a document subject is resolved against the team's own ROWS.
--
-- `zz.assessment.about` was "an external address such as the store path of the source". What the
-- column actually holds is what the caller said it was assessing — the live rows carry
-- `spec.md#CS-1` — so the comment states the grain the writer documents and the data shows.
--
-- A comment is the schema's documentation and it is read where it is written — the tools that
-- describe a table read these — so all three are corrected rather than left to mislead. Nothing but
-- the text changes: no column moves, no constraint is added, and the statements are idempotent.
--
-- DELIBERATE: no transaction control. The runner applies this file and its ledger row in one
-- transaction (services/gateway/src/db.ts).

COMMENT ON COLUMN zz.team.slug IS 'class=current_state; authority=this; question=what is this team''s external address, the slug that names it in a URL and in every document path?';

COMMENT ON COLUMN zz.assessment.about IS 'class=immutable_history; authority=this; question=what was assessed, as the caller stated it — a document path such as spec.md#CS-1, a source ref or a finding id?';

COMMENT ON COLUMN zz.eval_run.team_id IS 'class=relation; authority=this; question=which team ran this evaluation, whose documents its document subjects were resolved against and which the named initiative must belong to?';
