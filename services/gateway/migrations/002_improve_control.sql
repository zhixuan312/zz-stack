-- 002_improve_control — group G of the approved spec: the nine improve, promote and control
-- tables take their phase-4 shape, two relations hidden in jsonb become tables, and the
-- chain-check probe litter leaves.
--
-- The runner (`services/gateway/src/db.ts`) wraps this file in one transaction and records it in
-- `zz.schema_migration`; there is no `begin`/`commit` here and every name is schema-qualified.
--
-- Four shapes drive what follows.
--
-- A relation that is stored in a jsonb column cannot be enforced, and two of them gate something.
-- `improvement_run.finding_ids` is the provenance an improvement run is built on, and
-- `release_attempt.required_owners` is the list `document_approve` reads before an approval
-- counts. Both become rows — `improvement_run_finding` and `release_attempt_owner` — and the
-- columns go. `control_run`'s key is the same defect in text form: `(team_slug, initiative)`
-- names an initiative by address, so a run whose initiative was deleted keeps pointing at
-- nothing. It becomes `initiative_id`, `not null`, `unique`, `on delete cascade`.
--
-- A duplicate is not a second fact. `release_attempt.base_subject_version_id` and
-- `.approved_patch_digest` copy immutable columns of the `candidate` they name; `candidate.
-- touched_owners` copies `release_attempt.required_owners`; `release_attempt.rolled_back` copies
-- `status = 'rolled_back'`; `release_attempt.approval_refs` was written as `[]` and never read.
-- All five go, and every reader joins the row that owns the fact.
--
-- A column that is a query's own predicate belongs in a column. `release_attempt.verification`
-- held `{verdict, reason, evidence, rollback_plan}` and `release_verify`'s own retry gate reads
-- the verdict; `verdict` and `verified_at` become columns and `verification` keeps the evidence
-- the verdict rests on. `control_evidence.entry_id` is the kernel's matching key, and it repeats
-- inside a run today, so the run's facts are re-identified before the unique constraint the spec
-- names can hold.
--
-- An actor named by an address is a relation to `principal`, as `assessment.asked_by` and
-- `event.actor_id` already are. `eval_finding.decided_by`, `release_attempt.applied_by` and
-- `control_run.started_by` each become a principal id. Where the address names no principal the
-- column is null: an address that resolves to nobody is not a principal, and the spec makes all
-- three nullable. The address is never invented into a row; the count that could not be resolved
-- is reported below.
--
-- The probe litter is the one deletion, and it is the spec's criterion, not a list of names: a
-- `control_run` whose initiative does not exist is chain-check litter, and its evidence and
-- waivers leave with it through the foreign key that already cascades. The runs that do resolve
-- are keyed to the initiative they name, and the rehearsal's before/after table states how many
-- left rather than this file freezing a count live data has already moved.

-- ---------------------------------------------------------------------------------------------
-- (a) `eval_finding`: one lifecycle, and the relations the columns were carrying.
-- ---------------------------------------------------------------------------------------------
--
-- Two lifecycles shared this table: the legacy ruler rounds, whose columns (`eval_id`, `scope`,
-- `docs_affected`, `proposed_change`, `resulted_in_skill_version_id`) have had no writer since
-- Task I-13, and the `eval_run` findings. `002_catalog_evaluation.sql` archived the legacy rows
-- with the rounds and deleted them; what is left is one lifecycle, and it takes the spec's shape.
--
-- Three of the spec's checks hold of the data only after this block makes them hold:
--
--   * `owner_kind = 'plugin'` requires `owner_ref` null. The value always equalled the subject's
--     own plugin, which the run already names through its observation snapshot, so the copy goes
--     and the relation is derived through the run.
--   * `kind = 'strength'` requires `decision` null. A strength is what is working, not open work,
--     and `deferred` on one said the opposite. The column loses both its `not null` and its
--     `deferred` default, because neither can survive the check.
--   * `superseded_by` is constrained to `null or decision = 'rejected'`; no row carries one yet,
--     and the check is what keeps that true.
--
-- `decided_by` was the caller's address. It becomes the principal that address names, and it is
-- null exactly where nothing was decided — the same rows that carried the empty string.

