/**
 * okf.ts — I-12's OKF interoperability case group, over the real `services/zz-core/dist/
 * tenant-info/export.js`. `scripts/tenant-info/suites.ts` reserves the name "okf" at this
 * path, so `verify --suite okf` dynamic-imports it and calls `run`, exactly as `model.ts`
 * does for "model".
 *
 * NOTHING HERE TOUCHES A REAL STORE. Every fixture is a literal in-memory record — a raw OKF
 * markdown string, or a hand-built `ContentRevision`/`ArtifactEvent` — never a file under this
 * checkout and never a live artifact volume.
 *
 * NO OFFICIAL OKF REFERENCE DOCUMENT WAS SUPPLIED to this task or found anywhere in this
 * repository or the tenant-info workspace (checked: no `OKF` hit outside this suite and the
 * frozen check). `REFERENCE_FIXTURE` below is this suite's OWN pinned fixture, named for what
 * it is rather than claimed as "official" — if an actual official conformance reference is
 * meant to exist, it needs to be supplied; this suite cannot invent one honestly.
 */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { ArtifactEvent, ArtifactRef, ContentRevision } from "@zz/contracts";

import {
  buildOkfBundle, LEGACY_PROFILE, NATIVE_PROFILE, parseKnowledge, RAW_PROFILE,
  serializeKnowledge, validateNative, validateOkf,
} from "../../services/zz-core/dist/tenant-info/export.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OWNER = "11111111-1111-4111-8111-111111111111";

// ── fixtures ─────────────────────────────────────────────────────────────────────────────────

function nativeDoc(overrides: Record<string, string> = {}): string {
  const fields: Record<string, string> = { type: "Decision", title: "t", description: "d", ...overrides };
  return ["---", ...Object.entries(fields).map(([k, v]) => `${k}: ${v}`), "---", "", "body"].join("\n");
}

function revision(overrides: Partial<ContentRevision> = {}): ContentRevision {
  return {
    owner_id: OWNER, artifact_id: randomUUID(), revision: 1, content_hash: "0".repeat(64),
    payload: { title: "t", description: "d", type: "Decision", tags: [], body: "body\n", resource: null, content_fields: {} },
    cause_refs: [], sources: [],
    generated: { by: "tester", at: "2026-01-01T00:00:00.000Z" },
    origin_profile: "native", legacy_unresolved_sources: [], previous_revision: null,
    ...overrides,
  };
}

function event(overrides: Partial<ArtifactEvent> = {}): ArtifactEvent {
  return {
    event_id: randomUUID(), transaction_id: randomUUID(), owner_id: OWNER, artifact_id: randomUUID(),
    sequence: 1, at: "2026-01-01T00:00:00.000Z", actor: "tester", kind: "created",
    revision: 1, content_hash: "0".repeat(64), cause_refs: [], data: {},
    ...overrides,
  };
}

// A representative foreign OKF document, pinned by its own sha256 — see this file's header on
// why it is "this suite's fixture", not an official reference.
const REFERENCE_FIXTURE = [
  "---", "type: ExternalNote", "title: reference", "description: a foreign tool's export",
  "resource: https://example.org/asset/42", "unknown_extension:", "  depth: 2",
  "---", "", "reference body",
].join("\n");
const REFERENCE_FIXTURE_DIGEST = createHash("sha256").update(REFERENCE_FIXTURE, "utf8").digest("hex");

// ── case group ───────────────────────────────────────────────────────────────────────────────

function caseNativePositiveRoundTrips(): void {
  const first = parseKnowledge(nativeDoc());
  assert.equal(first.zz_profile, NATIVE_PROFILE);
  assert.equal(validateNative(first).ok, true, JSON.stringify(validateNative(first).errors));
  assert.equal(validateOkf(first).ok, true);
  const second = parseKnowledge(serializeKnowledge(first));
  assert.deepEqual(second, first);
}

function caseNativeNegativeEmptyTypeFailsBoth(): void {
  const parsed = parseKnowledge(nativeDoc({ type: "\"\"" }));
  assert.equal(validateNative(parsed).ok, false);
  assert.equal(validateOkf(parsed).ok, false);
}

function caseForeignTypeIsLegacyOkfNeverNative(): void {
  // The clause under test: official OKF conformance and native-profile validation are
  // SEPARATE verdicts. A foreign type passes one and fails the other, on the same record.
  const parsed = parseKnowledge(REFERENCE_FIXTURE);
  assert.equal(parsed.zz_profile, LEGACY_PROFILE);
  assert.equal(validateOkf(parsed).ok, true, "a well-formed foreign type is still valid OKF");
  assert.equal(validateNative(parsed).ok, false, "a foreign type must never silently pass the native validator");
}

function caseUnknownNestedKeysSurviveRoundTrip(): void {
  const raw = [
    "---", "type: Rule", "title: t", "description: d",
    "extension:", "  list:", "    - a", "    - b: 2", "  flag: true", "  count: 3",
    "---", "", "body",
  ].join("\n");
  const first = parseKnowledge(raw);
  const second = parseKnowledge(serializeKnowledge(first));
  // BY PARSED VALUE, not by re-serialized spelling — the contract only promises the values
  // survive, never the original YAML formatting.
  assert.deepEqual(second.extension, { list: ["a", { b: 2 }], flag: true, count: 3 });
}

