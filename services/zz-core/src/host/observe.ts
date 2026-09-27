/**
 * What the platform tells the control loop when something actually happens.
 *
 * One place, because there are four callers: `document_write`, `document_revise`,
 * `document_approve` and `source_add` each complete a step for some flow. Four copies of "work
 * out the initiative, find the module, find the step, record it" would disagree invisibly — each
 * caller would go on succeeding, and the run would be judged on a different set of facts
 * depending on which door the work came through.
 *
 * DELIBERATE: it records, it never refuses. Nothing here can stop a write the document guards
 * already allowed; a refusal, when one is owed, happens at the one place an action is claimed.
 * What it does do is decline to record the same fact twice, which stops no write and is not a
 * refusal of one: an id the run already holds is a fact the log already answers for, and writing
 * it again would be the database's unique key refusing the second copy of a fact rather than the
 * log growing by one.
 *
 * A failure here is visible later, not silent. If the database is unreachable the evidence is not
 * recorded, and the loop says the step's requirement is unmet — a missing fact reads as missing
 * rather than as satisfied.
 */
import { existsSync, readFileSync } from "node:fs";

import { parseEnvelope } from "@zz/contracts";

import { safePath } from "../paths.js";
import type { Chain } from "../write-guards.js";

import { stepForDocument, stepForSource, type DeclaredStage } from "./enrolment.js";
import { moduleForFlow } from "./index.js";
import { openRun, recordEvidence, recordedIds, runFor } from "./store.js";

/** What kind of fact this is, in the vocabulary the reviewed module's steps accept.
 *
 *  `document` and `approval` are the two a stage producing an artifact asks for; `audit` is what
 *  a stage producing a source asks for. They are the module's words, not this file's. */
export type Fact = "document" | "approval" | "audit";

/** One fact as the log identifies it: what it is about, and — for the two a document carries a
 *  version of — which version of it.
 *
 *  `path` is the initiative-relative path the entry is about: the document itself for a write, an
 *  approval or a revision, and the source file for an audit. Local rather than exported: the shape
 *  is `evidenceEntryId`'s parameter and nothing else names it, and this repository's gate refuses
 *  an export no other file imports. */
type EvidenceFact =
  | { readonly kind: "document"; readonly path: string; readonly version: number }
  | { readonly kind: "approval"; readonly path: string; readonly version: number }
  | { readonly kind: "audit"; readonly path: string };

/**
 * The id one fact is recorded under, derived from the fact alone.
 *
 * This is the whole of the fix for a withdrawn approval that never came back, and it is an
 * interface rather than an implementation detail because it is what makes the fix assertable:
 * `checks/control-evidence-identity.ts` drives it with no database at all.
 *
 * A document is identified by its version, and so is an approval of it. The kernel tells a fact
 * that still stands from one that does not by the id it carries, so an id that stood for two
 * facts could not tell "the approval I replaced" from "the approval somebody gave afterwards":
 * a withdrawal of that document's approval would reach the wrong one — and, with the run's ids
 * unique by constraint, the later approval could not be recorded at all. Versioning the id gives
 * each of those its own fact: a revision withdraws the approval of the version it replaced, and a
 * re-approval after a revision is a different id that nothing reaches.
 *
 * An audit is identified by its own source path. It is not a fact about a version of the
 * document it rates — it is a round's findings recorded in a file of their own — so it carries no
 * version, and the document it audited is named by its `about`. */
export function evidenceEntryId(fact: EvidenceFact): string {
  switch (fact.kind) {
    case "document": return `doc:${fact.path}@v${fact.version}`;
    case "approval": return `approval:${fact.path}@v${fact.version}`;
    case "audit": return `audit:${fact.path}`;
  }
}