alter table zz.eval_finding rename column decided_by to decided_by_address;
alter table zz.eval_finding add column decided_by uuid;

update zz.eval_finding f
   set decided_by = p.id
  from zz.principal p
 where p.email = f.decided_by_address;

do $$
declare n bigint;
begin
  select count(*) into n from zz.eval_finding
   where decided_by_address is not null and decided_by_address <> '' and decided_by is null;
  if n > 0 then
    raise exception 'eval_finding: % row(s) name a decider by an address no principal has', n;
  end if;
  select count(*) into n from zz.eval_finding where decided_by_address = '';
  if n > 0 then
    raise notice 'eval_finding: % row(s) carry an empty decider address and become NULL', n;
  end if;
  -- The address column is dropped after this, and a run id, a kind and an owner are what every
  -- surviving reader reads this table by.
  select count(*) into n from zz.eval_finding
   where eval_run_id is null or kind is null or owner_kind is null;
  if n > 0 then
    raise exception 'eval_finding: % row(s) name no run, no kind or no owner', n;
  end if;
end $$;

alter table zz.eval_finding drop column decided_by_address;

update zz.eval_finding set owner_ref = null where owner_kind = 'plugin' and owner_ref is not null;

-- The column sheds both before the strengths are nulled: `not null` cannot hold beside the check,
-- and the `deferred` default would put a decision back on a strength inserted without one.
alter table zz.eval_finding alter column decision drop not null;
alter table zz.eval_finding alter column decision drop default;
update zz.eval_finding set decision = null where kind = 'strength';

alter table zz.eval_finding alter column eval_run_id set not null;
alter table zz.eval_finding alter column kind set not null;
alter table zz.eval_finding alter column owner_kind set not null;

-- What goes with those columns: the XOR against the legacy round, the legacy scope vocabulary,
-- and the two foreign keys that name a column this block drops. The foreign key to the legacy
-- round table is already gone — it left with that table in the phase before this one, so this
-- block drops only the four the folded baseline still carries. The
-- `eval_finding_run_requires_kind_check` constraint stays: it was true before and is true after,
-- and the spec does not retire it.
alter table zz.eval_finding drop constraint eval_finding_round_xor_run_check;
alter table zz.eval_finding drop constraint eval_finding_scope_check;
alter table zz.eval_finding drop constraint eval_finding_resulted_in_skill_version_id_fkey;
alter table zz.eval_finding drop constraint eval_finding_superseded_by_fkey;

alter table zz.eval_finding drop column eval_id;
alter table zz.eval_finding drop column docs_affected;
alter table zz.eval_finding drop column scope;
alter table zz.eval_finding drop column proposed_change;
alter table zz.eval_finding drop column resulted_in_skill_version_id;

-- A correction stays inside its own run: `(eval_run_id, id)` is what the composite self-reference
-- resolves against, and `unique (eval_run_id, id)` is the key it needs to exist.
alter table zz.eval_finding
  add constraint eval_finding_eval_run_id_id_key unique (eval_run_id, id);
alter table zz.eval_finding
  add constraint eval_finding_eval_run_id_superseded_by_fkey
  foreign key (eval_run_id, superseded_by) references zz.eval_finding(eval_run_id, id);
alter table zz.eval_finding
  add constraint eval_finding_decided_by_fkey foreign key (decided_by) references zz.principal(id);
alter table zz.eval_finding
  add constraint eval_finding_kind_decision_check check ((kind = 'strength') = (decision is null));
alter table zz.eval_finding
  add constraint eval_finding_owner_ref_check check (owner_kind <> 'plugin' or owner_ref is null);
alter table zz.eval_finding
  add constraint eval_finding_superseded_check check (superseded_by is null or decision = 'rejected');
create index eval_finding_eval_run_id_idx on zz.eval_finding using btree (eval_run_id);

comment on column zz.eval_finding.eval_run_id is
  'The run that concluded this finding (finding_record). Every finding names one, and the legacy round column it shared this table with went with the round tables.';
comment on column zz.eval_finding.kind is
  'strength | defect | unknown. A strength is terminal at insert — it is what is working, not open work, so its decision is null.';

-- ---------------------------------------------------------------------------------------------
-- (b) `improvement_run` and the relation its findings were hidden in.
-- ---------------------------------------------------------------------------------------------

