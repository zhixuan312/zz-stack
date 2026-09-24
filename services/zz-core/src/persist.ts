/**
 * Writing a document down, and the four records that go with it.
 *
 * `persistDocument` is the only way bytes reach the store through the tools registered today
 * (document_write/patch, source_add, the initiative acts). It also takes the version snapshot
 * at an approval, writes the activity entry, appends the ledger row on a close, and commits.
 * The kernel-routed adapters at the bottom of this file reach a disposable store and are not
 * wired into those tools.
 *
 * The envelope is stamped here and nowhere else: `status`, `approved_by`, `approved_at`,
 * `outcome` and `closed_by` are the platform's to write, which is why a model may not send
 * them.
 */
import { execFile } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  ENVELOPE_BLOCK, parseCaller, parseEnvelope,
  type ArtifactRef, type MutationError, type MutationIndeterminate, type MutationResult,
} from "@zz/contracts";
import { indexDoc } from "@zz/indexing";
import { requestHeaders } from "@zz/mcp-http";

import { oneLine, tableRow } from "./document-rules.js";
import {
  legacyArtifactId, legacyImportPolicy, legacyImportRequest, legacyLocatorRefusal,
  prepareLegacyManifest,
} from "./tenant-info/legacy-import.js";
import { mutate, readArtifactHead, type AuthContext } from "./tenant-info/mutations.js";
import { nativePolicy } from "./tenant-info/policies.js";

import { type Chain, isoToday, stampEnvelope } from "./write-guards.js";

/** When a flow document's status flips to approved, copy the approved content to
 * _versions/<doc>.v<N>.md. The model never writes these. */
function snapshotOnApproval(chain: Chain, root: string, relPath: string, target: string, newContent: string): void {
  try {
    const parts = relPath.replace(/^\/+/, "").split("/");
    // DELIBERATE: a flow's declaration narrows this; its absence does not switch it off. A
    // freeform initiative has no manifest, and an approval there still files a frozen copy.
    if (parts.length !== 2) return;
    if (chain.documents.length && !chain.docs.has(parts[1])) return;
    if (parseEnvelope(newContent).status !== "approved") return;
    const oldStatus = existsSync(target)
      ? parseEnvelope(readFileSync(target, "utf8")).status
      : undefined;
    if (oldStatus === "approved") return; // only on the flip
    // Through parseEnvelope, not a bare regex: `^version:` with /m over the whole document
    // matches a line in the body, and takes the first match where parseEnvelope takes the last.
    const declaredV = parseEnvelope(newContent).version ?? "";
    const v = /^\d+$/.test(declaredV) ? declaredV : "1";
    const snapshot = parts[1].replace(/\.md$/, "") + ".v" + v + ".md";
    const dir = join(root, parts[0], "_versions");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, snapshot), newContent);
    // Indexed by the path that wrote it, so a frozen approval is searchable without a manual
    // knowledge_reindex. indexDoc derives `superseded_by` from exactly this path shape.
    //
    // The file is the record and the index is derived from it, so a failure here must not fail
    // the write — indexDoc swallows its own errors and reports them, as logActivity does.
    //
    // This one snapshot, not a rebuild of the team: an approval's cost must not grow with the
    // size of the store.
    void indexDoc(root, `${parts[0]}/_versions/${snapshot}`, newContent);
  } catch {
    /* snapshots must never break the write */
  }
}
/** Replace a field's line inside the frontmatter, leaving the body alone.
 *
 * A bare `doc.replace(/^status: .*$/m, …)` is applied to the whole document and rewrites
 * whichever line comes first, and a journal node has body lines that begin with a word and a
 * colon. */
export function setEnvelopeField(doc: string, field: string, value: string): string {
  const m = doc.match(ENVELOPE_BLOCK);
  if (!m) return doc;
  const line = new RegExp(`^${field}:.*$`, "m");
  if (!line.test(m[1])) return doc;
  // Function replacements, both of them: a string replacement interprets $$, $&, $` and $',
  // and `value` is not always the platform's own — initiative_close() passes the model's
  // `accepted_by` through putEnvelopeField below, so `$'` in a name duplicates the rest of the
  // document into its envelope.
  //
  // oneLine() for the other half: a newline in a value adds a field rather than corrupting
  // one, and parseEnvelope takes the last value of a repeated key, so `"Dana Reyes\nflow:
  // other"` sets a flow the platform never chose. Applied here rather than at the four call
  // sites. ownershipCheck cannot catch it: approve and close pass `via`, and that check returns
  // null on `via`.
  return doc.replace(m[0], () => m[0].replace(line, () => `${field}: ${oneLine(value)}`));
}
/** Set an envelope field, adding it when it is not already there.
 *
 * setEnvelopeField only replaces: it returns the document untouched when the field is absent,
 * and the governance fields are stamped onto documents that have never carried them. The
 * insert goes at the end of the frontmatter block, so `flow` and `type` stay at the top where
 * a reader scans for them. */
