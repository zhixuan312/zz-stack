-- Two columns a false headline paid for, and one the findings ledger needed from the start.
--
-- ADDITIVE ONLY. 064 deleted from a table another one points at and took all three doors down
-- for twenty minutes; nothing here drops, deletes or rewrites a row.
--
-- 1. rubric_dimension.reads -- WHICH FIGURE A QUANTITATIVE LINE IS DRAWN OVER.
--
-- A threshold was prose, and nothing checked that the figure it needs exists. zz-plugin-eval
-- 0.56.0 was scored against "every non-control round recorded against this plugin version has
-- a control round naming it" -- a figure plugin_profile does not compute and never has. The
-- threshold pass is instructed to answer NOT MET when the facts lack the figure a line needs,
-- so the line came back failed at 11%, became a closed report's headline finding, and was
-- false: every round at that version did carry a control.
--
-- It cost twice over, in opposite directions. The score was DEFLATED, because an unmeasurable
-- line counts against the quantitative half -- 7.06 instead of 9.06, a whole band. The headroom
-- was INFLATED, because the same line counts as a named change. And the stored row cannot tell
-- the two apart afterwards: `eval_score` holds 1 for a line that failed and 1 for a line that
-- was never asked.
--
-- Naming the figure makes the line checkable BEFORE any artifact is marked, which is the same
-- argument that already puts `threshold` and `threshold_reason` before the judge sees anything.
-- Empty default so every existing dimension stays valid and nothing is scored differently
-- today; ruler_record requires it for new quantitative dimensions, and round_judge refuses a
-- round whose declared figures are no longer on the sheet.
--
-- 2. eval_finding decision provenance -- WHO CLOSED IT AND WHY.
--
-- `decision` has held three values since it was written and only ever contained one: eleven
-- findings on this deployment, eleven `deferred`, none applied, none rejected. finding_record's
-- own description says "applying or rejecting it is a separate act by whoever owns the plugin"
-- and no tool performed that act, so the column was a promise with nothing behind it. A finding
-- nobody can close is a finding that sits in the ledger forever and, now that headroom counts
-- every open one, quietly inflates the next round's report.
--
-- Closing one is a decision a person makes, so it is recorded the way every other decision on
-- this platform is: with a name, a moment and a line saying why.

alter table zz.rubric_dimension
  add column if not exists reads text[] not null default '{}';

comment on column zz.rubric_dimension.reads is
  'Dotted paths into the facts sheet plugin_profile produces, e.g. record.revised_with_evidence_pct. '
  'Empty for a qualitative dimension, which reads the artifact instead. A quantitative dimension '
  'whose paths are not on the sheet cannot be measured, and is refused at ruler_record.';

alter table zz.eval_finding
  add column if not exists decided_by text,
  add column if not exists decided_at timestamptz,
  add column if not exists decision_note text not null default '';

comment on column zz.eval_finding.decision_note is
  'Why it was applied or rejected. Empty while deferred -- the open state needs no reason, and '
  'the two closed ones do.';
