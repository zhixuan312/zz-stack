/**
 * mutations.ts — the coordinating kernel: the cross-process owner lock, the etag comparison
 * it protects, the idempotency receipt that survives a lost response, and the mapping from
 * `record.ts`'s durable `CommitReceipt` to the public per-artifact `MutationResult`.
 *
 * WHAT THIS MODULE DOES NOT DO. `record.ts` (I-7) trusts `sequence` and `previous_commit_hash`
 * because only a lock-holder can compute them correctly — this module IS that lock-holder.
 * Deciding WHAT a mutation writes — which fields change, which revision/event objects and blob
 * bytes a request produces — is `Policy`'s job (I-9 binds native semantic/provenance policy for
 * real; this module only defines the interface and accepts an injected, already-validated
 * result). Supersession's two-participant check, cause resolution, gate/knowledge rules and
 * payload-to-content-hash derivation all live on the far side of that interface.
 *
 * THE ETAG IS OWNER-STORE STATE, NOT A DATABASE ROW. `zz.artifact.head_event_sequence` is a
 * projection I-10/I-11 build later; today the only durable record is the commit log itself.
 * `readOwnerState` derives the same fact by replaying `.zz/commits/*.json` in sequence order —
 * correct, and O(commit count) until a projection replaces it. That trade is deliberate: this
 * task may not touch a database, and the commit log is the one truth that already exists.
 *
 * THE LOCK IS A REAL FILE, NOT A MAP. `acquireOwnerLock` uses `open(path, "wx")`, which POSIX
 * guarantees is atomic across processes on the same filesystem — the only primitive here that
 * actually rules out two writers computing the same `sequence`. A `Map`-keyed in-process mutex
 * would leave every separate process with its own empty map and rule out nothing; the
 * coordination suite's two-real-process case exists to make exactly that swap fail loudly.
 *
 * IDEMPOTENCY RIDES ON THE COMMIT LOG TOO. A receipt key is `owner+operation+idempotency_key`;
 * this module qualifies the raw key with the operation before handing it to `record.ts` as
 * `manifest.idempotency_key`, then strips that qualifier back off on every path a caller can
 * observe it (`MutationIndeterminate.idempotency_key`, a replayed result) — the qualifier is
 * this module's own bookkeeping, never part of the public contract.
 */
import { randomUUID, createHash } from "node:crypto";
import { open, readdir, rename, unlink } from "node:fs/promises";
import { join } from "node:path";

import {
  MutationRequestSchema, type MutationRequest, type MutationResult,
  type MutationError, type MutationIndeterminate,
  type ArtifactEvent, type ContentRevision, type SourceCapture,
} from "@zz/contracts";

import {
  commitFilename, commitTransaction, manifestHash, nodeRecordIO,
  type CommitReceipt, type FileChangeEntry, type PreparedBlob, type PreparedManifestInput, type RecordIO,
} from "./record.js";

const STORE_DIR = ".zz";
const COMMITS_SUBDIR = "commits";
const KEY_SEPARATOR = "::"; // not a character any MutationOp contains

// ── canonical hashing, independent of record.ts's (different undefined semantics: a caller's
//    JSON request drops undefined-valued keys the way JSON.stringify does; a manifest never has
//    any) ───────────────────────────────────────────────────────────────────────────────────

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "number" || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => (v === undefined ? "null" : canonicalJson(v))).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).filter((k) => record[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(record[k])}`).join(",")}}`;
  }
  return "null"; // undefined at top level, function, symbol — never a legitimate request field
}

/** Canonicalizes `request` (any key order, `undefined`-valued keys dropped exactly as
 *  `JSON.stringify` drops them) and hashes it — the fact an idempotency replay is checked
 *  against, per the check at `checks/tenant-kernel-codes.ts`. */
export function requestHash(request: unknown): string {
  return createHash("sha256").update(canonicalJson(request), "utf8").digest("hex");
}

