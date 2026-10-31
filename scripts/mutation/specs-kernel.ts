/**
 * Defects planted in `@zz/contracts` — the kernel the behavioural checks call into.
 *
 * These reach the check through the build. `@zz/contracts` resolves to `dist/index.js`, so a check
 * importing it reads compiled output, not the source mutated here, and the gate's first check runs
 * `npm run -s build` before anything imports it.
 *
 * DELIBERATE: every mutation below is type-valid by construction. `tsc -b` does not emit for a
 * project with type errors, so a mutation that broke the types would leave the previous `dist` in
 * place and the row would record "survived" for a defect that never reached the check. Each row
 * carries whether the build failed.
 */
import type { MutationSpec } from "./plant.ts";

const NCP_MEMBERSHIP =
  "every negative-control probe on the contracts door is run by this file";

/** The registered contracts-door check both rows below are aimed at. It makes four independent
 *  claims — a wildcard it refuses, a ratchet forward and two directions of a ratchet backward,
 *  the last two in `unexercisable.ts` — and a mutation to any one says nothing about the others. */
const DOOR = "a name on the contracts door has an importer";

/** The one registered check both host-chain rows are aimed at; they differ by `assertion`. */
const TRIAL_CHAIN =
  "a registered procedure's chain is enforced all the way back, and still grants when it is met";

