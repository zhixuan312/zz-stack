-- 002_event_indexes.sql — two reads of the event log that had no index to use.
--
-- ADDITIVE: neither statement changes a row, so every table is expected unchanged and this file
-- declares no entry in scripts/rehearse/expect.ts. It folds into 001_init.sql at the release that
-- verifies it, and the `absorbed` row in that file's header grows by one.
--
-- The first is on the write path and is the reason this file exists. `events.ts`' STAMP_RUN
-- recomputes a run's counters from the events that carry its identity — team, initiative, skill
-- version and session — and deliberately recomputes rather than increments, so that writing the
-- same event twice leaves the same run. Without an index that aggregate reads the whole log on
-- EVERY tool call: measured 27.8 ms against this deployment's 33 254 events, of which 12 573
-- carry all four keys, and it grows with the log rather than with the run.
--
-- The second serves the console's Activity page, which asks for the newest 200 events and had no
-- way to find them but to sort all of them: 123.6 ms, and the same growth. `event_kind_ts` cannot
-- help — it is ordered by kind first, and this read has no kind predicate.

CREATE INDEX event_run_identity ON zz.event USING btree (team_id, initiative_id, skill_version_id, session);

CREATE INDEX event_ts ON zz.event USING btree (ts DESC);
