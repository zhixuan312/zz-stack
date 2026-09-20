/**
 * lifecycle.ts — I-10's "transition-matrix" case group: `policies.ts`'s independent gate,
 * knowledge and closure transitions (`decideTransition`, `handleLifecycleTransition`,
 * `handleSupersede`, and the `move` slot guard), exercised through the real `mutate()` kernel
 * against a fresh temporary owner-store — exactly the way `model.ts` exercises I-9's native
 * semantic policy. `scripts/tenant-info/suites.ts` reserves the name "lifecycle" at this path,
 * so `verify --suite lifecycle` dynamic-imports it and calls `run`.
 *
 * EVERY FIXTURE LIVES UNDER A FRESH `mkdtemp` OUTSIDE THIS CHECKOUT, removed in every case's
 * `finally` — `makeStoreRoot`/`withRoot` are `model.ts`'s own, reused here rather than copied.
 * Nothing here ever touches `ZZ_TENANT_INFO_WORKSPACE`, a deployment volume, or this
 * repository as a record root.
 *
 * WHAT `decideTransition`'S OWN MATRIX ALREADY PROVES, this file does not re-prove: the
 * frozen check at `checks/tenant-lifecycle-matrix.ts` pins its class/operation/authorization/
 * gate/revision/digest decision directly. What is left for this suite is everything only the
 * bound kernel can show — that a real `approve`/`verify`/`set_knowledge_status`/`supersede`/
 * `move` request actually reaches that decision with the right revision and record digest,
 * that a supersession batch commits as one atomic transaction, and that a correction to an
 * already-approved revision cannot retroactively validate under the old signature.
 *
 * "CORRECTING A CLOSED REPORT" IS TESTED IN THIS STORE'S OWN VOCABULARY, not the legacy flow
 * system's initiative/closing-document one. Tenant-info has no `outcome`/`closed_by` — its
 * closest analogue is an `approved` event pinned to a revision and record digest. This suite's
 * `correction_of_a_signed_revision_*` cases show the property the spec asks for in that
 * vocabulary: the original `approved` result is never mutated, and a correction (a new
 * revision) leaves the old expected revision/digest refused rather than silently still valid.
 * The legacy system's OWN closing-pointer/second-close guarantee — `guards.ts`'s
 * `closeCheck`/`closedDocumentGuard` — is unrelated code with zero import coupling to this
 * kernel (verified by inspection, not simulated here); the task report names the exact checks
 * that already exercise it.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import type { ArtifactRef } from "@zz/contracts";

import { mutate, type AuthContext } from "../../services/zz-core/dist/tenant-info/mutations.js";
import { decideTransition, nativePolicy, recordDigestOf } from "../../services/zz-core/dist/tenant-info/policies.js";
import { makeStoreRoot } from "./persistence.ts";

const AUTH: AuthContext = { owner_id: "66666666-6666-4666-8666-666666666666", actor: "lifecycle-suite" };
const OTHER_OWNER = "77777777-7777-4777-8777-777777777777";

function refFor(artifactId: string, revision: number | null, contentHash: string, ownerId = AUTH.owner_id): ArtifactRef {
  return { owner_id: ownerId, artifact_id: artifactId, revision, content_hash: contentHash };
}

function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: "t", description: "d", type: "Decision", tags: [], body: "line one\n",
    resource: null, content_fields: {}, ...overrides,
  };
}

function req(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    operation: "create", idempotency_key: `lifecycle-${randomUUID()}`,
    artifact_class: "work_document", payload: payload(), cause_refs: [], ...overrides,
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

// ── fixtures ─────────────────────────────────────────────────────────────────────────────

async function seedSource(root: string): Promise<{ id: string; hash: string }> {
  const result = await runMutate(root, req({
    artifact_class: "source",
    payload: { content: `source-${randomUUID()}\n`, original_path: "s.txt", title: "S", media_type: "text/plain" },
  }));
  assert.equal(result.committed, true, `seed source failed: ${JSON.stringify(result)}`);
  if (result.committed !== true) throw new Error("unreachable");
  return { id: result.artifact_id, hash: result.content_hash };
}

async function seedArtifact(root: string, artifactClass: "work_document" | "knowledge_concept"): Promise<{
  id: string; etag: string; hash: string; revision: number; cause: ArtifactRef; sequence: number;
}> {
  const source = await seedSource(root);
  const cause = refFor(source.id, null, source.hash);
  const result = await runMutate(root, req({ artifact_class: artifactClass, cause_refs: [cause] }));
  assert.equal(result.committed, true, `seed ${artifactClass} failed: ${JSON.stringify(result)}`);
  if (result.committed !== true) throw new Error("unreachable");
  return { id: result.artifact_id, etag: result.etag, hash: result.content_hash, revision: 1, cause, sequence: result.commit_sequence ?? 1 };
}

function digestFor(hash: string, sequence: number): string {
  return recordDigestOf({ content_hash: hash, head_event_sequence: sequence });
}

// ── the case group ───────────────────────────────────────────────────────────────────────

async function caseSourceVerifyIsInvalidInput(): Promise<void> {
  await withRoot(async (root) => {
    const created = await runMutate(root, req({
      artifact_class: "source",
      payload: { content: `source-${randomUUID()}\n`, original_path: "s2.txt", title: "S2", media_type: "text/plain" },
    }));
    assert.equal(created.committed, true);
    if (created.committed !== true) return;
    const result = await runMutate(root, {
      operation: "verify", idempotency_key: `lifecycle-${randomUUID()}`, artifact_id: created.artifact_id,
      artifact_class: "source", expected_etag: created.etag, cause_refs: [],
      payload: { reason: "fixture", expected_revision: 0, expected_record_digest: "a".repeat(64) },
    });
    assert.equal(result.committed, false, "verifying a source must be refused");
    if (result.committed === false) assert.equal(result.code, "INVALID_INPUT");
  });
}

async function caseKnowledgeApproveIsInvalidInput(): Promise<void> {
  await withRoot(async (root) => {
    const concept = await seedArtifact(root, "knowledge_concept");
    const result = await runMutate(root, {
      operation: "approve", /* NOT A TOOL: MutationOp */ idempotency_key: `lifecycle-${randomUUID()}`, artifact_id: concept.id,
      artifact_class: "knowledge_concept", expected_etag: concept.etag, cause_refs: [],
      payload: { reason: "fixture", gate_declared: true, expected_revision: 1, expected_record_digest: digestFor(concept.hash, concept.sequence) },
    });
    assert.equal(result.committed, false, "approving a knowledge concept must be refused");
    if (result.committed === false) assert.equal(result.code, "INVALID_INPUT");
  });
}

