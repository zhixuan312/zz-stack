/**
 * The "projection-schema" case group: the tenant-info suite that touches the derived
 * projection database rather than only the file-backed commit engine. `scripts/
 * tenant-info/suites.ts` reserves the name "rebuild" at this path, so `verify --suite rebuild`
 * dynamic-imports it and calls `run`.
 *
 * The offline cases exercise the schema file's own text and `tenant-projections.ts`'s pure
 * logic with no database at all. `atomic_apply_*` exercises the real `applyCommit` against an
 * operator-provided isolated copy, named by `ZZ_TENANT_INFO_ISOLATED_DB_URL` and never inferred
 * from `TEAM_DB_URL`/`PLATFORM_DB_URL`.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  applyCommit, compatIdFor, connectIsolated, ensureCorpus, loadCompatibilityMap,
  saveCompatibilityMap, semanticProjectionHash,
  type ProjectionClient, type ProjectionManifest,
} from "../../packages/indexing/dist/tenant-projections.js";

import { GENERATION_CASES } from "./rebuild-generation.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
// The schema, read from `001_init.sql`. Every claim below is a claim about the schema, not
// about the migration that introduced it.
const SCHEMA_PATH = join(repoRoot, "services/gateway/migrations/001_init.sql");
const MIGRATIONS_DIR = join(repoRoot, "services/gateway/migrations");

// Offline: the compatibility-id map is stable across a reload, never reallocated

function caseCompatMapRoundTripsAndNeverReallocates(): void {
  const dir = mkdtempSync(join(tmpdir(), "zz-tenant-compat-"));
  const path = join(dir, "compat-map.json");
  try {
    const empty = loadCompatibilityMap(path); // file does not exist yet — reads as empty
    assert.deepEqual(empty, { version: 1, entries: {} });

    const owner = randomUUID();
    const artifactA = randomUUID();
    const artifactB = randomUUID();
    const first = compatIdFor(empty, owner, artifactA);
    saveCompatibilityMap(path, first.map);
    const reloaded = loadCompatibilityMap(path);
    const again = compatIdFor(reloaded, owner, artifactA);
    assert.equal(again.id, first.id, "the same owner+artifact must get back the exact id a prior run allocated");

    const second = compatIdFor(reloaded, owner, artifactB);
    assert.notEqual(second.id, first.id, "a different artifact must never share a compatibility id");
    saveCompatibilityMap(path, second.map);

    // A third load, after both ids exist — reallocating either on a later rebuild would leave an
    // external reference pointing at an id nothing holds.
    const thirdLoad = loadCompatibilityMap(path);
    assert.equal(compatIdFor(thirdLoad, owner, artifactA).id, first.id);
    assert.equal(compatIdFor(thirdLoad, owner, artifactB).id, second.id);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function caseCompatMapRejectsAnUnreadableFile(): void {
  const dir = mkdtempSync(join(tmpdir(), "zz-tenant-compat-bad-"));
  const path = join(dir, "compat-map.json");
  try {
    // Not this map's own shape at all — must be refused, not silently treated as empty, since
    // silently treating a real file as empty is exactly how every id in it would be reallocated.
    writeFileSync(path, "{\"unrelated\":true}\n");
    assert.throws(() => loadCompatibilityMap(path), /version-1 compatibility map/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Offline: the semantic parity hash excludes operational fields by construction

function caseSemanticHashExcludesOperationalFields(): void {
  const base = {
    owner_id: "11111111-1111-4111-8111-111111111111",
    artifact_id: "22222222-2222-4222-8222-222222222222",
    artifact_class: "work_document" as const,
    revision: 1,
    content_hash: "0".repeat(64),
    payload: { title: "t" },
  };
  const hashA = semanticProjectionHash(base);
  // Two rows built at different rebuild times with different physical facts attached (a
  // wall-clock duration, an index OID, a retry timestamp), none of which
  // `semanticProjectionHash`'s parameter type has a slot for, so none can be read by accident.
  const rowSeenLater = { ...base, rebuild_duration_ms: 91234, index_oid: 88213, retried_at: "2026-09-20T00:00:00Z" };
  const hashB = semanticProjectionHash(rowSeenLater);
  assert.equal(hashA, hashB, "operational facts must never change the semantic parity hash");
}

function caseSemanticHashChangesWithAnySemanticField(): void {
  const base = {
    owner_id: "11111111-1111-4111-8111-111111111111",
    artifact_id: "22222222-2222-4222-8222-222222222222",
    artifact_class: "work_document" as const,
    revision: 1,
    content_hash: "0".repeat(64),
    payload: { title: "t" },
  };
  const baseline = semanticProjectionHash(base);
  assert.notEqual(semanticProjectionHash({ ...base, revision: 2 }), baseline);
  assert.notEqual(semanticProjectionHash({ ...base, content_hash: "1".repeat(64) }), baseline);
  assert.notEqual(semanticProjectionHash({ ...base, payload: { title: "different" } }), baseline);
  assert.notEqual(semanticProjectionHash({ ...base, artifact_class: "source" }), baseline);
}

// Offline: the schema's own text

const REQUIRED_OBJECTS = [
  "zz.artifact", "zz.artifact_revision", "zz.artifact_event", "zz.artifact_edge",
  "zz.doc_artifact", "zz.knowledge_node_artifact",
  "zz.search_current", "zz.search_evidence", "zz.search_history",
  "zz.artifact_passage", "zz.artifact_identifier",
];

function schemaSource(): string {
  return readFileSync(SCHEMA_PATH, "utf8");
}

function caseMigrationCreatesEveryRequiredObject(): void {
  const sql = schemaSource();
  const missing = REQUIRED_OBJECTS.filter(
    (name) => !new RegExp(`create table ${name.replace(".", "\\.")} \\(`, "i").test(sql));
  assert.deepEqual(missing, [], `the schema is missing: ${missing.join(", ")}`);
}

function caseMigrationCarriesNoNestedTransactionControl(): void {
  // Every file in the directory, not one of them: the runner wraps every file it applies, so the
  // hazard belongs to the directory.
  const offenders: string[] = [];
  for (const f of readdirSync(MIGRATIONS_DIR).filter((x) => x.endsWith(".sql")).sort()) {
    for (const l of readFileSync(join(MIGRATIONS_DIR, f), "utf8").split("\n")) {
      const t = l.trim().toLowerCase();
      if (t === "begin;" || t === "commit;") offenders.push(`${f}: ${t}`);
    }
  }
  assert.deepEqual(offenders, [],
    "the runner in services/gateway/src/db.ts already wraps the whole file in begin/commit; " +
    "a literal begin;/commit; inside a migration would end that transaction early");
}

function caseExtensionPrecedesAnyBm25Reference(): void {
  // Both positions are found in the same stripped text, comment lines removed first, so a
  // mention of "bm25" in this file's own prose is never mistaken for the executable object.
  // Comparing an executable-text position against a full-text position finds the comment's
  // earlier mention and reports a correctly ordered bm25 index as failing.
  const executable = schemaSource().split("\n")
    .filter((line) => !line.trim().startsWith("--")).join("\n").toLowerCase();
  const extensionAt = executable.indexOf("create extension if not exists pg_textsearch");
  assert.ok(extensionAt >= 0, "the schema must create the pinned extension");
  const bm25At = executable.indexOf("bm25");
  // The schema creates no bm25-dependent object (ensureCorpus builds the per-corpus indexes),
  // so this holds vacuously; asserted so it means something the day one is added.
  if (bm25At >= 0) {
    assert.ok(bm25At > extensionAt, "CREATE EXTENSION must precede any BM25-dependent object");
  }
}

function caseMigrationIsAdditiveOnly(): void {
  // The decision, not the diff. A schema file cannot be swept for `alter table`: a pg_dump of
  // any database is full of `ALTER TABLE ONLY ... ADD CONSTRAINT`. What the sweep defended is
  // checked instead — neither zz.doc nor zz.knowledge_node carries a column pointing at an
  // artifact, and the two bridge tables are what carry the link.
  const sql = schemaSource();
  const bodyOf = (t: string): string =>
    new RegExp(`create table ${t.replace(".", "\\.")} \\(([\\s\\S]*?)\\n\\);`, "i").exec(sql)?.[1] ?? "";
  for (const t of ["zz.doc", "zz.knowledge_node"]) {
    const body = bodyOf(t);
    assert.ok(body, `${t} is not in the schema`);
    assert.ok(!/^\s+\w*artifact\w*\s/im.test(body),
      `${t} carries an artifact column — the bridge table was chosen precisely so it would not`);
  }
  for (const bridge of ["zz.doc_artifact", "zz.knowledge_node_artifact"]) {
    assert.ok(bodyOf(bridge), `${bridge} is not in the schema — the link has nowhere to live`);
  }
}

// Offline: applyCommit's own control flow, against an in-memory fake — no database at all ─
//
// The actual imported `applyCommit`, not a rewritten copy, run against a minimal in-memory
// store implementing just enough of `begin`/`commit`/`rollback` and the statements it issues:
// replay-by-transaction_id, watermark regression refusal, and rollback leaving nothing behind.
// It proves the control flow; that Postgres accepts the SQL text is what `check:sql` and
// `atomic_apply_against_isolated_database` are for.

interface FakeRow { [key: string]: unknown }

class FakeProjectionStore implements ProjectionClient {
  private readonly artifacts = new Map<string, FakeRow>();
  private readonly revisions: FakeRow[] = [];
  private readonly events: FakeRow[] = [];
  private readonly commits = new Set<string>();
  private readonly watermarks = new Map<string, number>();
  private pending: (() => void)[] | null = null;
  // Foreign-key simulation, immediate rather than deferred: a real
  // `zz.artifact_edge.asserted_event_id` foreign key is checked the moment the INSERT runs,
  // against every row already inserted earlier in the same open transaction. `durableEventIds`
  // are events from a prior committed transaction; `pendingEventIds` are added the instant an
  // insert is queued and discarded on rollback.
  private readonly durableEventIds = new Set<string>();
  private pendingEventIds = new Set<string>();
  /** Set by a test to make the next non-transaction-control call throw, simulating a fault
   *  partway through a real projection transaction. */
  public failNextWrite = false;

  async query<T = FakeRow>(text: string, params: readonly unknown[] = []): Promise<{ rows: T[] }> {
    // Whitespace-collapsed, not merely trimmed: every statement below is a multi-line template
    // literal in the real source, so a `startsWith` against the raw text never matches past the
    // table name and every insert falls through to the no-op default.
    const sql = text.trim().toLowerCase().replace(/\s+/g, " ");
    if (sql === "begin") { this.pending = []; this.pendingEventIds = new Set(); return { rows: [] as T[] }; }
    if (sql === "commit") {
      this.pending?.forEach((apply) => apply());
      for (const id of this.pendingEventIds) this.durableEventIds.add(id);
      this.pending = null;
      return { rows: [] as T[] };
    }
    if (sql === "rollback") { this.pending = null; this.pendingEventIds = new Set(); return { rows: [] as T[] }; }

    if (sql.startsWith("select 1 from zz.artifact_projection_commit")) {
      const [owner, tx] = params as [string, string];
      return { rows: (this.commits.has(`${owner}\u0000${tx}`) ? [{}] : []) as T[] };
    }
    if (sql.startsWith("select head_sequence from zz.artifact_projection_watermark")) {
      const [owner] = params as [string];
      const head = this.watermarks.get(owner);
      return { rows: (head === undefined ? [] : [{ head_sequence: head }]) as T[] };
    }
    if (this.failNextWrite) { this.failNextWrite = false; throw new Error("injected mid-transaction failure"); }

    if (sql.startsWith("insert into zz.artifact (")) {
      const [owner, artifactId] = params as [string, string];
      this.pending?.push(() => this.artifacts.set(`${owner}\u0000${artifactId}`, { owner_id: owner, artifact_id: artifactId }));
      return { rows: [] as T[] };
    }
    if (sql.startsWith("insert into zz.artifact_revision")) {
      this.pending?.push(() => this.revisions.push({ params }));
      return { rows: [] as T[] };
    }
    if (sql.startsWith("insert into zz.artifact_event")) {
      const eventId = (params as [string])[0];
      this.pendingEventIds.add(eventId); // visible to a same-transaction edge insert immediately
      this.pending?.push(() => this.events.push({ params }));
      return { rows: [] as T[] };
    }
    if (sql.startsWith("insert into zz.artifact_edge")) {
      // `asserted_event_id` is the last bind parameter on both edge-insert statements applyCommit
      // issues (derived_from: 8 params; cites: 9), checked immediately against events visible in
      // this transaction or a prior committed one.
      const assertedEventId = params[params.length - 1] as string;
      if (!this.durableEventIds.has(assertedEventId) && !this.pendingEventIds.has(assertedEventId)) {
        throw new Error(
          `zz.artifact_edge references event ${assertedEventId}, which no zz.artifact_event ` +
          "row is visible yet -- the asserting event must be inserted first");
      }
      return { rows: [] as T[] };
    }
    if (sql.startsWith("insert into zz.artifact_projection_commit")) {
      const [owner, tx] = params as [string, string];
      this.pending?.push(() => this.commits.add(`${owner}\u0000${tx}`));
      return { rows: [] as T[] };
    }
    if (sql.startsWith("insert into zz.artifact_projection_watermark")) {
      const [owner, sequence] = params as [string, number];
      this.pending?.push(() => this.watermarks.set(owner, Math.max(this.watermarks.get(owner) ?? 0, sequence)));
      return { rows: [] as T[] };
    }
    // doc_artifact, knowledge_node_artifact: no assertions need them below.
    return { rows: [] as T[] };
  }

  artifactCount(owner: string): number {
    return [...this.artifacts.keys()].filter((k) => k.startsWith(`${owner}\u0000`)).length;
  }
}

