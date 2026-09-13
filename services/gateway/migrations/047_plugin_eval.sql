-- THE SUBJECT OF AN EVALUATION BECOMES A PLUGIN, which is the unit a person installs.
--
-- The platform evaluated at two levels and neither was the level it ships at. zz-skill-eval
-- scored one skill's documents; zz-block-eval measured one server's surface against its
-- contract. Both work. Neither can see the two things that decide whether a plugin is any good,
-- because both are properties of the WHOLE:
--
--   recovery -- can a flow that goes wrong at stage 4 return to stage 2 and re-ground? That is
--               a relation between stages, so no per-skill ruler contains it.
--   use      -- is a tool that is reachable, named by a skill and green on every gate check
--               ever actually CALLED? Reachability is a property of the package and is already
--               enforced at release; use is a property of the runs and nothing reads it.
--
-- A plugin is a flow's skills plus the MCP servers those skills call, installed together. So
-- the subject is one plugin at one version, and this is where that version becomes a row.
--
-- ── THIS MIGRATION IS PURELY ADDITIVE, AND THAT IS DELIBERATE ────────────────────────────
--
-- The old shape keys everything on zz.skill_version. Thirteen files query those columns, and
-- NOTHING IN THIS REPOSITORY CAN SEE A DROPPED COLUMN: SQL lives in template literals so tsc
-- cannot read it, and the gate's dropped-schema check reduces schemaColumns() to table names
-- (data-sql.mjs:175) -- its only column-level check covers /_at$/ columns that gate access.
-- Drop a column that is still queried and the build is green, the gate is green, and the
-- failure surfaces weeks later in one query for one caller.
--
-- So the drops wait for their last reader to go. This adds the new shape beside the old one;
-- the modules that own the old one are deleted in the same piece of work, and the migration
-- after this one drops the columns and tightens the new ones to NOT NULL. Two migrations
-- because the destructive half has a precondition, not because anything here is being kept
-- for compatibility -- there is no old caller to be compatible with once they are gone.

-- ── the subject ─────────────────────────────────────────────────────────────────────────

create table if not exists zz.plugin (
  id      uuid primary key default gen_random_uuid(),
  -- pluginName(flow): the catalog directory with its -flow suffix removed, which is what
  -- `claude plugin install <name>@zz-stack` takes. 'zz' is here too and is the only one not
  -- read from catalog/.
  name    text not null unique,
  -- Ours, or somebody else's. It decides what an evaluation DOES with its findings: for our
  -- own plugins they feed a change, for a third party's we assess and stop.
  origin  text not null check (origin in ('platform', 'third_party'))
);

create table if not exists zz.plugin_version (
  id         uuid primary key default gen_random_uuid(),
  plugin_id  uuid not null references zz.plugin(id),
  -- What flow.json declares. A number a person cites -- "sdlc 0.2 fixed it" -- and therefore a
  -- CLAIM, which is what the next column is for.
  version    text not null,
  -- What the plugin actually contains, from digestOfPlugin: its own files, not the shelf's, and
  -- no server URL. The pair is the point: the hash is not an alternative to the version, it is
  -- what makes the version true, and the gate refuses a release where they disagree. Exactly
  -- the argument skills.lock.json makes one level down.
  digest     text not null,
  -- The eval suite this version shipped with, or '' for none. A Delta measured against four
  -- cases and a Delta measured against one are not the same measurement, so a score has to be
  -- able to name the suite it was taken against or the series is not a series.
  cases_digest text not null default '',
  -- Which ruler judges this plugin. It hangs off the VERSION rather than the plugin so that
  -- cutting a version forces the choice -- reuse the ruler, or write a new one -- and "does
  -- this change what good means" is answered on purpose rather than by default. The same
  -- reasoning 016 gives for skill_version.rubric_id, which this replaces.
  rubric_id  uuid references zz.rubric(id),
  unique (plugin_id, version)
);

-- WHICH SKILL VERSIONS SHIPPED IN WHICH PLUGIN VERSION. Nothing recorded this, and the absence
-- was quietly expensive: zz.skill_version has no plugin column, zz.skill.flow is CURRENT
-- registration rather than per-version, and flow_install overwrites its own history on
-- reinstall. So "which version of this skill was running when this event fired" resolved to
-- whatever happened to be current at read time -- a wrong answer indistinguishable from a right
-- one. Release is the only moment anybody actually knows, so release is what writes these.
create table if not exists zz.plugin_version_skill (
  plugin_version_id uuid not null references zz.plugin_version(id) on delete cascade,
  skill_version_id  uuid not null references zz.skill_version(id),
  primary key (plugin_version_id, skill_version_id)
);

