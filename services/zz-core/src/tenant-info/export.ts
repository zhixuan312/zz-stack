/**
 * OKF (Open Knowledge Format) interoperability: reading a foreign or native OKF markdown
 * document into a parsed record, writing one back out, telling native ZZ knowledge concepts
 * from merely-valid-OKF foreign ones, and assembling an authorized export bundle.
 *
 * DELIBERATE: a round trip through this module never manufactures a fact nobody asserted.
 *   - `verified_against` (a subject-version string a foreign tool wrote) is never turned into
 *     a `{by, at}` verification event — that would forge a claim of review. `parseKnowledge`
 *     reads it and does nothing else with it.
 *   - `stale_after` is carried through exactly as given, or left absent, never defaulted.
 *   - malformed bytes are retained behind a labelled `legacy-raw` wrapper, never discarded
 *     and never reinterpreted as a native record with defaults filled in.
 *   - an unauthorized source citation in an exported bundle is rendered as
 *     `{unresolved: true}` and nothing else — not its ref, not its resource string, not a
 *     reason naming its owner.
 *
 * Parsed and serialized by the `yaml` package, not by line regex: a foreign OKF export can
 * legally contain arbitrary nesting, flow collections and quoted scalars. The only regular
 * expression here finds the `---` frontmatter fences, never the YAML between them.
 *
 * validateNative and validateOkf are two independent verdicts. A record can satisfy one and
 * fail the other — any foreign `type` is valid OKF and never valid native — and passing
 * either is a fact about shape, not about whether a claim is true or a person approved it.
 */
import { createHash } from "node:crypto";

import type { ArtifactEvent, ArtifactRef, ContentRevision } from "@zz/contracts";
import { KnowledgeTypeSchema } from "@zz/contracts";
import { parse, stringify } from "yaml";

// The three profiles a parsed record can carry

export const NATIVE_PROFILE = "zz-knowledge-v1" as const;
export const LEGACY_PROFILE = "legacy-okf" as const;
export const RAW_PROFILE = "legacy-raw" as const;

// Not exported: nothing outside this module names the type, only the three constants above.
type OkfProfile = typeof NATIVE_PROFILE | typeof LEGACY_PROFILE | typeof RAW_PROFILE;

const NATIVE_TYPES: readonly string[] = KnowledgeTypeSchema.options;

/**
 * A parsed OKF document: every frontmatter key survives verbatim, hence the index signature,
 * plus the two fields this module computes itself — `zz_profile`, never read from the input
 * because a document cannot claim its own profile, and `body`.
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

// Frontmatter framing

/**
 * Locates the `---` fences a document opens with, line by line — framing only, never a
 * stand-in for parsing the YAML between them. A fence line must be exactly `---`; the first
 * two such lines bound the frontmatter block, however many lines apart, including zero for an
 * empty block. One blank separator line after the closing fence is stripped; anything past
 * that is the body verbatim.
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
  // Malformed legacy bytes are retained behind a labelled wrapper, never discarded: the
  // complete original bytes under a name saying what they are and why, never merged into a
  // field a reader might mistake for parsed content.
  return {
    type: "Reference",
    zz_profile: RAW_PROFILE,
    legacy_raw_bytes: raw,
    legacy_raw_reason: reason,
    body: "",
  };
}

/**
 * Whether `raw` opens with a frontmatter block at all, decided by the same framing this
 * module's parser uses.
 *
 * `parseKnowledge` answers "no frontmatter" and "broken YAML" with the same `legacy-raw`
 * wrapper, which is right for a knowledge document, where frontmatter is mandatory. A
 * migration needs the two apart — plain Markdown with no frontmatter is not malformed YAML —
 * so `legacy-import.ts` asks this first.
 */
export function hasFrontmatter(raw: string): boolean {
  return splitFrontmatter(raw) !== null;
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

  // An empty frontmatter block is valid YAML — `parse("")` is `undefined`/`null` — and means
  // a document with no declared fields. Only a non-empty non-mapping result, a bare scalar or
  // sequence, is refused as malformed.
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
  // A bare `verified` mapping becomes a one-element list. Only a bare mapping: a list, a
  // scalar or an absent value is left exactly as given.
  if (normalized.verified !== null && typeof normalized.verified === "object" && !Array.isArray(normalized.verified)) {
    normalized.verified = [normalized.verified];
  }
  // DELIBERATE: no branch in this function reads `verified_against`. Reading it here to
  // synthesize `verified` would forge a verification nobody performed.

  return { ...normalized, zz_profile: profile, body: bodyText };
}

/**
 * Serializes a `ParsedKnowledge` record back to OKF markdown. `legacy-raw` records hand back
 * their preserved original bytes exactly — they were never real YAML, so there is nothing to
 * re-encode. Everything else goes through the YAML serializer, which preserves the parsed
 * values but not the original spelling: comments, quote style and key order may all move.
 */
