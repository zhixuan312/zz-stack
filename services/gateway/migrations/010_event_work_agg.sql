-- 010_event_work_agg.sql — the covering index over the real-work tool calls, which `007_event_work_scan.sql`
-- measured beside the narrow one and left out.
--
-- Usage, Record, Home and Status reduce the whole real-work history rather than a window of it: calls by week
-- and team, by tool and week with the median duration, by refusal owner, by local weekday and hour. Seven of
-- those statements on one Usage load, each reading all 40,287 real-work rows of this deployment's 69,555.
--
-- 007 chose `event_work_session (session, ts)` and recorded the covering variant as "write cost for a plan
-- that never ran". That verdict belonged to the statements 007 knew — the refusal follow-up, which seeks one
-- session and is answered by a seek. The whole-history reductions seek nothing: they order by no key and
-- read every matching row, so the narrow index answers them with a bitmap over 40k index entries and then a
-- heap visit per row. Given the covering index the planner reads the index alone and never the heap, measured
-- on this deployment (2 cores, 2026-10-24):
--
--   calls by week and team         187 ms -> 158 ms
--   calls by tool and week, median 283 ms -> 222 ms
--
-- 007's own note ends "a statement that later wants its columns back can add it"; these are those statements.
-- The 242 heap fetches one plan reported are rows a vacuum had not yet marked all-visible, so the gain is
-- larger once the table is vacuumed than these figures say.
--
-- DELIBERATE: partial on the predicate every one of those statements already writes, and INCLUDE exactly the
-- columns they read. It is a second index over the same rows as `event_work_session`, which is where 007's
-- write-cost objection would land — and this table takes a few hundred rows a day, so the cost is nil beside
-- a page load the index makes shorter.
--
-- `schema-target/telemetry.ts` declares the index, and `scripts/rehearse/expect.ts` needs no entry: no row
-- moves and no column changes, so the default assertion — row count unchanged, content hash unchanged — is
-- the one this file must pass.
--
-- The release before this file can run on what it builds: an index nothing names is invisible to it, and a
-- rollback leaves it in place, costing the old release nothing. No line below declares one. `IF NOT EXISTS`
-- because the deployment these figures were measured on already holds it under this name.

CREATE INDEX IF NOT EXISTS event_work_agg ON zz.event USING btree (ts)
  INCLUDE (team_id, session, tool_key, refusal_owner, duration_ms, batched, ok, initiative_id)
  WHERE kind = 'tool_call' AND origin = 'work';