create table zz.improvement_run_finding (
    improvement_run_id uuid not null,
    finding_id uuid not null,
    constraint improvement_run_finding_pkey primary key (improvement_run_id, finding_id),
    constraint improvement_run_finding_finding_id_fkey foreign key (finding_id) references zz.eval_finding(id),
    constraint improvement_run_finding_improvement_run_id_fkey foreign key (improvement_run_id) references zz.improvement_run(id) on delete cascade
);

-- `finding_ids` was a jsonb array of `eval_finding` ids with no foreign key behind it. A value
-- that names no finding fails the migration rather than landing as a row nothing can read.
do $$
declare n bigint;
begin
  select count(*) into n
    from zz.improvement_run ir
    cross join lateral jsonb_array_elements_text(ir.finding_ids) as f(id)
   where not exists (select 1 from zz.eval_finding e where e.id = f.id::uuid);
  if n > 0 then
    raise exception 'improvement_run: % finding_ids entr(ies) name no eval_finding', n;
  end if;
end $$;

insert into zz.improvement_run_finding (improvement_run_id, finding_id)
select ir.id, f.id::uuid
  from zz.improvement_run ir
  cross join lateral jsonb_array_elements_text(ir.finding_ids) as f(id)
 group by ir.id, f.id;

alter table zz.improvement_run drop column finding_ids;
create index improvement_run_eval_run_id_created_at_idx on zz.improvement_run using btree (eval_run_id, created_at desc);

-- ---------------------------------------------------------------------------------------------
-- (c) `candidate`: the patch is text, and the proposer is a principal.
-- ---------------------------------------------------------------------------------------------
--
-- `patchset` was a fixed `{diff, files}` object; the diff is the patch and the file list is
-- derived from it (`parseUnifiedDiff`) and already recorded in `touched_components`.
-- `proposer_identity` was a fixed `{principal, client, hypothesis_digest}` object with no reader;
-- the principal and the client become columns and the digest is derived from the hypothesis.
-- `touched_owners` is dropped because `release_attempt_owner` is the copy that gates.

alter table zz.candidate rename column base_subject_version_id to base_plugin_version_id;
alter table zz.candidate rename constraint candidate_base_subject_version_id_fkey to candidate_base_plugin_version_id_fkey;

alter table zz.candidate add column patch text;
alter table zz.candidate add column proposed_by uuid;
alter table zz.candidate add column proposer_client text;

update zz.candidate c
   set patch = c.patchset->>'diff',
       proposed_by = p.id,
       proposer_client = c.proposer_identity->>'client'
  from zz.principal p
 where p.email = c.proposer_identity->>'principal';

do $$
declare n bigint;
begin
  select count(*) into n from zz.candidate where patch is null;
  if n > 0 then
    raise exception 'candidate: % row(s) carry no diff in their patchset', n;
  end if;
  select count(*) into n from zz.candidate where proposed_by is null;
  if n > 0 then
    raise exception 'candidate: % row(s) name a proposer by an address no principal has', n;
  end if;
  select count(*) into n from zz.candidate
   where status not in ('recorded', 'awaiting_build', 'valid', 'invalid');
  if n > 0 then
    raise exception 'candidate: % row(s) carry a status the release attempt owns, not the candidate', n;
  end if;
end $$;

alter table zz.candidate alter column patch set not null;
alter table zz.candidate alter column proposed_by set not null;
alter table zz.candidate drop column patchset;
alter table zz.candidate drop column touched_owners;
alter table zz.candidate drop column proposer_identity;

alter table zz.candidate drop constraint candidate_status_check;
alter table zz.candidate
  add constraint candidate_status_check check (status in ('recorded', 'awaiting_build', 'valid', 'invalid'));
alter table zz.candidate
  add constraint candidate_proposed_by_fkey foreign key (proposed_by) references zz.principal(id);

comment on column zz.candidate.status is
  'recorded -> awaiting_build -> valid or invalid. The attempt states, released and rolled_back, live on release_attempt; a reader joins that row rather than reading a copy here.';

-- ---------------------------------------------------------------------------------------------
-- (d) `release_attempt`: the verdict is a column, and the owners are rows.
-- ---------------------------------------------------------------------------------------------

