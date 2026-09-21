/**
 * migration.ts — I-20's migration suite, and `createMigrationFixture`, which
 * `checks/tenant-migration-losslessness.ts` (frozen) imports by name.
 *
 * THE FIXTURE IS THE REAL IMPORTER AND THE REAL KERNEL. `apply()` calls `mutate()` from
 * `services/zz-core/dist/tenant-info/mutations.js` with `legacyImportPolicy` from
 * `legacy-import.js`, against a real owner store with a real `.zz/commits/` log, and
 * `inspect()` answers by READING THAT LOG BACK — not from anything this file remembered.
 * An in-memory replacement converter would make the whole task vacuous: the contract is about
 * what survives in a durable record, and a fake store has no durable record to survive in.
 *
 * NOTHING HERE TOUCHES A LIVE STORE OR A DATABASE. Every fixture is a `mkdtemp` directory
 * created by this file and removed by its own `close()`. The two cases that would need the
 * isolated projection database report `not_run` with the reason, because this task may not
 * open a database connection — see `CASES` at the bottom for exactly which, and why that is
 * an honest gap rather than a missing pass.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { ArtifactEvent, ContentRevision } from "@zz/contracts";
import { MAX_INPUT_BYTES } from "@zz/indexing";

import {
  BINARY_PROFILE, classifyLegacyInput, LEGACY_ARCHIVE_DIR, legacyArtifactId, legacyImportKey,
  legacyImportPolicy, legacyImportRequest, legacySourceArtifactId, prepareLegacyManifest,
  type LegacyConversionManifest, type LegacyManifestRow, type LegacyProfile,
} from "../../services/zz-core/dist/tenant-info/legacy-import.js";
import { mutate } from "../../services/zz-core/dist/tenant-info/mutations.js";

import type { ClassificationInventory } from "../../scripts/tenant-info/migrate.ts";

import { adoptionCases } from "./migration-adoption.ts";
import { makeStoreRoot } from "./persistence.ts";

const OWNER = "77777777-7777-4777-8777-777777777777";
const ACTOR = "migration-suite";

// ── the fixture the frozen check drives ─────────────────────────────────────────────────────

/** What `inspect()` reports, replayed off the target store's own commit log. `identities` is a
 *  sorted array rather than a count, because "no extra identity" has to mean the same SET and
 *  not merely the same number of them. */
interface MigrationInspection {
  readonly identities: readonly string[];
  readonly revisions: number;
  readonly events: number;
  readonly manifest: readonly LegacyManifestRow[];
}

interface MigrationFixture {
  addInput(path: string, bytes: Buffer): Promise<void>;
  prepare(): Promise<LegacyConversionManifest>;
  apply(manifest: LegacyConversionManifest): Promise<void>;
  inspect(): Promise<MigrationInspection>;
  originalBytes(path: string): Promise<Buffer>;
  // NOT A TOOL: this removes the fixture's own two temporary directories — no door registers
  // a `close`, and the initiative verb is `initiative_close`.
  close(): Promise<void>;
}

type CommitManifest = {
  readonly revisions: readonly ContentRevision[];
  readonly events: readonly ArtifactEvent[];
};

function readCommits(root: string): CommitManifest[] {
  const dir = join(root, ".zz", "commits");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort((a, b) => Number(/^(\d+)-/.exec(a)?.[1] ?? 0) - Number(/^(\d+)-/.exec(b)?.[1] ?? 0))
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as CommitManifest);
}

/** The manifest row a committed revision carries. The row is recorded INSIDE the durable
 *  record (`content_fields.zz_legacy`), so reading it back is reading the migration's own
 *  account of what it did — not this fixture's memory of what it was told to do. */
function committedRow(revision: ContentRevision): LegacyManifestRow | null {
  const fields = revision.payload.content_fields as Record<string, unknown>;
  const row = fields.zz_legacy;
  return row && typeof row === "object" ? row as LegacyManifestRow : null;
}