export function putEnvelopeField(doc: string, field: string, value: string): string {
  const m = doc.match(ENVELOPE_BLOCK);
  if (!m) return doc;
  if (new RegExp(`^${field}:.*$`, "m").test(m[1])) return setEnvelopeField(doc, field, value);
  const block = m[0].replace(/\n---[ \t]*\n?$/, () => `\n${field}: ${oneLine(value)}\n---\n`);
  return doc.replace(m[0], () => block);
}
/** Mechanical activity log — system telemetry, never written by the model.
 * Entries about a file inside an initiative folder go to that folder's
 * activity.jsonl; everything else to _activity.jsonl at the store root. */
export function logActivity(root: string, relPath: string | null, entry: Record<string, unknown>): void {
  try {
    let dir = root;
    const seg = relPath?.replace(/^\/+/, "").split("/")[0];
    if (relPath && relPath.includes("/") && seg && existsSync(join(root, seg))) {
      dir = join(root, seg);
    }
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
    appendFileSync(join(dir, dir === root ? "_activity.jsonl" : "activity.jsonl"), line + "\n");
  } catch {
    /* telemetry must never break the operation it describes */
  }
}
/** Mechanical ledger row on close: when outcome lands in the closing
 * document, append one row to the team's _ledger.md — basics only; the
 * learning analysis computes the rest from telemetry. */
function ledgerOnClose(root: string, relPath: string, content: string): void {
  try {
    const parts = relPath.replace(/^\/+/, "").split("/");
    // A document directly inside an initiative folder; nothing else closes one.
    if (parts.length !== 2) return;
    // Whichever document carries the outcome, whatever a flow named as its closing document:
    // an initiative abandoned part-way is closed on the furthest document that exists, because
    // the closing one was never written.
    //
    // The outcome is the signal. outcomeCheck refuses one typed by hand, so only
    // initiative_close can write it; it writes exactly one; and the already-closed test below
    // stops a second row. Read through parseEnvelope, so a body that merely mentions
    // `outcome:` appends nothing.
    const outcome = parseEnvelope(content).outcome;
    if (!outcome) return;
    const prev = existsSync(join(root, parts[0], parts[1]))
      ? readFileSync(join(root, parts[0], parts[1]), "utf8")
      : "";
    if (parseEnvelope(prev).outcome) return; // already closed once
    let writes = 0, patches = 0, firstTs = "", lastTs = "";
    const act = join(root, parts[0], "activity.jsonl");
    if (existsSync(act)) {
      for (const line of readFileSync(act, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const e = JSON.parse(line) as { ts?: string; action?: string };
          if (!firstTs && e.ts) firstTs = e.ts;
          if (e.ts) lastTs = e.ts;
          if (e.action === "document_write") writes++;
          if (e.action === "document_patch") patches++;
        } catch { /* skip */ }
      }
    }
    const hours = firstTs && lastTs
      ? ((new Date(lastTs).getTime() - new Date(firstTs).getTime()) / 3.6e6).toFixed(1)
      : "";
    const ledger = join(root, "_ledger.md");
    if (!existsSync(ledger)) {
      writeFileSync(ledger,
        "| closed | initiative | outcome | e2e hours | writes | patches |\n|---|---|---|---|---|---|\n");
    }
    // Escaped through tableRow, like every other table this file writes: an initiative folder
    // named `a|b`, which safePath permits, would otherwise append a row a parser reads as two
    // cells.
    appendFileSync(ledger, tableRow(isoToday(), parts[0], outcome, hours, writes, patches));
  } catch { /* the ledger must never break a close */ }
}
/** The team's store is a git repository, and every act that changes it is a commit.
 *
 * The actor is the git author, so attribution travels with the repository and is readable by
 * `git log` on a machine with nothing of ours installed.
 *
 * DELIBERATE: `add -A` rather than the one path. Journal nodes, sources and the ledger are
 * written by other tools, and staging everything keeps one commit path instead of a call at
 * every writeFileSync. The churn that would drown the history is excluded at init
 * instead, by STORE_GITIGNORE below.
 *
 * Never throws and never blocks: the file is on disk before this runs, so a git failure leaves
 * a team with their document and a missing commit rather than a refused write. Failures go to
 * the container log as well as the activity log, because nothing reads `git_failed`. */
