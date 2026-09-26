-- 002_a_finding_can_be_corrected.sql — a recorded finding can be superseded by a corrected one.
--
-- A finding is recorded once and never edited, so a wrong figure in one (a live evaluation wrote
-- 7.5 where the score said 7.7) had no way out but a second finding beside the first, both
-- current. finding_record(supersedes) now records the correction and closes the original in the
-- same transaction: the original is marked rejected, with the note naming what replaced it, and
-- points here at its replacement. Rejected rather than a fourth decision, so every reader that
-- already treats a decided finding as closed treats a superseded one the same way.
ALTER TABLE zz.eval_finding ADD COLUMN superseded_by uuid REFERENCES zz.eval_finding(id);

COMMENT ON COLUMN zz.eval_finding.superseded_by IS 'The finding that corrected this one, when finding_record(supersedes) replaced it. Null for a current finding. A superseded finding is also decision=rejected, so it stays closed for every reader.';
