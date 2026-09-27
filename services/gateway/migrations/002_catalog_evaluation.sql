-- 002_catalog_evaluation — the catalog tables take their phase-3 shape, `plugin_version` becomes
-- the one release identity, and the legacy evaluation family is archived and dropped.
--
-- The runner (`services/gateway/src/db.ts`) wraps this file in one transaction and records it in
-- `zz.schema_migration`; there is no `begin`/`commit` here and every name is schema-qualified.
--
-- Three shapes drive what follows.
--
-- A release has one identity. `eval_subject_version` was a second row per released thing,
-- carrying the same `plugin_id` and the same `declared_version` as a `plugin_version` and a
-- `content_digest` beside its `digest`. It folds onto `plugin_version` — the four source columns,
-- `released_at` and the id every reader is repointed to — and `plugin_version.digest` keeps the
-- value it already has and is never rewritten again (AC-6.2).
--
-- The legacy evaluation family is a closed history. `rubric`, `rubric_dimension`, `eval`,
-- `eval_subject`, `eval_score`, `eval_protocol`, `eval_evaluator`, `eval_evidence_snapshot` and
-- `eval_subject_version` are read once, archived whole, and dropped. The archive is the first
-- statement group below and it FAILS the migration rather than dropping a row it could not write:
-- a destructive phase whose data disposition includes a real archive step must not be able to
-- lose the rows silently. It is written as a large object in the platform's own database, so it
-- travels in the deployment's `pg_dump` backup (`deploy/backup.sh`) and never reaches a team
-- shelf — the archived `eval_score` quotes and `eval_subject_version` manifests carry quan's and
-- xuan's text, which no team store may hold.
--
-- What the family carried is normalised rather than guessed. `eval_run.dimension_scores` jsonb
-- becomes one `eval_run_dimension` row per element; `eval_failure_mode_candidate` becomes an
-- identity plus a sighting per row; `eval_assessment.subject_ref` text becomes the one typed
-- column its own kind names, decided by the same rule the door's `refKindOf` reads. A row whose
-- kind cannot be settled fails the migration, never lands with a guessed kind.
--
-- Four foreign keys hold the legacy tables in place from surviving ones and are removed first,
-- because PostgreSQL refuses a `DROP TABLE` while another table references it:
--
--   candidate.base_subject_version_id        -> eval_subject_version
--   release_attempt.base_subject_version_id  -> eval_subject_version
--   release_attempt.released_subject_version_id -> eval_subject_version
--   eval_finding.eval_id                     -> eval
--   eval_protocol_version.protocol_id        -> eval_protocol
--   eval_evaluator_version.evaluator_id      -> eval_evaluator
--
-- The three `*_subject_version_id` columns stay, repointed at `plugin_version(id)`; the other
-- three columns go with the tables they named. `eval_finding`'s 11 rows that carry an `eval_id`
-- are deleted explicitly, after the archive, because their own foreign key cascades from `eval`.

-- ---------------------------------------------------------------------------------------------
-- The six foreign keys that hold the legacy tables in place.
-- ---------------------------------------------------------------------------------------------

alter table zz.candidate drop constraint candidate_base_subject_version_id_fkey;
alter table zz.release_attempt drop constraint release_attempt_base_subject_version_id_fkey;
alter table zz.release_attempt drop constraint release_attempt_released_subject_version_id_fkey;
alter table zz.eval_finding drop constraint eval_finding_eval_id_fkey;
alter table zz.eval_protocol_version drop constraint eval_protocol_version_protocol_id_fkey;
alter table zz.eval_evaluator_version drop constraint eval_evaluator_version_evaluator_id_fkey;

-- ---------------------------------------------------------------------------------------------
-- The archive: every row of the legacy family, before anything below touches a column.
-- ---------------------------------------------------------------------------------------------
--
-- Written the way `pg_dump --data-only` writes a table: a `COPY <table> (<columns>) FROM stdin;`
-- header, the tab-separated rows `COPY … TO PROGRAM` produces, and a `\.` terminator. One
-- section per table, and one more for the `eval_finding` rows that carry an `eval_id`, which are
-- part of this family even though the table survives into phase 4.
--
-- The rows are assembled by the server: `copy … to program 'cat >> <scratch>'` appends each
-- table's own `COPY` output to one file in the container's `/tmp`, which is read back whole and
-- sliced by the characters already consumed. A table whose `COPY` wrote a line count other than
-- the row count its own table holds raises, so a row the archive could not carry is a refused
-- migration rather than a dropped row.

do $$
declare
  scratch constant text := '/tmp/zz-legacy-evaluation-archive.tab';
  payload text := '';
  seen text := '';
  whole text;
  chunk text;
  cols text;
  n bigint;
  lines bigint;
  rec record;
  archive_oid oid;
  archive_bytes bigint;
begin
  -- Truncate whatever a previous attempt left: this file is a scratch buffer, never the archive.
  execute format('copy (select '''' where false) to program %L', ': > ' || scratch);

  payload := format(E'-- zz legacy evaluation archive\n'
                 || E'-- written by services/gateway/migrations/002_catalog_evaluation.sql (%s)\n'
                 || E'-- one COPY section per table, as pg_dump --data-only writes them\n\n',
                 to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));

  for rec in
    select name from (values
      ('rubric'), ('rubric_dimension'), ('eval'), ('eval_subject'), ('eval_score'),
      ('eval_protocol'), ('eval_evaluator'), ('eval_evidence_snapshot'), ('eval_subject_version')
    ) as v(name)
  loop
    execute format('copy zz.%I to program %L', rec.name, 'cat >> ' || scratch);
    select string_agg(a.attname, ', ' order by a.attnum) into cols
      from pg_attribute a
     where a.attrelid = ('zz.' || rec.name)::regclass and a.attnum > 0 and not a.attisdropped;
    execute format('select count(*) from zz.%I', rec.name) into n;
    whole := pg_read_file(scratch);
    chunk := substr(whole, length(seen) + 1);
    seen := whole;
    -- A `COPY` row never contains a raw newline: the text format escapes it as `\n`, so the line
    -- count of the chunk is the row count of the table, and a short chunk is a row that is about
    -- to be destroyed without being archived.
    lines := length(chunk) - length(replace(chunk, E'\n', ''));
    if lines <> n then
      raise exception 'archive: zz.% holds % row(s) but its COPY section carries % line(s)', rec.name, n, lines;
    end if;
    payload := payload || format(E'-- table zz.%s: %s row(s)\nCOPY zz.%s (%s) FROM stdin;\n', rec.name, n, rec.name, cols)
                      || chunk || E'\\.\n\n';
  end loop;

  -- The `eval_finding` rows whose `eval_id` names a legacy round. They are archived with the
  -- family and deleted below, because their own foreign key cascades from `eval`.
  select count(*) into n from zz.eval_finding where eval_id is not null;
  execute format('copy (select * from zz.eval_finding where eval_id is not null) to program %L',
                 'cat >> ' || scratch);
  whole := pg_read_file(scratch);
  chunk := substr(whole, length(seen) + 1);
  lines := length(chunk) - length(replace(chunk, E'\n', ''));
  if lines <> n then
    raise exception 'archive: zz.eval_finding holds % row(s) with an eval_id but its COPY section carries % line(s)', n, lines;
  end if;
  select string_agg(a.attname, ', ' order by a.attnum) into cols
    from pg_attribute a
   where a.attrelid = 'zz.eval_finding'::regclass and a.attnum > 0 and not a.attisdropped;
  payload := payload || format(E'-- table zz.eval_finding, rows with an eval_id: %s row(s)\nCOPY zz.eval_finding (%s) FROM stdin;\n', n, cols)
                    || chunk || E'\\.\n';

  if length(payload) = 0 then
    raise exception 'archive: nothing was assembled for the legacy evaluation family';
  end if;

  archive_oid := lo_from_bytea(0, convert_to(payload, 'UTF8'));
  if archive_oid = 0 then
    raise exception 'archive: could not write the legacy evaluation archive to a large object';
  end if;
  select coalesce(sum(length(data)), 0) into archive_bytes from pg_largeobject where loid = archive_oid;
  if archive_bytes <> length(convert_to(payload, 'UTF8')) then
    raise exception 'archive: the large object holds % byte(s), the archive is %', archive_bytes, length(payload);
  end if;
  execute format('comment on large object %s is %L', archive_oid,
    'zz legacy evaluation archive — rubric, rubric_dimension, eval, eval_subject, eval_score, '
    'eval_protocol, eval_evaluator, eval_evidence_snapshot, eval_subject_version and the '
    'eval_finding rows with an eval_id, as pg_dump --data-only writes them. Written by '
    'services/gateway/migrations/002_catalog_evaluation.sql; kept in the database so it travels '
    'in the deployment''s own pg_dump backup and never reaches a team shelf.');

  -- Leave no readable dump behind in the container's /tmp: the archive is the large object.
  execute format('copy (select '''' where false) to program %L', ': > ' || scratch);
