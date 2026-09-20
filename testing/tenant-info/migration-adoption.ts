/**
 * migration-adoption.ts — the brownfield half of I-20, and the case I-11 could not write.
 *
 * WHAT MAKES A CASE BROWNFIELD. Every other suite in this delivery creates its artifacts
 * through the kernel and then writes to them, so the artifact always has a commit by the time
 * anything edits it. That is greenfield, and it is why a green gate could not see that routing
 * the registered tools through `mutate()` would refuse every write to each of the 527
 * documents already on a live deployment: none of them has a commit in the new record store,
 * because all of them predate it.
 *
 * So the store here is seeded THE OLD WAY — `writeFileSync` straight to
 * `<root>/<initiative>/<doc>.md`, exactly what `persistDocument` does, with no commit in
 * `.zz/commits/` for it and no blob in `.zz/blobs/` — and then written to through the real
 * exported adapter, `reviseDocumentAtPath`. `assertNoCommitFor` runs before every such write
 * and fails the case if the artifact already has a head, so a future edit that accidentally
 * made these cases greenfield turns them red rather than leaving them passing and vacuous.
 *
 * WHY THIS CANNOT PASS WITH THE ADOPTION PATH REMOVED, stated as a case rather than as a
 * comment: `adoption_is_what_makes_the_brownfield_write_possible` drives the id-addressed
 * `patchDocument` — the same kernel, the same store, the same bytes, without the adoption step
 * — and asserts it REFUSES. If adoption were removed from `reviseDocumentAtPath`, that is
 * precisely the refusal the brownfield case would get, and it asserts `committed === true` and
 * `revision === 2`. There is no way for both cases to be green at once without a real
 * `import_legacy` commit in between.
 */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ArtifactEvent, ArtifactRef, ContentRevision } from "@zz/contracts";

import {
  adoptLegacyDocument, captureSource, patchDocument, readDocumentBody, reviseDocumentAtPath,
  type ArtifactPorts,
} from "../../services/zz-core/dist/persist.js";
import { legacyArtifactId } from "../../services/zz-core/dist/tenant-info/legacy-import.js";
import { readArtifactHead } from "../../services/zz-core/dist/tenant-info/mutations.js";

import { makeStoreRoot } from "./persistence.ts";

const OWNER = "99999999-9999-4999-8999-999999999999";
const LOCATOR = "xuan/2026-09-13-platform-surface-redesign/plan.md";
const LEGACY_BYTES = Buffer.from(
  "---\r\nflow: sdlc-flow\r\ntype: Plan\r\ntitle: Platform surface redesign\r\nversion: 4\r\n---\r\n\r\nThe plan as it stood before any of this existed.\r\n",
);

interface Brownfield {
  readonly ports: ArtifactPorts;
  readonly artifactId: string;
  readonly cause: ArtifactRef;
  // NOT A TOOL: this removes the fixture's own temporary store — no door registers a `close`,
  // and the initiative verb is `initiative_close`.
  close(): void;
}

function commitFiles(root: string): string[] {
  const dir = join(root, ".zz", "commits");
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")) : [];
}

function commitsOf(root: string): { revisions: ContentRevision[]; events: ArtifactEvent[] } {
  const dir = join(root, ".zz", "commits");
  const revisions: ContentRevision[] = [];
  const events: ArtifactEvent[] = [];
  for (const file of commitFiles(root)) {
    const manifest = JSON.parse(readFileSync(join(dir, file), "utf8")) as
      { revisions: ContentRevision[]; events: ArtifactEvent[] };
    revisions.push(...manifest.revisions);
    events.push(...manifest.events);
  }
  return { revisions, events };
}

/**
 * A store seeded exactly the way the store on a live deployment was seeded: bytes written
 * straight to a path, and nothing else. The one commit this fixture does make first is the
 * fixture SOURCE every native edit needs for `cause_refs` — the document itself stays
 * uncommitted, which `assertNoCommitFor` verifies before any case writes to it.
 */