async function caseOfflineApplyCreatesProjectionsAndAdvancesWatermark(): Promise<void> {
  const store = new FakeProjectionStore();
  const owner = randomUUID();
  const artifact = randomUUID();
  const result = await applyCommit(store, manifestFor(owner, artifact, 1, randomUUID()));
  assert.equal(result.applied, true);
  assert.equal(store.artifactCount(owner), 1);
}

async function caseOfflineApplySkipsAnAlreadyAppliedTransaction(): Promise<void> {
  const store = new FakeProjectionStore();
  const owner = randomUUID();
  const artifact = randomUUID();
  const tx = randomUUID();
  await applyCommit(store, manifestFor(owner, artifact, 1, tx));
  const replay = await applyCommit(store, manifestFor(owner, artifact, 1, tx));
  assert.equal(replay.applied, false);
  assert.equal(replay.reason, "already_applied");
}

async function caseOfflineApplyRefusesToRegressTheWatermark(): Promise<void> {
  const store = new FakeProjectionStore();
  const owner = randomUUID();
  const artifact = randomUUID();
  await applyCommit(store, manifestFor(owner, artifact, 5, randomUUID()));
  const older = await applyCommit(store, manifestFor(owner, artifact, 2, randomUUID()));
  assert.equal(older.applied, false);
  assert.equal(older.reason, "stale_sequence");
}

