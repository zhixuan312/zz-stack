-- Every event written since 020 has a team slug and a null team key.
--
-- WHAT HAPPENED. 020_event_attribution.sql made zz.event.team_id the real foreign key —
-- "tenancy has to be answerable for all of them without a join, because every query in the
-- system filters by it" — and backfilled every row that existed at the time. It did not
-- touch the INSERT in services/gateway/src/events.ts, which has gone on writing team_slug
-- and nothing else. So the backfill was a photograph, not a rule: correct for the rows in
-- front of it and wrong for every row since.
--
-- WHAT IT COST. 36,784 events across four days, every one of them carrying a slug that
-- resolves to a real team, all invisible to anything that joins through team_id. The
-- console's team-scoped overview read zero events for a week in which the platform ran
-- busier than it ever had, and the number was not wrong — the query was right and the data
-- was empty. Found by a person looking at a chart and refusing to believe it.
--
-- THE WRITER IS FIXED IN THE SAME CHANGE as this file; without that, this migration is
-- another photograph and the next four days repeat it. This only settles the history.
--
-- IDEMPOTENT, and deliberately the same statement 020 ended with: `where e.team_id is null`
-- means running it twice changes nothing the second time, and a row whose slug names no
-- surviving team is left null rather than invented. zz-team is the real case — created
-- 2026-08-25, archived 2026-09-06, 139 events outliving it. Those events happened and the
-- log says so; the team did not survive, and no key can point at a row that is gone. An
-- unattributed event is the honest record of one, not a gap to be filled.

update zz.event e set team_id = t.id
  from zz.team t
 where t.slug = e.team_slug
   and e.team_id is null;
