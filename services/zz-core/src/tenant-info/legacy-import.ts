/**
 * legacy-import.ts — the adoption path: how bytes that predate this platform's record store
 * become artifacts it holds, without any of them changing.
 *
 * THIS IS THE FILE I-11 WAS MISSING. `mutations.ts` refuses `NOT_FOUND_OR_FORBIDDEN` for any
 * artifact_id it holds no commit for, because `readOwnerState` replays only
 * `.zz/commits/*.json`. Every document written before that store existed has no commit, so
 * routing the registered tools through `mutate()` would have answered every write to an
 * existing document with a refusal. The answer is not to loosen the kernel's identity rule —
 * it is to give a legacy artifact a first commit that says, truthfully, "these bytes came from
 * somewhere else and this platform did not produce them". That commit is `import_legacy`, and
 * this module is what prepares it.
 *
 * FOUR THINGS ARE DETERMINISTIC HERE, AND EVERY ONE OF THEM IS load-bearing for the contract's
 * "applying the same approved conversion manifest twice produces no extra identity, revision
 * or event":
 *   1. `legacyArtifactId(owner_id, locator)` — the identity. A UUIDv5-shaped digest of the
 *      owner and the legacy locator, so the same file in the same store is the same artifact
 *      on every run, on every machine, forever. This IS the alias map: `document_patch("a/b.md")`
 *      can compute the artifact_id it needs without consulting a table that might be missing.
 *   2. `manifestIdOf(rows)` — the manifest's own identity, a digest over its rows. A manifest
 *      re-prepared from the same inputs is the same manifest.
 *   3. `legacyImportKey(manifest_id, row)` — the idempotency key, a digest of the manifest id,
 *      the locator and the ORIGINAL BYTE HASH. This is the key `mutate()` finds in the
 *      idempotency index on a second apply and replays from, writing nothing.
 *   4. `legacyImportRequest(...)` — the whole request, a pure function of the row and the
 *      bytes. It carries no clock and no random value, so `requestHash` matches on the replay
 *      and the kernel does not refuse it as a different request under a reused key.
 * Nothing below deduplicates anything itself. The kernel's idempotency index does that, and it
 * can only do it because all four of the above are computed from the input and not from now.
 *
 * WHAT IS NEVER DECIDED HERE. A legacy `type:` is carried across verbatim, whatever it says.
 * This module classifies a document's PROFILE — native-shaped, foreign OKF, or unparsable —
 * using `export.ts`'s real parser, and records that profile; it never rewrites a foreign type
 * into one of this platform's four, and it never marks anything reviewed. Semantic conversion
 * of a team's own concepts needs that team's reviewer (H2), which is a decision a person
 * records, not a default a converter takes.
 *
 * WHAT IS NEVER LOST. The exact original bytes are written to `.zz/blobs/<sha256>` and
 * materialized at `legacy/<locator>` — before any parsing, and whatever the parsing concluded.
 * A file whose frontmatter is broken YAML still lands there byte for byte, wrapped as
 * `legacy-raw` with the reason recorded; so does a binary; so does text past the kernel's
 * 8-MiB new-write ceiling, which the migration exception exists for and which this module is
 * the one caller of.
 */
import { createHash, randomUUID } from "node:crypto";

import {
  ArtifactEventSchema, ContentRevisionSchema, SourceCaptureSchema,
  type ArtifactEvent, type ContentRevision, type MutationError, type MutationRequest,
  type SourceCapture,
} from "@zz/contracts";
import { assertWithinInputLimit, MAX_INPUT_BYTES, passagesOf } from "@zz/indexing";

import { hasFrontmatter, LEGACY_PROFILE, NATIVE_PROFILE, parseKnowledge, RAW_PROFILE } from "./export.js";
import type { Policy, PolicyOutcome } from "./mutations.js";
import { canonicalHash, invalid } from "./policies.js";
import type { FileChangeEntry, PreparedBlob } from "./record.js";

/** The conversion manifest's own format version. A later incompatible manifest shape is
 *  version 2 and is refused by this reader, rather than read as though it meant this one. */
