/**
 * record.ts — the durable commit engine for one owner's `.zz/` store.
 *
 * This module knows nothing about MutationRequest, authorization, etags or the cross-process
 * owner lock — those are I-8's (`mutations.ts`). What it accepts is a PREPARED transaction: a
 * caller has already decided the manifest's fields (including `sequence` and
 * `previous_commit_hash`, which only the lock-holder can compute correctly) and has the
 * complete bytes of every blob the transaction needs. This module's only job is to make that
 * batch durable, atomically, or to say precisely how it failed — never to leave a reader able
 * to see half of it.
 *
 * THE COMMIT ORDER IS THE CONTRACT, not an implementation detail:
 *   1. prepare (write) every new blob, fsync each blob file, fsync `.zz/blobs/` once a new
 *      name was linked into it;
 *   2. prepare (write) the manifest to a staging file, fsync it;
 *   3. RENAME the staging file to `.zz/commits/<sequence>-<txid>.json` — this is the logical
 *      publication point;
 *   4. fsync `.zz/commits/` — durability is not acknowledged until this returns;
 *   5. only then materialize readable paths and replay database/Git exports — failures here
 *      can never undo the canonical commit already durable at step 4.
 *
 * WHAT EACH FAULT BOUNDARY MEANS FOR THE CALLER:
 *   - Anything that fails before `rename` is even attempted (steps 1-2): nothing was linked
 *     into `.zz/commits/`, so refusing with `committed:false` is a fact, not a guess.
 *   - `rename` itself throwing, or the post-rename `fsyncDir` throwing (steps 3-4): the
 *     directory entry may or may not have survived the fault. This is exactly what
 *     `committed:"unknown"` / COMMIT_STATUS_UNKNOWN exists for — a caller that hears `false`
 *     here will retry and may double-write a batch that already landed.
 *   - Anything after step 4 returns (step 5): the commit is CONFIRMED durable. A materialize
 *     or export failure here is caught and reported as `projection`/`history_export: "pending"`
 *     — it never turns a durable `true` into anything else.
 *
 * `manifestHash` and `commitFilename` are pure and exported for exactly the two things named
 * in the spec: the hash a manifest is verified against, and the basename a commit is filed
 * under. Everything else in this file exists to make those two facts durable.
 */
import { createHash } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { ArtifactEvent, ContentRevision, MutationError, MutationIndeterminate, SourceCapture } from "@zz/contracts";

// ── the store layout, exactly as the spec names it ──────────────────────────────────────────

const STORE_DIR = ".zz";
const BLOBS_SUBDIR = "blobs";
const COMMITS_SUBDIR = "commits";
const STAGING_SUBDIR = "staging";