end $$;

-- Deleted second, explicitly, and only after the archive carries them. Eleven rows on the 0.27
-- backup; a row here with no archive above would be a row this migration destroys silently.
delete from zz.eval_finding where eval_id is not null;

do $$
declare n bigint;
begin
  select count(*) into n from zz.eval_finding where eval_id is not null;
  if n > 0 then
    raise exception 'eval_finding: % row(s) still carry an eval_id after the delete', n;
  end if;
end $$;

-- ---------------------------------------------------------------------------------------------
-- (a) `skill`: the catalog is `flow is null` or it is not; `skill_asset` is the file tree.
-- ---------------------------------------------------------------------------------------------

alter table zz.skill drop constraint skill_belongs_correctly;
alter table zz.skill drop column kind;
alter table zz.skill drop column ordinal;

drop table zz.skill_asset;

-- `unique (skill_id, id)` is what `plugin_version_skill`'s composite key below points at: a
-- binding names a skill version of the skill the binding's own key names. The content-hash check
-- is `not valid`: the 198 legacy values keep whatever format they were written in, and a subject
-- digest depends on them, so the rule binds every later insert and no existing row.
alter table zz.skill_version add constraint skill_version_skill_id_id_key unique (skill_id, id);
alter table zz.skill_version
  add constraint skill_version_content_hash_check check (content_hash ~ '^[0-9a-f]{64}$') not valid;

-- `door` was never constrained; every value in the backup is one of the three.
alter table zz.plugin_tool
  add constraint plugin_tool_door_check check (door = any (array['core','eval','manage']));

-- ---------------------------------------------------------------------------------------------
-- (b) `plugin`: ownership is a relation and a team reference, not a text column and a jsonb list.
-- ---------------------------------------------------------------------------------------------

create table zz.plugin_release_owner (
    plugin_id uuid not null,
    team_id uuid not null,
    constraint plugin_release_owner_pkey primary key (plugin_id, team_id),
    constraint plugin_release_owner_plugin_id_fkey foreign key (plugin_id) references zz.plugin(id) on delete cascade,
    constraint plugin_release_owner_team_id_fkey foreign key (team_id) references zz.team(id)
);

alter table zz.plugin add column owner_team_id uuid;

-- The team, from the slug that is already there. A plugin naming a slug no team has keeps
-- `owner_team_id` null, exactly as it kept the unresolvable text.
update zz.plugin p set owner_team_id = t.id from zz.team t where t.slug = p.owner_team;

-- `release_owners` jsonb -> rows. Every slug must resolve: a plugin whose owner list named a team
-- the platform does not have would silently lose a release owner, which is an authority, not a
-- label.
do $$
declare n int;
begin
  select count(*) into n
    from zz.plugin p
    cross join lateral jsonb_array_elements_text(p.release_owners) as s(slug)
   where not exists (select 1 from zz.team t where t.slug = s.slug);
  if n > 0 then
    raise exception 'plugin: % release_owners entr(ies) name a team slug no team has', n;
  end if;
end $$;

insert into zz.plugin_release_owner (plugin_id, team_id)
select p.id, t.id
  from zz.plugin p
  cross join lateral jsonb_array_elements_text(p.release_owners) as s(slug)
  join zz.team t on t.slug = s.slug
 group by p.id, t.id;

alter table zz.plugin drop column owner_team;
alter table zz.plugin drop column evolvable;
alter table zz.plugin drop column release_owners;

alter table zz.plugin
  add constraint plugin_owner_team_id_fkey foreign key (owner_team_id) references zz.team(id);

-- ---------------------------------------------------------------------------------------------
-- (c) `plugin_version`: the one release identity, with the source a third-party capture names.
-- ---------------------------------------------------------------------------------------------
--
-- The four source columns come from `eval_subject_version`: `component_manifest` and
-- `source_locator` as they stand, and `tree_digest`/`resolved_commit`, which only ever lived
-- inside `release_identity` jsonb (`release_identity->>'tree_digest'`, `->>'resolved_commit'`).
-- Null for a catalog release, set for a third-party capture. `released_at` is the moment the
-- version was registered — `captured_at` for the rows that have a capture, and the migration's
-- own `now()` for the catalog releases that predate `eval_subject_version`.

alter table zz.plugin_version add column released_at timestamp with time zone not null default now();
alter table zz.plugin_version add column component_manifest jsonb;
alter table zz.plugin_version add column source_locator jsonb;
alter table zz.plugin_version add column tree_digest text;
alter table zz.plugin_version add column resolved_commit text;

-- The newest capture of each (plugin, version) is the one that stands: `subject.ts` reads a
-- capture back with `order by captured_at desc limit 1`, and a version registered twice with the
-- same content digest differs only in when it was captured.
update zz.plugin_version pv
   set released_at = sv.captured_at,
       component_manifest = sv.component_manifest,
       source_locator = sv.source_locator,
       tree_digest = sv.release_identity->>'tree_digest',
       resolved_commit = sv.release_identity->>'resolved_commit'
  from (
        select distinct on (plugin_id, declared_version)
               plugin_id, declared_version, captured_at, component_manifest, source_locator, release_identity
          from zz.eval_subject_version
         order by plugin_id, declared_version, captured_at desc
       ) sv
 where sv.plugin_id = pv.plugin_id and sv.declared_version = pv.version;

alter table zz.plugin_version drop constraint plugin_version_rubric_id_fkey;
alter table zz.plugin_version drop column rubric_id;

-- ---------------------------------------------------------------------------------------------
-- (d) `plugin_version_skill`: one version per skill per plugin version.
-- ---------------------------------------------------------------------------------------------
--
-- The old key was `(plugin_version_id, skill_version_id)`, so a plugin version could bind two
-- versions of one skill — five such pairs in the backup. The later binding of each is deleted and
-- the earlier `released_at` is kept, which is the version the release actually shipped.

delete from zz.plugin_version_skill pvs
 where exists (
   select 1
     from zz.plugin_version_skill keep
     join zz.skill_version ksv on ksv.id = keep.skill_version_id
     join zz.skill_version sv on sv.id = pvs.skill_version_id
    where keep.plugin_version_id = pvs.plugin_version_id
      and ksv.skill_id = sv.skill_id
      and keep.skill_version_id <> pvs.skill_version_id
      and (ksv.released_at, ksv.id) < (sv.released_at, sv.id));

