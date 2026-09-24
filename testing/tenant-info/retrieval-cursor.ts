/**
 * The "cursor" case group: provenance cursors, pinned dereference and read-your-write
 * freshness (`pinned-read.ts`).
 *
 * COUPLED: merged into `retrieval.ts`'s `CASE_GROUPS`, alongside `retrieval-lanes.ts` and
 * `retrieval-query.ts`.
 */
import assert from "node:assert/strict";

import {
  decodeCursor, dereferencePinned, encodeCursor, waitForOwnStoreFreshness,
} from "../../services/zz-core/dist/tenant-info/pinned-read.js";
import type { CursorPayload, FreshnessOutcome, PinnedReadResult, PinnedReadTarget } from "../../services/zz-core/dist/tenant-info/pinned-read.js";

const OWNER = "55555555-5555-4555-8555-555555555555";
const ARTIFACT = "66666666-6666-4666-8666-666666666666";
const KEY = "fixture-cursor-hmac-key";

const PAYLOAD: CursorPayload = {
  caller_id: "caller-1", owner_id: OWNER, artifact_id: ARTIFACT, revision: 3, sequence: 42,
  record_digest: "c".repeat(64),
};

// Provenance cursors: round trip, tamper, malformed

async function caseCursorRoundTripsExactly(): Promise<void> {
  const cursor = encodeCursor(KEY, PAYLOAD);
  assert.deepEqual(decodeCursor(KEY, cursor), PAYLOAD);
}

async function caseTamperedCursorFailsAuthentication(): Promise<void> {
  const cursor = encodeCursor(KEY, PAYLOAD);
  const parts = cursor.split(".");
  const tampered = [parts[0], parts[1], `${parts[2]!.slice(0, -1)}${parts[2]!.slice(-1) === "A" ? "B" : "A"}`].join(".");
  assert.throws(() => decodeCursor(KEY, tampered),
    (e: unknown) => e instanceof Error && "code" in e && (e as { code: unknown }).code === "INVALID_INPUT");
}

async function caseWrongKeyFailsAuthentication(): Promise<void> {
  const cursor = encodeCursor(KEY, PAYLOAD);
  assert.throws(() => decodeCursor("a different key entirely", cursor),
    (e: unknown) => e instanceof Error && "code" in e && (e as { code: unknown }).code === "INVALID_INPUT");
}

async function caseMalformedCursorRefusesRatherThanCrashing(): Promise<void> {
  for (const bad of ["", "not-a-cursor", "c1.onlyonepart", "wrongversion.body.sig"]) {
    assert.throws(() => decodeCursor(KEY, bad),
      (e: unknown) => e instanceof Error && "code" in e && (e as { code: unknown }).code === "INVALID_INPUT",
      `expected ${JSON.stringify(bad)} to be refused as INVALID_INPUT`);
  }
}

// Pinned dereference: reauthorize every call, never fall back to latest

interface Row { readonly corpus_key: string; readonly owner_id: string; readonly artifact_id: string; readonly revision: number; readonly content_hash: string }

function fakeVisibilityClient(rows: readonly Row[]) {
  return {
    query: async <T>(text: string, params: readonly unknown[]) => {
      const conjuncts = [...text.matchAll(/(\w+) = \$(\d+)/g)].map((m) => [m[1], params[Number(m[2]) - 1]] as const);
      return { rows: rows.filter((r) => conjuncts.every(([col, want]) => (r as unknown as Record<string, unknown>)[col] === want)) as unknown as T[] };
    },
  };
}

const REGISTRY = [{ corpus_key: "owner-current", owner_id: OWNER, scope: "current", audience: "private", index_name: "i" }];
const CONTEXT = { owner_id: OWNER, shared_allowed: false };

async function caseDereferencePinnedReauthorizesAndSurfacesContentHashAsDigest(): Promise<void> {
  const client = fakeVisibilityClient([{ corpus_key: "owner-current", owner_id: OWNER, artifact_id: ARTIFACT, revision: 2, content_hash: "d".repeat(64) }]);
  const target: PinnedReadTarget = { owner_id: OWNER, artifact_id: ARTIFACT, scope: "current" };
  const result: PinnedReadResult = await dereferencePinned(client, CONTEXT, REGISTRY, target);
  assert.equal(result.ref.content_hash, "d".repeat(64));
  assert.equal(result.record_digest, "d".repeat(64), "no separate record_digest column exists on the search tables — see this file's own named gap");
}

