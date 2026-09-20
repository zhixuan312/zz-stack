/**
 * retrieval.ts — the retrieval suite. I-16 opens it with the "visibility" case group: corpus
 * and scope resolution, and the authorization boundary every later lane sits behind.
 *
 * WHY THIS FILE EXISTS AT I-16 RATHER THAN I-18, which the plan names as the retrieval suite's
 * first producing task. I-16's cases proved the owner predicate behaviourally — two rows sharing
 * a corpus key AND an artifact id, differing only in owner, where only the real `where owner_id
 * = $2` returns the one the caller asked for — and they were living in a scratch directory,
 * reachable from a report and from nowhere else. Evidence that cannot be re-run is not evidence
 * anybody can check later, and the plan's own rule is that the FIRST producing task creates the
 * suite and later tasks extend it. I-16 produced cases; this is that file. I-18 extends it.
 *
 * AND IT GIVES `checkVisibility` ITS FIRST CONSUMER, honestly. Exported for I-17's lanes and
 * I-18's pinned reads, it had none yet, and the dead-export gate check said so correctly. The
 * implementing worker declined to call it from inside its own module to quiet that — which would
 * have been gaming the check rather than satisfying it. A suite that exercises the primitive is
 * the real consumer the check was asking for.
 */
import assert from "node:assert/strict";

import { CURSOR_CASES } from "./retrieval-cursor.ts";
import { LANE_CASES } from "./retrieval-lanes.ts";
import { QUERY_CASES } from "./retrieval-query.ts";
import {
  checkVisibility, collapseBeforeCap, resolveCorpora, resultKey, rrf,
} from "../../services/zz-core/dist/tenant-info/retrieval.js";

const OWNER_P = "33333333-3333-4333-8333-333333333333";
const OWNER_Q = "44444444-4444-4444-8444-444444444444";
const ARTIFACT = "55555555-5555-4555-8555-555555555555";

interface Row {
  readonly corpus_key: string;
  readonly owner_id: string;
  readonly artifact_id: string;
  readonly revision: number;
  readonly content_hash: string;
}

/** A client that EVALUATES the predicates the query text actually carries, rather than scanning
 *  it for a substring. A checker that greps for "owner_id" passes on a query that selects the
 *  column and filters on nothing — which is the exact defect this task's contract names. */
function recordingClient(rows: readonly Row[]) {
  const seen: { text: string; params: readonly unknown[] }[] = [];
  return {
    seen,
    client: {
      query: async <T>(text: string, params: readonly unknown[]) => {
        seen.push({ text, params });
        const conjuncts = [...text.matchAll(/(\w+) = \$(\d+)/g)]
          .map((m) => [m[1], params[Number(m[2]) - 1]] as const);
        return {
          rows: rows.filter((r) => conjuncts.every(([col, want]) =>
            (r as unknown as Record<string, unknown>)[col] === want)) as unknown as T[],
        };
      },
    },
  };
}

const REGISTRY = [
  { corpus_key: "q-current", owner_id: OWNER_Q, scope: "current", audience: "private", index_name: "i" },
  { corpus_key: "p-current", owner_id: OWNER_P, scope: "current", audience: "private", index_name: "i" },
];

/** The corpus a context may not see never reaches a query at all — the registry gate refuses
 *  first, so no statement is issued for another tenant's corpus even in the moment before a
 *  predicate would have filtered it. */
async function caseUnregisteredOwnerIssuesNoQuery(): Promise<void> {
  const { seen, client } = recordingClient([]);
  const out = await checkVisibility(
    client, { owner_id: OWNER_Q, shared_allowed: false },
    [], { owner_id: OWNER_Q, artifact_id: ARTIFACT, scope: "current" },
  );
  assert.equal(out.ok, false);
  assert.equal((out as { code: string }).code, "NOT_FOUND_OR_FORBIDDEN");
  assert.equal(seen.length, 0, "an owner absent from the registry must not reach a query");
}

/** THE CASE THE WHOLE TASK RESTS ON. Two rows share a corpus key and, deliberately, the same
 *  artifact id, differing only in owner — the shape a partial index's WHERE clause would let
 *  through the moment somebody changed the index. Only the predicate in the executed text
 *  separates them, and the assertion is on the CONTENT HASH returned, not on "a row was found". */
