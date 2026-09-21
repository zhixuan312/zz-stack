/**
 * Defects planted in `@zz/contracts` — the kernel the behavioural checks call into.
 *
 * THESE REACH THE CHECK THROUGH THE BUILD, AND THAT IS LOAD-BEARING. `@zz/contracts` resolves
 * to `dist/index.js`, so a check importing it reads compiled output, not the source mutated
 * here. The gate's first check runs `npm run -s build`, which recompiles the package before
 * anything imports it — which is also why every mutation below is TYPE-VALID by construction.
 * `tsc -b` does not emit for a project with type errors, so a mutation that broke the types
 * would leave the previous `dist` in place, the check would read the OLD behaviour, and the
 * row would record "survived" for a defect that never reached it. Each row carries whether
 * the build failed for exactly that reason.
 */
import type { MutationSpec } from "./plant.ts";

/** The one registered check the four contracts-door rows are aimed at, which makes four
 *  independent claims — a wildcard it refuses, a ratchet forward and two directions of a
 *  ratchet backward — and a mutation to any one of them says nothing about the other three. */
const NCP_MEMBERSHIP =
  "every negative-control probe on the contracts door is run by this file";

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
    check: "scripts/gate/checks/audit-identity.ts",
    target: "audit identity survives import and no assessment erases a finding",
    subject: "packages/contracts/src/audit-legacy-import.ts",
    find: "    target: SPEC_DOC, approval_version: 4, round: 1,",
    replace: "    target: PLAN_DOC, approval_version: 4, round: 1,",
    planted: "one legacy spec audit is imported as a plan audit, so the import no longer " +
      "accounts for three audits of each target",
  },
  {
    check: "scripts/gate/checks/central-binding.ts",
    target: "a default binding change reaches new runs only, and a rebind cannot inherit calibration",
    subject: "packages/contracts/src/bindings.ts",
    find: "    inheritedCalibration: inherited(state.calibration.filter((e) => e.in_force)),",
    replace: "    inheritedCalibration: true,",
    planted: "a rebind carries the old profile's calibration onto the new one by name",
  },
  {
    check: "scripts/gate/checks/close-truthfulness.ts",
    target: "a close says only what is known and a handover claims only what it verified",
    subject: "packages/contracts/src/close.ts",
    // Written as a negation rather than by naming the two outcome words, because
    // @zz/contracts owns that vocabulary and a second spelling of it anywhere in this
    // repository is what "the envelope vocabulary is defined once" exists to refuse.
    find: '  if (basis.disposition === "finished") return named(basis.accepted_by)',
    replace: '  if (basis.disposition === "finished") return !named(basis.accepted_by)',
    planted: "a close with no sign-off is derived as accepted and one with an acceptor as " +
      "merely delivered, so the record states an acceptance nobody gave",
  },
  {
    check: "scripts/gate/checks/commit-result-reconciliation.ts",
    target: "a canonical no-op is durable, and an unknown commit reconciles instead of replaying",
    subject: "packages/contracts/src/commit-reconciliation.ts",
    find: 'return { state: "applied", durable, followUp, nextRequest: null };',
    replace: 'return { state: "reconciling", durable, followUp, nextRequest: null };',
    planted: "a write the store confirmed is left in an unsettled state, so a durable result " +
      "is treated as one still needing to be chased",
  },
  {
    check: "scripts/gate/checks/dependency-invalidation.ts",
    target: "a grant invalidates when a dependency moves even though the target bytes do not",
    subject: "packages/contracts/src/dependency-snapshot.ts",
    find: '  return revalidate(snap, world).state === "valid";',
    replace: "  return snap !== undefined && world !== undefined;",
    planted: "a grant is reported valid whatever moved underneath it, which is the " +
      "record-local digest assumption this whole snapshot exists to replace",
  },
  {
    check: "scripts/gate/checks/gap-routing.ts",
    target: "every gap kind reaches its resolver and no stage deadlocks",
    subject: "packages/contracts/src/gap-routing.ts",
    find: '  if (kind === "verification") return "run-experiment";',
    replace: '  if (kind === "verification") return "deepen-analysis";',
    planted: "an untested claim is routed to more analysis instead of to the experiment that " +
      "would settle it — the deadlock this router exists to prevent",
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
    find: "export { auditIdentityProbe, type AuditIdentityProbeRow }",
    replace: "export { auditIdentityProbe, auditIdentityProbe as spareProbe, type AuditIdentityProbeRow }",
    planted: "a probe name reaches the door that the file vouching for the probes never runs — a " +
      "probe nothing runs proves nothing, and the door would say otherwise",
  },
  {
    check: "scripts/gate/checks/negative-control-probes.ts",
    target: "the audit-identity negative control fires on every planted fault",
    assertion: "the audit-identity probe's own rows report that each planted fault was detected",
    subject: "packages/contracts/src/audit-identity-probe.ts",
    find: "  fires: healthy[0] && faulted[0],",
    replace: "  fires: healthy[0] && !faulted[0],",
    planted: "the audit-identity negative control reports that no detector fired on the faults it " +
      "planted, so the control that proves the detector works has stopped proving it",
  },
  {
    check: "scripts/gate/checks/negative-control-probes.ts",
    target: "the gap-routing negative control fires on every planted fault",
    assertion: "the gap-routing probe's own rows report that each planted fault was detected",
    subject: "packages/contracts/src/gap-routing-probe.ts",
    find: "  fires: healthy[0] && faulted[0],",
    replace: "  fires: healthy[0] && !faulted[0],",
    planted: "the gap-routing negative control reports that no detector fired on the faults it " +
      "planted, so the control that proves the detector works has stopped proving it",
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
    check: "scripts/gate/checks/negative-control-probes.ts",
    target: "the stage-control negative control fires on every planted fault",
    assertion: "the stage-control probe's own rows report that each planted fault was detected",
    subject: "packages/contracts/src/stage-control-probe.ts",
    find: "  fires: healthy[0] && faulted[0],",
    replace: "  fires: healthy[0] && !faulted[0],",
    planted: "the stage-control negative control reports that no detector fired on the faults it " +
      "planted, so the control that proves the detector works has stopped proving it",
  },
  {
    check: "scripts/gate/checks/negative-control-probes.ts",
    target: "the recall-trial negative control fires on every planted fault",
    assertion: "the recall-trial probe's own rows report that each planted fault was detected",
    subject: "packages/contracts/src/recall-trial-probe.ts",
    find: "  fires: healthy[0] && faulted[0],",
    replace: "  fires: healthy[0] && !faulted[0],",
    planted: "the recall-trial negative control reports that no detector fired on the faults it " +
      "planted, so the control that proves the detector works has stopped proving it",
  },
  {
    check: "scripts/gate/checks/negative-control-probes.ts",
    target: "the profile-rebind negative control fires on every planted fault",
    assertion: "the rebind probe's rolled-up everyDetectorFires follows from its scenarios",
    subject: "packages/contracts/src/bindings.ts",
    find: "&& s.sameRef.calibrationRetired === 0 && s.rebadge.inheritedCalibration",
    replace: "&& s.sameRef.calibrationRetired === 0 && !s.rebadge.inheritedCalibration",
    planted: "the rebind probe rolls its nine scenarios up into a verdict that no longer follows " +
      "from them, so the one boolean a reader trusts stops describing what was measured",
  },
  {
    check: "scripts/gate/checks/negative-control-probes.ts",
    target: "the commit-boundary negative control shows each field can come back the bad way",
    assertion: "the commit-boundary probe still returns every variant the table names",
    subject: "packages/contracts/src/commit-boundary.ts",
    find: 'row("split_transaction", split,',
    replace: 'row("split_transactions", split,',
    planted: "the variant that shows `serialized` can come back false is renamed out of the table, " +
      "so the field it alone proves is not constant goes unexercised",
  },
  {
    check: "scripts/gate/checks/negative-control-probes.ts",
    target: "the dependency-snapshot negative control shows the coverage audit can refuse",
    assertion: "the dependency-snapshot probe still returns every arrangement the table names",
    subject: "packages/contracts/src/dependency-snapshot.ts",
    find: 'arrangement: "one dependency dropped from the closed set",',
    replace: 'arrangement: "one dependency dropped from the set",',
    planted: "the arrangement that shows the coverage audit can refuse a dropped dependency is " +
      "renamed, so the audit is no longer shown to be load-bearing",
  },
  {
    check: "scripts/gate/checks/negative-control-probes.ts",
    target: "the commit-reconciliation negative control shows each flag can come back the bad way",
    assertion: "the commit-reconciliation probe still returns every variant the table names",
    subject: "packages/contracts/src/commit-reconciliation.ts",
    find: 'row("no_op_mints_a_transaction_id", NO_OP, {},',
    replace: 'row("no_op_mints_a_transaction_ids", NO_OP, {},',
    planted: "the variant that shows a no-op can invent a transaction id is renamed out of the " +
      "table, so one of the four flags loses the fault that proves it independent",
  },
  {
    check: "scripts/gate/checks/search-predicate-parameters.ts",
    target: "every parameter the search predicate binds is one its SQL references",
    assertion: "the numbers the statement references are exactly 1..args.length",
    subject: "services/zz-core/src/tools/knowledge-search.ts",
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
    replace: 'export * from "./check-state.js";\n\nexport {\n  createHost,',
    planted: "the door gains a wildcard, so a module's whole surface is published without " +
      "naming any of it — every name it adds is invisible to the reader and to this check",
  },
  {
    check: "scripts/gate/checks/contracts-door.ts",
    target: DOOR,
    assertion: "the ratchet forward — a NEW value name on the door with no importer fails",
    subject: "packages/contracts/src/control-loop.ts",
    find: "  procedureSignature,\n  reusesGatedDocumentPipeline,",
    replace: "  procedureSignature,\n  createHost as hostFactory,\n  reusesGatedDocumentPipeline,",
    planted: "a value name reaches the door that nothing imports and the residue does not " +
      "list, which is the growth the bound exists to stop",
  },
  {
    check: "scripts/gate/checks/contracts-door.ts",
    target: DOOR,
    assertion: "the ratchet backward — a listed name the door no longer publishes fails, so the list cannot outlive what it describes",
    subject: "packages/contracts/src/control-loop.ts",
    find: "  procedureSignature,\n  reusesGatedDocumentPipeline,\n",
    replace: "  reusesGatedDocumentPipeline,\n",
    planted: "a name the residue still lists comes off the door, so the list describes a " +
      "surface that has moved and the name could be re-added without ever needing an importer",
  },
  {
    check: "scripts/gate/checks/contracts-door.ts",
    target: DOOR,
    assertion: "the ratchet backward — a listed name that has ACQUIRED an importer fails, so it can never return to the residue",
    subject: "scripts/probes/envelope-shape.ts",
    // THE PAYLOAD IS SPLIT SO THIS FILE IS NOT ITSELF AN IMPORTER. Written whole, the string
    // below reads to the check's own sweep as `import { … UNAVAILABLE } from "@zz/contracts"`
    // in a `scripts/` file — it strips comments, not string literals — so the residue clause
    // fired against THIS file at baseline, before any mutation ran, and every row was measured
    // against a red target. Third time tonight that a payload written as a literal became
    // repository text the repository's own sweeps then read; the seam is the whole fix.
    find: 'import { ENVELOPE_BLOCK, parseEnvelope } from "@zz/' + 'contracts";',
    replace: 'import { ENVELOPE_BLOCK, parseEnvelope, UNAVAILABLE } from "@zz/' + 'contracts";\n\nvoid UNAVAILABLE;',
    planted: "a residue name gains a real importer outside the contracts package while the " +
      "list still tolerates it, so a name that has earned its place on the door goes on being " +
      "counted as dormant",
  },
  {
    // HALF ONE, AND IT FIRES ALONE. With the chain not consulted at all, an empty run is still
    // refused — the last step's OWN rules are unmet — but the refusal names only that step, so
    // the clause watching for an earlier step's id is what catches it. A complete run still
    // grants and still evaluates clean, so half two cannot answer for this.
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
    // HALF TWO, AND IT FIRES ALONE TOO. Any step that declares predecessors becomes
    // permanently unsatisfiable, so a run driven to genuine completion is still refused. The
    // empty run is refused as before and its refusal still names an earlier step, so half one
    // passes — which is the point: a host that refuses everything passes a check watching only
    // the refusal, and is worse than the broken one because nobody can ever finish.
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
    check: "scripts/gate/checks/issuer-unreachable.ts",
    target: "the grant issuer is unreachable by any caller and still works for the host",
    subject: "packages/contracts/src/control-grant-fixture.ts",
    find: '  evidence_record: {\n    minRole: "member",',
    replace: '  evidence_record: {\n    minRole: "superadmin",',
    planted: "recording evidence is raised out of a member's reach, so contrary evidence " +
      "cannot be filed while progression is held",
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
    check: "scripts/gate/checks/label-only-adapter.ts",
    target: "a label-only adapter cannot manufacture a probability or drift to the cloud",
    subject: "packages/contracts/src/label-adapter.ts",
    find: "  native_distributions: false as const,",
    replace: "  native_distributions: true as const,",
    planted: "a backend class with no probability primitive declares that it has one",
  },
  {
    check: "scripts/gate/checks/observation-manifests.ts",
    target: "observation manifests include ignored outputs and keep check states distinct",
    subject: "packages/contracts/src/observation-manifest.ts",
    find: '    exclusions.every((rule) => rule.source !== "git_ignore")',
    replace: '    exclusions.some((rule) => rule.source === "git_ignore")',
    planted: "the capture reports that it included ignored outputs precisely when it excluded " +
      "them, so generated output is invisible in the record that says it is there",
  },
  {
    check: "scripts/gate/checks/plan-validator.ts",
    target: "the plan validator blocks malformed plans from controlled execution but not from being written",
    subject: "packages/contracts/src/plan-validation.ts",
    find: "    const firstAt = claimedAt.get(id);\n    if (firstAt !== undefined) {",
    replace: "    const firstAt = claimedAt.get(id);\n    if (firstAt !== undefined && line < 0) {",
    planted: "a second task claiming an id already taken is no longer reported, so two tasks " +
      "share one identity through the whole of controlled execution",
  },
  {
    check: "scripts/gate/checks/readiness-basis.ts",
    target: "readiness rests on evidence and gates, never on volume, rounds or a score",
    subject: "packages/contracts/src/readiness.ts",
    find: "  const advance = blockers.length === 0;",
    replace: "  const advance = blockers.length >= 0;",
    planted: "readiness advances with its blockers still standing, so an open gap and an " +
      "unrecorded gate stop holding anything back",
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
  {
    check: "scripts/gate/checks/search-read-synthesis.ts",
    target: "search to pinned read to synthesis holds in both languages and cannot be redirected",
    subject: "packages/contracts/src/recall-trial.ts",
    find: '  return /\\p{Script=Han}/u.test(question) ? "zh" : "en";',
    replace: '  return question.length >= 0 ? "en" : "zh";',
    planted: "the asker's language is no longer read off the question, so a question asked in " +
      "Chinese is answered in English and the reader is handed a language they did not use",
  },
  {
    check: "scripts/gate/checks/trial-analyzer-agreement.ts",
    target: "the recall trial's analyzer finds the same Han terms as zz-lexical-v2",
    subject: "packages/contracts/src/recall-trial-corpus.ts",
    assertion: "the trial's analyzer and zz-lexical-v2 find the same Han unigrams and adjacent bigrams",
    find: "      if (i + 1 < scalars.length) terms.push(scalars[i] + scalars[i + 1]);",
    replace: "      if (i + 2 < scalars.length) terms.push(scalars[i] + scalars[i + 2]);",
    planted: "the trial's copy of the analyzer pairs scalars the real one keeps apart and " +
      "drops the pairs it ranks, so the two implementations of one segmentation disagree on " +
      "what is adjacent — the drift this check exists to notice",
  },
  {
    // THE SECOND ASSERTION OF THE SAME CHECK, and the row above establishes the other one.
    // That check makes two independent claims — that `searchCorpus` still DEFAULTS to the
    // trial's analyzer, and that the analyzer still MEANS what the real one means — and a
    // mutation to either says nothing about the other. The coupling is a default parameter,
    // so no value a caller passes in can observe it; only the default itself can be moved.
    check: "scripts/gate/checks/trial-analyzer-agreement.ts",
    target: "the recall trial's analyzer finds the same Han terms as zz-lexical-v2",
    subject: "packages/contracts/src/recall-trial-corpus.ts",
    assertion: "searchCorpus still defaults to the trial's own analyzer, so the agreement above is with a function something calls",
    find: "  analyzer: TrialAnalyzer = trialAnalyze,",
    replace: "  analyzer: TrialAnalyzer = (text) => text.split(/\\s+/).filter(Boolean),",
    planted: "the trial searches by splitting on whitespace instead of through its own " +
      "analyzer, so an unspaced Han run is handed back whole and matches nothing — and the " +
      "agreement the check verifies below is with a function nothing calls any more",
  },
  {
    check: "scripts/gate/checks/runtime-adapter-portability.ts",
    target: "a second runtime adapter runs the same protocol with a different event format",
    subject: "packages/contracts/src/adapters/conformance.ts",
    find: "      passed: reason === null,",
    replace: "      passed: false,",
    planted: "the shared conformance protocol never passes, so the second adapter cannot " +
      "demonstrate it runs the same protocol",
  },
];
