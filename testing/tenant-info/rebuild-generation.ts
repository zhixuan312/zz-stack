/**
 * rebuild-generation.ts — I-15's "generation" case group: `packages/indexing/src/
 * tenant-rebuild.ts`'s own walk, split out of `rebuild.ts` at the ceiling (that file was
 * already at 526 of a measured, unexemptable 700 before this group existed) — the same reason
 * `persistence-coordination.ts` exists beside `persistence.ts`. `rebuild.ts`'s registry
 * imports `GENERATION_CASES` from here.
 *
 * WHAT THIS FILE PROVES, IN TWO HALVES.
 *
 * OFFLINE (no database, most of this file): `checkStoreAvailability`/`readOrderedCommits`
 * read nothing but a temporary `.zz/` tree this file builds and, in the corruption cases,
 * deliberately damages afterward — never this repository, never a deployment volume. The
 * missing-mount and corrupt-chain cases assert not merely that `rebuildGeneration` reports
 * "blocked", but that the `ProjectionClient` it was handed received ZERO calls: the property
 * this whole task exists to guarantee is that a rebuild which cannot read the source never
 * touches the target, and a case that only checks the return value would miss a version of the
 * bug where availability is checked, found wanting, and something downstream writes anyway.
 * `genesis_ready_with_zero_commits` is the deliberate counter-case: a real, available store
 * that has simply never had a commit is the ONE legitimate "empty", and must report `ready`
 * with `applied: 0` — a case list without it invites someone to "harden" the empty path later
 * and break every brand-new tenant.
 *
 * ISOLATED DATABASE (`real_rebuild_against_isolated_copy`, one case, gated exactly like
 * `rebuild.ts`'s own `atomic_apply_against_isolated_database`): a real owner store built
 * through the real `mutate()`/`nativePolicy` kernel, copied to a second directory with every
 * file's mtime rewritten, rebuilt twice into the same isolated database (the second rebuild
 * following a hand-reset of that owner's rows — the isolated copy an operator provides IS the
 * "fresh database" this task's contract names, and reusing the connection across two resets is
 * how one case proves two independent rebuilds of the SAME canonical source agree, without a
 * second live database to provision). Absent `ZZ_TENANT_INFO_ISOLATED_DB_URL`, it fails loudly
 * naming the variable, never silently skips.
 */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { access, cp, mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  commitTransaction, nodeRecordIO, type PreparedManifestInput,
} from "../../services/zz-core/dist/tenant-info/record.js";
import { mutate, type AuthContext } from "../../services/zz-core/dist/tenant-info/mutations.js";
import { nativePolicy } from "../../services/zz-core/dist/tenant-info/policies.js";

import type { ArtifactClass } from "@zz/contracts";
import {
  checkStoreAvailability, classifyArtifact, collectSemanticState, compareGenerations,
  readOrderedCommits, rebuildGeneration, toProjectionManifest,
  type RawCommitManifest, type RebuildIO,
} from "../../packages/indexing/dist/tenant-rebuild.js";
import { connectIsolated, type ProjectionClient } from "../../packages/indexing/dist/tenant-projections.js";

import { makeStoreRoot } from "./persistence.ts";

const AUTH: AuthContext = { owner_id: "66666666-6666-4666-8666-666666666666", actor: "rebuild-suite" };

