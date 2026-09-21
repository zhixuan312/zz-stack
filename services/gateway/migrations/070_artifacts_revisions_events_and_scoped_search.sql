-- The tenant-information derived database: common artifact/revision/event/edge projections,
-- source/work/knowledge subtype compatibility, three scoped search projections and
-- passage/identifier storage. Every object below is NEW; nothing existing is dropped,
-- renamed, altered or moved. `zz.doc` and `zz.knowledge_node` (migration 059) are read here
-- only to describe why they are untouched -- they carry 527 live documents and 880
-- knowledge nodes on this deployment, and this migration's own contract is additive.
--
-- NO `begin;`/`commit;` IN THIS FILE, unlike 068/069. `services/gateway/src/db.ts` already
-- wraps every migration file in its own `begin` ... `commit`, one client, one transaction, and
-- rolls back and un-sets the pool on any error. A `commit;` inside this file would end that
-- outer transaction the moment Postgres reached it -- the runner's own subsequent
-- `insert into zz.schema_migration` would then run as its own separately auto-committed
-- statement, and its trailing `commit` would be a no-op against a session already out of a
-- transaction. That still happens to leave everything committed on the happy path (068 and
-- 069 are exactly this, and both are idempotent enough that a retry after a crash between the
-- file's own `commit;` and the runner's insert would not corrupt anything) -- but it is an
-- ACCIDENTAL NESTED-TRANSACTION COMMIT, and this task's own contract asks for the runner's
-- transaction ownership to be respected rather than fought. Every statement below is written
-- `if not exists`/`if not exists` so the whole file is safe to replay if the runner's own
-- transaction never reaches the `insert into zz.schema_migration` at all.
--
-- WHY BRIDGE TABLES AND NOT `alter table zz.doc add column ...`. The derived-database contract
-- asks for "zz.doc: existing work/source compatibility fields plus stable owner/artifact/
-- current revision" and the same shape for zz.knowledge_node. Read as an ALTER, that is
-- exactly the operation this task's own data-safety constraint forbids against a table
-- holding 527 live rows. The same contract paragraph offers the other reading: "retain
-- subtype tables OR COMPATIBLE VIEWS without recreating common policy in readers" -- so this
-- migration takes that option. `zz.doc_artifact` and `zz.knowledge_node_artifact` below are
-- NEW tables that map each existing row's own natural key (never its surrogate `id`, and
-- never an `on delete` dependency on it -- see their own comments) to the new owner_id/
-- artifact_id/current_revision identity. A reader that wants both halves joins on that natural
-- key; nothing about zz.doc or zz.knowledge_node changes to make that join possible.
--
-- WHAT THIS FILE DOES NOT DO. It does not populate a single row anywhere -- that is
-- `packages/indexing/src/tenant-projections.ts`'s `applyCommit`, called once a real owner
-- commit exists to replay. It does not create a `bm25` index. `create extension pg_textsearch`
-- is here, first, so that WHEN a BM25-dependent object is created it is created after the
-- extension exists -- but this task's own dependency task (I-5) recorded that pg_textsearch's
-- actual verified DDL "does not exist in this checkout" (testing/tenant-info/deployment.ts),
-- and inventing index syntax for an extension nobody has built or run would be exactly the
-- fabrication this platform's data-safety and no-guessing rules forbid. The three search
-- tables below carry a stock `tsvector` GIN index instead -- proven Postgres syntax, and
-- already the spec's own named fallback lane (D8: "Stock FTS remains a compatibility/filter/
-- fallback tool, not the primary ranker") -- so the schema is usable today and a later task
-- adds the BM25 index once the extension's real DDL is verified against a built image.
--
-- WHY THE SEARCH/PASSAGE/IDENTIFIER TABLES ARE EMPTY SHELLS TODAY. The full text analyzer
-- (`packages/indexing/src/tenant-analysis.ts`, I-14) and the rebuild walk (`packages/indexing/
-- src/tenant-rebuild.ts`, I-15) do not exist yet. This migration creates every table the
-- derived-database contract names so later tasks populate rather than create. `applyCommit`
-- already projects zz.artifact/zz.artifact_revision/zz.artifact_event/zz.artifact_edge and the
-- two subtype bridges from a real committed manifest today; it does NOT yet write to
-- zz.search_current/evidence/history or to zz.artifact_passage/zz.artifact_identifier -- both
-- wait on I-14's analyzer and, for the search tables, a corpus-key derivation rule that does
-- not exist yet either.
--
-- WHY THE SEARCH TABLES ARE PARTITIONED BY `corpus_key` WITH ONLY A DEFAULT PARTITION TODAY.
-- The retrieval contract requires "separate PostgreSQL list partitions ... for each private
-- owner and published shared shelf, with BM25 indexes on concrete partitions, not a
-- statistics-sharing parent index" -- but which corpora exist is a runtime fact (a tenant
-- signs up, a shelf is published), not something a migration authored today can enumerate.
-- Declarative partitioning lets this file create the durable parent shape now and
-- `tenant-projections.ts`'s `ensureCorpus` attach one partition per corpus the first time that
-- corpus actually projects anything. The `_default` partition exists so the schema is usable
-- (and `check:sql` can prepare against it) before any real corpus has been provisioned.