function caseMalformedBytesRetainedBehindLegacyRawWrapper(): void {
  const garbled = "not frontmatter at all, just prose\nwith no fences anywhere";
  const parsed = parseKnowledge(garbled);
  assert.equal(parsed.zz_profile, RAW_PROFILE);
  assert.equal(parsed.type, "Reference");
  // Byte-for-byte, not a re-derived or normalized copy.
  assert.equal(parsed.legacy_raw_bytes, garbled);
  assert.equal(validateOkf(parsed).ok, false);
  assert.equal(validateNative(parsed).ok, false);
}

function caseUnparsableYamlIsAlsoLegacyRaw(): void {
  const raw = ["---", "type: Fact", "bad: [unterminated", "---", "", "body"].join("\n");
  const parsed = parseKnowledge(raw);
  assert.equal(parsed.zz_profile, RAW_PROFILE);
  assert.equal(parsed.legacy_raw_bytes, raw);
}

function caseEmptyFrontmatterIsValidNotMalformed(): void {
  // parse("") is valid YAML (no declared fields) — this must never be reported as malformed.
  // Two fences with nothing between them: zero frontmatter lines, still a well-formed block.
  const raw = ["---", "---", "", "body"].join("\n");
  const parsed = parseKnowledge(raw);
  assert.equal(parsed.body, "body");
  assert.notEqual(parsed.zz_profile, RAW_PROFILE);
  assert.equal(validateOkf(parsed).ok, false, "an empty frontmatter has no type, so it fails OKF conformance honestly — not by being marked malformed");
}

function caseVerifiedAgainstNeverBecomesAVerificationEvent(): void {
  const raw = nativeDoc({ verified_against: "subject-v9", stale_after: "2027-01-01" });
  const parsed = parseKnowledge(raw);
  assert.equal(parsed.verified_against, "subject-v9");
  assert.equal(parsed.stale_after, "2027-01-01");
  assert.equal(parsed.verified, undefined, "verified_against must never be read to synthesize a verification event");
}

function caseBareVerifiedMappingBecomesOneElementList(): void {
  const raw = [
    "---", "type: Decision", "title: t", "description: d",
    "verified:", "  by: reviewer-1", "  at: 2026-02-02T00:00:00.000Z",
    "---", "", "body",
  ].join("\n");
  const parsed = parseKnowledge(raw);
  assert.deepEqual(parsed.verified, [{ by: "reviewer-1", at: "2026-02-02T00:00:00.000Z" }]);
}

function casePinnedReferenceFixtureDigest(): void {
  const actual = createHash("sha256").update(REFERENCE_FIXTURE, "utf8").digest("hex");
  assert.equal(actual, REFERENCE_FIXTURE_DIGEST, "the pinned fixture's bytes must not silently drift");
  const parsed = parseKnowledge(REFERENCE_FIXTURE);
  assert.equal(parsed.zz_profile, LEGACY_PROFILE);
  assert.equal(validateOkf(parsed).ok, true);
}

