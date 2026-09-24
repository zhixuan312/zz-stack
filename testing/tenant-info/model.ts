/**
 * The "semantic-policy" case group: `policies.ts`'s native `Policy` bound into the real
 * `mutate()` kernel, exercised against a fresh temporary owner-store.
 * COUPLED: `scripts/tenant-info/suites.ts` reserves the name "model" at this path, so
 * `verify --suite model` dynamic-imports it and calls `run`.
 *
 * Every fixture lives under a fresh `mkdtemp` outside this checkout. Nothing here points at a
 * deployment volume or this repository, and no fixture is adjusted to make a deliberately
 * broken request pass.
 */
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { rmSync } from "node:fs";

import type { ArtifactRef } from "@zz/contracts";

import {
  captureSource, patchDocument, approveDocument, readDocumentBody, toOutcomeView, writeDocument,
  type ArtifactPorts, type MutationOutcomeView,
} from "../../services/zz-core/dist/persist.js";
import { mutate, type AuthContext } from "../../services/zz-core/dist/tenant-info/mutations.js";
import { nativePolicy, recordDigestOf } from "../../services/zz-core/dist/tenant-info/policies.js";
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

// Fixtures: a source in its own transaction, and a document that cites it

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

// The case group

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
    // The source and the document that cites it are minted in two separate transactions —
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

    // The staged source is durably committed, not discarded after this transaction: a later,
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
    // DELIBERATE: the wrong hash for this source — the policy must refuse it outright, not
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

/**
 * A cause asserting a foreign owner is refused, with every other identity component correct so
 * that only the owner field can be what refuses it.
 *
 * `resolveRef` must compare `owner_id` as well as artifact, revision and hash, on both
 * resolution paths: the staged map when the artifact is in the same batch, and `getHead`
 * otherwise. A false owner that commits lives permanently in the ContentRevision's
 * `cause_refs` and in the `created` event's, both append-only.
 *
 * DELIBERATE: the code is `UNRESOLVED_CAUSE`, not a "wrong owner" code. "Found, but not yours"
 * must not leak to a caller probing for another tenant's artifact ids.
 */
async function caseForeignOwnerCauseIsRefused(): Promise<void> {
  const FOREIGN = "99999999-9999-4999-8999-999999999999";
  await withRoot(async (root) => {
    const doc = await seedDocument(root);

    // The honest ref first: identical in every field but owner, and it must still work — a
    // guard that refuses everything would pass the negative half of this case and break writes.
    const honest = await runMutate(root, req({
      operation: "revise", artifact_id: doc.id, expected_etag: doc.etag,
      cause_refs: [doc.cause], payload: payload({ body: "cited by an honest ref\n" }),
    }));
    assert.equal(honest.committed, true, "a cause naming this store's own owner must still resolve");

    const foreign = { ...doc.cause, owner_id: FOREIGN };
    assert.equal(foreign.artifact_id, doc.cause.artifact_id, "only the owner field may differ");
    assert.equal(foreign.content_hash, doc.cause.content_hash);
    assert.equal(foreign.revision, doc.cause.revision);

    const committedDoc = honest.committed === true ? honest : undefined;
    const result = await runMutate(root, req({
      operation: "revise", artifact_id: doc.id,
      expected_etag: committedDoc?.etag ?? doc.etag,
      cause_refs: [foreign], payload: payload({ body: "would-be foreign-owner citation\n" }),
    }));
    assert.equal(result.committed, false,
      "a cause_ref asserting another owner must not commit — it would write a false provenance " +
      "edge into append-only records that nothing can later correct");
    if (result.committed === false) assert.equal(result.code, "UNRESOLVED_CAUSE");

    // The staged door, closed too: a source minted in this very batch, cited with a foreign owner.
    const staged = await runMutate(root, req({
      payload: payload({
        new_sources: [{
          artifact_id: "5b5b5b5b-5b5b-4b5b-8b5b-5b5b5b5b5b5b", content: "staged evidence\n",
          original_path: "e.txt", title: "E", media_type: "text/plain",
        }],
      }),
      cause_refs: [{ owner_id: FOREIGN, artifact_id: "5b5b5b5b-5b5b-4b5b-8b5b-5b5b5b5b5b5b", revision: null, content_hash: createHash("sha256").update(Buffer.from("staged evidence\n", "utf8")).digest("hex") }],
    }));
    assert.equal(staged.committed, false,
      "the staged-record path resolves refs too, and must refuse a foreign owner the same way");
  });
}

/**
 * A stale-revision cause is refused and the refusal names the current revision, while a ref
 * this owner cannot see stays generic. Naming the revision discloses nothing an owner cannot
 * already read; a generic message everywhere would refuse a committed, present record in the
 * same words as a fabricated hash.
 *
 * `resolveRef` refuses every foreign-owner ref before this branch is reachable, so a matching
 * owner here means the caller owns the store being described.
 */