const HEX64 = /^[0-9a-f]{64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── manifest shape ───────────────────────────────────────────────────────────────────────────

/** `file_changes` entries: `after_hash: null` means the materialized path is absent or was
 *  removed — it never means the referenced blob was deleted. `before_hash` is the path's prior
 *  materialized hash, recorded for audit; this module does not read it back. */
export interface FileChangeEntry {
  readonly path: string;
  readonly before_hash: string | null;
  readonly after_hash: string | null;
}

/** A complete, hash-verified blob a transaction needs written to `.zz/blobs/<hash>`. The
 *  caller (I-8/I-9) has already decided what belongs here: a source's captured payload bytes,
 *  a rendered materialization that differs from its source hash, or both. */
export interface PreparedBlob {
  readonly hash: string;
  readonly bytes: Uint8Array;
}

/** Every manifest field the spec names, except `manifest_hash` — which this module computes,
 *  never accepts as input. `sequence` and `previous_commit_hash` are the lock-holder's
 *  (I-8's) to set; this module trusts them and does not re-derive owner sequencing. */
export interface PreparedManifestInput {
  readonly format_version: number;
  readonly owner_id: string;
  readonly sequence: number;
  readonly transaction_id: string;
  readonly idempotency_key: string;
  readonly request_hash: string;
  readonly actor: string;
  readonly at: string;
  readonly previous_commit_hash: string | null;
  readonly file_changes: readonly FileChangeEntry[];
  readonly source_captures: readonly SourceCapture[];
  readonly revisions: readonly ContentRevision[];
  readonly events: readonly ArtifactEvent[];
}

/** The manifest as it is actually written to `.zz/commits/<sequence>-<txid>.json`. */
export interface CommitManifest extends PreparedManifestInput {
  readonly manifest_hash: string;
}

// ── canonical hashing ────────────────────────────────────────────────────────────────────────

/** Deliberately NOT `JSON.stringify(sortedKeysObject)`: V8 iterates an object's own integer-
 *  looking string keys in ascending numeric order before any insertion-ordered key, regardless
 *  of how the object was built. `content_fields` is caller-controlled `Record<string, unknown>`
 *  and a key like `"2"` would silently escape whatever sort this module thinks it performed.
 *  Building the JSON text by hand keeps the key order under this function's own control. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(record[k])}`).join(",")}}`;
  }
  // undefined / function / symbol: not a value a manifest field ever legitimately holds.
  return "null";
}

/** SHA-256 of every manifest field except `manifest_hash` itself, over canonical UTF-8 JSON
 *  with recursively sorted keys. Accepts a manifest that already carries a `manifest_hash` (a
 *  round-tripped commit) or one in any key order — both are excluded/normalized before hashing,
 *  which is what makes the two forms hash identically. */
export function manifestHash(manifest: Record<string, unknown>): string {
  const rest: Record<string, unknown> = {};
  for (const key of Object.keys(manifest)) {
    if (key !== "manifest_hash") rest[key] = manifest[key];
  }
  return createHash("sha256").update(canonicalJson(rest), "utf8").digest("hex");
}

/** The spec's commit basename. `sequence` must be a positive integer — genesis is sequence 1,
 *  never 0 — and `transactionId` must be the UUID it always is on this platform; both are
 *  refused rather than silently coerced, because a filename this module got wrong would be a
 *  manifest a reader could never find again. */
export function commitFilename(sequence: number, transactionId: string): string {
  if (!Number.isInteger(sequence) || sequence < 1) {
    throw new RangeError(`commit sequence must be a positive integer, got ${String(sequence)}`);
  }
  if (!UUID_RE.test(transactionId)) {
    throw new RangeError(`commitFilename requires a UUID transaction id, got ${JSON.stringify(transactionId)}`);
  }
  return `${sequence}-${transactionId}.json`;
}

// ── injectable I/O ───────────────────────────────────────────────────────────────────────────

/** Every filesystem primitive the commit engine performs, named individually so a test harness
 *  can record the order they actually happen in and fail any one of them on demand. Nothing in
 *  this module reasons about source text order as a stand-in for execution order — this
 *  interface is the only thing that decides what "happened" means. */
export interface RecordIO {
  mkdir(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  writeFile(path: string, data: Uint8Array): Promise<void>;
  fsyncFile(path: string): Promise<void>;
  fsyncDir(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  /** Removes a file or directory tree; tolerates the target already being absent. */
  remove(path: string): Promise<void>;
  readFile(path: string): Promise<Buffer>;
}

async function fsyncPath(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** The real, production I/O: plain POSIX calls, nothing injected. Every fault-injection test
 *  wraps THIS, rather than replacing it, so the recorded order reflects what Node actually did. */
export const nodeRecordIO: RecordIO = {
  mkdir: async (path) => { await mkdir(path, { recursive: true }); },
  exists: async (path) => {
    try { await stat(path); return true; } catch { return false; }
  },
  writeFile: async (path, data) => { await writeFile(path, data); },
  fsyncFile: fsyncPath,
  fsyncDir: fsyncPath,
  rename: async (from, to) => { await rename(from, to); },
  remove: async (path) => {
    try { await rm(path, { recursive: true, force: true }); } catch { /* already gone */ }
  },
  readFile: (path) => readFile(path),
};

// ── path safety for materialized (readable) paths ───────────────────────────────────────────

/** A `file_changes[].path` may not walk out of the owner-store root and may not land under
 *  `.zz/`, which is this module's own record — a caller naming that path would let a
 *  materialization overwrite the manifests and blobs this function just made durable. */
function materializedPath(root: string, relPath: string): string {
  if (relPath.startsWith("/") || relPath.startsWith("\\") || /^[A-Za-z]:/.test(relPath)) {
    throw new Error(`file_changes path must be relative to the owner-store root, got ${JSON.stringify(relPath)}`);
  }
  const parts = relPath.split(/[/\\]/);
  if (parts.length === 0 || parts.some((p) => p === "" || p === "." || p === "..")) {
    throw new Error(`file_changes path escapes the owner-store root: ${JSON.stringify(relPath)}`);
  }
  if (parts[0] === STORE_DIR) {
    throw new Error(`file_changes may not materialize under ${STORE_DIR}/: ${JSON.stringify(relPath)}`);
  }
  return join(root, ...parts);
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

// ── commit outcome ───────────────────────────────────────────────────────────────────────────

/** A durable success. Not `MutationResult` — that shape names a single artifact's
 *  revision/etag, which a batch manifest touching several artifacts does not uniquely have;
 *  assembling the public per-artifact result from a receipt like this is I-8's job. `false`
 *  and `unknown` outcomes reuse `MutationError`/`MutationIndeterminate` directly from
 *  `@zz/contracts` because neither shape carries a per-artifact field this layer would have to
 *  invent. */
export interface CommitReceipt {
  readonly committed: true;
  readonly sequence: number;
  readonly transaction_id: string;
  readonly manifest_hash: string;
  readonly commit_path: string;
  readonly projection: "current" | "pending";
  readonly history_export: "current" | "pending";
}

export type CommitOutcome = CommitReceipt | MutationError | MutationIndeterminate;

/** Optional replay hooks for the database projection and the Git history export. Absent, or
 *  thrown from, either one leaves the canonical commit untouched and is reported as
 *  `"pending"` — never as a reason to fail or reclassify the commit itself. Nothing here
 *  wires an actual database client or `git` process; that belongs to the adapters that hold
 *  those dependencies (I-11 and later), not to the durability engine. */
export interface CommitExports {
  projectToDatabase?(manifest: CommitManifest): Promise<void>;
  exportToGit?(manifest: CommitManifest): Promise<void>;
}

export interface CommitRequest {
  readonly root: string;
  readonly manifest: PreparedManifestInput;
  readonly blobs: readonly PreparedBlob[];
  readonly io?: RecordIO;
  readonly exports?: CommitExports;
}

function indeterminate(manifest: PreparedManifestInput, message: string): MutationIndeterminate {
  return {
    committed: "unknown",
    code: "COMMIT_STATUS_UNKNOWN",
    transaction_id: manifest.transaction_id,
    idempotency_key: manifest.idempotency_key,
    message,
  };
}

function refuse(code: MutationError["code"], message: string): MutationError {
  return { committed: false, code, message };
}

/** Everything that must be true before a single byte is written. Every check here runs before
 *  `rename` is even attempted, so a failure here is `committed:false` honestly — nothing has
 *  been linked into `.zz/commits/` yet. A missing `.zz/` layout is reported exactly as the spec
 *  demands: refused, never read as an empty tenant. */
async function preflightRefusal(
  io: RecordIO, root: string, manifest: PreparedManifestInput, blobs: readonly PreparedBlob[],
  zzDir: string, blobsDir: string, commitsDir: string,
): Promise<MutationError | null> {
  if (!(await io.exists(zzDir)) || !(await io.exists(blobsDir)) || !(await io.exists(commitsDir))) {
    return refuse("STORE_UNAVAILABLE",
      `owner-store root is missing its ${STORE_DIR}/ layout under ${root} — a missing mount is refused, never read as an empty tenant`);
  }
  for (const blob of blobs) {
    if (!HEX64.test(blob.hash) || sha256Hex(blob.bytes) !== blob.hash) {
      return refuse("INVALID_INPUT", `prepared blob does not hash to its claimed content hash: ${blob.hash}`);
    }
  }
  for (const change of manifest.file_changes) {
    try {
      materializedPath(root, change.path);
    } catch (err) {
      return refuse("INVALID_INPUT", err instanceof Error ? err.message : String(err));
    }
    if (change.after_hash !== null && !blobs.some((b) => b.hash === change.after_hash)) {
      return refuse("INVALID_INPUT", `file_changes references after_hash ${change.after_hash} with no matching prepared blob`);
    }
  }
  for (const capture of manifest.source_captures) {
    if (!blobs.some((b) => b.hash === capture.blob_hash)) {
      return refuse("INVALID_INPUT", `source_captures references blob_hash ${capture.blob_hash} with no matching prepared blob`);
    }
  }
  let commitPath: string;
  try {
    commitPath = join(commitsDir, commitFilename(manifest.sequence, manifest.transaction_id));
  } catch (err) {
    return refuse("INVALID_INPUT", err instanceof Error ? err.message : String(err));
  }
  if (await io.exists(commitPath)) {
    // I-8 holds the owner lock and rechecks before calling this, so this is not a TOCTOU race
    // in practice — it is the last line of defense against ever renaming over a published
    // manifest, which POSIX `rename` would otherwise do silently.
    return refuse("IDEMPOTENCY_CONFLICT", `a commit already exists at ${commitPath} — refusing to rename over a published manifest`);
  }
  return null;
}

/** Writes each `file_changes` entry's readable materialization by temp-file replacement in the
 *  SAME directory as its target (so the final rename is same-filesystem and atomic).
 *  `after_hash: null` removes the materialized path without touching any blob. Every failure
 *  here is the caller's (`commitTransaction`'s) to swallow — this function is only ever called
 *  after the canonical commit is already durable, so nothing it does can undo that fact. */
async function materialize(
  io: RecordIO, root: string, blobs: readonly PreparedBlob[], changes: readonly FileChangeEntry[],
): Promise<void> {
  for (const change of changes) {
    const target = materializedPath(root, change.path);
    if (change.after_hash === null) {
      await io.remove(target);
      continue;
    }
    const blob = blobs.find((b) => b.hash === change.after_hash);
    if (!blob) continue; // preflight already refused this; defensive only
    await io.mkdir(dirname(target));
    const tempPath = join(dirname(target), `.materialize-${change.after_hash}.tmp`);
    await io.writeFile(tempPath, blob.bytes);
    await io.rename(tempPath, target);
  }
}

/**
 * The durable commit engine. Accepts one prepared transaction and either makes it fully
 * durable and readable, or reports precisely why it did not — never a half-visible batch.
 *
 * See this file's header for the exact commit order and what each fault boundary means for
 * the returned outcome. In short: a fault before `rename` is attempted returns `false`; a
 * fault at `rename` or at the commits-directory fsync returns `unknown`; anything after the
 * commits-directory fsync returns is caught and reported as `true` with `projection`/
 * `history_export` marked `"pending"` where its own step failed.
 */
export async function commitTransaction(request: CommitRequest): Promise<CommitOutcome> {
  const io = request.io ?? nodeRecordIO;
  const root = request.root;
  const zzDir = join(root, STORE_DIR);
  const blobsDir = join(zzDir, BLOBS_SUBDIR);
  const commitsDir = join(zzDir, COMMITS_SUBDIR);
  const stagingDir = join(zzDir, STAGING_SUBDIR, request.manifest.transaction_id);

  const refusal = await preflightRefusal(io, root, request.manifest, request.blobs, zzDir, blobsDir, commitsDir);
  if (refusal) return refusal;

  const commitPath = join(commitsDir, commitFilename(request.manifest.sequence, request.manifest.transaction_id));
  const hash = manifestHash(request.manifest as unknown as Record<string, unknown>);
  const manifest: CommitManifest = { ...request.manifest, manifest_hash: hash };

  try {
    // ── steps 1-2: prepare and fsync every new blob, then the manifest — nothing published yet
    await io.mkdir(stagingDir);
    for (const blob of request.blobs) {
      const finalPath = join(blobsDir, blob.hash);
      if (await io.exists(finalPath)) continue; // content-addressed and immutable: already durable
      const tempPath = join(stagingDir, `blob-${blob.hash}`);
      await io.writeFile(tempPath, blob.bytes);
      await io.fsyncFile(tempPath);
      await io.rename(tempPath, finalPath);
      await io.fsyncFile(finalPath);
      await io.fsyncDir(blobsDir); // a new name was linked into this directory
    }
    const manifestTemp = join(stagingDir, "manifest.json");
    await io.writeFile(manifestTemp, Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8"));
    await io.fsyncFile(manifestTemp);

    // ── step 3: RENAME — the logical publication point. A fault here is indeterminate: the
    //    directory entry may or may not have survived it.
    try {
      await io.rename(manifestTemp, commitPath);
    } catch {
      return indeterminate(request.manifest,
        "the manifest rename to its commit path could not be confirmed — it may or may not have published");
    }

    // ── step 4: fsync the commits directory. Durability is not acknowledged until this
    //    returns; a fault here is indeterminate for the same reason as the rename itself.
    try {
      await io.fsyncDir(commitsDir);
    } catch {
      return indeterminate(request.manifest,
        "the commit was renamed into place but its directory fsync could not be confirmed durable");
    }
  } catch (err) {
    // Everything above this catch runs before `rename` is attempted (both `rename` and the
    // directory fsync have their own try/catch and never reach here) — nothing was published,
    // so a definite refusal is a fact.
    return refuse("STORE_UNAVAILABLE", err instanceof Error ? err.message : String(err));
  }

  // ── step 5: PUBLISHED AND DURABLE. Materialization and export failures from here on are
  //    caught individually and can never change the outcome already earned above.
  let projection: "current" | "pending" = "current";
  let historyExport: "current" | "pending" = "current";
  try {
    await materialize(io, root, request.blobs, request.manifest.file_changes);
  } catch { /* a later reader repairs an incomplete materialization from the canonical manifest */ }
  try {
    if (request.exports?.projectToDatabase) await request.exports.projectToDatabase(manifest);
    else projection = "pending";
  } catch { projection = "pending"; }
  try {
    if (request.exports?.exportToGit) await request.exports.exportToGit(manifest);
    else historyExport = "pending";
  } catch { historyExport = "pending"; }
  try {
    await io.remove(stagingDir); // best-effort; the canonical commit does not depend on this
  } catch { /* staging litter; a later reader sweeps it, it never blocks readiness */ }

  return {
    committed: true,
    sequence: request.manifest.sequence,
    transaction_id: request.manifest.transaction_id,
    manifest_hash: hash,
    commit_path: commitPath,
    projection,
    history_export: historyExport,
  };
}
