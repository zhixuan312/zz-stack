/**
 * policies.ts — I-9's native semantic/provenance policy: the one thing `mutations.ts` (I-8)
 * deliberately left as an injected interface. This module decides WHAT a mutation writes —
 * which fields changed, whether that change earns a new `ContentRevision` or only an
 * `ArtifactEvent`, and what a cause has to resolve to before a mutation is allowed to happen
 * at all. The kernel's lock, etag and idempotency machinery is unaware of any of this.
 *
 * THE COMMITTED/STAGED RECORD RESOLVER THE CONTRACT NAMES IS TWO THINGS, NOT A THIRD
 * INTERFACE. `PolicyContext.getHead` (I-8's) resolves anything already committed in this
 * owner's store; a plain `Map` built inside one policy call resolves anything this SAME
 * request is about to create (a source cited by the document that mints it, in one
 * transaction). Nothing here needs an injected resolver beyond those two, because a single
 * `Policy` invocation only ever produces one batch.
 *
 * WHAT COUNTS AS A SOURCE, STRUCTURALLY. A `SourceArtifact` never carries a content revision
 * (the contract's own words); `ArtifactHead.revision === null` is exactly that fact, already
 * recorded by the kernel's replay. This module never re-derives "is this a source" any other
 * way — not from `artifact_class` on the request, which describes intent to CREATE one, not
 * an existing artifact's nature.
 *
 * CANONICALIZATION IS THE ONLY DEFINITION OF "THE SAME CONTENT". `canonicalHash` and `isNoOp`
 * are exported because the frozen check pins their exact behaviour; `content_hash` on every
 * `ContentRevision` this module writes is `canonicalHash` of the SAME canonicalized payload
 * that revision stores — never the raw request — so a later no-op comparison is a single
 * hash equality against `ArtifactHead.content_hash`, with no need to re-fetch a full payload.
 *
 * SCOPE. `create`, `revise`, `move`, `attach_input`, `disposition_input` and
 * `correct_provenance` are native here. `approve`, `verify`, `set_knowledge_status`,
 * `publish`, `unpublish` and `supersede` are I-10's independent gate/knowledge/closure
 * transitions, bound through `decideTransition` below. Only `import_legacy` remains
 * unhandled — that is `migrate.ts`'s, not this task's.
 *
 * `PolicyContext.getHead` (I-8's, outside this task's edit surface) resolves only
 * `revision`/`content_hash`/`head_event_sequence` — no committed
 * revision's `cause_refs`/`sources`, no flow declaration. So: a state operation's class is the
 * CALLER's declared value, checked only structurally against `head.revision === null`;
 * `recordDigestOf` folds in `head_event_sequence` rather than the spec's provenance-set/flow-
 * contract digest (see its own comment); and `decideTransition` never authorizes by role —
 * `nativePolicy` passes `actor_authorized: true` since `ctx.actor` is already authenticated. */
import { randomUUID, createHash } from "node:crypto";

import {
  semanticFields,
  SemanticPayloadSchema,
  SourceCitationSchema,
  type SourceCitation,
  ContentRevisionSchema,
  type ContentRevision,
  ArtifactEventSchema,
  type ArtifactEvent,
  type ArtifactEventKind,
  SourceCaptureSchema,
  type SourceCapture,
  type ArtifactRef,
  type MutationRequest,
  type MutationError,
} from "@zz/contracts";

import { assertWithinInputLimit, InputTooLargeError } from "@zz/indexing";

import type { ArtifactHead, Policy, PolicyContext, PolicyOutcome } from "./mutations.js";
import { handleLifecycleTransition, handleSupersede } from "./transitions.js";

// ── canonicalization: the one definition of "the same content" ─────────────────────────────

function crlfToLf(value: string): string {
  return value.replace(/\r\n/g, "\n");
}

/** Recursively sorts object keys and normalizes CRLF in every string it finds. Never trims,
 *  lowercases or otherwise rewrites a string's own bytes — only line endings. */
function canonicalValue(value: unknown): unknown {
  if (typeof value === "string") return crlfToLf(value);
  if (Array.isArray(value)) return value.map((v) => canonicalValue(v));
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) out[key] = canonicalValue(record[key]);
    return out;
  }
  return value;
}

