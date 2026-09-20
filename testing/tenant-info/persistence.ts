/**
 * persistence.ts — I-7's "record-commit" case group: `record.ts`'s durable commit engine,
 * exercised against real temporary POSIX files with an injectable I/O layer that can both
 * record what actually happened and fail one named operation on demand.
 *
 * `run` below is this file's other job: `scripts/tenant-info/suites.ts` reserves the name
 * "persistence" at exactly this path, so `verify --suite persistence` and `--finalize`
 * dynamic-import it and call `run`. `"record-commit"` and I-8's `"coordination"` (below) are
 * the only case groups so far — I-9's policy cases are a later addition to this same file.
 *
 * EVERY FIXTURE LIVES UNDER A FRESH `mkdtemp` OUTSIDE THIS CHECKOUT, removed in every case's
 * `finally`. Nothing here ever touches `ZZ_TENANT_INFO_WORKSPACE`, a deployment volume, or
 * this repository as a record root — the platform holds real tenant data, and a file-commit
 * engine's own tests are exactly the code that must never be pointed at it.
 *
 * WHAT THE FAULT CASES DO AND DO NOT PROVE. `fault_before_rename` and `fault_at_rename`
 * inject a thrown error at the wrapped I/O call itself, before it ever reaches the real
 * syscall — that proves the classification logic (a fault here must never report `false` for
 * `fault_at_rename`, since the syscall may have already linked the entry), not a genuine
 * kernel-level partial rename, which no userspace harness can reproduce on demand.
 * `fault_at_commits_fsync` is the more realistic case: the real `rename` DOES execute, only
 * the following `fsyncDir` is intercepted, so the manifest is genuinely on disk while its
 * durability is (correctly) reported unconfirmed. `fault_after_durability` intercepts the
 * materialization write only after both the real rename and the real commits-directory fsync
 * have completed for real, so it proves a post-durability fault never changes `committed`.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { MutationRequest } from "@zz/contracts";

import {
  commitFilename, commitTransaction, manifestHash, nodeRecordIO,
  type CommitExports, type CommitManifest, type CommitOutcome, type CommitReceipt, type CommitRequest,
  type FileChangeEntry, type PreparedBlob, type PreparedManifestInput, type RecordIO,
} from "../../services/zz-core/dist/tenant-info/record.js";
import {
  mutate,
  type ArtifactHead, type AuthContext, type MutateOptions, type Policy, type PolicyContext, type PolicyOutcome,
  type PreparedPolicyResult,
} from "../../services/zz-core/dist/tenant-info/mutations.js";
import {
  resolveIndeterminate, verifyStore,
  type RecoveryOutcome, type StoreVerification,
} from "../../services/zz-core/dist/tenant-info/recovery.js";

// ── a fresh, disposable owner-store root per case ───────────────────────────────────────────

function makeStoreRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "zz-tenant-record-"));
  mkdirSync(join(root, ".zz", "blobs"), { recursive: true });
  mkdirSync(join(root, ".zz", "commits"), { recursive: true });
  return root;
}

function fixture(overrides: Partial<PreparedManifestInput> = {}): { manifest: PreparedManifestInput; blobs: PreparedBlob[] } {
  const content = Buffer.from(`content-${randomUUID()}\n`, "utf8");
  const hash = createHash("sha256").update(content).digest("hex");
  const changes: FileChangeEntry[] = [{ path: "doc.md", before_hash: null, after_hash: hash }];
  const manifest: PreparedManifestInput = {
    format_version: 1,
    owner_id: "11111111-1111-4111-8111-111111111111",
    sequence: 1,
    transaction_id: randomUUID(),
    idempotency_key: `case-${randomUUID()}`,
    request_hash: "a".repeat(64),
    actor: "persistence-suite",
    at: new Date().toISOString(),
    previous_commit_hash: null,
    file_changes: changes,
    source_captures: [],
    revisions: [],
    events: [],
    ...overrides,
  };
  return { manifest, blobs: [{ hash, bytes: content }] };
}

// ── the injectable, observing I/O wrapper ───────────────────────────────────────────────────

interface Recorded { readonly op: string; readonly path: string }

/** Fires when a call to `op` is made with a path `matchPath` accepts. `rename` is matched on
 *  its DESTINATION, since that is the name that tells a blob promotion from a manifest
 *  publication apart. */
interface Fault {
  readonly op: "mkdir" | "writeFile" | "fsyncFile" | "fsyncDir" | "rename" | "remove";
  readonly matchPath: (path: string) => boolean;
}

/** Wraps the real `nodeRecordIO`: every call is recorded in order, actually delegated, unless
 *  it matches `fault` — in which case it throws instead of touching the filesystem at all. */