/**
 * WHERE EACH FIXTURE'S TARGET STORE IS, for the cases below that need to drive `mutate()`
 * directly — a refused import writes no commit, so `inspect()` cannot show one, and the case
 * that proves an altered source hash is refused has to call the kernel itself.
 *
 * A WeakMap rather than a `root` field on the fixture: `createMigrationFixture`'s shape is
 * pinned by the frozen check, and a suite's convenience is not a reason to widen a contract a
 * check was written against.
 */
const FIXTURE_ROOTS = new WeakMap<MigrationFixture, string>();

function storeRootOf(f: MigrationFixture): string {
  const root = FIXTURE_ROOTS.get(f);
  if (!root) throw new Error("this fixture's store root was never recorded");
  return root;
}

function readCommitsOf(f: MigrationFixture): CommitManifest[] {
  return readCommits(storeRootOf(f));
}

/**
 * A disposable migration: a source snapshot directory, a separate target owner store, and the
 * real importer between them. `close()` removes both.
 */
export async function createMigrationFixture(): Promise<MigrationFixture> {
  const target = makeStoreRoot();
  const source = join(target, "..", `source-${createHash("sha256").update(target).digest("hex").slice(0, 12)}`);
  mkdirSync(source, { recursive: true });
  const inputs: { path: string; bytes: Buffer }[] = [];
  const auth = { owner_id: OWNER, actor: ACTOR };

  const fixture: MigrationFixture = {
    async addInput(path, bytes) {
      const file = join(source, ...path.split("/"));
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, bytes);
      inputs.push({ path, bytes });
    },

    async prepare() {
      const { manifest, blocking } = prepareLegacyManifest(inputs);
      if (blocking.length > 0) {
        throw new Error(`the conversion manifest is blocked: ${blocking.map((b) => `${b.path} ${b.code}`).join(", ")}`);
      }
      return manifest;
    },

    async apply(manifest) {
      for (const row of manifest.rows) {
        const bytes = readFileSync(join(source, ...row.path.split("/")));
        const outcome = await mutate({
          root: target, auth, policy: legacyImportPolicy,
          request: legacyImportRequest(OWNER, manifest, row, bytes),
        });
        if (outcome.committed !== true) {
          throw new Error(`importing ${row.path} did not commit: ${JSON.stringify(outcome)}`);
        }
      }
    },

    async inspect() {
      const commits = readCommits(target);
      const identities = new Set<string>();
      let revisions = 0;
      let events = 0;
      const rows: LegacyManifestRow[] = [];
      for (const commit of commits) {
        for (const revision of commit.revisions) {
          revisions += 1;
          identities.add(revision.artifact_id);
          const row = committedRow(revision);
          if (row) rows.push(row);
        }
        for (const event of commit.events) {
          events += 1;
          identities.add(event.artifact_id);
        }
      }
      return {
        identities: [...identities].sort(),
        revisions, events,
        manifest: rows.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
      };
    },

    /** The archived original, read back CONTENT-ADDRESSED: the hash comes off the committed
     *  row and the bytes come out of `.zz/blobs/<hash>`. Reading the materialized copy instead
     *  would prove only that a file exists at a path; this proves the bytes the record claims
     *  are the bytes the store holds — and asserts the materialized copy agrees. */
    async originalBytes(path) {
      const row = (await this.inspect()).manifest.find((r) => r.path === path);
      if (!row) throw new Error(`no committed migration row for ${path}`);
      const blob = readFileSync(join(target, ".zz", "blobs", row.sha256));
      const materialized = readFileSync(join(target, LEGACY_ARCHIVE_DIR, ...path.split("/")));
      assert.ok(blob.equals(materialized), `the archived copy of ${path} differs from its blob`);
      return blob;
    },

    // NOT A TOOL: the fixture method declared above — it removes this migration's own two
    // temporary directories. The initiative verb is `initiative_close`.
    async close() {
      rmSync(target, { recursive: true, force: true });
      rmSync(source, { recursive: true, force: true });
    },
  };
  FIXTURE_ROOTS.set(fixture, target);
  return fixture;
}