async function withRoot(body: (root: string) => Promise<void>): Promise<void> {
  const root = makeStoreRoot();
  try {
    await body(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** A `ProjectionClient` that records every call and answers nothing — exactly enough to prove
 *  "this client was never touched", which is the property the blocking cases exist to prove. */
function callRecordingClient(): ProjectionClient & { readonly calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    query: async (text) => { calls.push(text.trim().replace(/\s+/g, " ")); return { rows: [] }; },
  };
}

// ── offline: mount/readiness validation runs before anything touches the target ────────────

async function caseMissingZzDirBlocksAndTouchesNothing(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "zz-rebuild-nomount-"));
  try {
    const client = callRecordingClient();
    const outcome = await rebuildGeneration({
      root, ownerId: AUTH.owner_id, corpusKey: "acme_team", baselineWatermark: 0, client,
    });
    assert.equal(outcome.status, "blocked");
    if (outcome.status === "blocked") assert.match(outcome.reason, /no .zz\/ layout|missing mount/);
    assert.equal(client.calls.length, 0, "a missing mount must never reach the target database at all");
    const availability = await checkStoreAvailability(root);
    assert.equal(availability.available, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** `.zz/` exists with neither `commits/` nor `blobs/` — a mount that landed on an empty
 *  directory rather than not mounting at all, the other shape of "there but not ready". */
async function caseMissingSubdirsBlocksAndTouchesNothing(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "zz-rebuild-partial-"));
  try {
    await mkdir(join(root, ".zz"), { recursive: true });
    const client = callRecordingClient();
    const outcome = await rebuildGeneration({
      root, ownerId: AUTH.owner_id, corpusKey: "acme_team", baselineWatermark: 0, client,
    });
    assert.equal(outcome.status, "blocked");
    if (outcome.status === "blocked") assert.match(outcome.reason, /commits\/ or blobs\//);
    assert.equal(client.calls.length, 0, "an incomplete mount must never reach the target database either");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** The one legitimate empty store: available, real, never touched by a commit. Without this
 *  case, "harden the empty path" reads as a safe cleanup and breaks genesis for every new
 *  tenant — see this file's header. */
async function caseGenesisReadyWithZeroCommits(): Promise<void> {
  await withRoot(async (root) => {
    const client = callRecordingClient();
    const outcome = await rebuildGeneration({
      root, ownerId: AUTH.owner_id, corpusKey: "acme_team", baselineWatermark: 0, client,
    });
    assert.equal(outcome.status, "ready");
    if (outcome.status === "ready") {
      assert.equal(outcome.stats.applied, 0);
      assert.equal(outcome.stats.skipped, 0);
    }
    // ensureCorpus still runs on genesis — provisioning is not gated on having content yet.
    assert.ok(client.calls.some((c) => c.includes("partition of zz.search_current")));
  });
}

// ── offline: a database outage is reported unavailable/pending, never an empty assertion ──

async function caseDatabaseOutageIsUnavailableNeverEmpty(): Promise<void> {
  await withRoot(async (root) => {
    const failing: ProjectionClient = { query: async () => { throw new Error("connection reset"); } };
    const outcome = await rebuildGeneration({
      root, ownerId: AUTH.owner_id, corpusKey: "acme_team", baselineWatermark: 0, client: failing,
    });
    assert.equal(outcome.status, "unavailable");
    if (outcome.status === "unavailable") assert.match(outcome.reason, /pending|unavailable/);
  });
}

// ── offline: hand-built commit chains, verified and then deliberately damaged ──────────────

async function commitEmpty(root: string, sequence: number, previousHash: string | null): Promise<{ hash: string }> {
  const manifest: PreparedManifestInput = {
    format_version: 1, owner_id: AUTH.owner_id, sequence, transaction_id: randomUUID(),
    idempotency_key: randomUUID(), request_hash: "0".repeat(64), actor: AUTH.actor,
    at: "2026-09-20T00:00:00.000Z", previous_commit_hash: previousHash,
    file_changes: [], source_captures: [], revisions: [], events: [],
  };
  const outcome = await commitTransaction({ root, manifest, blobs: [], io: nodeRecordIO });
  assert.equal(outcome.committed, true, `fixture commit failed: ${JSON.stringify(outcome)}`);
  if (outcome.committed !== true) throw new Error("unreachable");
  return { hash: outcome.manifest_hash };
}

async function caseCleanChainReadsInOrderRegardlessOfDirectoryOrder(): Promise<void> {
  await withRoot(async (root) => {
    const first = await commitEmpty(root, 1, null);
    await commitEmpty(root, 2, first.hash);
    await commitEmpty(root, 3, (await readManifest(root, 2)).manifest_hash);
    // Out-of-order replay: the directory listing order must not matter — only the parsed
    // sequence does. A reversing wrapper proves `readOrderedCommits` sorts rather than trusts
    // whatever order the filesystem happens to hand back.
    const reversedIo: RebuildIO = {
      exists: (p) => access(p).then(() => true, () => false),
      readdir: async (p) => (await readdir(p)).reverse(),
      readFile: (p) => readFile(p),
    };
    const result = await readOrderedCommits(root, 0, reversedIo);
    assert.equal(result.ok, true, JSON.stringify(result.problems));
    assert.deepEqual(result.commits.map((c) => c.sequence), [1, 2, 3]);
    const afterFirst = await readOrderedCommits(root, 1, reversedIo);
    assert.deepEqual(afterFirst.commits.map((c) => c.sequence), [2, 3], "baseline is a replay cursor, not a read cursor");
  });
}

async function readManifest(root: string, sequence: number): Promise<{ manifest_hash: string }> {
  const dir = join(root, ".zz", "commits");
  const file = (await readdir(dir)).find((f) => f.startsWith(`${sequence}-`));
  assert.ok(file, `no commit file for sequence ${sequence}`);
  return JSON.parse(await readFile(join(dir, file!), "utf8"));
}

async function caseTamperedChainLinkIsCorruptAndBlocks(): Promise<void> {
  await withRoot(async (root) => {
    const first = await commitEmpty(root, 1, null);
    await commitEmpty(root, 2, first.hash);
    const dir = join(root, ".zz", "commits");
    const file2 = (await readdir(dir)).find((f) => f.startsWith("2-"))!;
    const manifest = JSON.parse(await readFile(join(dir, file2), "utf8"));
    manifest.previous_commit_hash = "f".repeat(64); // no longer chains from commit 1
    await writeFile(join(dir, file2), JSON.stringify(manifest));
    const result = await readOrderedCommits(root, 0);
    assert.equal(result.ok, false);
    assert.ok(result.problems.some((p) => p.includes("does not chain")), JSON.stringify(result.problems));

    const client = callRecordingClient();
    const outcome = await rebuildGeneration({ root, ownerId: AUTH.owner_id, corpusKey: "acme_team", baselineWatermark: 0, client });
    assert.equal(outcome.status, "blocked");
    assert.equal(client.calls.length, 0, "a corrupt chain must block before a single statement reaches the target");
  });
}

async function caseForgedManifestHashIsCorruptAndBlocks(): Promise<void> {
  await withRoot(async (root) => {
    await commitEmpty(root, 1, null);
    const dir = join(root, ".zz", "commits");
    const file1 = (await readdir(dir)).find((f) => f.startsWith("1-"))!;
    const manifest = JSON.parse(await readFile(join(dir, file1), "utf8"));
    manifest.manifest_hash = "e".repeat(64);
    await writeFile(join(dir, file1), JSON.stringify(manifest));
    const result = await readOrderedCommits(root, 0);
    assert.equal(result.ok, false);
    assert.ok(result.problems.some((p) => p.includes("does not match its own canonical content")));
  });
}

async function caseMissingBlobIsCorruptAndBlocks(): Promise<void> {
  await withRoot(async (root) => {
    const bytes = Buffer.from("hello\n");
    const hash = createHash("sha256").update(bytes).digest("hex");
    const manifest: PreparedManifestInput = {
      format_version: 1, owner_id: AUTH.owner_id, sequence: 1, transaction_id: randomUUID(),
      idempotency_key: randomUUID(), request_hash: "0".repeat(64), actor: AUTH.actor,
      at: "2026-09-20T00:00:00.000Z", previous_commit_hash: null,
      file_changes: [{ path: "documents/x.md", before_hash: null, after_hash: hash }],
      source_captures: [], revisions: [], events: [],
    };
    const outcome = await commitTransaction({ root, manifest, blobs: [{ hash, bytes }], io: nodeRecordIO });
    assert.equal(outcome.committed, true);
    await rm(join(root, ".zz", "blobs", hash));
    const result = await readOrderedCommits(root, 0);
    assert.equal(result.ok, false);
    assert.ok(result.problems.some((p) => p.includes("missing blob")));
  });
}

async function caseCorruptedBlobBytesAreCaughtByHash(): Promise<void> {
  await withRoot(async (root) => {
    const bytes = Buffer.from("hello\n");
    const hash = createHash("sha256").update(bytes).digest("hex");
    const manifest: PreparedManifestInput = {
      format_version: 1, owner_id: AUTH.owner_id, sequence: 1, transaction_id: randomUUID(),
      idempotency_key: randomUUID(), request_hash: "0".repeat(64), actor: AUTH.actor,
      at: "2026-09-20T00:00:00.000Z", previous_commit_hash: null,
      file_changes: [{ path: "documents/x.md", before_hash: null, after_hash: hash }],
      source_captures: [], revisions: [], events: [],
    };
    const outcome = await commitTransaction({ root, manifest, blobs: [{ hash, bytes }], io: nodeRecordIO });
    assert.equal(outcome.committed, true);
    await writeFile(join(root, ".zz", "blobs", hash), "bit-rotted content, wrong length even");
    const result = await readOrderedCommits(root, 0);
    assert.equal(result.ok, false);
    assert.ok(result.problems.some((p) => p.includes("does not hash to its own name")));
  });
}

async function caseDuplicateSequenceIsCorruptAndBlocks(): Promise<void> {
  await withRoot(async (root) => {
    await commitEmpty(root, 1, null);
    const dir = join(root, ".zz", "commits");
    const file1 = (await readdir(dir)).find((f) => f.startsWith("1-"))!;
    const manifest = JSON.parse(await readFile(join(dir, file1), "utf8"));
    const forgedTx = randomUUID();
    await writeFile(join(dir, `1-${forgedTx}.json`), JSON.stringify({ ...manifest, transaction_id: forgedTx }));
    const result = await readOrderedCommits(root, 0);
    assert.equal(result.ok, false);
    assert.ok(result.problems.some((p) => p.includes("claimed by both")));
  });
}

// ── offline: the shared projection policy — classification and path derivation ─────────────

function fixtureManifest(overrides: Partial<RawCommitManifest>): RawCommitManifest {
  return {
    owner_id: AUTH.owner_id, sequence: 1, transaction_id: randomUUID(),
    previous_commit_hash: null, manifest_hash: "0".repeat(64),
    file_changes: [], source_captures: [], revisions: [], events: [],
    ...overrides,
  };
}

function revisionFixture(artifactId: string, type: string): RawCommitManifest["revisions"][number] {
  return {
    owner_id: AUTH.owner_id, artifact_id: artifactId, revision: 1, content_hash: "1".repeat(64),
    payload: { title: "t", description: "d", type, tags: [], body: "b", resource: null, content_fields: {} },
    cause_refs: [], sources: [], generated: { by: "x", at: "2026-09-20T00:00:00.000Z" },
    origin_profile: "native", legacy_unresolved_sources: [], previous_revision: null,
  };
}

async function caseClassifiesBySourceCaptureVersusRevisionType(): Promise<void> {
  const artifactId = randomUUID();
  const createdEvent = (cls: string) => ({
    event_id: randomUUID(), transaction_id: "tx", owner_id: AUTH.owner_id, artifact_id: artifactId,
    sequence: 1, at: "2026-09-20T00:00:00.000Z", actor: "x", kind: "created" as const,
    revision: null, content_hash: "2".repeat(64), cause_refs: [], data: { artifact_class: cls },
  });

  const source = fixtureManifest({
    source_captures: [{
      owner_id: AUTH.owner_id, artifact_id: artifactId, original_path: "s.txt", title: "S",
      media_type: "text/plain", byte_length: 1, blob_hash: "2".repeat(64),
      captured_at: "2026-09-20T00:00:00.000Z", captured_by: "x", original_locator: null,
    }],
    events: [createdEvent("source")],
  });
  assert.equal(classifyArtifact(source, artifactId), "source");

  // THE COLLISION THIS CASE USED TO DOCUMENT IS GONE, and the two assertions below are why.
  // The class was inferred from `payload.type` until the record began carrying it: anything
  // whose type matched one of the four native knowledge words was called a knowledge_concept.
  // This repository's own fixture is exactly that trap — `testing/tenant-info/model.ts` builds
  // a work_document with `type: "Decision"` — so a rebuild wrote the wrong
  // `zz.artifact.artifact_class` for it, and AC-4.1 asks a replay to restore identical semantic
  // identity. Now the `created` event carries `data.artifact_class`, written once by the policy
  // that decided it, and the same payload type classifies either way depending only on what was
  // actually recorded.
  const decisionAsWork = fixtureManifest({
    revisions: [revisionFixture(artifactId, "Decision")], events: [createdEvent("work_document")],
  });
  assert.equal(classifyArtifact(decisionAsWork, artifactId), "work_document",
    "a work document whose type happens to be Decision is still a work document");

  const decisionAsKnowledge = fixtureManifest({
    revisions: [revisionFixture(artifactId, "Decision")], events: [createdEvent("knowledge_concept")],
  });
  assert.equal(classifyArtifact(decisionAsKnowledge, artifactId), "knowledge_concept",
    "the same payload type is a knowledge concept when that is what was recorded");

  // AND AN UNRECORDED CLASS IS REFUSED, not guessed. A rebuild that fills a NOT NULL column
  // with its best idea has silently decided something only the writer knew.
  const unrecorded = fixtureManifest({
    revisions: [revisionFixture(artifactId, "notes")],
    events: [{ ...createdEvent("work_document"), data: {} }],
  });
  assert.throws(() => classifyArtifact(unrecorded, artifactId), /no recorded artifact_class/);
}

async function casePathFromFileChangesThenCapturesThenKnownThenRefuses(): Promise<void> {
  const artifactId = randomUUID();
  const known = new Map<string, string>();
  // One classes map across the whole case, the way the real walk keeps one: the `created` event
  // appears in the first commit only, and every later commit names the artifact without
  // restating what it is. This case is about PATH resolution; carrying the class is what lets
  // it stay about that.
  const classes = new Map<string, ArtifactClass>();

  const created = {
    event_id: randomUUID(), transaction_id: "tx", owner_id: AUTH.owner_id, artifact_id: artifactId,
    sequence: 1, at: "2026-09-20T00:00:00.000Z", actor: "x", kind: "created" as const,
    revision: null, content_hash: "3".repeat(64), cause_refs: [],
    data: { artifact_class: "work_document" },
  };
  const withChange = fixtureManifest({
    file_changes: [{ path: "documents/a.md", before_hash: null, after_hash: "3".repeat(64) }],
    revisions: [revisionFixture(artifactId, "notes")], events: [created],
  });
  const projected = toProjectionManifest(withChange, known, classes);
  assert.equal(projected?.current_path, "documents/a.md");
  assert.equal(known.get(artifactId), "documents/a.md");

  // No file_changes this time (an approve/verify-only commit) — falls back to the path this
  // walk already learned, never invents one.
  const eventOnly = fixtureManifest({
    revisions: [revisionFixture(artifactId, "notes")],
    events: [{
      event_id: randomUUID(), transaction_id: "tx", owner_id: AUTH.owner_id, artifact_id: artifactId,
      sequence: 2, at: "2026-09-20T00:00:00.000Z", actor: "x", kind: "approved",
      revision: 1, content_hash: "1".repeat(64), cause_refs: [], data: {},
    }],
  });
  assert.equal(toProjectionManifest(eventOnly, known, classes)?.current_path, "documents/a.md");

  const unknownArtifact = randomUUID();
  const stranded = fixtureManifest({ revisions: [revisionFixture(unknownArtifact, "notes")] });
  // EITHER REFUSAL IS THE RIGHT ONE. A commit naming an artifact this walk has never seen has
  // neither a path nor a recorded class, and which check reaches it first is an ordering detail
  // rather than a property worth pinning. What matters is that it is refused rather than
  // defaulted — pinning one message would make a later reorder look like a regression.
  assert.throws(() => toProjectionManifest(stranded, new Map(), new Map()),
    /no known materialized path|no recorded artifact_class/);
}

// ── offline: parity comparison is a pure equality over two maps ────────────────────────────

async function caseParityComparesSemanticMapsExactly(): Promise<void> {
  const before = new Map([["a", "h1"], ["b", "h2"]]);
  const same = new Map([["a", "h1"], ["b", "h2"]]);
  assert.equal(compareGenerations(before, same).ok, true);

  const changed = new Map([["a", "h1"], ["b", "different"]]);
  const mismatch = compareGenerations(before, changed);
  assert.equal(mismatch.ok, false);
  assert.deepEqual(mismatch.mismatched, ["b"]);

  const extra = new Map([["a", "h1"], ["b", "h2"], ["c", "h3"]]);
  assert.equal(compareGenerations(before, extra).ok, false, "an artifact present in only one generation is a mismatch, not a pass");
}

// ── isolated database: the real round trip this task's contract insists on ─────────────────

async function caseRealRebuildAgainstIsolatedCopy(): Promise<void> {
  const url = (process.env.ZZ_TENANT_INFO_ISOLATED_DB_URL ?? "").trim();
  if (!url) {
    throw new Error(
      "ZZ_TENANT_INFO_ISOLATED_DB_URL is not set. This case replays a real owner store through " +
      "rebuildGeneration into a real database and runs only against an operator-provided " +
      "isolated copy migration 070 is already applied to — never inferred from TEAM_DB_URL/ " +
      "PLATFORM_DB_URL, and never run here. Set it and rerun `verify --suite rebuild --profile " +
      "integration --cases generation` to exercise it.");
  }
  const owner = randomUUID();
  const auth: AuthContext = { owner_id: owner, actor: "rebuild-suite" };
  const root = makeStoreRoot();
  let copy: string | null = null;
  const client = await connectIsolated(url);
  try {
    // A tail term far past any single passage, so raw_body must carry the whole body for the
    // query below to find it — the property `passagesOf`'s no-truncation guarantee exists for.
    const longBody = `${"filler word ".repeat(3000)}zzuniquetailtermnine\n`;
    const created = await mutate({
      root, auth, policy: nativePolicy,
      request: {
        operation: "create", idempotency_key: `gen-${randomUUID()}`, artifact_class: "work_document",
        payload: { title: "Long", description: "d", type: "notes", tags: ["alpha-beta"], body: longBody, resource: null, content_fields: {} },
        cause_refs: [],
      },
    });
    assert.equal(created.committed, true, JSON.stringify(created));
    if (created.committed !== true) throw new Error("unreachable");

    copy = await mkdtemp(join(tmpdir(), "zz-rebuild-copy-"));
    await cp(root, copy, { recursive: true });
    const past = new Date(Date.now() - 86_400_000);
    for (const dir of ["commits", "blobs"]) {
      for (const f of await readdir(join(copy, ".zz", dir))) await utimes(join(copy, ".zz", dir, f), past, past);
    }

    const outcomeA = await rebuildGeneration({ root, ownerId: owner, corpusKey: "acme_team", baselineWatermark: 0, client });
    assert.equal(outcomeA.status, "ready", JSON.stringify(outcomeA));
    const mapA = await collectSemanticState(client, owner);

    await client.query("delete from zz.artifact_passage where owner_id=$1", [owner]);
    await client.query("delete from zz.artifact where owner_id=$1", [owner]);
    await client.query("delete from zz.artifact_projection_commit where owner_id=$1", [owner]);
    await client.query("delete from zz.artifact_projection_watermark where owner_id=$1", [owner]);

    const outcomeB = await rebuildGeneration({ root: copy, ownerId: owner, corpusKey: "acme_team", baselineWatermark: 0, client });
    assert.equal(outcomeB.status, "ready", JSON.stringify(outcomeB));
    const mapB = await collectSemanticState(client, owner);

    const parity = compareGenerations(mapA, mapB);
    assert.equal(parity.ok, true, `a copied store with changed mtimes must reconstruct the same semantic projections: ${JSON.stringify(parity.mismatched)}`);

    const tail = await client.query<{ n: string }>(
      `select count(*)::text as n from zz.search_current
        where corpus_key=$1 and owner_id=$2 and to_tsvector('english', raw_body) @@ plainto_tsquery('english', $3)`,
      ["acme_team", owner, "zzuniquetailtermnine"]);
    assert.equal(tail.rows[0]?.n, "1", "a term past the first passage must still be findable — raw_body must not be truncated");
  } finally {
    if (copy) await rm(copy, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
    await client.query("delete from zz.artifact_passage where owner_id=$1", [owner]);
    await client.query("delete from zz.artifact where owner_id=$1", [owner]);
    await client.query("delete from zz.artifact_projection_commit where owner_id=$1", [owner]);
    await client.query("delete from zz.artifact_projection_watermark where owner_id=$1", [owner]);
    await client.close();
  }
}

/** The case group this file owns; `rebuild.ts`'s registry names it. */
export const GENERATION_CASES: Readonly<Record<string, () => void | Promise<void>>> = {
  missing_zz_dir_blocks_and_touches_nothing: caseMissingZzDirBlocksAndTouchesNothing,
  missing_subdirs_blocks_and_touches_nothing: caseMissingSubdirsBlocksAndTouchesNothing,
  genesis_ready_with_zero_commits: caseGenesisReadyWithZeroCommits,
  database_outage_is_unavailable_never_empty: caseDatabaseOutageIsUnavailableNeverEmpty,
  clean_chain_reads_in_order_regardless_of_directory_order: caseCleanChainReadsInOrderRegardlessOfDirectoryOrder,
  tampered_chain_link_is_corrupt_and_blocks: caseTamperedChainLinkIsCorruptAndBlocks,
  forged_manifest_hash_is_corrupt_and_blocks: caseForgedManifestHashIsCorruptAndBlocks,
  missing_blob_is_corrupt_and_blocks: caseMissingBlobIsCorruptAndBlocks,
  corrupted_blob_bytes_are_caught_by_hash: caseCorruptedBlobBytesAreCaughtByHash,
  duplicate_sequence_is_corrupt_and_blocks: caseDuplicateSequenceIsCorruptAndBlocks,
  classifies_by_source_capture_versus_revision_type: caseClassifiesBySourceCaptureVersusRevisionType,
  path_from_file_changes_then_captures_then_known_then_refuses: casePathFromFileChangesThenCapturesThenKnownThenRefuses,
  parity_compares_semantic_maps_exactly: caseParityComparesSemanticMapsExactly,
  real_rebuild_against_isolated_copy: caseRealRebuildAgainstIsolatedCopy,
};