function instrument(fault?: Fault): { io: RecordIO; log: Recorded[] } {
  const log: Recorded[] = [];
  const maybeFail = (op: Fault["op"], path: string): void => {
    if (fault && fault.op === op && fault.matchPath(path)) {
      throw new Error(`injected fault: ${op} ${path}`);
    }
  };
  const io: RecordIO = {
    async mkdir(path) { maybeFail("mkdir", path); log.push({ op: "mkdir", path }); await nodeRecordIO.mkdir(path); },
    exists: (path) => nodeRecordIO.exists(path),
    async writeFile(path, data) { maybeFail("writeFile", path); log.push({ op: "writeFile", path }); await nodeRecordIO.writeFile(path, data); },
    async fsyncFile(path) { maybeFail("fsyncFile", path); log.push({ op: "fsyncFile", path }); await nodeRecordIO.fsyncFile(path); },
    async fsyncDir(path) { maybeFail("fsyncDir", path); log.push({ op: "fsyncDir", path }); await nodeRecordIO.fsyncDir(path); },
    async rename(from, to) { maybeFail("rename", to); log.push({ op: "rename", path: `${from}=>${to}` }); await nodeRecordIO.rename(from, to); },
    async remove(path) { maybeFail("remove", path); log.push({ op: "remove", path }); await nodeRecordIO.remove(path); },
    readFile: (path) => nodeRecordIO.readFile(path),
  };
  return { io, log };
}

const isManifestRenameTarget = (to: string): boolean => /\d+-[0-9a-f-]{36}\.json$/i.test(to);

// ── the case group ───────────────────────────────────────────────────────────────────────────