create table zz.release_attempt_owner (
    release_attempt_id uuid not null,
    team_id uuid not null,
    constraint release_attempt_owner_pkey primary key (release_attempt_id, team_id),
    constraint release_attempt_owner_release_attempt_id_fkey foreign key (release_attempt_id) references zz.release_attempt(id) on delete cascade,
    constraint release_attempt_owner_team_id_fkey foreign key (team_id) references zz.team(id)
);

alter table zz.release_attempt rename column released_subject_version_id to released_plugin_version_id;
alter table zz.release_attempt rename constraint release_attempt_released_subject_version_id_fkey to release_attempt_released_plugin_version_id_fkey;

-- An owner team slug that resolves to no team would silently drop a release owner, and the owner
-- list is what gates `document_approve` — an authority, not a label.
do $$
declare n bigint;
begin
  select count(*) into n
    from zz.release_attempt r
    cross join lateral jsonb_array_elements_text(r.required_owners) as s(slug)
   where not exists (select 1 from zz.team t where t.slug = s.slug);
  if n > 0 then
    raise exception 'release_attempt: % required_owners entr(ies) name a team slug no team has', n;
  end if;
end $$;

insert into zz.release_attempt_owner (release_attempt_id, team_id)
select r.id, t.id
  from zz.release_attempt r
  cross join lateral jsonb_array_elements_text(r.required_owners) as s(slug)
  join zz.team t on t.slug = s.slug
 group by r.id, t.id;

alter table zz.release_attempt add column verdict text;
alter table zz.release_attempt add column verified_at timestamp with time zone;
alter table zz.release_attempt rename column applied_by to applied_by_address;
alter table zz.release_attempt add column applied_by uuid;

-- The verdict a retry gate reads becomes a column, the evidence stays where it was, and the
-- legacy jsonb's own `rollback_plan` goes: plugin, declared version and prior version are all
-- reachable from the attempt's candidate and its base release, so nothing is carried twice.
update zz.release_attempt r
   set verdict = r.verification->>'verdict',
       verification = r.verification->'evidence',
       applied_by = p.id
  from zz.principal p
 where p.email = r.applied_by_address;

do $$
declare n bigint;
begin
  select count(*) into n from zz.release_attempt
   where applied_by_address is not null and applied_by_address <> '' and applied_by is null;
  if n > 0 then
    raise exception 'release_attempt: % row(s) name an applier by an address no principal has', n;
  end if;
  select count(*) into n from zz.release_attempt
   where status not in ('prepared', 'applying', 'released', 'refused', 'failed', 'rolled_back');
  if n > 0 then
    raise exception 'release_attempt: % row(s) carry a status outside the attempt lifecycle', n;
  end if;
  -- The release ref is the 40-hex commit the release tag names, and the released version is
  -- present exactly when the attempt reached released or rolled_back.
  select count(*) into n from zz.release_attempt
   where (status in ('released', 'rolled_back')) <> (released_plugin_version_id is not null);
  if n > 0 then
    raise exception 'release_attempt: % row(s) disagree about whether they released something', n;
  end if;
end $$;

alter table zz.release_attempt drop column applied_by_address;
alter table zz.release_attempt drop constraint release_attempt_base_subject_version_id_fkey;
alter table zz.release_attempt drop column base_subject_version_id;
alter table zz.release_attempt drop column approved_patch_digest;
alter table zz.release_attempt drop column required_owners;
alter table zz.release_attempt drop column approval_refs;
alter table zz.release_attempt drop column rolled_back;

alter table zz.release_attempt
  add constraint release_attempt_applied_by_fkey foreign key (applied_by) references zz.principal(id);
alter table zz.release_attempt
  add constraint release_attempt_release_ref_check check (release_ref is null or release_ref ~ '^[0-9a-f]{40}$');
alter table zz.release_attempt
  add constraint release_attempt_released_check check ((status in ('released', 'rolled_back')) = (released_plugin_version_id is not null));
alter table zz.release_attempt
  add constraint release_attempt_verdict_check check (verdict in ('established', 'rolled_back', 'not_established'));

comment on column zz.release_attempt.verification is
  'The evidence the verdict rests on: {post_release_runs, released_eval_run_id, released_overall, base_eval_run_id, base_overall, delta, regression_band, guardrail_status}. Null until the released subject has enough real runs and an evaluation to judge. The verdict itself is the verdict column, and when it landed is verified_at.';