function canonicalTags(tags: unknown): string[] {
  const list = Array.isArray(tags) ? tags.filter((t): t is string => typeof t === "string") : [];
  return [...new Set(list.map(crlfToLf))].sort();
}

/**
 * The canonical form of a raw payload: every rule the spec names, in one place. `description`
 * absent becomes `""`, `resource` absent becomes `null`, tags are sorted and deduplicated,
 * `content_fields` keys are sorted recursively — and body whitespace, markdown and source
 * bytes are otherwise untouched. Loosely typed on purpose: a legacy or malformed payload must
 * canonicalize into SOMETHING that `SemanticPayloadSchema` can then accept or reject, rather
 * than throwing before validation gets a chance to name what is wrong.
 */
function canonicalPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of semanticFields) {
    if (field === "description") { out.description = crlfToLf(String(payload.description ?? "")); continue; }
    if (field === "resource") {
      const resource = payload.resource;
      out.resource = resource === null || resource === undefined ? null : crlfToLf(String(resource));
      continue;
    }
    if (field === "tags") { out.tags = canonicalTags(payload.tags); continue; }
    if (field === "content_fields") { out.content_fields = canonicalValue(payload.content_fields ?? {}); continue; }
    out[field] = canonicalValue(payload[field] ?? "");
  }
  return out;
}

/** Hand-built, not `JSON.stringify(sortedKeysObject)` — same reasoning as `record.ts`'s own
 *  `canonicalJson`: caller-controlled `content_fields` can carry an integer-looking string
 *  key, and V8's own object key iteration would silently reorder it ahead of this function's
 *  sort. Building the text by hand keeps key order under this function's control alone. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "number" || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(record[k])}`).join(",")}}`;
  }
  return "null";
}

/** The check at `checks/tenant-revision-boundary.ts` pins this function's exact behaviour —
 *  see that file for the frozen cases (tag order/dupes, CRLF, sorted `content_fields`, and
 *  which single-field edits must change the hash). */
export function canonicalHash(payload: Record<string, unknown>): string {
  return createHash("sha256").update(canonicalJson(canonicalPayload(payload)), "utf8").digest("hex");
}

/** `isNoOp(a, b)` is `canonicalHash` equality — the SAME predicate a real `revise` uses, just
 *  stated over two full payloads rather than a payload and a stored `content_hash`. The real
 *  kernel path only ever has the latter (`ArtifactHead` carries no payload), so `revise`
 *  below compares `canonicalHash(candidate) !== head.content_hash` directly; this export
 *  exists for a caller that legitimately holds both payloads, and for the frozen check. */
export function isNoOp(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  return canonicalHash(a) === canonicalHash(b);
}

// ── cause and citation resolution: committed heads, plus this request's own staged batch ───

interface StagedRecord { readonly content_hash: string; readonly revision: number | null }

export function invalid(message: string): MutationError {
  return { committed: false, code: "INVALID_INPUT", message };
}

/** A reference resolves against whichever of the two record sets actually has it — never
 *  against `selfId`, which by definition has not been (and, for a new artifact, cannot yet
 *  have been) committed. That refusal is what turns a self-citing `cause_refs` entry into
 *  "does not resolve" rather than an accidental match.
 *
 *  FOUR IDENTITY COMPONENTS, FOUR CHECKS. `owner_id` used to be the one field a caller could
 *  assert freely: this function compared artifact, revision and hash, and a ref naming a
 *  FOREIGN owner alongside this store's correct artifact/revision/hash resolved `true`. The
 *  request then committed, and the false assertion went permanently into the ContentRevision's
 *  `cause_refs` and the `created` event's — append-only records, so nothing later can correct
 *  it. `cause_refs` IS the provenance trail; an owner in it that is not the owner the artifact
 *  lives under points a future reader at another tenant's store.
 *
 *  AND THE KERNEL WAS INCONSISTENT WITH ITSELF, which is what makes this a defect rather than
 *  a design choice: `handleSupersede` (transitions.ts) already refuses a replacement whose
 *  `owner_id` is not `ctx.owner_id`, as `NOT_FOUND_OR_FORBIDDEN`. Two paths, one field, two
 *  answers.
 *
 *  It returns `false` rather than a distinct code deliberately — see `checkCauses` below:
 *  `resolveRef` cannot see WHY a reference failed, only that it did, and "found but not
 *  yours" is exactly the distinction that must not leak.
 *
 *  Found by the I-24 agent review, the first reader on this delivery who had built none of it. */