async function caseOfflineApplyRollsBackOnMidTransactionFailure(): Promise<void> {
  const store = new FakeProjectionStore();
  const owner = randomUUID();
  const artifact = randomUUID();
  store.failNextWrite = true; // fails the very first write inside the transaction (zz.artifact)
  await assert.rejects(() => applyCommit(store, manifestFor(owner, artifact, 1, randomUUID())),
                        /injected mid-transaction failure/);
  assert.equal(store.artifactCount(owner), 0, "a rolled-back transaction must leave nothing behind");
}

async function caseOfflineApplyProjectsEventsBeforeCitationEdges(): Promise<void> {
  // `zz.artifact_edge.asserted_event_id` is an immediate foreign key into zz.artifact_event, so
  // a "cites" edge inserted before the event that asserts it fails on a real Postgres. This
  // fixture carries a `sources` entry so that path runs, and `FakeProjectionStore` enforces the
  // same ordering, so moving the revisions loop above the events loop fails here immediately.
  const store = new FakeProjectionStore();
  const owner = randomUUID();
  const artifact = randomUUID();
  const result = await applyCommit(store, manifestFor(owner, artifact, 1, randomUUID(), true));
  assert.equal(result.applied, true);
}

// Offline: ensureCorpus's own validation and the statements it issues