/** Revocation is never deferred: a target the registry no longer authorizes, or a row the
 *  table no longer has, answers `NOT_FOUND_OR_FORBIDDEN` — there is no branch here that falls
 *  back to whatever "latest" happens to resolve to. */
async function caseRevokedOrAbsentTargetNeverFallsBackToLatest(): Promise<void> {
  const client = fakeVisibilityClient([]);
  await assert.rejects(
    dereferencePinned(client, CONTEXT, REGISTRY, { owner_id: OWNER, artifact_id: ARTIFACT, scope: "current" }),
    (e: unknown) => e instanceof Error && "code" in e && (e as { code: unknown }).code === "NOT_FOUND_OR_FORBIDDEN",
  );
  const unauthorizedContext = { owner_id: "99999999-9999-4999-8999-999999999999", shared_allowed: false };
  await assert.rejects(
    dereferencePinned(client, unauthorizedContext, REGISTRY, { owner_id: OWNER, artifact_id: ARTIFACT, scope: "current" }),
    (e: unknown) => e instanceof Error && "code" in e && (e as { code: unknown }).code === "NOT_FOUND_OR_FORBIDDEN",
  );
}

async function caseHistoryDereferenceRequiresAnExplicitRevision(): Promise<void> {
  const client = fakeVisibilityClient([{ corpus_key: "owner-current", owner_id: OWNER, artifact_id: ARTIFACT, revision: 1, content_hash: "e".repeat(64) }]);
  const historyRegistry = [{ ...REGISTRY[0]!, scope: "history" }];
  await assert.rejects(
    dereferencePinned(client, CONTEXT, historyRegistry, { owner_id: OWNER, artifact_id: ARTIFACT, scope: "history" }),
    /INVALID_INPUT|explicit revision/i,
  );
}

// Read-your-write freshness: min_commit_sequence versus indexed_through

async function caseNoMinCommitSequenceIsImmediatelyReady(): Promise<void> {
  let calls = 0;
  const outcome: FreshnessOutcome = await waitForOwnStoreFreshness(OWNER, undefined, async () => { calls++; return {}; }, 1000);
  assert.equal(outcome.ready, true);
  assert.equal(calls, 0, "an omitted min_commit_sequence never polls at all");
}

async function caseFreshnessReachedBeforeDeadlineReportsReady(): Promise<void> {
  let call = 0;
  const refresh = async () => { call++; return { [OWNER]: call >= 3 ? 10 : 1 }; };
  let clock = 0;
  const outcome: FreshnessOutcome = await waitForOwnStoreFreshness(
    OWNER, 10, refresh, 1000, () => clock, async () => { clock += 10; },
  );
  assert.equal(outcome.ready, true);
  assert.ok(call >= 3);
}

/** "stale results never claim read-your-write" (spec): a store that never catches up within
 *  the deadline reports `projection_pending`, not a silent downgrade to whatever it had. */
async function caseFreshnessNeverReachedReportsProjectionPending(): Promise<void> {
  let clock = 0;
  const outcome: FreshnessOutcome = await waitForOwnStoreFreshness(
    OWNER, 999, async () => ({ [OWNER]: 1 }), 100, () => clock, async () => { clock += 50; },
  );
  assert.equal(outcome.ready, false);
  assert.equal(outcome.reason, "projection_pending");
}

export const CURSOR_CASES: Readonly<Record<string, () => Promise<void>>> = {
  cursor_round_trips_exactly: caseCursorRoundTripsExactly,
  tampered_cursor_fails_authentication: caseTamperedCursorFailsAuthentication,
  wrong_key_fails_authentication: caseWrongKeyFailsAuthentication,
  malformed_cursor_refuses_rather_than_crashing: caseMalformedCursorRefusesRatherThanCrashing,
  dereference_pinned_reauthorizes_and_surfaces_content_hash_as_digest: caseDereferencePinnedReauthorizesAndSurfacesContentHashAsDigest,
  revoked_or_absent_target_never_falls_back_to_latest: caseRevokedOrAbsentTargetNeverFallsBackToLatest,
  history_dereference_requires_an_explicit_revision: caseHistoryDereferenceRequiresAnExplicitRevision,
  no_min_commit_sequence_is_immediately_ready: caseNoMinCommitSequenceIsImmediatelyReady,
  freshness_reached_before_deadline_reports_ready: caseFreshnessReachedBeforeDeadlineReportsReady,
  freshness_never_reached_reports_projection_pending: caseFreshnessNeverReachedReportsProjectionPending,
};
