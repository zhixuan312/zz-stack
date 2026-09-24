/**
 * isolation.ts — the suite for one property: one tenant's writes never move another tenant's
 * scores, counts or ranking, even when every row-level predicate is completely correct.
 *
 * Two separate things live in this file. `validateIsolationObservation` is the pure comparator
 * `checks/tenant-isolation-statistics.ts` imports directly — it tests bad-observation detection
 * (does the comparator notice an empty baseline, a moved score, a leaked field), never database
 * isolation, because it never touches a database. `run` below is the suite: it seeds an invented
 * owner-A corpus, perturbs an owner-B corpus through the fixture loader, re-observes A through
 * production's own lane query builders, and feeds the before/after pair through that validator.
 *
 * The property is statistical, not row-level. A real BM25 index's document-frequency statistics
 * live in the index structure `to_bm25query(query, index_name)` names, not in the row-level `where`
 * clause that runs after it — so two owners who are correctly row-filtered but share one physical
 * index still leak: B's writes move A's IDF and hence A's score, though every row A's query returns
 * is genuinely A's own. The "statistics" case group models that channel on the real `to_bm25query`
 * call `buildLexicalLaneQuery` issues; a fake index evaluates the real executed SQL text and params,
 * never a mock of `buildLexicalLaneQuery` itself.
 *
 * Two gaps this suite reports rather than half-builds:
 *  - `zz.artifact.audience` is null everywhere and the search tables carry no audience column, so
 *    "recheck visibility" is honestly "still in the authorized corpus projection right now", not a
 *    live read of a system-of-record publication flag. The "publication" group proves what is true
 *    today: revocation through the registry `checkVisibility` is handed is never deferred, because
 *    nothing caches between a registry update and the next call.
 *  - Nothing in this checkout can run against real PG17/pg_textsearch: no bm25 index, no verified
 *    score expression, no DDL. The "live-postgres" group reports `not_run`.
 */
import assert from "node:assert/strict";

import { resolveCorpora, resultKey, rrf } from "../../services/zz-core/dist/tenant-info/retrieval.js";
import { checkVisibility } from "../../services/zz-core/dist/tenant-info/pinned-read.js";
import type { CorpusDescriptor, RetrievalClient } from "../../services/zz-core/dist/tenant-info/retrieval.js";
import { buildLexicalLaneQuery } from "../../services/zz-core/dist/tenant-info/lanes.js";
import { LIVE_CASES, LIVE_DB_ENV } from "./isolation-live.ts";

// validateIsolationObservation: the pure comparator the frozen check drives

interface IsolationResultRow {
  readonly owner_id: string;
  readonly artifact_id: string;
  readonly revision: number;
  readonly score: number;
}

interface IsolationCorpusState {
  readonly stats: Readonly<Record<string, number>>;
  readonly results: readonly IsolationResultRow[];
}

