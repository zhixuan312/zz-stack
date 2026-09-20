/**
 * export.ts — OKF (Open Knowledge Format) interoperability: reading a foreign or native OKF
 * markdown document into a parsed record, writing one back out, telling native ZZ knowledge
 * concepts from merely-valid-OKF foreign ones, and assembling an authorized export bundle.
 *
 * EVERY CLAUSE HERE GUARDS AGAINST AN IMPORT QUIETLY INVENTING HISTORY. A round trip through
 * this module must never manufacture a fact nobody asserted:
 *   - `verified_against` (a subject-VERSION string a foreign tool wrote) is never turned into
 *     a `{by, at}` verification EVENT — nobody performed that verification, and synthesizing
 *     one would forge a claim of review that never happened. See `parseKnowledge` below: it
 *     reads `verified_against` and does nothing else with it, ever.
 *   - `stale_after` is carried through exactly as given, or left absent — never defaulted.
 *   - malformed bytes are retained behind a labelled `legacy-raw` wrapper, never discarded and
 *     never silently reinterpreted as a native record with defaults filled in.
 *   - a private/unauthorized source citation in an exported bundle is rendered as
 *     `{unresolved: true}` and NOTHING else — not its ref, not its resource string, not a
 *     reason naming its owner. Leaking any of that through a "redaction" would be the same
 *     quiet history-invention wearing a metadata-leak costume.
 *
 * A REAL YAML PARSER/SERIALIZER, not line-regex parsing: the `yaml` package (see
 * `services/zz-core/package.json`) round-trips arbitrary nesting, flow collections, quoted
 * scalars and the rest of the format a foreign OKF export can legally contain. The only
 * regular expression in this file finds the `---` frontmatter FENCES — a structural framing
 * concern, never the YAML content between them.
 *
 * validateNative and validateOkf are two INDEPENDENT verdicts. A record can satisfy one and
 * fail the other (any foreign `type` is valid OKF and never valid native), and passing either
 * one is a structural fact about shape — NEITHER certifies that a claim is true or that a
 * person approved it. That is the platform's separate gate/approval workflow.
 */
import { createHash } from "node:crypto";

import type { ArtifactEvent, ArtifactRef, ContentRevision } from "@zz/contracts";
import { KnowledgeTypeSchema } from "@zz/contracts";
import { parse, stringify } from "yaml";

// ── the three profiles a parsed record can carry ────────────────────────────────────────────

export const NATIVE_PROFILE = "zz-knowledge-v1" as const;
export const LEGACY_PROFILE = "legacy-okf" as const;
export const RAW_PROFILE = "legacy-raw" as const;

// Not exported: nothing outside this module names the type, only the three constants above —
// see hygiene.ts's "nothing exported that nobody imports" for why an unused export stays local.
type OkfProfile = typeof NATIVE_PROFILE | typeof LEGACY_PROFILE | typeof RAW_PROFILE;

const NATIVE_TYPES: readonly string[] = KnowledgeTypeSchema.options;

/**
 * A parsed OKF document: every frontmatter key survives verbatim (an index signature, because
 * a foreign document's unknown keys — top-level and nested — are exactly what must round-trip
 * untouched), plus the two fields this module always computes itself: `zz_profile` (never
 * trusted from the input — a document cannot claim its own profile) and `body`.
 */
interface ParsedKnowledge {
  readonly [field: string]: unknown;
  readonly zz_profile: OkfProfile;
  readonly body: string;
}

interface ValidationResult {
  readonly ok: boolean;
  readonly errors: readonly string[];
}

// ── frontmatter framing ──────────────────────────────────────────────────────────────────────

/**
 * Locates the `---` fences a document opens with, line by line — STRUCTURAL framing only,
 * never a stand-in for parsing the YAML between them (that is `parse()`'s job, below). A
 * fence line must be exactly `---`; the first two such lines bound the frontmatter block,
 * however many lines apart — including zero, for an intentionally empty block. The single
 * conventional blank separator line right after the closing fence, if present, is stripped;
 * anything past that is the body verbatim.
 */
function splitFrontmatter(raw: string): { frontmatterText: string; body: string } | null {
  const lines = raw.split(/\r?\n/);
  if (lines[0] !== "---") return null;
  const closeIndex = lines.indexOf("---", 1);
  if (closeIndex === -1) return null;
  const frontmatterText = lines.slice(1, closeIndex).join("\n");
  const bodyLines = lines.slice(closeIndex + 1);
  if (bodyLines[0] === "") bodyLines.shift();
  return { frontmatterText, body: bodyLines.join("\n") };
}

function wrapRaw(raw: string, reason: string): ParsedKnowledge {
  // "Malformed legacy bytes are retained behind a labelled wrapper, never discarded" — the
  // spec's own words for this shape: `type: "Reference"`, `zz_profile: "legacy-raw"`, and the
  // COMPLETE original bytes under a name that says exactly what they are and why they are
  // here, never merged into any field a reader might mistake for parsed content.
  return {
    type: "Reference",
    zz_profile: RAW_PROFILE,
    legacy_raw_bytes: raw,
    legacy_raw_reason: reason,
    body: "",
  };
}