// ── cases ───────────────────────────────────────────────────────────────────────────────────

async function withFixture(body: (f: MigrationFixture) => Promise<void>): Promise<void> {
  const f = await createMigrationFixture();
  try { await body(f); } finally { await f.close(); }
}

const CRLF_DOC = "---\r\ntype: ForeignType\r\ntitle: A\r\n---\r\nbody\r\n";
const BROKEN_YAML = "---\ntype: [broken\n---\nbody";

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** The frozen check's own shape, run inside the suite too — a check that only exists at
 *  `checks/` is a check the acceptance profile never sees. */
async function caseSameManifestTwiceAddsNothing(): Promise<void> {
  await withFixture(async (f) => {
    await f.addInput("a.md", Buffer.from(CRLF_DOC));
    await f.addInput("bad.md", Buffer.from(BROKEN_YAML));
    const manifest = await f.prepare();
    await f.apply(manifest);
    const first = await f.inspect();
    await f.apply(manifest);
    const second = await f.inspect();
    assert.deepEqual(second.identities, first.identities, "a second apply minted an identity");
    assert.equal(second.revisions, first.revisions, "a second apply wrote a revision");
    assert.equal(second.events, first.events, "a second apply wrote an event");
    assert.ok(first.revisions > 0 && first.events > 0, "the first apply must actually have written something");
    // The key is the whole reason the above is true — pinned here so a change to how it is
    // derived is a red case and not a silently-weakened guarantee.
    const row = first.manifest.find((r) => r.path === "a.md")!;
    assert.equal(legacyImportKey(manifest.manifest_id, row), legacyImportKey(manifest.manifest_id, row));
    assert.ok(legacyImportKey(manifest.manifest_id, row).startsWith("legacy-import:"));
  });
}

/** Re-preparing the same inputs must give the same manifest id, or the second apply would
 *  carry different idempotency keys and re-import everything under the same identities. */
async function casePrepareIsDeterministic(): Promise<void> {
  await withFixture(async (f) => {
    await f.addInput("a.md", Buffer.from(CRLF_DOC));
    await f.addInput("b.md", Buffer.from("---\ntype: Decision\n---\nb\n"));
    const first = await f.prepare();
    const second = await f.prepare();
    assert.equal(second.manifest_id, first.manifest_id);
    assert.deepEqual(second.rows, first.rows);
  });
}

async function caseOriginalBytesSurviveEveryProfile(): Promise<void> {
  const binary = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe, 0x01]);
  await withFixture(async (f) => {
    await f.addInput("a.md", Buffer.from(CRLF_DOC));
    await f.addInput("bad.md", Buffer.from(BROKEN_YAML));
    await f.addInput("logo.png", binary);
    await f.apply(await f.prepare());
    assert.equal((await f.originalBytes("a.md")).toString(), CRLF_DOC, "CRLF must survive byte for byte");
    assert.equal((await f.originalBytes("bad.md")).toString(), BROKEN_YAML, "unparsable bytes must survive verbatim");
    assert.ok((await f.originalBytes("logo.png")).equals(binary), "binary bytes must survive verbatim");
    const rows = (await f.inspect()).manifest;
    assert.equal(rows.find((r) => r.path === "a.md")?.sha256, sha256(Buffer.from(CRLF_DOC)));
    assert.equal(rows.find((r) => r.path === "bad.md")?.profile, "legacy-raw");
    assert.equal(rows.find((r) => r.path === "logo.png")?.profile, BINARY_PROFILE);
    assert.equal(rows.find((r) => r.path === "logo.png")?.binary, true);
  });
}

/**
 * "PLAIN MARKDOWN WITH NO FRONTMATTER IS NOT AUTOMATICALLY MALFORMED YAML", which is the
 * contract's own sentence and a rule that is easy to get wrong: the OKF parser answers "no
 * frontmatter" and "broken YAML" with the same `legacy-raw` wrapper, because for a knowledge
 * document frontmatter is mandatory. Most of a real team's store is not a knowledge document.
 * A README carried across as malformed would be a whole store filed behind Reference wrappers
 * for a defect none of it has.
 */