export function resolveRef(
  ref: ArtifactRef, ctx: PolicyContext, staged: ReadonlyMap<string, StagedRecord>, selfId: string,
): boolean {
  if (ref.artifact_id === selfId) return false;
  if (ref.owner_id !== ctx.owner_id) return false;
  const stagedRecord = staged.get(ref.artifact_id);
  if (stagedRecord) return stagedRecord.content_hash === ref.content_hash && stagedRecord.revision === ref.revision;
  const head = ctx.getHead(ref.artifact_id);
  if (!head) return false;
  return head.content_hash === ref.content_hash && head.revision === ref.revision;
}

/**
 * `cause_refs` in the order the Errors contract names them: empty is `CAUSE_REQUIRED`; a
 * cause naming the artifact this very request produces is the one cycle a single request can
 * reach, and is named as such (`CYCLE_REFUSED`) rather than left to fall through to the
 * generic "does not resolve"; anything left is `UNRESOLVED_CAUSE`, with no separate code for
 * "found but not yours" — `resolveRef` cannot see why a reference failed, only that it did,
 * which is what keeps that failure nonrevealing.
 */
function checkCauses(
  causeRefs: readonly ArtifactRef[], ctx: PolicyContext, staged: ReadonlyMap<string, StagedRecord>, selfId: string,
): MutationError | null {
  if (causeRefs.length === 0) return { committed: false, code: "CAUSE_REQUIRED", message: "at least one cause_refs entry is required" };
  for (const ref of causeRefs) {
    if (ref.artifact_id === selfId) {
      return { committed: false, code: "CYCLE_REFUSED", message: `cause_refs may not name the artifact this request itself produces (${selfId})` };
    }
  }
  for (const ref of causeRefs) {
    if (!resolveRef(ref, ctx, staged, selfId)) {
      return { committed: false, code: "UNRESOLVED_CAUSE", message: `cause_refs entry for ${ref.artifact_id} does not resolve to a known revision/hash` };
    }
  }
  return null;
}

// ── same-batch source creation ──────────────────────────────────────────────────────────────

interface NewSourceInput {
  readonly artifact_id: string; readonly content: string; readonly original_path: string;
  readonly title: string; readonly media_type: string; readonly original_locator: string | null;
}

/** `undefined` is "no same-batch sources", a valid and common case; anything present but not
 *  shaped like a source-to-mint is `null`, which the caller reports as `INVALID_INPUT` rather
 *  than silently dropping malformed entries. */
function parseNewSources(raw: unknown): NewSourceInput[] | null {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return null;
  const out: NewSourceInput[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") return null;
    const e = entry as Record<string, unknown>;
    if (typeof e.artifact_id !== "string" || typeof e.content !== "string" || typeof e.original_path !== "string"
      || typeof e.title !== "string" || typeof e.media_type !== "string") return null;
    out.push({
      artifact_id: e.artifact_id, content: e.content, original_path: e.original_path,
      title: e.title, media_type: e.media_type,
      original_locator: typeof e.original_locator === "string" ? e.original_locator : null,
    });
  }
  return out;
}

interface StagedSourcesBuild {
  readonly captures: SourceCapture[]; readonly events: ArtifactEvent[];
  readonly blobs: { hash: string; bytes: Uint8Array }[]; readonly staged: Map<string, StagedRecord>;
}

/** Mints one immutable `SourceCapture` (plus its own `created` event, `revision: null`) per
 *  same-batch source, and returns the staged map the document minted alongside them resolves
 *  its `cause_refs`/`sources` against — the "staged" half of the committed/staged resolver. */
function buildStagedSources(newSources: readonly NewSourceInput[], ctx: PolicyContext, now: string): StagedSourcesBuild {
  const captures: SourceCapture[] = [];
  const events: ArtifactEvent[] = [];
  const blobs: { hash: string; bytes: Uint8Array }[] = [];
  const staged = new Map<string, StagedRecord>();
  for (const src of newSources) {
    const bytes = Buffer.from(src.content, "utf8");
    const hash = createHash("sha256").update(bytes).digest("hex");
    captures.push({
      owner_id: ctx.owner_id, artifact_id: src.artifact_id, original_path: src.original_path,
      title: src.title, media_type: src.media_type, byte_length: bytes.byteLength,
      blob_hash: hash, captured_at: now, captured_by: ctx.actor, original_locator: src.original_locator,
    });
    events.push({
      event_id: randomUUID(), transaction_id: ctx.transaction_id, owner_id: ctx.owner_id, artifact_id: src.artifact_id,
      sequence: ctx.sequence, at: now, actor: ctx.actor, kind: "created", revision: null, content_hash: hash,
      cause_refs: [], data: { artifact_class: "source" },
    });
    blobs.push({ hash, bytes });
    staged.set(src.artifact_id, { content_hash: hash, revision: null });
  }
  return { captures, events, blobs, staged };
}

