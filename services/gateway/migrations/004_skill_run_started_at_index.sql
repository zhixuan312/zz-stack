-- 004_skill_run_started_at_index.sql — the column every run report windows by, unindexed.
--
-- ADDITIVE: nothing here changes a row, so every table is expected unchanged and this file declares
-- no entry in scripts/rehearse/expect.ts. It folds into 001_init.sql at the release that verifies
-- it, and the `absorbed` row in that file's header grows by one.
--
-- `zz.skill_run` carries one index, `run_skill_version`, and its first column is `skill_version_id`:
-- a question about ONE skill's runs is served, and a question about a WINDOW of them is not. The
-- console's Overview asks the second — `order by r.started_at desc limit 400`, over the whole table
-- or filtered by team — so the planner reads every run it must sort. Measured on the deployment's own
-- catalog: 4.3 ms at 1,278 runs, and it is linear, so the overview pays it on every page view and the
-- payment grows with every run the platform records.
--
-- Two indexes were enough for `zz.event` in 002 and one for `zz.doc` in 003; this is the same shape of
-- gap again — a column every reader windows by, with nothing to search it by.

CREATE INDEX skill_run_started_at ON zz.skill_run USING btree (started_at);