const STORE_GITIGNORE = [
  "# Mechanical telemetry, appended on every call and already held in zz.event.",
  "# A commit per skill load would bury the history this repository exists for.",
  "activity.jsonl",
  "_activity.jsonl",
  "",
].join("\n");
export function commitStore(root: string, actor: string, action: string, subject: string): void {
  const run = (args: string[], then?: () => void): void => {
    execFile("git", ["-C", root, ...args], { timeout: 15_000 }, (err) => {
      if (err) {
        const why = `${args[0]}: ${String(err.message).slice(0, 160)}`;
        logActivity(root, null, { user: actor, action: "git_failed", detail: why });
        // The history can stop being written without a single request failing, and the
        // activity log is read by nothing.
        console.error(`git_failed in ${root}: ${why}`);
        return;
      }
      then?.();
    });
  };
  const name = actor.split("@")[0] || "zz";
  const commit = (): void => run(["add", "-A"], () =>
    // --allow-empty: a write that changed nothing still happened, and a run of them with no
    // commits reads as a store nobody touched.
    run(["-c", `user.name=${name}`, "-c", `user.email=${actor}`,
         "commit", "--allow-empty", "-m", `${action}: ${subject}`]));
  if (existsSync(join(root, ".git"))) return commit();
  // The first act on a team's store initialises it. `-b main` rather than the host's default:
  // a branch name that varies by machine breaks the day this repository gains a remote.
  try {
    writeFileSync(join(root, ".gitignore"), STORE_GITIGNORE);
  } catch { /* unwritable root: init will fail too, and that failure is the one worth logging */ }
  run(["init", "-b", "main"], commit);
}
/** Everything that happens once a mutation is allowed, in the order it must happen.
 *
 * `act` has no default. It becomes the commit message in the team's own repository, and a log
 * in which an approval and a typo fix both read "write" cannot answer what happened between
 * the approval and the close. Without a default, the compiler asks. */
export function persistDocument(chain: Chain, root: string, relPath: string, target: string,
                         content: string, act: string): string {
  const stamped = stampEnvelope(chain, relPath, content);
  mkdirSync(resolve(target, ".."), { recursive: true });
  snapshotOnApproval(chain, root, relPath, target, stamped);
  ledgerOnClose(root, relPath, stamped);
  writeFileSync(target, stamped);
  // The act, not "write": every commit here names its act.
  commitStore(root, parseCaller(requestHeaders()).email, act, relPath);
  void indexDoc(root, relPath, stamped);
  return stamped;
}

// Adapters that route through the tenant-info mutation kernel
//
// These are not wired into document_write/document_patch/document_approve/source_add above.
// `mutate()` (tenant-info/mutations.ts) refuses NOT_FOUND_OR_FORBIDDEN for any artifact_id it
// holds no commit for — `readOwnerState` there replays only `.zz/commits/*.json` — and a
// document the old write path created has none, so routing the tools above through `mutate()`
// would answer every write to an existing document with a refusal. The adoption path at the
// bottom of this file is the missing half.
//
// `auth` is the one port these functions accept: the caller identity
// `parseCaller(requestHeaders())` resolves for the tools above is passed in here instead, so a
// fixture can supply a fixed one. A clock and export ports are not threaded through — `mutate()`
// derives `at` internally and never accepts a `CommitExports`.

export interface ArtifactPorts {
  readonly root: string;
  readonly auth: AuthContext;
}

/** The semantic fields a document write may set. Anything omitted gets exactly the default
 *  `canonicalPayload` (policies.ts) would apply to a missing field — this never invents a
 *  second set of defaults. */
interface DocumentSeed {
  readonly body: string;
  readonly title?: string;
  readonly description?: string;
  readonly type?: string;
  readonly tags?: readonly string[];
  readonly resource?: string | null;
  readonly content_fields?: Record<string, unknown>;
}

function documentPayload(seed: DocumentSeed): Record<string, unknown> {
  const payload: Record<string, unknown> = { body: seed.body };
  if (seed.title !== undefined) payload.title = seed.title;
  if (seed.description !== undefined) payload.description = seed.description;
  if (seed.type !== undefined) payload.type = seed.type;
  if (seed.tags !== undefined) payload.tags = seed.tags;
  if (seed.resource !== undefined) payload.resource = seed.resource;
  if (seed.content_fields !== undefined) payload.content_fields = seed.content_fields;
  return payload;
}

export type MutationOutcome = MutationResult | MutationError | MutationIndeterminate;

