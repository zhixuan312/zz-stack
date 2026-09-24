/**
 * Which step of a run a document or a source is evidence for — read from the flow's own
 * manifest, never from a list in this file.
 *
 * COUPLED: `catalog/sdlc/sdlc-flow/flow.json` already declares, stage by stage, what each
 * stage produces:
 *
 *     sdlc-explore     produces explore.md
 *     sdlc-spec        produces spec.md
 *     sdlc-spec-audit  produces source, supports spec.md
 *     sdlc-plan        produces plan.md
 *     sdlc-plan-audit  produces source, supports plan.md
 *     sdlc-execute     produces nothing
 *     sdlc-review      produces review.md
 *
 * and the reviewed module's step ids are those same seven names. When a flow adds a stage this
 * follows without an edit; when a flow renames one this stops matching and the run stops being
 * credited, which is visible rather than silently crediting the wrong step.
 *
 * Null is the ordinary answer. Most writes are not evidence for anything: a source on a
 * freeform initiative, a document on a flow with no reviewed module, a stage that produces
 * "nothing".
 *
 * Stages arrive from the caller, already parsed, which is why this file imports nothing. Every
 * caller in the service holds a `Chain`, and a chain carries the flow's stages.
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
 * Matched on the declared name, not a path: callers hold a repo-relative path like
 * `2026-09-20-x/spec.md` and the manifest declares `spec.md`. Taking the last segment here
 * rather than at each call site keeps four callers from disagreeing about it.
 */
export function stepForDocument(
  stages: readonly DeclaredStage[], path: string,
): string | null {
  const name = path.split("/").pop() ?? path;
  return stages.find((s) => s.produces === name)?.name ?? null;
}

/**
 * The step a source is evidence for: the stage that produces a source supporting that document.
 *
 * COUPLED: this is how an audit is evidenced, and why `services/zz-core/src/reviewed-modules.ts`
 * asks those two steps for `1x audit` rather than `1x document`. An audit round produces a
 * source supporting the document it audited rather than a document of its own, so looking for a document here would
 * report every audited initiative as un-audited.
 */
export function stepForSource(
  stages: readonly DeclaredStage[], supports: string | null,
): string | null {
  if (!supports) return null;
  const name = supports.split("/").pop() ?? supports;
  return stages.find((s) => s.produces === "source" && s.supports === name)?.name ?? null;
}