async function caseUngatedWorkCannotBeApproved(): Promise<void> {
  await withRoot(async (root) => {
    const doc = await seedArtifact(root, "work_document");
    const result = await runMutate(root, {
      operation: "approve", /* NOT A TOOL: MutationOp */ idempotency_key: `lifecycle-${randomUUID()}`, artifact_id: doc.id,
      artifact_class: "work_document", expected_etag: doc.etag, cause_refs: [],
      payload: { reason: "fixture", gate_declared: false, expected_revision: 1, expected_record_digest: digestFor(doc.hash, doc.sequence) },
    });
    assert.equal(result.committed, false, "an undeclared gate must refuse approval");
    if (result.committed === false) assert.equal(result.code, "GATE_REFUSED");
  });
}

async function caseApprovalBindsRevisionAndDigest(): Promise<void> {
  await withRoot(async (root) => {
    const doc = await seedArtifact(root, "work_document");
    const wrongRevision = await runMutate(root, {
      operation: "approve", /* NOT A TOOL: MutationOp */ idempotency_key: `lifecycle-${randomUUID()}`, artifact_id: doc.id,
      artifact_class: "work_document", expected_etag: doc.etag, cause_refs: [],
      payload: { reason: "fixture", gate_declared: true, expected_revision: 99, expected_record_digest: digestFor(doc.hash, doc.sequence) },
    });
    assert.equal(wrongRevision.committed, false, "a wrong expected revision must never approve current content");
    if (wrongRevision.committed === false) assert.equal(wrongRevision.code, "REVISION_CONFLICT");

    const wrongDigest = await runMutate(root, {
      operation: "approve", /* NOT A TOOL: MutationOp */ idempotency_key: `lifecycle-${randomUUID()}`, artifact_id: doc.id,
      artifact_class: "work_document", expected_etag: doc.etag, cause_refs: [],
      payload: { reason: "fixture", gate_declared: true, expected_revision: 1, expected_record_digest: "b".repeat(64) },
    });
    assert.equal(wrongDigest.committed, false, "a wrong expected digest must never approve current content");
    if (wrongDigest.committed === false) assert.equal(wrongDigest.code, "REVISION_CONFLICT");

    const correct = await runMutate(root, {
      operation: "approve", /* NOT A TOOL: MutationOp */ idempotency_key: `lifecycle-${randomUUID()}`, artifact_id: doc.id,
      artifact_class: "work_document", expected_etag: doc.etag, cause_refs: [],
      payload: { reason: "fixture", gate_declared: true, expected_revision: 1, expected_record_digest: digestFor(doc.hash, doc.sequence) },
    });
    assert.equal(correct.committed, true, `a matching revision/digest must approve: ${JSON.stringify(correct)}`);
  });
}