/** A flat, always-shaped view of `MutationOutcome` for a caller that reads a field without
 *  first narrowing the discriminated union. A field that does not apply to this outcome's
 *  `committed` value is absent, never a fabricated default. */
export interface MutationOutcomeView {
  readonly committed: true | false | "unknown";
  readonly code?: string;
  readonly message?: string;
  readonly transaction_id?: string | null;
  readonly idempotency_key?: string;
  readonly artifact_id?: string;
  readonly revision?: number | null;
  readonly content_hash?: string;
  readonly etag?: string;
  readonly commit_sequence?: number | null;
  readonly projection?: "current" | "pending";
  readonly history_export?: "current" | "pending";
}

export function toOutcomeView(outcome: MutationOutcome): MutationOutcomeView {
  return { ...outcome };
}

/** `source_add`'s eventual kernel entry point: one immutable capture, never revised. */
export async function captureSource(
  ports: ArtifactPorts,
  input: { readonly content: string; readonly original_path: string; readonly title: string; readonly media_type: string },
  idempotencyKey: string,
): Promise<MutationOutcome> {
  return mutate({
    root: ports.root, auth: ports.auth, policy: nativePolicy,
    request: {
      operation: "create", idempotency_key: idempotencyKey, artifact_class: "source",
      payload: { content: input.content, original_path: input.original_path, title: input.title, media_type: input.media_type },
      cause_refs: [],
    },
  });
}

/** `document_write`'s eventual kernel entry point for a new document. `causeRefs` must
 *  already resolve to a committed (or same-batch-staged) record — an empty list is refused
 *  CAUSE_REQUIRED by the kernel's own policy, never defaulted here. */
export async function writeDocument(
  ports: ArtifactPorts, seed: DocumentSeed, causeRefs: readonly ArtifactRef[], idempotencyKey: string,
): Promise<MutationOutcome> {
  return mutate({
    root: ports.root, auth: ports.auth, policy: nativePolicy,
    request: {
      operation: "create", idempotency_key: idempotencyKey, artifact_class: "work_document",
      payload: documentPayload(seed), cause_refs: causeRefs,
    },
  });
}

/** `document_patch`/`document_revise`'s eventual kernel entry point. `expected_etag` has no
 *  default: an omitted one is the safety-related compatibility error the spec names, never a
 *  value this function invents to let a stale request through. */
export async function patchDocument(
  ports: ArtifactPorts,
  request: {
    readonly artifact_id: string; readonly expected_etag?: string; readonly idempotency_key: string;
    readonly seed: DocumentSeed; readonly cause_refs: readonly ArtifactRef[];
  },
): Promise<MutationOutcome> {
  return mutate({
    root: ports.root, auth: ports.auth, policy: nativePolicy,
    request: {
      operation: "revise", artifact_id: request.artifact_id, expected_etag: request.expected_etag,
      idempotency_key: request.idempotency_key, artifact_class: "work_document",
      payload: documentPayload(request.seed), cause_refs: request.cause_refs,
    },
  });
}

/** `document_approve`'s eventual kernel entry point. Binds to the revision and record digest
 *  the caller presents as current — `decideTransition` (policies.ts) refuses either one stale,
 *  never approving content or provenance the caller has not actually seen. */
export async function approveDocument(
  ports: ArtifactPorts,
  request: {
    readonly artifact_id: string; readonly expected_etag?: string; readonly idempotency_key: string;
    readonly reason: string; readonly expected_revision: number; readonly expected_record_digest: string;
  },
): Promise<MutationOutcome> {
  return mutate({
    root: ports.root, auth: ports.auth, policy: nativePolicy,
    request: {
      // NOT A TOOL: the kernel's own MutationOp value. The MCP tool this adapter will stand
      // behind is document_approve.
      operation: "approve", artifact_id: request.artifact_id, expected_etag: request.expected_etag,
      idempotency_key: request.idempotency_key, artifact_class: "work_document",
      payload: {
        reason: request.reason, expected_revision: request.expected_revision,
        expected_record_digest: request.expected_record_digest, gate_declared: true,
      },
      cause_refs: [],
    },
  });
}

// The adoption path, and the adapter the cutover registers
//
// A registered tool holds a path — `document_patch("xuan/plan.md")` — and `legacyArtifactId`
// turns that path into the one identity this platform will ever give those bytes. If the
// kernel already holds that artifact, `reviseDocumentAtPath` is an ordinary revise at its
// current etag. If it does not, and the bytes are on disk where the old write path left them,
// they are adopted first: one `import_legacy` commit that archives the original bytes
// untouched and records where they came from, and only then the revise.

