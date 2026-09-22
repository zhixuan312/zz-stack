/**
 * Which step of a run a document or a source is evidence for — read from the flow's own
 * manifest, never from a list in this file.
 *
 * THE MAPPING ALREADY EXISTS AND IS ALREADY DECLARED. `catalog/sdlc/sdlc-flow/flow.json`
 * says, stage by stage, what each one produces:
 *
 *     sdlc-explore     produces explore.md
 *     sdlc-spec        produces spec.md
 *     sdlc-spec-audit  produces source, supports spec.md
 *     sdlc-plan        produces plan.md
 *     sdlc-plan-audit  produces source, supports plan.md
 *     sdlc-execute     produces nothing
 *     sdlc-review      produces review.md
 *
 * and the reviewed module's step ids are those same seven names. So a hardcoded table here
 * would be a second declaration of a thing already declared once — the shape this platform
 * spent an initiative removing. When a flow adds a stage, this follows without an edit;
 * when a flow renames one, this stops matching and the run stops being credited, which is
 * visible, rather than silently crediting the wrong step.
 *
 * NULL IS THE ORDINARY ANSWER. Most writes are not evidence for anything: a source on a
 * freeform initiative, a document on a flow with no reviewed module, a stage that produces
 * "nothing". Returning null rather than guessing is what keeps "this was not evidence" from
 * being recorded as "this was evidence for the step I assumed".
 *
 * STAGES ARRIVE FROM THE CALLER, already parsed, which is why this file imports nothing.
 * Every caller in the service holds a `Chain`, and a chain carries the flow's stages — so
 * re-reading the manifest here would be a second read of a file already read, and two
 * readings of one declaration are two chances to disagree about it.
 */

/** A stage as the manifest declares it, narrowed to the two fields this file asks about. */
export interface DeclaredStage {
  readonly name?: string;
  readonly produces?: string;
  readonly supports?: string;
}

/**
 * The step a document is evidence for, by the name the flow declares it under.
 *
 * MATCHED ON THE DECLARED NAME, NOT A PATH. Callers hold a repo-relative path like
 * `2026-09-20-x/spec.md`; the manifest declares `spec.md`. Taking the last segment is the
 * whole translation, and doing it here rather than at each call site keeps four callers from
 * disagreeing about it.
 */
export function stepForDocument(
  stages: readonly DeclaredStage[], path: string,
): string | null {
  const name = path.split("/").pop() ?? path;
  return stages.find((s) => s.produces === name)?.name ?? null;
}

/**
 * The step a SOURCE is evidence for: the stage that produces a source supporting that
 * document.
 *
 * THIS IS HOW AN AUDIT IS EVIDENCED, and it is why the module asks those two steps for
 * `1x audit` rather than `1x document`. An audit round does not write a document of its own
 * in the flow's declaration — it produces a source that supports the document it audited. A
 * platform that looked for a document here would find none and would report every audited
 * initiative as un-audited.
 */
export function stepForSource(
  stages: readonly DeclaredStage[], supports: string | null,
): string | null {
  if (!supports) return null;
  const name = supports.split("/").pop() ?? supports;
  return stages.find((s) => s.produces === "source" && s.supports === name)?.name ?? null;
}
