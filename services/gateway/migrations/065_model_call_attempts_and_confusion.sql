-- WHAT A MODEL CALL COST, HOW MANY TRIES IT TOOK, AND HOW SURE THE ANSWER WAS.
--
-- zz.model_call recorded the reading judge's calls and nothing else: the typed judgement
-- service, which now makes EVERY typed decision on this platform -- the qualitative marks, the
-- thresholds, the recommendation enum -- wrote no row at all. Twelve rounds of evidence with no
-- record that the calls behind them happened, how long they took, or whether any had to be
-- retried.
--
-- THREE COLUMNS, EACH ANSWERING A QUESTION THE TABLE COULD NOT.
--
--   `attempts` -- a call that succeeded on its third try is not the same fact as one that
--   succeeded immediately, and until now both stored one row that looked identical. A rising
--   attempt count is the earliest signal an endpoint is degrading, and it is invisible in a
--   duration alone because the retries are inside it.
--
--   `confidence` -- CONFUSION IS A MEASUREMENT, not an error. The typed service returns how
--   sure it is, and an answer at 0.11 and one at 0.96 are different evidence wearing the same
--   shape. Recorded per call as the mean across that call's answers, so a run of low-confidence
--   judgements is visible as a trend rather than discovered one report at a time. Null for the
--   reading judge, which reports no such figure -- not zero, which would read as certainty
--   about nothing.
--
--   `note` -- WHY a call failed, in the words the endpoint used. `ok = false` says something
--   went wrong and every kind of wrong looked the same: a timeout, a 429, a body whose shape
--   moved. Those need different responses and the table could not tell them apart.
--
-- Nothing is dropped and every existing row stays readable: attempts defaults to 1, which is
-- what every recorded call did, and the other two are null, which is "not reported".

alter table zz.model_call add column if not exists attempts integer not null default 1;
alter table zz.model_call add column if not exists confidence numeric;
alter table zz.model_call add column if not exists note text;

-- Read when somebody asks whether the endpoint is behaving, which is a question about the
-- recent past rather than about one plugin.
create index if not exists model_call_failed_ts on zz.model_call (ts desc) where not ok;