comment on column zz.release_attempt.applied_by is
  'The principal whose release_apply moved this attempt to applying. release_record and release_verify accept that principal or a member of a required owner team, nobody else.';

-- ---------------------------------------------------------------------------------------------
-- (e) `control_run`: keyed by the initiative, and the probe litter swept.
-- ---------------------------------------------------------------------------------------------
--
-- `(team_slug, initiative)` named an initiative by address, so a run whose initiative was deleted
-- kept pointing at nothing — 70 of the ledger's 102 runs, and their evidence, were chain-check
-- probe runs nothing ever swept. The key becomes `initiative_id`, resolved through `zz.team.slug`
-- and `zz.initiative.slug`; a run that resolves to no initiative is litter and leaves, with its
-- evidence and waivers, rather than being given a null key the spec's foreign key refuses.
--
-- `module_id` equalled `initiative.flow` by construction; `subject` was always the initiative
-- slug; `profile` was always `[]`. All three are constant or derivable and go.
--
-- `started_by` was the enroler's address as text. It becomes the principal that address names, as
-- `decided_by` and `applied_by` do above. The enrollment script that created the surviving runs
-- was never a principal, so those rows carry null — an address that resolves to nobody is not a
-- principal — and the same text is still recorded, per fact, in `control_evidence.recorded_by`.

alter table zz.control_run add column initiative_id uuid;

update zz.control_run r
   set initiative_id = i.id
  from zz.team t
  join zz.initiative i on i.team_id = t.id
 where t.slug = r.team_slug and i.slug = r.initiative;

do $$
declare n bigint;
begin
  select count(*) into n from zz.control_run where initiative_id is null;
  raise notice 'control_run: % chain-check probe run(s) resolve no initiative and are deleted with their evidence', n;
end $$;

delete from zz.control_run where initiative_id is null;

alter table zz.control_run alter column initiative_id set not null;

alter table zz.control_run rename column started_by to started_by_address;
alter table zz.control_run add column started_by uuid;

update zz.control_run r set started_by = p.id from zz.principal p where p.email = r.started_by_address;

do $$
declare n bigint;
begin
  select count(*) into n from zz.control_run
   where started_by_address is not null and started_by_address <> '' and started_by is null;
  if n > 0 then
    raise notice 'control_run: % run(s) name an enroler by an address no principal has and carry NULL instead', n;
  end if;
end $$;

alter table zz.control_run drop column started_by_address;

do $$
declare n bigint;
begin
  select count(*) into n
    from (select initiative_id from zz.control_run group by 1 having count(*) > 1) d;
  if n > 0 then
    raise exception 'control_run: % initiative(s) are governed by more than one run', n;
  end if;
end $$;

alter table zz.control_run drop constraint control_run_team_slug_initiative_key;
alter table zz.control_run drop column team_slug;
alter table zz.control_run drop column initiative;
alter table zz.control_run drop column module_id;
alter table zz.control_run drop column subject;
alter table zz.control_run drop column profile;

alter table zz.control_run
  add constraint control_run_initiative_id_key unique (initiative_id);
alter table zz.control_run
  add constraint control_run_initiative_id_fkey foreign key (initiative_id) references zz.initiative(id) on delete cascade;
alter table zz.control_run
  add constraint control_run_started_by_fkey foreign key (started_by) references zz.principal(id);

-- ---------------------------------------------------------------------------------------------
-- (f) `control_evidence`: one fact, one id.
-- ---------------------------------------------------------------------------------------------
--
-- `entry_id` is the kernel's matching key and it repeats inside a run: the writer recorded
-- `approval:<path>` on every approval of a document and `doc:<path>` on every write before the
-- versioned form landed. Because the kernel's withdrawn set is order-independent, one revision
-- then withdrew every approval of that document, later ones included, so 12 re-approvals counted
-- for nothing. The constraint is the backstop; this block makes the ids unique so it can hold.
--
-- The re-identification, in the spec's order:
--
--   1. every row of a duplicate `(run_id, entry_id)` group is suffixed with its own `seq`;
--   2. `supersedes` is re-pointed at the newest entry of the path it names that precedes it in
--      its own run, and nulled where none does — 51 rows withdrew an approval that never existed;
--   3. an approval's `about` names the document entry current at its own `seq`, which is the
--      version it approved rather than the path it was derived from.
--
-- A path an approval names with no document entry before it fails the migration: `about` is the
-- id the kernel matches an approval against, and an approval nothing can match is not a fact.

