-- A CONTROL NAMES THE ROUND IT CONTROLS.
--
-- The judge-on-trial gap is the one number that says a ruler could tell the right artifact
-- from the wrong one, and it is a property of ONE ROUND: these subjects, marked this way,
-- against this control. It was computed by pooling every score under a plugin version and a
-- rubric, real on one side and control on the other, because nothing linked the two rows.
--
-- That reads correctly while a version has one round and stops the moment it has two. Measured
-- on this deployment: a second round of six subjects was taken, and the gap it reported
-- averaged both rounds together -- so a round could not be read on its own, and a round whose
-- evidence was later shown to be defective went on moving the number of every round beside it
-- until its rows were deleted outright.
--
-- Nullable, and null is the ordinary answer: every real round has it null, and so does every
-- control taken before this column existed. The reader falls back to the pooled form when it
-- is null, which is what those older rounds were always measured by -- so nothing that was
-- already recorded changes its meaning.
alter table zz.eval add column if not exists controls uuid references zz.eval (id) on delete set null;

-- Read one way only: given a real round, find the control that names it.
create index if not exists eval_controls_idx on zz.eval (controls) where controls is not null;