/**
 * The version a document is at, read from the document itself.
 *
 * The document is the authority on its own version: `document_revise` derives the next one as
 * `previous + 1` from this same field, so a version worked out anywhere else — by counting the
 * run's entries, say — would disagree with that writer the first time a document was written
 * twice without a revision between the two. One means the first version, which is what a document
 * nobody has revised carries: the field is written on revision and not before.
 */
async function documentVersion(relPath: string): Promise<number> {
  const target = await safePath(relPath);
  if (!existsSync(target)) return 1;
  const declared = parseInt(parseEnvelope(readFileSync(target, "utf8")).version ?? "", 10);
  return Number.isFinite(declared) && declared > 0 ? declared : 1;
}

/** The initiative an initiative-relative path belongs to. `2026-09-20-x/spec.md` -> the first
 *  segment. Getting it wrong records evidence against a run that belongs to different work. */
function initiativeOf(relPath: string): string | null {
  const first = relPath.split("/")[0];
  return first && first !== relPath ? first : null;
}

/**
 * Record that a document reached a state the flow's declaration recognises.
 *
 * Silent and harmless for everything the declaration does not recognise: a freeform
 * initiative, a flow with no reviewed module, a file the flow never declared, a stage that
 * produces "nothing". Each returns before touching the database, because "this was not
 * evidence" must not be recorded as "this was evidence for the step I assumed".
 */
export async function noteDocument(
  chain: Chain, relPath: string, fact: Fact, by: string, team: string | null,
): Promise<void> {
  const step = stepForDocument(chain.stages as readonly DeclaredStage[], relPath);
  if (!step) return;   // the flow does not declare this document — not evidence for anything
  await note(chain, relPath, fact, by, team, step);
}

/**
 * Record that a document was revised, which withdraws whatever approval it carried.
 *
 * A revision is a fact and so is the approval it replaces. `document_revise` files the signed
 * text in `_versions/`, bumps the version and returns a gated document to draft — the approval
 * really was given, so nothing deletes it, and it no longer stands, so nothing may count it. The
 * new entry says which earlier entry it withdraws and the log goes on only growing.
 *
 * Without this, a run whose spec had been revised back to draft goes on reporting that step met,
 * and the loop grants `close:initiative` where `documentGuards` refuses it.
 *
 * The withdrawn id is derived, not looked up: `document_approve` records `approval:<relPath>@v<n>`
 * for the version it approved, and this withdraws that id for the version before the one the
 * document just moved to. Deterministic, so a replay rebuilds the same graph, and it costs nothing
 * when the document was never approved — a withdrawal of nothing, which is the null this writes
 * rather than a reference to an entry no run holds.
 */
export async function noteRevision(
  chain: Chain, relPath: string, version: number, by: string, team: string | null,
): Promise<void> {
  const step = stepForDocument(chain.stages as readonly DeclaredStage[], relPath);
  if (!step) return;
  await note(chain, relPath, "document", by, team, step, null, { version });
}

/**
 * Record that a source supporting a document was added — which is how an audit evidences
 * itself, because the flow declares an audit stage as producing a source rather than a
 * document of its own.
 *
 * `supports` is the document the source stands behind. With none, this is a source about
 * nothing the declaration names, and nothing is recorded.
 */
export async function noteSource(
  chain: Chain, relPath: string, supports: string | null, by: string, team: string | null,
): Promise<void> {
  const step = stepForSource(chain.stages as readonly DeclaredStage[], supports);
  if (!step) return;   // no stage produces a source supporting that document
  // An audit is about the document it audited — the document the source supports, not the source
  // file itself. The rule says `{kind: "audit", about: "document"}`, and the only document entry
  // in the run that answers it is the one for the audited document.
  await note(chain, relPath, "audit", by, team, step, supports);
}