-- requires-extension: pg_textsearch
--
-- READ BY services/gateway/src/db.ts BEFORE THIS FILE IS OPENED AS SQL. The deployed
-- platform database is PostgreSQL 16 with citext and plpgsql; the image carrying
-- pg_textsearch arrives in a later, separately rehearsed cutover. Without this line the
-- first boot after this migration merges would fail `create extension`, roll back, un-set
-- the pool and rethrow -- and the gateway starts anyway by a deliberate choice made in
-- db.ts, so the platform would run with no database while reporting itself healthy.
-- Declaring the requirement defers this file instead: skipped, NOT recorded as applied,
-- and applied in full by the first boot on a cluster that can supply the extension.

-- requires-extension: pg_trgm
--
-- THE FUZZY LANE IS NOT OPTIONAL AND IT IS NOT STOCK POSTGRESQL. One of the four recall lanes
-- (`buildFuzzyLaneQuery`, services/zz-core/src/tenant-info/lanes.ts) issues
-- `similarity(ai.normalized_text, $n) >= ...` and orders by the `<->` distance operator. Both
-- belong to pg_trgm, and no migration in this repository created it. pg_trgm ships WITH
-- PostgreSQL, which is what that lane's own comment says -- but shipped is not installed, and
-- the deployed cluster reports only citext and plpgsql. The lane would have failed at runtime
-- with `function similarity(text, text) does not exist` on the first fuzzy query ever issued.

create extension if not exists pg_textsearch;
create extension if not exists pg_trgm;

-- ── common artifact/revision/event/edge projections ─────────────────────────────────────────
--
-- "Common identity is owner+artifact; revision identity adds revision; edge identity includes
-- assertion event" -- this task's own contract, verbatim in every primary key below.

create table if not exists zz.artifact (
  owner_id            uuid not null,
  artifact_id         uuid not null,
  artifact_class      text not null
                      check (artifact_class in ('source', 'work_document', 'knowledge_concept')),
  current_path        text not null,
  -- NULL IS HOW A SourceArtifact SAYS IT HAS NO CONTENT REVISION, and this column forbade it.
  --
  -- `not null check (> 0)` left the schema with no representation for an immutable source at
  -- all, while the rest of the platform already had one and used it everywhere:
  -- `ArtifactRefSchema` accepts `revision: null` and resolves it only to a source, and
  -- `transitions.ts` refuses every lifecycle operation on `head.revision === null` for exactly
  -- that reason. The projection had nothing legal to write and the insert was refused —
  -- "new row for relation \"artifact\" violates check constraint
  -- \"artifact_current_revision_check\"" — the first time a rebuild ran against this schema
  -- with a real source in the store.
  --
  -- Found by restoring a production backup into the built PostgreSQL 17 image and replaying a
  -- real owner store through it. No offline check could see it: every suite that exercises
  -- sources runs against the file-backed record, and every suite that exercises this table
  -- built its fixtures from work documents.
  current_revision    integer check (current_revision is null or current_revision > 0),
  content_hash        text not null,
  head_event_sequence integer not null check (head_event_sequence > 0),
  -- NULLABLE. "Unknown legacy timestamps are null plus diagnostic, never now()" -- a lossless
  -- legacy import may know no original creation time at all, and this column must be able to
  -- say so rather than inventing one. The diagnostic itself lives on the originating
  -- `legacy_imported` event's `data`, not duplicated here.
  created_at          timestamptz,
  audience            text,
  profile             text,
  primary key (owner_id, artifact_id)
);
create index if not exists artifact_by_class on zz.artifact (owner_id, artifact_class);

