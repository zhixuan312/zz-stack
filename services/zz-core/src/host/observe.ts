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
 *
 * A failure here is visible later, not silent. If the database is unreachable the evidence is not
 * recorded, and the loop says the step's requirement is unmet — a missing fact reads as missing
 * rather than as satisfied.
 */
import type { Chain } from "../write-guards.js";

import { stepForDocument, stepForSource, type DeclaredStage } from "./enrolment.js";
import { moduleForFlow } from "./index.js";
import { openRun, recordEvidence, runFor } from "./store.js";

/** What kind of fact this is, in the vocabulary the reviewed module's steps accept.
 *
 *  `document` and `approval` are the two a stage producing an artifact asks for; `audit` is what
 *  a stage producing a source asks for. They are the module's words, not this file's. */
export type Fact = "document" | "approval" | "audit";

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
 * The withdrawn id is derived, not looked up: `document_approve` records `approval:<relPath>` and
 * this withdraws that same id. Deterministic, so a replay rebuilds the same graph, and it costs
 * nothing when the document was never approved — a withdrawal of nothing.
 */
export async function noteRevision(
  chain: Chain, relPath: string, version: number, by: string, team: string | null,
): Promise<void> {
  const step = stepForDocument(chain.stages as readonly DeclaredStage[], relPath);
  if (!step) return;
  await note(chain, relPath, "document", by, team, step, null,
             { id: `doc:${relPath}@v${version}`, supersedes: `approval:${relPath}` });
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
  /** A revision's own id and the approval it withdraws — see `noteRevision`. Absent for every
   *  other fact, which neither renames itself nor withdraws anything. */
  revision?: { id: string; supersedes: string },
): Promise<void> {
  if (!step || !team) return;
  const initiative = initiativeOf(relPath);
  if (!initiative) return;
  const governed = moduleForFlow(await packaged(), chain.name);
  if (!governed) return;

  // The run is opened if it is not there: an initiative with no run gets one at its first
  // write.
  // `openRun` is idempotent on (team, initiative), so this cannot produce a second run.
  const existing = await runFor(team, initiative);
  const runId = existing?.id ?? await openRun({
    team, initiative, module: governed.module, digest: governed.digest,
    subject: initiative, profile: [], by,
  });
  if (!runId) return;

  // The back-reference is the whole thing, and getting it wrong makes every gated step
  // permanently unmeetable in a way nothing reports.
  //
  // A completion rule carrying `about` is satisfied only by an entry whose `about` is the id of
  // another entry of the named kind — `met()` reads
  // `evidence.some(p => p.kind === rule.about && p.id === e.about)`. An approval recorded `about` a filename satisfies nothing, because no entry
  // has that filename as its id.
  //
  // So the id is derived from the document alone — not from the step, not from the fact — and an
  // approval or an audit points at it. Deterministic, so a replay rebuilds the same graph, and
  // stable across the two tools that record the two halves.
  //
  // The pointer is an initiative-relative path, because that is what the document entry's id was
  // built from. A `supports` value is the flow's own vocabulary — a bare `spec.md` — while a
  // document is recorded under `<initiative>/spec.md`, and `doc:spec.md` is a reference to
  // nothing.
  const supported = aboutDocument
    ? (aboutDocument.includes("/") ? aboutDocument : `${initiative}/${aboutDocument}`)
    : relPath;
  const documentEntry = `doc:${supported}`;
  await recordEvidence(runId, step, {
    id: revision ? revision.id : (fact === "document" ? documentEntry : `${fact}:${relPath}`),
    stepId: step, kind: fact,
    about: fact === "document" ? relPath : documentEntry,
    note: revision
      ? "recorded by the platform when the document was revised; the approval it carried no longer stands"
      : `recorded by the platform when ${fact} landed`,
    supersedes: revision?.supersedes,
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