export const KERNEL_SPECS: readonly MutationSpec[] = [
  {
    check: "scripts/gate/checks/assessment-port.ts",
    target: "the assessment port never invents a probability or an answer",
    subject: "packages/contracts/src/assessment.ts",
    find: 'return record(env, "unavailable", null, NO_SIGNALS, why);',
    replace: 'return record(env, "invalid_response", null, NO_SIGNALS, why);',
    planted: "a transport timeout is recorded as a malformed reply, so a call that never " +
      "arrived becomes indistinguishable from an assessor that answered badly",
  },
  {
    check: "scripts/gate/checks/close-truthfulness.ts",
    target: "a close says only what is known",
    subject: "packages/contracts/src/close.ts",
    // Written as a negation rather than by naming the two outcome words: @zz/contracts owns that
    // vocabulary, and a second spelling of it is what "the envelope vocabulary is defined once"
    // refuses.
    find: '    return (named(basis.accepted_by) ? "accepted"',
    replace: '    return (!named(basis.accepted_by) ? "accepted"',
    planted: "a close with no sign-off is derived as accepted and one with an acceptor as " +
      "merely delivered, so the record states an acceptance nobody gave",
  },
  {
    check: "scripts/gate/checks/generic-host-genericity.ts",
    target: "the generic host serves a second flow and the kernel never branches on an SDLC stage",
    subject: "packages/contracts/src/host.ts",
    find: "    invoked: [...host.trace],",
    replace: "    invoked: [],",
    planted: "the second-flow fixture reports no operations at all, so it demonstrates " +
      "nothing about the host being generic",
  },
  {
    check: "scripts/gate/checks/negative-control-probes.ts",
    target: NCP_MEMBERSHIP,
    assertion: "every probe published on the door is actually run by the file that vouches for them",
    subject: "packages/contracts/src/control-loop.ts",
    find: "export { closeProbe, type CloseProbeRow }",
    replace: "export { closeProbe, closeProbe as spareProbe, type CloseProbeRow }",
    planted: "a probe name reaches the door that the file vouching for the probes never runs — a " +
      "probe nothing runs proves nothing, and the door would say otherwise",
  },
  {
    check: "scripts/gate/checks/negative-control-probes.ts",
    target: "the close negative control fires on every planted fault",
    assertion: "the close probe's own rows report that each planted fault was detected",
    subject: "packages/contracts/src/close-probe.ts",
    find: "  fires: healthy[0] && faulted[0],",
    replace: "  fires: healthy[0] && !faulted[0],",
    planted: "the close negative control reports that no detector fired on the faults it " +
      "planted, so the control that proves the detector works has stopped proving it",
  },
  {
    check: "scripts/gate/checks/search-predicate-parameters.ts",
    target: "every parameter the search predicate binds is one its SQL references",
    assertion: "the numbers the statement references are exactly 1..args.length",
    subject: "services/zz-core/src/tools/search-predicate.ts",
    find: '  if (a.type) cond.push(`type = ${put(a.type)}`);',
    replace: '  if (a.type) { put(a.type); cond.push(`type = ${put(a.type)}`); }',
    planted: "a parameter is bound as a side effect and then never referenced, so the statement " +
      "numbers $1 and $3 while binding three — PostgreSQL refuses to parse it and the query " +
      "answers nothing to anybody",
  },
  {
    check: "scripts/gate/checks/stopped-close-exemption.ts",
    target: "a stopped close is not refused over gates nobody passed, and a finished one still is",
    assertion: "an abandoned close is NOT refused over a gate nobody recorded",
    subject: "packages/contracts/src/close.ts",
    find: 'if (gatePosture === "unrecorded" && disposition === "finished") {',
    replace: 'if (gatePosture === "unrecorded") {',
    planted: "the refusal loses its scoping, so stopped work — which is precisely work whose gates " +
      "were not passed — can only be closed by forging an approval or left open forever",
  },
  {
    check: "scripts/gate/checks/stopped-close-exemption.ts",
    target: "a stopped close is not refused over gates nobody passed, and a finished one still is",
    assertion: "the observation survives the exemption — an abandoned close still REPORTS the posture it was told",
    subject: "packages/contracts/src/close.ts",
    find: "    stages: ok ? deriveStages(stages, reachedStage) : NO_STAGES,\n    gatePosture,",
    replace: '    stages: ok ? deriveStages(stages, reachedStage) : NO_STAGES,\n    gatePosture: "unstated",',
    planted: "the record drops what the caller said about the gates, so the observation is " +
      "collapsed into the rule and a later reader is told less than the record knew",
  },
  {
    check: "scripts/gate/checks/stopped-close-exemption.ts",
    target: "a stopped close is not refused over gates nobody passed, and a finished one still is",
    assertion: "the rule still holds where it was not exempted — a FINISHED close is still refused",
    subject: "packages/contracts/src/close.ts",
    find: 'if (gatePosture === "unrecorded" && disposition === "finished") {',
    replace: 'if (gatePosture === "recorded" && disposition === "finished") {',
    planted: "the exemption swallows the rule it was carved out of, so a finished close is " +
      "permitted with a declared gate left unrecorded",
  },
  {
    check: "scripts/gate/checks/contracts-door.ts",
    target: DOOR,
    assertion: "a wildcard re-export is refused, because it publishes names nothing can enumerate",
    subject: "packages/contracts/src/control-loop.ts",
    find: "export {\n  createHost,",
    replace: 'export * from "./recall.js";\n\nexport {\n  createHost,',
    planted: "the door gains a wildcard, so a module's whole surface is published without " +
      "naming any of it — every name it adds is invisible to the reader and to this check",
  },
  {
    check: "scripts/gate/checks/contracts-door.ts",
    target: DOOR,
    assertion: "the ratchet forward — a NEW value name on the door with no importer fails",
    subject: "packages/contracts/src/control-loop.ts",
    find: "  createHost,\n  moduleDigest,",
    replace: "  createHost,\n  createHost as hostFactory,\n  moduleDigest,",
    planted: "a value name reaches the door that nothing imports and the residue does not " +
      "list, which is the growth the bound exists to stop",
  },
  {
    // Half one, and it fires alone. With the chain not consulted at all, an empty run is still
    // refused — the last step's own rules are unmet — but the refusal names only that step, so the
    // clause watching for an earlier step's id is what catches it. A complete run still grants, so
    // half two cannot answer for this.
    check: "scripts/gate/checks/host-chain.ts",
    target: TRIAL_CHAIN,
    assertion: "an action is refused on an empty run AND the refusal names a step behind the one claimed",
    subject: "packages/contracts/src/host.ts",
    find: "    for (const before of step.after) {",
    replace: "    for (const before of step.after.slice(0, 0)) {",
    planted: "the chain is not consulted at all, so every step is judged alone — the refusal a " +
      "caller receives names only the step they claimed and says nothing about the six behind " +
      "it that are still outstanding",
  },
  {
    // Half two, and it fires alone too. Any step that declares predecessors becomes permanently
    // unsatisfiable, so a run driven to genuine completion is still refused, while the empty run is
    // refused as before with a refusal naming an earlier step — so half one passes. A host that
    // refuses everything passes a check watching only the refusal.
    check: "scripts/gate/checks/host-chain.ts",
    target: TRIAL_CHAIN,
    assertion: "the same action is GRANTED on a run driven to genuine completion, and the evaluation agrees",
    subject: "packages/contracts/src/host.ts",
    find: "    return { satisfied: distinct.length === 0, unmet: distinct };",
    replace: "    return { satisfied: distinct.length === 0 && step.after.length === 0, unmet: distinct };",
    planted: "a step that declares any predecessor can never be satisfied, so the control loop " +
      "refuses a procedure whose every step has been completed on its own terms — a wall " +
      "rather than a control, and nobody can finish a run",
  },
  {
    check: "scripts/gate/checks/jev-adapter.ts",
    target: "the first provider adapter validates identity, ranges and retry classification",
    subject: "packages/contracts/src/adapters/jev-retry.ts",
    find: "export const retryable = (status: number | null): boolean => RETRYABLE.includes(classify(status));",
    replace: "export const retryable = (status: number | null): boolean => status !== null;",
    planted: "every answered status is classified as retryable, so a refusal the provider " +
      "will repeat forever is retried instead of surfaced",
  },
  {
    check: "scripts/gate/checks/plan-validator.ts",
    target: "the plan validator refuses a duplicate task id, a dependency cycle and a task with no Output",
    subject: "packages/contracts/src/plan-validation.ts",
    find: "    const firstAt = claimedAt.get(id);\n    if (firstAt !== undefined) {",
    replace: "    const firstAt = claimedAt.get(id);\n    if (firstAt !== undefined && line < 0) {",
    planted: "a second task claiming an id already taken is no longer reported, so two tasks " +
      "share one identity in every wave the plan is executed in",
  },
  {
    check: "scripts/gate/checks/recall-result-contract.ts",
    target: "recall separates an inconclusive search from a scoped no-match",
    subject: "packages/contracts/src/recall.ts",
    find: '      result: "retrieval_inconclusive",',
    replace: '      result: "no_relevant_match_in_searched_scope",',
    planted: "a search that could not answer reports a clean scoped no-match, which is the " +
      "one reading that must never be produced from a blocked search",
  },
];