-- ── the eval tables learn the new subject ───────────────────────────────────────────────
--
-- Nullable for now, NOT NULL in the migration that drops their skill-version counterparts.
-- All five eval tables hold ZERO rows on every deployment, so nothing is being migrated here
-- and nothing will be lost when the old columns go -- worth writing down, because a future
-- reader has no other way to know a dropped column carried nothing.

alter table zz.eval         add column if not exists plugin_version_id uuid references zz.plugin_version(id);
alter table zz.eval_subject add column if not exists plugin_version_id uuid references zz.plugin_version(id);
alter table zz.rubric       add column if not exists plugin_id         uuid references zz.plugin(id);

-- AND THE OLD COLUMNS STOP BEING REQUIRED, which is the half that makes the rest of this
-- migration usable rather than decorative.
--
-- zz.eval.skill_version_id and zz.rubric.skill_id are both NOT NULL. Adding the plugin-side
-- columns beside them changes nothing on its own: the first insert naming only a plugin version
-- dies on a NOT NULL violation at RUNTIME, while the build and the whole gate stay green --
-- SQL lives in template literals, so nothing offline reads it. That is the same blind spot this
-- work has already been caught by twice, arriving a third time through the migration written to
-- avoid it.
--
-- Dropped rather than swapped because the old columns still have a reader until the modules
-- that own them are deleted. When they go, the migration after this one drops the columns
-- outright and makes the new ones NOT NULL.
alter table zz.eval   alter column skill_version_id drop not null;
alter table zz.rubric alter column skill_id         drop not null;

-- A rubric now belongs to a plugin OR a skill, so it needs the matching key. The old
-- `unique (skill_id, version)` stays and costs nothing: Postgres treats NULLs as distinct, so a
-- plugin rubric -- whose skill_id is null -- never collides on it. That is the same NULL rule
-- that made zz.run accumulate 1801 phantom rows; here it is what we want, which is worth saying
-- out loud so nobody "fixes" it later.
create unique index if not exists rubric_plugin_id_version_key on zz.rubric (plugin_id, version);

-- ── a ruler gets two kinds of dimension ─────────────────────────────────────────────────
--
-- QUALITATIVE is what a rubric_dimension has always been: a reader scores 1-5 against the two
-- ends written out above. QUANTITATIVE is new and is where the tool/LLM boundary lands in the
-- schema. A tool computes a fact -- "6 of 31 reachable tools were never called" -- and only a
-- person can say whether 6 is too many and where the line is. So the fact comes from the tool
-- and the THRESHOLD comes from the ruler, written down before any artifact is scored.
--
-- threshold_reason is not decoration. A threshold with no stated reason is a number somebody
-- can move later to make a result come out differently, and nobody would be able to tell.
alter table zz.rubric_dimension
  add column if not exists kind text not null default 'qualitative'
    check (kind in ('qualitative', 'quantitative')),
  add column if not exists threshold text not null default '',
  add column if not exists threshold_reason text not null default '';

-- ── the ablation result, RECORDED rather than read ──────────────────────────────────────
--
-- `claude plugin eval` answers the one question this platform has never asked: does installing
-- this plugin help, VERSUS NOT INSTALLING IT? Every case also runs a no-plugin arm and reports
-- the delta. A counterfactual, not a score.
--
-- But it is a CLI, it runs on the person's own machine on their own credential, and it writes
-- its results into their plugin cache. zz-core runs in a container on the host and cannot see
-- any of that -- so a tool that tried to READ the results would be a tool that returns nothing,
-- forever, for reasons no message would explain.
--
-- So the stage skill runs the command where it can be run and hands the JSON to a tool, and the
-- result lands here as a fact with a timestamp. That also fixes the question a filesystem read
-- could never answer: HOW OLD IS THIS DELTA. A stale delta presented as current is the failure
-- this table's `ran_at` exists to prevent.
--
-- cases_digest is copied in rather than joined, deliberately. It records the suite this result
-- was taken against, and a suite that changes afterwards must not silently re-label an old
-- measurement -- four cases and one case are not the same measurement.
create table if not exists zz.plugin_case_run (
  id                uuid primary key default gen_random_uuid(),
  plugin_version_id uuid not null references zz.plugin_version(id) on delete cascade,
  cases_digest      text not null default '',
  ran_at            timestamptz not null default now(),
  recorded_by       text not null default '',
  -- The command's own --json output, whole. Stored rather than summarised because the summary
  -- this platform wants today is not the only one it will want, and the run costs real money on
  -- somebody's own credential -- roughly $0.40 per case -- so throwing away everything but a
  -- mean would mean paying again to answer the next question.
  result            jsonb not null
);

create index if not exists plugin_case_run_latest
  on zz.plugin_case_run (plugin_version_id, ran_at desc);