// ── the semantic (create/revise) preparation shared by both ────────────────────────────────

interface SemanticPreparation {
  readonly canonical: Record<string, unknown>;
  readonly hash: string;
  readonly sources: SourceCitation[];
  readonly staged: StagedSourcesBuild;
}

function isMutationError(v: SemanticPreparation | MutationError): v is MutationError {
  return (v as MutationError).committed === false;
}

/**
 * Everything `create` and `revise` share: canonicalize and validate the payload, mint any
 * same-batch sources, resolve every `sources` citation and every `cause_refs` entry against
 * the committed-plus-staged set. Returns the prepared pieces, or the one `MutationError` that
 * blocks publication — nothing here decides revision numbers, which differ between the two
 * callers.
 */
function prepareSemanticChange(
  request: MutationRequest, ctx: PolicyContext, selfId: string, now: string,
): SemanticPreparation | MutationError {
  const rawPayload = request.payload;
  const canonical = canonicalPayload(rawPayload);

  // THE 8-MiB KERNEL GATE, and until this line it did not exist as behaviour.
  //
  // `assertWithinInputLimit` and `MAX_INPUT_BYTES` were built by I-14, exported, and
  // mutation-tested by a frozen check — and every reference to either one in the whole
  // checkout belonged to that check. `PAYLOAD_TOO_LARGE` has been one of the twelve declared
  // mutation error codes since I-6 and was emitted by nothing. A contract with no
  // implementation on both halves at once: the limit could not refuse anything and the code
  // could not be returned. I-14 named the absence in its own commit — "NOT called from
  // record.ts, whichever task owns it needs one line" — and no task was ever assigned it.
  //
  // MEASURED ON THE CANONICAL PAYLOAD, which is what the code is named after. Every text a
  // revision carries is in there — title, description, body, tags, resource, content_fields —
  // so no field list here can drift out of step with `semanticFields`. The JSON structure
  // costs a few hundred bytes against a ceiling of eight million.
  //
  // BEFORE SCHEMA VALIDATION, deliberately: refusing an oversized payload should not depend on
  // it also being well-formed, and the cheap byte count should run before any work proportional
  // to the content.
  //
  // LEGACY CONTENT IS EXEMPT BY CONSTRUCTION, not by a flag. `import_legacy` never reaches this
  // function — the dispatcher at the bottom of this file routes it out by name — so oversized
  // material that predates the limit is preserved and indexed exactly as the migration
  // exception requires, and there is no boolean anyone can pass to get a new write past it.
  try {
    assertWithinInputLimit(Buffer.byteLength(canonicalJson(canonical), "utf8"));
  } catch (err) {
    if (!(err instanceof InputTooLargeError)) throw err;
    return {
      committed: false, code: "PAYLOAD_TOO_LARGE",
      message: `payload is ${err.actualBytes} bytes, over the ${err.allowedBytes}-byte limit for new artifact text`,
    };
  }

  const parsedPayload = SemanticPayloadSchema.safeParse(canonical);
  if (!parsedPayload.success) {
    return invalid(`payload failed semantic validation: ${parsedPayload.error.issues.map((i) => i.message).join("; ")}`);
  }

  const newSources = parseNewSources(rawPayload.new_sources);
  if (newSources === null) {
    return invalid("new_sources, when present, must be an array of {artifact_id, content, original_path, title, media_type}");
  }
  const staged = buildStagedSources(newSources, ctx, now);

  const rawSources = Array.isArray(rawPayload.sources) ? rawPayload.sources : [];
  const sources: SourceCitation[] = [];
  for (const entry of rawSources) {
    const parsed = SourceCitationSchema.safeParse(entry);
    if (!parsed.success) return invalid("sources entries must be valid SourceCitation records");
    if (!resolveRef(parsed.data.ref, ctx, staged.staged, selfId)) {
      return { committed: false, code: "UNRESOLVED_CAUSE", message: `sources entry ${parsed.data.id} does not resolve to a known revision/hash` };
    }
    sources.push(parsed.data);
  }

  const causeError = checkCauses(request.cause_refs, ctx, staged.staged, selfId);
  if (causeError) return causeError;

  return { canonical, hash: canonicalHash(canonical), sources, staged };
}