do $$
declare n bigint;
begin
  -- The map is the run's own rows with the id each is about to carry, so steps 2 and 3 can
  -- resolve a path to the row that holds it after step 1 has re-identified it.
  create temp table zz_improve_control_evidence_map on commit drop as
    select e.run_id,
           e.seq,
           e.entry_id as old_id,
           case when count(*) over (partition by e.run_id, e.entry_id) > 1
                then e.entry_id || '@' || e.seq::text
                else e.entry_id end as new_id
      from zz.control_evidence e;

  update zz.control_evidence e
     set entry_id = m.new_id
    from zz_improve_control_evidence_map m
   where m.run_id = e.run_id and m.seq = e.seq;

  -- The scalar subquery returns null where no entry of that path precedes the row, which is the
  -- null the spec asks for; it reads `e.supersedes` from before this statement, as a SET
  -- expression always does.
  update zz.control_evidence e
     set supersedes = (
           select m2.new_id
             from zz_improve_control_evidence_map m2
            where m2.run_id = e.run_id and m2.old_id = e.supersedes and m2.seq < e.seq
            order by m2.seq desc
            limit 1)
   where e.supersedes is not null;

  select count(*) into n
    from zz.control_evidence e
   where e.kind = 'approval'
     and not exists (select 1 from zz.control_evidence d
                      where d.run_id = e.run_id and d.kind = 'document'
                        and ('doc:' || d.about) = e.about and d.seq <= e.seq);
  if n > 0 then
    raise exception 'control_evidence: % approval(s) name a path no document entry of their own run precedes', n;
  end if;

  update zz.control_evidence e
     set about = (
           select m2.new_id
             from zz_improve_control_evidence_map m2
             join zz.control_evidence d
               on d.run_id = m2.run_id and d.seq = m2.seq and d.kind = 'document'
            where m2.run_id = e.run_id and ('doc:' || d.about) = e.about and m2.seq <= e.seq
            order by m2.seq desc
            limit 1)
   where e.kind = 'approval';

  select count(*) into n
    from (select run_id, entry_id from zz.control_evidence group by 1, 2 having count(*) > 1) d;
  if n > 0 then
    raise exception 'control_evidence: % (run_id, entry_id) group(s) are still duplicated after re-identification', n;
  end if;

  select count(*) into n
    from zz.control_evidence e
   where e.supersedes is not null
     and not exists (select 1 from zz.control_evidence o
                      where o.run_id = e.run_id and o.entry_id = e.supersedes and o.seq < e.seq);
  if n > 0 then
    raise exception 'control_evidence: % supersedes value(s) name no earlier entry of their own run', n;
  end if;
end $$;

alter table zz.control_evidence drop column note;

alter table zz.control_evidence
  add constraint control_evidence_run_id_entry_id_key unique (run_id, entry_id);
alter table zz.control_evidence
  add constraint control_evidence_run_id_supersedes_fkey
  foreign key (run_id, supersedes) references zz.control_evidence(run_id, entry_id);
alter table zz.control_evidence
  add constraint control_evidence_kind_check check (kind in ('document', 'approval', 'audit'));

-- ---------------------------------------------------------------------------------------------
-- (g) `control_waiver`: one waiver per gap, and the ground it stands on.
-- ---------------------------------------------------------------------------------------------
--
-- No column moves. Two waivers for the same gap add nothing, and a waiver with an empty ground
-- is a gap somebody accepted without saying why, which the code has always required and only the
-- writer, now gone, enforced.

alter table zz.control_waiver
  add constraint control_waiver_run_id_step_id_kind_key unique (run_id, step_id, kind);
alter table zz.control_waiver
  add constraint control_waiver_ground_check check (btrim(ground) <> '');
alter table zz.control_waiver
  add constraint control_waiver_kind_check check (kind in ('document', 'approval', 'audit'));