async function casePlainMarkdownIsNotMalformed(): Promise<void> {
  const plain = "# Notes\n\nNo frontmatter here at all.\n";
  await withFixture(async (f) => {
    await f.addInput("README.md", Buffer.from(plain));
    await f.addInput("bad.md", Buffer.from(BROKEN_YAML));
    await f.apply(await f.prepare());
    const rows = (await f.inspect()).manifest;
    assert.equal(rows.find((r) => r.path === "README.md")?.profile, "legacy-okf",
      "a document that declared nothing is not a document whose declaration is broken");
    assert.equal(rows.find((r) => r.path === "bad.md")?.profile, "legacy-raw",
      "unparsable frontmatter is still legacy-raw");
    const revisions = readCommitsOf(f).flatMap((c) => c.revisions);
    const plainRevision = revisions.find((r) => committedRow(r)?.path === "README.md")!;
    assert.equal(plainRevision.payload.body, plain, "the whole file is the body when nothing was declared");
    assert.equal((plainRevision.payload.content_fields as Record<string, unknown>).legacy_raw_bytes, undefined,
      "a document that declared nothing must not be wrapped as retained malformed bytes");
    assert.equal(plainRevision.payload.type, "", "nothing declared means no type, not a Reference wrapper");
    assert.equal((await f.originalBytes("README.md")).toString(), plain);
  });
}

/** One file, classified with no store and no manifest around it — the pure function an
 *  operator previewing a single row actually calls. A profile decided only inside a manifest
 *  preparation could not be checked one input at a time. */
function caseOneInputClassifiesOnItsOwn(): void {
  const row = classifyLegacyInput("a.md", Buffer.from(CRLF_DOC));
  assert.ok(!("code" in row), "a well-formed input must classify rather than block");
  if ("code" in row) return;
  const profile: LegacyProfile = row.profile;
  assert.equal(profile, "legacy-okf");
  assert.equal(row.sha256, sha256(Buffer.from(CRLF_DOC)));
  assert.equal(row.byte_length, Buffer.byteLength(CRLF_DOC));
  assert.equal(row.media_type, "text/markdown");
  const blocked = classifyLegacyInput("../out.md", Buffer.from(CRLF_DOC));
  assert.equal("code" in blocked ? blocked.code : null, "UNSAFE_LOCATOR");
}

/** A foreign type is carried across as itself. The whole point of the legacy profile is that
 *  this platform's four native types are NOT imposed on another team's vocabulary. */
async function caseForeignTypeIsNotReclassified(): Promise<void> {
  await withFixture(async (f) => {
    await f.addInput("a.md", Buffer.from(CRLF_DOC));
    await f.apply(await f.prepare());
    const commits = readCommitsOf(f);
    const revision = commits.flatMap((c) => c.revisions)[0];
    assert.equal(revision.payload.type, "ForeignType", "the legacy type must survive unchanged");
    assert.equal(revision.origin_profile, "legacy_import");
    assert.equal((revision.payload.content_fields as Record<string, unknown>).zz_profile, "legacy-okf");
  });
}

/** Missing times stay unknown, and a declared one keeps its precision. */
async function caseUnknownTimesStayUnknown(): Promise<void> {
  await withFixture(async (f) => {
    await f.addInput("a.md", Buffer.from(CRLF_DOC));
    await f.addInput("dated.md", Buffer.from("---\ntype: Note\ndate: 2021-03-04\n---\nb\n"));
    await f.addInput("exact.md", Buffer.from("---\ntype: Note\ncreated_at: 2021-03-04T05:06:07Z\n---\nb\n"));
    await f.apply(await f.prepare());
    const rows = (await f.inspect()).manifest;
    const row = (p: string) => rows.find((r) => r.path === p)!;
    assert.equal(row("a.md").original_time, null, "a document declaring no time must record none");
    assert.equal(row("a.md").original_time_precision, "unknown");
    assert.equal(row("dated.md").original_time, "2021-03-04T00:00:00.000Z");
    assert.equal(row("dated.md").original_time_precision, "date", "a bare date must not be recorded as an exact instant");
    assert.equal(row("exact.md").original_time_precision, "exact");
    // AND THE IMPORT NEVER BECOMES THE AUTHOR. `generated.by` stays null whatever the source
    // said; a source author never becomes this platform's generator or verifier.
    const revisions = readCommitsOf(f).flatMap((c) => c.revisions);
    for (const revision of revisions) assert.equal(revision.generated.by, null);
  });
}