/** `publication` is what a read of `.zz/commits/` established; `durable` is a *fresh*
 *  confirmation (a `fsyncDir` that returned rather than one recalled from write time). Only a
 *  definite absence earns `false` — everything else that is not confirmed both published and
 *  durable is `"unknown"`, never guessed past. */
export function classifyCommitOutcome(
  signal: { readonly publication: "absent" | "published" | "uncertain"; readonly durable: boolean },
): true | false | "unknown" {
  if (signal.publication === "absent") return false;
  if (signal.publication === "published" && signal.durable) return true;
  return "unknown";
}

// ── the OS-backed, per-owner-store cross-process lock ───────────────────────────────────────

const LOCK_STALE_MS = 30_000;
const LOCK_POLL_MS = 20;
const LOCK_TIMEOUT_MS = 8_000;

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but belongs to someone else — still alive. Anything else
    // (ESRCH, or a malformed pid) means it is not.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Breaks a lock file that names a dead pid or has outlived `LOCK_STALE_MS`, by RENAMING it
 *  aside rather than unlinking it directly. Two waiters can both decide a lock is stale at the
 *  same instant; only one `rename` of the same source path can succeed, so only one of them
 *  ever removes a lock — the other's rename fails ENOENT and it simply loops back to retry.
 *  Unlinking directly here would let both succeed, the second deleting whichever fresh lock the
 *  first waiter had *already* placed. */
async function breakStaleLockIfDead(io: { readFile(p: string): Promise<Buffer> }, lockPath: string): Promise<void> {
  let holder: string;
  try {
    holder = (await io.readFile(lockPath)).toString("utf8");
  } catch {
    return; // already gone — someone else's retry loop will pick up the now-free lock
  }
  const [pidText, atText] = holder.split(":");
  const pid = Number(pidText);
  const at = Number(atText);
  const stale = !Number.isFinite(pid) || !Number.isFinite(at)
    || Date.now() - at > LOCK_STALE_MS || !pidAlive(pid);
  if (!stale) return;
  const staleName = `${lockPath}.stale-${randomUUID()}`;
  try {
    await rename(lockPath, staleName);
  } catch {
    return; // lost the race to break it — the winner's own retry loop proceeds
  }
  try {
    await unlink(staleName);
  } catch { /* best-effort; an orphaned .stale- file blocks nothing */ }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface LockHandle {
  release(): Promise<void>;
}

/** Acquires the one lock file for this owner-store root, atomically (`open(..., "wx")`),
 *  across however many processes race for it. NOT an in-process primitive — a `Map` keyed by
 *  `root` would coordinate nothing between two Node processes, which is exactly the failure
 *  mode the two-real-process coordination case exists to catch. */
async function acquireOwnerLock(root: string): Promise<LockHandle> {
  const lockPath = join(root, STORE_DIR, "lock");
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      const handle = await open(lockPath, "wx");
      try {
        await handle.writeFile(`${process.pid}:${Date.now()}`);
      } finally {
        await handle.close();
      }
      return {
        release: async () => {
          try { await unlink(lockPath); } catch { /* already gone */ }
        },
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      await breakStaleLockIfDead(nodeRecordIO, lockPath);
      if (Date.now() > deadline) {
        throw new Error(`owner lock at ${lockPath} was not released within ${LOCK_TIMEOUT_MS}ms`);
      }
      await sleep(LOCK_POLL_MS);
    }
  }
}

// ── owner-store state, replayed from the commit log ─────────────────────────────────────────

/** `revision` is `null` for a SourceArtifact (never revised); `etagOf` renders that as the
 *  spec's "0" revision component. `head_event_sequence` is the `sequence` of the most recent
 *  commit that recorded ANY event or revision for this artifact — a state-only operation (e.g.
 *  `approve`) advances it without touching `revision`, exactly as the spec requires. */
export interface ArtifactHead {
  readonly artifact_id: string;
  readonly revision: number | null;
  readonly head_event_sequence: number;
  readonly content_hash: string;
}