alter table zz.plugin_version_skill add column skill_id uuid;
update zz.plugin_version_skill pvs
   set skill_id = sv.skill_id
  from zz.skill_version sv
 where sv.id = pvs.skill_version_id;
alter table zz.plugin_version_skill alter column skill_id set not null;

alter table zz.plugin_version_skill drop constraint plugin_version_skill_pkey;
alter table zz.plugin_version_skill drop constraint plugin_version_skill_skill_version_id_fkey;
alter table zz.plugin_version_skill
  add constraint plugin_version_skill_pkey primary key (plugin_version_id, skill_id);
alter table zz.plugin_version_skill
  add constraint plugin_version_skill_skill_id_skill_version_id_fkey
  foreign key (skill_id, skill_version_id) references zz.skill_version(skill_id, id);

-- The three `*_subject_version_id` columns a surviving table keeps: the legacy id collapses onto
-- the `plugin_version` row that names the same plugin and the same version, so every value is
-- repointed rather than renumbered.
alter table zz.candidate
  add constraint candidate_base_subject_version_id_fkey
  foreign key (base_subject_version_id) references zz.plugin_version(id);
alter table zz.release_attempt
  add constraint release_attempt_base_subject_version_id_fkey
  foreign key (base_subject_version_id) references zz.plugin_version(id);
alter table zz.release_attempt
  add constraint release_attempt_released_subject_version_id_fkey
  foreign key (released_subject_version_id) references zz.plugin_version(id);

update zz.candidate c
   set base_subject_version_id = pv.id
  from zz.eval_subject_version sv
  join zz.plugin_version pv on pv.plugin_id = sv.plugin_id and pv.version = sv.declared_version
 where sv.id = c.base_subject_version_id;

update zz.release_attempt r
   set base_subject_version_id = pv.id
  from zz.eval_subject_version sv
  join zz.plugin_version pv on pv.plugin_id = sv.plugin_id and pv.version = sv.declared_version
 where sv.id = r.base_subject_version_id;

update zz.release_attempt r
   set released_subject_version_id = pv.id
  from zz.eval_subject_version sv
  join zz.plugin_version pv on pv.plugin_id = sv.plugin_id and pv.version = sv.declared_version
 where sv.id = r.released_subject_version_id;

do $$
declare n bigint;
begin
  select count(*) into n from zz.candidate c
   where c.base_subject_version_id is not null
     and not exists (select 1 from zz.plugin_version pv where pv.id = c.base_subject_version_id);
  if n > 0 then
    raise exception 'candidate: % base_subject_version_id value(s) do not name a plugin_version', n;
  end if;
  select count(*) into n from zz.release_attempt r
   where (r.base_subject_version_id is not null
          and not exists (select 1 from zz.plugin_version pv where pv.id = r.base_subject_version_id))
      or (r.released_subject_version_id is not null
          and not exists (select 1 from zz.plugin_version pv where pv.id = r.released_subject_version_id));
  if n > 0 then
    raise exception 'release_attempt: % subject-version value(s) do not name a plugin_version', n;
  end if;
end $$;

-- ---------------------------------------------------------------------------------------------
-- (e) The protocol family: the two headers fold onto the version, and one jsonb becomes rows.
-- ---------------------------------------------------------------------------------------------

-- `eval_protocol` was a header with no fact of its own — a plugin and a key — so both move onto
-- the version. `plugin_id` + `protocol_key` + `version` is then the identity `unique
-- (plugin_id, version)` names.
alter table zz.eval_protocol_version add column plugin_id uuid;
alter table zz.eval_protocol_version add column protocol_key text;
update zz.eval_protocol_version epv
   set plugin_id = ep.plugin_id, protocol_key = ep.protocol_key
  from zz.eval_protocol ep
 where ep.id = epv.protocol_id;

do $$
declare n bigint;
begin
  select count(*) into n from zz.eval_protocol_version where plugin_id is null or protocol_key is null;
  if n > 0 then
    raise exception 'eval_protocol_version: % row(s) resolve no eval_protocol header', n;
  end if;
end $$;

alter table zz.eval_protocol_version alter column plugin_id set not null;
alter table zz.eval_protocol_version alter column protocol_key set not null;
alter table zz.eval_protocol_version drop constraint eval_protocol_version_protocol_id_version_key;
alter table zz.eval_protocol_version drop column protocol_id;
alter table zz.eval_protocol_version drop column subject_compatibility;
alter table zz.eval_protocol_version drop column suites;
-- `failure_taxonomy` is read once more, in (f), where it becomes `eval_protocol_failure_mode`.
alter table zz.eval_protocol_version
  add constraint eval_protocol_version_plugin_id_version_key unique (plugin_id, version);
alter table zz.eval_protocol_version
  add constraint eval_protocol_version_plugin_id_fkey foreign key (plugin_id) references zz.plugin(id);

-- `observable_surfaces` was jsonb holding a JSON array of strings; it is a text array. Filled
-- through a second column rather than an `alter column … type … using`, because PostgreSQL
-- refuses a subquery in a transform expression and the element order is the array's own.
alter table zz.eval_protocol_version add column observable_surfaces_text text[];
update zz.eval_protocol_version epv
   set observable_surfaces_text = (
         select array_agg(v order by ord)
           from jsonb_array_elements_text(epv.observable_surfaces) with ordinality as t(v, ord));
alter table zz.eval_protocol_version alter column observable_surfaces_text set not null;
alter table zz.eval_protocol_version drop column observable_surfaces;
alter table zz.eval_protocol_version rename column observable_surfaces_text to observable_surfaces;

-- The affirmation: who approved which document, and who recorded the version at all. Neither is
-- a guess — `protocol_affirm` and `protocol_record` each wrote one `zz.eval_idempotency` row
-- naming this version as their result, and those two rows carry the principal and the moment.
alter table zz.eval_protocol_version add column approved_doc_id uuid;
alter table zz.eval_protocol_version add column affirmed_by uuid;
alter table zz.eval_protocol_version add column affirmed_at timestamp with time zone;
alter table zz.eval_protocol_version add column recorded_by uuid;

update zz.eval_protocol_version epv
   set approved_doc_id = d.id
  from zz.doc d
 where (d.initiative || '/' || d.path) = epv.approved_document_path;

update zz.eval_protocol_version epv
   set affirmed_by = p.id, affirmed_at = i.created_at
  from zz.eval_idempotency i
  join zz.principal p on p.email = i.principal
 where i.tool = 'protocol_affirm' and i.result_table = 'zz.eval_protocol_version' and i.result_id = epv.id;

update zz.eval_protocol_version epv
   set recorded_by = p.id
  from zz.eval_idempotency i
  join zz.principal p on p.email = i.principal
 where i.tool = 'protocol_record' and i.result_table = 'zz.eval_protocol_version' and i.result_id = epv.id;

do $$
declare n bigint;
begin
  select count(*) into n from zz.eval_protocol_version
   where approved_document_path is not null and approved_doc_id is null;
  if n > 0 then
    raise exception 'eval_protocol_version: % affirmative(s) name a document that is not in zz.doc', n;
  end if;
  select count(*) into n from zz.eval_protocol_version where recorded_by is null;
  if n > 0 then
    raise exception 'eval_protocol_version: % row(s) resolve no recorder in the idempotency ledger', n;
  end if;
  select count(*) into n from zz.eval_protocol_version
   where (approved_doc_id is null) <> (affirmed_by is null)
      or (approved_doc_id is null) <> (affirmed_at is null);
  if n > 0 then
    raise exception 'eval_protocol_version: % row(s) disagree about whether they are affirmed', n;
  end if;
end $$;

alter table zz.eval_protocol_version drop column approved_document_path;
alter table zz.eval_protocol_version alter column recorded_by set not null;

