-- An evaluation says whether it IS the control, so continuing the wrong one cannot look like
-- success.
--
-- eval_skill_judge resumes by `eval_id`, and it decided what was left to judge by which
-- subjects that session had already scored. A control run of a body-subject skill has exactly
-- one subject — the same one the plain run judged — so passing the PLAIN session's id with
-- `control: true` found nothing left to do and answered `remaining: 0, stored: 0`, with the
-- closing line "The control is complete." Nothing was judged, nothing was stored, and the
-- report said the measurement had its control.
--
-- That is the one failure this apparatus cannot tolerate. The control is what establishes the
-- judge was reading at all; a round that silently loses it keeps every number and drops the
-- only evidence that the numbers mean anything. Found on the second skill evaluation, by the
-- flow itself, in a run whose real-vs-control gap turned out to be under the noise floor — well inside the
-- collapse line, so the honest verdict was "unverified" either way.
--
-- The column belongs on zz.eval rather than being inferred from its scores, because a session
-- that has scored nothing yet has no scores to infer from — which is precisely the state the
-- mismatch is caught in.
alter table zz.eval add column if not exists is_control boolean not null default false;

-- Existing rows, from their own scores. A session whose scores are controls is a control run;
-- everything else stays false, which is what it was.
update zz.eval ev set is_control = true
 where exists (select 1 from zz.eval_score sc where sc.eval_id = ev.id and sc.is_control);
