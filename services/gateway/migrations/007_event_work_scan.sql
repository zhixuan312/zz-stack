-- 007_event_work_scan.sql — one index over the real-work tool calls, so the console's history reads stop
-- scanning every event the platform ever recorded.
--
-- Usage, Record and Home each reduce the whole event history: calls by week, by tool, by team, by refusal
-- owner, by local weekday and hour, and the refusals put right by a later call of the same session. Every
-- one of those statements filters `kind = 'tool_call' and origin = 'work'` — 40,089 of this deployment's
-- 69,046 rows — and the planner had no index narrow enough to be worth choosing, so each read the heap in
-- full. Nine of them on one page load measured 3.1-3.7 s; with this index the same nine measure 0.9-1.0 s.
--
-- DELIBERATE: partial, and narrow. The predicate is the one every reader already writes, and the columns are
-- the two the refusal-follow-up seeks on (`session`, and `ts` for its 120-second window and its week). It is
-- a fraction of the size of a full index on the table, which is what makes it cheaper to read than the heap
-- it replaces: the planner bitmap-scans this index whole rather than the table.
--
-- The covering variant — `(ts) INCLUDE (refusal_owner, duration_ms, batched, team_id, session, tool_key,
-- initiative_id)` — was measured beside it and is not here: the planner chose this one either way, so the
-- second was write cost for a plan that never ran. A statement that later wants its columns back can add it.
--
-- `schema-target/telemetry.ts` declares the index, and `scripts/rehearse/expect.ts` needs no entry: no row
-- moves and no column changes, so the default assertion — row count unchanged, content hash unchanged — is
-- the one this file must pass.
--
-- The release before this file can run on what it builds: an index nothing names is invisible to it, and a
-- rollback leaves it in place, costing the old release nothing. No line below declares one.

CREATE INDEX IF NOT EXISTS event_work_session ON zz.event USING btree (session, ts)
  WHERE kind = 'tool_call' AND origin = 'work';
