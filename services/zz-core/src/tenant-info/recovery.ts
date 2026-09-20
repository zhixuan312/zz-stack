/**
 * recovery.ts — what a caller does with a `MutationIndeterminate`, and what a freshly
 * restarted reader does with an owner-store nobody has looked at since the last crash.
 *
 * TWO SEPARATE JOBS, because they run at different times for different reasons:
 *   - `resolveIndeterminate` answers one specific question — "did THIS transaction actually
 *     land?" — for a caller holding a `MutationIndeterminate` `mutate()` handed back. It never
 *     mutates anything; it only ever reads, and (per `classifyCommitOutcome`) only a definite
 *     absence licenses telling the caller it is safe to resubmit the identical request.
 *   - `verifyStore` is the "restarted recovery reader": no specific transaction in hand, just
 *     an owner-store root that may have been left mid-write by a crash. It walks the whole
 *     commit chain, confirms each link's `previous_commit_hash` and every referenced blob, and
 *     repairs a materialized path that does not yet match its commit — the "incomplete
 *     materialization" `record.ts`'s own header says a later reader must fix, since nothing in
 *     `commitTransaction` itself may retry that step once the commit is durable.
 *
 * NEITHER FUNCTION MINTS A NEW TRANSACTION. Resuming a lost write is `mutate()`'s job (it
 * already knows the manifest to retry, in place, under the lock it is still holding) — this
 * module only ever reports what the disk says, or repairs a READABLE projection of a commit
 * that already exists. A caller who wants the original mutation actually retried resubmits the
 * same `MutationRequest` (same `idempotency_key`) through `mutate()`, whose idempotency lookup
 * is what actually resumes it — safely, because "absent" here is what licenses that resubmit
 * rather than refusing it as a conflict.
 */
import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { MutationIndeterminate, MutationResult } from "@zz/contracts";

import { classifyCommitOutcome, replayFromManifest, resolveDirect, type DirectResolution } from "./mutations.js";
import { nodeRecordIO, type FileChangeEntry, type PreparedManifestInput, type RecordIO } from "./record.js";

const STORE_DIR = ".zz";
const COMMITS_SUBDIR = "commits";
const BLOBS_SUBDIR = "blobs";

// ── resolving one transaction a caller is holding an indeterminate result for ──────────────

export type RecoveryOutcome =
  | { readonly committed: true; readonly result: MutationResult }
  | { readonly committed: false; readonly safe_to_resume: true }
  | { readonly committed: "unknown" };

/** Finds the ONE commit file `transactionId` could have published to, by scanning
 *  `.zz/commits/` for the suffix `commitFilename` always gives it — `MutationIndeterminate`
 *  carries no `sequence`, only the transaction id, so a direct-path check
 *  (`resolveDirect`, which `mutate()`'s own in-place resume uses) is not available here. */
async function findBySequencePrefix(root: string, transactionId: string): Promise<number | null> {
  const commitsDir = join(root, STORE_DIR, COMMITS_SUBDIR);
  let files: string[];
  try {
    files = await readdir(commitsDir);
  } catch {
    return null;
  }
  const suffix = `-${transactionId}.json`;
  const match = files.find((f) => f.endsWith(suffix));
  if (!match) return null;
  const sequence = Number(match.slice(0, -suffix.length));
  return Number.isFinite(sequence) ? sequence : null;
}

/**
 * Given a `MutationIndeterminate` `mutate()` returned earlier, decides what actually happened:
 * `committed:true` with the original `MutationResult` (never a second one — this reads the
 * commit that already exists, it does not create one), `committed:false, safe_to_resume:true`
 * once absence is freshly established (the caller may resubmit the identical request), or
 * `committed:"unknown"` when neither can be confirmed and nothing has changed.
 */
export async function resolveIndeterminate(
  root: string, indeterminate: MutationIndeterminate, io: RecordIO = nodeRecordIO,
): Promise<RecoveryOutcome> {
  const sequence = await findBySequencePrefix(root, indeterminate.transaction_id);
  if (sequence === null) return { committed: false, safe_to_resume: true };
  const resolved: DirectResolution = await resolveDirect(root, io, sequence, indeterminate.transaction_id);
  const verdict = classifyCommitOutcome(resolved);
  if (verdict === true) {
    if (!resolved.manifest) throw new Error(`resolveDirect reported published without a manifest for ${indeterminate.transaction_id}`);
    return { committed: true, result: replayFromManifest(resolved.manifest, sequence) };
  }
  if (verdict === false) return { committed: false, safe_to_resume: true };
  return { committed: "unknown" };
}

