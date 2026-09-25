-- Release-path review fixes (FR-49): three facts zz.release_attempt could not hold.
--
-- plugin_id: migration 077's own partial unique index keys on candidate_id, so two DIFFERENT
-- candidates built on the same base could both sit in 'applying' at once — each passing the
-- compare-and-swap against a released subject the other was about to move. A partial unique index
-- cannot join through zz.candidate, so the plugin is recorded on the row itself (release_prepare
-- writes it) and the index below makes "at most one applying attempt per plugin" a database fact
-- rather than a property of the advisory lock alone. Filled from the attempt's own base subject.
alter table zz.release_attempt
    add column plugin_id uuid null references zz.plugin(id),
    add column applied_by text null,
    add column applying_at timestamp with time zone null;

update zz.release_attempt ra
   set plugin_id = sv.plugin_id
  from zz.eval_subject_version sv
 where sv.id = ra.base_subject_version_id;

alter table zz.release_attempt alter column plugin_id set not null;

create unique index release_attempt_applying_plugin_idx on zz.release_attempt (plugin_id)
    where status = 'applying';

comment on column zz.release_attempt.plugin_id is
  'The plugin this attempt releases — the base subject''s own plugin, written by release_prepare. Keys release_attempt_applying_plugin_idx: at most one applying attempt per plugin.';
comment on column zz.release_attempt.applied_by is
  'The principal whose release_apply moved this attempt to applying. release_record and release_verify accept that principal or a member of a required owner team, nobody else.';
comment on column zz.release_attempt.applying_at is
  'When release_apply moved this attempt to applying. An attempt still applying long after the CLI''s own gate and release timeouts is stale: release_apply names it for reconciliation.';