function etagOf(head: ArtifactHead): string {
  return `${head.revision ?? 0}:${head.head_event_sequence}`;
}

interface IdempotencyEntry {
  readonly sequence: number;
  readonly request_hash: string;
  readonly manifest: PreparedManifestInput & { readonly manifest_hash: string };
}

interface OwnerState {
  readonly nextSequence: number;
  readonly previousCommitHash: string | null;
  readonly artifacts: ReadonlyMap<string, ArtifactHead>;
  readonly idempotency: ReadonlyMap<string, IdempotencyEntry>;
}

function bumpHead(
  artifacts: Map<string, ArtifactHead>, artifactId: string, sequence: number,
  revision: number | null, contentHash: string | undefined,
): void {
  const prior = artifacts.get(artifactId);
  artifacts.set(artifactId, {
    artifact_id: artifactId,
    revision: revision ?? prior?.revision ?? null,
    head_event_sequence: sequence,
    content_hash: contentHash ?? prior?.content_hash ?? "",
  });
}

/** Replays every commit under `root/.zz/commits/`, in sequence order, into the owner-level
 *  next-sequence counter, the chain tip hash, every artifact's current head, and the
 *  idempotency index. Always reads through plain `node:fs` — this is bookkeeping over already-
 *  durable files, not the fault-injectable write path `record.ts` owns. */
async function readOwnerState(root: string): Promise<OwnerState> {
  const commitsDir = join(root, STORE_DIR, COMMITS_SUBDIR);
  let files: string[];
  try {
    files = (await readdir(commitsDir)).filter((f) => f.endsWith(".json"));
  } catch {
    files = [];
  }
  const entries = files
    .map((f) => ({ file: f, sequence: Number(/^(\d+)-/.exec(f)?.[1] ?? NaN) }))
    .filter((e) => Number.isFinite(e.sequence))
    .sort((a, b) => a.sequence - b.sequence);

  const artifacts = new Map<string, ArtifactHead>();
  const idempotency = new Map<string, IdempotencyEntry>();
  let nextSequence = 1;
  let previousCommitHash: string | null = null;

  for (const { file, sequence } of entries) {
    const raw = await nodeRecordIO.readFile(join(commitsDir, file));
    const manifest = JSON.parse(raw.toString("utf8")) as PreparedManifestInput & { manifest_hash: string };
    nextSequence = Math.max(nextSequence, sequence + 1);
    previousCommitHash = manifest.manifest_hash;
    for (const revision of manifest.revisions as readonly ContentRevision[]) {
      bumpHead(artifacts, revision.artifact_id, sequence, revision.revision, revision.content_hash);
    }
    for (const event of manifest.events as readonly ArtifactEvent[]) {
      bumpHead(artifacts, event.artifact_id, sequence, null, event.content_hash);
    }
    idempotency.set(manifest.idempotency_key, { sequence, request_hash: manifest.request_hash, manifest });
  }
  return { nextSequence, previousCommitHash, artifacts, idempotency };
}

/**
 * One artifact's current head and the etag that goes with it, replayed off the commit log.
 *
 * WHY THIS IS EXPORTED. `readOwnerState` is this module's own bookkeeping and stays private,
 * but an adapter routing a registered tool through `mutate()` genuinely needs one fact from
 * it: whether this store holds the artifact at all, and at which etag. Without it, persist.ts
 * said so itself — "Revision, content_hash, record_digest and etag are NOT derivable here
 * without mutations.ts's owner-state replay" — and an adapter had to make the caller carry an
 * etag it could not have for a document it has never written through this kernel. That is the
 * lookup the adoption path is built on: no head means adopt, a head means revise at its etag.
 *
 * NO LOCK. This is a read of already-durable files; a caller that intends to WRITE what it
 * read still goes through `mutate()`, which takes the lock and re-reads state under it, so
 * nothing here can be used to skip the etag comparison that lock protects.
 */