class RecordingClient implements ProjectionClient {
  readonly calls: string[] = [];
  async query<T = FakeRow>(text: string): Promise<{ rows: T[] }> {
    this.calls.push(text.trim().toLowerCase().replace(/\s+/g, " "));
    return { rows: [] as T[] };
  }
}

async function caseEnsureCorpusRejectsAnUnsafeKeyBeforeIssuingAnyStatement(): Promise<void> {
  const recorder = new RecordingClient();
  await assert.rejects(() => ensureCorpus(recorder, "acme'; drop table zz.artifact; --"), RangeError);
  assert.equal(recorder.calls.length, 0, "an unsafe corpus key must be refused before any statement is issued");
}

async function caseEnsureCorpusProvisionsAllThreeSearchParents(): Promise<void> {
  const recorder = new RecordingClient();
  await ensureCorpus(recorder, "acme_team");
  for (const parent of ["zz.search_current", "zz.search_evidence", "zz.search_history"]) {
    assert.ok(recorder.calls.some((c) => c.includes(`partition of ${parent} for values in ('acme_team')`)),
      `ensureCorpus must attach a partition of ${parent}`);
  }
  // The bm25 index is the fourth statement per parent, and it is what the partitions exist for:
  // `to_bm25query(query, index_name)` requires the named index to be on the relation being
  // scanned, so a per-corpus BM25 index on a concrete partition keeps one tenant's term
  // statistics out of another's ranking.
  assert.ok(recorder.calls.some((c) => /using bm25 \(raw_body\) with \(text_config='english'\)/.test(c)),
    "ensureCorpus must build the per-corpus BM25 index, not leave the corpus to a parent index");
  assert.equal(recorder.calls.length, 12, "3 search parents × (partition + tsv index + tags index + bm25 index)");
}