alter table zz.eval_protocol_version
  add constraint eval_protocol_version_approved_doc_id_fkey foreign key (approved_doc_id) references zz.doc(id);
alter table zz.eval_protocol_version
  add constraint eval_protocol_version_affirmed_by_fkey foreign key (affirmed_by) references zz.principal(id);
alter table zz.eval_protocol_version
  add constraint eval_protocol_version_recorded_by_fkey foreign key (recorded_by) references zz.principal(id);
alter table zz.eval_protocol_version
  add constraint eval_protocol_version_affirmation_check
  check ((approved_doc_id is null) = (affirmed_by is null) and (approved_doc_id is null) = (affirmed_at is null));

-- `eval_dimension`: `name` said nothing `key` does not, and the two composite keys below are what
-- `eval_measure` and `eval_run_dimension` point at.
alter table zz.eval_dimension drop column name;
alter table zz.eval_dimension
  add constraint eval_dimension_protocol_version_id_key_key unique (protocol_version_id, key);
alter table zz.eval_dimension
  add constraint eval_dimension_id_protocol_version_id_key unique (id, protocol_version_id);
alter table zz.eval_dimension
  add constraint eval_dimension_weight_check check (weight >= 0 and weight <= 1);

-- `eval_measure`: `suite` is gone, `protocol_version_id` is the dimension's own, `fact_key` is
-- the dotted path a deterministic/outcome measure reads, and `subject_kind` is what the measure
-- is about. The two biconditional checks hold on every row in the backup.
alter table zz.eval_measure add column protocol_version_id uuid;
alter table zz.eval_measure add column fact_key text;
alter table zz.eval_measure add column subject_kind text;
alter table zz.eval_measure add column guardrail_threshold numeric;

update zz.eval_measure m
   set protocol_version_id = d.protocol_version_id,
       fact_key = m.definition->>'factPath',
       subject_kind = m.definition->>'subjectKind'
  from zz.eval_dimension d
 where d.id = m.dimension_id;

do $$
declare n bigint;
begin
  select count(*) into n from zz.eval_measure where protocol_version_id is null;
  if n > 0 then
    raise exception 'eval_measure: % row(s) resolve no dimension', n;
  end if;
  select count(*) into n from zz.eval_measure
   where (evaluator_type in ('deterministic','outcome')) <> (fact_key is not null);
  if n > 0 then
    raise exception 'eval_measure: % row(s) disagree about whether they read a fact', n;
  end if;
  select count(*) into n from zz.eval_measure
   where (evaluator_type in ('bounded_semantic','generative_critic')) <> (evaluator_version_id is not null);
  if n > 0 then
    raise exception 'eval_measure: % model-backed row(s) name no evaluator version', n;
  end if;
end $$;

alter table zz.eval_measure drop constraint eval_measure_suite_check;
alter table zz.eval_measure drop column suite;
alter table zz.eval_measure alter column protocol_version_id set not null;
alter table zz.eval_measure
  add constraint eval_measure_protocol_version_id_key_key unique (protocol_version_id, key);
alter table zz.eval_measure
  add constraint eval_measure_dimension_id_protocol_version_id_fkey
  foreign key (dimension_id, protocol_version_id) references zz.eval_dimension(id, protocol_version_id);
alter table zz.eval_measure
  add constraint eval_measure_fact_key_check
  check ((evaluator_type in ('deterministic','outcome')) = (fact_key is not null));
alter table zz.eval_measure
  add constraint eval_measure_evaluator_version_check
  check ((evaluator_type in ('bounded_semantic','generative_critic')) = (evaluator_version_id is not null));

-- `eval_evaluator_version`: `stable_key` is the evaluator's identity and lives on its version,
-- `polarity` jsonb becomes the one answer that counts as positive, and `model_policy` is gone.
alter table zz.eval_evaluator_version add column stable_key text;
update zz.eval_evaluator_version ev
   set stable_key = e.stable_key
  from zz.eval_evaluator e
 where e.id = ev.evaluator_id;

do $$
declare n bigint;
begin
  select count(*) into n from zz.eval_evaluator_version where stable_key is null;
  if n > 0 then
    raise exception 'eval_evaluator_version: % row(s) resolve no evaluator', n;
  end if;
end $$;

alter table zz.eval_evaluator_version alter column stable_key set not null;
alter table zz.eval_evaluator_version drop constraint eval_evaluator_version_evaluator_id_version_key;
alter table zz.eval_evaluator_version drop column evaluator_id;
-- `{}` — one evaluator in the backup named no positive answer at all — becomes NULL rather than a
-- made-up one, so the column is nullable where the jsonb it came from was not.
alter table zz.eval_evaluator_version alter column polarity drop not null;
alter table zz.eval_evaluator_version
  alter column polarity type text using (polarity->>'good_when');
alter table zz.eval_evaluator_version rename column polarity to positive_answer;
alter table zz.eval_evaluator_version drop column model_policy;
alter table zz.eval_evaluator_version
  add constraint eval_evaluator_version_stable_key_version_key unique (stable_key, version);
alter table zz.eval_evaluator_version
  add constraint eval_evaluator_version_stable_key_content_digest_key unique (stable_key, content_digest);

-- `eval_evaluator_qualification` is about a measure, not an evaluator: the evaluator version and
-- the protocol version are both reachable through `measure_id`, and `subject_scope` said only
-- what the measure already says. `qualified_by` comes from the `evaluator_qualify` ledger row
-- that wrote this qualification.
alter table zz.eval_evaluator_qualification add column measure_id uuid;
alter table zz.eval_evaluator_qualification add column qualified_by uuid;

-- The measure this qualification was run for: the one measure of this protocol version that
-- defers to this evaluator version. `evaluator_qualify` refuses a measure key two dimensions
-- share, so there is at most one.
update zz.eval_evaluator_qualification q
   set measure_id = m.id
  from zz.eval_measure m
  join zz.eval_dimension d on d.id = m.dimension_id
 where m.evaluator_version_id = q.evaluator_version_id
   and d.protocol_version_id = q.protocol_version_id;

update zz.eval_evaluator_qualification q
   set qualified_by = p.id
  from zz.eval_idempotency i
  join zz.principal p on p.email = i.principal
 where i.tool = 'evaluator_qualify' and i.result_table = 'zz.eval_evaluator_qualification' and i.result_id = q.id;

do $$
declare n bigint;
begin
  select count(*) into n from zz.eval_evaluator_qualification where measure_id is null;
  if n > 0 then
    raise exception 'eval_evaluator_qualification: % row(s) resolve no measure', n;
  end if;
  select count(*) into n from zz.eval_evaluator_qualification where qualified_by is null;
  if n > 0 then
    raise exception 'eval_evaluator_qualification: % row(s) resolve no qualifier in the idempotency ledger', n;
  end if;
end $$;

alter table zz.eval_evaluator_qualification alter column measure_id set not null;
alter table zz.eval_evaluator_qualification alter column qualified_by set not null;
alter table zz.eval_evaluator_qualification drop constraint eval_evaluator_qualification_evaluator_version_id_fkey;
alter table zz.eval_evaluator_qualification drop constraint eval_evaluator_qualification_protocol_version_id_fkey;
alter table zz.eval_evaluator_qualification drop column evaluator_version_id;
alter table zz.eval_evaluator_qualification drop column protocol_version_id;
alter table zz.eval_evaluator_qualification drop column subject_scope;
alter table zz.eval_evaluator_qualification
  add constraint eval_evaluator_qualification_measure_id_fkey foreign key (measure_id) references zz.eval_measure(id);
alter table zz.eval_evaluator_qualification
  add constraint eval_evaluator_qualification_qualified_by_fkey foreign key (qualified_by) references zz.principal(id);
