-- A run whose calls were never measured has no total. That is not a total of zero.
--
-- 017 created bytes_total as `bigint not null default 0`, and runs.ts wrote
-- `coalesce(sum(...), 0)` into it, so the two facts collapsed into one number: a run that
-- genuinely moved nothing and a run nobody measured both read as 0. It went unnoticed while
-- every tool_call row carried `detail.bytes`, because the unmeasured case was rare enough to
-- look like noise. 050 moved the figure into `zz.event.response_bytes`, which is nullable
-- precisely so a gap stays a gap — and every row written before 050 has a null there. Left
-- as it was, this column would have converted all of that back into zeros on the next
-- refresh, which is the FR-7a conflation the initiative exists to remove, reintroduced by a
-- default nobody looked at.
--
-- Separate from 050 rather than folded into it: 050 may already have applied on a host, and
-- an applied migration is history.
--
-- Existing zeros are NOT converted to null. A zero already in this column is unreadable —
-- it may be either fact — and guessing which would be inventing data to satisfy a schema.
-- They stay as they are, ambiguous and finite; every row written from here is honest.
alter table zz.run alter column bytes_total drop not null;
alter table zz.run alter column bytes_total drop default;

comment on column zz.run.bytes_total is
  'Sum of response_bytes over the run''s events. Null when no event in the run was measured — '
  'distinct from 0, which means measured and empty. Zeros written before migration 051 are '
  'ambiguous and were deliberately not converted.';