export function serializeKnowledge(parsed: ParsedKnowledge): string {
  if (parsed.zz_profile === RAW_PROFILE) {
    return typeof parsed.legacy_raw_bytes === "string" ? parsed.legacy_raw_bytes : "";
  }
  const { body, zz_profile: _zz_profile, ...rest } = parsed;
  const frontmatter = stringify(rest, { lineWidth: 0 });
  return `---\n${frontmatter}---\n\n${body}`;
}

// The two independent verdicts

/**
 * Whether `parsed` is a well-formed native ZZ knowledge concept: one of the native types,
 * carrying the native profile, with the minimal shape a native concept has. Structural only.
 */
export function validateNative(parsed: ParsedKnowledge): ValidationResult {
  const errors: string[] = [];
  const type = typeof parsed.type === "string" ? parsed.type : "";
  if (parsed.zz_profile !== NATIVE_PROFILE) {
    errors.push(`zz_profile must be "${NATIVE_PROFILE}" for a native concept, got ${JSON.stringify(parsed.zz_profile)}`);
  }
  // DELIBERATE: checked again although `zz_profile` above implies it. `zz_profile` is this
  // module's computed tag, and a hand-built record can carry a foreign `type` with a forged
  // native profile.
  if (!NATIVE_TYPES.includes(type)) {
    errors.push(`type must be one of ${NATIVE_TYPES.join("/")} for a native concept, got ${JSON.stringify(type)}`);
  }
  if (typeof parsed.title !== "string" || parsed.title.length === 0) errors.push("a native concept requires a non-empty title");
  if (typeof parsed.description !== "string") errors.push("a native concept requires a description string");
  return { ok: errors.length === 0, errors };
}

/**
 * Whether `parsed` is OKF-conformant — the foreign-tool contract, independent of the native
 * profile above. OKF requires a non-empty `type`; `legacy-raw` content never conforms,
 * because it was never parsed as OKF.
 */
export function validateOkf(parsed: ParsedKnowledge): ValidationResult {
  const errors: string[] = [];
  if (parsed.zz_profile === RAW_PROFILE) errors.push("malformed/unparsed content is not OKF-conformant");
  const type = typeof parsed.type === "string" ? parsed.type : "";
  if (type.trim().length === 0) errors.push("OKF requires a non-empty type");
  return { ok: errors.length === 0, errors };
}

// Authorized export bundle

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
 * The current applicable verification for one artifact, derived only from real `verified`
 * events — `by`/`at` are the event's own `actor`/`at`. The most recent wins; every
 * verification, current or superseded, still appears in `log.md`, which is built from the
 * same `events` list unfiltered.
 */
function currentVerification(artifactId: string, events: readonly ArtifactEvent[]): { by: string; at: string } | undefined {
  const verifications = events.filter((e) => e.artifact_id === artifactId && e.kind === "verified");
  if (verifications.length === 0) return undefined;
  const latest = verifications.reduce((a, b) => (a.sequence > b.sequence ? a : b));
  return { by: latest.actor, at: latest.at };
}

/**
 * One concept file's frontmatter, mapped from the platform's own `ContentRevision`:
 * `resource` is the described underlying asset, which may legitimately be null and is never
 * platform identity; `zz_artifact_id` is platform identity; `generated.at` is content-change
 * time, and no competing timestamp field is added.
 *
 * `authorized(ref)` decides per citation whether the caller may see the source it names. An
 * unauthorized citation is `{unresolved: true}` with exactly that one key, so no ref,
 * resource string or reason can leak through it.
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

/** `index.md`: one line per exported concept — its native type, its title and its stable
 *  platform identity. */
function indexFile(revisions: readonly ContentRevision[]): OkfBundleFile {
  const lines = ["# index", "", ...revisions.map((r) => `- [${r.payload.type}] ${r.payload.title} (${r.artifact_id})`), ""];
  return fileOf("index.md", lines.join("\n"));
}

/** `log.md`: one line per event, in the order given — the full trail, including every
 *  superseded verification `bundleFrontmatter` did not carry forward. */
function logFile(events: readonly ArtifactEvent[]): OkfBundleFile {
  const lines = ["# log", "", ...events.map((e) => `- ${e.at} ${e.kind} ${e.actor} ${e.artifact_id}`), ""];
  return fileOf("log.md", lines.join("\n"));
}

/**
 * Assembles an authorized OKF export bundle from already-resolved platform records, with no
 * filesystem or store access of its own: nothing but `revisions` and `events` can end up in
 * the bundle. `revisions` is the current revision of each exported artifact, never a full
 * history — that is what `events` and `log.md` carry.
 *
 * Every concept file goes through `serializeKnowledge` rather than a second YAML writer.
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
