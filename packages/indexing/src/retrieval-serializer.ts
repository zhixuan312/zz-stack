/**
 * `serializeReceipt` — the public, validated serializer that turns a retrieval backend's raw
 * response (plus any authorized readback) into `RetrievalItem`/`RetrievalReceipt` exactly as
 * `spec.md`'s "Legacy and native adapters" section defines them (← AC-7.4, AC-3.1).
 *
 * A SERIALIZATION LAYER, NOT A LIVE RETRIEVAL PATH. Exactly like `lanesFor` (I-11) and
 * `planSearch` (I-12) — see their own file headers — this function touches no database and is
 * not called from a live query path today. It has one job: given rows a caller already has
 * (from a real backend response, a fixture, or a test), map every fact onto the spec's shape
 * without inventing a single one. "Final deliverable content is not in this plan" is this
 * task's own boundary; nothing here makes native retrieval live, and the native tenant-info
 * projections this could eventually read from still hold zero rows.
 *
 * THE ENVELOPE WINS, NEVER THE FILENAME. The whole reason this serializer exists: `spec.md`
 * was observed serialized on this platform as `type: agreement`, not `type: spec` — a
 * consumer that inferred content type from a path's own filename would have silently dropped
 * that document from its own evidence. `content_type` is read only from `envelope_type` (the
 * backend's own envelope/manifest) or from authorized readback, never from `path`. The same
 * discipline applies to `object_class`: a legacy mixed document/node row's class comes from
 * returned metadata or readback, never guessed from where it lives.
 *
 * ABSENT IS `null`/`"unknown"`, NEVER A DEFAULT THAT READS LIKE KNOWLEDGE. `status_origin`
 * records where a fact came from — `"wire"` when the backend's own row carried it, `"readback"`
 * when only an authorized read established it, `"unknown"` when neither did. It is one field
 * per item covering four facts (`object_class`, `content_type`, `gate_status`,
 * `knowledge_status`); this serializer's rule is: `"wire"` if ANY of the four arrived on the
 * row itself, else `"readback"` if any arrived through `readback`, else `"unknown"` — a single
 * per-item marker is coarser than four, and coarser-toward-honesty (a row that mixes wire and
 * readback facts is marked `"wire"`, never silently upgraded past what the weakest of the four
 * actually knows... the weakest here is a non-issue because a `"wire"` marking never HIDES a
 * `null`; every individual field still carries its own `null`/`"unknown"` when absent).
 *
 * A `current_path` REFERENCE IS A LEAD, NEVER A PINNED DEPENDENCY. `reference_assurance`
 * defaults to `"current_path"` — the weakest of the three, because a row that says nothing
 * about its own assurance is exactly the case spec.md warns about: "current path reads are
 * mutable observations". `canAuthorizeMutation` (beyond spec.md's own field list, but pinned
 * by this task's declared check) is `true` only for `"kernel_pinned"` and `"legacy_snapshot"` —
 * enumerated rather than negated, so a future assurance value this file has not seen yet
 * defaults to NOT authorizing a mutation rather than silently starting to.
 *
 * `raw_response_ref` IS NOT ONE OF SPEC'S THREE `Ref` VARIANTS, AND THAT IS DISCLOSED HERE
 * RATHER THAN FAKED. spec.md types `raw_response_ref: Ref`, and `Ref` (`ArtifactRef` /
 * `LegacyRef` / `ExecutionRef`, all three reproduced below from spec.md's own "Upstream
 * identity and commit contract") is an INDIVIDUAL-ARTIFACT identity reference — every variant
 * needs either a validated owner/artifact UUID pair, or a real repository-grounded path, or an
 * execution receipt wrapping one of those. A whole preserved SEARCH RESPONSE has none of that:
 * fabricating an `owner_id`/`content_hash` this layer never saw, or a `path` that does not
 * describe a search response, is exactly the kind of invention this task exists to refuse. So
 * `raw_response_ref` is built as a fourth, narrower shape (`RawResponseCapture`) carrying a
 * REAL sha256 of the preserved payload and a real capture timestamp — never a fabricated
 * artifact identity. This is a disclosed gap against "exactly as spec.md defines them" for
 * this one field, to be closed once a real backend/readback layer can hand this function an
 * actual `Ref` for where it stored the raw response — see this task's own execution report.
 */