interface IsolationValidation {
  readonly ok: boolean;
  readonly issues: readonly string[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function isCorpusState(v: unknown): v is IsolationCorpusState {
  return isRecord(v) && isRecord(v.stats) && Array.isArray(v.results);
}

function resultRowIssues(label: "before" | "after", state: IsolationCorpusState, ownerId: string): string[] {
  const issues: string[] = [];
  for (const row of state.results) {
    if (!isRecord(row) || !isNonEmptyString(row.artifact_id) || !Number.isInteger(row.revision) || !isFiniteNumber(row.score)) {
      issues.push(`${label}.results carries a malformed row — every entry needs artifact_id/revision/score`);
      continue;
    }
    // An unqualified key is itself the disclosure. `resultKey` (retrieval.ts) folds owner_id into
    // every identity so two owners can never collide on one key; a result row that does not carry
    // the observation's own bound owner is the shape that collision would take, whether it is a
    // leaked row or a comparator that forgot to qualify.
    if (!isNonEmptyString(row.owner_id) || row.owner_id !== ownerId) {
      issues.push(`${label}.results carries an unqualified key — row owner ${JSON.stringify(row.owner_id)} `
        + `does not match the observation's bound owner ${JSON.stringify(ownerId)}`);
    }
  }
  return issues;
}

function resultIdentity(row: IsolationResultRow): string {
  return `${row.owner_id}:${row.artifact_id}:${row.revision}`;
}

/**
 * Requires nonempty comparable observations and explicit owner/query bindings — an empty baseline, a
 * missing after result, a changed score or statistic, an unqualified key or leaked forbidden
 * metadata all fail. A pure function of its argument alone: no database, no clock, no filesystem.
 * The isolation property is proved by the caller having produced a real before/after pair.
 */
export function validateIsolationObservation(observation: unknown): IsolationValidation {
  if (!isRecord(observation)) return { ok: false, issues: ["observation must be an object"] };

  const shapeIssues: string[] = [];
  if (!isNonEmptyString(observation.owner_id)) shapeIssues.push("owner_id must be an explicit nonempty string binding");
  if (!isNonEmptyString(observation.query)) shapeIssues.push("query must be an explicit nonempty string binding");
  if (!isCorpusState(observation.before)) shapeIssues.push("before must carry a stats object and a results array");
  if (!isCorpusState(observation.after)) shapeIssues.push("after must carry a stats object and a results array");
  if (!Array.isArray(observation.forbidden_metadata)) shapeIssues.push("forbidden_metadata must be an array");
  if (shapeIssues.length > 0) return { ok: false, issues: shapeIssues };

  const ownerId = observation.owner_id as string;
  const before = observation.before as IsolationCorpusState;
  const after = observation.after as IsolationCorpusState;
  const forbidden = observation.forbidden_metadata as readonly unknown[];

  const issues: string[] = [];

  // A leak of forbidden metadata fails regardless of whether scores moved: no count, snippet, graph
  // edge or fallback path may disclose metadata about an artifact the caller cannot read. A hard
  // refusal, not a tiebreaker against the statistics comparison below.
  if (forbidden.length > 0) {
    issues.push(`forbidden_metadata discloses ${forbidden.length} field(s) an unauthorized caller must never see: `
      + `${forbidden.map((f) => JSON.stringify(f)).join(", ")}`);
  }

  // Nonvacuous by construction: an empty baseline proves nothing, because every comparison below
  // would trivially hold over two empty lists.
  if (before.results.length === 0) {
    issues.push("before.results is empty — nothing was seeded, so no comparison could possibly fail");
  }

  issues.push(...resultRowIssues("before", before, ownerId));
  issues.push(...resultRowIssues("after", after, ownerId));
  if (issues.length > 0) return { ok: false, issues };

  // Statistics: every key either side names must match, in both directions — a statistic that
  // appears only after, not merely one that changed value, is the shape a corpus-wide aggregate
  // newly leaking into the observation would take.
  const statKeys = new Set([...Object.keys(before.stats), ...Object.keys(after.stats)]);
  for (const key of statKeys) {
    const b = before.stats[key];
    const a = after.stats[key];
    if (a !== b) {
      issues.push(`corpus statistic "${key}" changed from ${JSON.stringify(b)} to ${JSON.stringify(a)} — `
        + "another owner's write must never move this owner's statistics");
    }
  }

  // Results: identity set and score, both directions — a result present after but absent before is
  // a count leak (another owner's write surfacing a new result for this owner's query) as much as a
  // missing or rescored one is.
  const beforeByKey = new Map(before.results.map((r) => [resultIdentity(r), r]));
  const afterByKey = new Map(after.results.map((r) => [resultIdentity(r), r]));
  for (const [key, beforeRow] of beforeByKey) {
    const afterRow = afterByKey.get(key);
    if (!afterRow) { issues.push(`result ${key} was present before and is missing after`); continue; }
    if (afterRow.score !== beforeRow.score) {
      issues.push(`result ${key}'s score changed from ${beforeRow.score} to ${afterRow.score}`);
    }
  }
  for (const key of afterByKey.keys()) {
    if (!beforeByKey.has(key)) issues.push(`result ${key} appears after but was absent before — an uninvited result is a count leak`);
  }

  return { ok: issues.length === 0, issues };
}

// The "statistics" case group: a fake index, driven through the real lane query.
//
// `statisticsClient` below evaluates the SQL text and params `buildLexicalLaneQuery` actually
// produces — the owner/corpus equality conjuncts, plus the `to_bm25query($term, $index_name)` call
// this file's header explains is the one query-time surface this checkout's DDL gap leaves
// unverified. A checker that grepped the query text for "owner_id" would pass on a mutation that
// pooled statistics across owners while still filtering rows correctly.

interface FakeDoc {
  readonly corpus_key: string;
  readonly owner_id: string;
  readonly artifact_id: string;
  readonly revision: number;
  readonly content_hash: string;
  readonly tags: readonly string[];
  /** The physical index this document's term statistics are pooled into — distinct, in a correctly
   *  configured registry, from `corpus_key`/`owner_id`. The registry entry's own `index_name` is
   *  what a real query binds into `to_bm25query`; this field is the fixture's side of that value. */
  readonly index_name: string;
  readonly raw_body: string;
}

function equalityConjuncts(text: string, params: readonly unknown[]): [string, unknown][] {
  return [...text.matchAll(/(\w+) = \$(\d+)/g)].map((m) => [m[1], params[Number(m[2]) - 1]] as [string, unknown]);
}

function bm25Call(text: string, params: readonly unknown[]): { term: string; indexName: string } | null {
  const m = /to_bm25query\(\$(\d+),\s*\$(\d+)\)/.exec(text);
  if (!m) return null;
  return { term: String(params[Number(m[1]) - 1]), indexName: String(params[Number(m[2]) - 1]) };
}

/**
 * A client that evaluates the executed predicate against an in-memory fixture — no real
 * pg_textsearch, no docker, no network. `seen` lets a case assert the SQL actually issued carried
 * the predicate it expects.
 */
function statisticsClient(docs: readonly FakeDoc[]): { seen: { text: string; params: readonly unknown[] }[]; client: RetrievalClient } {
  const seen: { text: string; params: readonly unknown[] }[] = [];
  const client: RetrievalClient = {
    query: async <T>(text: string, params: readonly unknown[] = []) => {
      seen.push({ text, params });
      const conjuncts = equalityConjuncts(text, params);
      const bm25 = bm25Call(text, params);
      let rows = docs.filter((d) => conjuncts.every(([col, want]) => (d as unknown as Record<string, unknown>)[col] === want));
      if (bm25) rows = rows.filter((d) => d.raw_body.toLowerCase().includes(bm25.term.toLowerCase()));
      return { rows: rows as unknown as T[] };
    },
  };
  return { seen, client };
}

/**
 * Okapi BM25's own idf, `ln((N - df + 0.5) / (df + 0.5) + 1)`, computed over the physical index's
 * population (every doc sharing `indexName`) and never over `corpus_key`/`owner_id` — the exact
 * distinction a real bm25 index makes and a row-level `where` clause cannot fix. Substring
 * containment stands in for the real tsvector match, as `pinned-read.ts`'s `matchesArtifact` does.
 */
function idf(docs: readonly FakeDoc[], indexName: string, term: string): number {
  const population = docs.filter((d) => d.index_name === indexName);
  const n = population.length;
  const df = population.filter((d) => d.raw_body.toLowerCase().includes(term.toLowerCase())).length;
  return Math.log((n - df + 0.5) / (df + 0.5) + 1);
}

interface Observation { readonly stats: Record<string, number>; readonly results: IsolationResultRow[] }

/** Runs the real `buildLexicalLaneQuery` against `docs` through `statisticsClient`, and scores every
 *  returned row with `idf` over the index the executed query actually named. */
async function observe(docs: readonly FakeDoc[], descriptor: CorpusDescriptor, term: string): Promise<Observation> {
  const { client } = statisticsClient(docs);
  const q = buildLexicalLaneQuery(descriptor, term, {}, 50);
  const { rows } = await client.query<{ owner_id: string; artifact_id: string; revision: number }>(q.text, q.params);
  const bm25 = bm25Call(q.text, q.params);
  if (!bm25) throw new Error("the lexical lane query carries no to_bm25query match — nothing to score");
  const population = docs.filter((d) => d.index_name === bm25.indexName);
  const hits = population.filter((d) => d.raw_body.toLowerCase().includes(bm25.term.toLowerCase()));
  const score = idf(docs, bm25.indexName, bm25.term);
  return {
    stats: { documents: population.length, matches: hits.length },
    results: rows.map((r) => ({ owner_id: r.owner_id, artifact_id: r.artifact_id, revision: r.revision, score })),
  };
}

function seedDocs(descriptor: CorpusDescriptor, count: number, term: string, hitEvery: number): FakeDoc[] {
  const out: FakeDoc[] = [];
  for (let i = 0; i < count; i++) {
    const hit = i % hitEvery === 0;
    out.push({
      corpus_key: descriptor.corpus_key,
      owner_id: descriptor.owner_id,
      artifact_id: `fx-${descriptor.owner_id.slice(0, 8)}-${i.toString().padStart(6, "0")}`,
      revision: 1,
      content_hash: "0".repeat(64),
      tags: [],
      index_name: descriptor.index_name,
      raw_body: hit ? `filler filler ${term} filler` : "filler filler filler filler",
    });
  }
  return out;
}

const OWNER_A = "77777777-7777-4777-8777-777777777777";
const OWNER_B = "88888888-8888-4888-8888-888888888888";
const TERM = "distinctive-b-perturbation";

const DESCRIPTOR_A: CorpusDescriptor = { corpus_key: "acme-current", owner_id: OWNER_A, scope: "current", audience: "private", index_name: "idx-acme" };
const DESCRIPTOR_B: CorpusDescriptor = { corpus_key: "widget-current", owner_id: OWNER_B, scope: "current", audience: "private", index_name: "idx-widget" };
/** The misconfiguration under test: owner B's own corpus, pointed at owner A's physical index — one
 *  index filtered by team instead of one index per team. Row-level filtering (`owner_id = $n`) is
 *  untouched; only the index population B's writes land in has changed. */
const DESCRIPTOR_B_SHARED_INDEX: CorpusDescriptor = { ...DESCRIPTOR_B, index_name: DESCRIPTOR_A.index_name };

/** Seeding must actually produce a comparable baseline, proved directly rather than inferred from a
 *  later assertion passing. */
async function caseSeedThenBaselineIsNonvacuous(): Promise<void> {
  const docsA = seedDocs(DESCRIPTOR_A, 40, TERM, 2);
  assert.equal(docsA.length, 40, "the tested owner's own corpus must be seeded before any observation is taken");
  const baseline = await observe(docsA, DESCRIPTOR_A, TERM);
  assert.ok(baseline.results.length > 0,
    "a baseline drawn from a corpus with no matching document proves nothing — the seed must produce real hits");
  assert.equal(baseline.stats.documents, 40);
}

/** The property itself. A correctly configured registry gives owner A and owner B distinct physical
 *  indexes, so B's 5000-document, maximally distinctive perturbation must not move A's statistics,
 *  scores or result count by one bit. */
async function caseIsolatedIndexesLeaveAUnchanged(): Promise<void> {
  const docsA = seedDocs(DESCRIPTOR_A, 40, TERM, 2);
  const before = await observe(docsA, DESCRIPTOR_A, TERM);
  assert.ok(before.results.length > 0, "before must be nonempty, or the after-comparison is vacuous");

  const docsB = seedDocs(DESCRIPTOR_B, 5000, TERM, 1); // every B document names the term — maximal statistical pressure
  const merged = [...docsA, ...docsB];
  const after = await observe(merged, DESCRIPTOR_A, TERM);

  const verdict = validateIsolationObservation({ owner_id: OWNER_A, query: TERM, before, after, forbidden_metadata: [] });
  assert.equal(verdict.ok, true, verdict.issues.join("; "));
}

/** The mutation test: another tenant's writes can move the tested owner's scores, and the suite goes
 *  red naming it. Row-level correctness is untouched throughout — A's own returned artifact
 *  identities are exactly the same before and after — so the leak is invisible to any check that
 *  only inspects which rows came back. */
async function caseSharedIndexMisconfigurationMovesAScoresAndGoesRed(): Promise<void> {
  const docsA = seedDocs(DESCRIPTOR_A, 40, TERM, 2);
  const before = await observe(docsA, DESCRIPTOR_A, TERM);
  assert.ok(before.results.length > 0);

  const docsBOnSharedIndex = seedDocs(DESCRIPTOR_B_SHARED_INDEX, 5000, TERM, 1);
  const merged = [...docsA, ...docsBOnSharedIndex];
  const after = await observe(merged, DESCRIPTOR_A, TERM); // descriptor unchanged — still asks for idx-acme

  assert.notEqual(after.stats.documents, before.stats.documents,
    "the mutant must actually move the population statistic, or this case proves nothing");
  assert.notEqual(after.results[0]?.score, before.results[0]?.score,
    "the mutant must actually move A's score, or this case proves nothing");
  assert.deepEqual(
    [...after.results.map((r) => r.artifact_id)].sort(),
    [...before.results.map((r) => r.artifact_id)].sort(),
    "a statistical leak can happen even though the row-level predicate returns exactly A's own rows — that is what makes it invisible to a row-only check",
  );

  const verdict = validateIsolationObservation({ owner_id: OWNER_A, query: TERM, before, after, forbidden_metadata: [] });
  assert.equal(verdict.ok, false, "a misconfigured shared index must fail the isolation check even though every returned row is A's own");
  assert.ok(verdict.issues.some((i) => /statistic/.test(i)), `expected a statistic-change issue, got: ${verdict.issues.join("; ")}`);
}

/**
 * The code guarantee behind the case above. `assertOneOwnerPerIndex` (retrieval.ts) is the invariant,
 * and this case is what makes it mutation-testable: remove the guard and this case goes red. The
 * misconfigured registry here is built from the same `DESCRIPTOR_B_SHARED_INDEX` the leak case
 * perturbs with, so the thing refused is the thing shown to move A's scores.
 */
async function caseRegistryPointingTwoOwnersAtOneIndexIsRefused(): Promise<void> {
  const misconfigured = [DESCRIPTOR_A, DESCRIPTOR_B_SHARED_INDEX];
  assert.equal(misconfigured[0].index_name, misconfigured[1].index_name,
    "this case is only meaningful if the two entries really do share one physical index");
  assert.notEqual(misconfigured[0].owner_id, misconfigured[1].owner_id);

  assert.throws(
    () => resolveCorpora({ owner_id: OWNER_A, shared_allowed: false }, {}, misconfigured),
    (err: unknown) => (err as { code?: string }).code === "REGISTRY_MISCONFIGURED",
    "a registry pointing one index at two owners must be refused as server misconfiguration — " +
    "not as INVALID_INPUT, which would blame a caller that did nothing wrong",
  );

  // The guard must refuse this and not simply everything: a correctly configured registry, one index
  // per owner, still resolves.
  const correct = resolveCorpora({ owner_id: OWNER_A, shared_allowed: false }, {}, [DESCRIPTOR_A, DESCRIPTOR_B]);
  assert.equal(correct.length, 1, "owner A's own current corpus still resolves when the registry is sound");
  assert.equal(correct[0].owner_id, OWNER_A);

  // Two entries for the same owner sharing an index are not a tenant leak and stay allowed —
  // the guard is the narrow property the mutation case proves, not a general uniqueness rule.
  const sameOwnerTwoScopes = [DESCRIPTOR_A, { ...DESCRIPTOR_A, corpus_key: "acme-history", scope: "history" }];
  assert.doesNotThrow(() => resolveCorpora({ owner_id: OWNER_A, shared_allowed: false }, { scopes: ["current", "history"] }, sameOwnerTwoScopes));
}

/**
 * One owner is not one visibility scope, and the guard above only checked the owner.
 *
 * `zz-platform` holds both its private work documents and the knowledge it publishes to every team.
 * Two of its corpora sharing one physical index passes an owner check — same owner, no cross-tenant
 * collision — and a shared reader's ranking is then moved by content they cannot see and cannot ask
 * about. The leak happens inside one tenant, across the line `audience` exists to draw, and every
 * row that comes back is one the caller is entitled to.
 */
async function caseRegistryPointingTwoAudiencesAtOneIndexIsRefused(): Promise<void> {
  const PLATFORM = "5c5c5c5c-5c5c-4c5c-8c5c-5c5c5c5c5c5c";
  const shared = "zz_search_current_platform_shared";
  const misconfigured = [
    { corpus_key: "platform-private", owner_id: PLATFORM, scope: "current", audience: "private", index_name: shared },
    { corpus_key: "platform-published", owner_id: PLATFORM, scope: "current", audience: "published", index_name: shared },
  ];
  assert.equal(misconfigured[0].owner_id, misconfigured[1].owner_id,
    "this case is only meaningful while both corpora belong to the SAME owner — otherwise it is the cross-tenant case");
  assert.notEqual(misconfigured[0].audience, misconfigured[1].audience);

  assert.throws(
    () => resolveCorpora({ owner_id: PLATFORM, shared_allowed: true }, {}, misconfigured),
    (err: unknown) => (err as { code?: string }).code === "REGISTRY_MISCONFIGURED",
    "an index shared across a private and a published corpus of one owner must be refused",
  );

  // And the guard still admits the configuration that is correct: one index per corpus.
  const correct = misconfigured.map((e) => ({ ...e, index_name: `zz_search_current_${e.corpus_key.replace("-", "_")}` }));
  const resolved = resolveCorpora({ owner_id: PLATFORM, shared_allowed: true }, {}, correct);
  assert.equal(resolved.length, 2, "two correctly-indexed corpora of one owner both resolve");
}

const STATISTICS_CASES: Readonly<Record<string, () => Promise<void>>> = {
  seed_then_baseline_is_nonvacuous: caseSeedThenBaselineIsNonvacuous,
  isolated_indexes_leave_a_unchanged: caseIsolatedIndexesLeaveAUnchanged,
  shared_index_misconfiguration_moves_a_scores_and_goes_red: caseSharedIndexMisconfigurationMovesAScoresAndGoesRed,
  registry_pointing_two_owners_at_one_index_is_refused: caseRegistryPointingTwoOwnersAtOneIndexIsRefused,
  registry_pointing_two_audiences_at_one_index_is_refused: caseRegistryPointingTwoAudiencesAtOneIndexIsRefused,
};

// The "identity" case group: identical paths across two teams never collide on one key

function caseIdenticalPathsAcrossOwnersNeverCollide(): void {
  const artifactId = "identical-path-across-two-teams.md";
  const keyA = resultKey({ owner_id: OWNER_A, artifact_id: artifactId, revision: 1, content_hash: "a".repeat(64), scope: "current" });
  const keyB = resultKey({ owner_id: OWNER_B, artifact_id: artifactId, revision: 1, content_hash: "b".repeat(64), scope: "current" });
  assert.notEqual(keyA, keyB, "an identical artifact_id/path across two owners must never collide on one result key");

  const fused = rrf([
    { lane: "lexical", corpus: DESCRIPTOR_A.corpus_key, keys: [keyA] },
    { lane: "lexical", corpus: DESCRIPTOR_B.corpus_key, keys: [keyB] },
  ]);
  assert.equal(fused.length, 2, "two distinct owners' identically-pathed artifacts must fuse to two candidates, never one");
}

const IDENTITY_CASES: Readonly<Record<string, () => void>> = {
  identical_paths_across_owners_never_collide: caseIdenticalPathsAcrossOwnersNeverCollide,
};

// The "publication" case group: shared publication, revocation, and refusal shape

interface VisibilityRow { readonly corpus_key: string; readonly owner_id: string; readonly artifact_id: string; readonly revision: number; readonly content_hash: string }

function visibilityRowsClient(rows: readonly VisibilityRow[]): RetrievalClient {
  return {
    query: async <T>(text: string, params: readonly unknown[] = []) => {
      const conjuncts = equalityConjuncts(text, params);
      return { rows: rows.filter((r) => conjuncts.every(([col, want]) => (r as unknown as Record<string, unknown>)[col] === want)) as unknown as T[] };
    },
  };
}

const SHARED_ARTIFACT = "shared-platform-artifact";
const shared = (audience: "published" | "private"): CorpusDescriptor[] => [
  { corpus_key: "platform-shared", owner_id: OWNER_A, scope: "current", audience, index_name: "idx-platform-shared" },
];

/** A caller without shared access can never see a published corpus belonging to another owner —
 *  exercised through `checkVisibility`'s real query path, not asserted on `resolveCorpora` alone. */
async function casePrivatePlatformIsolationWithoutSharedAccess(): Promise<void> {
  const rows: VisibilityRow[] = [{ corpus_key: "platform-shared", owner_id: OWNER_A, artifact_id: SHARED_ARTIFACT, revision: 1, content_hash: "c".repeat(64) }];
  const client = visibilityRowsClient(rows);
  const out = await checkVisibility(client, { owner_id: OWNER_B, shared_allowed: false }, shared("published"),
    { owner_id: OWNER_A, artifact_id: SHARED_ARTIFACT, scope: "current" });
  assert.equal(out.ok, false);
  assert.equal((out as { code: string }).code, "NOT_FOUND_OR_FORBIDDEN");
}

/**
 * Revocation is not deferred until index refresh: the real `checkVisibility` is called twice, once
 * against a `published` registry and once against the same registry with the entry flipped to
 * `private`, with no caching layer between the two calls that could serve stale state. The refusal
 * carries nothing beyond `ok`/`code` — no title, snippet or count leaks through a denial.
 */
async function caseSharedPublicationThenRevocationIsImmediatelyInvisible(): Promise<void> {
  const rows: VisibilityRow[] = [{ corpus_key: "platform-shared", owner_id: OWNER_A, artifact_id: SHARED_ARTIFACT, revision: 1, content_hash: "d".repeat(64) }];
  const client = visibilityRowsClient(rows);
  const context = { owner_id: OWNER_B, shared_allowed: true };
  const target = { owner_id: OWNER_A, artifact_id: SHARED_ARTIFACT, scope: "current" as const };

  const published = await checkVisibility(client, context, shared("published"), target);
  assert.equal(published.ok, true, "a genuinely published corpus must be visible to a shared-access caller");

  const revoked = await checkVisibility(client, context, shared("private"), target);
  assert.equal(revoked.ok, false);
  assert.equal((revoked as { code: string }).code, "NOT_FOUND_OR_FORBIDDEN");
  assert.deepEqual(Object.keys(revoked).sort(), ["code", "ok"],
    "a revoked-publication refusal must disclose nothing beyond ok/code — no title, snippet or count");
}

const PUBLICATION_CASES: Readonly<Record<string, () => Promise<void>>> = {
  private_platform_isolation_without_shared_access: casePrivatePlatformIsolationWithoutSharedAccess,
  shared_publication_then_revocation_is_immediately_invisible: caseSharedPublicationThenRevocationIsImmediatelyInvisible,
};

// The "live-postgres" case group: real PG17/pg_textsearch, reported not_run here.
//
// An unavailable PostgreSQL or a fixture setup error is blocked/not_run, never a successful
// isolation refusal. These cases are never entered into the generic try/catch case runner below,
// which would report an unset URL as "failed" — they report `not_run` directly, with the reason
// named.
//
// COUPLED: `ZZ_TENANT_INFO_ISOLATED_DB_URL` is the same env var `rebuild.ts`'s
// `atomic_apply_against_isolated_database` case uses.
const LIVE_POSTGRES_CASES = ["real_pg17_statistical_isolation", "real_pg17_bm25_score_expression"] as const;

function liveNotRunReason(): string {
  const url = (process.env[LIVE_DB_ENV] ?? "").trim();
  if (!url) {
    return `${LIVE_DB_ENV} is not set. This case runs only against an operator-provided isolated `
      + "PG17/pg_textsearch copy with the schema applied — never inferred from TEAM_DB_URL/"
      + "PLATFORM_DB_URL, and never spun up by this suite. A full-capacity run (40+ A fixtures, "
      + "5000+ B perturbations) is I-23/I-25's, not claimed from anything smaller here.";
  }
  return "lanes.ts's own header records that this checkout carries no verified pg_textsearch bm25 "
    + "index or score expression (the schema declares neither) — "
    + "\"real pg_textsearch scores/statistics\" cannot be produced from anything committed here yet, "
    + `even with ${LIVE_DB_ENV} set. This is a named contract gap, not a guessed pass.`;
}


// Suite entry point

const CASE_GROUPS: Readonly<Record<string, Readonly<Record<string, () => void | Promise<void>>>>> = {
  statistics: STATISTICS_CASES,
  identity: IDENTITY_CASES,
  publication: PUBLICATION_CASES,
};

interface CaseResult { readonly status: "passed" | "failed" | "not_run"; readonly reason?: string }
interface SuiteDetail { readonly status: "blocked" | "ran"; readonly cases: Readonly<Record<string, CaseResult>> }
interface SuiteOutcome { readonly passed: boolean; readonly detail: SuiteDetail }

/**
 * `verify --suite isolation`'s entry point. `--cases` names one whole group; the `live-postgres`
 * group is never run through the generic try/catch loop (see its own comment) and its cases are
 * always reported `not_run`. `passed` treats `not_run` as non-blocking (`every(status !== "failed")`),
 * so an unreachable live database neither reads as a false green nor drags down the offline cases.
 */
export async function run({ cases }: { cases?: string }): Promise<SuiteOutcome> {
  const allGroupNames = [...Object.keys(CASE_GROUPS), "live-postgres"];
  if (cases !== undefined && !allGroupNames.includes(cases)) {
    const allNames = [...Object.values(CASE_GROUPS).flatMap((g) => Object.keys(g)), ...LIVE_POSTGRES_CASES];
    const notRun = Object.fromEntries(allNames.map((name) => [
      name, { status: "not_run" as const, reason: `only the "${allGroupNames.join('", "')}" case group(s) exist` },
    ]));
    return { passed: false, detail: { status: "blocked", cases: notRun } };
  }

  const groupNames = cases === undefined ? Object.keys(CASE_GROUPS) : (cases === "live-postgres" ? [] : [cases]);
  const results: Record<string, CaseResult> = {};
  for (const groupName of groupNames) {
    for (const [name, run1] of Object.entries(CASE_GROUPS[groupName])) {
      try {
        await run1();
        results[name] = { status: "passed" };
      } catch (err) {
        results[name] = { status: "failed", reason: err instanceof Error ? err.message : String(err) };
      }
    }
  }
  if (cases === undefined || cases === "live-postgres") {
    const url = (process.env[LIVE_DB_ENV] ?? "").trim();
    if (!url) {
      const reason = liveNotRunReason();
      for (const name of LIVE_POSTGRES_CASES) results[name] = { status: "not_run", reason };
    } else {
      for (const [name, run1] of Object.entries(LIVE_CASES)) {
        try {
          await run1();
          results[name] = { status: "passed" };
        } catch (err) {
          results[name] = { status: "failed", reason: err instanceof Error ? err.message : String(err) };
        }
      }
    }
  }

  const passed = Object.values(results).every((r) => r.status !== "failed");
  return { passed, detail: { status: "ran", cases: results } };
}