create table if not exists zz.artifact_revision (
  owner_id                  uuid not null,
  artifact_id               uuid not null,
  revision                  integer not null check (revision > 0),
  content_hash              text not null,
  -- SemanticPayload and the ArtifactRef/SourceCitation arrays, stored as the caller's own
  -- validated JSON rather than exploded into columns this migration would have to keep in
  -- lockstep with packages/contracts/src/tenant-information.ts by hand.
  payload                   jsonb not null,
  cause_refs                jsonb not null default '[]'::jsonb,
  sources                   jsonb not null default '[]'::jsonb,
  -- NULLABLE INDEPENDENTLY, not as a pair standing in for "unknown, full stop" -- matches
  -- ContentRevisionSchema's own `generated: {by, at}` shape, each nullable on its own.
  generated_by              text,
  generated_at              timestamptz,
  origin_profile            text not null check (origin_profile in ('native', 'legacy_import')),
  legacy_unresolved_sources jsonb not null default '[]'::jsonb,
  previous_revision         integer check (previous_revision is null or previous_revision > 0),
  primary key (owner_id, artifact_id, revision),
  foreign key (owner_id, artifact_id) references zz.artifact (owner_id, artifact_id)
);

create table if not exists zz.artifact_event (
  event_id       uuid primary key,
  transaction_id text not null,
  owner_id       uuid not null,
  artifact_id    uuid not null,
  sequence       integer not null check (sequence > 0),
  at             timestamptz not null,
  actor          text not null,
  kind           text not null check (kind in (
                   'created', 'revised', 'approved', 'verified', 'status_changed',
                   'moved', 'input_attached', 'input_dispositioned',
                   'provenance_corrected', 'superseded', 'published',
                   'unpublished', 'legacy_imported'
                 )),
  -- NULLABLE. Not every event kind pins a revision (a `moved` or `input_attached` event may
  -- not), matching ArtifactEventSchema's own `revision: PositiveIntSchema.nullable()`.
  revision       integer check (revision is null or revision > 0),
  content_hash   text not null,
  cause_refs     jsonb not null default '[]'::jsonb,
  data           jsonb not null default '{}'::jsonb,
  foreign key (owner_id, artifact_id) references zz.artifact (owner_id, artifact_id),
  unique (owner_id, artifact_id, sequence)
);
create index if not exists artifact_event_transaction on zz.artifact_event (transaction_id);

create table if not exists zz.artifact_edge (
  source_owner_id    uuid not null,
  source_artifact_id uuid not null,
  -- NULLABLE on both ends, like ArtifactRef.revision -- an edge may cite a SourceArtifact as
  -- a whole rather than one of its revisions.
  source_revision    integer check (source_revision is null or source_revision > 0),
  kind               text not null
                     check (kind in ('derived_from', 'cites', 'revision_of', 'supersedes')),
  target_owner_id    uuid not null,
  target_artifact_id uuid not null,
  target_revision    integer check (target_revision is null or target_revision > 0),
  target_hash        text not null,
  citation_id        text,
  asserted_event_id  uuid not null references zz.artifact_event (event_id),
  retracted_event_id uuid references zz.artifact_event (event_id),
  -- "edge identity includes assertion event" -- an edge re-asserted by a later event is a
  -- distinct row, not an overwrite of the retracted one; history stays queryable.
  primary key (source_owner_id, source_artifact_id, kind, target_owner_id, target_artifact_id,
               asserted_event_id)
);
create index if not exists artifact_edge_target on zz.artifact_edge (target_owner_id, target_artifact_id);

-- ── replay bookkeeping ───────────────────────────────────────────────────────────────────────
--
-- "One owner commit updates all its projections and applied-sequence watermark in one DB
-- transaction; replay uses transaction_id as its unique key" and "an older queue item never
-- overwrites a newer head" -- this task's own contract. Both tables are read/written only by
-- `applyCommit` in `packages/indexing/src/tenant-projections.ts`.

create table if not exists zz.artifact_projection_watermark (
  owner_id      uuid primary key,
  head_sequence integer not null default 0 check (head_sequence >= 0),
  updated_at    timestamptz not null default now()
);