async function caseKnowledgeStatusIndependentOfWorkGate(): Promise<void> {
  await withRoot(async (root) => {
    const doc = await seedArtifact(root, "work_document");
    const concept = await seedArtifact(root, "knowledge_concept");
    const gateRefused = await runMutate(root, {
      operation: "approve", /* NOT A TOOL: MutationOp */ idempotency_key: `lifecycle-${randomUUID()}`, artifact_id: doc.id,
      artifact_class: "work_document", expected_etag: doc.etag, cause_refs: [],
      payload: { reason: "fixture", gate_declared: false, expected_revision: 1, expected_record_digest: digestFor(doc.hash, doc.sequence) },
    });
    assert.equal(gateRefused.committed, false, "the work gate must still refuse on its own terms");

    const statusSet = await runMutate(root, {
      operation: "set_knowledge_status", idempotency_key: `lifecycle-${randomUUID()}`, artifact_id: concept.id,
      artifact_class: "knowledge_concept", expected_etag: concept.etag, cause_refs: [],
      payload: { reason: "fixture", status: "stable", expected_revision: 1, expected_record_digest: digestFor(concept.hash, concept.sequence) },
    });
    assert.equal(statusSet.committed, true, `knowledge status must transition independently of the unrelated work gate refusal: ${JSON.stringify(statusSet)}`);

    const statusOnWork = await runMutate(root, {
      operation: "set_knowledge_status", idempotency_key: `lifecycle-${randomUUID()}`, artifact_id: doc.id,
      artifact_class: "work_document", expected_etag: doc.etag, cause_refs: [],
      payload: { reason: "fixture", status: "stable", expected_revision: 1, expected_record_digest: digestFor(doc.hash, doc.sequence) },
    });
    assert.equal(statusOnWork.committed, false, "knowledge status can never approve work");
    if (statusOnWork.committed === false) assert.equal(statusOnWork.code, "INVALID_INPUT");
  });
}

/** Reads the one commit manifest a `mutate()` result's own `transaction_id` names, straight
 *  off disk — the only way to observe that a batch's events actually landed together, rather
 *  than trusting the same call that would also report a partial write as success. */
function manifestFor(root: string, transactionId: string): { events: { kind: string; transaction_id: string; revision: number | null; data: Record<string, unknown> }[] } {
  const dir = join(root, ".zz", "commits");
  for (const f of readdirSync(dir)) {
    const manifest = JSON.parse(readFileSync(join(dir, f), "utf8"));
    if (manifest.transaction_id === transactionId) return manifest;
  }
  throw new Error(`no commit manifest found for transaction ${transactionId}`);
}