create index eval_evaluator_qualification_measure_id_qualified_at_idx
  on zz.eval_evaluator_qualification using btree (measure_id, qualified_at desc);

-- `eval_observation_snapshot`: the release it observed is a `plugin_version`, and the three jsonb
-- bags collapse into the columns `evaluation_score`'s coverage floor and `plugin_profile` read.
alter table zz.eval_observation_snapshot add column plugin_version_id uuid;
alter table zz.eval_observation_snapshot add column window_from timestamp with time zone;
alter table zz.eval_observation_snapshot add column window_to timestamp with time zone;
alter table zz.eval_observation_snapshot add column surface_observed integer;
alter table zz.eval_observation_snapshot add column surface_total integer;
alter table zz.eval_observation_snapshot add column surface_source text;
alter table zz.eval_observation_snapshot add column platform_version text;
alter table zz.eval_observation_snapshot add column recorded_by uuid;

-- `plugin_profile` records the window it resolved, and records `{from: infinity, to: -infinity}`
-- when it resolved none at all (`observe.ts:96`) — an inverted sentinel, not a window. That pair
-- becomes NULL here rather than a window this migration invents: `window_from <= window_to` is a
-- real check, and one row in the backup (b91c3da8, 0 usable runs, 0 total) has no window to make
-- it true. A `notice` names it, so an operator reading the migration's own log sees which.
do $$
declare n bigint;
begin
  select count(*) into n
    from zz.eval_observation_snapshot
   where (production_window->'resolved'->>'from')::timestamp with time zone
         > (production_window->'resolved'->>'to')::timestamp with time zone;
  if n > 0 then
    raise notice 'eval_observation_snapshot: % snapshot(s) resolved no window and keep NULL window_from/window_to', n;
  end if;
end $$;

update zz.eval_observation_snapshot os
   set plugin_version_id = pv.id,
       window_from = case
         when (os.production_window->'resolved'->>'from')::timestamp with time zone
              <= (os.production_window->'resolved'->>'to')::timestamp with time zone
         then (os.production_window->'resolved'->>'from')::timestamp with time zone end,
       window_to = case
         when (os.production_window->'resolved'->>'from')::timestamp with time zone
              <= (os.production_window->'resolved'->>'to')::timestamp with time zone
         then (os.production_window->'resolved'->>'to')::timestamp with time zone end,
       surface_observed = (os.coverage->'surface'->>'observed')::integer,
       surface_total = (os.coverage->'surface'->>'total')::integer,
       surface_source = os.coverage->'surface'->>'source',
       platform_version = os.runtime_identity->'service_versions'->>'zz-core'
  from zz.eval_subject_version sv
  join zz.plugin_version pv on pv.plugin_id = sv.plugin_id and pv.version = sv.declared_version
 where sv.id = os.subject_version_id;

update zz.eval_observation_snapshot os
   set recorded_by = p.id
  from zz.eval_idempotency i
  join zz.principal p on p.email = i.principal
 where i.tool = 'plugin_profile' and i.result_table = 'zz.eval_observation_snapshot' and i.result_id = os.id;

do $$
declare n bigint;
begin
  select count(*) into n from zz.eval_observation_snapshot
   where plugin_version_id is null
      or surface_observed is null or surface_total is null or platform_version is null;
  if n > 0 then
    raise exception 'eval_observation_snapshot: % row(s) do not resolve a release, a surface and a platform version', n;
  end if;
  select count(*) into n from zz.eval_observation_snapshot where recorded_by is null;
  if n > 0 then
    raise exception 'eval_observation_snapshot: % row(s) resolve no recorder in the idempotency ledger', n;
  end if;
end $$;

alter table zz.eval_observation_snapshot alter column plugin_version_id set not null;
alter table zz.eval_observation_snapshot alter column surface_observed set not null;
alter table zz.eval_observation_snapshot alter column surface_total set not null;
alter table zz.eval_observation_snapshot alter column platform_version set not null;
alter table zz.eval_observation_snapshot alter column recorded_by set not null;
alter table zz.eval_observation_snapshot drop column production_window;
alter table zz.eval_observation_snapshot drop column coverage;
alter table zz.eval_observation_snapshot drop column runtime_identity;
alter table zz.eval_observation_snapshot drop column environment_digest;
alter table zz.eval_observation_snapshot
  add constraint eval_observation_snapshot_plugin_version_id_fkey foreign key (plugin_version_id) references zz.plugin_version(id);
alter table zz.eval_observation_snapshot
  add constraint eval_observation_snapshot_recorded_by_fkey foreign key (recorded_by) references zz.principal(id);
alter table zz.eval_observation_snapshot
  add constraint eval_observation_snapshot_window_check check (window_from <= window_to);
alter table zz.eval_observation_snapshot
  add constraint eval_observation_snapshot_run_count_check check (usable_run_count <= total_run_count);

-- ---------------------------------------------------------------------------------------------
-- (f) Failure modes: an identity per stable key, and a sighting per discovery.
-- ---------------------------------------------------------------------------------------------
--
-- `eval_failure_mode_candidate` was two things in one row: the failure mode — `(plugin_id,
-- stable_key)` — and the finding of it in one snapshot. The identity keeps `(plugin_id,
-- stable_key)`; each candidate row becomes one sighting carrying its own prevalence, owner and
-- evidence. A candidate that was merged into another keeps its row, and the identity it belongs
-- to is its merge target's — which is what `merged_into_id` said all along. `discovery_key` is
-- the key the sighting was discovered under.

create table zz.eval_failure_mode (
    id uuid default gen_random_uuid() not null,
    plugin_id uuid not null,
    stable_key text not null,
    description text not null,
    created_at timestamp with time zone not null,
    constraint eval_failure_mode_pkey primary key (id),
    constraint eval_failure_mode_plugin_id_stable_key_key unique (plugin_id, stable_key),
    constraint eval_failure_mode_plugin_id_fkey foreign key (plugin_id) references zz.plugin(id)
);

insert into zz.eval_failure_mode (plugin_id, stable_key, description, created_at)
select pv.plugin_id,
       coalesce(t.stable_key, c.stable_key),
       (array_agg(c.description order by c.created_at))[1],
       min(c.created_at)
  from zz.eval_failure_mode_candidate c
  join zz.eval_observation_snapshot os on os.id = c.observation_snapshot_id
  join zz.eval_subject_version sv on sv.id = os.subject_version_id
  join zz.plugin_version pv on pv.plugin_id = sv.plugin_id and pv.version = sv.declared_version
  left join zz.eval_failure_mode_candidate t on t.id = c.merged_into_id
 group by pv.plugin_id, coalesce(t.stable_key, c.stable_key);

create table zz.eval_failure_mode_sighting (
    id uuid default gen_random_uuid() not null,
    failure_mode_id uuid not null,
    observation_snapshot_id uuid not null,
    description text not null,
    prevalence_numerator integer not null,
    prevalence_denominator integer not null,
    owner_kind text not null,
    owner_ref text,
    ownership_reason text,
    confidence numeric,
    assessment_id bigint,
    description_model_call_id bigint,
    evidence_refs jsonb not null,
    discovered_by uuid,
    discovery_key text,
    created_at timestamp with time zone not null,
    constraint eval_failure_mode_sighting_pkey primary key (id),
    constraint eval_failure_mode_sighting_failure_mode_id_fkey foreign key (failure_mode_id) references zz.eval_failure_mode(id),
    constraint eval_failure_mode_sighting_observation_snapshot_id_fkey foreign key (observation_snapshot_id) references zz.eval_observation_snapshot(id),
    constraint eval_failure_mode_sighting_assessment_id_fkey foreign key (assessment_id) references zz.assessment(id),
    constraint eval_failure_mode_sighting_description_model_call_id_fkey foreign key (description_model_call_id) references zz.model_call(id),
    constraint eval_failure_mode_sighting_discovered_by_fkey foreign key (discovered_by) references zz.principal(id),
    constraint eval_failure_mode_sighting_owner_kind_check check (owner_kind = any (array['plugin','dependency','platform','environment','user_input','unknown'])),
    constraint eval_failure_mode_sighting_prevalence_check check (prevalence_numerator <= prevalence_denominator)
);

