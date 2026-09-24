/**
 * Tenant information and retrieval — the shared artifact, revision, event, mutation and
 * search contracts, as runtime schemas rather than as types alone.
 *
 * Every interface here describes untrusted boundary input — a JSON mutation request from an
 * MCP tool, a search query from the gateway, a record read back off disk — so the zod schema
 * is what rejects it and the exported TypeScript type is inferred from that schema.
 *
 * COUPLED: `semanticFields` below is the only place SemanticPayload's field set is
 * enumerated; every consumer that needs to tell a payload change from a state operation
 * imports it rather than writing a second list.
 *
 * Citation identity is `(owner_id, artifact_id, revision-or-source-hash)`, never a bare node
 * number or a relative path. `ArtifactRefSchema` is that triple plus an optional selector, and
 * `content_hash` is a full 64-character lowercase SHA-256, never a mutable "latest" alias.
 * `revision` is nullable because a reference into a SourceArtifact carries none; resolving
 * such a reference, and refusing it for anything but a SourceArtifact, is authorization work
 * downstream rather than something `safeParse` can establish.
 */

import { z } from "zod";

// Shared primitives
//
// Written once and reused: a bare UUID, a full lowercase SHA-256 digest, a timezone-qualified
// ISO 8601 timestamp, and the two integer shapes revisions, sequences and byte counts need.

const UuidSchema = z.string().uuid();
const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/, "must be a full 64-character lowercase SHA-256 digest");
const TimestampSchema = z.string().datetime({ offset: true });
const PositiveIntSchema = z.number().int().positive();
const NonNegativeIntSchema = z.number().int().nonnegative();

// Vocabulary and ownership

export const ArtifactClassSchema = z.enum(["source", "work_document", "knowledge_concept"]);
export type ArtifactClass = z.infer<typeof ArtifactClassSchema>;

export const KnowledgeTypeSchema = z.enum(["Decision", "Rule", "Fact", "Defect"]);
export type KnowledgeType = z.infer<typeof KnowledgeTypeSchema>;

export const KnowledgeStatusSchema = z.enum(["draft", "stable", "deprecated"]);
export type KnowledgeStatus = z.infer<typeof KnowledgeStatusSchema>;

export const GateStatusSchema = z.enum(["draft", "approved"]);
export type GateStatus = z.infer<typeof GateStatusSchema>;

export const EdgeKindSchema = z.enum(["derived_from", "cites", "revision_of", "supersedes"]);
export type EdgeKind = z.infer<typeof EdgeKindSchema>;

/** `revision: null` is structural only: it says a reference does not carry one, which is true
 *  of a reference into a SourceArtifact. It does not prove the reference resolves to a
 *  source — that needs the actual record, and belongs to authorized resolution. */
export const ArtifactRefSchema = z.object({
  owner_id: UuidSchema,
  artifact_id: UuidSchema,
  revision: PositiveIntSchema.nullable(),
  content_hash: Sha256Schema,
  selector: z.string().optional(),
});
export type ArtifactRef = z.infer<typeof ArtifactRefSchema>;

/**
 * The semantic fields, in SemanticPayload's own declared order, and the only place that order
 * is written down. Editing one of them is a semantic edit and creates a revision; editing a
 * field the platform schema declares state-only does not.
 */
export const semanticFields = ["title", "description", "type", "tags", "body", "resource", "content_fields"] as const;

export const SemanticPayloadSchema = z.object({
  title: z.string(),
  description: z.string(),
  type: z.string(),
  tags: z.array(z.string()),
  body: z.string(),
  resource: z.string().nullable(),
  content_fields: z.record(z.string(), z.unknown()),
});
export type SemanticPayload = z.infer<typeof SemanticPayloadSchema>;

export const SourceCitationSchema = z.object({
  id: z.string(),
  resource: z.string(),
  ref: ArtifactRefSchema,
  title: z.string().optional(),
  author: z.string().optional(),
  last_modified: z.string().optional(),
});
export type SourceCitation = z.infer<typeof SourceCitationSchema>;

/**
 * A revision's own `generated` block is nullable-by-part rather than nullable-as-a-whole: a
 * lossless import may know neither the original actor nor the original time, and each is
 * absent independently rather than the pair standing in for "unknown, full stop".
 */
const GeneratedSchema = z.object({
  by: z.string().nullable(),
  at: TimestampSchema.nullable(),
});

const LegacyUnresolvedSourceSchema = z.object({
  original: z.string(),
  reason: z.string(),
});