async function seedBrownfield(): Promise<Brownfield> {
  const root = makeStoreRoot();
  const ports: ArtifactPorts = { root, auth: { owner_id: OWNER, actor: "migration-adoption-suite" } };

  const target = join(root, ...LOCATOR.split("/"));
  mkdirSync(join(root, ...LOCATOR.split("/").slice(0, -1)), { recursive: true });
  writeFileSync(target, LEGACY_BYTES);

  const source = await captureSource(ports, {
    content: `adoption-cause-${randomUUID()}\n`, original_path: "cause.txt",
    title: "Adoption cause", media_type: "text/plain",
  }, `adoption-cause-${randomUUID()}`);
  if (source.committed !== true) throw new Error(`seedBrownfield: the cause source failed: ${JSON.stringify(source)}`);

  return {
    ports,
    artifactId: legacyArtifactId(OWNER, LOCATOR),
    cause: { owner_id: OWNER, artifact_id: source.artifact_id, revision: null, content_hash: source.content_hash },
    close: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** THE PRECONDITION THAT KEEPS THIS SUITE HONEST. A case that writes to an artifact the store
 *  already holds is testing something else entirely, so every adoption case asserts the
 *  artifact has no head and the bytes are only on disk before it writes. */
async function assertNoCommitFor(b: Brownfield): Promise<void> {
  assert.equal(await readArtifactHead(b.ports.root, b.artifactId), null,
    "this case is only meaningful while the artifact has no commit — it is not brownfield otherwise");
  assert.ok(existsSync(join(b.ports.root, ...LOCATOR.split("/"))), "the legacy bytes must be on disk");
  assert.ok(!existsSync(join(b.ports.root, ".zz", "blobs", createHash("sha256").update(LEGACY_BYTES).digest("hex"))),
    "the legacy bytes must not already be in the record store");
}

async function withBrownfield(body: (b: Brownfield) => Promise<void>): Promise<void> {
  const b = await seedBrownfield();
  try { await body(b); } finally { b.close(); }
}

// ── the cases ───────────────────────────────────────────────────────────────────────────────

/**
 * The write every one of the 527 live documents would have received on cutover day: a document
 * with bytes on disk, no commit anywhere, edited through the adapter the cutover registers.
 */
async function caseBrownfieldWriteThroughTheRegisteredHandler(): Promise<void> {
  await withBrownfield(async (b) => {
    await assertNoCommitFor(b);
    const outcome = await reviseDocumentAtPath(b.ports, {
      locator: LOCATOR, seed: { body: "the plan, edited after the cutover\n" },
      cause_refs: [b.cause], idempotency_key: "cutover-edit-1",
    });
    assert.equal(outcome.committed, true, `the brownfield write was refused: ${JSON.stringify(outcome)}`);
    if (outcome.committed !== true) return;
    assert.equal(outcome.artifact_id, b.artifactId, "the write must land on the identity the locator determines");
    assert.equal(outcome.revision, 2, "revision 2 means revision 1 was the adoption; revision 1 would mean the original was replaced");

    const { revisions, events } = commitsOf(b.ports.root);
    const imported = revisions.find((r) => r.artifact_id === b.artifactId && r.revision === 1);
    assert.ok(imported, "the store must hold an imported revision 1 for this artifact");
    assert.equal(imported.origin_profile, "legacy_import", "revision 1 must say it was imported, not written here");
    assert.equal(imported.generated.by, null, "an import never names this platform as the original author");
    assert.ok(events.some((e) => e.artifact_id === b.artifactId && e.kind === "legacy_imported"),
      "the adoption must be recorded as a legacy_imported event");

    // THE ORIGINAL BYTES SURVIVED, proven two ways: content-addressed in the record store, and
    // readable at the archive path a person can open.
    const hash = createHash("sha256").update(LEGACY_BYTES).digest("hex");
    assert.ok(readFileSync(join(b.ports.root, ".zz", "blobs", hash)).equals(LEGACY_BYTES),
      "the pre-existing bytes must be preserved byte for byte in the record store");
    assert.ok(readFileSync(join(b.ports.root, "legacy", ...LOCATOR.split("/"))).equals(LEGACY_BYTES),
      "the pre-existing bytes must be readable in the legacy archive");
    assert.ok(readFileSync(join(b.ports.root, ...LOCATOR.split("/"))).equals(LEGACY_BYTES),
      "adoption must not rewrite the file it adopted");

    // The revision the caller asked for is the one a reader now gets.
    assert.equal(readDocumentBody(b.ports.root, b.artifactId)?.body, "the plan, edited after the cutover\n");
  });
}

/**
 * THE CASE THAT PROVES THE ONE ABOVE IS NOT VACUOUS. The same store, the same bytes, the same
 * kernel — and the id-addressed adapter, which has no adoption step. It must refuse, exactly
 * as `persist.ts`'s I-11 note predicted it would, or the brownfield case above proves nothing.
 */
async function caseAdoptionIsWhatMakesTheBrownfieldWritePossible(): Promise<void> {
  await withBrownfield(async (b) => {
    await assertNoCommitFor(b);
    const withoutEtag = await patchDocument(b.ports, {
      artifact_id: b.artifactId, idempotency_key: "no-adoption-1",
      seed: { body: "edited\n" }, cause_refs: [b.cause],
    });
    assert.equal(withoutEtag.committed, false);
    assert.equal(withoutEtag.committed === false ? withoutEtag.code : null, "INVALID_INPUT");

    const withEtag = await patchDocument(b.ports, {
      artifact_id: b.artifactId, expected_etag: "1:1", idempotency_key: "no-adoption-2",
      seed: { body: "edited\n" }, cause_refs: [b.cause],
    });
    assert.equal(withEtag.committed, false);
    assert.equal(withEtag.committed === false ? withEtag.code : null, "NOT_FOUND_OR_FORBIDDEN",
      "this is the refusal every live document would have got on cutover day");

    // And nothing was written by either refusal — a refused write leaves no trace.
    assert.equal(await readArtifactHead(b.ports.root, b.artifactId), null);
  });
}

/** Adopting twice writes nothing the second time. The key is a digest of the manifest id, the
 *  locator and the original byte hash, so the second call is the identical request under the
 *  identical key and the kernel replays it off the commit log. */
async function caseAdoptingTwiceWritesNothing(): Promise<void> {
  await withBrownfield(async (b) => {
    await assertNoCommitFor(b);
    const first = await adoptLegacyDocument(b.ports, LOCATOR);
    assert.equal(first?.committed, true, `the adoption was refused: ${JSON.stringify(first)}`);
    const after = commitFiles(b.ports.root).length;
    const second = await adoptLegacyDocument(b.ports, LOCATOR);
    assert.equal(second?.committed, true);
    assert.equal(commitFiles(b.ports.root).length, after, "a second adoption wrote a commit");
    if (first?.committed === true && second?.committed === true) {
      assert.equal(second.transaction_id, first.transaction_id, "a second adoption must replay the first transaction");
      assert.equal(second.revision, 1);
    }
  });
}

/** A whole write repeated under the same idempotency key is one write, adoption included. */
async function caseRepeatedBrownfieldWriteIsOneWrite(): Promise<void> {
  await withBrownfield(async (b) => {
    await assertNoCommitFor(b);
    const request = {
      locator: LOCATOR, seed: { body: "once\n" },
      cause_refs: [b.cause], idempotency_key: "cutover-edit-repeat",
    };
    const first = await reviseDocumentAtPath(b.ports, request);
    const after = commitFiles(b.ports.root).length;
    const second = await reviseDocumentAtPath(b.ports, request);
    assert.equal(first.committed, true);
    assert.equal(second.committed, true);
    assert.equal(commitFiles(b.ports.root).length, after, "repeating the write wrote a second commit");
    if (first.committed === true && second.committed === true) {
      assert.equal(second.transaction_id, first.transaction_id);
      assert.equal(second.revision, first.revision);
    }
  });
}

/** Malformed frontmatter is adopted as legacy-raw behind a Reference wrapper and is STILL
 *  writable — a document nobody can edit because its YAML was broken years ago is exactly the
 *  regression the cutover must not ship. */
async function caseBrokenFrontmatterIsAdoptedAndStillWritable(): Promise<void> {
  await withBrownfield(async (b) => {
    const broken = Buffer.from("---\ntype: [broken\n---\nnotes\n");
    const locator = "xuan/2026-09-13-platform-surface-redesign/notes.md";
    writeFileSync(join(b.ports.root, ...locator.split("/")), broken);
    const artifactId = legacyArtifactId(OWNER, locator);
    assert.equal(await readArtifactHead(b.ports.root, artifactId), null);

    const outcome = await reviseDocumentAtPath(b.ports, {
      locator, seed: { body: "repaired notes\n" }, cause_refs: [b.cause], idempotency_key: "broken-1",
    });
    assert.equal(outcome.committed, true, `a legacy-raw document was not writable: ${JSON.stringify(outcome)}`);
    const imported = commitsOf(b.ports.root).revisions.find((r) => r.artifact_id === artifactId && r.revision === 1);
    assert.ok(imported, "the broken document must have been adopted as revision 1");
    const fields = imported.payload.content_fields as Record<string, unknown>;
    assert.equal(fields.zz_profile, "legacy-raw");
    assert.equal(fields.legacy_raw_bytes, broken.toString(),
      "the unparsable bytes must be retained in the record, not only in the archive");
    const hash = createHash("sha256").update(broken).digest("hex");
    assert.ok(readFileSync(join(b.ports.root, ".zz", "blobs", hash)).equals(broken));
  });
}

/** A caller that HAS an etag still gets the etag rule. The adoption fallback exists only for
 *  the first write to bytes nobody could have read a kernel etag for; it never turns a stale
 *  etag into an accepted write. */
async function caseAStaleEtagIsStillRefused(): Promise<void> {
  await withBrownfield(async (b) => {
    await assertNoCommitFor(b);
    const outcome = await reviseDocumentAtPath(b.ports, {
      locator: LOCATOR, seed: { body: "edited\n" }, cause_refs: [b.cause],
      idempotency_key: "stale-1", expected_etag: "9:9",
    });
    assert.equal(outcome.committed, false);
    assert.equal(outcome.committed === false ? outcome.code : null, "REVISION_CONFLICT");
  });
}

/** Nothing on disk and nothing in the store is not something to adopt. `reviseDocumentAtPath`
 *  refuses by name rather than inventing a document — creating one is `writeDocument`'s job
 *  and a different act. */
async function caseNothingToAdoptIsStillRefused(): Promise<void> {
  await withBrownfield(async (b) => {
    const outcome = await reviseDocumentAtPath(b.ports, {
      locator: "xuan/2026-09-13-platform-surface-redesign/never-existed.md",
      seed: { body: "edited\n" }, cause_refs: [b.cause], idempotency_key: "absent-1",
    });
    assert.equal(outcome.committed, false);
    assert.equal(outcome.committed === false ? outcome.code : null, "NOT_FOUND_OR_FORBIDDEN");
  });
}

/** After adoption, the ordinary native rules apply again: the next edit is a plain revise at
 *  the etag the caller now legitimately holds, and it becomes revision 3. */
async function caseNativeWritesAfterImportFollowOrdinaryPolicy(): Promise<void> {
  await withBrownfield(async (b) => {
    await assertNoCommitFor(b);
    const first = await reviseDocumentAtPath(b.ports, {
      locator: LOCATOR, seed: { body: "first\n" }, cause_refs: [b.cause], idempotency_key: "native-1",
    });
    assert.equal(first.committed, true);
    if (first.committed !== true) return;
    const second = await patchDocument(b.ports, {
      artifact_id: b.artifactId, expected_etag: first.etag, idempotency_key: "native-2",
      seed: { body: "second\n" }, cause_refs: [b.cause],
    });
    assert.equal(second.committed, true, `the native edit after import was refused: ${JSON.stringify(second)}`);
    if (second.committed !== true) return;
    assert.equal(second.revision, 3);
    const revision = commitsOf(b.ports.root).revisions.find((r) => r.artifact_id === b.artifactId && r.revision === 3);
    assert.equal(revision?.origin_profile, "native", "a write made here is native, whatever the artifact was imported from");
    assert.equal(revision?.previous_revision, 2);
  });
}

/**
 * THE FALLBACK ETAG IS GOOD FOR ONE WRITE PER DOCUMENT, AND THE CUTOVER HAS TO KNOW IT.
 *
 * The adoption's etag is stable precisely because it replays the import commit forever — which
 * is what makes a retry a replay. The other side of that: once a no-etag write has landed and
 * moved the head past the import, the NEXT no-etag write presents the import's etag against a
 * head that has moved on, and is refused REVISION_CONFLICT. That is the safe answer — a caller
 * that has not read the document may not blind-write over it — but it means `document_patch`
 * and `document_revise` must become read-then-write at cutover rather than keeping today's
 * path-and-content shape. Pinned as a case so that constraint is something a later task has to
 * decide about rather than discover.
 */
async function caseASecondBlindWriteIsRefused(): Promise<void> {
  await withBrownfield(async (b) => {
    await assertNoCommitFor(b);
    const first = await reviseDocumentAtPath(b.ports, {
      locator: LOCATOR, seed: { body: "first\n" }, cause_refs: [b.cause], idempotency_key: "blind-1",
    });
    assert.equal(first.committed, true);
    const second = await reviseDocumentAtPath(b.ports, {
      locator: LOCATOR, seed: { body: "second\n" }, cause_refs: [b.cause], idempotency_key: "blind-2",
    });
    assert.equal(second.committed, false, "a blind write over a head the caller never read must not land");
    assert.equal(second.committed === false ? second.code : null, "REVISION_CONFLICT");
  });
}

/**
 * THE STORE THE CUTOVER WILL ACTUALLY FIND, which is not the store every other case here uses.
 * `makeStoreRoot()` creates an empty `.zz/blobs` and `.zz/commits`; a store holding documents
 * written before the record store existed has NO `.zz/` at all. `record.ts` refuses a missing
 * layout on purpose — "a missing mount is refused, never read as an empty tenant" — so adoption
 * must not conjure one, and this case pins that: the write is refused STORE_UNAVAILABLE rather
 * than quietly initialising somebody's volume.
 *
 * What it makes explicit is a cutover precondition, not a defect: creating `.zz/blobs` and
 * `.zz/commits` on each live owner store is an operator act that happens before any of this
 * runs. If a later change makes the kernel auto-create the layout, this case goes red and
 * somebody has to decide that deliberately.
 */
async function caseAStoreWithNoRecordLayoutIsRefusedNotInitialised(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "zz-preexisting-store-"));
  try {
    mkdirSync(join(root, ...LOCATOR.split("/").slice(0, -1)), { recursive: true });
    writeFileSync(join(root, ...LOCATOR.split("/")), LEGACY_BYTES);
    assert.ok(!existsSync(join(root, ".zz")), "this case is only meaningful with no record layout present");

    const ports: ArtifactPorts = { root, auth: { owner_id: OWNER, actor: "migration-adoption-suite" } };
    const outcome = await reviseDocumentAtPath(ports, {
      locator: LOCATOR, seed: { body: "edited\n" },
      cause_refs: [{ owner_id: OWNER, artifact_id: legacyArtifactId(OWNER, "cause"), revision: null, content_hash: "0".repeat(64) }],
      idempotency_key: "no-layout-1",
    });
    assert.equal(outcome.committed, false);
    assert.equal(outcome.committed === false ? outcome.code : null, "STORE_UNAVAILABLE");
    assert.ok(!existsSync(join(root, ".zz")), "a refused write must not have initialised the store it refused");
    assert.ok(readFileSync(join(root, ...LOCATOR.split("/"))).equals(LEGACY_BYTES), "a refused write must leave the bytes alone");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

export const adoptionCases: Readonly<Record<string, () => Promise<void>>> = {
  brownfield_write_through_the_registered_handler: caseBrownfieldWriteThroughTheRegisteredHandler,
  adoption_is_what_makes_the_brownfield_write_possible: caseAdoptionIsWhatMakesTheBrownfieldWritePossible,
  adopting_twice_writes_nothing: caseAdoptingTwiceWritesNothing,
  repeated_brownfield_write_is_one_write: caseRepeatedBrownfieldWriteIsOneWrite,
  broken_frontmatter_is_adopted_and_still_writable: caseBrokenFrontmatterIsAdoptedAndStillWritable,
  a_stale_etag_is_still_refused: caseAStaleEtagIsStillRefused,
  nothing_to_adopt_is_still_refused: caseNothingToAdoptIsStillRefused,
  native_writes_after_import_follow_ordinary_policy: caseNativeWritesAfterImportFollowOrdinaryPolicy,
  a_second_blind_write_is_refused: caseASecondBlindWriteIsRefused,
  a_store_with_no_record_layout_is_refused_not_initialised: caseAStoreWithNoRecordLayoutIsRefusedNotInitialised,
};