async function caseHappyPathOrder(): Promise<void> {
  const root = makeStoreRoot();
  try {
    const { manifest, blobs } = fixture();
    const { io, log } = instrument();
    const request: CommitRequest = { root, manifest, blobs, io };
    const outcome: CommitOutcome = await commitTransaction(request);
    assert.equal(outcome.committed, true, `expected a durable commit, got ${JSON.stringify(outcome)}`);
    if (outcome.committed !== true) return;
    const receipt: CommitReceipt = outcome;
    assert.equal(receipt.projection, "pending", "no export hooks were supplied");
    assert.equal(receipt.history_export, "pending", "no export hooks were supplied");
    assert.equal(manifestHash(manifest as unknown as Record<string, unknown>), receipt.manifest_hash);

    const indexOf = (op: string, matches: (p: string) => boolean): number =>
      log.findIndex((e) => e.op === op && matches(e.path));
    const blobFsync = indexOf("fsyncFile", (p) => p.endsWith(blobs[0].hash));
    const blobDirFsync = indexOf("fsyncDir", (p) => p.endsWith(join(".zz", "blobs")));
    const manifestFsync = indexOf("fsyncFile", (p) => p.endsWith("manifest.json"));
    const manifestRename = indexOf("rename", (p) => isManifestRenameTarget(p));
    const commitsDirFsync = indexOf("fsyncDir", (p) => p.endsWith(join(".zz", "commits")));
    const materializeWrite = indexOf("writeFile", (p) => p.includes(".materialize-"));
    for (const [label, i] of Object.entries({ blobFsync, blobDirFsync, manifestFsync, manifestRename, commitsDirFsync, materializeWrite })) {
      assert.ok(i >= 0, `expected operation "${label}" is missing from the recorded log: ${JSON.stringify(log)}`);
    }
    assert.ok(blobFsync < manifestFsync, "the blob must be fsynced before the manifest is prepared");
    assert.ok(blobDirFsync < manifestRename, "the blobs directory must be fsynced before the manifest is renamed into commits");
    assert.ok(manifestFsync < manifestRename, "the manifest must be fsynced before it is renamed");
    assert.ok(manifestRename < commitsDirFsync, "rename is the logical publication point, before the commits-directory fsync");
    assert.ok(commitsDirFsync < materializeWrite,
      "a materialization write must never precede the durable commit — that IS the half-visible batch this task exists to prevent");

    const commitPath = join(root, ".zz", "commits", commitFilename(manifest.sequence, manifest.transaction_id));
    const onDisk = JSON.parse(readFileSync(commitPath, "utf8")) as Record<string, unknown>;
    assert.equal(onDisk.manifest_hash, receipt.manifest_hash);
    assert.equal(manifestHash(onDisk), receipt.manifest_hash);
    const blobBytes = readFileSync(join(root, ".zz", "blobs", blobs[0].hash));
    assert.equal(createHash("sha256").update(blobBytes).digest("hex"), blobs[0].hash);
    const materialized = readFileSync(join(root, "doc.md"));
    assert.equal(createHash("sha256").update(materialized).digest("hex"), blobs[0].hash);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function caseBlobDedupSkipsFsync(): Promise<void> {
  const root = makeStoreRoot();
  try {
    const { manifest: first, blobs } = fixture();
    const firstOutcome: CommitOutcome = await commitTransaction({ root, manifest: first, blobs, io: instrument().io });
    assert.equal(firstOutcome.committed, true);
    if (firstOutcome.committed !== true) return;

    const secondChanges: FileChangeEntry[] = [{ path: "doc-2.md", before_hash: null, after_hash: blobs[0].hash }];
    const second: PreparedManifestInput = {
      ...first,
      sequence: 2,
      transaction_id: randomUUID(),
      idempotency_key: `case-${randomUUID()}`,
      previous_commit_hash: firstOutcome.manifest_hash,
      file_changes: secondChanges,
    };
    const { io, log } = instrument();
    const request: CommitRequest = { root, manifest: second, blobs, io };
    const secondOutcome: CommitOutcome = await commitTransaction(request);
    assert.equal(secondOutcome.committed, true);
    assert.equal(log.some((e) => e.op === "writeFile" && e.path.endsWith(blobs[0].hash)), false,
      "a blob already present at its content-addressed path must not be rewritten");
    assert.equal(log.some((e) => e.op === "fsyncDir" && e.path.endsWith(join(".zz", "blobs"))), false,
      "no new entry was linked into .zz/blobs on the second commit, so it must not be fsynced again");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function casePreflightRefusals(): Promise<void> {
  const root = makeStoreRoot();
  try {
    const { manifest, blobs } = fixture();

    const missing = await commitTransaction({ root: join(root, "not-mounted"), manifest, blobs, io: instrument().io });
    assert.equal(missing.committed, false);
    if (missing.committed === false) assert.equal(missing.code, "STORE_UNAVAILABLE");

    const badBlobs: PreparedBlob[] = [{ hash: blobs[0].hash, bytes: Buffer.from("these are not the bytes that hash to it") }];
    const badBlob = await commitTransaction({ root, manifest, blobs: badBlobs, io: instrument().io });
    assert.equal(badBlob.committed, false);
    if (badBlob.committed === false) assert.equal(badBlob.code, "INVALID_INPUT");

    for (const path of ["../escape.md", "/etc/passwd", ".zz/blobs/x"]) {
      const escapingChanges: FileChangeEntry[] = [{ path, before_hash: null, after_hash: blobs[0].hash }];
      const escaping: PreparedManifestInput = { ...manifest, file_changes: escapingChanges };
      const outcome: CommitOutcome = await commitTransaction({ root, manifest: escaping, blobs, io: instrument().io });
      assert.equal(outcome.committed, false, `expected "${path}" to be refused`);
      if (outcome.committed === false) assert.equal(outcome.code, "INVALID_INPUT");
    }

    const badCaptureManifest: PreparedManifestInput = {
      ...manifest,
      source_captures: [{
        owner_id: manifest.owner_id, artifact_id: manifest.owner_id, original_path: "x",
        title: "x", media_type: "text/markdown", byte_length: 1, blob_hash: "0".repeat(64),
        captured_at: manifest.at, captured_by: manifest.actor, original_locator: null,
      }],
    };
    const badCapture: CommitOutcome = await commitTransaction({ root, manifest: badCaptureManifest, blobs, io: instrument().io });
    assert.equal(badCapture.committed, false, "a source_captures entry naming an absent blob must be refused");
    if (badCapture.committed === false) assert.equal(badCapture.code, "INVALID_INPUT");

    const commitPath = join(root, ".zz", "commits", commitFilename(manifest.sequence, manifest.transaction_id));
    assert.equal(existsSync(commitPath), false, "none of these definite refusals may publish anything");

    // A commit already exists at this exact sequence/txid: renaming over it would silently
    // replace a published manifest, which POSIX `rename` permits and this module must not.
    const published: CommitOutcome = await commitTransaction({ root, manifest, blobs, io: instrument().io });
    assert.equal(published.committed, true);
    const replay: CommitOutcome = await commitTransaction({ root, manifest, blobs, io: instrument().io });
    assert.equal(replay.committed, false, "renaming over an already-published manifest must be refused");
    if (replay.committed === false) assert.equal(replay.code, "IDEMPOTENCY_CONFLICT");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function caseFaultBeforeRename(): Promise<void> {
  const root = makeStoreRoot();
  try {
    const { manifest, blobs } = fixture();
    const { io } = instrument({ op: "fsyncFile", matchPath: (p) => p.endsWith("manifest.json") });
    const outcome: CommitOutcome = await commitTransaction({ root, manifest, blobs, io });
    assert.equal(outcome.committed, false, `a fault before rename was even attempted must be a definite refusal, got ${JSON.stringify(outcome)}`);
    const commitPath = join(root, ".zz", "commits", commitFilename(manifest.sequence, manifest.transaction_id));
    assert.equal(existsSync(commitPath), false, "nothing may be published when the fault landed before rename");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function caseFaultAtRename(): Promise<void> {
  const root = makeStoreRoot();
  try {
    const { manifest, blobs } = fixture();
    const { io } = instrument({ op: "rename", matchPath: isManifestRenameTarget });
    const outcome: CommitOutcome = await commitTransaction({ root, manifest, blobs, io });
    assert.equal(outcome.committed, "unknown", `a fault at rename must be indeterminate, got ${JSON.stringify(outcome)}`);
    if (outcome.committed === "unknown") {
      assert.equal(outcome.code, "COMMIT_STATUS_UNKNOWN");
      assert.equal(outcome.transaction_id, manifest.transaction_id);
      assert.equal(outcome.idempotency_key, manifest.idempotency_key);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function caseFaultAtCommitsFsync(): Promise<void> {
  const root = makeStoreRoot();
  try {
    const { manifest, blobs } = fixture();
    const { io } = instrument({ op: "fsyncDir", matchPath: (p) => p.endsWith(join(".zz", "commits")) });
    const outcome: CommitOutcome = await commitTransaction({ root, manifest, blobs, io });
    assert.equal(outcome.committed, "unknown", `a fault at the commits-directory fsync must be indeterminate, got ${JSON.stringify(outcome)}`);

    // The rename itself was real and untouched by the fault: the manifest genuinely landed on
    // disk even though its durability was never confirmed — exactly the ambiguity
    // `committed:"unknown"` exists to report honestly rather than guess past.
    const commitPath = join(root, ".zz", "commits", commitFilename(manifest.sequence, manifest.transaction_id));
    assert.equal(existsSync(commitPath), true, "the manifest was actually renamed into place before the fsync fault fired");
    const onDisk = JSON.parse(readFileSync(commitPath, "utf8")) as Record<string, unknown>;
    assert.equal(manifestHash(onDisk), onDisk.manifest_hash);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function caseFaultAfterDurability(): Promise<void> {
  const root = makeStoreRoot();
  try {
    const { manifest, blobs } = fixture();
    const { io } = instrument({ op: "writeFile", matchPath: (p) => p.includes(".materialize-") });
    const outcome: CommitOutcome = await commitTransaction({ root, manifest, blobs, io });
    assert.equal(outcome.committed, true,
      `a fault after durability must never be reported as anything but committed, got ${JSON.stringify(outcome)}`);
    const commitPath = join(root, ".zz", "commits", commitFilename(manifest.sequence, manifest.transaction_id));
    assert.equal(existsSync(commitPath), true, "the canonical commit is unaffected by a post-durability materialization fault");
    assert.equal(existsSync(join(root, "doc.md")), false,
      "the injected fault fired before the readable materialization was written — a later repair reads it back from the canonical manifest, which this case does not itself implement");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function caseFaultAtStagingCleanup(): Promise<void> {
  const root = makeStoreRoot();
  try {
    const { manifest, blobs } = fixture();
    const { io } = instrument({ op: "remove", matchPath: (p) => p.includes(join(".zz", "staging")) });
    const outcome: CommitOutcome = await commitTransaction({ root, manifest, blobs, io });
    assert.equal(outcome.committed, true,
      `a fault while sweeping staging litter must never be reported as anything but committed, got ${JSON.stringify(outcome)}`);
    const commitPath = join(root, ".zz", "commits", commitFilename(manifest.sequence, manifest.transaction_id));
    assert.equal(existsSync(commitPath), true, "the canonical commit is unaffected by a failed best-effort staging cleanup");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function caseExportHooksPendingOrCurrent(): Promise<void> {
  const root = makeStoreRoot();
  try {
    const { manifest: okManifest, blobs: okBlobs } = fixture();
    const seenByHooks: CommitManifest[] = [];
    const succeedingExports: CommitExports = {
      projectToDatabase: async (manifest: CommitManifest) => { seenByHooks.push(manifest); },
      exportToGit: async (manifest: CommitManifest) => { seenByHooks.push(manifest); },
    };
    const okRequest: CommitRequest = { root, manifest: okManifest, blobs: okBlobs, io: instrument().io, exports: succeedingExports };
    const ok: CommitOutcome = await commitTransaction(okRequest);
    assert.equal(ok.committed, true);
    if (ok.committed === true) {
      assert.equal(ok.projection, "current");
      assert.equal(ok.history_export, "current");
      // The hooks were handed the ACTUAL published manifest — its hash, not a placeholder.
      assert.equal(seenByHooks.length, 2);
      for (const seen of seenByHooks) {
        assert.equal(seen.manifest_hash, ok.manifest_hash);
        assert.equal(seen.transaction_id, okManifest.transaction_id);
      }
    }

    const { manifest: failManifest, blobs: failBlobs } = fixture({
      sequence: 2, previous_commit_hash: ok.committed === true ? ok.manifest_hash : null,
    });
    const failingExports: CommitExports = {
      projectToDatabase: async () => { throw new Error("projection unavailable"); },
      exportToGit: async () => { throw new Error("git unavailable"); },
    };
    const failing: CommitOutcome = await commitTransaction({
      root, manifest: failManifest, blobs: failBlobs, io: instrument().io, exports: failingExports,
    });
    assert.equal(failing.committed, true, "an export hook failure must never change the canonical commit outcome");
    if (failing.committed === true) {
      assert.equal(failing.projection, "pending");
      assert.equal(failing.history_export, "pending");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const CASES: Readonly<Record<string, () => Promise<void>>> = {
  happy_path_order: caseHappyPathOrder,
  blob_dedup_skips_fsync: caseBlobDedupSkipsFsync,
  preflight_refusals: casePreflightRefusals,
  fault_before_rename: caseFaultBeforeRename,
  fault_at_rename: caseFaultAtRename,
  fault_at_commits_fsync: caseFaultAtCommitsFsync,
  fault_after_durability: caseFaultAfterDurability,
  fault_at_staging_cleanup: caseFaultAtStagingCleanup,
  export_hooks_pending_or_current: caseExportHooksPendingOrCurrent,
};

// I-8's "coordination" case group: mutations.ts + recovery.ts — the owner lock, etag
// comparison, idempotency receipt and commit-outcome classification, on the ACTUAL kernel.
// Two cases spawn real child processes: a Map-keyed in-process lock cannot coordinate
// across them at all, which is the defect those two exist to catch.
const AUTH: AuthContext = { owner_id: "44444444-4444-4444-8444-444444444444", actor: "coordination-suite" };

function payloadHash(payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

/** A minimal stand-in for I-9's real policy: one artifact, one revision, a materialized note. */
function testPolicy(): Policy {
  const impl = (request: MutationRequest, ctx: PolicyContext): PolicyOutcome => {
    const artifactId = request.artifact_id ?? randomUUID();
    const prior: ArtifactHead | null = ctx.getHead(artifactId);
    const revisionNumber = (prior?.revision ?? 0) + 1;
    const payload = request.payload as { title?: unknown; body?: unknown };
    const bodyText = String(payload.body ?? "");
    const hash = payloadHash(request.payload);
    const blobHash = createHash("sha256").update(bodyText, "utf8").digest("hex");
    const now = new Date().toISOString();
    const revision = {
      owner_id: ctx.owner_id, artifact_id: artifactId, revision: revisionNumber, content_hash: hash,
      payload: { title: String(payload.title ?? ""), description: "", type: "note", tags: [], body: bodyText, resource: null, content_fields: {} },
      cause_refs: [], sources: [], generated: { by: ctx.actor, at: now },
      origin_profile: "native" as const, legacy_unresolved_sources: [],
      previous_revision: revisionNumber > 1 ? revisionNumber - 1 : null,
    };
    const event = {
      event_id: randomUUID(), transaction_id: ctx.transaction_id, owner_id: ctx.owner_id, artifact_id: artifactId,
      sequence: ctx.sequence, at: now, actor: ctx.actor, cause_refs: [], data: {},
      kind: (revisionNumber === 1 ? "created" : "revised") as "created" | "revised", revision: revisionNumber, content_hash: hash,
    };
    const prepared: PreparedPolicyResult = {
      artifact_id: artifactId, changed: true, revision: revisionNumber, content_hash: hash,
      file_changes: [{ path: `note-${artifactId}.md`, before_hash: null, after_hash: blobHash }],
      source_captures: [], revisions: [revision], events: [event],
      blobs: [{ hash: blobHash, bytes: Buffer.from(bodyText, "utf8") }],
    };
    return { ok: true, result: prepared };
  };
  return impl;
}

function coordRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    operation: "create", idempotency_key: `coord-${randomUUID()}`,
    payload: { title: "t", body: "b" }, cause_refs: [],
    ...overrides,
  };
}

function runMutate(root: string, request: unknown, io?: RecordIO): ReturnType<typeof mutate> {
  const options: MutateOptions = { root, request, auth: AUTH, policy: testPolicy(), io };
  return mutate(options);
}

async function seedArtifact(root: string): Promise<{ artifactId: string; etag: string }> {
  const result = await runMutate(root, coordRequest({ operation: "create" }));
  assert.equal(result.committed, true, `seed create failed: ${JSON.stringify(result)}`);
  if (result.committed !== true) throw new Error("unreachable");
  return { artifactId: result.artifact_id, etag: result.etag };
}

// A delayed writer widens its own critical section, so the outcome depends on the lock.
const CHILD_SCRIPT_SOURCE = `
import { writeFile } from "node:fs/promises";
import { randomUUID, createHash } from "node:crypto";
const { mutate } = await import(process.argv[5]);
const { nodeRecordIO } = await import(process.argv[6]);
const [, , rootArg, requestJson, outFile] = process.argv, delayMs = Number(process.argv[7] || "0");
const request = JSON.parse(requestJson), auth = ${JSON.stringify(AUTH)};
const io = delayMs > 0 ? { ...nodeRecordIO, rename: async (from, to) => {
  if (/\\d+-[0-9a-fA-F-]{36}\\.json$/.test(to)) await new Promise((r) => setTimeout(r, delayMs));
  await nodeRecordIO.rename(from, to);
} } : undefined;
const hashOf = (v) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
const policy = (req, ctx) => {
  const artifactId = req.artifact_id ?? randomUUID();
  const revisionNumber = (ctx.getHead(artifactId)?.revision ?? 0) + 1;
  const bodyText = String(req.payload.body ?? "");
  const hash = hashOf(req.payload);
  const blobHash = createHash("sha256").update(bodyText, "utf8").digest("hex");
  const now = new Date().toISOString();
  const revision = {
    owner_id: ctx.owner_id, artifact_id: artifactId, revision: revisionNumber, content_hash: hash,
    payload: { title: String(req.payload.title ?? ""), description: "", type: "note", tags: [], body: bodyText, resource: null, content_fields: {} },
    cause_refs: [], sources: [], generated: { by: ctx.actor, at: now },
    origin_profile: "native", legacy_unresolved_sources: [], previous_revision: revisionNumber > 1 ? revisionNumber - 1 : null,
  };
  const event = {
    event_id: randomUUID(), transaction_id: ctx.transaction_id, owner_id: ctx.owner_id, artifact_id: artifactId,
    sequence: ctx.sequence, at: now, actor: ctx.actor, cause_refs: [], data: {},
    kind: revisionNumber === 1 ? "created" : "revised", revision: revisionNumber, content_hash: hash,
  };
  return { ok: true, result: {
    artifact_id: artifactId, changed: true, revision: revisionNumber, content_hash: hash,
    file_changes: [{ path: \`note-\${artifactId}.md\`, before_hash: null, after_hash: blobHash }],
    source_captures: [], revisions: [revision], events: [event],
    blobs: [{ hash: blobHash, bytes: Buffer.from(bodyText, "utf8") }],
  } };
};
const result = await mutate({ root: rootArg, request, auth, policy, io });
await writeFile(outFile, JSON.stringify(result));
`;

const DIST_TENANT_INFO = new URL("../../services/zz-core/dist/tenant-info/", import.meta.url);

function writeChildScript(dir: string): string {
  const scriptPath = join(dir, "child.mjs");
  writeFileSync(scriptPath, CHILD_SCRIPT_SOURCE);
  return scriptPath;
}

function runChild(
  scriptPath: string, root: string, request: Record<string, unknown>, outFile: string, delayMs: number,
): Promise<Record<string, unknown>> {
  const args = [
    scriptPath, root, JSON.stringify(request), outFile,
    new URL("mutations.js", DIST_TENANT_INFO).href, new URL("record.js", DIST_TENANT_INFO).href, String(delayMs),
  ];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
    child.on("error", reject);
    child.on("exit", (code) => (code !== 0
      ? reject(new Error(`child process exited ${code}: ${stderr}`))
      : resolve(JSON.parse(readFileSync(outFile, "utf8")))));
  });
}

function assertNoDuplicateSequences(root: string): void {
  const files = readdirSync(join(root, ".zz", "commits"));
  const sequences = files.map((f) => /^(\d+)-/.exec(f)?.[1]);
  assert.equal(new Set(sequences).size, sequences.length, `two commits must never claim the same sequence: ${files.join(", ")}`);
}

/** Spawns `reqA`/`reqB` as two real child processes against the same `root` (`reqA` sleeps
 *  mid-rename); shared by every two-process case below. */
async function raceTwoChildren(
  root: string, runnerDir: string, reqA: Record<string, unknown>, reqB: Record<string, unknown>,
): Promise<[Record<string, unknown>, Record<string, unknown>]> {
  const scriptPath = writeChildScript(runnerDir);
  return Promise.all([
    runChild(scriptPath, root, reqA, join(runnerDir, "a.json"), 500),
    runChild(scriptPath, root, reqB, join(runnerDir, "b.json"), 0),
  ]);
}

async function withTwoProcessFixture(body: (root: string, runnerDir: string) => Promise<void>): Promise<void> {
  const root = makeStoreRoot();
  const runnerDir = mkdtempSync(join(tmpdir(), "zz-tenant-child-"));
  try {
    await body(root, runnerDir);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(runnerDir, { recursive: true, force: true });
  }
}

async function caseTwoProcessesRaceOnStaleEtag(): Promise<void> {
  await withTwoProcessFixture(async (root, runnerDir) => {
    const seed = await seedArtifact(root);
    const base = { operation: "revise", artifact_id: seed.artifactId, expected_etag: seed.etag };
    const [a, b] = await raceTwoChildren(root, runnerDir,
      coordRequest({ ...base, payload: { title: "t", body: "from-a" } }),
      coordRequest({ ...base, payload: { title: "t", body: "from-b" } }));
    const committed = [a, b].filter((r) => r.committed === true);
    const conflicted = [a, b].filter((r) => r.committed === false && r.code === "REVISION_CONFLICT");
    assert.equal(committed.length, 1, `expected one winner of a race on the same etag: ${JSON.stringify([a, b])}`);
    assert.equal(conflicted.length, 1, `expected the loser to see a stale etag: ${JSON.stringify([a, b])}`);
    assertNoDuplicateSequences(root);
  });
}

async function caseTwoProcessesSameKeyEqualRequestDedupes(): Promise<void> {
  await withTwoProcessFixture(async (root, runnerDir) => {
    const request = coordRequest({ operation: "create" }); // byte-identical for both children
    const [a, b] = await raceTwoChildren(root, runnerDir, request, request);
    assert.equal(a.committed, true, JSON.stringify(a));
    assert.equal(b.committed, true, JSON.stringify(b));
    assert.equal(a.transaction_id, b.transaction_id, "same key/same request must replay one transaction, never mint a second");
    assert.equal(readdirSync(join(root, ".zz", "commits")).length, 1, "exactly one commit for one idempotency key");
  });
}

async function caseTwoProcessesSameKeyDifferentRequestConflicts(): Promise<void> {
  await withTwoProcessFixture(async (root, runnerDir) => {
    const key = `coord-${randomUUID()}`;
    const [a, b] = await raceTwoChildren(root, runnerDir,
      coordRequest({ operation: "create", idempotency_key: key, payload: { title: "t", body: "from-a" } }),
      coordRequest({ operation: "create", idempotency_key: key, payload: { title: "t", body: "from-b" } }));
    const committed = [a, b].filter((r) => r.committed === true);
    const conflicted = [a, b].filter((r) => r.committed === false && r.code === "IDEMPOTENCY_CONFLICT");
    assert.equal(committed.length, 1, `expected one writer to claim the key: ${JSON.stringify([a, b])}`);
    assert.equal(conflicted.length, 1, `expected a different request under the same key refused: ${JSON.stringify([a, b])}`);
  });
}

// ── single-process coordination cases: the lock, and every acknowledgement boundary ────────

async function withRoot(body: (root: string) => Promise<void>): Promise<void> {
  const root = makeStoreRoot();
  try {
    await body(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function caseStaleLockIsBroken(): Promise<void> {
  await withRoot(async (root) => {
    const deadPid = spawnSync(process.execPath, ["-e", "process.exit(0)"]).pid ?? 999_999;
    writeFileSync(join(root, ".zz", "lock"), `${deadPid}:${Date.now() - 60_000}`);
    const result = await runMutate(root, coordRequest());
    assert.equal(result.committed, true, `a lock naming a dead pid must be broken, not block forever: ${JSON.stringify(result)}`);
  });
}

async function caseIndeterminateRecoveryConfirmsCommit(): Promise<void> {
  await withRoot(async (root) => {
    const { io } = instrument({ op: "fsyncDir", matchPath: (p) => p.endsWith(join(".zz", "commits")) });
    const result = await runMutate(root, coordRequest({ operation: "create" }), io);
    assert.equal(result.committed, "unknown", `a commits-fsync fault must surface as unknown: ${JSON.stringify(result)}`);
    if (result.committed !== "unknown") return;
    const recovered: RecoveryOutcome = await resolveIndeterminate(root, result, nodeRecordIO);
    assert.equal(recovered.committed, true, `recovery must confirm a commit that genuinely landed: ${JSON.stringify(recovered)}`);
    if (recovered.committed === true) {
      assert.equal(recovered.result.transaction_id, result.transaction_id, "recovery must report the SAME transaction, never mint a new one");
    }
  });
}

async function caseIndeterminateAbsenceIsSafeToResume(): Promise<void> {
  await withRoot(async (root) => {
    const { io } = instrument({ op: "rename", matchPath: isManifestRenameTarget });
    const result = await runMutate(root, coordRequest({ operation: "create" }), io);
    assert.equal(result.committed, "unknown", `a persistent rename fault must surface as unknown even after the in-place resume: ${JSON.stringify(result)}`);
    if (result.committed !== "unknown") return;
    assert.equal(existsSync(join(root, ".zz", "commits")) && readdirSync(join(root, ".zz", "commits")).length, 0,
      "a fault firing before rename ever runs must never publish anything");
    const recovered: RecoveryOutcome = await resolveIndeterminate(root, result, nodeRecordIO);
    assert.deepEqual(recovered, { committed: false, safe_to_resume: true });
  });
}

/** Repairs a crash-incomplete materialization, then flags (never silently resolves) two
 *  commits corrupted into sharing a sequence — the one thing the owner lock forbids. */
async function caseRestartedRecoveryReader(): Promise<void> {
  await withRoot(async (root) => {
    const { io } = instrument({ op: "writeFile", matchPath: (p) => p.includes(".materialize-") });
    const result = await runMutate(root, coordRequest({ operation: "create" }), io);
    assert.equal(result.committed, true, `a fault after durability must still report committed:true: ${JSON.stringify(result)}`);
    if (result.committed !== true) return;
    const materialized = join(root, `note-${result.artifact_id}.md`);
    assert.equal(existsSync(materialized), false, "the injected fault fired before materialization completed");

    const repair: StoreVerification = await verifyStore(root, nodeRecordIO);
    assert.equal(existsSync(materialized), true, "a restarted reader must repair the missing materialization");
    assert.ok(repair.repaired.includes(materialized), JSON.stringify(repair));
    assert.equal(repair.ok, true, `no problems should remain once repaired: ${JSON.stringify(repair.problems)}`);
    assert.equal(readFileSync(materialized, "utf8"), "b");

    const commitsDir = join(root, ".zz", "commits");
    const original = JSON.parse(readFileSync(join(commitsDir, `${result.commit_sequence}-${result.transaction_id}.json`), "utf8"));
    const forgedTxId = randomUUID();
    writeFileSync(join(commitsDir, `${result.commit_sequence}-${forgedTxId}.json`), JSON.stringify({ ...original, transaction_id: forgedTxId }));
    const collision: StoreVerification = await verifyStore(root, nodeRecordIO);
    assert.equal(collision.ok, false, "two commits sharing a sequence must never verify clean");
    assert.ok(collision.problems.some((p) => p.includes(`sequence ${result.commit_sequence}`)), JSON.stringify(collision.problems));
  });
}

const COORDINATION_CASES: Readonly<Record<string, () => Promise<void>>> = {
  two_processes_race_on_stale_etag: caseTwoProcessesRaceOnStaleEtag,
  two_processes_same_key_equal_request_dedupes: caseTwoProcessesSameKeyEqualRequestDedupes,
  two_processes_same_key_different_request_conflicts: caseTwoProcessesSameKeyDifferentRequestConflicts,
  stale_lock_is_broken: caseStaleLockIsBroken,
  indeterminate_recovery_confirms_commit: caseIndeterminateRecoveryConfirmsCommit,
  indeterminate_absence_is_safe_to_resume: caseIndeterminateAbsenceIsSafeToResume,
  restarted_recovery_reader: caseRestartedRecoveryReader,
};

const CASE_GROUPS: Readonly<Record<string, Readonly<Record<string, () => Promise<void>>>>> = {
  "record-commit": CASES,
  coordination: COORDINATION_CASES,
};

interface CaseResult { readonly status: "passed" | "failed" | "not_run"; readonly reason?: string }
interface SuiteDetail { readonly status: "blocked" | "ran"; readonly cases: Readonly<Record<string, CaseResult>> }
interface SuiteOutcome { readonly passed: boolean; readonly detail: SuiteDetail }

/** `verify --suite persistence`'s entry point; anything not a known case group is `not_run`. */
export async function run({ cases }: { cases?: string }): Promise<SuiteOutcome> {
  if (cases !== undefined && !(cases in CASE_GROUPS)) {
    const allNames = Object.values(CASE_GROUPS).flatMap((g) => Object.keys(g));
    const notRun = Object.fromEntries(allNames.map((name) => [
      name, { status: "not_run" as const, reason: `only the ${Object.keys(CASE_GROUPS).map((g) => `"${g}"`).join(" and ")} case groups exist so far` },
    ]));
    return { passed: false, detail: { status: "blocked", cases: notRun } };
  }
  const groupNames = cases === undefined ? Object.keys(CASE_GROUPS) : [cases];
  const results: Record<string, CaseResult> = {};
  for (const groupName of groupNames) {
    for (const [name, run1] of Object.entries(CASE_GROUPS[groupName])) {
      try {
        await run1();
        results[name] = { status: "passed" };
      } catch (err) {
        results[name] = { status: "failed", reason: err instanceof Error ? err.message : String(err) };
      }
    }
  }
  return { passed: Object.values(results).every((r) => r.status === "passed"), detail: { status: "ran", cases: results } };
}