async function caseSupersessionBatch(): Promise<void> {
  await withRoot(async (root) => {
    const oldConcept = await seedArtifact(root, "knowledge_concept");
    const replacement = await seedArtifact(root, "knowledge_concept");
    const result = await runMutate(root, {
      operation: "supersede", idempotency_key: `lifecycle-${randomUUID()}`, artifact_id: oldConcept.id,
      artifact_class: "knowledge_concept", expected_etag: oldConcept.etag, cause_refs: [],
      payload: { reason: "fixture", replacement: refFor(replacement.id, replacement.revision, replacement.hash) },
    });
    assert.equal(result.committed, true, `a same-owner supersession must commit as one batch: ${JSON.stringify(result)}`);
    if (result.committed !== true) return;

    // Not assertion-by-construction: this reads the durable manifest back and checks the
    // batch actually landed as one atomic transaction with both expected events, not merely
    // that `mutate()` reported success.
    const manifest = manifestFor(root, result.transaction_id ?? "");
    assert.equal(manifest.events.length, 2, "a supersession batch must commit exactly two events");
    const kinds = manifest.events.map((e) => e.kind).sort();
    assert.deepEqual(kinds, ["status_changed", "superseded"]);
    assert.ok(manifest.events.every((e) => e.transaction_id === result.transaction_id), "both events share the one transaction");
    assert.ok(manifest.events.every((e) => e.revision === oldConcept.revision), "neither event mints a new content revision");
    const deprecated = manifest.events.find((e) => e.kind === "status_changed");
    assert.equal(deprecated?.data.status, "deprecated");
  });
}

async function caseSupersedeSelfIsCycleRefused(): Promise<void> {
  await withRoot(async (root) => {
    const concept = await seedArtifact(root, "knowledge_concept");
    const result = await runMutate(root, {
      operation: "supersede", idempotency_key: `lifecycle-${randomUUID()}`, artifact_id: concept.id,
      artifact_class: "knowledge_concept", expected_etag: concept.etag, cause_refs: [],
      payload: { reason: "fixture", replacement: refFor(concept.id, concept.revision, concept.hash) },
    });
    assert.equal(result.committed, false, "a concept cannot supersede itself");
    if (result.committed === false) assert.equal(result.code, "CYCLE_REFUSED");
  });
}

async function caseSupersedeCrossOwnerRefused(): Promise<void> {
  await withRoot(async (root) => {
    const oldConcept = await seedArtifact(root, "knowledge_concept");
    const result = await runMutate(root, {
      operation: "supersede", idempotency_key: `lifecycle-${randomUUID()}`, artifact_id: oldConcept.id,
      artifact_class: "knowledge_concept", expected_etag: oldConcept.etag, cause_refs: [],
      payload: { reason: "fixture", replacement: refFor(randomUUID(), 1, "c".repeat(64), OTHER_OWNER) },
    });
    assert.equal(result.committed, false, "cross-owner retirement must be refused");
    if (result.committed === false) assert.equal(result.code, "NOT_FOUND_OR_FORBIDDEN");
  });
}

async function caseSupersedeMissingReplacementRefused(): Promise<void> {
  await withRoot(async (root) => {
    const oldConcept = await seedArtifact(root, "knowledge_concept");
    const result = await runMutate(root, {
      operation: "supersede", idempotency_key: `lifecycle-${randomUUID()}`, artifact_id: oldConcept.id,
      artifact_class: "knowledge_concept", expected_etag: oldConcept.etag, cause_refs: [],
      payload: { reason: "fixture", replacement: refFor(randomUUID(), 1, "d".repeat(64)) },
    });
    assert.equal(result.committed, false, "a replacement that resolves to nothing must be refused");
    if (result.committed === false) assert.equal(result.code, "UNRESOLVED_CAUSE");
  });
}

