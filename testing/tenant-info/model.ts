/**
 * model.ts — I-9's "semantic-policy" case group: `policies.ts`'s native `Policy` bound into
 * the real `mutate()` kernel, exercised against a fresh temporary owner-store, exactly the
 * way `persistence.ts` exercises I-7/I-8. `scripts/tenant-info/suites.ts` reserves the name
 * "model" at this path, so `verify --suite model` dynamic-imports it and calls `run`.
 *
 * EVERY FIXTURE LIVES UNDER A FRESH `mkdtemp` OUTSIDE THIS CHECKOUT, exactly as `persistence.ts`
 * requires — see that file's header for why. Nothing here ever points at a deployment volume
 * or this repository.
 *
 * WHAT THESE CASES ACTUALLY PROVE, per the plan's own list: a create makes revision 1; a
 * semantic edit (including a description-only one) makes the next sequential revision; a
 * canonical no-op — byte-identical, or only reordered tags — makes none, but still advances
 * the etag with its own event; returning to an earlier revision's exact bytes still mints a
 * new, higher revision number; a source created in its own transaction and one created in the
 * SAME batch as the document that cites it both resolve as valid causes; a source is refused
 * a revision of its own; a cause naming the wrong hash, an empty `cause_refs`, and a cause
 * naming the artifact it would itself belong to are each refused BY THE POLICY — this file
 * never adjusts a fixture to make a deliberately-broken request pass.
 */
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { rmSync } from "node:fs";

import type { ArtifactRef } from "@zz/contracts";

import { mutate, type AuthContext } from "../../services/zz-core/dist/tenant-info/mutations.js";
import { nativePolicy } from "../../services/zz-core/dist/tenant-info/policies.js";
import { makeStoreRoot } from "./persistence.ts";

const AUTH: AuthContext = { owner_id: "55555555-5555-4555-8555-555555555555", actor: "model-suite" };

function refFor(artifactId: string, revision: number | null, contentHash: string): ArtifactRef {
  return { owner_id: AUTH.owner_id, artifact_id: artifactId, revision, content_hash: contentHash };
}

function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: "t", description: "d", type: "Decision", tags: ["a", "b"],
    body: "line one\n", resource: null, content_fields: {},
    ...overrides,
  };
}

function req(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    operation: "create", idempotency_key: `model-${randomUUID()}`,
    artifact_class: "work_document", payload: payload(), cause_refs: [],
    ...overrides,
  };
}

function runMutate(root: string, request: unknown): ReturnType<typeof mutate> {
  return mutate({ root, request, auth: AUTH, policy: nativePolicy });
}