/** The legacy bytes for a locator, or `null` when the store holds no such file. The locator is
 *  checked with the importer's own rule before the path is opened — one rule, not a second
 *  slightly-different one here. */
function readLegacyBytes(root: string, locator: string): Buffer | null {
  if (legacyLocatorRefusal(locator) !== null) return null;
  const target = join(root, ...locator.split("/"));
  if (!existsSync(target)) return null;
  return readFileSync(target);
}

/**
 * Gives an artifact that predates this record store its first commit, from the bytes the old
 * write path left on disk. Returns `null` when there is nothing at that locator to adopt,
 * which is the ordinary answer for a document this store minted itself.
 *
 * Calling it twice is free: the importer's idempotency key is a digest of the manifest id, the
 * locator and the original byte hash, so a second call presents the identical request under
 * the identical key and `mutate()` replays the first commit's result without writing.
 */
export async function adoptLegacyDocument(ports: ArtifactPorts, locator: string): Promise<MutationOutcome | null> {
  const bytes = readLegacyBytes(ports.root, locator);
  if (bytes === null) return null;
  const { manifest, blocking } = prepareLegacyManifest([{ path: locator, bytes }]);
  const row = manifest.rows[0];
  if (!row) {
    const why = blocking.map((b) => `${b.code}: ${b.message}`).join("; ");
    return { committed: false, code: "INVALID_INPUT", message: `${locator} cannot be adopted — ${why}` };
  }
  return mutate({
    root: ports.root, auth: ports.auth, policy: legacyImportPolicy,
    request: legacyImportRequest(ports.auth.owner_id, manifest, row, bytes),
  });
}

/**
 * The path-addressed write the cutover registers, and the only one that is safe to point
 * `document_patch`/`document_revise` at. Adopts first when the artifact has no commit here and
 * legacy bytes exist for it, then revises through the same `patchDocument` every native edit
 * uses.
 *
 * `expected_etag` still wins when the caller has one, and a stale one is refused. The fallback
 * covers only the first write to bytes this store has just adopted, which no caller can hold a
 * kernel etag for.
 */
export async function reviseDocumentAtPath(
  ports: ArtifactPorts,
  request: {
    readonly locator: string; readonly seed: DocumentSeed;
    readonly cause_refs: readonly ArtifactRef[]; readonly idempotency_key: string;
    readonly expected_etag?: string;
  },
): Promise<MutationOutcome> {
  const artifactId = legacyArtifactId(ports.auth.owner_id, request.locator);
  const head = await readArtifactHead(ports.root, artifactId);

  // DELIBERATE: the fallback etag comes off the adoption and nothing else. `expected_etag` is
  // part of what `requestHash` covers, so synthesizing the current head's etag would hand the
  // kernel a different request every time the document changed, and a caller retrying a lost
  // response under the same idempotency key would get IDEMPOTENCY_CONFLICT instead of a clean
  // replay. The adoption replays off its own commit forever, so its etag never moves.
  //
  // Adoption is attempted only when it could matter: no commit, or no etag from the caller.
  let adopted: MutationOutcome | null = null;
  if (head === null || request.expected_etag === undefined) {
    adopted = await adoptLegacyDocument(ports, request.locator);
    if (adopted !== null && adopted.committed !== true) return adopted;
  }
  if (head === null && adopted === null) {
    // No commit and no bytes: nothing to revise and nothing to adopt. Naming that beats
    // falling through to the kernel's "expected_etag is required".
    return {
      committed: false, code: "NOT_FOUND_OR_FORBIDDEN",
      message: `no artifact for ${request.locator} in this store, and no legacy bytes at that path to adopt — writing a new document is writeDocument's act`,
    };
  }
  return patchDocument(ports, {
    artifact_id: artifactId,
    expected_etag: request.expected_etag ?? (adopted?.committed === true ? adopted.etag : undefined),
    idempotency_key: request.idempotency_key, seed: request.seed, cause_refs: request.cause_refs,
  });
}

/** `document_read`/`document_present`'s eventual kernel entry point for a pinned artifact_id:
 *  the materialized body `record.ts` wrote to `documents/<artifact_id>.md` on the last
 *  committed create/revise. Revision, content_hash, record_digest and etag are not derivable
 *  here without `mutations.ts`'s unexported owner-state replay; a caller that needs those holds
 *  them on the `MutationResult` a create/revise/approve just returned. */
export function readDocumentBody(root: string, artifactId: string): { readonly body: string } | null {
  const target = join(root, "documents", `${artifactId}.md`);
  if (!existsSync(target)) return null;
  return { body: readFileSync(target, "utf8") };
}