import { createHash, randomUUID } from "node:crypto";

import { ArtifactClassSchema, ArtifactRefSchema, GateStatusSchema, type ArtifactRef, type GateStatus } from "@zz/contracts";
import { z } from "zod";

// ── `Ref`, reproduced from spec.md's "Upstream identity and commit contract" ───────────────
//
// `ArtifactRef` already exists on `@zz/contracts` (I-10/I-11's own upstream dependency) and is
// reused rather than redeclared. `LegacyRef`/`ExecutionRef` do not exist anywhere in this
// repository yet — declared here, local to this module, rather than widening `@zz/contracts`
// for a shape only this serializer's `reference`/`superseding_refs` fields consume today.

/** A legacy artifact's reference, honest about degraded provenance: `hash_origin:
 *  "unavailable"` and `repository_grounding: { kind: "none" }` exist precisely for a legacy
 *  row this serializer cannot ground further — never filled with a fabricated value instead. */
export interface LegacyRef {
  readonly kind: "legacy";
  readonly path: string;
  readonly approval_version: number | null;
  readonly snapshot_sha256: string | null;
  readonly hash_origin: "computed_at_import" | "unavailable";
  readonly hash_observed_at: string | null;
  readonly hashed_byte_count: number | null;
  readonly repository_grounding:
    | { readonly kind: "commit"; readonly value: string }
    | { readonly kind: "migration_head"; readonly value: string }
    | { readonly kind: "none" };
}

export interface ExecutionRef {
  readonly kind: "execution";
  readonly receipt_id: string;
  readonly artifact: ArtifactRef;
}

export type Ref = ArtifactRef | LegacyRef | ExecutionRef;

const RepositoryGroundingSchema = z.union([
  z.object({ kind: z.literal("commit"), value: z.string() }),
  z.object({ kind: z.literal("migration_head"), value: z.string() }),
  z.object({ kind: z.literal("none") }),
]);

const LegacyRefSchema = z.object({
  kind: z.literal("legacy"),
  path: z.string(),
  approval_version: z.number().int().positive().nullable(),
  snapshot_sha256: z.string().nullable(),
  hash_origin: z.enum(["computed_at_import", "unavailable"]),
  hash_observed_at: z.string().nullable(),
  hashed_byte_count: z.number().int().nonnegative().nullable(),
  repository_grounding: RepositoryGroundingSchema,
});

const ExecutionRefSchema = z.object({
  kind: z.literal("execution"),
  receipt_id: z.string(),
  artifact: ArtifactRefSchema,
});

const RefSchema = z.union([ArtifactRefSchema, LegacyRefSchema, ExecutionRefSchema]);

// ── the public shapes, exactly as spec.md's "Legacy and native adapters" section defines them ─

export type RetrievalScope = "current" | "evidence" | "history";

export interface RetrievalItem {
  readonly item_id: string;
  readonly object_class: "source" | "work_document" | "knowledge_concept" | "unknown";
  readonly content_type: string | null;
  readonly shelf: "team" | "platform";
  readonly reference: Ref | null;
  readonly read_handle: string;
  readonly reference_assurance: "kernel_pinned" | "legacy_snapshot" | "current_path";
  // `GateStatus`, imported above from `@zz/contracts` rather than restated as a literal pair
  // — the envelope's own vocabulary lives there once, and a second literal copy of
  // "draft"/"approved" anywhere else is exactly what that package exists to prevent.
  readonly gate_status: GateStatus | null;
  readonly knowledge_status: string | null;
  readonly status_origin: "wire" | "readback" | "unknown";
  readonly snippet: string;
  readonly snippet_byte_range: { readonly start: number; readonly end: number } | null;
  readonly match_kind: "direct" | "broadened_lead" | "graph_lead" | "unknown";
  readonly via: readonly string[];
  readonly superseding_refs: readonly Ref[] | null;
  /** Beyond spec.md's own field list — pinned by this task's declared check, which reads it
   *  directly. A `current_path` lead can never authorize a protected mutation as a pinned
   *  dependency (spec.md, verbatim); the two assurances that CAN are enumerated rather than
   *  derived by negating `"current_path"`, so an assurance value neither this file nor spec.md
   *  has seen yet defaults to not authorizing rather than silently starting to. */
  readonly canAuthorizeMutation: boolean;
}