async function withRoot(body: (root: string) => Promise<void>): Promise<void> {
  const root = makeStoreRoot();
  try {
    await body(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ── fixtures: a source in its own transaction, and a document that cites it ────────────────

async function seedSource(root: string): Promise<{ id: string; hash: string; etag: string }> {
  const result = await runMutate(root, req({
    artifact_class: "source",
    payload: { content: `source-${randomUUID()}\n`, original_path: "s.txt", title: "S", media_type: "text/plain" },
  }));
  assert.equal(result.committed, true, `seed source failed: ${JSON.stringify(result)}`);
  if (result.committed !== true) throw new Error("unreachable");
  return { id: result.artifact_id, hash: result.content_hash, etag: result.etag };
}

async function seedDocument(root: string): Promise<{ id: string; etag: string; hash: string; revision: number; cause: ArtifactRef }> {
  const source = await seedSource(root);
  const cause = refFor(source.id, null, source.hash);
  const result = await runMutate(root, req({ cause_refs: [cause] }));
  assert.equal(result.committed, true, `seed document failed: ${JSON.stringify(result)}`);
  if (result.committed !== true) throw new Error("unreachable");
  assert.equal(result.revision, 1, "a native create must land at revision 1");
  return { id: result.artifact_id, etag: result.etag, hash: result.content_hash, revision: 1, cause };
}

// ── the case group ───────────────────────────────────────────────────────────────────────

async function caseCreateMakesRevisionOne(): Promise<void> {
  await withRoot(async (root) => {
    const doc = await seedDocument(root);
    assert.equal(doc.revision, 1);
  });
}

async function caseSemanticChangeMakesNextRevision(): Promise<void> {
  await withRoot(async (root) => {
    const doc = await seedDocument(root);
    const result = await runMutate(root, req({
      operation: "revise", artifact_id: doc.id, expected_etag: doc.etag, cause_refs: [doc.cause],
      payload: payload({ body: "changed body\n" }),
    }));
    assert.equal(result.committed, true, JSON.stringify(result));
    if (result.committed !== true) return;
    assert.equal(result.revision, 2, "a semantic edit must land at exactly the previous revision plus one");
    assert.equal(result.changed, true);
    assert.notEqual(result.content_hash, doc.hash);
  });
}

async function caseDescriptionOnlyChangeIsSemantic(): Promise<void> {
  await withRoot(async (root) => {
    const doc = await seedDocument(root);
    const result = await runMutate(root, req({
      operation: "revise", artifact_id: doc.id, expected_etag: doc.etag, cause_refs: [doc.cause],
      payload: payload({ description: "a materially different description" }),
    }));
    assert.equal(result.committed, true, JSON.stringify(result));
    if (result.committed !== true) return;
    assert.equal(result.revision, 2, "description is a semantic field — editing only it must still version");
    assert.equal(result.changed, true);
  });
}

async function caseCanonicalNoOpMakesNoRevision(): Promise<void> {
  await withRoot(async (root) => {
    const doc = await seedDocument(root);
    const result = await runMutate(root, req({
      operation: "revise", artifact_id: doc.id, expected_etag: doc.etag, cause_refs: [doc.cause], payload: payload(),
    }));
    assert.equal(result.committed, true, JSON.stringify(result));
    if (result.committed !== true) return;
    assert.equal(result.changed, false, "a byte-identical payload must be a canonical no-op");
    assert.equal(result.revision, doc.revision, "a no-op must mint no new revision");
    assert.equal(result.content_hash, doc.hash);
    assert.notEqual(result.etag, doc.etag, "a no-op still advances the state etag");
  });
}

async function caseTagReorderIsNoOpTagChangeIsNot(): Promise<void> {
  await withRoot(async (root) => {
    const doc = await seedDocument(root);
    const reordered = await runMutate(root, req({
      operation: "revise", artifact_id: doc.id, expected_etag: doc.etag, cause_refs: [doc.cause],
      payload: payload({ tags: ["b", "a", "b"] }),
    }));
    assert.equal(reordered.committed, true, JSON.stringify(reordered));
    if (reordered.committed !== true) return;
    assert.equal(reordered.changed, false, "reordering (and duplicating) an identical tag set must be a no-op");
    assert.equal(reordered.revision, doc.revision);

    const changed = await runMutate(root, req({
      operation: "revise", artifact_id: doc.id, expected_etag: reordered.etag, cause_refs: [doc.cause],
      payload: payload({ tags: ["a", "c"] }),
    }));
    assert.equal(changed.committed, true, JSON.stringify(changed));
    if (changed.committed !== true) return;
    assert.equal(changed.changed, true, "changing a tag string must version, unlike reordering");
    assert.equal(changed.revision, 2);
  });
}

async function caseReturnToOldContentMakesNewSequentialRevision(): Promise<void> {
  await withRoot(async (root) => {
    const doc = await seedDocument(root);
    const second = await runMutate(root, req({
      operation: "revise", artifact_id: doc.id, expected_etag: doc.etag, cause_refs: [doc.cause],
      payload: payload({ body: "second body\n" }),
    }));
    assert.equal(second.committed, true, JSON.stringify(second));
    if (second.committed !== true) return;
    assert.equal(second.revision, 2);

    const third = await runMutate(root, req({
      operation: "revise", artifact_id: doc.id, expected_etag: second.etag, cause_refs: [doc.cause], payload: payload(),
    }));
    assert.equal(third.committed, true, JSON.stringify(third));
    if (third.committed !== true) return;
    assert.equal(third.revision, 3, "returning to an earlier revision's bytes still mints a new sequential revision");
    assert.equal(third.content_hash, doc.hash, "the repeated hash is exactly revision 1's, proving this really is a return");
  });
}

async function caseAttachBeforeDocument(): Promise<void> {
  await withRoot(async (root) => {
    // The source and the document that cites it are minted in two SEPARATE transactions —
    // "attach before document" in the ordering sense, as against the same-batch case below.
    const doc = await seedDocument(root);
    const attach = await runMutate(root, req({
      operation: "attach_input", artifact_id: doc.id, expected_etag: doc.etag, cause_refs: [doc.cause],
      payload: { note: "attached after the document already existed" },
    }));
    assert.equal(attach.committed, true, JSON.stringify(attach));
    if (attach.committed !== true) return;
    assert.equal(attach.changed, false, "attaching an input is an event, never a synthetic content edit");
    assert.equal(attach.revision, doc.revision);
    assert.equal(attach.content_hash, doc.hash);
  });
}

async function caseMoveRecordsEventNotRevision(): Promise<void> {
  await withRoot(async (root) => {
    const doc = await seedDocument(root);
    const moved = await runMutate(root, req({
      operation: "move", artifact_id: doc.id, expected_etag: doc.etag, cause_refs: [doc.cause],
      payload: { from: "old/path.md", to: "new/path.md" },
    }));
    assert.equal(moved.committed, true, JSON.stringify(moved));
    if (moved.committed !== true) return;
    assert.equal(moved.changed, false, "a move/alias is an event, never a content revision");
    assert.equal(moved.revision, doc.revision);
    assert.equal(moved.content_hash, doc.hash);
  });
}

async function caseSameBatchSourceCreation(): Promise<void> {
  await withRoot(async (root) => {
    const newSourceId = randomUUID();
    const content = `same-batch-${randomUUID()}\n`;
    const hash = createHash("sha256").update(Buffer.from(content, "utf8")).digest("hex");
    const result = await runMutate(root, req({
      cause_refs: [refFor(newSourceId, null, hash)],
      payload: payload({
        new_sources: [{ artifact_id: newSourceId, content, original_path: "ns.txt", title: "NS", media_type: "text/plain" }],
      }),
    }));
    assert.equal(result.committed, true, JSON.stringify(result));
    if (result.committed !== true) return;
    assert.equal(result.revision, 1, "the document minted alongside its own source must still land at revision 1");

    // The staged source is durably committed, not discarded after this transaction: a LATER,
    // separate revise can still cite it by the same id/hash.
    const again = await runMutate(root, req({
      operation: "revise", artifact_id: result.artifact_id, expected_etag: result.etag,
      cause_refs: [refFor(newSourceId, null, hash)], payload: payload({ body: "revised after batch\n" }),
    }));
    assert.equal(again.committed, true, `the same-batch source must resolve again from a later, separate transaction: ${JSON.stringify(again)}`);
  });
}

async function caseSourceIsImmutableOnceCreated(): Promise<void> {
  await withRoot(async (root) => {
    const source = await seedSource(root);
    const result = await runMutate(root, req({
      operation: "revise", artifact_id: source.id, expected_etag: source.etag, cause_refs: [], payload: payload(),
    }));
    assert.equal(result.committed, false, "a source must never accept a content revision");
    if (result.committed === false) assert.equal(result.code, "SOURCE_IMMUTABLE");
  });
}

async function caseSourceHashChangeIsRefused(): Promise<void> {
  await withRoot(async (root) => {
    const source = await seedSource(root);
    // Deliberately the WRONG hash for this source — the policy must refuse it outright, not
    // have this fixture quietly substitute the real hash to make the request pass.
    const badCause = refFor(source.id, null, "0".repeat(64));
    const result = await runMutate(root, req({ cause_refs: [badCause] }));
    assert.equal(result.committed, false, "a cause citing a source's wrong hash must be refused, not silently repaired");
    if (result.committed === false) assert.equal(result.code, "UNRESOLVED_CAUSE");
  });
}

async function caseMissingCauseIsRefused(): Promise<void> {
  await withRoot(async (root) => {
    const result = await runMutate(root, req({ cause_refs: [] }));
    assert.equal(result.committed, false, "a native create with no declared cause must be refused, not defaulted");
    if (result.committed === false) assert.equal(result.code, "CAUSE_REQUIRED");
  });
}

async function caseSelfReferenceCauseIsCycleRefused(): Promise<void> {
  await withRoot(async (root) => {
    const doc = await seedDocument(root);
    const selfCause = refFor(doc.id, doc.revision, doc.hash);
    const result = await runMutate(root, req({
      operation: "revise", artifact_id: doc.id, expected_etag: doc.etag, cause_refs: [selfCause],
      payload: payload({ body: "would-be self-caused edit\n" }),
    }));
    assert.equal(result.committed, false, "a cause naming the artifact it would itself belong to is the one reachable cycle");
    if (result.committed === false) assert.equal(result.code, "CYCLE_REFUSED");
  });
}

async function caseProvenanceCorrectionDoesNotEraseOriginalEdges(): Promise<void> {
  await withRoot(async (root) => {
    const doc = await seedDocument(root);
    const corrected = await runMutate(root, req({
      operation: "correct_provenance", artifact_id: doc.id, expected_etag: doc.etag, cause_refs: [doc.cause],
      payload: { reason: "citation metadata was wrong, content was not" },
    }));
    assert.equal(corrected.committed, true, JSON.stringify(corrected));
    if (corrected.committed !== true) return;
    assert.equal(corrected.changed, false, "a provenance correction on unchanged content is an event, not a new revision");
    assert.equal(corrected.revision, doc.revision, "the originally asserted revision is never erased or replaced by a correction");
    assert.equal(corrected.content_hash, doc.hash);
  });
}

const CASES: Readonly<Record<string, () => Promise<void>>> = {
  create_makes_revision_one: caseCreateMakesRevisionOne,
  semantic_change_makes_next_revision: caseSemanticChangeMakesNextRevision,
  description_only_change_is_semantic: caseDescriptionOnlyChangeIsSemantic,
  canonical_no_op_makes_no_revision: caseCanonicalNoOpMakesNoRevision,
  tag_reorder_is_no_op_tag_change_is_not: caseTagReorderIsNoOpTagChangeIsNot,
  return_to_old_content_makes_new_sequential_revision: caseReturnToOldContentMakesNewSequentialRevision,
  attach_before_document: caseAttachBeforeDocument,
  move_records_event_not_revision: caseMoveRecordsEventNotRevision,
  same_batch_source_creation: caseSameBatchSourceCreation,
  source_is_immutable_once_created: caseSourceIsImmutableOnceCreated,
  source_hash_change_is_refused: caseSourceHashChangeIsRefused,
  missing_cause_is_refused: caseMissingCauseIsRefused,
  self_reference_cause_is_cycle_refused: caseSelfReferenceCauseIsCycleRefused,
  provenance_correction_does_not_erase_original_edges: caseProvenanceCorrectionDoesNotEraseOriginalEdges,
};

const CASE_GROUPS: Readonly<Record<string, Readonly<Record<string, () => Promise<void>>>>> = {
  "semantic-policy": CASES,
};

interface CaseResult { readonly status: "passed" | "failed" | "not_run"; readonly reason?: string }
interface SuiteDetail { readonly status: "blocked" | "ran"; readonly cases: Readonly<Record<string, CaseResult>> }
interface SuiteOutcome { readonly passed: boolean; readonly detail: SuiteDetail }

/** `verify --suite model`'s entry point, same shape as `persistence.ts`'s. */
export async function run({ cases }: { cases?: string }): Promise<SuiteOutcome> {
  if (cases !== undefined && !(cases in CASE_GROUPS)) {
    const allNames = Object.values(CASE_GROUPS).flatMap((g) => Object.keys(g));
    const notRun = Object.fromEntries(allNames.map((name) => [
      name, { status: "not_run" as const, reason: `only the ${Object.keys(CASE_GROUPS).map((g) => `"${g}"`).join(" and ")} case group exists so far` },
    ]));
    return { passed: false, detail: { status: "blocked", cases: notRun } };
  }
  const groupNames = cases === undefined ? Object.keys(CASE_GROUPS) : [cases];
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
  return { passed: Object.values(results).every((r) => r.status === "passed"), detail: { status: "ran", cases: results } };
}
