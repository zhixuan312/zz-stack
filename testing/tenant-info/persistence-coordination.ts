/**
 * persistence-coordination.ts — I-8's "coordination" case group: the owner lock, the etag
 * comparison made under it, idempotency receipts, and recovery from an uncertain outcome.
 *
 * SPLIT OUT OF persistence.ts AT THE CEILING, and not for tidiness. That file reached 698 lines
 * of a measured, unexemptable 700 while the ledger still owed it a third case group from I-11.
 * The rule in this repository is to agree the size and split rather than let a worker discover
 * the wall mid-task, so the shape is set here: the suite entry keeps the shared fixtures and the
 * group registry, and each case group is a file that imports them. I-11 adds a file.
 *
 * THESE CASES SPAWN REAL CHILD PROCESSES. Two writers racing on one stale etag, and two carrying
 * the same idempotency key with equal and with differing requests, are each two operating-system
 * processes contending for one lock — with the first to reach rename made to sleep inside it, so
 * what is measured is the lock serialising them rather than which process happened to start
 * first. Sequential calls in a single process would pass against a kernel holding no lock at all.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { MutationRequest } from "@zz/contracts";

import {
  nodeRecordIO,
  type RecordIO,
} from "../../services/zz-core/dist/tenant-info/record.js";
import {
  mutate,
  type ArtifactHead,
  type AuthContext,
  type MutateOptions,
  type Policy,
  type PolicyContext,
  type PolicyOutcome,
  type PreparedPolicyResult,
} from "../../services/zz-core/dist/tenant-info/mutations.js";
import {
  resolveIndeterminate,
  verifyStore,
  type RecoveryOutcome,
  type StoreVerification,
} from "../../services/zz-core/dist/tenant-info/recovery.js";
import { instrument, isManifestRenameTarget, makeStoreRoot } from "./persistence.ts";

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

/** The case group this file owns; `persistence.ts`'s registry names it. */
export const COORDINATION_CASES: Readonly<Record<string, () => Promise<void>>> = {
  two_processes_race_on_stale_etag: caseTwoProcessesRaceOnStaleEtag,
  two_processes_same_key_equal_request_dedupes: caseTwoProcessesSameKeyEqualRequestDedupes,
  two_processes_same_key_different_request_conflicts: caseTwoProcessesSameKeyDifferentRequestConflicts,
  stale_lock_is_broken: caseStaleLockIsBroken,
  indeterminate_recovery_confirms_commit: caseIndeterminateRecoveryConfirmsCommit,
  indeterminate_absence_is_safe_to_resume: caseIndeterminateAbsenceIsSafeToResume,
  restarted_recovery_reader: caseRestartedRecoveryReader,
};