async function caseOwnerPredicateSeparatesCollidingRows(): Promise<void> {
  const rows: Row[] = [
    { corpus_key: "q-current", owner_id: OWNER_P, artifact_id: ARTIFACT, revision: 1, content_hash: "p".repeat(64) },
    { corpus_key: "q-current", owner_id: OWNER_Q, artifact_id: ARTIFACT, revision: 1, content_hash: "q".repeat(64) },
  ];
  const { seen, client } = recordingClient(rows);
  const out = await checkVisibility(
    client, { owner_id: OWNER_Q, shared_allowed: false },
    REGISTRY, { owner_id: OWNER_Q, artifact_id: ARTIFACT, scope: "current" },
  );
  assert.equal(seen.length, 1);
  assert.match(seen[0].text, /owner_id = \$/,
    "the owner predicate must be in the statement that runs, not left to an index");
  assert.equal(out.ok, true);
  assert.equal((out as { row: Row }).row.content_hash, "q".repeat(64),
    "a request for one owner's artifact must never return another owner's bytes");
}

/** An owner the context is not authorized for answers exactly as a non-existent one does.
 *  Distinguishable refusals are themselves a disclosure: "forbidden" tells a caller the thing
 *  exists. */
async function caseUnauthorizedReadsAsAbsent(): Promise<void> {
  const { client } = recordingClient([]);
  const forbidden = await checkVisibility(
    client, { owner_id: OWNER_Q, shared_allowed: false },
    REGISTRY, { owner_id: OWNER_P, artifact_id: ARTIFACT, scope: "current" },
  );
  const absent = await checkVisibility(
    client, { owner_id: OWNER_Q, shared_allowed: false },
    REGISTRY, { owner_id: OWNER_Q, artifact_id: "99999999-9999-4999-8999-999999999999", scope: "current" },
  );
  assert.equal(forbidden.ok, false);
  assert.equal(absent.ok, false);
  assert.equal((forbidden as { code: string }).code, (absent as { code: string }).code);
}

/** `current` is the default and the only scope an unasked-for request resolves to — source and
 *  history are reachable only by naming them. */
async function caseCurrentIsTheDefaultScope(): Promise<void> {
  const resolved = resolveCorpora({ owner_id: OWNER_Q, shared_allowed: false }, {}, REGISTRY);
  assert.ok(resolved.length > 0);
  assert.ok(resolved.every((d: { scope: string }) => d.scope === "current"),
    "omitting scopes resolves to current alone");
}

/** A request cannot widen its own access by carrying an owner or an index name: those are
 *  resolved from the authenticated context and the registry, and a request that names them is
 *  refused rather than having them read as data. */
async function caseRequestCannotSmuggleOwnerOrIndex(): Promise<void> {
  for (const smuggled of [{ owner_id: OWNER_P }, { index_name: "p-index" }, { audience: "shared" }]) {
    assert.throws(
      () => resolveCorpora({ owner_id: OWNER_Q, shared_allowed: false }, smuggled, REGISTRY),
      /INVALID_INPUT|invalid/i,
      `a request carrying ${Object.keys(smuggled)[0]} must be refused, not read as data`,
    );
  }
}

const VISIBILITY_CASES: Readonly<Record<string, () => Promise<void>>> = {
  unregistered_owner_issues_no_query: caseUnregisteredOwnerIssuesNoQuery,
  owner_predicate_separates_colliding_rows: caseOwnerPredicateSeparatesCollidingRows,
  unauthorized_reads_as_absent: caseUnauthorizedReadsAsAbsent,
  current_is_the_default_scope: caseCurrentIsTheDefaultScope,
  request_cannot_smuggle_owner_or_index: caseRequestCannotSmuggleOwnerOrIndex,
};

// ── I-17: the "fusion" case group — dedup-before-cap and cross-corpus RRF arithmetic ────────
//
// `checks/tenant-fusion-arithmetic.ts` is frozen and drives `rrf`/`budgets`/`resultKey` on
// opaque string keys; it cannot see whether a REAL pipeline collapses passages before or after
// applying a lane's cap, because it never builds a `RankedRow`. These cases exercise
// `collapseBeforeCap` and `rrf` the way the real orchestrator (I-17's `lanes.ts`) actually
// calls them, on fixtures shaped like real lane output — the mutation the task's own report
// calls out (cap-then-dedup) fails one of these by distinct-artifact COUNT, not incidentally.

const OWNER_A = "55555555-5555-4555-8555-555555555555";

function passageIdentity(artifactSuffix: string, revision = 1): { identity: { owner_id: string; artifact_id: string; revision: number; content_hash: string; scope: string }; row: { artifact: string } } {
  const artifactId = `66666666-6666-4666-8666-${artifactSuffix.padStart(12, "0")}`;
  return {
    identity: { owner_id: OWNER_A, artifact_id: artifactId, revision, content_hash: "c".repeat(64), scope: "current" },
    row: { artifact: artifactSuffix },
  };
}

