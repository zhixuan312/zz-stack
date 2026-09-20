/**
 * persistence.ts — I-7's "record-commit" case group: `record.ts`'s durable commit engine,
 * exercised against real temporary POSIX files with an injectable I/O layer that can both
 * record what actually happened and fail one named operation on demand.
 *
 * `run` below is this file's other job: `scripts/tenant-info/suites.ts` reserves the name
 * "persistence" at exactly this path, so `verify --suite persistence` and `--finalize`
 * dynamic-import it and call `run`. Only the `"record-commit"` case group exists so far —
 * I-8's coordination cases and I-9's policy cases are later additions to this same file, not
 * a reason for `record-commit` to claim the whole persistence AC on its own.
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
import { randomUUID, createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  commitFilename, commitTransaction, manifestHash, nodeRecordIO,
  type CommitExports, type CommitManifest, type CommitOutcome, type CommitReceipt, type CommitRequest,
  type FileChangeEntry, type PreparedBlob, type PreparedManifestInput, type RecordIO,
} from "../../services/zz-core/dist/tenant-info/record.js";

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

const CASE_GROUP = "record-commit";

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

interface CaseResult { readonly status: "passed" | "failed" | "not_run"; readonly reason?: string }
interface SuiteDetail { readonly status: "blocked" | "ran"; readonly cases: Readonly<Record<string, CaseResult>> }
interface SuiteOutcome { readonly passed: boolean; readonly detail: SuiteDetail }

/** `verify --suite persistence`'s entry point. `record-commit` is the only case group this
 *  file knows about; anything else asked for is reported `not_run` rather than guessed at. */
export async function run({ cases }: { cases?: string }): Promise<SuiteOutcome> {
  if (cases !== undefined && cases !== CASE_GROUP) {
    const notRun = Object.fromEntries(Object.keys(CASES).map((name) => [
      name, { status: "not_run" as const, reason: `only the "${CASE_GROUP}" case group exists so far` },
    ]));
    return { passed: false, detail: { status: "blocked", cases: notRun } };
  }
  const results: Record<string, CaseResult> = {};
  for (const [name, run1] of Object.entries(CASES)) {
    try {
      await run1();
      results[name] = { status: "passed" };
    } catch (err) {
      results[name] = { status: "failed", reason: err instanceof Error ? err.message : String(err) };
    }
  }
  return { passed: Object.values(results).every((r) => r.status === "passed"), detail: { status: "ran", cases: results } };
}