export const LEGACY_MANIFEST_FORMAT_VERSION = 1;

/** Where the untouched original of every imported file is materialized, relative to the target
 *  owner-store root. `record.ts` forbids materializing under `.zz/`, and that is right: the
 *  archive is meant to be readable by a person with `ls`, not buried in the record store. */
export const LEGACY_ARCHIVE_DIR = "legacy";

/** The profiles `classifyLegacyInput` can report. `legacy-binary` is this module's own — the
 *  other three are `export.ts`'s and mean exactly what they mean there. */
export const BINARY_PROFILE = "legacy-binary" as const;
export type LegacyProfile =
  | typeof NATIVE_PROFILE | typeof LEGACY_PROFILE | typeof RAW_PROFILE | typeof BINARY_PROFILE;

// ── deterministic identity ──────────────────────────────────────────────────────────────────

/** A UUIDv5-SHAPED digest, not a v5 UUID: SHA-256 rather than SHA-1, with the version and
 *  variant nibbles set so the result is a well-formed UUID every schema on this platform
 *  accepts. The point is not RFC-4122 lineage, it is that the same (owner, locator) pair
 *  always produces the same identity — SHA-1 buys nothing here and is the weaker digest. */
function digestUuid(namespace: string, name: string): string {
  const bytes = Buffer.from(createHash("sha256").update(`${namespace}\u0000${name}`, "utf8").digest().subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * THE ALIAS MAP, as a function rather than a table. An adapter holding a legacy path — which
 * is all any registered tool ever holds — computes the artifact_id this migration gave (or
 * will give) those bytes, with no lookup that could be absent, stale or out of order.
 */
export function legacyArtifactId(ownerId: string, locator: string): string {
  return digestUuid(`zz-legacy-artifact:${ownerId}`, locator);
}

/** The identity of the SourceArtifact that captures one row's original bytes. A separate
 *  namespace from the document's, so the capture and the document it came from can never
 *  collide on the same id. */
export function legacySourceArtifactId(ownerId: string, locator: string): string {
  return digestUuid(`zz-legacy-source:${ownerId}`, locator);
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

// ── the conversion manifest ─────────────────────────────────────────────────────────────────

/** One row of an approved mechanical conversion manifest: everything the contract requires be
 *  accounted for about one input file, and nothing that is a judgement about its contents. */
export interface LegacyManifestRow {
  /** The legacy locator, relative to the source store root — the ambiguity-free thing a label
   *  must resolve to before it is used. */
  readonly path: string;
  readonly sha256: string;
  readonly byte_length: number;
  /** The original authoring time when the source declared one this reader could parse, and
   *  `null` when it did not. Never a file mtime standing in for an authoring time, and never
   *  the import's own clock: an unknown time stays unknown. */
  readonly original_time: string | null;
  readonly original_time_precision: "exact" | "date" | "unknown";
  readonly profile: LegacyProfile;
  /** The legacy system's own identifier for this record, when the source declared one. */
  readonly legacy_id: string | null;
  /** The available history label — a version/revision string the source declared. Gaps stay
   *  gaps: nothing here fabricates the revisions between one label and the next. */
  readonly history_label: string | null;
  readonly media_type: string;
  readonly binary: boolean;
  /** References the source declared that this migration could not resolve, kept labelled
   *  rather than dropped or silently re-pointed. */
  readonly unresolved_references: readonly { readonly original: string; readonly reason: string }[];
}

export interface LegacyConversionManifest {
  readonly format_version: number;
  readonly manifest_id: string;
  readonly rows: readonly LegacyManifestRow[];
}

/** A row that cannot be carried forward at all. The contract makes each of these block the
 *  cutover rather than be skipped with a warning — a migration that quietly dropped a file
 *  would be exactly the loss this whole task exists to prevent. */
export interface LegacyBlockingError {
  readonly path: string;
  readonly code: "UNSAFE_LOCATOR" | "ALTERED_SOURCE_HASH" | "DUPLICATE_IDENTITY" | "UNINDEXABLE_CONTENT";
  readonly message: string;
}

const ISO_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_FIELDS = ["original_time", "created_at", "created", "date"] as const;
const ID_FIELDS = ["legacy_id", "id", "uid"] as const;
const HISTORY_FIELDS = ["version", "revision", "history"] as const;

function firstString(fields: Record<string, unknown>, names: readonly string[]): string | null {
  for (const name of names) {
    const value = fields[name];
    if (typeof value === "string" && value.trim() !== "") return value;
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return null;
}

/** A declared time is used only at the precision it was actually written at. A bare `date`
 *  becomes midnight UTC and is labelled `"date"`, never `"exact"` — a reader must be able to
 *  tell a recorded instant from a day this converter padded out. Anything else is unknown. */
function readOriginalTime(fields: Record<string, unknown>): { at: string | null; precision: LegacyManifestRow["original_time_precision"] } {
  const raw = firstString(fields, TIME_FIELDS);
  if (raw === null) return { at: null, precision: "unknown" };
  if (ISO_OFFSET.test(raw)) return { at: new Date(raw).toISOString(), precision: "exact" };
  if (ISO_DATE.test(raw)) return { at: `${raw}T00:00:00.000Z`, precision: "date" };
  return { at: null, precision: "unknown" };
}

/** Every `sources:` entry a legacy document declared, labelled unresolved. This migration
 *  resolves none of them on purpose: a legacy citation names a record in a system this
 *  platform did not own, and pointing it at a local artifact that merely looks similar would
 *  be fabricating provenance. */
function unresolvedReferences(fields: Record<string, unknown>): { original: string; reason: string }[] {
  const raw = fields.sources;
  if (!Array.isArray(raw)) return [];
  return raw.map((entry) => ({
    original: typeof entry === "string" ? entry : JSON.stringify(entry),
    reason: "declared by the legacy source; no artifact in this store resolves it",
  }));
}

/** A locator this migration will refuse, or `null` when it is safe to archive. The same rule
 *  `record.ts` applies to a materialized path, applied one step earlier so the refusal names
 *  the input file rather than surfacing as an INVALID_INPUT from deep inside a commit — and
 *  exported so an adapter reading a legacy file off disk applies the identical rule BEFORE it
 *  opens the path, rather than a second, slightly different one of its own. */
export function legacyLocatorRefusal(path: string): string | null {
  if (path === "" || path.startsWith("/") || path.startsWith("\\") || /^[A-Za-z]:/.test(path)) {
    return "a legacy locator must be relative to the source store root";
  }
  const parts = path.split(/[/\\]/);
  if (parts.some((p) => p === "" || p === "." || p === "..")) return "a legacy locator may not contain an empty or traversing segment";
  if (parts[0] === ".zz" || parts[0] === LEGACY_ARCHIVE_DIR || parts[0] === "documents") {
    return `a legacy locator may not start at ${JSON.stringify(parts[0])}, which is the target store's own`;
  }
  return null;
}

/** UTF-8 that round-trips, and no NUL byte. A file that fails either is carried as binary:
 *  its bytes are preserved exactly and nothing pretends to have read them as text. */
function isProbablyText(bytes: Uint8Array): boolean {
  if (bytes.includes(0)) return false;
  const text = Buffer.from(bytes).toString("utf8");
  return Buffer.from(text, "utf8").equals(Buffer.from(bytes));
}

function mediaTypeOf(path: string, binary: boolean): string {
  if (binary) return "application/octet-stream";
  return path.endsWith(".md") ? "text/markdown" : "text/plain";
}

interface LegacyReading {
  readonly profile: LegacyProfile;
  /** Every frontmatter key the source declared, verbatim, plus whatever `parseKnowledge`
   *  computed for a `legacy-raw` wrapper (`type: "Reference"`, the retained bytes and the
   *  reason). Empty for a document that declared nothing. */
  readonly fields: Record<string, unknown>;
  readonly body: string;
}

/**
 * HOW A LEGACY TEXT FILE IS READ, and the one place the distinction the contract insists on is
 * drawn: "Plain Markdown with no frontmatter is not automatically malformed YAML."
 *
 * `parseKnowledge` collapses both into `legacy-raw`, correctly for a knowledge document where
 * frontmatter is mandatory. A migration reads a whole team's store, most of which never
 * claimed to be a knowledge document at all — a README, a meeting note, a scratch file. Those
 * declared nothing; they are not broken, their body is the whole file, and calling them
 * malformed would put every one of them behind a Reference wrapper for a defect they do not
 * have. A file that DID open a frontmatter block and put unparsable YAML in it is a different
 * thing, and stays `legacy-raw`.
 */
function readLegacyDocument(raw: string): LegacyReading {
  if (!hasFrontmatter(raw)) return { profile: LEGACY_PROFILE, fields: {}, body: raw };
  const parsed = parseKnowledge(raw);
  return { profile: parsed.zz_profile, fields: parsed as unknown as Record<string, unknown>, body: parsed.body };
}

/**
 * ONE INPUT FILE, ACCOUNTED FOR: its bytes' hash, its legacy id, its available history label,
 * its known date precision, and the profile the real OKF parser assigns it. Pure — no
 * filesystem, no clock, no randomness — which is what lets `prepare()` be re-run and produce
 * the identical manifest.
 */
export function classifyLegacyInput(path: string, bytes: Uint8Array): LegacyManifestRow | LegacyBlockingError {
  const unsafe = legacyLocatorRefusal(path);
  if (unsafe) return { path, code: "UNSAFE_LOCATOR", message: unsafe };

  const binary = !isProbablyText(bytes);
  const base = {
    path, sha256: sha256Hex(bytes), byte_length: bytes.byteLength,
    media_type: mediaTypeOf(path, binary), binary,
  };
  if (binary) {
    return {
      ...base, profile: BINARY_PROFILE, original_time: null, original_time_precision: "unknown",
      legacy_id: null, history_label: null, unresolved_references: [],
    };
  }

  const { profile, fields } = readLegacyDocument(Buffer.from(bytes).toString("utf8"));
  const time = readOriginalTime(fields);
  return {
    ...base,
    profile,
    original_time: time.at,
    original_time_precision: time.precision,
    legacy_id: firstString(fields, ID_FIELDS),
    history_label: firstString(fields, HISTORY_FIELDS),
    unresolved_references: unresolvedReferences(fields),
  };
}

/** The manifest's identity: a digest over exactly the rows it carries, in locator order. Two
 *  preparations of the same inputs are the same manifest, and a manifest with one row changed
 *  is a different one — which is what stops a second, edited manifest from replaying the
 *  first's idempotency keys and silently doing nothing. */
function manifestIdOf(rows: readonly LegacyManifestRow[]): string {
  const canonical = rows.map((r) => `${r.path}\u0000${r.sha256}\u0000${r.profile}`).join("\u0001");
  return createHash("sha256").update(`${LEGACY_MANIFEST_FORMAT_VERSION}\u0002${canonical}`, "utf8").digest("hex");
}

export interface LegacyManifestPreparation {
  readonly manifest: LegacyConversionManifest;
  readonly blocking: readonly LegacyBlockingError[];
}

/**
 * Turns a set of read inputs into an approved-shape mechanical manifest. Rows come out sorted
 * by locator so the manifest id does not depend on the order a directory walk happened to
 * yield, and a locator appearing twice is a DUPLICATE_IDENTITY block rather than a row that
 * silently wins.
 */
export function prepareLegacyManifest(
  inputs: readonly { readonly path: string; readonly bytes: Uint8Array }[],
): LegacyManifestPreparation {
  const rows: LegacyManifestRow[] = [];
  const blocking: LegacyBlockingError[] = [];
  const seen = new Set<string>();
  for (const input of [...inputs].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    if (seen.has(input.path)) {
      blocking.push({ path: input.path, code: "DUPLICATE_IDENTITY", message: `${input.path} appears more than once in this manifest` });
      continue;
    }
    seen.add(input.path);
    const row = classifyLegacyInput(input.path, input.bytes);
    if ("code" in row) { blocking.push(row); continue; }
    if (!row.binary) {
      const unindexable = unindexableReason(Buffer.from(input.bytes).toString("utf8"), row.byte_length);
      if (unindexable) { blocking.push({ path: input.path, code: "UNINDEXABLE_CONTENT", message: unindexable }); continue; }
    }
    rows.push(row);
  }
  return { manifest: { format_version: LEGACY_MANIFEST_FORMAT_VERSION, manifest_id: manifestIdOf(rows), rows }, blocking };
}

/**
 * "UNINDEXABLE RETAINED CONTENT BLOCKS CUTOVER" — measured, not assumed. Retained text has to
 * be fully indexed under the legacy exception, so this runs the real analyzer and checks that
 * its passages cover every byte. Oversized text is explicitly NOT a reason to refuse: that is
 * what `assertWithinInputLimit(..., { imported: true })` is for, and this module is the only
 * caller entitled to pass it.
 */
function unindexableReason(text: string, byteLength: number): string | null {
  try {
    assertWithinInputLimit(byteLength, { imported: true });
    const passages = passagesOf(text);
    if (byteLength === 0) return null;
    if (passages.length === 0) return "the analyzer produced no passages for non-empty retained text";
    const covered = passages.reduce((max, p) => Math.max(max, p.end), 0);
    if (covered < byteLength) return `the analyzer covered ${covered} of ${byteLength} bytes; retained content must be fully indexed`;
    return null;
  } catch (err) {
    return `the analyzer refused this retained content: ${err instanceof Error ? err.message : String(err)}`;
  }
}

// ── the request, and its idempotency key ────────────────────────────────────────────────────

/** THE KEY THE SECOND APPLY REPLAYS FROM. Manifest id, locator and original byte hash — no
 *  clock, no counter, no random value. `mutate()` qualifies it with the operation, finds it in
 *  the idempotency index it replayed off `.zz/commits/`, sees the same `request_hash`, and
 *  returns the first commit's result without writing anything. That, and nothing else, is what
 *  makes applying the same manifest twice add no identity, revision or event. */
export function legacyImportKey(manifestId: string, row: LegacyManifestRow): string {
  return `legacy-import:${createHash("sha256").update(`${manifestId}\u0000${row.path}\u0000${row.sha256}`, "utf8").digest("hex")}`;
}

/** A pure function of the manifest row and the bytes. Base64 rather than a string field for
 *  both text and binary: one encoding for both keeps `requestHash` stable across a replay
 *  whatever the content was, and a binary source has no lossless string form at all. */
export function legacyImportRequest(
  ownerId: string, manifest: LegacyConversionManifest, row: LegacyManifestRow, bytes: Uint8Array,
): MutationRequest {
  return {
    operation: "import_legacy",
    idempotency_key: legacyImportKey(manifest.manifest_id, row),
    artifact_id: legacyArtifactId(ownerId, row.path),
    artifact_class: "work_document",
    payload: { legacy: { ...row, manifest_id: manifest.manifest_id, format_version: manifest.format_version }, bytes_base64: Buffer.from(bytes).toString("base64") },
    cause_refs: [],
  };
}

// ── the policy ──────────────────────────────────────────────────────────────────────────────

function refuse(code: MutationError["code"], message: string): PolicyOutcome {
  return { ok: false, error: { committed: false, code, message } };
}

/** The semantic payload an imported document gets. The legacy `type` is carried verbatim —
 *  a foreign type stays foreign — and every frontmatter key the platform has no field for
 *  survives under `content_fields`, alongside the whole manifest row so the record itself
 *  says where it came from. */
function importedPayload(row: LegacyManifestRow, raw: string): Record<string, unknown> {
  if (row.binary) {
    return {
      title: row.path, description: "", type: "", tags: [], body: "", resource: null,
      content_fields: { zz_profile: BINARY_PROFILE, zz_legacy: { ...row } },
    };
  }
  const { profile, fields, body } = readLegacyDocument(raw);
  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (key === "body" || key === "zz_profile" || key === "title" || key === "description" || key === "type" || key === "tags") continue;
    extra[key] = value;
  }
  return {
    title: typeof fields.title === "string" ? fields.title : row.path,
    description: typeof fields.description === "string" ? fields.description : "",
    type: typeof fields.type === "string" ? fields.type : "",
    tags: Array.isArray(fields.tags) ? fields.tags.filter((t): t is string => typeof t === "string") : [],
    body,
    resource: null,
    content_fields: { ...extra, zz_profile: profile, zz_legacy: { ...row } },
  };
}

interface ParsedImportPayload {
  readonly row: LegacyManifestRow;
  readonly manifestId: string;
  readonly bytes: Buffer;
}

function readImportPayload(payload: Record<string, unknown>): ParsedImportPayload | MutationError {
  const legacy = payload.legacy;
  if (!legacy || typeof legacy !== "object") return invalid("import_legacy requires a payload.legacy manifest row");
  const row = legacy as LegacyManifestRow & { manifest_id?: unknown; format_version?: unknown };
  if (row.format_version !== LEGACY_MANIFEST_FORMAT_VERSION) {
    return invalid(`this importer reads conversion manifest format ${LEGACY_MANIFEST_FORMAT_VERSION}, got ${JSON.stringify(row.format_version)}`);
  }
  if (typeof row.path !== "string" || typeof row.sha256 !== "string" || typeof row.manifest_id !== "string") {
    return invalid("payload.legacy must carry path, sha256 and manifest_id");
  }
  if (typeof payload.bytes_base64 !== "string") return invalid("import_legacy requires payload.bytes_base64");
  const bytes = Buffer.from(payload.bytes_base64, "base64");
  // "ALTERED SOURCE HASH BLOCKS CUTOVER", checked here rather than only at the CLI: the bytes
  // that reach the commit are the ones re-hashed, so nothing can be substituted between the
  // manifest being approved and the import being applied.
  if (sha256Hex(bytes) !== row.sha256) {
    return { committed: false, code: "INVALID_INPUT", message: `the bytes presented for ${row.path} hash to ${sha256Hex(bytes)}, not the manifest's ${row.sha256}` };
  }
  if (bytes.byteLength !== row.byte_length) {
    return invalid(`the bytes presented for ${row.path} are ${bytes.byteLength} long, not the manifest's ${row.byte_length}`);
  }
  return { row, manifestId: row.manifest_id, bytes };
}

/**
 * `import_legacy`'s policy — the one operation `nativePolicy` deliberately does not handle.
 *
 * It produces a revision 1 whose `origin_profile` is `legacy_import`, whose `generated` block
 * names neither an author nor a time unless the source declared one this reader could parse,
 * whose `sources` list is empty and whose `legacy_unresolved_sources` carries every reference
 * the source declared that nothing here resolved. `ContentRevisionSchema` permits that shape
 * for an import and refuses it for a native write, which is the schema doing the work of
 * keeping "we imported this" and "we wrote this" apart.
 *
 * The import event is `legacy_imported` and its actor and time are the IMPORT's, which are
 * known facts about the conversion — never a claim about who wrote the original or when.
 */
export const legacyImportPolicy: Policy = (request, ctx) => {
  if (request.operation !== "import_legacy") {
    return refuse("INVALID_INPUT", `legacyImportPolicy handles import_legacy only, got ${JSON.stringify(request.operation)}`);
  }
  const artifactId = request.artifact_id;
  if (artifactId === undefined) return refuse("INVALID_INPUT", "import_legacy names the artifact_id its locator determines");
  // DUPLICATE IDENTITY BLOCKS CUTOVER. A replay of the same import never reaches policy at
  // all — the kernel answers it from the idempotency index — so a head already here means a
  // DIFFERENT manifest is claiming a locator this store has already adopted.
  if (ctx.getHead(artifactId) !== null) {
    return refuse("IDEMPOTENCY_CONFLICT", `artifact ${artifactId} already exists in this store; a second manifest may not re-import the same legacy locator`);
  }
  const parsed = readImportPayload(request.payload);
  if ("committed" in parsed) return { ok: false, error: parsed };
  const { row, bytes } = parsed;

  if (legacyArtifactId(ctx.owner_id, row.path) !== artifactId) {
    return refuse("INVALID_INPUT", `artifact_id ${artifactId} is not the identity ${row.path} determines for owner ${ctx.owner_id}`);
  }
  if (legacyLocatorRefusal(row.path)) return refuse("INVALID_INPUT", `${row.path} is not a locator this store can archive`);

  const raw = row.binary ? "" : bytes.toString("utf8");
  const payload = importedPayload(row, raw);
  const contentHash = canonicalHash(payload);
  const now = new Date().toISOString();

  const originalBlob: PreparedBlob = { hash: row.sha256, bytes };
  const bodyBytes = Buffer.from(String(payload.body ?? ""), "utf8");
  const bodyBlob: PreparedBlob = { hash: sha256Hex(bodyBytes), bytes: bodyBytes };

  const capture: SourceCapture = {
    owner_id: ctx.owner_id, artifact_id: legacySourceArtifactId(ctx.owner_id, row.path),
    original_path: row.path, title: row.path, media_type: row.media_type,
    byte_length: row.byte_length, blob_hash: row.sha256,
    // The CONVERSION's time and actor, and the contract says so in as many words: the import
    // record describes the conversion, not the truth of the historical claim it carries.
    captured_at: now, captured_by: ctx.actor, original_locator: row.path,
  };
  if (!SourceCaptureSchema.safeParse(capture).success) return refuse("INVALID_INPUT", `prepared legacy capture for ${row.path} failed validation`);

  const revision: ContentRevision = {
    owner_id: ctx.owner_id, artifact_id: artifactId, revision: 1, content_hash: contentHash,
    payload: payload as ContentRevision["payload"],
    cause_refs: [], sources: [],
    generated: { by: null, at: row.original_time },
    origin_profile: "legacy_import",
    legacy_unresolved_sources: [...row.unresolved_references],
    previous_revision: null,
  };
  const revisionCheck = ContentRevisionSchema.safeParse(revision);
  if (!revisionCheck.success) {
    return refuse("INVALID_INPUT", `prepared legacy revision for ${row.path} failed validation: ${revisionCheck.error.issues.map((i) => i.message).join("; ")}`);
  }

  const captureEvent: ArtifactEvent = {
    event_id: randomUUID(), transaction_id: ctx.transaction_id, owner_id: ctx.owner_id,
    artifact_id: capture.artifact_id, sequence: ctx.sequence, at: now, actor: ctx.actor,
    kind: "created", revision: null, content_hash: row.sha256, cause_refs: [],
    data: { artifact_class: "source", legacy_archive: `${LEGACY_ARCHIVE_DIR}/${row.path}` },
  };
  const importEvent: ArtifactEvent = {
    event_id: randomUUID(), transaction_id: ctx.transaction_id, owner_id: ctx.owner_id,
    artifact_id: artifactId, sequence: ctx.sequence, at: now, actor: ctx.actor,
    kind: "legacy_imported", revision: 1, content_hash: contentHash, cause_refs: [],
    data: {
      manifest_id: parsed.manifestId, legacy_path: row.path, legacy_sha256: row.sha256,
      legacy_id: row.legacy_id, history_label: row.history_label, profile: row.profile,
      original_time: row.original_time, original_time_precision: row.original_time_precision,
      oversized_legacy_exception: row.byte_length > MAX_INPUT_BYTES,
    },
  };
  for (const event of [captureEvent, importEvent]) {
    if (!ArtifactEventSchema.safeParse(event).success) return refuse("INVALID_INPUT", `prepared legacy event for ${row.path} failed validation`);
  }

  const fileChanges: FileChangeEntry[] = [
    { path: `${LEGACY_ARCHIVE_DIR}/${row.path}`, before_hash: null, after_hash: row.sha256 },
    { path: `documents/${artifactId}.md`, before_hash: null, after_hash: bodyBlob.hash },
  ];
  return {
    ok: true,
    result: {
      artifact_id: artifactId, changed: true, revision: 1, content_hash: contentHash,
      file_changes: fileChanges, source_captures: [capture],
      revisions: [revision], events: [captureEvent, importEvent],
      blobs: originalBlob.hash === bodyBlob.hash ? [originalBlob] : [originalBlob, bodyBlob],
    },
  };
};