function caseReservedIndexAndLogFilesArePresent(): void {
  const r1 = revision({ payload: { title: "First", description: "d", type: "Decision", tags: [], body: "b\n", resource: null, content_fields: {} } });
  const e1 = event({ artifact_id: r1.artifact_id, kind: "created", at: "2026-01-01T00:00:00.000Z", actor: "a1", sequence: 1 });
  const bundle = buildOkfBundle([r1], [e1], () => true);
  const index = bundle.files.find((f) => f.path === "index.md");
  const log = bundle.files.find((f) => f.path === "log.md");
  assert.ok(index, "index.md must be emitted");
  assert.ok(log, "log.md must be emitted");
  assert.match(index!.content, /\[Decision\] First \(/);
  assert.match(log!.content, /created a1/);
  // Nothing but the exported concepts and the two reserved files — no internal bookkeeping.
  assert.deepEqual(bundle.files.map((f) => f.path).sort(), [`${r1.artifact_id}.md`, "index.md", "log.md"].sort());
}

function caseCurrentVersusHistoricalVerification(): void {
  const artifactId = randomUUID();
  const r1 = revision({ artifact_id: artifactId });
  const older = event({ artifact_id: artifactId, kind: "verified", sequence: 1, actor: "reviewer-old", at: "2026-01-01T00:00:00.000Z" });
  const newer = event({ artifact_id: artifactId, kind: "verified", sequence: 2, actor: "reviewer-new", at: "2026-02-01T00:00:00.000Z" });
  const bundle = buildOkfBundle([r1], [older, newer], () => true);
  const concept = bundle.files.find((f) => f.path === `${artifactId}.md`);
  const parsed = parseKnowledge(concept!.content);
  assert.deepEqual(parsed.verified, [{ by: "reviewer-new", at: "2026-02-01T00:00:00.000Z" }],
    "the frontmatter must carry only the CURRENT applicable verification");
  const log = bundle.files.find((f) => f.path === "log.md")!;
  assert.match(log.content, /reviewer-old/, "the superseded verification must still be in the full history");
  assert.match(log.content, /reviewer-new/);
}

function caseAuthorizedPrivateSourceClosureExport(): void {
  const publicRef: ArtifactRef = { owner_id: OWNER, artifact_id: randomUUID(), revision: 1, content_hash: "1".repeat(64) };
  const privateRef: ArtifactRef = { owner_id: OWNER, artifact_id: randomUUID(), revision: 1, content_hash: "2".repeat(64) };
  const r1 = revision({
    sources: [
      { id: "s1", resource: "https://example.org/public", ref: publicRef },
      { id: "s2", resource: "https://example.org/private-and-secret", ref: privateRef },
    ],
  });
  const authorized = (ref: ArtifactRef): boolean => ref.artifact_id === publicRef.artifact_id;
  const bundle = buildOkfBundle([r1], [], authorized);
  const concept = bundle.files.find((f) => f.path === `${r1.artifact_id}.md`)!;
  const parsed = parseKnowledge(concept.content);
  const sources = parsed.sources as unknown[];
  const privateEntry = sources.find((s) => Object.keys(s as object).length === 1 && (s as { unresolved?: boolean }).unresolved === true);
  assert.ok(privateEntry, "the private citation must be rendered, marked unresolved");
  assert.deepEqual(Object.keys(privateEntry as object), ["unresolved"], "an unresolved citation carries exactly one key");
  // No metadata leakage anywhere in the whole bundle — not just the one field.
  const everything = bundle.files.map((f) => f.content).join("\n");
  assert.ok(!everything.includes(privateRef.artifact_id), "the private ref's identity must not leak into the bundle");
  assert.ok(!everything.includes("private-and-secret"), "the private resource string must not leak into the bundle");
  assert.ok(everything.includes("public"), "the authorized citation is still exported normally");
}

function caseSchemaAgreesWithNativeValidator(): void {
  const schemaPath = join(repoRoot, "packages/contracts/schemas/zz-knowledge-v1.json");
  const schema = JSON.parse(readFileSync(schemaPath, "utf8")) as {
    properties: { type: { enum: string[] }; zz_profile: { const: string } };
  };
  assert.deepEqual(schema.properties.type.enum, ["Decision", "Rule", "Fact", "Defect"]);
  assert.equal(schema.properties.zz_profile.const, NATIVE_PROFILE);
}

const CASES: Readonly<Record<string, () => void>> = {
  native_positive_round_trips: caseNativePositiveRoundTrips,
  native_negative_empty_type_fails_both: caseNativeNegativeEmptyTypeFailsBoth,
  foreign_type_is_legacy_okf_never_native: caseForeignTypeIsLegacyOkfNeverNative,
  unknown_nested_keys_survive_round_trip: caseUnknownNestedKeysSurviveRoundTrip,
  malformed_bytes_retained_behind_legacy_raw_wrapper: caseMalformedBytesRetainedBehindLegacyRawWrapper,
  unparsable_yaml_is_also_legacy_raw: caseUnparsableYamlIsAlsoLegacyRaw,
  empty_frontmatter_is_valid_not_malformed: caseEmptyFrontmatterIsValidNotMalformed,
  verified_against_never_becomes_a_verification_event: caseVerifiedAgainstNeverBecomesAVerificationEvent,
  bare_verified_mapping_becomes_one_element_list: caseBareVerifiedMappingBecomesOneElementList,
  pinned_reference_fixture_digest: casePinnedReferenceFixtureDigest,
  reserved_index_and_log_files_are_present: caseReservedIndexAndLogFilesArePresent,
  current_versus_historical_verification: caseCurrentVersusHistoricalVerification,
  authorized_private_source_closure_export: caseAuthorizedPrivateSourceClosureExport,
  schema_agrees_with_native_validator: caseSchemaAgreesWithNativeValidator,
};

interface CaseResult { readonly status: "passed" | "failed"; readonly reason?: string }
interface SuiteDetail { readonly status: "ran"; readonly cases: Readonly<Record<string, CaseResult>> }
interface SuiteOutcome { readonly passed: boolean; readonly detail: SuiteDetail }

/** `verify --suite okf`'s entry point, same shape as `model.ts`'s. */
export async function run({ cases }: { cases?: string }): Promise<SuiteOutcome> {
  const names = cases === undefined ? Object.keys(CASES) : [cases];
  const results: Record<string, CaseResult> = {};
  for (const name of names) {
    if (!(name in CASES)) {
      results[name] = { status: "failed", reason: `no such okf case: ${name}` };
      continue;
    }
    try {
      CASES[name]();
      results[name] = { status: "passed" };
    } catch (err) {
      results[name] = { status: "failed", reason: err instanceof Error ? err.message : String(err) };
    }
  }
  return { passed: Object.values(results).every((r) => r.status === "passed"), detail: { status: "ran", cases: results } };
}
