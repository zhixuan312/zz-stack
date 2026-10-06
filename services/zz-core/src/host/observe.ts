/**
 * What the platform tells the control loop when something actually happens.
 *
 * One place, because every act that completes a step for some flow — a document written or
 * changed, an approval, a source added — reports here. Several copies of "work
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
import { loadDocument } from "../versions.js";
import type { Chain } from "../write-guards.js";

import { stepForDocument, stepForSource, type DeclaredStage } from "./enrolment.js";
import { moduleForFlow } from "./index.js";
import { openRun, recordEvidence, recordedIds, runFor } from "./store.js";

/** What kind of fact this is, in the vocabulary the reviewed module's steps accept.
 *
 *  `document` and `approval` are the two a stage producing an artifact asks for; `audit` is what
 *  a stage producing a source asks for. They are the module's words, not this file's. */
export type Fact = "document" | "approval" | "audit";

/** Which snapshot of a document a fact is about: its public version, and the stored row within
 *  it. Several rows can share one public version — a change with no new cause lands on a row
 *  somebody was shown or signed as a new row of the same version — so the version alone does not
 *  name the bytes an approval signed. Local, like `EvidenceFact`: callers pass the literal. */
interface Snapshot { readonly version: number; readonly revision: number }

/** One fact as the log identifies it: what it is about, and — for the two a document carries a
 *  snapshot of — which snapshot.
 *
 *  `path` is the initiative-relative path the entry is about: the document itself for a write, an
 *  approval or a revision, and the source file for an audit. Local rather than exported: the shape
 *  is `evidenceEntryId`'s parameter and nothing else names it, and this repository's gate refuses
 *  an export no other file imports. */
type EvidenceFact =
  | { readonly kind: "document"; readonly path: string; readonly at: Snapshot }
  | { readonly kind: "approval"; readonly path: string; readonly at: Snapshot }
  | { readonly kind: "audit"; readonly path: string };

/**
 * The id one fact is recorded under, derived from the fact alone.
 *
 * This is the whole of the fix for a withdrawn approval that never came back, and it is an
 * interface rather than an implementation detail because it is what makes the fix assertable:
 * `checks/control-evidence-identity.ts` drives it with no database at all.
 *
 * A document is identified by its snapshot — public version and stored row, `@v<version>.<revision>`
 * — and so is an approval of it. The kernel tells a fact that still stands from one that does not
 * by the id it carries, so an id that stood for two facts could not tell "the approval I replaced"
 * from "the approval somebody gave afterwards": a withdrawal of that document's approval would
 * reach the wrong one — and, with the run's ids unique by constraint, the later approval could not
 * be recorded at all. The version alone is not enough: a metadata-only correction of an approved
 * document is a new row of the SAME version, approved again later, and the two approvals must be
 * two facts. Naming the snapshot gives each its own: a change withdraws the approval of the
 * snapshot it displaced, and a re-approval after it is a different id that nothing reaches.
 *
 * An audit is identified by its own source path. It is not a fact about a version of the
 * document it rates — it is a round's findings recorded in a file of their own — so it carries no
 * version, and the document it audited is named by its `about`. */
export function evidenceEntryId(fact: EvidenceFact): string {
  switch (fact.kind) {
    case "document": return `doc:${fact.path}@v${fact.at.version}.${fact.at.revision}`;
    case "approval": return `approval:${fact.path}@v${fact.at.version}.${fact.at.revision}`;
    case "audit": return `audit:${fact.path}`;
  }
}

/**
 * The snapshot a document is at now, read from the document's own row — what an audit of it is
 * about. Only an audit asks: a write and an approval are told their snapshot by the act that made
 * it, which is the one place that knows it without a second read racing the next write.
 *
 * Read from the ROW (`versions.ts`), never from a file: a `readFileSync` of the retired store
 * answered 1 for every document, so an audit of a revised document pointed at its first version.
 * A document that cannot be read answers the first snapshot, whose entry a run that recorded
 * nothing else does not hold either — the audit then satisfies nothing, which is the truth.
 */
