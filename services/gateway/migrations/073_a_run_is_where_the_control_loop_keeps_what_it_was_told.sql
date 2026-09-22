-- A run is where the control loop keeps what it was told, so it survives a restart.
--
-- WHY THIS EXISTS AT ALL. The generic host holds runs in a `Map` and hands out ids shaped
-- `${moduleId}/${sequence}` from a counter that starts at zero when the process does. That is
-- right for what it is — `createHost()` performs no I/O, which is why it can live in
-- `@zz/contracts` and why FR-23 is satisfiable at all — but an initiative spans days and
-- several deployments, and evidence recorded against it on Monday has to still be there on
-- Thursday. The kernel must not learn about Postgres; the service must not re-implement the
-- chain. So the durable half lives here and the kernel is rehydrated from it per request:
-- load the run and its evidence, build a host, register the module, replay, then ask.
--
-- The platform's run id is therefore the one that matters and the kernel's is scratch. They
-- are deliberately not the same value: making the kernel accept an injected id would put
-- persistence into the contract, which is the seam this design exists to keep.
--
-- ONE RUN PER INITIATIVE, and the unique constraint says so rather than a convention nobody
-- can check. An initiative IS one run of the flow governing it; two runs would mean two
-- answers to "may this close", which is the defect this whole adoption removes rather than
-- adds.
--
-- `module_digest` IS RECORDED, NOT LOOKED UP. A run says which body governed it, so a reader
-- of an old run is not told what the module says today. The allowlist can move; what a run
-- was judged against cannot.

create table if not exists zz.control_run (
  id            uuid primary key default gen_random_uuid(),
  team_slug     text        not null,
  initiative    text        not null,
  module_id     text        not null,
  module_digest text        not null,
  subject       text        not null,
  profile       jsonb       not null default '[]'::jsonb,
  started_at    timestamptz not null default now(),
  started_by    text,
  unique (team_slug, initiative)
);

-- EVIDENCE IS APPEND-ONLY AND ORDERED, because the engine replays it. `seq` is the order the
-- platform recorded them in, not `recorded_at`: two entries inside one transaction share a
-- timestamp, and a replay that reordered them would be judging a run that never happened.
--
-- `entry_id` is the handle the kernel's own `EvidenceEntry.id` carries, kept so a later entry
-- can be `about` an earlier one — the back-reference a completion rule follows. Without it a
-- replay would rebuild entries the rules can no longer point at.
create table if not exists zz.control_evidence (
  seq         bigserial   primary key,
  run_id      uuid        not null references zz.control_run(id) on delete cascade,
  entry_id    text        not null,
  step_id     text        not null,
  kind        text        not null,
  about       text        not null,
  note        text        not null default '',
  recorded_at timestamptz not null default now(),
  recorded_by text
);

create index if not exists control_evidence_run_seq on zz.control_evidence (run_id, seq);

-- A WAIVER DISCHARGES A REQUIREMENT AND MUST SAY ON WHAT GROUND — `ground` is NOT NULL and
-- that is the entire difference between a waiver and an exemption. An exemption is a hole
-- somebody cut; a waiver is a hole somebody signed for.
--
-- This exists because of a real and bounded situation the kernel's own comment anticipated:
-- "some requirements become permanently unsatisfiable through nobody's fault — the evidence
-- they ask for is evidence nobody will now produce". Twenty-four of this platform's
-- twenty-seven sdlc-flow initiatives never had a spec-audit or a plan-audit document. Nobody
-- is going to audit them now. The honest record is a waiver naming that fact, not a fabricated
-- audit and not a second code path that skips old initiatives.
create table if not exists zz.control_waiver (
  seq         bigserial   primary key,
  run_id      uuid        not null references zz.control_run(id) on delete cascade,
  step_id     text        not null,
  kind        text        not null,
  ground      text        not null,
  recorded_at timestamptz not null default now(),
  recorded_by text
);

create index if not exists control_waiver_run on zz.control_waiver (run_id);
