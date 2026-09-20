/**
 * Writing a document down, and the four records that go with it.
 *
 * `persistDocument` is the only way bytes reach the store THROUGH THE TOOLS REGISTERED TODAY
 * (document_write/patch, source_add, and the initiative acts) — see this file's bottom
 * section for the second, kernel-routed way bytes reach a DISPOSABLE store, and why it is not
 * yet the same tools' way of reaching this one. It remains one function for the tools above
 * because each of the things it does afterwards was once a line somebody had to remember: the
 * version snapshot taken at an approval, the activity entry, the ledger row on a close, and
 * the commit that makes the store a history a team can walk away with.
 *
 * THE ENVELOPE IS STAMPED HERE AND NOWHERE ELSE. `status`, `approved_by`, `approved_at`,
 * `outcome`, `closed_by` are the platform's to write, which is the whole reason a model may
 * not send them — a second writer would make that rule advisory.
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
import { mutate, type AuthContext } from "./tenant-info/mutations.js";
import { nativePolicy } from "./tenant-info/policies.js";

import { type Chain, isoToday, stampEnvelope } from "./write-guards.js";

/** Mechanical version snapshot: the moment a flow document's status flips
 * to approved, copy the APPROVED content to _versions/<doc>.v<N>.md. The
 * model never writes these; provenance gets a frozen copy per approval. */
function snapshotOnApproval(chain: Chain, root: string, relPath: string, target: string, newContent: string): void {
  try {
    const parts = relPath.replace(/^\/+/, "").split("/");
    // A FLOW'S DECLARATION NARROWS THIS; ITS ABSENCE DOES NOT SWITCH IT OFF. Unconditionally
    // this returned for every document of a freeform initiative, so an approval there filed
    // no frozen copy at all — the approver's name stood on bytes with nothing recording what
    // they were. Provenance the platform cannot show is the failure this function exists to
    // prevent, and "no manifest" is not a reason to stop preventing it.
    if (parts.length !== 2) return;
    if (chain.documents.length && !chain.docs.has(parts[1])) return;
    if (parseEnvelope(newContent).status !== "approved") return;
    const oldStatus = existsSync(target)
      ? parseEnvelope(readFileSync(target, "utf8")).status
      : undefined;
    if (oldStatus === "approved") return; // only on the flip
    // Through parseEnvelope like every other envelope read. This was a bare regex with /m
    // over the WHOLE document, so a line beginning `version:` anywhere in the body — a code
    // block, a quoted frontmatter example — was read as the document's version, and it took
    // the FIRST match where parseEnvelope takes the last. A snapshot then landed under the
    // wrong v<N>, which either invents a version nobody wrote or overwrites the one that
    // was there.
    const declaredV = parseEnvelope(newContent).version ?? "";
    const v = /^\d+$/.test(declaredV) ? declaredV : "1";
    const snapshot = parts[1].replace(/\.md$/, "") + ".v" + v + ".md";
    const dir = join(root, parts[0], "_versions");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, snapshot), newContent);
    // INDEXED BY THE PATH THAT WROTE IT.
    //
    // Snapshots reached disk and stopped there. Nothing put a row in zz.doc for one, so the
    // only way a frozen approval became searchable was somebody remembering to run
    // knowledge_reindex(force) by hand — and the initiative that found this has snapshots on
    // disk and zero indexed rows, which is what "somebody remembers" looks like over time.
    // indexDoc already knows what a snapshot IS: it derives `superseded_by` from exactly this
    // path shape. It was simply never called with one at the moment one was written.
    //
    // The file is the record and the index is derived from it, so a failure here must not
    // fail the write. indexDoc swallows its own errors and reports them, the same way
    // logActivity does — a snapshot that is written but unindexed is a stale row, while a
    // snapshot refused over an index fault is a lost approval.
    //
    // This one snapshot, not a rebuild of the team: the write path knows precisely what it
    // changed, and reindexing everything on every approval would make an approval's cost
    // grow with the size of the store.
    void indexDoc(root, `${parts[0]}/_versions/${snapshot}`, newContent);
  } catch {
    /* snapshots must never break the write */
  }
}
/** Replace a field's line INSIDE the frontmatter, leaving the body alone.
 *
 * A bare `doc.replace(/^status: .*$/m, …)` is applied to the whole document, so it rewrites
 * whichever line comes first — and in a journal node or an OKR sheet the body is full of
 * lines that begin with a word and a colon. The OKR grader already lost this once with a narrower
 * pattern: `^status: active$` matched the first grading only, so a second pass left the
 * envelope carrying the FIRST average while the body carried the new scores. Scoping the
 * replacement is what makes "the envelope says X" true of the envelope. */