function bodyBlob(canonical: Record<string, unknown>): { hash: string; bytes: Uint8Array } {
  const bytes = Buffer.from(String(canonical.body ?? ""), "utf8");
  return { hash: createHash("sha256").update(bytes).digest("hex"), bytes };
}

// ── create ───────────────────────────────────────────────────────────────────────────────

function handleCreateSource(request: MutationRequest, ctx: PolicyContext, artifactId: string, now: string): PolicyOutcome {
  const raw = request.payload;
  if (typeof raw.content !== "string" || typeof raw.original_path !== "string"
    || typeof raw.title !== "string" || typeof raw.media_type !== "string") {
    return { ok: false, error: invalid("a source create requires content, original_path, title and media_type") };
  }
  const bytes = Buffer.from(raw.content, "utf8");
  const hash = createHash("sha256").update(bytes).digest("hex");
  const capture: SourceCapture = {
    owner_id: ctx.owner_id, artifact_id: artifactId, original_path: raw.original_path,
    title: raw.title, media_type: raw.media_type, byte_length: bytes.byteLength, blob_hash: hash,
    captured_at: now, captured_by: ctx.actor, original_locator: typeof raw.original_locator === "string" ? raw.original_locator : null,
  };
  if (!SourceCaptureSchema.safeParse(capture).success) return { ok: false, error: invalid("prepared source capture failed validation") };
  const event: ArtifactEvent = {
    event_id: randomUUID(), transaction_id: ctx.transaction_id, owner_id: ctx.owner_id, artifact_id: artifactId,
    sequence: ctx.sequence, at: now, actor: ctx.actor, kind: "created", revision: null, content_hash: hash,
    cause_refs: [], data: { artifact_class: "source" },
  };
  if (!ArtifactEventSchema.safeParse(event).success) return { ok: false, error: invalid("prepared source event failed validation") };
  return {
    ok: true,
    result: {
      artifact_id: artifactId, changed: true, revision: null, content_hash: hash,
      file_changes: [], source_captures: [capture], revisions: [], events: [event], blobs: [{ hash, bytes }],
    },
  };
}

function handleCreate(request: MutationRequest, ctx: PolicyContext): PolicyOutcome {
  if (request.artifact_id !== undefined) {
    return { ok: false, error: invalid("create must not name an artifact_id — the policy mints one") };
  }
  if (request.artifact_class === undefined) return { ok: false, error: invalid("create requires artifact_class") };
  const now = new Date().toISOString();
  const artifactId = randomUUID();

  if (request.artifact_class === "source") return handleCreateSource(request, ctx, artifactId, now);

  const prep = prepareSemanticChange(request, ctx, artifactId, now);
  if (isMutationError(prep)) return { ok: false, error: prep };

  const revision: ContentRevision = {
    owner_id: ctx.owner_id, artifact_id: artifactId, revision: 1, content_hash: prep.hash,
    payload: parsePayload(prep.canonical), cause_refs: [...request.cause_refs], sources: prep.sources,
    generated: { by: ctx.actor, at: now }, origin_profile: "native", legacy_unresolved_sources: [], previous_revision: null,
  };
  if (!ContentRevisionSchema.safeParse(revision).success) return { ok: false, error: invalid("prepared content revision failed validation") };
  const event: ArtifactEvent = {
    event_id: randomUUID(), transaction_id: ctx.transaction_id, owner_id: ctx.owner_id, artifact_id: artifactId,
    sequence: ctx.sequence, at: now, actor: ctx.actor, kind: "created", revision: 1, content_hash: prep.hash,
    cause_refs: [...request.cause_refs], data: { artifact_class: request.artifact_class },
  };
  if (!ArtifactEventSchema.safeParse(event).success) return { ok: false, error: invalid("prepared created event failed validation") };

  const body = bodyBlob(prep.canonical);
  return {
    ok: true,
    result: {
      artifact_id: artifactId, changed: true, revision: 1, content_hash: prep.hash,
      file_changes: [{ path: `documents/${artifactId}.md`, before_hash: null, after_hash: body.hash }],
      source_captures: prep.staged.captures, revisions: [revision], events: [...prep.staged.events, event],
      blobs: [...prep.staged.blobs, body],
    },
  };
}