/** THE CASE THE MUTATION TEST NAMES. Artifact A contributes three ranked passages before
 *  artifact B, C, D each contribute one. Dedup-before-cap over a cap of 4 keeps one row per
 *  artifact and returns all four distinct artifacts (A, B, C, D). Capping first — the
 *  mutation this task's report asks to be provoked and observed — would slice to A's three
 *  passages plus B, collapsing to only two distinct artifacts: "a page of results that is
 *  really three documents". The assertion is on the distinct-artifact COUNT, not on any
 *  particular row surviving, so it fails for that reason and no other. */
async function caseDedupCollapsesPassagesBeforeTheCap(): Promise<void> {
  const rows = [
    passageIdentity("000000000001"), passageIdentity("000000000001"), passageIdentity("000000000001"),
    passageIdentity("000000000002"), passageIdentity("000000000003"), passageIdentity("000000000004"),
  ];
  const collapsed = collapseBeforeCap(rows, 4);
  const distinctArtifacts = new Set(collapsed.map((r) => resultKey(r.identity)));
  assert.equal(distinctArtifacts.size, 4,
    "dedup-before-cap must return four distinct artifacts, not the first four ranked rows");
  assert.equal(collapsed.length, 4);
}

/** The same artifact ranked #1 in both a private and a shared corpus, within the SAME lane,
 *  must contribute once to that lane's fused score — "the same artifact in private and shared
 *  corpus contributes at most once per lane, taking the better local contribution" (retrieval
 *  contract). A mutation that summed per-corpus contributions instead of taking their max
 *  would double the private/shared artifact's score relative to one that appeared in only one
 *  corpus; this case fails on that exact doubling, not on an incidental total. */
async function caseSharedAndPrivateNeverDoubleCountWithinALane(): Promise<void> {
  const lists = [
    { lane: "lexical", corpus: "private", keys: ["shared-artifact", "private-only"] },
    { lane: "lexical", corpus: "shared", keys: ["shared-artifact"] },
  ];
  const scores = new Map(rrf(lists).map((x) => [x.key, x.score]));
  assert.ok(Math.abs(scores.get("shared-artifact")! - 1 / 61) < 1e-12,
    "an artifact ranked #1 in both its private and shared corpus contributes once per lane, at its best rank");
  assert.ok(Math.abs(scores.get("private-only")! - 1 / 62) < 1e-12);
}

const FUSION_CASES: Readonly<Record<string, () => Promise<void>>> = {
  dedup_collapses_passages_before_the_cap: caseDedupCollapsesPassagesBeforeTheCap,
  shared_and_private_never_double_count_within_a_lane: caseSharedAndPrivateNeverDoubleCountWithinALane,
};

// ── I-18: the "query" and "cursor" case groups — grammar, wire response, pinned reads ──────
//
// `retrieval-query.ts` (`parseQuery`/`serializeResults`/`matchesArtifact`) and
// `retrieval-cursor.ts` (provenance cursors, pinned dereference, read-your-write freshness)
// are this task's own split, following the `retrieval-lanes.ts` pattern I-17 already set.

const CASE_GROUPS: Readonly<Record<string, Readonly<Record<string, () => Promise<void>>>>> = {
  visibility: VISIBILITY_CASES,
  fusion: FUSION_CASES,
  lanes: LANE_CASES,
  query: QUERY_CASES,
  cursor: CURSOR_CASES,
};

interface CaseResult { readonly status: "passed" | "failed" | "not_run"; readonly reason?: string }
interface SuiteDetail { readonly status: "blocked" | "ran"; readonly cases: Readonly<Record<string, CaseResult>> }
interface SuiteOutcome { readonly passed: boolean; readonly detail: SuiteDetail }

/** `verify --suite retrieval`'s entry point; anything not a known case group is `not_run`. */
export async function run({ cases }: { cases?: string }): Promise<SuiteOutcome> {
  if (cases !== undefined && !(cases in CASE_GROUPS)) {
    const names = Object.values(CASE_GROUPS).flatMap((g) => Object.keys(g));
    return {
      passed: false,
      detail: {
        status: "blocked",
        cases: Object.fromEntries(names.map((n) => [n, {
          status: "not_run" as const,
          reason: `only the ${Object.keys(CASE_GROUPS).map((g) => `"${g}"`).join(" and ")} case group(s) exist so far`,
        }])),
      },
    };
  }
  const groups = cases === undefined ? Object.keys(CASE_GROUPS) : [cases];
  const results: Record<string, CaseResult> = {};
  for (const group of groups) {
    for (const [name, run1] of Object.entries(CASE_GROUPS[group])) {
      try {
        await run1();
        results[name] = { status: "passed" };
      } catch (err) {
        results[name] = { status: "failed", reason: err instanceof Error ? err.message : String(err) };
      }
    }
  }
  return {
    passed: Object.values(results).every((r) => r.status === "passed"),
    detail: { status: "ran", cases: results },
  };
}
