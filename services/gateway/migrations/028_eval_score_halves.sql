-- A judgement of 4.5 must be stored as 4.5.
--
-- zz.eval_score.score was smallint. eval-judge emits whole numbers, so nothing noticed —
-- until a person scored two initiatives gate by gate and used half points, which is what a
-- careful reader does when a document is clearly better than the 4 anchor and short of the 5.
--
-- Rounding on the way in moved one document's mean from 3.90 to 4.20. That is larger than
-- most of the differences these scores exist to detect, so the storage decision was quietly
-- deciding the finding. A column that changes the number it is given is worse than one that
-- refuses it.
--
-- numeric(2,1) holds 1.0 through 5.0 in halves and casts every existing integer unchanged,
-- so the corpus stays comparable and no score already taken moves.
alter table zz.eval_score alter column score type numeric(2,1) using score::numeric(2,1);

comment on column zz.eval_score.score is
  'One dimension, 1.0-5.0. Halves allowed: a judge who means 4.5 must not be recorded as 5.';