/** Available revision labels stay explicit and the gaps stay gaps. A document that says it is
 *  version 7 imports as revision 1 carrying the label "7" — six revisions this platform never
 *  saw are not invented to make the numbering look continuous. */
async function caseHistoryGapsStayExplicit(): Promise<void> {
  await withFixture(async (f) => {
    await f.addInput("v7.md", Buffer.from("---\ntype: Note\nversion: 7\n---\nb\n"));
    await f.apply(await f.prepare());
    const rows = (await f.inspect()).manifest;
    assert.equal(rows[0].history_label, "7");
    const revisions = readCommitsOf(f).flatMap((c) => c.revisions);
    assert.equal(revisions.length, 1, "a version label must not fabricate the revisions below it");
    assert.equal(revisions[0].revision, 1);
    assert.equal(revisions[0].previous_revision, null);
  });
}

/** A legacy citation names a record in a system this platform did not own. It is kept, marked
 *  unresolved, and never re-pointed at a local artifact that merely looks similar. */
async function caseUnresolvedReferencesStayLabelled(): Promise<void> {
  await withFixture(async (f) => {
    await f.addInput("cited.md", Buffer.from("---\ntype: Note\nsources:\n  - 'legacy://record/42'\n---\nb\n"));
    await f.apply(await f.prepare());
    const revision = readCommitsOf(f).flatMap((c) => c.revisions)[0];
    assert.equal(revision.sources.length, 0, "an unresolved legacy citation must not become a resolved source");
    assert.equal(revision.legacy_unresolved_sources.length, 1);
    assert.equal(revision.legacy_unresolved_sources[0].original, "legacy://record/42");
    assert.ok(revision.legacy_unresolved_sources[0].reason.length > 0, "an unresolved reference must say why");
  });
}

/** Text already larger than the kernel's 8-MiB new-write ceiling is preserved and fully
 *  indexed under the migration exception. The case also proves the exception is not vacuous:
 *  the same byte count is over the limit for a NEW write. */
async function caseOversizedLegacyTextIsPreserved(): Promise<void> {
  const body = "x".repeat(MAX_INPUT_BYTES + 1024);
  const doc = `---\ntype: Note\n---\n${body}`;
  await withFixture(async (f) => {
    await f.addInput("huge.md", Buffer.from(doc));
    const manifest = await f.prepare();
    assert.ok(manifest.rows[0].byte_length > MAX_INPUT_BYTES, "the fixture must actually exceed the new-write limit");
    await f.apply(manifest);
    assert.equal((await f.originalBytes("huge.md")).toString(), doc, "oversized legacy text must not be truncated");
    const event = readCommitsOf(f).flatMap((c) => c.events).find((e) => e.kind === "legacy_imported")!;
    assert.equal(event.data.oversized_legacy_exception, true, "the exception taken must be recorded on the import event");
  });
}

/** The same locator in two different owners' stores is two different artifacts. An identity
 *  derived from the locator alone would have merged them. */
function caseMultiOwnerStoresStaySeparate(): void {
  const other = "88888888-8888-4888-8888-888888888888";
  assert.notEqual(legacyArtifactId(OWNER, "a.md"), legacyArtifactId(other, "a.md"));
  assert.equal(legacyArtifactId(OWNER, "a.md"), legacyArtifactId(OWNER, "a.md"));
  assert.notEqual(legacyArtifactId(OWNER, "a.md"), legacySourceArtifactId(OWNER, "a.md"));
}