export async function readArtifactHead(
  root: string, artifactId: string,
): Promise<(ArtifactHead & { readonly etag: string }) | null> {
  const head = (await readOwnerState(root)).artifacts.get(artifactId);
  return head ? { ...head, etag: etagOf(head) } : null;
}

// ── the policy boundary ──────────────────────────────────────────────────────────────────────

export interface AuthContext {
  readonly owner_id: string;
  readonly actor: string;
}

export interface PolicyContext {
  readonly owner_id: string;
  readonly actor: string;
  /** The identity this commit will publish under — minted before policy runs (not after) so
   *  every `ArtifactEvent` policy produces can carry the `transaction_id` its schema requires,
   *  and so a native revision's provenance names the transaction that actually created it. */
  readonly transaction_id: string;
  readonly sequence: number;
  /** Any artifact's current head, resolved under the same lock this request holds —
   *  supersession's two-participant check and cause resolution both need more than just
   *  `request.artifact_id`, so this is a lookup rather than a single fixed field. */
  readonly getHead: (artifactId: string) => ArtifactHead | null;
}

/** The prepared change a policy hands back — I-9's real semantic/provenance decisions,
 *  reduced to exactly what this kernel needs to build a commit and a `MutationResult`.
 *  `changed:false` with empty `revisions` is a valid, durable no-op receipt; it must never
 *  carry a `revisions` entry that was not actually a new content revision. */
export interface PreparedPolicyResult {
  readonly artifact_id: string;
  readonly changed: boolean;
  readonly revision: number | null;
  readonly content_hash: string;
  readonly file_changes: readonly FileChangeEntry[];
  readonly source_captures: readonly SourceCapture[];
  readonly revisions: readonly ContentRevision[];
  readonly events: readonly ArtifactEvent[];
  readonly blobs: readonly PreparedBlob[];
}

export type PolicyOutcome =
  | { readonly ok: true; readonly result: PreparedPolicyResult }
  | { readonly ok: false; readonly error: MutationError };

export type Policy = (
  request: MutationRequest, ctx: PolicyContext,
) => Promise<PolicyOutcome> | PolicyOutcome;

// ── replaying a public result back out of a durable manifest ───────────────────────────────

/** Reconstructs the `MutationResult` a manifest already on disk represents — used for an
 *  idempotent replay and for recovery's resumed-commit path alike. `projection`/
 *  `history_export` are not manifest fields (`record.ts`'s receipt carries them, not the
 *  commit itself), so a replay reports them `"pending"` — honest, since nothing downstream of
 *  the commit log exists to have confirmed them current before I-11. */
export function replayFromManifest(
  manifest: PreparedManifestInput, sequence: number,
): MutationResult {
  const revision = (manifest.revisions as readonly ContentRevision[]).at(-1) ?? null;
  const event = (manifest.events as readonly ArtifactEvent[]).at(-1) ?? null;
  const artifactId = revision?.artifact_id ?? event?.artifact_id;
  if (!artifactId) {
    throw new Error(`manifest for transaction ${manifest.transaction_id} carries neither a revision nor an event to replay a result from`);
  }
  const rev = revision?.revision ?? null;
  return {
    committed: true,
    changed: manifest.revisions.length > 0,
    transaction_id: manifest.transaction_id,
    artifact_id: artifactId,
    revision: rev,
    content_hash: revision?.content_hash ?? event?.content_hash ?? "",
    etag: `${rev ?? 0}:${sequence}`,
    commit_sequence: sequence,
    projection: "pending",
    history_export: "pending",
  };
}

function toIndeterminate(outcome: MutationIndeterminate, originalKey: string): MutationIndeterminate {
  return { ...outcome, idempotency_key: originalKey };
}

// ── the coordinating entry point ────────────────────────────────────────────────────────────

export interface MutateOptions {
  readonly root: string;
  readonly request: unknown;
  readonly auth: AuthContext;
  readonly policy: Policy;
  /** Injectable for fault-testing `record.ts`'s commit path; defaults to real POSIX I/O. */
  readonly io?: RecordIO;
}

