/**
 * transitions.ts — the two lifecycle handlers: what an approval or a status change binds to,
 * and what a supersession must establish about both of its participants.
 *
 * COUPLED: `checks/tenant-lifecycle-matrix.ts` imports `decideTransition` from `policies.js` by
 * name and its bytes are frozen, so the matrix decision and the record digest stay there and
 * the handlers that call them live here.
 *
 * An approval binds to the revision and the record digest, so content or effective provenance
 * moving underneath it invalidates the approval rather than carrying a signature onto bytes
 * nobody read. A native knowledge edit returns the concept to draft, so an old verification
 * cannot come to describe new content. A supersession is one atomic batch and refuses
 * self-replacement, a cycle, a missing replacement and cross-owner retirement — the kernel's
 * `getHead` takes an id so both participants can be checked here, without the kernel ever
 * learning what a supersession is.
 */
import { randomUUID } from "node:crypto";

import {
  ArtifactEventSchema,
  type ArtifactEvent,
  KnowledgeStatusSchema,
  ArtifactRefSchema,
  type ArtifactRef,
  type MutationRequest,
} from "@zz/contracts";

import type { ArtifactHead, PolicyContext, PolicyOutcome } from "./mutations.js";
import { decideTransition, recordDigestOf, invalid, resolveRef, SHA256_RE, LIFECYCLE_EVENT_KIND, type LifecycleOp } from "./policies.js";

/** `approve`/`verify`/`set_knowledge_status`/`publish`/`unpublish` share one shape: none
 *  touch content, all bind to the revision and record digest the caller asserts is current,
 *  and `decideTransition` is the one gate for class/operation/authorization/gate/binding. A
 *  SourceArtifact is refused structurally (`head.revision === null`) before the caller's
 *  declared `artifact_class` is consulted, so a lie about class buys it no lifecycle. */
export function handleLifecycleTransition(request: MutationRequest, ctx: PolicyContext, head: ArtifactHead, op: LifecycleOp): PolicyOutcome {
  const artifactId = request.artifact_id as string;
  const raw = request.payload;
  if (request.artifact_class === undefined) return { ok: false, error: invalid(`${op} requires artifact_class`) };
  if (typeof raw.reason !== "string" || !raw.reason.trim()) return { ok: false, error: invalid(`${op} requires a non-empty reason`) };
  if (typeof raw.expected_revision !== "number") return { ok: false, error: invalid(`${op} requires expected_revision`) };
  if (typeof raw.expected_record_digest !== "string" || !SHA256_RE.test(raw.expected_record_digest)) {
    return { ok: false, error: invalid(`${op} requires expected_record_digest as a full 64-character lowercase SHA-256 digest`) };
  }
  if (op === "set_knowledge_status" && !KnowledgeStatusSchema.safeParse(raw.status).success) {
    return { ok: false, error: invalid("set_knowledge_status requires status: draft, stable or deprecated") };
  }
  if (head.revision === null) return { ok: false, error: invalid(`${op} is refused on ${artifactId} — it is an immutable source with no gate or knowledge lifecycle`) };

  const decision = decideTransition({
    artifact_class: request.artifact_class, operation: op, actor_authorized: true,
    gate_declared: op === "approve" ? raw.gate_declared === true : true,  // NOT A TOOL: MutationOp
    current_revision: head.revision, expected_revision: raw.expected_revision,
    record_digest: recordDigestOf(head), expected_record_digest: raw.expected_record_digest,
    reason: raw.reason,
  });
  if (!decision.accepted) {
    return { ok: false, error: { committed: false, code: decision.code ?? "INVALID_INPUT", message: `${op} refused for ${artifactId}` } };
  }

  const now = new Date().toISOString();
  const data: Record<string, unknown> = { reason: raw.reason };
  if (op === "set_knowledge_status") data.status = raw.status;
  const event: ArtifactEvent = {
    event_id: randomUUID(), transaction_id: ctx.transaction_id, owner_id: ctx.owner_id, artifact_id: artifactId,
    sequence: ctx.sequence, at: now, actor: ctx.actor, kind: LIFECYCLE_EVENT_KIND[op],
    revision: head.revision, content_hash: head.content_hash, cause_refs: [...request.cause_refs], data,
  };
  if (!ArtifactEventSchema.safeParse(event).success) return { ok: false, error: invalid(`prepared ${op} event failed validation`) };
  return {
    ok: true,
    result: {
      artifact_id: artifactId, changed: false, revision: head.revision, content_hash: head.content_hash,
      file_changes: [], source_captures: [], revisions: [], events: [event], blobs: [],
    },
  };
}