async function caseStaleRevisionCauseNamesTheCurrentRevision(): Promise<void> {
  await withRoot(async (root) => {
    const doc = await seedDocument(root);
    const concept = await seedSource(root);
    const stale = refFor(concept.id, null, concept.hash);

    // Revise the cited artifact so the ref the caller holds is no longer head. A source has no
    // revisions, so use the document itself as the cited artifact instead.
    const revised = await runMutate(root, req({
      operation: "revise", artifact_id: doc.id, expected_etag: doc.etag,
      cause_refs: [stale], payload: payload({ body: "now at revision two\n" }),
    }));
    assert.equal(revised.committed, true, JSON.stringify(revised));
    if (revised.committed !== true) return;
    assert.equal(revised.revision, 2);

    // Now cite revision 1 of that document — committed, present, and no longer head.
    const staleDocRef = refFor(doc.id, 1, doc.hash);
    const result = await runMutate(root, req({ cause_refs: [staleDocRef] }));
    assert.equal(result.committed, false, "a cause must resolve against the current revision");
    if (result.committed !== false) return;
    assert.equal(result.code, "UNRESOLVED_CAUSE");
    assert.match(result.message, /revision 1/,
      "the refusal must name the revision the caller cited");
    assert.match(result.message, /current revision, which is 2/,
      "and the revision that is current — otherwise a present, committed, owned record is " +
      "refused in the same words as a fabricated hash");

    // A ref this caller does not own stays generic: no revision numbers, nothing to probe with.
    const foreign = { ...staleDocRef, owner_id: "99999999-9999-4999-8999-999999999999" };
    const foreignResult = await runMutate(root, req({ cause_refs: [foreign] }));
    assert.equal(foreignResult.committed, false);
    if (foreignResult.committed !== false) return;
    assert.doesNotMatch(foreignResult.message, /current revision/,
      "a foreign-owner ref must not learn anything about this store from the refusal");
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
  foreign_owner_cause_is_refused: caseForeignOwnerCauseIsRefused,
  stale_revision_cause_names_the_current_revision: caseStaleRevisionCauseNamesTheCurrentRevision,
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

// createAdapterFixture — real registered handlers, real kernel, disposable store
//
// COUPLED: `checks/tenant-single-writer.ts` (frozen) imports this by name. It wraps
// `persist.ts`'s captureSource/writeDocument/patchDocument/approveDocument/readDocumentBody —
// the real adapters, bound to the real `mutate()`/`nativePolicy` kernel — over a fresh
// `makeStoreRoot()` this fixture owns, supplying only the `auth` port those functions accept
// and never a second mutate()/policy call. `seedDocument` captures one real fixture source and
// keeps it as the default cause for every later edit, so a check exercising `patch`/`approve`
// never passes an empty `cause_refs` to get past CAUSE_REQUIRED.

interface AdapterRef {
  readonly ref: ArtifactRef;
  readonly etag: string;
  readonly record_digest: string;
  readonly artifact_id: string;
}

interface AdapterFixture {
  seedDocument(input: { readonly body: string }): Promise<AdapterRef>;
  patch(request: {
    readonly ref: ArtifactRef; readonly body: string;
    readonly expected_etag?: string; readonly idempotency_key: string;
  }): Promise<MutationOutcomeView>;
  // NOT A TOOL: this fixture method mirrors the kernel's own `approve` MutationOp; the MCP
  // tool is document_approve.
  approve(request: {
    readonly ref: ArtifactRef; readonly record_digest: string;
    readonly expected_etag?: string; readonly idempotency_key: string;
  }): Promise<MutationOutcomeView>;
  // `string | undefined`, not `string`: the frozen check reads `.artifact_id` straight off a
  // `MutationOutcomeView`, where it is optional, with no narrowing. `undefined` is refused
  // here at runtime, not at the type.
  read(artifactId: string | undefined): Promise<{ readonly body: string }>;
  // NOT A TOOL: releases this fixture's own disposable store — no door registers a `close`.
  close(): Promise<void>;
}

export async function createAdapterFixture(): Promise<AdapterFixture> {
  const root = makeStoreRoot();
  const ports: ArtifactPorts = { root, auth: { owner_id: randomUUID(), actor: "adapter-fixture" } };
  let defaultCause: ArtifactRef | null = null;

  function requireCause(): ArtifactRef {
    if (!defaultCause) throw new Error("createAdapterFixture: seedDocument must run before an edit");
    return defaultCause;
  }

  return {
    async seedDocument({ body }) {
      const source = await captureSource(ports, {
        content: `fixture-source-${randomUUID()}\n`, original_path: "fixture.txt",
        title: "Fixture source", media_type: "text/plain",
      }, `fixture-source-${randomUUID()}`);
      if (source.committed !== true) throw new Error(`createAdapterFixture: source capture failed: ${JSON.stringify(source)}`);
      const cause: ArtifactRef = {
        owner_id: ports.auth.owner_id, artifact_id: source.artifact_id, revision: null, content_hash: source.content_hash,
      };
      defaultCause = cause;
      const created = await writeDocument(ports, { body }, [cause], `fixture-doc-${randomUUID()}`);
      if (created.committed !== true) throw new Error(`createAdapterFixture: seedDocument failed: ${JSON.stringify(created)}`);
      return {
        ref: { owner_id: ports.auth.owner_id, artifact_id: created.artifact_id, revision: created.revision, content_hash: created.content_hash },
        etag: created.etag, artifact_id: created.artifact_id,
        record_digest: recordDigestOf({ content_hash: created.content_hash, head_event_sequence: created.commit_sequence ?? 0 }),
      };
    },
    patch: async (request) => toOutcomeView(await patchDocument(ports, {
      artifact_id: request.ref.artifact_id, expected_etag: request.expected_etag,
      idempotency_key: request.idempotency_key, seed: { body: request.body }, cause_refs: [requireCause()],
    })),
    approve: async (request) => toOutcomeView(await approveDocument(ports, {
      artifact_id: request.ref.artifact_id, expected_etag: request.expected_etag,
      idempotency_key: request.idempotency_key, reason: "adapter fixture approval",
      expected_revision: request.ref.revision ?? 0, expected_record_digest: request.record_digest,
    })),
    async read(artifactId) {
      if (!artifactId) throw new Error("createAdapterFixture: read requires an artifact_id");
      const doc = readDocumentBody(root, artifactId);
      if (!doc) throw new Error(`createAdapterFixture: no materialized document for ${artifactId}`);
      return doc;
    },
    // NOT A TOOL: same as the interface method above — this releases the fixture's own store.
    async close() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}