// Integration: applyCommit against an operator-provided isolated copy

function manifestFor(
  owner: string, artifact: string, sequence: number, transactionId: string,
  withCitation = false,
): ProjectionManifest {
  const now = "2026-09-20T00:00:00.000Z";
  // A cited source, when asked for — exercises the "cites" edge path, whose `asserted_event_id`
  // foreign key `offline_apply_projects_events_before_edges` below proves is ordered correctly.
  const sourceRef = withCitation
    ? { owner_id: owner, artifact_id: randomUUID(), revision: 1, content_hash: "1".repeat(64) }
    : null;
  return {
    owner_id: owner, artifact_id: artifact, artifact_class: "work_document",
    current_path: "notes.md", sequence, transaction_id: transactionId,
    revisions: [{
      owner_id: owner, artifact_id: artifact, revision: 1, content_hash: "0".repeat(64),
      payload: { title: "t", description: "d", type: "Decision", tags: [], body: "b\n", resource: null, content_fields: {} },
      cause_refs: [],
      sources: sourceRef ? [{ id: "s1", resource: "https://example.org/s1", ref: sourceRef }] : [],
      generated: { by: "rebuild-suite", at: now },
      origin_profile: "native", legacy_unresolved_sources: [], previous_revision: null,
    }],
    events: [{
      event_id: randomUUID(), transaction_id: transactionId, owner_id: owner, artifact_id: artifact,
      sequence: 1, at: now, actor: "rebuild-suite", kind: "created",
      revision: 1, content_hash: "0".repeat(64), cause_refs: [], data: {},
    }],
  };
}