// ── the restarted recovery reader ───────────────────────────────────────────────────────────

export interface StoreVerification {
  readonly ok: boolean;
  readonly problems: readonly string[];
  readonly repaired: readonly string[];
}

function materializedPath(root: string, relPath: string): string {
  return join(root, ...relPath.split(/[/\\]/));
}

async function sha256Hex(io: RecordIO, path: string): Promise<string | null> {
  if (!(await io.exists(path))) return null;
  return createHash("sha256").update(await io.readFile(path)).digest("hex");
}

/** Re-materializes one `file_changes` entry the same way `record.ts` does on the happy path
 *  (same-directory temp file, then rename) — mirrored here because that step is private to
 *  `record.ts` and only ever runs once, right after a commit becomes durable; a reader that
 *  starts up long after that moment is this function's only caller. */
async function repairMaterialization(io: RecordIO, root: string, blobsDir: string, change: FileChangeEntry): Promise<void> {
  const target = materializedPath(root, change.path);
  if (change.after_hash === null) {
    await io.remove(target);
    return;
  }
  const bytes = await io.readFile(join(blobsDir, change.after_hash));
  await io.mkdir(dirname(target));
  const tempPath = join(dirname(target), `.materialize-${change.after_hash}.tmp`);
  await io.writeFile(tempPath, bytes);
  await io.rename(tempPath, target);
}

/**
 * Walks `root/.zz/commits/` in sequence order: every file must own a sequence no other file
 * claims (a collision is the one thing the owner lock exists to make impossible — reported,
 * never silently picked between), every `previous_commit_hash` must chain from the prior
 * commit's own `manifest_hash`, every blob a `file_changes` entry names must exist and hash
 * correctly, and every materialized path must match its commit's `after_hash` — repaired in
 * place when it does not, exactly as `commitTransaction`'s own step 5 would have, had it not
 * been interrupted.
 */
export async function verifyStore(root: string, io: RecordIO = nodeRecordIO): Promise<StoreVerification> {
  const commitsDir = join(root, STORE_DIR, COMMITS_SUBDIR);
  const blobsDir = join(root, STORE_DIR, BLOBS_SUBDIR);
  let files: string[];
  try {
    files = (await readdir(commitsDir)).filter((f) => f.endsWith(".json"));
  } catch (err) {
    return { ok: false, problems: [`commits directory unreadable: ${err instanceof Error ? err.message : String(err)}`], repaired: [] };
  }
  const entries = files
    .map((f) => ({ file: f, sequence: Number(/^(\d+)-/.exec(f)?.[1] ?? NaN) }))
    .sort((a, b) => a.sequence - b.sequence);

  const problems: string[] = [];
  const repaired: string[] = [];
  const claimedBy = new Map<number, string>();
  let previousHash: string | null = null;

  for (const { file, sequence } of entries) {
    if (!Number.isFinite(sequence)) { problems.push(`unrecognized file in commits/: ${file}`); continue; }
    const priorClaim = claimedBy.get(sequence);
    if (priorClaim) { problems.push(`sequence ${sequence} is claimed by both ${priorClaim} and ${file}`); continue; }
    claimedBy.set(sequence, file);

    let manifest: PreparedManifestInput & { manifest_hash: string };
    try {
      manifest = JSON.parse((await io.readFile(join(commitsDir, file))).toString("utf8"));
    } catch { problems.push(`${file} could not be parsed`); continue; }

    if ((manifest.previous_commit_hash ?? null) !== previousHash) {
      problems.push(`${file} previous_commit_hash does not chain from the prior commit`);
    }
    previousHash = manifest.manifest_hash;

    for (const change of manifest.file_changes) {
      if (change.after_hash !== null && !(await io.exists(join(blobsDir, change.after_hash)))) {
        problems.push(`${file} references missing blob ${change.after_hash}`);
        continue;
      }
      const target = materializedPath(root, change.path);
      const currentHash = await sha256Hex(io, target);
      const wantHash = change.after_hash;
      if (currentHash === wantHash) continue;
      try {
        await repairMaterialization(io, root, blobsDir, change);
        repaired.push(target);
      } catch (err) {
        problems.push(`could not repair materialization ${target}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  return { ok: problems.length === 0, problems, repaired };
}