/**
 * Validates and executes one `MutationRequest` under this owner-store's cross-process lock:
 * checks the idempotency receipt first (a retry never re-runs policy or re-checks the etag it
 * already satisfied), then the etag, then hands a prepared, validated change to `record.ts`.
 * An indeterminate commit is resumed once, in place, with the identical manifest — never a
 * fresh transaction — and only when absence is freshly established; otherwise the caller gets
 * `COMMIT_STATUS_UNKNOWN` back rather than a guess.
 */
export async function mutate(options: MutateOptions): Promise<MutationResult | MutationError | MutationIndeterminate> {
  const parsed = MutationRequestSchema.safeParse(options.request);
  if (!parsed.success) {
    return { committed: false, code: "INVALID_INPUT", message: parsed.error.issues.map((i) => i.message).join("; ") };
  }
  const request = parsed.data;
  const io = options.io ?? nodeRecordIO;
  const root = options.root;

  let lock: LockHandle;
  try {
    lock = await acquireOwnerLock(root);
  } catch (err) {
    return { committed: false, code: "STORE_UNAVAILABLE", message: err instanceof Error ? err.message : String(err) };
  }

  try {
    const state = await readOwnerState(root);
    const qualifiedKey = `${request.operation}${KEY_SEPARATOR}${request.idempotency_key}`;
    const hash = requestHash(request);

    const existing = state.idempotency.get(qualifiedKey);
    if (existing) {
      if (existing.request_hash !== hash) {
        return {
          committed: false, code: "IDEMPOTENCY_CONFLICT",
          message: `idempotency_key ${JSON.stringify(request.idempotency_key)} was already used for a different ${request.operation} request`,
        };
      }
      return replayFromManifest(existing.manifest, existing.sequence);
    }

    // ADOPTION IS THE ONE OPERATION THAT NAMES AN ARTIFACT THIS STORE HAS NO COMMIT FOR.
    //
    // Every other operation naming an `artifact_id` is editing something this store already
    // holds, so it must present the etag it saw and it must resolve to a head. `import_legacy`
    // is neither: it is the first commit an artifact that predates this store ever gets, and
    // its identity is DETERMINED BY THE LEGACY LOCATOR rather than minted (which is why it
    // names an id at all, where `create` may not). There is no etag to present, because there
    // is nothing here yet to have read.
    //
    // This is the defect I-11 found and could not fix from its own edit surface: with these
    // two rules applied to `import_legacy` as well, every write to each of the 527 documents
    // already on a live deployment would answer NOT_FOUND_OR_FORBIDDEN the moment the
    // registered tools routed through this kernel, because none of them has a commit here.
    // The fix is not to loosen the identity rule for edits — it is to let the adoption path
    // exist. A store that already holds the artifact refuses a second import as a duplicate
    // identity, in `legacyImportPolicy`, where the locator is in scope to say so.
    const adopting = request.operation === "import_legacy";
    if (request.artifact_id !== undefined && request.expected_etag === undefined && !adopting) {
      return { committed: false, code: "INVALID_INPUT", message: "expected_etag is required for a mutation naming an existing artifact_id" };
    }
    if (adopting && request.artifact_id === undefined) {
      return { committed: false, code: "INVALID_INPUT", message: "import_legacy names the artifact_id its legacy locator determines" };
    }
    const head = request.artifact_id ? state.artifacts.get(request.artifact_id) ?? null : null;
    if (request.artifact_id !== undefined && request.operation !== "create" && !adopting && !head) {
      return { committed: false, code: "NOT_FOUND_OR_FORBIDDEN", message: `no artifact ${request.artifact_id} in owner ${options.auth.owner_id}` };
    }
    if (request.expected_etag !== undefined) {
      const currentEtag = head ? etagOf(head) : null;
      if (currentEtag !== request.expected_etag) {
        return {
          committed: false, code: "REVISION_CONFLICT",
          message: `expected_etag ${request.expected_etag} does not match current ${currentEtag ?? "(absent)"}`,
        };
      }
    }

    const sequence = state.nextSequence;
    const transactionId = randomUUID();
    const policyOutcome = await options.policy(request, {
      owner_id: options.auth.owner_id,
      actor: options.auth.actor,
      transaction_id: transactionId,
      sequence,
      getHead: (artifactId) => state.artifacts.get(artifactId) ?? null,
    });
    if (!policyOutcome.ok) return policyOutcome.error;
    const prepared = policyOutcome.result;

    const manifestInput: PreparedManifestInput = {
      format_version: 1,
      owner_id: options.auth.owner_id,
      sequence,
      transaction_id: transactionId,
      idempotency_key: qualifiedKey,
      request_hash: hash,
      actor: options.auth.actor,
      at: new Date().toISOString(),
      previous_commit_hash: state.previousCommitHash,
      file_changes: prepared.file_changes,
      source_captures: prepared.source_captures,
      revisions: prepared.revisions,
      events: prepared.events,
    };

    let outcome = await commitTransaction({ root, manifest: manifestInput, blobs: prepared.blobs, io });
    if (outcome.committed === "unknown") {
      // One bounded, in-place resume: same manifest, same transaction_id, never a fresh key.
      // Only ever retried when a fresh read establishes the prior attempt never published —
      // committing over a `published` path is exactly the IDEMPOTENCY_CONFLICT record.ts's own
      // preflight exists to refuse, so this never becomes a second edit under the same identity.
      const resolved = await resolveDirect(root, io, sequence, transactionId);
      if (resolved.publication === "absent") {
        outcome = await commitTransaction({ root, manifest: manifestInput, blobs: prepared.blobs, io });
      }
    }
    if (outcome.committed === "unknown") return toIndeterminate(outcome, request.idempotency_key);
    if (outcome.committed === false) return outcome;
    return toMutationResult(outcome, prepared);
  } finally {
    await lock.release();
  }
}