export function setEnvelopeField(doc: string, field: string, value: string): string {
  const m = doc.match(ENVELOPE_BLOCK);
  if (!m) return doc;
  const line = new RegExp(`^${field}:.*$`, "m");
  if (!line.test(m[1])) return doc;
  // FUNCTION replacements, both of them. A string replacement interprets $$, $&, $` and $'
  // — and `value` here is not always the platform's own: initiative_close() passes the model's
  // `accepted_by` through putEnvelopeField below. `$'` means "everything after the match",
  // so one of those in a name silently duplicates the rest of the document into its envelope.
  //
  // ONE LINE, for the other half of the same problem. That comment already said the value can
  // be the model's and stopped at the substitution patterns, which are the milder failure: a
  // newline does not corrupt a field, it ADDS one, and parseEnvelope takes the LAST value of a
  // repeated key. Measured through document_approve(): `on_behalf_of: "Dana Reyes\nflow: other\noutcome:
  // accepted"` wrote a flow the platform had not chosen and an outcome nobody had derived —
  // through the tool whose description says the platform writes those fields and a
  // hand-written one is refused. ownershipCheck cannot see it either, because approve and
  // close pass `via` and that check returns null on `via` by design.
  //
  // Here rather than at the four call sites. initiative_close() already spelled `oneLine(reason)` at one
  // of them and not at `accepted_by` directly above it, which is what a rule kept as a
  // call-site habit looks like just before it is forgotten.
  return doc.replace(m[0], () => m[0].replace(line, () => `${field}: ${oneLine(value)}`));
}
/** Set an envelope field, adding it when it is not already there.
 *
 * setEnvelopeField only REPLACES: it returns the document untouched when the field is
 * absent, which is right for a rewrite and wrong for a stamp. The governance fields are
 * stamped by the platform onto documents that have never carried them, so the stamp needs
 * the other half. Insert at the end of the frontmatter block, never the top: a reader scans
 * frontmatter for `flow` and `type` first, and pushing them down to make room for a status
 * line makes the envelope harder to read for no gain. */
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
    // WHICHEVER DOCUMENT CARRIES THE OUTCOME, when no flow named one. A freeform initiative
    // has `closingDoc === ""`, so this returned every time and a freeform close appended no
    // ledger row — and the ledger is what the team's counts read, so those closes were
    // invisible to every total built on it. initiative_close is the only thing that can write
    // an `outcome` (outcomeCheck refuses one typed by hand), so the document it stamps is the
    // one that closed the initiative.
    if (parts.length !== 2) return;
    // AND WHICHEVER DOCUMENT CARRIES IT WHEN A FLOW *DID* NAME ONE — the same argument, which
    // was only ever applied to half the cases.
    //
    // `if (chain.closingDoc && parts[1] !== chain.closingDoc) return;` stood here, and an
    // initiative abandoned part-way is exactly the close that does not land on the closing
    // document: `initiative_close` records an abandon on the FURTHEST document that exists,
    // because the closing one never got written — that is what abandoning means. So the one
    // outcome the ledger most needs was the one it never received, while initiative_close
    // told the caller in as many words that "a ledger row was appended". Live on this
    // deployment: xuan/2026-09-13-platform-surface-redesign, abandoned on plan.md, absent
    // from the ledger the team's counts are totalled from.
    //
    // Nothing is loosened by dropping it. `outcomeCheck` refuses an `outcome` typed by hand,
    // so only initiative_close can put one there; it writes exactly one; and the
    // already-closed test below stops a second row. The presence of the outcome IS the
    // signal, which is what the paragraph above already concluded for freeform.
    // Through parseEnvelope: both of these scanned the whole document, so a closing document
    // that merely mentioned `outcome:` in its body — quoting the rule, or showing an
    // example — appended a ledger row for an initiative nobody had closed.
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
    // ESCAPED, like every other table this file writes. journalLog and the journal index both
    // pass their variable fields through tableCell and this row did not — so an initiative
    // folder named `a|b`, which safePath permits, appended a row a parser reads as initiative
    // "a" and outcome "b". The ledger is the record the smoke suite's whole verdict rests on,
    // "a row the model cannot write"; the model cannot write it, and it could still shape it
    // by choosing a folder name.
    appendFileSync(ledger, tableRow(isoToday(), parts[0], outcome, hours, writes, patches));
  } catch { /* the ledger must never break a close */ }
}
/** The team's store IS a git repository, and every act that changes it is a commit.
 *
 * The store has been a directory on a volume: real writes, real approval snapshots in
 * `_versions/`, and no way to answer "what changed between the approval and the close"
 * except by diffing two snapshots the platform happened to take. git answers that for every
 * write, and answers it in a format that outlives this platform — which is the point,
 * because the documents belong to the team and not to us. A team that leaves takes its
 * repository and loses nothing.
 *
 * The actor is the git author. Provenance already lives in `zz.event` and in the envelope;
 * putting it in the commit too means the attribution travels with the repository, readable
 * by `git log` on a laptop with nothing of ours installed.
 *
 * WHY `add -A` RATHER THAN THE ONE PATH: documents are not the only thing a team owns.
 * Journal nodes, OKRs, sources and the ledger are written by five other tools, and a
 * repository holding the documents but not the knowledge is a repository that answers half
 * the questions. Staging everything means one commit path instead of a call sprinkled at
 * every writeFileSync — which is how two of them end up disagreeing about what a commit is.
 *
 * The churn that would drown it is excluded at init instead: `activity.jsonl` is appended on
 * every skill load and already lives in `zz.event`, and a commit per read is noise that
 * makes the history useless for the thing it exists for.
 *
 * NEVER throws and never blocks. The file is on disk before this runs; a git failure must
 * leave a team with their document and a missing commit, not a refused write — exactly as
 * the ledger must never break a close.
 *
 * AND IT SAYS SO WHERE SOMEBODY LOOKS. This docstring used to end "failures land in the
 * activity log, which is where a silent degradation becomes something a person can see", and
 * nothing anywhere reads `git_failed` — not the reports, not the monitor, not the release
 * checks. That is not hypothetical: the released image shipped without git for some time, so
 * every document write on production succeeded, logged this line, and left every team's store
 * with no history at all. The container log is where an operator looks when something is
 * wrong with a service, so the failure goes there too. */
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
        // The store's history is what a team keeps when they leave this platform, and it can
        // stop being written without a single request failing. Somebody has to be able to see
        // that, and the activity log is read by nothing.
        console.error(`git_failed in ${root}: ${why}`);
        return;
      }
      then?.();
    });
  };
  const name = actor.split("@")[0] || "zz";
  const commit = (): void => run(["add", "-A"], () =>
    // --allow-empty: a write that changed nothing still happened, and a run of them with no
    // commits reads as a store nobody touched. Empty commits are cheap and honest.
    run(["-c", `user.name=${name}`, "-c", `user.email=${actor}`,
         "commit", "--allow-empty", "-m", `${action}: ${subject}`]));
  if (existsSync(join(root, ".git"))) return commit();
  // The first act on a team's store initialises it. `-b main` rather than whatever the host
  // configured as its default: a branch name that varies by machine is a branch name that
  // breaks the day this repository gains a remote.
  try {
    writeFileSync(join(root, ".gitignore"), STORE_GITIGNORE);
  } catch { /* unwritable root: init will fail too, and that failure is the one worth logging */ }
  run(["init", "-b", "main"], commit);
}
/** Everything that happens once a mutation is allowed, in the order it must happen.
 *
 * Both write paths did these steps inline and document_patch was missing one of them, silently
 * skipping the envelope stamp, so a document written before its flow was known stayed
 * unstamped however often it was edited. (The count is not written here for the reason
 * documentGuards gives above: the list has grown twice since and the number had not.)
 *
 * `act` has no default on purpose. It becomes the commit message in the team's own
 * repository, and the question that repository exists to answer — what happened between the
 * approval and the close — cannot be answered by a log in which an approval and a typo fix
 * both read "write". A default would let the next write path be added without anyone
 * choosing; without one, the compiler asks. */