// ── revise ───────────────────────────────────────────────────────────────────────────────

function handleRevise(request: MutationRequest, ctx: PolicyContext, head: ArtifactHead): PolicyOutcome {
  const artifactId = request.artifact_id as string;
  if (head.revision === null) {
    return { ok: false, error: { committed: false, code: "SOURCE_IMMUTABLE", message: `artifact ${artifactId} is an immutable source and has no content revision` } };
  }
  const now = new Date().toISOString();
  const prep = prepareSemanticChange(request, ctx, artifactId, now);
  if (isMutationError(prep)) return { ok: false, error: prep };

  if (prep.hash === head.content_hash) {
    const event: ArtifactEvent = {
      event_id: randomUUID(), transaction_id: ctx.transaction_id, owner_id: ctx.owner_id, artifact_id: artifactId,
      sequence: ctx.sequence, at: now, actor: ctx.actor, kind: "revised", revision: head.revision, content_hash: head.content_hash,
      cause_refs: [...request.cause_refs], data: { no_op: true },
    };
    if (!ArtifactEventSchema.safeParse(event).success) return { ok: false, error: invalid("prepared no-op event failed validation") };
    return {
      ok: true,
      result: {
        artifact_id: artifactId, changed: false, revision: head.revision, content_hash: head.content_hash,
        file_changes: [], source_captures: prep.staged.captures, revisions: [],
        events: [...prep.staged.events, event], blobs: prep.staged.blobs,
      },
    };
  }

  const nextRevision = head.revision + 1;
  const revision: ContentRevision = {
    owner_id: ctx.owner_id, artifact_id: artifactId, revision: nextRevision, content_hash: prep.hash,
    payload: parsePayload(prep.canonical), cause_refs: [...request.cause_refs], sources: prep.sources,
    generated: { by: ctx.actor, at: now }, origin_profile: "native", legacy_unresolved_sources: [], previous_revision: head.revision,
  };
  if (!ContentRevisionSchema.safeParse(revision).success) return { ok: false, error: invalid("prepared content revision failed validation") };
  const event: ArtifactEvent = {
    event_id: randomUUID(), transaction_id: ctx.transaction_id, owner_id: ctx.owner_id, artifact_id: artifactId,
    sequence: ctx.sequence, at: now, actor: ctx.actor, kind: "revised", revision: nextRevision, content_hash: prep.hash,
    cause_refs: [...request.cause_refs], data: {},
  };
  if (!ArtifactEventSchema.safeParse(event).success) return { ok: false, error: invalid("prepared revised event failed validation") };

  const body = bodyBlob(prep.canonical);
  return {
    ok: true,
    result: {
      artifact_id: artifactId, changed: true, revision: nextRevision, content_hash: prep.hash,
      file_changes: [{ path: `documents/${artifactId}.md`, before_hash: null, after_hash: body.hash }],
      source_captures: prep.staged.captures, revisions: [revision], events: [...prep.staged.events, event],
      blobs: [...prep.staged.blobs, body],
    },
  };
}

/** `SemanticPayloadSchema.safeParse` already accepted `canonical`; this narrows the type for
 *  `ContentRevision.payload` without a second, redundant validation pass. */
function parsePayload(canonical: Record<string, unknown>): ContentRevision["payload"] {
  return SemanticPayloadSchema.parse(canonical);
}

// ── metadata-only operations: an event, never a revision ───────────────────────────────────

const STATE_EVENT_KIND: Partial<Record<MutationRequest["operation"], ArtifactEventKind>> = {
  move: "moved",
  attach_input: "input_attached",
  disposition_input: "input_dispositioned",
  correct_provenance: "provenance_corrected",
};

/** `governing_flow_slots`, when declared, names the paths a flow-bound role may occupy (this
 *  kernel tracks no flow binding of its own). Absent, a move is freeform; present, the target
 *  must stay in the same initiative and a declared slot, or it orphans a prerequisite/gate. */