/** Knowledge supersession: one atomic batch (both events share this request's own
 *  `transaction_id`/`sequence`) that deprecates the old concept and records the replacement
 *  edge as the `superseded` event's `cause_refs`. Self-replacement is `CYCLE_REFUSED` — the
 *  same reasoning `checkCauses` already applies to a cause naming its own request, since a
 *  self-reference is the one cycle a single request can reach; cross-owner is
 *  `NOT_FOUND_OR_FORBIDDEN`; an unresolved replacement is `UNRESOLVED_CAUSE`, as any bad cause
 *  reference is elsewhere in this file. */
export function handleSupersede(request: MutationRequest, ctx: PolicyContext, head: ArtifactHead): PolicyOutcome {
  const artifactId = request.artifact_id as string;
  const raw = request.payload;
  if (request.artifact_class !== "knowledge_concept") {
    return { ok: false, error: invalid("supersede requires artifact_class: knowledge_concept — it is not a work-document operation") };
  }
  if (head.revision === null) {
    return { ok: false, error: invalid(`supersede is refused on ${artifactId} — it is an immutable source`) };
  }
  if (typeof raw.reason !== "string" || !raw.reason.trim()) return { ok: false, error: invalid("supersede requires a non-empty reason") };
  const replacement = raw.replacement as Partial<ArtifactRef> | undefined;
  if (!replacement || typeof replacement.artifact_id !== "string") {
    return { ok: false, error: invalid("supersede requires payload.replacement, an ArtifactRef naming the replacement concept") };
  }
  if (replacement.artifact_id === artifactId) {
    return { ok: false, error: { committed: false, code: "CYCLE_REFUSED", message: "a concept cannot supersede itself" } };
  }
  if (replacement.owner_id !== ctx.owner_id) {
    return { ok: false, error: { committed: false, code: "NOT_FOUND_OR_FORBIDDEN", message: "cross-owner retirement is refused — a replacement must be in this same owner's store" } };
  }
  const parsedReplacement = ArtifactRefSchema.safeParse(replacement);
  if (!parsedReplacement.success || !resolveRef(parsedReplacement.data, ctx, new Map(), artifactId)) {
    return { ok: false, error: { committed: false, code: "UNRESOLVED_CAUSE", message: `replacement ${JSON.stringify(replacement.artifact_id)} does not resolve to a known revision/hash` } };
  }

  const now = new Date().toISOString();
  const supersededEvent: ArtifactEvent = {
    event_id: randomUUID(), transaction_id: ctx.transaction_id, owner_id: ctx.owner_id, artifact_id: artifactId,
    sequence: ctx.sequence, at: now, actor: ctx.actor, kind: "superseded", revision: head.revision, content_hash: head.content_hash,
    cause_refs: [parsedReplacement.data], data: { reason: raw.reason },
  };
  const deprecatedEvent: ArtifactEvent = {
    event_id: randomUUID(), transaction_id: ctx.transaction_id, owner_id: ctx.owner_id, artifact_id: artifactId,
    sequence: ctx.sequence, at: now, actor: ctx.actor, kind: "status_changed", revision: head.revision, content_hash: head.content_hash,
    cause_refs: [parsedReplacement.data], data: { status: "deprecated", reason: raw.reason },
  };
  for (const event of [supersededEvent, deprecatedEvent]) {
    if (!ArtifactEventSchema.safeParse(event).success) return { ok: false, error: invalid("prepared supersession event failed validation") };
  }
  return {
    ok: true,
    result: {
      artifact_id: artifactId, changed: false, revision: head.revision, content_hash: head.content_hash,
      file_changes: [], source_captures: [], revisions: [], events: [supersededEvent, deprecatedEvent], blobs: [],
    },
  };
}

// The dispatcher