/** Not one of spec.md's three `Ref` variants — see this file's own header for why a whole
 *  preserved response cannot honestly be forced into an artifact-identity shape, and what
 *  closing that gap needs. */
export interface RawResponseCapture {
  readonly kind: "raw_capture";
  readonly sha256: string;
  readonly byte_count: number;
  readonly captured_at: string;
}

export interface RetrievalReceipt {
  readonly receipt_id: string;
  readonly backend_contract: string;
  readonly query_original: string;
  readonly query_executed: string;
  readonly query_variant_kind: "original" | "lexical_variant" | "bilingual_variant";
  readonly query_language: string;
  readonly requested_scopes: readonly RetrievalScope[];
  readonly effective_scopes: readonly RetrievalScope[] | null;
  readonly effective_filters: Record<string, string | readonly string[]> | null;
  readonly status: "ok" | "unavailable" | "unsupported_filter" | "unsupported_scope" | "schema_mismatch";
  readonly items: readonly RetrievalItem[];
  readonly completeness: "complete_for_declared_search" | "incomplete" | "unknown";
  readonly reasons: readonly string[];
  readonly analyzer_identity: string | null;
  readonly index_generation: string | null;
  readonly indexed_through: Record<string, number> | null;
  readonly language_qualified: boolean | null;
  readonly candidate_total: number | null;
  readonly withheld_candidates: number | null;
  readonly continuation_handle: string | null;
  readonly raw_response_ref: RawResponseCapture;
}

// ── the input this serializer actually receives today ──────────────────────────────────────
//
// One row of a backend's raw response, normalized just enough to serialize an item — see this
// file's own header for the envelope/filename and wire/readback rules. Fields this serializer
// itself invented (never pinned by spec.md) stay plain `string`/`z.string()` rather than a
// narrow literal union, so a legacy wire value this file has not catalogued yet is carried
// through as `"unknown"`/absent instead of rejected outright — the same reason `knowledge_status`
// is `string | null` in spec.md's own type rather than the native `draft`/`stable`/`deprecated`
// enum: this adapter also carries imported legacy labels, unenumerated.

const ByteRangeSchema = z.object({
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
});

const ReadbackFactsSchema = z.object({
  object_class: z.string().optional(),
  content_type: z.string().optional(),
  gate_status: z.string().optional(),
  knowledge_status: z.string().optional(),
});

const RawRetrievalRowSchema = z.object({
  item_id: z.string().optional(),
  path: z.string().optional(),
  /** The WIRE content type, as the backend's own envelope/manifest states it — never `path`.
   *  See this file's own header for why the two are separate fields. */
  envelope_type: z.string().optional(),
  object_class: z.string().optional(),
  shelf: z.enum(["team", "platform"]).optional(),
  reference: RefSchema.optional(),
  read_handle: z.string().optional(),
  assurance: z.enum(["kernel_pinned", "legacy_snapshot", "current_path"]).optional(),
  gate_status: z.string().optional(),
  knowledge_status: z.string().optional(),
  snippet: z.string().optional(),
  snippet_byte_range: ByteRangeSchema.optional(),
  /** Which native lane, or legacy/broadening stage, produced this row — `match_kind <- the
   *  lane`, per this task's own Contract. `lanesFor`'s (I-11) `LaneName` values
   *  (`"exact"`/`"bm25"`/`"fuzzy"`/`"provenance"`) plus `planSearch`'s (I-12) own stage names
   *  (`"neighbours"`/`"lexical-broadened"`) are the values this serializer recognizes; kept as
   *  plain `string` rather than importing `LaneName` so a legacy stage name neither of those
   *  two tasks named still maps to `"unknown"` instead of failing validation. */
  lane: z.string().optional(),
  via: z.array(z.string()).optional(),
  superseding_refs: z.array(RefSchema).optional(),
  /** Facts established by AUTHORIZED READBACK rather than returned on the wire — the
   *  Contract's "plus any authorized readback" input. Only ever raises `status_origin` from
   *  `"unknown"` toward `"readback"`; never overrides a fact the wire itself carried. */
  readback: ReadbackFactsSchema.optional(),
});

export type RawRetrievalRow = z.infer<typeof RawRetrievalRowSchema>;