async function caseGatedSpecMoveRefusal(): Promise<void> {
  await withRoot(async (root) => {
    const doc = await seedArtifact(root, "work_document");
    const outsideSlot = await runMutate(root, {
      operation: "move", idempotency_key: `lifecycle-${randomUUID()}`, artifact_id: doc.id,
      expected_etag: doc.etag, cause_refs: [doc.cause],
      payload: { from: "initiative-a/spec.md", to: "initiative-b/spec.md", governing_flow_slots: ["initiative-a/spec.md"] },
    });
    assert.equal(outsideSlot.committed, false, "a move outside the governing flow's declared slots must be refused");
    if (outsideSlot.committed === false) assert.equal(outsideSlot.code, "GATE_REFUSED");

    const insideSlot = await runMutate(root, {
      operation: "move", idempotency_key: `lifecycle-${randomUUID()}`, artifact_id: doc.id,
      expected_etag: doc.etag, cause_refs: [doc.cause],
      payload: { from: "initiative-a/spec.md", to: "initiative-a/spec-v2.md", governing_flow_slots: ["initiative-a/spec.md", "initiative-a/spec-v2.md"] },
    });
    assert.equal(insideSlot.committed, true, `a move inside a declared slot must be allowed: ${JSON.stringify(insideSlot)}`);
  });
}

async function caseProvenanceCorrectionInvalidatesOldDigest(): Promise<void> {
  await withRoot(async (root) => {
    const doc = await seedArtifact(root, "work_document");
    const staleDigest = digestFor(doc.hash, doc.sequence);
    const corrected = await runMutate(root, {
      operation: "correct_provenance", idempotency_key: `lifecycle-${randomUUID()}`, artifact_id: doc.id,
      expected_etag: doc.etag, cause_refs: [doc.cause], payload: { reason: "citation metadata was wrong" },
    });
    assert.equal(corrected.committed, true, JSON.stringify(corrected));
    if (corrected.committed !== true) return;

    const staleVerify = await runMutate(root, {
      operation: "verify", idempotency_key: `lifecycle-${randomUUID()}`, artifact_id: doc.id,
      artifact_class: "work_document", expected_etag: corrected.etag, cause_refs: [],
      payload: { reason: "fixture", expected_revision: 1, expected_record_digest: staleDigest },
    });
    assert.equal(staleVerify.committed, false, "a digest captured before the correction must no longer verify");
    if (staleVerify.committed === false) assert.equal(staleVerify.code, "REVISION_CONFLICT");

    const freshVerify = await runMutate(root, {
      operation: "verify", idempotency_key: `lifecycle-${randomUUID()}`, artifact_id: doc.id,
      artifact_class: "work_document", expected_etag: corrected.etag, cause_refs: [],
      payload: { reason: "fixture", expected_revision: 1, expected_record_digest: digestFor(corrected.content_hash, corrected.commit_sequence ?? doc.sequence) },
    });
    assert.equal(freshVerify.committed, true, `the digest recomputed after the correction must verify: ${JSON.stringify(freshVerify)}`);
  });
}

async function caseCorrectionOfASignedRevisionNeverTransfersTheOldSignature(): Promise<void> {
  await withRoot(async (root) => {
    const doc = await seedArtifact(root, "work_document");
    const originalDigest = digestFor(doc.hash, doc.sequence);
    const approved = await runMutate(root, {
      operation: "approve", /* NOT A TOOL: MutationOp */ idempotency_key: `lifecycle-${randomUUID()}`, artifact_id: doc.id,
      artifact_class: "work_document", expected_etag: doc.etag, cause_refs: [],
      payload: { reason: "sign-off", gate_declared: true, expected_revision: 1, expected_record_digest: originalDigest },
    });
    assert.equal(approved.committed, true, JSON.stringify(approved));
    if (approved.committed !== true) return;
    // The historical signature is exactly what `approve` returned — captured once, and this
    // suite never mutates a manifest to check that it "stayed"; it stayed because nothing here
    // writes over a commit. What is tested is the property that matters operationally: it does
    // not transfer.
    assert.equal(approved.revision, 1);
    assert.equal(approved.content_hash, doc.hash);

    const corrected = await runMutate(root, {
      operation: "revise", artifact_id: doc.id, idempotency_key: `lifecycle-${randomUUID()}`,
      expected_etag: approved.etag, cause_refs: [doc.cause], payload: payload({ body: "corrected body\n" }),
    });
    assert.equal(corrected.committed, true, JSON.stringify(corrected));
    if (corrected.committed !== true) return;
    assert.equal(corrected.revision, 2, "a correction is a new sequential revision, never the old one rewritten");

    const staleApprove = await runMutate(root, {
      operation: "approve", /* NOT A TOOL: MutationOp */ idempotency_key: `lifecycle-${randomUUID()}`, artifact_id: doc.id,
      artifact_class: "work_document", expected_etag: corrected.etag, cause_refs: [],
      payload: { reason: "reusing the old signature", gate_declared: true, expected_revision: 1, expected_record_digest: originalDigest },
    });
    assert.equal(staleApprove.committed, false, "the old revision/digest must never approve the corrected content");
    if (staleApprove.committed === false) assert.equal(staleApprove.code, "REVISION_CONFLICT");

    const freshApprove = await runMutate(root, {
      operation: "approve", /* NOT A TOOL: MutationOp */ idempotency_key: `lifecycle-${randomUUID()}`, artifact_id: doc.id,
      artifact_class: "work_document", expected_etag: corrected.etag, cause_refs: [],
      payload: { reason: "fresh sign-off", gate_declared: true, expected_revision: 2, expected_record_digest: digestFor(corrected.content_hash, corrected.commit_sequence ?? 0) },
    });
    assert.equal(freshApprove.committed, true, `the corrected revision earns its own, separate approval: ${JSON.stringify(freshApprove)}`);
  });
}