export function persistDocument(chain: Chain, root: string, relPath: string, target: string,
                         content: string, act: string): string {
  const stamped = stampEnvelope(chain, relPath, content);
  mkdirSync(resolve(target, ".."), { recursive: true });
  snapshotOnApproval(chain, root, relPath, target, stamped);
  ledgerOnClose(root, relPath, stamped);
  writeFileSync(target, stamped);
  // The ACT, not "write". The store is a git repository so that a team can ask what
  // happened between the approval and the close, and a log in which an approval and a typo
  // fix both read "write" cannot answer that. Every other commit here names its act.
  commitStore(root, parseCaller(requestHeaders()).email, act, relPath);
  void indexDoc(root, relPath, stamped);
  return stamped;
}

// ── I-11: adapters that route through the tenant-info mutation kernel ──────────────────────
//
// THESE ARE NOT WIRED INTO document_write/document_patch/document_approve/source_add ABOVE,
// and that gap is reported rather than papered over. `mutate()` (I-8's `tenant-info/
// mutations.ts`) refuses NOT_FOUND_OR_FORBIDDEN for any artifact_id it holds no commit for —
// `readOwnerState` there replays only `.zz/commits/*.json` — and every one of the 527
// documents on a live deployment has no such commit. Giving one a commit is `import_legacy`,
// which `nativePolicy` (policies.ts) explicitly excludes ("that is migrate.ts's, not this
// task's") and which does not exist yet: it is task I-20, three tasks after this one, per the
// plan's own dependency order. Routing the tools above through `mutate()` before that import
// exists would answer every write to an existing document with a refusal — the regression the
// safety directive on this task names outright: "a document that is valid and writable today
// must remain valid and writable."
//
// What this task delivers instead: the one real, single-mutation-kernel entry point the
// cutover task registers in place of the ad-hoc writes above, exercised end to end against a
// disposable store by `createAdapterFixture()` in testing/tenant-info/model.ts (checks/
// tenant-single-writer.ts). `auth` is the one port these functions accept — the caller
// identity `parseCaller(requestHeaders())` resolves for the tools above is passed in here
// instead, so a fixture can supply a fixed one. A clock and export ports are deliberately NOT
// threaded through: `mutate()` derives `at` internally and never accepts a `CommitExports`
// (`record.ts`'s own optional projectToDatabase/exportToGit), and both are I-8's file, outside
// this task's edit surface — wiring either here would mean editing mutations.ts.

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
 *  first narrowing the discriminated union — exactly what a JSON reply to an MCP client (or a
 *  check exercising this adapter layer with no type guard of its own) needs. Every field the
 *  spec's structured mutation metadata names is present on the type; a field that does not
 *  apply to this particular outcome's `committed` value is simply absent, never a fabricated
 *  default standing in for it. */
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

/** `document_write`'s eventual kernel entry point for a NEW document. `causeRefs` must
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

/** `document_approve`'s eventual kernel entry point. Binds to the revision AND record digest
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
      // NOT A TOOL: the kernel's own MutationOp value — the MCP tool this adapter will
      // eventually stand behind is document_approve.
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

/** `document_read`/`document_present`'s eventual kernel entry point for a pinned artifact_id:
 *  the materialized body `record.ts` already wrote to `documents/<artifact_id>.md` on the last
 *  committed create/revise. Revision, content_hash, record_digest and etag are NOT derivable
 *  here without `mutations.ts`'s owner-state replay (`readOwnerState`, unexported and outside
 *  this task's edit surface) — a caller that needs those already holds them on the
 *  `MutationResult` a create/revise/approve just returned; this only re-reads the bytes. */
export function readDocumentBody(root: string, artifactId: string): { readonly body: string } | null {
  const target = join(root, "documents", `${artifactId}.md`);
  if (!existsSync(target)) return null;
  return { body: readFileSync(target, "utf8") };
}