/** Every way a row blocks the cutover, refused rather than skipped. A migration that dropped a
 *  file with a warning would be exactly the loss this whole task exists to prevent. */
function caseBlockingErrorsRefuseRatherThanSkip(): void {
  const bytes = Buffer.from("---\ntype: Note\n---\nb\n");
  const duplicate = prepareLegacyManifest([{ path: "a.md", bytes }, { path: "a.md", bytes }]);
  assert.equal(duplicate.manifest.rows.length, 1);
  assert.equal(duplicate.blocking[0]?.code, "DUPLICATE_IDENTITY");

  for (const path of ["../escape.md", "/absolute.md", ".zz/commits/1.json", "legacy/already.md", ""]) {
    const refused = prepareLegacyManifest([{ path, bytes }]);
    assert.equal(refused.manifest.rows.length, 0, `${JSON.stringify(path)} must not become a row`);
    assert.equal(refused.blocking[0]?.code, "UNSAFE_LOCATOR", `${JSON.stringify(path)} must block the cutover`);
  }
}

/** Bytes substituted between approval and apply are refused at the commit, not only at the
 *  CLI — the hash the manifest was approved against is re-derived from the bytes that actually
 *  reach the kernel. */
async function caseAlteredSourceHashBlocksCutover(): Promise<void> {
  await withFixture(async (f) => {
    await f.addInput("a.md", Buffer.from(CRLF_DOC));
    const manifest = await f.prepare();
    const outcome = await mutate({
      root: storeRootOf(f), auth: { owner_id: OWNER, actor: ACTOR }, policy: legacyImportPolicy,
      request: legacyImportRequest(OWNER, manifest, manifest.rows[0], Buffer.from("substituted\n")),
    });
    assert.equal(outcome.committed, false);
    assert.equal(outcome.committed === false ? outcome.code : null, "INVALID_INPUT");
  });
}

/** A second, different manifest claiming a locator this store has already adopted is a
 *  duplicate identity — not a silent second revision under the same id. */
async function caseSecondManifestMayNotReimportTheSameLocator(): Promise<void> {
  await withFixture(async (f) => {
    await f.addInput("a.md", Buffer.from(CRLF_DOC));
    const manifest = await f.prepare();
    await f.apply(manifest);
    const second: LegacyConversionManifest = { ...manifest, manifest_id: `${manifest.manifest_id.slice(0, 63)}0` };
    const outcome = await mutate({
      root: storeRootOf(f), auth: { owner_id: OWNER, actor: ACTOR }, policy: legacyImportPolicy,
      request: legacyImportRequest(OWNER, second, second.rows[0], Buffer.from(CRLF_DOC)),
    });
    assert.equal(outcome.committed, false);
    assert.equal(outcome.committed === false ? outcome.code : null, "IDEMPOTENCY_CONFLICT");
  });
}

/** A mechanical carry-forward selects no native conversions, so the classification inventory
 *  records `selected_count: 0` / `review_required: false`. That is a complete answer, not
 *  missing evidence, and it does not block the mechanical rows.
 *
 *  AND IT SAYS WHAT IT COUNTED OVER. `source_root` is asserted here because without it those
 *  two numbers are the same bytes whether they describe a production corpus or three invented
 *  files in a temp directory — which is exactly the shape the contract accepts as resolving a
 *  human gate. A `selected_count: 0` that cannot name its corpus resolves nothing. */
async function caseNoSelectedConversionsIsNotMissingEvidence(): Promise<void> {
  const { classifyMigration } = await import("../../scripts/tenant-info/migrate.ts");
  const bytes = Buffer.from(CRLF_DOC);
  const { manifest } = prepareLegacyManifest([{ path: "a.md", bytes }]);
  const inventory: ClassificationInventory = classifyMigration(manifest, "/fixture/source-root");
  assert.equal(inventory.selected_count, 0);
  assert.equal(inventory.review_required, false);
  assert.equal(inventory.profiles["legacy-okf"], 1);
  assert.equal(inventory.source_root, "/fixture/source-root",
    "the inventory must record the corpus it counted over — a bare zero resolves no gate");
}