export const ContentRevisionSchema = z.object({
  owner_id: UuidSchema,
  artifact_id: UuidSchema,
  revision: PositiveIntSchema,
  content_hash: Sha256Schema,
  payload: SemanticPayloadSchema,
  cause_refs: z.array(ArtifactRefSchema),
  sources: z.array(SourceCitationSchema),
  generated: GeneratedSchema,
  origin_profile: z.enum(["native", "legacy_import"]),
  legacy_unresolved_sources: z.array(LegacyUnresolvedSourceSchema),
  previous_revision: PositiveIntSchema.nullable(),
}).superRefine((revision, ctx) => {
  // A native revision names its own generator and carries no unresolved legacy declarations.
  // Only import_legacy may leave the original actor/time unknown, because it is importing
  // bytes the platform did not produce; the import's own actor and time are recorded apart.
  if (revision.origin_profile === "native") {
    if (revision.generated.by === null || revision.generated.at === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom, path: ["generated"],
        message: "a native revision must name its own generator (generated.by/at cannot be null)",
      });
    }
    if (revision.legacy_unresolved_sources.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom, path: ["legacy_unresolved_sources"],
        message: "a native revision carries no unresolved legacy source declarations",
      });
    }
  }
});
export type ContentRevision = z.infer<typeof ContentRevisionSchema>;

export const ArtifactEventKindSchema = z.enum([
  "created", "revised", "approved", "verified", "status_changed",
  "moved", "input_attached", "input_dispositioned",
  "provenance_corrected", "superseded", "published",
  "unpublished", "legacy_imported",
]);
export type ArtifactEventKind = z.infer<typeof ArtifactEventKindSchema>;

export const ArtifactEventSchema = z.object({
  event_id: UuidSchema,
  transaction_id: z.string().min(1),
  owner_id: UuidSchema,
  artifact_id: UuidSchema,
  sequence: PositiveIntSchema,
  at: TimestampSchema,
  actor: z.string().min(1),
  kind: ArtifactEventKindSchema,
  revision: PositiveIntSchema.nullable(),
  content_hash: Sha256Schema,
  cause_refs: z.array(ArtifactRefSchema),
  data: z.record(z.string(), z.unknown()),
});
export type ArtifactEvent = z.infer<typeof ArtifactEventSchema>;

/** The durable capture record for a SourceArtifact — reconstructible from a commit manifest,
 *  never re-derived from a re-rendered wrapper. `original_locator` is nullable because a
 *  mutable URL alone is not a causal capture; with none reviewable it stays null. */
export const SourceCaptureSchema = z.object({
  owner_id: UuidSchema,
  artifact_id: UuidSchema,
  original_path: z.string(),
  title: z.string(),
  media_type: z.string(),
  byte_length: NonNegativeIntSchema,
  blob_hash: Sha256Schema,
  captured_at: TimestampSchema,
  captured_by: z.string(),
  original_locator: z.string().nullable(),
});
export type SourceCapture = z.infer<typeof SourceCaptureSchema>;

// Mutation, persistence and derived data

export const MutationOpSchema = z.enum([
  // NOT A TOOL: `approve` here is the kernel's MutationOp — the operation a
  // work-document approval funnels through — not the `document_approve` tool that invokes it.
  "create", "revise", "approve", "verify",
  "set_knowledge_status", "move", "attach_input", "disposition_input",
  "correct_provenance", "supersede", "publish", "unpublish", "import_legacy",
]);
export type MutationOp = z.infer<typeof MutationOpSchema>;

/**
 * The mutation error codes. `MutationErrorSchema.code` is built from this list rather than a
 * separate literal union, so there is one place a new code is added.
 */
export const mutationErrorCodes = [
  "INVALID_INPUT", "NOT_FOUND_OR_FORBIDDEN", "SOURCE_IMMUTABLE",
  "CAUSE_REQUIRED", "UNRESOLVED_CAUSE", "REVISION_CONFLICT",
  "IDEMPOTENCY_CONFLICT", "GATE_REFUSED", "CYCLE_REFUSED",
  "PAYLOAD_TOO_LARGE", "STORE_UNAVAILABLE", "LEGACY_REVIEW_REQUIRED",
] as const;

/** Fields no caller payload may set, because authorization context — not caller input —
 *  supplies them: owner and actor from the authenticated session, gate/knowledge status from
 *  a dedicated operation, and platform identity is minted. A payload naming one is rejected
 *  at the boundary rather than ignored, so an override surfaces as INVALID_INPUT. */