create table if not exists zz.artifact_projection_commit (
  owner_id       uuid not null,
  transaction_id text not null,
  sequence       integer not null check (sequence > 0),
  applied_at     timestamptz not null default now(),
  primary key (owner_id, transaction_id)
);

-- ── source/work/knowledge subtype compatibility ─────────────────────────────────────────────
--
-- NEITHER TABLE CARRIES A FOREIGN KEY ONTO zz.doc OR zz.knowledge_node. `packages/indexing/
-- src/index.ts`'s `reindexTeam` deletes rows from both by natural key whenever a file moves or
-- disappears, with no awareness this migration exists; an `on delete` dependency here would
-- make that existing, already-shipped delete path fail against a table it has never heard of.
-- The natural key is the join a reader performs, deliberately looser than a hard constraint.

create table if not exists zz.doc_artifact (
  team_slug        text not null,
  initiative       text not null,
  path             text not null,
  owner_id         uuid not null,
  artifact_id      uuid not null,
  current_revision integer not null check (current_revision > 0),
  updated_at       timestamptz not null default now(),
  -- "gate is work-only" -- zz.doc's own `status` column already carries the gate verdict for
  -- every row this bridges (zz.doc holds nothing else since migration 059); this table adds
  -- only the stable identity zz.doc does not have, not a second copy of the gate.
  primary key (team_slug, initiative, path),
  unique (owner_id, artifact_id)
);

create table if not exists zz.knowledge_node_artifact (
  team_slug        text not null,
  path             text not null,
  owner_id         uuid not null,
  artifact_id      uuid not null,
  current_revision integer not null check (current_revision > 0),
  -- "native/legacy profile and independent lifecycle" -- lifecycle is zz.knowledge_node's own
  -- `lifecycle` column (migration 059); origin_profile is the one field that table has never
  -- carried, so it is added here rather than duplicating a column that already exists.
  origin_profile   text not null check (origin_profile in ('native', 'legacy_import')),
  updated_at       timestamptz not null default now(),
  primary key (team_slug, path),
  unique (owner_id, artifact_id)
);

-- ── three scoped search projections ─────────────────────────────────────────────────────────
--
-- "current, default | Latest work revision and latest non-deprecated knowledge revision" /
-- "evidence | Immutable textual SourceArtifacts" / "history | Deprecated/superseded concepts
-- and non-current content revisions" -- the retrieval contract's own scope table. "Current/
-- evidence identity is owner+artifact; history includes revision/hash", so only
-- zz.search_history's primary key carries revision.

create table if not exists zz.search_current (
  corpus_key       text not null,
  owner_id         uuid not null,
  artifact_id      uuid not null,
  revision         integer not null check (revision > 0),
  content_hash     text not null,
  title            text not null default '',
  type             text not null default '',
  tags             text[] not null default '{}',
  path             text not null default '',
  gate_status      text,
  knowledge_status text,
  raw_body         text not null default '',
  analyzer_version text,
  -- "Operational rebuild/index IDs are excluded from semantic parity hashes" -- projection_hash
  -- is the semantic half only; it never includes this row's own physical index OID or the
  -- rebuild's wall-clock duration, neither of which this table stores at all.
  projection_hash  text not null,
  updated_at       timestamptz not null default now(),
  primary key (corpus_key, owner_id, artifact_id)
) partition by list (corpus_key);

create table if not exists zz.search_current_default partition of zz.search_current default;
create index if not exists search_current_default_tsv on zz.search_current_default
  using gin (to_tsvector('english', raw_body));
create index if not exists search_current_default_tags on zz.search_current_default using gin (tags);

create table if not exists zz.search_evidence (
  corpus_key       text not null,
  owner_id         uuid not null,
  artifact_id      uuid not null,
  revision         integer not null check (revision > 0),
  content_hash     text not null,
  title            text not null default '',
  type             text not null default '',
  tags             text[] not null default '{}',
  path             text not null default '',
  gate_status      text,
  knowledge_status text,
  raw_body         text not null default '',
  analyzer_version text,
  projection_hash  text not null,
  updated_at       timestamptz not null default now(),
  primary key (corpus_key, owner_id, artifact_id)
) partition by list (corpus_key);