function toMutationResult(receipt: CommitReceipt, prepared: PreparedPolicyResult): MutationResult {
  return {
    committed: true,
    changed: prepared.changed,
    transaction_id: receipt.transaction_id,
    artifact_id: prepared.artifact_id,
    revision: prepared.revision,
    content_hash: prepared.content_hash,
    etag: `${prepared.revision ?? 0}:${receipt.sequence}`,
    commit_sequence: receipt.sequence,
    projection: receipt.projection,
    history_export: receipt.history_export,
  };
}

// ── shared with recovery.ts: resolving one transaction directly, by its own commit path ────

export interface DirectResolution {
  readonly publication: "absent" | "published" | "uncertain";
  readonly durable: boolean;
  readonly manifest?: PreparedManifestInput & { readonly manifest_hash: string };
}

/** Checks the ONE exact path a `(sequence, transaction_id)` pair would publish to — no
 *  directory scan. `durable` re-confirms with a FRESH `fsyncDir`, never one recalled from
 *  write time, which is what lets this turn a genuine `unknown` into a confident `true`. */
export async function resolveDirect(
  root: string, io: RecordIO, sequence: number, transactionId: string,
): Promise<DirectResolution> {
  const commitsDir = join(root, STORE_DIR, COMMITS_SUBDIR);
  const commitPath = join(commitsDir, commitFilename(sequence, transactionId));
  if (!(await io.exists(commitPath))) return { publication: "absent", durable: false };
  let manifest: PreparedManifestInput & { manifest_hash: string };
  try {
    manifest = JSON.parse((await io.readFile(commitPath)).toString("utf8"));
  } catch {
    return { publication: "uncertain", durable: false };
  }
  if (manifestHash(manifest as unknown as Record<string, unknown>) !== manifest.manifest_hash) {
    return { publication: "uncertain", durable: false };
  }
  try {
    await io.fsyncDir(commitsDir);
  } catch {
    return { publication: "published", durable: false, manifest };
  }
  return { publication: "published", durable: true, manifest };
}