-- The candidate's own id is the sighting's: it is one row of one discovery, and keeping the id is
-- what lets a reader follow a candidate it recorded before this migration to the sighting it
-- became.
insert into zz.eval_failure_mode_sighting
  (id, failure_mode_id, observation_snapshot_id, description, prevalence_numerator,
   prevalence_denominator, owner_kind, owner_ref, ownership_reason, confidence, evidence_refs,
   discovered_by, discovery_key, created_at)
select c.id,
       fm.id,
       c.observation_snapshot_id,
       c.description,
       (c.prevalence->>'numerator')::integer,
       (c.prevalence->>'denominator')::integer,
       c.owner_kind,
       nullif((select e->>'owner_ref' from jsonb_array_elements(c.evidence_refs) e where e->>'kind' = 'ownership' limit 1), ''),
       (select e->>'reason' from jsonb_array_elements(c.evidence_refs) e where e->>'kind' = 'ownership' limit 1),
       c.confidence,
       c.evidence_refs,
       (select p.id from zz.principal p
         where p.email = (select e->>'principal' from jsonb_array_elements(c.evidence_refs) e
                           where e->>'kind' = 'discovery_run' limit 1)),
       coalesce(t.stable_key, c.stable_key),
       c.created_at
  from zz.eval_failure_mode_candidate c
  join zz.eval_observation_snapshot os on os.id = c.observation_snapshot_id
  join zz.eval_subject_version sv on sv.id = os.subject_version_id
  join zz.plugin_version pv on pv.plugin_id = sv.plugin_id and pv.version = sv.declared_version
  left join zz.eval_failure_mode_candidate t on t.id = c.merged_into_id
  join zz.eval_failure_mode fm
    on fm.plugin_id = pv.plugin_id and fm.stable_key = coalesce(t.stable_key, c.stable_key);

do $$
declare n bigint;
begin
  select count(*) into n from zz.eval_failure_mode_candidate c
   where not exists (select 1 from zz.eval_failure_mode_sighting s where s.id = c.id);
  if n > 0 then
    raise exception 'eval_failure_mode_sighting: % candidate(s) became no sighting', n;
  end if;
  select count(*) into n from zz.eval_failure_mode_sighting where prevalence_numerator is null
                                                                  or prevalence_denominator is null;
  if n > 0 then
    raise exception 'eval_failure_mode_sighting: % row(s) carry no prevalence', n;
  end if;
end $$;

-- A protocol's failure taxonomy was a jsonb array of stable keys, some of them objects naming the
-- candidates a key folded in. It is a relation now.
create table zz.eval_protocol_failure_mode (
    protocol_version_id uuid not null,
    failure_mode_id uuid not null,
    constraint eval_protocol_failure_mode_pkey primary key (protocol_version_id, failure_mode_id),
    constraint eval_protocol_failure_mode_protocol_version_id_fkey foreign key (protocol_version_id) references zz.eval_protocol_version(id),
    constraint eval_protocol_failure_mode_failure_mode_id_fkey foreign key (failure_mode_id) references zz.eval_failure_mode(id)
);

insert into zz.eval_protocol_failure_mode (protocol_version_id, failure_mode_id)
with cand as (
  select c.id, coalesce(t.stable_key, c.stable_key) as identity_key, pv.plugin_id
    from zz.eval_failure_mode_candidate c
    join zz.eval_observation_snapshot os on os.id = c.observation_snapshot_id
    join zz.eval_subject_version sv on sv.id = os.subject_version_id
    join zz.plugin_version pv on pv.plugin_id = sv.plugin_id and pv.version = sv.declared_version
    left join zz.eval_failure_mode_candidate t on t.id = c.merged_into_id
), links as (
  select epv.id as protocol_version_id, cand.plugin_id, cand.identity_key
    from zz.eval_protocol_version epv
    cross join lateral jsonb_array_elements(epv.failure_taxonomy) el
    join cand on cand.id::text = el->>'candidateId'
  union
  select epv.id, cand.plugin_id, cand.identity_key
    from zz.eval_protocol_version epv
    cross join lateral jsonb_array_elements(epv.failure_taxonomy) el
    cross join lateral jsonb_array_elements_text(coalesce(el->'mergedCandidateIds', '[]'::jsonb)) mid
    join cand on cand.id::text = mid
   where jsonb_typeof(el) = 'object'
  union
  select epv.id, epv.plugin_id, el #>> '{}'
    from zz.eval_protocol_version epv
    cross join lateral jsonb_array_elements(epv.failure_taxonomy) el
   where jsonb_typeof(el) = 'string'
)
select l.protocol_version_id, fm.id
  from links l
  join zz.eval_failure_mode fm on fm.plugin_id = l.plugin_id and fm.stable_key = l.identity_key
 group by l.protocol_version_id, fm.id;

-- Read into the relation above; the jsonb array itself is gone.
alter table zz.eval_protocol_version drop column failure_taxonomy;

drop table zz.eval_failure_mode_candidate;

-- ---------------------------------------------------------------------------------------------
-- (g) `eval_run`: a scored run is terminal, and its per-dimension results are rows.
-- ---------------------------------------------------------------------------------------------
--
-- `run_status` is gone: `scored_at` is the terminal marker and `score_status` is what was
-- established. The subject release is the observation snapshot's own `plugin_version_id`, equal
-- to the run's `subject_version_id` in 15 of 15 rows. The team and the initiative the run was
-- opened in come from the `eval:evaluation_start` event the door wrote in the same call — the
-- first such event at or after the run was created — and `started_by` from the ledger row.

alter table zz.eval_run add column team_id uuid;
alter table zz.eval_run add column initiative_id uuid;
alter table zz.eval_run add column observation_snapshot_id uuid;
alter table zz.eval_run add column score_lower numeric;
alter table zz.eval_run add column score_upper numeric;
alter table zz.eval_run add column measure_coverage numeric;
alter table zz.eval_run add column establishment_blocked_by text[];
alter table zz.eval_run add column scorer_version text;
alter table zz.eval_run add column started_by uuid;
alter table zz.eval_run add column scored_at timestamp with time zone;

update zz.eval_run r
   set observation_snapshot_id = es.observation_snapshot_id
  from zz.eval_evidence_snapshot es
 where es.id = r.evidence_snapshot_id;

do $$
declare n bigint;
begin
  select count(*) into n from zz.eval_run where observation_snapshot_id is null;
  if n > 0 then
    raise exception 'eval_run: % row(s) resolve no evidence snapshot', n;
  end if;
  -- The subject release the run named must be the release its observation snapshot observed: a
  -- run whose two halves disagree about what was evaluated is not a run anybody may score. The
  -- two halves are compared as plugin and version, because that pair is what the collapse below
  -- merges on — 15 of 15 rows agree.
  select count(*) into n
    from zz.eval_run r
    join zz.eval_observation_snapshot os on os.id = r.observation_snapshot_id
    join zz.eval_subject_version sv1 on sv1.id = r.subject_version_id
    join zz.eval_subject_version sv2 on sv2.id = os.subject_version_id
   where (sv1.plugin_id, sv1.declared_version) <> (sv2.plugin_id, sv2.declared_version);
  if n > 0 then
    raise exception 'eval_run: % row(s) name a subject version that is not their snapshot''s release', n;
  end if;
end $$;