/**
 * Parses raw OKF markdown (a `---`-fenced YAML frontmatter block, then a body) into a
 * `ParsedKnowledge` record. Import-safe: no filesystem or network access, pure function of its
 * one argument.
 */
export function parseKnowledge(raw: string): ParsedKnowledge {
  const split = splitFrontmatter(raw);
  if (!split) return wrapRaw(raw, "no YAML frontmatter block was found (expected a leading and a closing `---` fence)");
  const { frontmatterText, body: bodyText } = split;

  let parsed: unknown;
  try {
    parsed = parse(frontmatterText);
  } catch (err) {
    return wrapRaw(raw, `frontmatter did not parse as YAML: ${err instanceof Error ? err.message : String(err)}`);
  }

  // An EMPTY frontmatter block is valid YAML (`parse("")` is `undefined`/`null`) — that is a
  // document with no declared fields, not malformed content. Only a non-mapping, non-empty
  // result (a bare scalar, a bare sequence) is refused as malformed.
  let fields: Record<string, unknown>;
  if (parsed === undefined || parsed === null) {
    fields = {};
  } else if (typeof parsed === "object" && !Array.isArray(parsed)) {
    fields = parsed as Record<string, unknown>;
  } else {
    return wrapRaw(raw, "frontmatter must parse to a YAML mapping");
  }

  const type = typeof fields.type === "string" ? fields.type : "";
  const profile: OkfProfile = NATIVE_TYPES.includes(type) ? NATIVE_PROFILE : LEGACY_PROFILE;

  const normalized: Record<string, unknown> = { ...fields };
  // "Accept a bare `verified` mapping as a one-element list" — and ONLY a bare mapping; any
  // other shape (already a list, a scalar, absent) is left exactly as given.
  if (normalized.verified !== null && typeof normalized.verified === "object" && !Array.isArray(normalized.verified)) {
    normalized.verified = [normalized.verified];
  }
  // `verified_against` IS NOT TOUCHED — no branch anywhere in this function reads it. That
  // silence is the guard: reading it here to synthesize `verified` is the exact defect this
  // module exists to prevent. See this file's header and the mutation test named in the task
  // report for how that guard is proven, not merely asserted.

  return { ...normalized, zz_profile: profile, body: bodyText };
}

/**
 * Serializes a `ParsedKnowledge` record back to OKF markdown. `legacy-raw` records hand back
 * their preserved original bytes exactly — they were never real YAML, so there is nothing to
 * re-encode. Everything else goes through the real YAML serializer; per the spec, formatting
 * need not preserve the ORIGINAL spelling (comments, quote style, key order) — only the parsed
 * VALUES need to survive, which `serializeKnowledge(parseKnowledge(x))` proves by round-trip.
 */
export function serializeKnowledge(parsed: ParsedKnowledge): string {
  if (parsed.zz_profile === RAW_PROFILE) {
    return typeof parsed.legacy_raw_bytes === "string" ? parsed.legacy_raw_bytes : "";
  }
  const { body, zz_profile: _zz_profile, ...rest } = parsed;
  const frontmatter = stringify(rest, { lineWidth: 0 });
  return `---\n${frontmatter}---\n\n${body}`;
}

// ── the two independent verdicts ────────────────────────────────────────────────────────────

/**
 * Whether `parsed` is a well-formed NATIVE ZZ knowledge concept: one of the four native types,
 * carrying the native profile, with the minimal shape a native concept always has. Structural
 * only — see this file's header on what "certifies" does and does not mean here.
 */
export function validateNative(parsed: ParsedKnowledge): ValidationResult {
  const errors: string[] = [];
  const type = typeof parsed.type === "string" ? parsed.type : "";
  if (parsed.zz_profile !== NATIVE_PROFILE) {
    errors.push(`zz_profile must be "${NATIVE_PROFILE}" for a native concept, got ${JSON.stringify(parsed.zz_profile)}`);
  }
  // A FOREIGN TYPE CANNOT SILENTLY PASS: repeated on purpose even though `zz_profile` above
  // already implies it — `zz_profile` is this module's own computed tag, and a caller handing
  // in a hand-built record with a mismatched pair (foreign `type`, forged native profile)
  // must still be refused on the fact that actually matters.
  if (!NATIVE_TYPES.includes(type)) {
    errors.push(`type must be one of ${NATIVE_TYPES.join("/")} for a native concept, got ${JSON.stringify(type)}`);
  }
  if (typeof parsed.title !== "string" || parsed.title.length === 0) errors.push("a native concept requires a non-empty title");
  if (typeof parsed.description !== "string") errors.push("a native concept requires a description string");
  return { ok: errors.length === 0, errors };
}

/**
 * Whether `parsed` is OFFICIAL-OKF conformant — the loose, foreign-tool contract, independent
 * of the stricter native profile above. OKF's own requirement is a non-empty `type`; malformed
 * (`legacy-raw`) content never conforms, because it was never parsed as OKF at all.
 */