async function caseAtomicApplyAgainstIsolatedDatabase(): Promise<void> {
  const url = (process.env.ZZ_TENANT_INFO_ISOLATED_DB_URL ?? "").trim();
  if (!url) {
    throw new Error(
      "ZZ_TENANT_INFO_ISOLATED_DB_URL is not set. This case applies real DDL and real rows " +
      "and runs only against an operator-provided isolated copy that the schema is already " +
      "applied to — never inferred from TEAM_DB_URL/PLATFORM_DB_URL, and never run here. Set " +
      "it to such a database and rerun `verify --suite rebuild --profile integration --cases " +
      "projection-schema` to exercise it.");
  }
  const client = await connectIsolated(url);
  try {
    // 1. Actual catalogs/FKs: every required table exists, and the two edge foreign keys
    //    (asserted_event_id/retracted_event_id) resolve to zz.artifact_event.
    for (const table of REQUIRED_OBJECTS) {
      const [schema, name] = table.split(".");
      const rows = await client.query<{ n: string }>(
        "select count(*)::text as n from information_schema.tables where table_schema=$1 and table_name=$2",
        [schema, name]);
      assert.equal(rows.rows[0]?.n, "1", `${table} must exist on the isolated copy`);
    }
    const fk = await client.query<{ n: string }>(
      `select count(*)::text as n from information_schema.table_constraints
        where table_schema='zz' and table_name='artifact_edge' and constraint_type='FOREIGN KEY'`);
    assert.equal(fk.rows[0]?.n, "2", "zz.artifact_edge must carry exactly its two event foreign keys");

    const owner = randomUUID();
    const artifact = randomUUID();
    const txA = randomUUID();

    // 2. Deliver an older sequence after a newer one — the older must never regress the head.
    //    `withCitation: true` also exercises the "cites" edge against a real, immediate foreign
    //    key: the offline fake proves the ordering, this proves Postgres accepts it.
    const newer = await applyCommit(client, manifestFor(owner, artifact, 5, txA, true));
    assert.equal(newer.applied, true);
    const older = await applyCommit(client, manifestFor(owner, artifact, 2, randomUUID()));
    assert.equal(older.applied, false);
    assert.equal(older.reason, "stale_sequence");
    const watermark = await client.query<{ head_sequence: number }>(
      "select head_sequence from zz.artifact_projection_watermark where owner_id=$1", [owner]);
    assert.equal(watermark.rows[0]?.head_sequence, 5, "an older queue item must never overwrite a newer head");

    // 3. Replay the same commit twice — the second call is a no-op, not a duplicate.
    const replay = await applyCommit(client, manifestFor(owner, artifact, 5, txA));
    assert.equal(replay.applied, false);
    assert.equal(replay.reason, "already_applied");
    const events = await client.query<{ n: string }>(
      "select count(*)::text as n from zz.artifact_event where owner_id=$1", [owner]);
    assert.equal(events.rows[0]?.n, "1", "a replayed commit must never duplicate its own events");

    // 4. Inject a middle-of-transaction failure and confirm rollback: nothing from this
    //    transaction_id reaches any table when the write half of applyCommit throws partway.
    const failingOwner = randomUUID();
    const failingArtifact = randomUUID();
    const failingTx = randomUUID();
    let calls = 0;
    const failingClient: ProjectionClient = {
      query: async (text, params) => {
        calls++;
        // Let begin/replay-check/watermark-check/artifact-insert through, then fail before the
        // event insert reaches the database (events project before revisions — see
        // applyCommit's own comment on why) — a genuine mid-transaction failure.
        if (calls === 5) throw new Error("injected mid-transaction failure");
        return client.query(text, params);
      },
    };
    await assert.rejects(() => applyCommit(failingClient, manifestFor(failingOwner, failingArtifact, 1, failingTx)),
                          /injected mid-transaction failure/);
    const survived = await client.query<{ n: string }>(
      "select count(*)::text as n from zz.artifact where owner_id=$1", [failingOwner]);
    assert.equal(survived.rows[0]?.n, "0", "a failed projection transaction must leave nothing behind");
  } finally {
    await client.close();
  }
}

// Case group

const PROJECTION_SCHEMA_CASES: Readonly<Record<string, () => void | Promise<void>>> = {
  compat_map_round_trips_and_never_reallocates: caseCompatMapRoundTripsAndNeverReallocates,
  compat_map_rejects_an_unreadable_file: caseCompatMapRejectsAnUnreadableFile,
  semantic_hash_excludes_operational_fields: caseSemanticHashExcludesOperationalFields,
  semantic_hash_changes_with_any_semantic_field: caseSemanticHashChangesWithAnySemanticField,
  migration_creates_every_required_object: caseMigrationCreatesEveryRequiredObject,
  migration_carries_no_nested_transaction_control: caseMigrationCarriesNoNestedTransactionControl,
  extension_precedes_any_bm25_reference: caseExtensionPrecedesAnyBm25Reference,
  migration_is_additive_only: caseMigrationIsAdditiveOnly,
  offline_apply_creates_projections_and_advances_watermark: caseOfflineApplyCreatesProjectionsAndAdvancesWatermark,
  offline_apply_skips_an_already_applied_transaction: caseOfflineApplySkipsAnAlreadyAppliedTransaction,
  offline_apply_refuses_to_regress_the_watermark: caseOfflineApplyRefusesToRegressTheWatermark,
  offline_apply_rolls_back_on_mid_transaction_failure: caseOfflineApplyRollsBackOnMidTransactionFailure,
  offline_apply_projects_events_before_citation_edges: caseOfflineApplyProjectsEventsBeforeCitationEdges,
  ensure_corpus_rejects_an_unsafe_key: caseEnsureCorpusRejectsAnUnsafeKeyBeforeIssuingAnyStatement,
  ensure_corpus_provisions_all_three_search_parents: caseEnsureCorpusProvisionsAllThreeSearchParents,
  atomic_apply_against_isolated_database: caseAtomicApplyAgainstIsolatedDatabase,
};