update zz.eval_run r
   set team_id = e.team_id, initiative_id = e.initiative_id
  from (
        select distinct on (i.result_id) i.result_id as run_id, e.team_id, e.initiative_id
          from zz.eval_idempotency i
          join zz.event e on e.tool_key = 'eval:evaluation_start'
                          and e.ts >= i.created_at
                          and e.ts < i.created_at + interval '5 seconds'
         where i.tool = 'evaluation_start' and i.result_table = 'zz.eval_run'
         order by i.result_id, e.ts
       ) e
 where e.run_id = r.id;

update zz.eval_run r
   set started_by = p.id
  from zz.eval_idempotency i
  join zz.principal p on p.email = i.principal
 where i.tool = 'evaluation_start' and i.result_table = 'zz.eval_run' and i.result_id = r.id;

update zz.eval_run r
   set scored_at = s.at
  from (select result_id, min(created_at) as at
          from zz.eval_idempotency
         where tool = 'evaluation_score' and result_table = 'zz.eval_run'
         group by result_id) s
 where s.result_id = r.id;

update zz.eval_run r
   set score_lower = (r.score_interval->>'lower')::numeric,
       score_upper = (r.score_interval->>'upper')::numeric,
       measure_coverage = (r.coverage->>'measures')::numeric,
       establishment_blocked_by = case when r.coverage ? 'establishment_blocked_by'
         then coalesce((select array_agg(v order by v)
                          from jsonb_array_elements_text(r.coverage->'establishment_blocked_by') as t(v)),
                       '{}'::text[])
         else null end;

do $$
declare n bigint;
begin
  select count(*) into n from zz.eval_run where team_id is null or started_by is null;
  if n > 0 then
    raise exception 'eval_run: % row(s) resolve no team or no starter', n;
  end if;
  -- `scored_at` marks the scored run, and a run carries a score status exactly when it has one.
  select count(*) into n from zz.eval_run
   where (scored_at is null) <> (score_status is null);
  if n > 0 then
    raise exception 'eval_run: % row(s) disagree about whether they were scored', n;
  end if;
end $$;

alter table zz.eval_run alter column team_id set not null;
alter table zz.eval_run alter column observation_snapshot_id set not null;
alter table zz.eval_run alter column started_by set not null;

alter table zz.eval_run drop constraint eval_run_run_status_check;
alter table zz.eval_run drop constraint eval_run_evidence_snapshot_id_fkey;
alter table zz.eval_run drop constraint eval_run_subject_version_id_fkey;
alter table zz.eval_run drop column subject_version_id;
alter table zz.eval_run drop column evidence_snapshot_id;
alter table zz.eval_run drop column run_status;
alter table zz.eval_run drop column score_interval;
alter table zz.eval_run drop column guardrails;
alter table zz.eval_run drop column coverage;

alter table zz.eval_run
  add constraint eval_run_observation_snapshot_id_fkey foreign key (observation_snapshot_id) references zz.eval_observation_snapshot(id);
alter table zz.eval_run
  add constraint eval_run_started_by_fkey foreign key (started_by) references zz.principal(id);
alter table zz.eval_run
  add constraint eval_run_team_id_initiative_id_fkey
  foreign key (team_id, initiative_id) references zz.initiative(team_id, id);
alter table zz.eval_run add constraint eval_run_id_protocol_version_id_key unique (id, protocol_version_id);
alter table zz.eval_run
  add constraint eval_run_scored_check check ((scored_at is null) = (score_status is null));
alter table zz.eval_run
  add constraint eval_run_overall_score_check check (overall_score >= 0 and overall_score <= 10);
create index eval_run_protocol_version_id_created_at_idx on zz.eval_run using btree (protocol_version_id, created_at desc);

-- The per-dimension results, one row per element of the jsonb snapshot that column used to hold.
-- `score` and `coverage` are both nullable: a dimension that was not applicable and a coverage
-- that was not measured have always been recorded as absent, never as zero.
create table zz.eval_run_dimension (
    eval_run_id uuid not null,
    protocol_version_id uuid not null,
    dimension_id uuid not null,
    score numeric,
    coverage numeric,
    constraint eval_run_dimension_pkey primary key (eval_run_id, dimension_id),
    constraint eval_run_dimension_eval_run_id_protocol_version_id_fkey
      foreign key (eval_run_id, protocol_version_id) references zz.eval_run(id, protocol_version_id),
    constraint eval_run_dimension_dimension_id_protocol_version_id_fkey
      foreign key (dimension_id, protocol_version_id) references zz.eval_dimension(id, protocol_version_id),
    constraint eval_run_dimension_score_check check (score >= 0 and score <= 10),
    constraint eval_run_dimension_coverage_check check (coverage >= 0 and coverage <= 1)
);

-- The jsonb snapshot is expanded here, before `eval_run.dimension_scores` is dropped above.
do $$
declare
  elements bigint;
begin
  select count(*) into elements
    from zz.eval_run er, lateral jsonb_array_elements(er.dimension_scores) e;

  insert into zz.eval_run_dimension (eval_run_id, protocol_version_id, dimension_id, score, coverage)
  select er.id, er.protocol_version_id, d.id,
         (e->>'score')::numeric, (e->>'coverage')::numeric
    from zz.eval_run er
    cross join lateral jsonb_array_elements(er.dimension_scores) e
    join zz.eval_dimension d on d.protocol_version_id = er.protocol_version_id and d.key = e->>'key';

  if (select count(*) from zz.eval_run_dimension) <> elements then
    raise exception 'eval_run_dimension: % element(s) expanded into % row(s)', elements, (select count(*) from zz.eval_run_dimension);
  end if;
end $$;

do $$
declare n bigint;
begin
  -- Every element's rendered score and coverage survive into its own row, to the last digit.
  select count(*) into n
    from zz.eval_run er
    cross join lateral jsonb_array_elements(er.dimension_scores) e
    join zz.eval_dimension d on d.protocol_version_id = er.protocol_version_id and d.key = e->>'key'
    left join zz.eval_run_dimension rd on rd.eval_run_id = er.id and rd.dimension_id = d.id
   where rd.eval_run_id is null
      or rd.score is distinct from (e->>'score')::numeric
      or rd.coverage is distinct from (e->>'coverage')::numeric;
  if n > 0 then
    raise exception 'eval_run_dimension: % row(s) do not render the score the jsonb snapshot held', n;
  end if;
end $$;

-- The jsonb snapshot is gone; every element of it is a row above, and the two proofs have run.
alter table zz.eval_run drop column dimension_scores;

-- ---------------------------------------------------------------------------------------------
-- (h) `eval_assessment`: the typed subject, and the answer as columns rather than one jsonb.
-- ---------------------------------------------------------------------------------------------
--
-- `subject_ref` was free text carrying six different shapes; the kind and the one child key the
-- kind names replace it, decided by the same rule the door's own `refKindOf` reads. A ref whose
-- kind cannot be settled fails the migration. `evaluator_version_id` is reachable through the
-- measure and is gone; `evidence_ref` named the run's own observation snapshot, which the run
-- already carries; `answer`'s four figures are columns.

alter table zz.eval_assessment add column subject_kind text;
alter table zz.eval_assessment add column run_id uuid;
alter table zz.eval_assessment add column doc_id uuid;
alter table zz.eval_assessment add column doc_revision integer;
alter table zz.eval_assessment add column knowledge_node_id uuid;
alter table zz.eval_assessment add column bug_id uuid;
alter table zz.eval_assessment add column event_id bigint;
alter table zz.eval_assessment add column value numeric;
alter table zz.eval_assessment add column raw_value jsonb;
alter table zz.eval_assessment add column numerator integer;
alter table zz.eval_assessment add column denominator integer;
alter table zz.eval_assessment add column excluded_reason text;

