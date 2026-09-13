-- THE SKILL-SIDE SUBJECT GOES, now that its last reader has.
--
-- 047 added the plugin-side columns beside the skill-side ones and said, in its own header,
-- exactly why it stopped there: nothing in this repository can see a dropped column. SQL lives
-- in template literals so tsc cannot read it, and the gate's dropped-schema check reduces
-- schemaColumns() to table names (data-sql.mjs:175). Drop a column that is still queried and
-- the build is green, the gate is green, and the failure surfaces weeks later in one query for
-- one caller. So 047 was additive and this one is the destructive half, held back until the
-- precondition was true.
--
-- The precondition is that the modules owning the old shape are gone. They are:
-- services/zz-core/src/evaluation.ts, its eight eval_* tools, judge-skill.ts, and the
-- packages/tools eval ops -- deleted with catalog/zz/zz-skill-eval and catalog/zz/zz-block-eval,
-- the two component-level evaluation flows a plugin-level one replaced in 14dbe03.
--
-- ── NOTHING IS BEING MIGRATED, BECAUSE THERE IS NOTHING TO MIGRATE ──────────────────────
--
-- Every one of these columns is empty. Measured on the deployment on 2026-09-13, before this
-- was written, not asserted from memory:
--
--   zz.eval              0 rows        zz.rubric             0 rows
--   zz.eval_subject      0 rows        zz.rubric_dimension   0 rows
--   zz.eval_score        0 rows        zz.eval_finding       0 rows
--
-- Both evaluation flows shipped and neither was ever run. That is worth writing down here
-- because a future reader has no other way to know a dropped column carried nothing -- the
-- rows are gone with the column, and "we checked, it was empty" is not recoverable from a
-- schema. If this migration is ever applied somewhere those tables are NOT empty, it destroys
-- the attribution of every skill-side score to the version that earned it. Check first.

-- ── the subject columns ─────────────────────────────────────────────────────────────────
--
-- The unique key goes first and by name, rather than being taken out as collateral when its
-- column drops. Postgres would drop it either way; naming it here is what makes the intent
-- readable to somebody reading the migration instead of the catalog.
alter table zz.rubric drop constraint if exists rubric_skill_id_version_key;

alter table zz.eval          drop column if exists skill_version_id;
alter table zz.eval_subject  drop column if exists skill_version_id;
alter table zz.rubric        drop column if exists skill_id;
alter table zz.skill_version drop column if exists rubric_id;

-- ── and the plugin-side columns stop being optional ─────────────────────────────────────
--
-- 047 added these nullable and relaxed two NOT NULLs on their skill-side counterparts, because
-- both shapes had to be writable while both had readers. Only one shape has a reader now, so a
-- null here is no longer "the other kind of round" -- it is a row nothing can attribute, which
-- is the state the NOT NULL on zz.eval.skill_version_id existed to prevent in the first place.
--
-- zz.eval_subject.plugin_version_id is deliberately NOT tightened, and its skill-side
-- counterpart is dropped rather than replaced by a required column. 019 declared
-- zz.eval_subject.skill_version_id nullable and gave no reason for it -- unlike zz.eval's,
-- which it made NOT NULL in the line above -- so there is no stated intent here to complete.
-- Making the plugin-side one required would be a new rule arriving under cover of a cleanup.
-- If a subject with no version turns out to be worth refusing, that is its own migration with
-- its own argument.
alter table zz.eval   alter column plugin_version_id set not null;
alter table zz.rubric alter column plugin_id         set not null;

-- ── 'body' is not a thing a plugin has ──────────────────────────────────────────────────
--
-- 032 added `subject` with four values and wrote down the case that earned the fourth:
-- using-casebox, a VENDORED FILE judged on whether it earns its place beside the block's own
-- tools. That is a question about a skill's own text, it can only be asked of a skill, and it
-- left with zz-skill-eval.
--
-- A plugin has no body -- it is a package of skills and the servers those skills call -- and
-- tools/plugin-judge.ts already refuses a ruler declaring `body` in as many words. This makes
-- the database agree with the tool instead of leaving a value only a refusal stands between us
-- and. Dropped and recreated rather than altered because a CHECK cannot be narrowed in place.
--
-- AND THAT COSTS THIS COLUMN ITS GATE COVERAGE, which is worth stating rather than discovering.
-- "every state the schema allows can actually be reached" (documents-schema.mjs) skips any
-- column whose DERIVED constraint name -- `<table>_<col>_check` -- appears in a `drop
-- constraint`, and it derives that name rather than reading the one actually in force. So the
-- drop below exempts zz.rubric.subject permanently, whatever the replacement is called;
-- renaming it does not help. All three surviving values are named in the source today
-- (`auto` in tools/plugin-judge.ts, `document` and `trace` in judge.ts), and a fourth added
-- later will NOT be checked. Whoever adds one owes it the reader this check would have been.
alter table zz.rubric drop constraint if exists rubric_subject_check;
alter table zz.rubric add  constraint rubric_subject_check
  check (subject in ('auto', 'document', 'trace'));

comment on column zz.rubric.subject is
  'What this ruler is applied to: the documents the subject produced, its run traces, or auto — '
  'documents where they exist and traces otherwise.';

-- ── AND zz.run.outcome, WHICH NOTHING WRITES AND NOTHING READS ──────────────────────────
--
-- Its only writer was packages/tools/src/ops/eval-decide.ts -- the README said so in those
-- words -- and that went with the skill-level evaluation. No SQL anywhere in services/ or
-- packages/ selects it. Measured on the deployment: zero rows carry a non-empty value.
--
-- THE INTERESTING PART IS WHY ONLY ONE OF ITS STATES LOOKED ORPHANED. The gate's
-- "every state the schema allows can actually be reached" check reported 'open' alone, and
-- that is a coincidence of vocabulary rather than a fact about this column: 'accepted',
-- 'delivered' and 'abandoned' appear as literals in persist.ts, where they are DOCUMENT
-- envelope outcomes -- a different thing that happens to share three words. So three of the
-- four states were exactly as unreachable as the one the check named, and only 'open' was
-- spelled nowhere else. Retiring that one value would have left a column whose remaining
-- states are unreachable and merely look otherwise. The column goes instead.
--
-- A run's outcome, if the platform wants one again, belongs to whatever decides it. Nothing
-- does today, and a column reserved for a decision nobody makes is a column that reads as a
-- fact somebody forgot to record.
alter table zz.run drop column if exists outcome;