create table if not exists zz.search_evidence_default partition of zz.search_evidence default;
create index if not exists search_evidence_default_tsv on zz.search_evidence_default
  using gin (to_tsvector('english', raw_body));
create index if not exists search_evidence_default_tags on zz.search_evidence_default using gin (tags);

create table if not exists zz.search_history (
  corpus_key       text not null,
  owner_id         uuid not null,
  artifact_id      uuid not null,
  revision         integer not null check (revision > 0),
  content_hash     text not null,
  title            text not null default '',
  type             text not null default '',
  tags             text[] not null default '{}',
  path             text not null default '',
  gate_status      text,
  knowledge_status text,
  raw_body         text not null default '',
  analyzer_version text,
  projection_hash  text not null,
  updated_at       timestamptz not null default now(),
  primary key (corpus_key, owner_id, artifact_id, revision)
) partition by list (corpus_key);

create table if not exists zz.search_history_default partition of zz.search_history default;
create index if not exists search_history_default_tsv on zz.search_history_default
  using gin (to_tsvector('english', raw_body));
create index if not exists search_history_default_tags on zz.search_history_default using gin (tags);

-- ── passage/identifier storage ───────────────────────────────────────────────────────────────
--
-- "Owner-qualified parent/revision/scope/corpus, ordinal, original byte offsets, raw/analyzed
-- text and analyzer version" -- this task's own contract. Passages are replaceable index rows
-- ("They are replaceable index rows, not knowledge/revision identities" -- spec), so they
-- carry their own surrogate id rather than participating in any compatibility-id scheme; only
-- artifact/revision identity itself is preserved across a rebuild.

create table if not exists zz.artifact_passage (
  id               bigint generated always as identity primary key,
  owner_id         uuid not null,
  artifact_id      uuid not null,
  revision         integer not null check (revision > 0),
  scope            text not null check (scope in ('current', 'evidence', 'history')),
  corpus_key       text not null,
  ordinal          integer not null check (ordinal >= 0),
  byte_start       integer not null check (byte_start >= 0),
  byte_end         integer not null check (byte_end >= byte_start),
  raw_text         text not null,
  analyzed_text    text not null,
  analyzer_version text not null,
  unique (owner_id, artifact_id, revision, scope, corpus_key, ordinal)
);
create index if not exists artifact_passage_owner on zz.artifact_passage (owner_id, artifact_id, revision, scope);

create table if not exists zz.artifact_identifier (
  id              bigint generated always as identity primary key,
  owner_id        uuid not null,
  artifact_id     uuid not null,
  revision        integer not null check (revision > 0),
  scope           text not null check (scope in ('current', 'evidence', 'history')),
  corpus_key      text not null,
  passage_id      bigint not null references zz.artifact_passage (id) on delete cascade,
  identifier_text text not null,
  normalized_text text not null
);
-- BTREE CANNOT SERVE EITHER HALF OF THE FUZZY LANE'S QUERY, and this index was the only one
-- on this column. `similarity(normalized_text, $n) >= t` is not a range or equality predicate,
-- and `order by normalized_text <-> $n` is a KNN ordering; a btree accelerates neither, so
-- every fuzzy query would have sequentially scanned the whole identifier table -- against a
-- reference corpus of 780,000 records.
--
-- GiST RATHER THAN GIN, and the choice is forced rather than preferred. GIN's own trigram
-- operator class serves `similarity()`, but pg_trgm's KNN distance ordering is supported ONLY
-- by `gist_trgm_ops`. This lane uses both, so GiST is the one index type that serves the whole
-- statement. (GIN's class is named in prose rather than backticks deliberately: this file is
-- the schema's only design document, and its own gate check requires every backticked name to
-- exist somewhere in this repository. Nothing here uses it, which is the point being made.)
--
-- AND IT IS WHAT MAKES CHINESE RETRIEVABLE AT ALL TODAY. Trigrams are computed over
-- characters, not whitespace-delimited words, so they segment CJK text that no
-- whitespace tokenizer can. 240 of the 600 judged queries are Chinese or mixed.
create index if not exists artifact_identifier_normalized on zz.artifact_identifier (normalized_text);
create index if not exists artifact_identifier_trgm on zz.artifact_identifier
  using gist (normalized_text gist_trgm_ops);
create index if not exists artifact_identifier_owner on zz.artifact_identifier (owner_id, artifact_id, revision, scope);