async function currentSnapshot(team: string, relPath: string): Promise<Snapshot> {
  const loaded = await loadDocument(team, relPath);
  return loaded.ok ? { version: loaded.rev.version, revision: loaded.rev.revision }
    : { version: 1, revision: 1 };
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
  chain: Chain, relPath: string, fact: Fact, at: Snapshot, by: string, team: string | null,
): Promise<void> {
  const step = stepForDocument(chain.stages as readonly DeclaredStage[], relPath);
  if (!step) return;   // the flow does not declare this document — not evidence for anything
  await note(chain, relPath, fact, by, team, step, at);
}

/**
 * Record that a change displaced an approved snapshot, which withdraws that approval.
 *
 * A change is a fact and so is the approval it displaces. A new version, or a same-version draft
 * of an approved document, files a new `doc_revision` row and returns a gated document to draft —
 * the approval really was given, so nothing deletes it, and it no longer stands, so nothing may
 * count it. The new entry says which earlier entry it withdraws and the log goes on only growing.
 *
 * Without this, a run whose spec had been changed back to draft goes on reporting that step met,
 * and the loop grants `close:initiative` where `documentGuards` refuses it.
 *
 * `at` is the snapshot the write produced; `replaced` is the approved snapshot it displaced — the
 * row `doc.approved_revision` named while it was the current row — or null when the write
 * displaced no approval. The withdrawn id is exactly `replaced`'s approval: named by the act that
 * knows it, not derived by arithmetic on versions, so a same-version draft withdraws the approval
 * it displaced and a later approval of the same version is never reached. A `replaced` the run
 * never recorded an approval of is a withdrawal of nothing, which is the null the row carries.
 */
export async function noteRevision(
  chain: Chain, relPath: string, at: Snapshot, replaced: Snapshot | null, by: string, team: string | null,
): Promise<void> {
  const step = stepForDocument(chain.stages as readonly DeclaredStage[], relPath);
  if (!step) return;
  await note(chain, relPath, "document", by, team, step, at, null, { replaced });
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
  await note(chain, relPath, "audit", by, team, step, null, supports);
}

async function note(
  chain: Chain, relPath: string, fact: Fact, by: string, team: string | null,
  step: string | null,
  /** The snapshot a write or an approval is about, as the act that made it says; null for an
   *  audit, whose document is read as it stands now. */
  at: Snapshot | null, aboutDocument?: string | null,
  /** A change that displaced an approval: which approved snapshot its entry withdraws. Absent for
   *  every other fact, which withdraws nothing — see `noteRevision`. */
  change?: { replaced: Snapshot | null },
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
  // So an approval and an audit point at the document entry of the snapshot they are about. An
  // approval is told it by the act that sealed it — the same snapshot the write recorded, since a
  // seal rewrites that row in place — and an audit reads it off the document rather than the run:
  // the run's newest entry for a path is the document's own snapshot only while every write
  // records one, and the row is the authority.
  //
  // The pointer is an initiative-relative path, because that is what the document entry's id was
  // built from. A `supports` value is the flow's own vocabulary — a bare `spec.md` — while a
  // document is recorded under `<initiative>/spec.md`, and `doc:spec.md@v1` is a reference to
  // nothing.
  const supported = aboutDocument
    ? (aboutDocument.includes("/") ? aboutDocument : `${initiative}/${aboutDocument}`)
    : relPath;
  const snapshot = at ?? await currentSnapshot(team, supported);
  const documentEntry = evidenceEntryId({ kind: "document", path: supported, at: snapshot });
  const id = fact === "document" ? documentEntry
    : fact === "approval" ? evidenceEntryId({ kind: "approval", path: relPath, at: snapshot })
      : evidenceEntryId({ kind: "audit", path: relPath });

  const held = await recordedIds(runId);
  // A fact the run already holds is not written a second time. The id IS the fact: a document
  // written twice at one version, or approved twice with no revision between the two, is one fact
  // arriving again, and the log already answers for it. Refused here rather than by the unique key,
  // which is the backstop for a bug and not the mechanism — a writer that reached it would turn a
  // fact already recorded into a failed tool call for whoever asked.
  if (held.has(id)) return;

  // A change withdraws the approval it displaced and nothing else: the approval of the snapshot
  // its act names. Checked against the run rather than written blind, because the log refuses a
  // withdrawal that names no entry of its own run — and a snapshot nobody approved has no approval
  // to withdraw, which is the null the row carries.
  const replaced = change?.replaced
    ? evidenceEntryId({ kind: "approval", path: relPath, at: change.replaced })
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