async function note(
  chain: Chain, relPath: string, fact: Fact, by: string, team: string | null,
  step: string | null, aboutDocument?: string | null,
  /** A revision's own fact: the version the document moved TO. Its entry is that version's
   *  document entry, and what it withdraws is the approval of the version before it. Absent for
   *  every other fact, which neither renames itself nor withdraws anything — see `noteRevision`. */
  revision?: { version: number },
): Promise<void> {
  if (!step || !team) return;
  const initiative = initiativeOf(relPath);
  if (!initiative) return;
  const governed = moduleForFlow(await packaged(), chain.name);
  if (!governed) return;

  // The run is opened if it is not there: an initiative with no run gets one at its first write.
  // `openRun` is idempotent on the initiative, so this cannot produce a second run.
  const existing = await runFor(team, initiative);
  const runId = existing?.id ?? await openRun({
    team, initiative, digest: governed.digest, by,
  });
  if (!runId) return;

  // The back-reference is the whole thing, and getting it wrong makes every gated step
  // permanently unmeetable in a way nothing reports.
  //
  // A completion rule carrying `about` is satisfied only by an entry whose `about` is the id of
  // another entry of the named kind — `met()` reads
  // `evidence.some(p => p.kind === rule.about && p.id === e.about)`. An approval recorded `about`
  // a filename satisfies nothing, because no entry has that filename as its id.
  //
  // So an approval and an audit point at the document entry of the version they are about, and
  // that version is the one the document is at. Which is why it is read from the document rather
  // than from the run: the run's newest entry for a path and the document's own version are the
  // same thing only while every write records a version, and the document is the authority
  // `document_revise` already derives its arithmetic from.
  //
  // The pointer is an initiative-relative path, because that is what the document entry's id was
  // built from. A `supports` value is the flow's own vocabulary — a bare `spec.md` — while a
  // document is recorded under `<initiative>/spec.md`, and `doc:spec.md@v1` is a reference to
  // nothing.
  const supported = aboutDocument
    ? (aboutDocument.includes("/") ? aboutDocument : `${initiative}/${aboutDocument}`)
    : relPath;
  const version = revision ? revision.version : await documentVersion(supported);
  const documentEntry = evidenceEntryId({ kind: "document", path: supported, version });
  const id = revision ? documentEntry
    : fact === "document" ? evidenceEntryId({ kind: "document", path: relPath, version })
      : fact === "approval" ? evidenceEntryId({ kind: "approval", path: relPath, version })
        : evidenceEntryId({ kind: "audit", path: relPath });

  const held = await recordedIds(runId);
  // A fact the run already holds is not written a second time. The id IS the fact: a document
  // written twice at one version, or approved twice with no revision between the two, is one fact
  // arriving again, and the log already answers for it. Refused here rather than by the unique key,
  // which is the backstop for a bug and not the mechanism — a writer that reached it would turn a
  // fact already recorded into a failed tool call for whoever asked.
  if (held.has(id)) return;

  // A revision withdraws the approval it replaced and nothing else: the approval of the version
  // the document was at before it, which is the version immediately below the one it moved to.
  // Checked against the run rather than written blind, because the log refuses a withdrawal that
  // names no entry of its own run — and a document never approved at that version has no approval
  // to withdraw, which is the null the row carries.
  const replaced = revision
    ? evidenceEntryId({ kind: "approval", path: relPath, version: version - 1 })
    : null;

  await recordEvidence(runId, step, {
    id, stepId: step, kind: fact,
    about: fact === "document" ? relPath : documentEntry,
    // The kernel's type requires it and the column that held it is gone; nothing reads it.
    note: "",
    supersedes: replaced && held.has(replaced) ? replaced : undefined,
  }, by);
}

/** The registered catalogue, imported lazily.
 *
 *  `reviewed-modules.ts` is data rather than behaviour, and importing it at the top of this file
 *  would put it in the module graph of every tool that records evidence. It is read once per call
 *  on a path that already touches the database. */
async function packaged(): Promise<Awaited<ReturnType<typeof load>>> { return load(); }
async function load() {
  const m = await import("../reviewed-modules.js");
  return m.packagedModules;
}