export function validateOkf(parsed: ParsedKnowledge): ValidationResult {
  const errors: string[] = [];
  if (parsed.zz_profile === RAW_PROFILE) errors.push("malformed/unparsed content is not OKF-conformant");
  const type = typeof parsed.type === "string" ? parsed.type : "";
  if (type.trim().length === 0) errors.push("OKF requires a non-empty type");
  return { ok: errors.length === 0, errors };
}

// ── authorized export bundle ─────────────────────────────────────────────────────────────────

interface OkfBundleFile {
  readonly path: string;
  readonly content: string;
  readonly sha256: string;
}

interface OkfBundle {
  readonly files: readonly OkfBundleFile[];
}

function sha256Hex(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function fileOf(path: string, content: string): OkfBundleFile {
  return { path, content, sha256: sha256Hex(content) };
}

/**
 * The CURRENT applicable verification for one artifact, derived only from real `verified`
 * events — `by`/`at` are the event's own `actor`/`at`, never invented. The most recent one
 * wins; every verification (current or superseded) still appears in `log.md`, which is built
 * from the same `events` list and never filtered by "current".
 */
function currentVerification(artifactId: string, events: readonly ArtifactEvent[]): { by: string; at: string } | undefined {
  const verifications = events.filter((e) => e.artifact_id === artifactId && e.kind === "verified");
  if (verifications.length === 0) return undefined;
  const latest = verifications.reduce((a, b) => (a.sequence > b.sequence ? a : b));
  return { by: latest.actor, at: latest.at };
}

/**
 * One concept file's frontmatter, mapped from the platform's own `ContentRevision`:
 * `resource` is the described underlying asset (the payload's own `resource` field, which may
 * legitimately be null — never platform identity); `zz_artifact_id` is platform identity;
 * `generated.at` is content-change time — no competing timestamp field is ever added.
 *
 * `authorized(ref)` decides per-citation whether the caller may see the source it names. An
 * unauthorized citation is rendered as `{unresolved: true}` and NOTHING else — the object has
 * exactly that one key, so no ref, resource string or reason can leak through it.
 */
function bundleFrontmatter(
  revision: ContentRevision, events: readonly ArtifactEvent[], authorized: (ref: ArtifactRef) => boolean,
): Record<string, unknown> {
  const verified = currentVerification(revision.artifact_id, events);
  const frontmatter: Record<string, unknown> = {
    type: revision.payload.type,
    title: revision.payload.title,
    description: revision.payload.description,
    tags: revision.payload.tags,
    resource: revision.payload.resource,
    zz_artifact_id: revision.artifact_id,
    generated: { by: revision.generated.by, at: revision.generated.at },
    sources: revision.sources.map((citation) => (authorized(citation.ref)
      ? { id: citation.id, resource: citation.resource, ref: citation.ref }
      : { unresolved: true })),
  };
  if (Object.keys(revision.payload.content_fields).length > 0) frontmatter.content_fields = revision.payload.content_fields;
  if (verified) frontmatter.verified = [verified];
  return frontmatter;
}

/** `index.md`'s reserved structure: one line per exported concept, naming what a reader needs
 *  to find it again — its native type, its title and its stable platform identity. No spec for
 *  this file existed before this task; this is the minimum this task defines it as. */
function indexFile(revisions: readonly ContentRevision[]): OkfBundleFile {
  const lines = ["# index", "", ...revisions.map((r) => `- [${r.payload.type}] ${r.payload.title} (${r.artifact_id})`), ""];
  return fileOf("index.md", lines.join("\n"));
}

/** `log.md`'s reserved structure: one line per event, in the order given — the FULL trail,
 *  including every superseded verification `bundleFrontmatter` did not carry forward. */
function logFile(events: readonly ArtifactEvent[]): OkfBundleFile {
  const lines = ["# log", "", ...events.map((e) => `- ${e.at} ${e.kind} ${e.actor} ${e.artifact_id}`), ""];
  return fileOf("log.md", lines.join("\n"));
}

/**
 * Assembles an authorized OKF export bundle from already-resolved platform records — no
 * filesystem or store access of its own, so "internal transaction files and unrelated
 * bookkeeping never enter the bundle" holds structurally: nothing but `revisions` and `events`
 * can end up in it. `revisions` is the CURRENT revision of each exported artifact, never a
 * full history — history is exactly what `events` (and `log.md`) carries.
 *
 * Reuses `serializeKnowledge` for every concept file rather than a second YAML writer, which
 * is what makes this the one delegation point a CLI exporter needs.
 */
export function buildOkfBundle(
  revisions: readonly ContentRevision[],
  events: readonly ArtifactEvent[],
  authorized: (ref: ArtifactRef) => boolean,
): OkfBundle {
  const concepts = revisions.map((revision) => {
    const frontmatter = bundleFrontmatter(revision, events, authorized);
    const type = typeof frontmatter.type === "string" ? frontmatter.type : "";
    const profile: OkfProfile = NATIVE_TYPES.includes(type) ? NATIVE_PROFILE : LEGACY_PROFILE;
    const content = serializeKnowledge({ ...frontmatter, zz_profile: profile, body: revision.payload.body });
    return fileOf(`${revision.artifact_id}.md`, content);
  });
  return { files: [...concepts, indexFile(revisions), logFile(events)] };
}