export interface SerializeReceiptInput {
  readonly rows: readonly unknown[];
  /** The backend's raw response, preserved verbatim and opaque to this layer — no live
   *  backend integration exists yet (this file's own header), so nothing here parses it for
   *  content. Wrapped into `raw_response_ref`, never discarded. */
  readonly raw: unknown;
  readonly backendContract?: string;
  readonly queryOriginal?: string;
  readonly queryExecuted?: string;
  readonly queryVariantKind?: RetrievalReceipt["query_variant_kind"];
  readonly queryLanguage?: string;
  readonly requestedScopes?: readonly RetrievalScope[];
  readonly effectiveScopes?: readonly RetrievalScope[] | null;
  readonly effectiveFilters?: RetrievalReceipt["effective_filters"];
  /** Caller-declared status (e.g. the backend itself reported `"unavailable"`). Overridden to
   *  `"schema_mismatch"` when `rows`/`raw` fail validation — a response that fails validation
   *  never claims to be `"ok"`. */
  readonly status?: RetrievalReceipt["status"];
  readonly completeness?: RetrievalReceipt["completeness"];
  readonly reasons?: readonly string[];
  readonly analyzerIdentity?: string | null;
  readonly indexGeneration?: string | null;
  readonly indexedThrough?: Record<string, number> | null;
  readonly languageQualified?: boolean | null;
  readonly candidateTotal?: number | null;
  readonly withheldCandidates?: number | null;
  readonly continuationHandle?: string | null;
}

function matchKindFor(lane: string | undefined): RetrievalItem["match_kind"] {
  switch (lane) {
    case "exact":
    case "bm25":
    case "fuzzy":
      return "direct";
    case "lexical-broadened":
      return "broadened_lead";
    case "provenance":
    case "neighbours":
      return "graph_lead";
    default:
      return "unknown";
  }
}

function statusOriginFor(row: RawRetrievalRow): RetrievalItem["status_origin"] {
  const wireHit = row.object_class !== undefined || row.envelope_type !== undefined
    || row.gate_status !== undefined || row.knowledge_status !== undefined;
  if (wireHit) return "wire";
  const rb = row.readback;
  const readbackHit = rb !== undefined && (rb.object_class !== undefined || rb.content_type !== undefined
    || rb.gate_status !== undefined || rb.knowledge_status !== undefined);
  return readbackHit ? "readback" : "unknown";
}

function objectClassFor(row: RawRetrievalRow): RetrievalItem["object_class"] {
  const wire = ArtifactClassSchema.safeParse(row.object_class);
  if (wire.success) return wire.data;
  const readback = ArtifactClassSchema.safeParse(row.readback?.object_class);
  return readback.success ? readback.data : "unknown";
}

function contentTypeFor(row: RawRetrievalRow): string | null {
  // THE ENVELOPE WINS, NEVER THE FILENAME — `row.path` is never consulted here. See this
  // file's own header for the observed `spec.md` / `type: agreement` defect this exists to
  // prevent.
  return row.envelope_type ?? row.readback?.content_type ?? null;
}

function gateStatusFor(row: RawRetrievalRow): RetrievalItem["gate_status"] {
  const wire = GateStatusSchema.safeParse(row.gate_status);
  if (wire.success) return wire.data;
  const readback = GateStatusSchema.safeParse(row.readback?.gate_status);
  return readback.success ? readback.data : null;
}

function knowledgeStatusFor(row: RawRetrievalRow): string | null {
  return row.knowledge_status ?? row.readback?.knowledge_status ?? null;
}

function canAuthorizeMutationFor(assurance: RetrievalItem["reference_assurance"]): boolean {
  return assurance === "kernel_pinned" || assurance === "legacy_snapshot";
}

function itemFor(row: RawRetrievalRow): RetrievalItem {
  const transportHandle = row.item_id ?? row.read_handle ?? row.path ?? "";
  const assurance = row.assurance ?? "current_path";
  return {
    item_id: transportHandle,
    object_class: objectClassFor(row),
    content_type: contentTypeFor(row),
    shelf: row.shelf ?? "team",
    reference: row.reference ?? null,
    read_handle: row.read_handle ?? row.path ?? row.item_id ?? "",
    reference_assurance: assurance,
    gate_status: gateStatusFor(row),
    knowledge_status: knowledgeStatusFor(row),
    status_origin: statusOriginFor(row),
    snippet: row.snippet ?? "",
    snippet_byte_range: row.snippet_byte_range ?? null,
    match_kind: matchKindFor(row.lane),
    via: row.via ?? [],
    superseding_refs: row.superseding_refs ?? null,
    canAuthorizeMutation: canAuthorizeMutationFor(assurance),
  };
}