function moveRefusal(payload: Record<string, unknown>): MutationError | null {
  const from = typeof payload.from === "string" ? payload.from : null;
  const to = typeof payload.to === "string" ? payload.to : null;
  const slotsRaw = payload.governing_flow_slots;
  if (from === null || to === null || slotsRaw === undefined) return null;
  if (!Array.isArray(slotsRaw) || slotsRaw.some((s) => typeof s !== "string")) {
    return invalid("governing_flow_slots, when present, must be an array of strings");
  }
  const slots = slotsRaw as string[];
  const sameInitiative = to.split("/")[0] === from.split("/")[0];
  const inDeclaredSlot = slots.some((slot) => to === slot || to.startsWith(`${slot}/`));
  if (!sameInitiative || !inDeclaredSlot) {
    return {
      committed: false, code: "GATE_REFUSED",
      message: `move to "${to}" leaves the governing flow's declared slots (${slots.join(", ")}) — ` +
        "refused rather than orphaning this document's prerequisite or gate",
    };
  }
  return null;
}

/**
 * `move`, `attach_input`, `disposition_input` and `correct_provenance` share one shape: they
 * never touch `payload`'s semantic fields, so `data` carries the caller's payload verbatim
 * and the head's own `revision`/`content_hash` pass through untouched — exactly the
 * "independently recorded event, not a synthetic content edit" the contract requires. A
 * provenance correction's own cause is checked the same way any other cause is: it must be
 * declared and must resolve, and nothing here touches `sources`/`cause_refs` already on file
 * against an earlier revision, so an original assertion is never erased by a later one.
 */
function handleStateEvent(request: MutationRequest, ctx: PolicyContext, head: ArtifactHead, kind: ArtifactEventKind): PolicyOutcome {
  const artifactId = request.artifact_id as string;
  if (kind === "moved") {
    const moveError = moveRefusal(request.payload);
    if (moveError) return { ok: false, error: moveError };
  }
  const causeError = checkCauses(request.cause_refs, ctx, new Map(), artifactId);
  if (causeError) return { ok: false, error: causeError };

  const now = new Date().toISOString();
  const event: ArtifactEvent = {
    event_id: randomUUID(), transaction_id: ctx.transaction_id, owner_id: ctx.owner_id, artifact_id: artifactId,
    sequence: ctx.sequence, at: now, actor: ctx.actor, kind, revision: head.revision, content_hash: head.content_hash,
    cause_refs: [...request.cause_refs], data: request.payload,
  };
  if (!ArtifactEventSchema.safeParse(event).success) return { ok: false, error: invalid(`prepared ${kind} event failed validation`) };
  return {
    ok: true,
    result: {
      artifact_id: artifactId, changed: false, revision: head.revision, content_hash: head.content_hash,
      file_changes: [], source_captures: [], revisions: [], events: [event], blobs: [],
    },
  };
}

// ── I-10: the independent gate/knowledge/closure transition matrix ─────────────────────────

/** Everything `decideTransition` judges, flattened. Fields are plain `string`/`number`/
 *  `boolean` rather than the narrower `ArtifactClass`/`MutationOp` unions: the frozen check
 *  builds this object as a literal with no `as const`, and a narrower type would fail that
 *  check's own typecheck rather than exercise the decision. Unknown values refuse at runtime. */
interface TransitionContext {
  readonly artifact_class: string; readonly operation: string; readonly actor_authorized: boolean;
  readonly gate_declared: boolean; readonly current_revision: number; readonly expected_revision: number;
  readonly record_digest: string; readonly expected_record_digest: string; readonly reason: string;
}

interface TransitionDecision { readonly accepted: boolean; readonly code?: MutationError["code"] }

function refusedTransition(code: MutationError["code"]): TransitionDecision {
  return { accepted: false, code };
}

/** Which classes each lifecycle op accepts, before authorization/gate/revision checks — the
 *  spec's matrix as a table. `revise` appears only for the one fact owned here: a source
 *  never accepts one; every other class's `revise` is `handleRevise`'s decision. */
const OPERATION_CLASSES: Readonly<Record<string, ReadonlySet<string>>> = {
  approve: new Set(["work_document"]),
  verify: new Set(["work_document", "knowledge_concept"]),
  set_knowledge_status: new Set(["knowledge_concept"]),
  publish: new Set(["work_document", "knowledge_concept"]),
  unpublish: new Set(["work_document", "knowledge_concept"]),
  supersede: new Set(["knowledge_concept"]),
};