update zz.eval_assessment a
   set subject_kind = case
         when a.subject_ref like 'observation_snapshot:%' then 'run_level'
         when a.subject_ref ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then 'run'
         when a.subject_ref like 'bug:%' then 'bug'
         when a.subject_ref ~ '^event:[0-9]+$' then 'event'
         when a.subject_ref like '_knowledge/%' and a.subject_ref like '%.md' then 'knowledge'
         when a.subject_ref like '%.md' then 'document'
       end,
       run_id = case when a.subject_ref ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                     then a.subject_ref::uuid end,
       doc_id = (select d.id from zz.doc d
                  where a.subject_ref like '%.md' and a.subject_ref not like '_knowledge/%'
                    and (d.initiative || '/' || d.path) = a.subject_ref),
       knowledge_node_id = (select k.id from zz.knowledge_node k
                             where a.subject_ref like '_knowledge/%'
                               and k.path = replace(a.subject_ref, '_knowledge/', '')),
       bug_id = case when a.subject_ref like 'bug:%' then substring(a.subject_ref from 5)::uuid end,
       event_id = case when a.subject_ref ~ '^event:[0-9]+$' then substring(a.subject_ref from 7)::bigint end,
       value = (a.answer->>'value')::numeric,
       raw_value = a.answer->'detail'->'raw_value',
       numerator = (a.answer->'detail'->>'numerator')::integer,
       denominator = (a.answer->'detail'->>'denominator')::integer,
       excluded_reason = a.answer->>'excluded_reason';

do $$
declare n bigint;
begin
  select count(*) into n from zz.eval_assessment where subject_kind is null;
  if n > 0 then
    raise exception 'eval_assessment: % subject_ref value(s) name no kind this migration can settle', n;
  end if;
  -- Every kind but `run_level` names its subject; a row that says it judges a run, a document, a
  -- knowledge node, a bug or a call and resolves none of them is a claim with nothing behind it.
  select count(*) into n from zz.eval_assessment
   where (subject_kind = 'run' and run_id is null)
      or (subject_kind = 'document' and doc_id is null)
      or (subject_kind = 'knowledge' and knowledge_node_id is null)
      or (subject_kind = 'bug' and bug_id is null)
      or (subject_kind = 'event' and event_id is null)
      or (subject_kind = 'run_level'
          and (run_id is not null or doc_id is not null or knowledge_node_id is not null
               or bug_id is not null or event_id is not null));
  if n > 0 then
    raise exception 'eval_assessment: % row(s) name a kind but not the subject it requires', n;
  end if;
  select count(*) into n from zz.eval_assessment where (value is null) <> (excluded_reason is not null);
  if n > 0 then
    raise exception 'eval_assessment: % row(s) disagree about whether they were excluded', n;
  end if;
end $$;

alter table zz.eval_assessment alter column subject_kind set not null;
alter table zz.eval_assessment drop constraint eval_assessment_evaluator_version_id_fkey;
alter table zz.eval_assessment drop column evaluator_version_id;
alter table zz.eval_assessment drop column subject_ref;
alter table zz.eval_assessment drop column evidence_ref;
alter table zz.eval_assessment drop column answer;
alter table zz.eval_assessment drop column policy_version;
alter table zz.eval_assessment drop column resulting_action;

alter table zz.eval_assessment
  add constraint eval_assessment_run_id_fkey foreign key (run_id) references zz.skill_run(id);
alter table zz.eval_assessment
  add constraint eval_assessment_doc_id_fkey foreign key (doc_id) references zz.doc(id);
alter table zz.eval_assessment
  add constraint eval_assessment_knowledge_node_id_fkey foreign key (knowledge_node_id) references zz.knowledge_node(id);
alter table zz.eval_assessment
  add constraint eval_assessment_bug_id_fkey foreign key (bug_id) references zz.bug(id);
alter table zz.eval_assessment
  add constraint eval_assessment_event_id_fkey foreign key (event_id) references zz.event(id);

-- The kind shape: `run_level` is about the parent run's own observation snapshot and names no
-- child subject; each other kind names exactly one, and only the column its kind names.
alter table zz.eval_assessment
  add constraint eval_assessment_subject_kind_check check (
    (subject_kind = 'run_level'
       and run_id is null and doc_id is null and knowledge_node_id is null and bug_id is null and event_id is null)
    or (subject_kind = 'run'
       and run_id is not null and doc_id is null and knowledge_node_id is null and bug_id is null and event_id is null)
    or (subject_kind = 'document'
       and run_id is null and doc_id is not null and knowledge_node_id is null and bug_id is null and event_id is null)
    or (subject_kind = 'knowledge'
       and run_id is null and doc_id is null and knowledge_node_id is not null and bug_id is null and event_id is null)
    or (subject_kind = 'bug'
       and run_id is null and doc_id is null and knowledge_node_id is null and bug_id is not null and event_id is null)
    or (subject_kind = 'event'
       and run_id is null and doc_id is null and knowledge_node_id is null and bug_id is null and event_id is not null)
  );

-- One assessment per measure per subject per run. `nulls not distinct` because a `run_level` row
-- names no child subject at all, and every such row would otherwise be free to repeat.
alter table zz.eval_assessment
  add constraint eval_assessment_subject_key unique nulls not distinct
  (eval_run_id, measure_id, subject_kind, run_id, doc_id, doc_revision, knowledge_node_id, bug_id, event_id);

-- A value and a reason for its absence are exclusive: a row that carries neither, or both, says
-- nothing a reducer can read.
alter table zz.eval_assessment
  add constraint eval_assessment_value_check check ((value is null) = (excluded_reason is not null));

create index eval_assessment_eval_run_id_idx on zz.eval_assessment using btree (eval_run_id);

-- `eval_idempotency` is keyed to the principal that made the call rather than to the address it
-- was made from.
alter table zz.eval_idempotency add column principal_id uuid;
update zz.eval_idempotency i
   set principal_id = p.id
  from zz.principal p
 where p.email = i.principal;

do $$
declare n bigint;
begin
  select count(*) into n from zz.eval_idempotency where principal_id is null;
  if n > 0 then
    raise exception 'eval_idempotency: % row(s) name a principal by an address no principal has', n;
  end if;
end $$;

alter table zz.eval_idempotency alter column principal_id set not null;
alter table zz.eval_idempotency drop constraint eval_idempotency_pkey;
alter table zz.eval_idempotency drop column principal;
alter table zz.eval_idempotency
  add constraint eval_idempotency_pkey primary key (principal_id, tool, idempotency_key);
alter table zz.eval_idempotency
  add constraint eval_idempotency_principal_id_fkey foreign key (principal_id) references zz.principal(id);

-- ---------------------------------------------------------------------------------------------
-- (i) The legacy family, dropped.
-- ---------------------------------------------------------------------------------------------
--
-- Children before parents: `eval_score` and `eval_subject` both reference `eval`;
-- `rubric_dimension` references `rubric`; `eval_evidence_snapshot` references
-- `eval_subject_version`, whose other three references went with the columns above.

-- The last reference to `eval_subject_version` from a surviving table: the observation snapshot's
-- own subject column, which `eval_run`'s own release comparison above still needed.
alter table zz.eval_observation_snapshot drop constraint eval_observation_snapshot_subject_version_id_fkey;
alter table zz.eval_observation_snapshot drop column subject_version_id;

drop table zz.eval_score;
drop table zz.eval_subject;
drop table zz.eval;
drop table zz.rubric_dimension;
drop table zz.rubric;
drop table zz.eval_evidence_snapshot;
drop table zz.eval_protocol;
drop table zz.eval_evaluator;
drop table zz.eval_subject_version;