function rawResponseRefFor(raw: unknown): RawResponseCapture {
  // A REAL digest of what was actually preserved, never a fabricated artifact identity — see
  // this file's own header for why `raw_response_ref` is this shape and not spec.md's `Ref`.
  const serialized = raw === undefined ? "null" : JSON.stringify(raw);
  return {
    kind: "raw_capture",
    sha256: createHash("sha256").update(serialized, "utf8").digest("hex"),
    byte_count: Buffer.byteLength(serialized, "utf8"),
    captured_at: new Date().toISOString(),
  };
}

/**
 * The public, validated serializer (← AC-7.4, AC-3.1). Maps the backend's raw response rows,
 * plus any authorized readback, onto `RetrievalItem`/`RetrievalReceipt` exactly as spec.md
 * defines them: absent facts are `null`/`"unknown"` rather than defaulted, `content_type`
 * comes from the envelope rather than the filename, and a response that fails validation
 * returns `status: "schema_mismatch"` with no partially-populated item — the raw response is
 * still preserved as a protected reference either way.
 */
export function serializeReceipt(input: SerializeReceiptInput): RetrievalReceipt {
  const rawResponseRef = rawResponseRefFor(input.raw);
  const reasons: string[] = [...(input.reasons ?? [])];

  const parsedRows = z.array(RawRetrievalRowSchema).safeParse(input.rows);
  const rawPresent = input.raw !== undefined;
  const validated = parsedRows.success && rawPresent;

  if (!validated) {
    if (!parsedRows.success) reasons.push("rows failed schema validation; no item was serialized from any of them");
    if (!rawPresent) reasons.push("no raw response was supplied to preserve");
    return {
      receipt_id: randomUUID(),
      backend_contract: input.backendContract ?? "",
      query_original: input.queryOriginal ?? "",
      query_executed: input.queryExecuted ?? input.queryOriginal ?? "",
      query_variant_kind: input.queryVariantKind ?? "original",
      query_language: input.queryLanguage ?? "",
      requested_scopes: input.requestedScopes ?? [],
      effective_scopes: input.effectiveScopes ?? null,
      effective_filters: input.effectiveFilters ?? null,
      status: "schema_mismatch",
      items: [],
      completeness: "unknown",
      reasons,
      analyzer_identity: input.analyzerIdentity ?? null,
      index_generation: input.indexGeneration ?? null,
      indexed_through: input.indexedThrough ?? null,
      language_qualified: input.languageQualified ?? null,
      candidate_total: input.candidateTotal ?? null,
      withheld_candidates: input.withheldCandidates ?? null,
      continuation_handle: input.continuationHandle ?? null,
      raw_response_ref: rawResponseRef,
    };
  }

  if (input.backendContract === undefined) reasons.push("backend_contract not supplied by caller; defaulted to \"\"");
  if (input.queryOriginal === undefined) reasons.push("query_original not supplied by caller; defaulted to \"\"");
  if (input.queryLanguage === undefined) reasons.push("query_language not supplied by caller; defaulted to \"\"");

  return {
    receipt_id: randomUUID(),
    backend_contract: input.backendContract ?? "",
    query_original: input.queryOriginal ?? "",
    query_executed: input.queryExecuted ?? input.queryOriginal ?? "",
    query_variant_kind: input.queryVariantKind ?? "original",
    query_language: input.queryLanguage ?? "",
    requested_scopes: input.requestedScopes ?? [],
    effective_scopes: input.effectiveScopes ?? null,
    effective_filters: input.effectiveFilters ?? null,
    status: input.status ?? "ok",
    items: parsedRows.data.map(itemFor),
    completeness: input.completeness ?? "unknown",
    reasons,
    analyzer_identity: input.analyzerIdentity ?? null,
    index_generation: input.indexGeneration ?? null,
    indexed_through: input.indexedThrough ?? null,
    language_qualified: input.languageQualified ?? null,
    candidate_total: input.candidateTotal ?? null,
    withheld_candidates: input.withheldCandidates ?? null,
    continuation_handle: input.continuationHandle ?? null,
    raw_response_ref: rawResponseRef,
  };
}