const ARTIFACT_CLASSES = new Set(["source", "work_document", "knowledge_concept"]);

/** The real subtype-policy decision: a class alone never authorizes a transition. Checked in
 *  the order the frozen check exercises it — structural class/operation refusals first (they
 *  hold regardless of authorization, gate or revision state), then authorization, then the
 *  gate declaration `approve` alone requires, then revision and digest binding. A wrong
 *  expected digest OR revision refuses — never one checked and the other assumed. */
export function decideTransition(context: TransitionContext): TransitionDecision {
  const { artifact_class: artifactClass, operation } = context;
  if (!ARTIFACT_CLASSES.has(artifactClass)) return refusedTransition("INVALID_INPUT");

  // A source accepts no gate and no lifecycle. Its own immutability refusal is named
  // distinctly from every other refusal this matrix reports.
  if (operation === "revise" && artifactClass === "source") return refusedTransition("SOURCE_IMMUTABLE");

  const allowedClasses = OPERATION_CLASSES[operation];
  if (!allowedClasses || !allowedClasses.has(artifactClass)) return refusedTransition("INVALID_INPUT");

  if (!context.actor_authorized) return refusedTransition("NOT_FOUND_OR_FORBIDDEN");
  if (operation === "approve" && !context.gate_declared) return refusedTransition("GATE_REFUSED");  // NOT A TOOL: the MutationOp, not document_approve
  if (context.current_revision !== context.expected_revision) return refusedTransition("REVISION_CONFLICT");
  if (context.record_digest !== context.expected_record_digest) return refusedTransition("REVISION_CONFLICT");
  return { accepted: true };
}

/** The record digest a lifecycle transition binds to. The spec's formula also folds in the
 *  effective provenance-reference set and a work document's flow-contract digest; neither is
 *  reachable from `PolicyContext.getHead` (I-8's, outside this edit surface), which exposes
 *  only `content_hash`/`head_event_sequence` — no committed revision's `cause_refs` and no
 *  flow declaration. Folding `head_event_sequence` in is the safe substitute: EVERY committed
 *  event advances it, so this digest invalidates a stale approval/verification at least as
 *  often as the spec's formula would (never less) — at the named cost of also invalidating
 *  across an event the spec would have left alone (a bare `moved`), a false "re-approve this"
 *  rather than a false "still current". */
export function recordDigestOf(head: Pick<ArtifactHead, "content_hash" | "head_event_sequence">): string {
  return createHash("sha256").update(`${head.content_hash}:${head.head_event_sequence}`, "utf8").digest("hex");
}

export const SHA256_RE = /^[0-9a-f]{64}$/;
export type LifecycleOp = "approve" | "verify" | "set_knowledge_status" | "publish" | "unpublish";  // NOT A TOOL: MutationOp union members
export const LIFECYCLE_EVENT_KIND: Readonly<Record<LifecycleOp, ArtifactEventKind>> = {
  approve: "approved", verify: "verified", set_knowledge_status: "status_changed",
  publish: "published", unpublish: "unpublished",
};

const LIFECYCLE_OPS = new Set<string>(["approve", "verify", "set_knowledge_status", "publish", "unpublish"]);  // NOT A TOOL: MutationOp names

export const nativePolicy: Policy = (request, ctx) => {
  if (request.operation === "create") return handleCreate(request, ctx);

  const artifactId = request.artifact_id;
  if (artifactId === undefined) return { ok: false, error: invalid(`operation "${request.operation}" requires artifact_id`) };
  const head = ctx.getHead(artifactId);
  if (!head) return { ok: false, error: { committed: false, code: "NOT_FOUND_OR_FORBIDDEN", message: `no artifact ${artifactId}` } };

  if (request.operation === "revise") return handleRevise(request, ctx, head);

  const kind = STATE_EVENT_KIND[request.operation];
  if (kind) return handleStateEvent(request, ctx, head, kind);

  if (LIFECYCLE_OPS.has(request.operation)) return handleLifecycleTransition(request, ctx, head, request.operation as LifecycleOp);
  if (request.operation === "supersede") return handleSupersede(request, ctx, head);

  return { ok: false, error: invalid(`operation "${request.operation}" is not handled by the native tenant-information policy — it is migrate.ts's import_legacy`) };
};
