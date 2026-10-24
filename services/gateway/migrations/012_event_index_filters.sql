-- 012_event_index_filters.sql — the four filters the console and zz-core ask for on every load, and the two
-- `zz.model_call` indexes nothing reaches.
--
-- Four statements recur on the reads a page waits for, and none of them had an index of its own: a revision
-- waiting for approval (`console/pending.ts`: `r.presented_at is not null and r.presented_at <= $1 and
-- r.approved_at is null`), one initiative's sources (`tools/source-list.ts`: `d.path like 'sources/%' and
-- d.path like '%.md'`), the scored runs a plugin's history is drawn from (`console/platform-evaluation.ts`:
-- `r.scored_at is not null and r.scored_at <= $1`), and the platform's own model calls in a window
-- (`console/usage-figures.ts`: `m.ts < $2 and m.ts >= $3`).
--
-- Measured by `EXPLAIN (ANALYZE, BUFFERS)` on a throwaway migrated from this tree and seeded to a population
-- where each choice is a real one — 20,000 revisions of which 40 wait, 20,000 documents across 100
-- initiatives, 4,000 runs of which 40 are scored, 20,000 model calls across a season — the same statements
-- before this file and after it:
--
--   pending.ts          Seq Scan on doc_revision            1,109 buffers   1.20 ms
--                       -> Index Scan using doc_revision_pending   242 buffers   0.19 ms
--   source-list.ts      Bitmap Index Scan on doc_initiative_id      242 buffers   0.26 ms
--                       -> Bitmap Index Scan on doc_initiative_path  55 buffers   0.11 ms
--   the score history   Seq Scan on eval_run                         206 buffers   0.28 ms
--                       -> Index Scan using eval_run_scored_at      162 buffers   0.12 ms
--   modelDays           Seq Scan on model_call                       250 buffers   0.77 ms
--                       -> Index Scan using model_call_ts             11 buffers   0.32 ms
--
-- The seed is the measurement's, not this deployment's, which holds 5,391 model calls, 4,327 documents,
-- 5,951 revisions and 15 evaluation runs (read 2026-10-25) — sizes at which PostgreSQL reads three of these
-- tables whole and no index can be watched being chosen. `eval_run` is the case that makes the point either
-- way — 15 rows today, one per scoring, and a read that asks for the scored ones on every Evaluation load, so
-- the declaration is what keeps its plan from degrading silently rather than something a plan can demonstrate.
--
-- DELIBERATE: `(initiative_id, path text_pattern_ops)`, and not `(path)`. This cluster's database collates
-- `en_US.utf8`, so a `LIKE` prefix cannot use a btree under the default operator class at all; against a bare
-- `(path)` the planner kept its sequential scan. `initiative_id` leads because the statement is always one
-- initiative's, and on the same seed a `(path text_pattern_ops)` partial on the same pattern was passed over
-- for the composite, which reads 12 index entries where it read 1,177.
--
-- DELIBERATE: `presented_at` and `scored_at` are partial on the predicate their own statements already write,
-- so the planner can prove the index applies. A plain `(presented_at)` was measured too and not chosen — the
-- column is set on a third of the revisions while the queue `pending.ts` reads is a handful, and only the
-- partial index says that.
--
-- DELIBERATE: `model_call_ts` is `(ts)` and nothing else. The covering form — `(ts) INCLUDE (purpose, model,
-- ok, input_tokens, output_tokens)` — was measured on the same window at 200,000 rows and wins by 30 buffers
-- against 55 and 0.34 ms, which is the trade `010_event_work_agg.sql` took for a table 40,287 real-work rows
-- deep and taking a few hundred a day. This one holds 5,391 rows in all: a second copy of five columns on
-- every insert buys a difference that only exists at a scale this table has not reached, and the declaration
-- is what lets a later release take it deliberately. `usage-figures.ts` reads the window as it is written; an
-- index carrying those columns would make that read index-only, and that is a change with a measurement
-- behind it, not a guess bundled into this one.
--
-- The two indexes `zz.model_call` carried are dropped, each for a reason written here because a reader who
-- finds an index missing and no line beside it has no way to tell a decision from a loss:
--
--   `model_call_failed_ts (ts DESC) WHERE (NOT ok)` — nothing reaches it. The only `ok` predicate in either
--   repository is `count(*) filter (where not m.ok)` inside `modelDays`, which reads the table unfiltered; a
--   partial index is not consulted for a FILTER clause, so the predicate this one is built on can never
--   appear in a WHERE.
--
--   `model_call_purpose_ts (purpose, ts)` — an earlier reading had `modelDays` reaching this one because it
--   groups by `m.purpose` under a `ts` range. It does not: it has no `purpose` predicate, and a
--   `(purpose, ts)` btree can only reach a `ts` range by reading every entry in the index. On 200,000 rows
--   and a two-day window the planner takes `model_call_ts` at 55 buffers; forced to this index
--   (`enable_seqscan = off`) it costs 1,637 buffers at a plan cost of 8,609 against the sequential scan's
--   5,564. `modelDays` is the only reader of `zz.model_call` in either repository.
--
-- DELIBERATE: the two `DROP INDEX` lines are not `CONCURRENTLY`, because the runner applies each migration in
-- one transaction and `CONCURRENTLY` cannot run inside one. They take ACCESS EXCLUSIVE on `zz.model_call` for
-- the length of a drop on 5,391 rows, which is a moment, and a table that grows by a handful of rows a day is
-- not the one to design a concurrent path around.
--
-- `schema-target/documents.ts`, `schema-target/eval-run.ts` and `schema-target/typed-service.ts` declare these
-- and `scripts/rehearse/expect.ts` needs no entry: no row moves and no column changes, so the default
-- assertion — row count unchanged, content hash unchanged — is the one this file must pass.
--
-- The release before this file can run on what it builds: an index nothing names is invisible to it, and a
-- rollback leaves these four in place, costing the old release nothing. The two DROP lines cost it nothing
-- either, because no statement in either image names either index. `IF NOT EXISTS` and `IF EXISTS` because a
-- deployment measured before this shipped may already hold — or already have lost — one of them by hand.

CREATE INDEX IF NOT EXISTS doc_revision_pending ON zz.doc_revision USING btree (presented_at)
  WHERE presented_at IS NOT NULL AND approved_at IS NULL;

CREATE INDEX IF NOT EXISTS doc_initiative_path ON zz.doc USING btree (initiative_id, path text_pattern_ops);

CREATE INDEX IF NOT EXISTS eval_run_scored_at ON zz.eval_run USING btree (scored_at)
  WHERE scored_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS model_call_ts ON zz.model_call USING btree (ts);

DROP INDEX IF EXISTS zz.model_call_purpose_ts;
DROP INDEX IF EXISTS zz.model_call_failed_ts;