const CASE_GROUPS: Readonly<Record<string, Readonly<Record<string, () => void | Promise<void>>>>> = {
  "projection-schema": PROJECTION_SCHEMA_CASES,
  generation: GENERATION_CASES,
};

interface CaseResult { readonly status: "passed" | "failed" | "not_run"; readonly reason?: string }
interface SuiteDetail { readonly status: "blocked" | "ran"; readonly cases: Readonly<Record<string, CaseResult>> }
interface SuiteOutcome { readonly passed: boolean; readonly detail: SuiteDetail }

/**
 * The two cases that require an operator-provided isolated PostgreSQL 17 copy, reported
 * `not_run` with a reason when `ZZ_TENANT_INFO_ISOLATED_DB_URL` is unset — the same shape
 * `isolation.ts` uses for its own live-database group.
 *
 * `not_run` is not silent: at `--profile acceptance` a suite with any unrun case is `blocked`,
 * the receipt names the case, and the command exits nonzero.
 */
const ISOLATED_DATABASE_CASES = new Set([
  "atomic_apply_against_isolated_database",
  "real_rebuild_against_isolated_copy",
]);

const ISOLATED_DATABASE_REASON =
  "ZZ_TENANT_INFO_ISOLATED_DB_URL is not set. This case applies real DDL and real rows and runs " +
  "only against an operator-provided isolated copy with the schema already applied — never " +
  "inferred from TEAM_DB_URL/PLATFORM_DB_URL, and never provisioned by this suite. I-21 is the " +
  "task that produces that copy and exports the variable.";

/** `verify --suite rebuild`'s entry point, same shape as `persistence.ts`'s: `--cases` names a
 *  whole GROUP, not one case, and every case in it runs and reports individually. */
export async function run({ cases }: { cases?: string }): Promise<SuiteOutcome> {
  if (cases !== undefined && !(cases in CASE_GROUPS)) {
    const allNames = Object.values(CASE_GROUPS).flatMap((g) => Object.keys(g));
    const notRun = Object.fromEntries(allNames.map((name) => [
      name, { status: "not_run" as const, reason: `only the "${Object.keys(CASE_GROUPS).join('", "')}" case group exists so far` },
    ]));
    return { passed: false, detail: { status: "blocked", cases: notRun } };
  }
  const groupNames = cases === undefined ? Object.keys(CASE_GROUPS) : [cases];
  const isolatedUrl = (process.env.ZZ_TENANT_INFO_ISOLATED_DB_URL ?? "").trim();
  const results: Record<string, CaseResult> = {};
  for (const groupName of groupNames) {
    for (const [name, run1] of Object.entries(CASE_GROUPS[groupName])) {
      if (isolatedUrl === "" && ISOLATED_DATABASE_CASES.has(name)) {
        results[name] = { status: "not_run", reason: ISOLATED_DATABASE_REASON };
        continue;
      }
      try {
        await run1();
        results[name] = { status: "passed" };
      } catch (err) {
        results[name] = { status: "failed", reason: err instanceof Error ? err.message : String(err) };
      }
    }
  }
  // `not_run` is not a failure here — see `ISOLATED_DATABASE_CASES` above for what it means.
  return { passed: Object.values(results).every((r) => r.status !== "failed"), detail: { status: "ran", cases: results } };
}