// ── the suite entry point ───────────────────────────────────────────────────────────────────

type CaseFn = () => void | Promise<void>;

const CASES: Readonly<Record<string, CaseFn>> = {
  same_manifest_twice_adds_nothing: caseSameManifestTwiceAddsNothing,
  prepare_is_deterministic: casePrepareIsDeterministic,
  original_bytes_survive_every_profile: caseOriginalBytesSurviveEveryProfile,
  one_input_classifies_on_its_own: caseOneInputClassifiesOnItsOwn,
  plain_markdown_is_not_malformed: casePlainMarkdownIsNotMalformed,
  foreign_type_is_not_reclassified: caseForeignTypeIsNotReclassified,
  unknown_times_stay_unknown: caseUnknownTimesStayUnknown,
  history_gaps_stay_explicit: caseHistoryGapsStayExplicit,
  unresolved_references_stay_labelled: caseUnresolvedReferencesStayLabelled,
  oversized_legacy_text_is_preserved: caseOversizedLegacyTextIsPreserved,
  multi_owner_stores_stay_separate: caseMultiOwnerStoresStaySeparate,
  blocking_errors_refuse_rather_than_skip: caseBlockingErrorsRefuseRatherThanSkip,
  altered_source_hash_blocks_cutover: caseAlteredSourceHashBlocksCutover,
  second_manifest_may_not_reimport_the_same_locator: caseSecondManifestMayNotReimportTheSameLocator,
  no_selected_conversions_is_not_missing_evidence: caseNoSelectedConversionsIsNotMissingEvidence,
  ...adoptionCases,
};

/**
 * THE TWO CASES THIS CHECKOUT CANNOT RUN, named rather than quietly dropped.
 *
 * Both need the isolated projection database the contract's integration suite calls for, and
 * this task is forbidden any database connection at all — the tenant's 527 live documents are
 * one careless connection string away, and no migration evidence is worth that risk. At
 * `--profile acceptance` a `not_run` case BLOCKS the suite, and that is the correct verdict
 * here: the evidence does not exist, so the suite must not report that it does.
 */
const NOT_RUN: Readonly<Record<string, string>> = {
  projection_parity_against_the_isolated_database:
    "needs the isolated projection database; this task is forbidden every database connection, including a read-only one",
  copied_multi_owner_store_projection_replay:
    "needs a copied multi-owner store replayed into the isolated projection database; same prohibition",
};

interface CaseResult { readonly status: "passed" | "failed" | "not_run"; readonly reason?: string }
interface SuiteDetail { readonly status: "ran"; readonly cases: Readonly<Record<string, CaseResult>> }
interface SuiteOutcome { readonly passed: boolean; readonly detail: SuiteDetail }

/** `verify --suite migration`'s entry point, the same shape as `model.ts`'s and `okf.ts`'s. */
export async function run({ cases }: { cases?: string }): Promise<SuiteOutcome> {
  const names = cases === undefined ? [...Object.keys(CASES), ...Object.keys(NOT_RUN)] : [cases];
  const results: Record<string, CaseResult> = {};
  for (const name of names) {
    if (name in NOT_RUN) { results[name] = { status: "not_run", reason: NOT_RUN[name] }; continue; }
    if (!(name in CASES)) { results[name] = { status: "failed", reason: `no such migration case: ${name}` }; continue; }
    try {
      await CASES[name]();
      results[name] = { status: "passed" };
    } catch (err) {
      results[name] = { status: "failed", reason: err instanceof Error ? err.message : String(err) };
    }
  }
  return {
    passed: Object.values(results).every((r) => r.status !== "failed"),
    detail: { status: "ran", cases: results },
  };
}