const RESERVED_PAYLOAD_KEYS = ["owner_id", "owner", "actor", "gate", "gate_status", "identity"] as const;

const MutationPayloadSchema = z.record(z.string(), z.unknown()).superRefine((payload, ctx) => {
  for (const key of RESERVED_PAYLOAD_KEYS) {
    if (key in payload) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom, path: [key],
        message: `payload may not set reserved field "${key}"; it comes from authorization context`,
      });
    }
  }
});

/**
 * DELIBERATE: `.strict()`. An unknown top-level field is how a caller smuggles a
 * platform-owned value (owner, actor, gate, identity) past the operation-specific payload, so
 * anything MutationRequest does not declare is refused rather than passed through.
 */
export const MutationRequestSchema = z.object({
  operation: MutationOpSchema,
  idempotency_key: z.string().min(1),
  artifact_id: UuidSchema.optional(),
  artifact_class: ArtifactClassSchema.optional(),
  expected_etag: z.string().optional(),
  payload: MutationPayloadSchema,
  cause_refs: z.array(ArtifactRefSchema),
}).strict();
export type MutationRequest = z.infer<typeof MutationRequestSchema>;

export const MutationResultSchema = z.object({
  committed: z.literal(true),
  changed: z.boolean(),
  transaction_id: z.string().nullable(),
  artifact_id: UuidSchema,
  revision: PositiveIntSchema.nullable(),
  content_hash: Sha256Schema,
  etag: z.string(),
  commit_sequence: NonNegativeIntSchema.nullable(),
  projection: z.enum(["current", "pending"]),
  history_export: z.enum(["current", "pending"]),
});
export type MutationResult = z.infer<typeof MutationResultSchema>;

export const MutationErrorSchema = z.object({
  committed: z.literal(false),
  code: z.enum(mutationErrorCodes),
  message: z.string(),
});
export type MutationError = z.infer<typeof MutationErrorSchema>;

export const MutationIndeterminateSchema = z.object({
  committed: z.literal("unknown"),
  code: z.literal("COMMIT_STATUS_UNKNOWN"),
  transaction_id: z.string(),
  idempotency_key: z.string(),
  message: z.string(),
});
export type MutationIndeterminate = z.infer<typeof MutationIndeterminateSchema>;

/** Discriminated on `committed`, not a bare union: a mutation outcome is one of exactly three
 *  shapes and the discriminant is the field every caller already checks first. */
export const MutationOutcomeSchema = z.discriminatedUnion("committed", [
  MutationResultSchema, MutationErrorSchema, MutationIndeterminateSchema,
]);
export type MutationOutcome = z.infer<typeof MutationOutcomeSchema>;

// Retrieval contract

export const SearchResultSchema = z.object({
  ref: ArtifactRefSchema,
  record_digest: Sha256Schema,
  etag: z.string(),
  path: z.string(),
  title: z.string(),
  artifact_class: ArtifactClassSchema,
  type: z.string(),
  scope: z.enum(["current", "evidence", "history"]),
  shelf: z.enum(["team", "platform"]),
  gate_status: GateStatusSchema.nullable(),
  knowledge_status: KnowledgeStatusSchema.nullable(),
  profile: z.string(),
  source_refs: z.array(ArtifactRefSchema),
  source_refs_truncated: z.boolean(),
  source_refs_cursor: z.string().nullable(),
  snippet: z.string(),
  snippet_byte_start: NonNegativeIntSchema,
  snippet_byte_end: NonNegativeIntSchema,
  via: z.array(z.string()),
  corpora: z.array(z.string()),
  score: z.number(),
});
export type SearchResult = z.infer<typeof SearchResultSchema>;

/** schema_version is a literal 2, not `number`: it is the response's own disclosure that it
 *  is the structured, reasons-carrying shape rather than the explanatory-text response some
 *  tools still return alongside it. */
export const SearchResponseSchema = z.object({
  schema_version: z.literal(2),
  results: z.array(SearchResultSchema),
  index_generation: z.string(),
  indexed_through: z.record(z.string(), NonNegativeIntSchema),
  returned: NonNegativeIntSchema,
  candidate_total: NonNegativeIntSchema,
  withheld_candidates: NonNegativeIntSchema,
  incomplete: z.boolean(),
  reasons: z.array(z.enum([
    "candidate_budget", "inspection_budget", "deadline",
    "response_budget", "projection_pending", "fallback_lexical",
  ])),
  mode_used: z.enum(["natural", "websearch", "browse"]),
});
export type SearchResponse = z.infer<typeof SearchResponseSchema>;
