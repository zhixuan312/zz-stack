-- A recorded suite belongs to an initiative, because running one is a piece of work.
--
-- zz.plugin_case_run held what a suite measured and no trace of the WORK of measuring it: who
-- was doing what, under which flow, and what came of it. So four suites could be run, eleven
-- cases measured and $15.76 spent, and the platform's own record of "what is this team doing"
-- said nothing had happened — while the console, which lists initiatives, showed no sign of the
-- most expensive act anybody took that week.
--
-- zz-plugin-eval IS A FLOW: locate, profile, define (rulers.md), judge, report (findings.md).
-- Recording the run outside an initiative meant the flow's own first evidence lived somewhere
-- its later stages could not reach, and `findings.md` had nowhere to be written to.
--
-- NULLABLE, AND NULL MEANS "recorded before this column existed". Eight rows predate it. They
-- are not backfilled onto an invented initiative: a run that was never part of one is a fact
-- about how it was recorded, and inventing a folder to hold it would put a piece of work in
-- this team's history that nobody did.
alter table zz.plugin_case_run add column if not exists team_slug text;
alter table zz.plugin_case_run add column if not exists initiative text;

comment on column zz.plugin_case_run.initiative is
  'The initiative this suite was run as, on the zz-plugin-eval flow. NULL for runs recorded '
  'before 055, which is not the same as a run that belonged to no work.';

create index if not exists plugin_case_run_initiative
  on zz.plugin_case_run (team_slug, initiative);
