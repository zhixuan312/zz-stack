-- A ruler names its levels, a mark carries its confidence, and a round carries its recommendation.
--
-- WHY. Three shapes this evaluation track has always had in prose and never in a column:
--
--   A DIMENSION IS AN ORDERED SCALE, and it was stored as two ends — `one_means` and
--   `five_means` — with the three rungs between them left to whoever was marking. A level
--   nobody described is a level nobody can mark against consistently, and the marks it produced
--   were not comparable between rounds for exactly that reason. `levels` holds 2-10 ordered
--   descriptions, low to high, which is also what a typed judgement service can be asked
--   against directly instead of being handed two ends and a prompt.
--
--   A MARK HAS A CERTAINTY, and it was stored as a bare number. A 3 the marker was sure of and
--   a 3 it was torn between 2 and 4 over are different findings, and the second one is the
--   interesting one. `confidence` is the distribution's shape collapsed to 0-1; `probabilities`
--   keeps the distribution itself, so a later reader can apply their own threshold rather than
--   ours.
--
--   A ROUND ENDS IN A RECOMMENDATION, and it was a sentence somebody wrote in a document. One
--   word from a closed set — keep, keep-and-change, re-run, not-evaluable, retire — is a fact
--   the platform can count; a paragraph is not. `not-evaluable` is in that set deliberately: it
--   is a verdict about the MEASUREMENT rather than the plugin, and the first report written on
--   this platform got that wrong, reporting "we could not measure this" as a low score.
--
-- NOTHING IS DROPPED. `one_means` and `five_means` stay, carrying the rulers written before
-- this, so a historical round still reads the way it was marked. A dimension has levels or it
-- has ends, and the reader can tell which by looking.

alter table zz.rubric_dimension add column if not exists levels text[];

alter table zz.eval_score add column if not exists confidence numeric;
alter table zz.eval_score add column if not exists probabilities jsonb;

-- The judge that produced the marks is already recorded per round (zz.eval.judge_model), which
-- is what lets a judge change be read like a rubric version change rather than silently
-- rewriting the meaning of every earlier score.
alter table zz.eval add column if not exists recommendation text;
alter table zz.eval add column if not exists recommendation_confidence numeric;
alter table zz.eval add column if not exists recommendation_probabilities jsonb;

-- A closed set, enforced. The whole value of an enum here is that the ledger is read by
-- counting it, and a sixth word is a row nobody can total — the same argument zz.doc's
-- `outcome` vocabulary is closed for.
alter table zz.eval drop constraint if exists eval_recommendation_check;
alter table zz.eval add constraint eval_recommendation_check
  check (recommendation is null or recommendation in
         ('keep', 'keep-and-change', 're-run', 'not-evaluable', 'retire'));

-- Read whenever a round is summarised, always beside the round it belongs to.
create index if not exists eval_recommendation_idx on zz.eval (recommendation)
  where recommendation is not null;

-- AND A RULER MAY TAKE A WHOLE INITIATIVE AS ITS SUBJECT.
--
-- "Does the end deliver what the beginning asked for" is a property of the SEQUENCE. A judge
-- handed one document at a time can say a review is well written without knowing whether it
-- answers the exploration that opened the work — so the most important question a FLOW can be
-- asked was the one its rulers could not express. An initiative subject hands the judge both
-- ends of one initiative at once, labelled, and is refused when the version has left no
-- initiative carrying two.
alter table zz.rubric drop constraint if exists rubric_subject_check;
alter table zz.rubric add constraint rubric_subject_check
  check (subject in ('auto', 'document', 'trace', 'initiative'));
