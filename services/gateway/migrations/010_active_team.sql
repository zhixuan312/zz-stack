-- Which team a person is ACTING FOR, chosen rather than computed.
--
-- The concept already existed: teamsFor() returned {active, all}, and `active` was decided
-- by a rule nobody picked — admin role first, then alphabetically. So a person in two teams
-- had an active team they never chose and could not see, and work landed in it.
--
-- One active team at a time, switched deliberately in ZZ Access. Nullable because a person
-- may be in no team yet, and because the first membership is adopted on first use rather
-- than at insert — a column that must be right at creation is one more thing to get wrong.
--
-- ON DELETE SET NULL, not CASCADE: retiring a team must not delete the people in it.
alter table zz.principal
  add column if not exists active_team_id uuid references zz.team (id) on delete set null;
