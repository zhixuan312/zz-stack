/**
 * What the platform tells the control loop when something actually happens.
 *
 * ONE PLACE, BECAUSE THERE ARE FOUR CALLERS. `document_write`, `document_revise`,
 * `document_approve` and `source_add` each complete a step for some flow, and four copies of
 * "work out the initiative, find the module, find the step, record it" would be four chances
 * to disagree about what counts as evidence. The disagreement would not be visible: each
 * caller would go on succeeding, and the run would simply be judged on a different set of
 * facts depending on which door the work came through.
 *
 * IT RECORDS, IT NEVER REFUSES. Nothing here can stop a write that the document guards
 * already allowed. The loop's job is to answer questions about a run, not to become a second
 * veto beside `documentGuards` — that duplication is the thing this adoption removes. A
 * refusal, when one is owed, happens at the one place an action is claimed.
 *
 * A FAILURE HERE IS VISIBLE LATER, NOT SILENT. If the database is unreachable the evidence is
 * not recorded, and the loop will say the step's requirement is unmet — which is true of what
 * it was told. That is the right failure direction: a missing fact reads as missing rather
 * than as satisfied, and the sentence a person gets back names exactly what to record.
 */
import type { Chain } from "../write-guards.js";

import { stepForDocument, stepForSource, type DeclaredStage } from "./enrolment.js";
import { moduleForFlow } from "./index.js";
import { openRun, recordEvidence, runFor } from "./store.js";

/** What kind of fact this is, in the vocabulary the reviewed module's steps accept.
 *
 *  `document` and `approval` are the two a stage producing an artifact asks for; `audit` is
 *  what a stage producing a SOURCE asks for. They are the module's words, not this file's. */
export type Fact = "document" | "approval" | "audit";

/** The initiative an initiative-relative path belongs to. `2026-09-20-x/spec.md` -> the first
 *  segment. Written once here because getting it wrong records evidence against a run that
 *  belongs to a different piece of work. */
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
 * Record that a source supporting a document was added — which is how an AUDIT evidences
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
  await note(chain, relPath, "audit", by, team, step);
}

async function note(
  chain: Chain, relPath: string, fact: Fact, by: string, team: string | null,
  step: string | null,
): Promise<void> {
  if (!step || !team) return;
  const initiative = initiativeOf(relPath);
  if (!initiative) return;
  const governed = moduleForFlow(await packaged(), chain.name);
  if (!governed) return;

  // THE RUN IS OPENED IF IT IS NOT THERE. An initiative opened before this platform started
  // telling the loop anything has no run, and its first write is the moment to give it one —
  // otherwise the evidence has nowhere to go and the initiative stays permanently unjudgeable
  // through no fault of the person doing the work. `openRun` is idempotent on
  // (team, initiative), so this cannot produce a second run for one initiative.
  const existing = await runFor(team, initiative);
  const runId = existing?.id ?? await openRun({
    team, initiative, module: governed.module, digest: governed.digest,
    subject: initiative, profile: [], by,
  });
  if (!runId) return;

  await recordEvidence(runId, step, {
    id: `${step}/${fact}/${relPath}`, stepId: step, kind: fact,
    about: relPath, note: `recorded by the platform when ${fact} landed`,
  }, by);
}

/** The registered catalogue, imported lazily.
 *
 *  `reviewed-modules.ts` is data rather than behaviour, and importing it at the top of this
 *  file would put it in the module graph of every tool that records evidence. It is read once
 *  per call on a path that already touches the database, so the cost is nothing beside what
 *  it buys: this file stays importable by anything without dragging the whole allowlist in. */
async function packaged(): Promise<Awaited<ReturnType<typeof load>>> { return load(); }
async function load() {
  const m = await import("../reviewed-modules.js");
  return m.packagedModules;
}