async function caseDecideTransitionMatrixMirrorsTheFrozenCheck(): Promise<void> {
  const ctx = {
    artifact_class: "work_document", operation: "approve", /* NOT A TOOL: MutationOp */ actor_authorized: true, gate_declared: true,
    current_revision: 2, expected_revision: 2, record_digest: "a".repeat(64), expected_record_digest: "a".repeat(64), reason: "fixture",
  };
  assert.equal(decideTransition(ctx).accepted, true);
  assert.equal(decideTransition({ ...ctx, operation: "publish" }).accepted, true, "publish is valid on a work document");
  assert.equal(decideTransition({ ...ctx, artifact_class: "source", operation: "publish" }).code, "INVALID_INPUT");
  assert.equal(decideTransition({ ...ctx, operation: "supersede" }).code, "INVALID_INPUT", "supersede is knowledge-only");
  assert.equal(decideTransition({ ...ctx, artifact_class: "knowledge_concept", operation: "supersede" }).accepted, true);
}

const CASES: Readonly<Record<string, () => Promise<void>>> = {
  source_verify_is_invalid_input: caseSourceVerifyIsInvalidInput,
  knowledge_approve_is_invalid_input: caseKnowledgeApproveIsInvalidInput,
  ungated_work_cannot_be_approved: caseUngatedWorkCannotBeApproved,
  approval_binds_revision_and_digest: caseApprovalBindsRevisionAndDigest,
  knowledge_status_independent_of_work_gate: caseKnowledgeStatusIndependentOfWorkGate,
  supersession_batch: caseSupersessionBatch,
  supersede_self_is_cycle_refused: caseSupersedeSelfIsCycleRefused,
  supersede_cross_owner_refused: caseSupersedeCrossOwnerRefused,
  supersede_missing_replacement_refused: caseSupersedeMissingReplacementRefused,
  gated_spec_move_refusal: caseGatedSpecMoveRefusal,
  provenance_correction_invalidates_old_digest: caseProvenanceCorrectionInvalidatesOldDigest,
  correction_of_a_signed_revision_never_transfers_the_old_signature: caseCorrectionOfASignedRevisionNeverTransfersTheOldSignature,
  decide_transition_matrix_mirrors_the_frozen_check: caseDecideTransitionMatrixMirrorsTheFrozenCheck,
};

const CASE_GROUPS: Readonly<Record<string, Readonly<Record<string, () => Promise<void>>>>> = {
  "transition-matrix": CASES,
};

interface CaseResult { readonly status: "passed" | "failed" | "not_run"; readonly reason?: string }
interface SuiteDetail { readonly status: "blocked" | "ran"; readonly cases: Readonly<Record<string, CaseResult>> }
interface SuiteOutcome { readonly passed: boolean; readonly detail: SuiteDetail }

/** `verify --suite lifecycle`'s entry point, same shape as `model.ts`'s. */
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
