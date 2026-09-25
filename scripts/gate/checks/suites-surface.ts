/**
 * The doors, the skills and the documents a tenant actually meets.

 * Which tools each door serves and under which nouns, which plugin owns which skill, what a
 * document must carry before it may be gated, and what the written record says about all of
 * it. The two bash suites are here too: they are about the deck skill's own shipped assets.
 */
import { check } from "../run.ts";
import { runsCheck, runsShell } from "../suite-runner.ts";

check("the manifest can express what the standard requires, and not what it replaced",
      runsCheck("contract-fields.ts"));

check("a command is what a manifest declares, not what a function derives from a skill name",
      runsCheck("commands-declared.ts"));

check("a flow is a plugin that declares documents, and zz-access is not one",
      runsCheck("flow-classification.ts"));

check("every plugin declares what it is, what it ships, and what each stage leaves behind",
      runsCheck("manifests-conform.ts"));

check("the core door speaks noun-first, and no caller still says the old name",
      runsCheck("core-names.ts"));

check("a revision names its cause — one route or the other, never neither and never both",
      runsCheck("revise-cause.ts"));

check("a document read takes a list and a version, and history never vouches for the present",
      runsCheck("document-reads.ts"));

check("the core door serves exactly its tools, and a removed tool is gone from every caller",
      runsCheck("core-surface.ts"));

check("the core door introduces itself to a client that reads nothing else, and the pointer survives",
      runsCheck("orientation.ts"));

check("opening is explicit and dated by the platform, and freeform gets no next move",
      runsCheck("initiative-open.ts"));

check("audit rounds follow evidence, a spent budget or a reopened agreement waits on the stakeholder",
      runsCheck("audit-rounds.ts"));

check("review rounds follow evidence — fix, run_experiment, decide at the budget, settle — and a verifying document is approved on one acceptance-evidence row per declared criterion",
      runsCheck("review-rounds.ts"));

check("a document's `when` decides applicability by code from durable facts, never by confidence",
      runsCheck("flow-when.ts"));

check("a not_applicable document is discharged everywhere and an undetermined one blocks a finished close",
      runsCheck("flow-when-status.ts"));

check("a close lands where its branch does, and a stop on a fallback draft owes that draft no approval",
      runsCheck("close-fallback-gates.ts"));

check("plugin_register reads the catalog root, public https git and registry packages, and nothing else",
      runsCheck("plugin-register-source.ts"));

check("the /manage door is cut by role, the duplicates are gone, and the exception is kept",
      runsCheck("manage-surface.ts"));

check("the evaluation door serves its own tools, and the gateway reaches that door and not the other",
      runsCheck("eval-door.ts"));

check("sdlc closes on its review, gates it, and leaves its audits ungated",
      runsCheck("sdlc-documents.ts"));

check("the evaluation modules are on the evaluation side, and attest stays on the core one",
      runsCheck("eval-tools-moved.ts"));

check("the three verification stages leave a document, and keep their independence",
      runsCheck("verification-stages-write.ts"));

check("the evaluation door speaks four nouns, three names are deliberately untouched, and the graders and the chain check follow",
      runsCheck("eval-names.ts"));

check("every skill ships from the plugin that owns it, and its commands follow with it",
      runsCheck("skill-homes.ts"));

check("the two misnamed core skills are renamed, every caller moved, and an old step still resolves",
      runsCheck("skill-renames.ts"));

check("no shipped file states a count of this platform's own surface",
      runsCheck("derived-counts.ts"));

check("the written record matches the delivered surface, and no document outgrew the ceiling",
      runsCheck("docs-current.ts"));

check("a renamed plugin still resolves, and the updater's copy of the map is the contract's",
      runsCheck("plugin-alias.ts"));

check("the deck skill names one destination, and never the platform's document-write tool",
      runsShell("deck-destination.sh"));

check("the deck chassis carries no slides and the guidebook carries all of them",
      runsShell("deck-chassis-sections.sh"));

check("shipped zz-plugin-eval text describes trace evidence only, not the removed ablation block",
      runsCheck("eval-drift-free.ts"));

check("an evaluation protocol accepts every FR-6 field and refuses unbalanced weights, an unknown enum and an unexplained non-applicable dimension",
      runsCheck("eval-protocol-schema.ts"));

check("the zz-core bootstrap reference protocol validates under EvaluationProtocol and carries exactly FR-57's frozen dimension weights, search policy, selection order, split policy and bootstrap establishment",
      runsCheck("eval-zz-core-protocol.ts"));

check("a deterministic/outcome measure reads any observed fact by a dotted factPath, normalised by rate/inverted_rate/threshold, missing evidence excludes rather than scoring 0, protocol_record refuses an unknown factPath or an unresolved criticalGuardrails key, and evaluateGuardrails never folds not_established into fail",
      runsCheck("eval-fact-path.ts"));

check("a request's digest ignores key order and the idempotency key, and a stored ledger row decides proceed, replay or conflict",
      runsCheck("eval-idempotency.ts"));

check("the evaluator registry's question digest matches the plan header's formula, and every entry point refuses before touching a database it does not have",
      runsCheck("eval-evaluators.ts"));

check("the qualification ladder is earned bottom-up from evidence counts and a protocol's own thresholds, zero anchors always refuses, and a 0-total category never counts as cleared",
      runsCheck("eval-qualification-ladder.ts"));

check("a run's overall score re-normalises across applicable and present dimensions, a missing required measure voids its dimension, unqualified evidence cannot establish, and a guardrail firing never moves the number",
      runsCheck("eval-score-formula.ts"));

check("the three-way split orders replayable cases by sha256(seed, digest), floors evolve and validation, and is stable for a given seed",
      runsCheck("eval-replay-split.ts"));

check("each replay role sees exactly its visibility classes, in chronological order, and an unknown role is refused rather than defaulted",
      runsCheck("eval-replay-visibility.ts"));

check("team_create refuses a replay- slug for every caller, and provisionReplayTeam refuses a team-bound caller before touching the database",
      runsCheck("replay-team-pure.ts"));

check("every dependency mode resolves to exactly one action with no fabricated or uncontrolled write, and a search context never sees a proof-split row",
      runsCheck("eval-replay-safety.ts"));

check("the launcher builds every git/claude argv with no shell, a run-bound credential is refused any events role but actor, and a launch outside a shell-capable runtime refuses before touching a process",
      runsCheck("replay-launch-pure.ts"));

check("a replay session's environment is an allowlist with no launcher credential in it, only the launching principal's own unbound credential may begin or close a live run, the run TTL outlasts the launcher's worst case, and the launcher installs a standalone clone of the subject's own release tag",
      runsCheck("replay-isolation-pure.ts"));
check("the launcher's git reads only its own repository outside the tree, so no fsmonitor, hook or filter planted in the tree runs, and the sandbox keeps that repository and the tree's gitfile read-only",
      runsCheck("replay-git-fsmonitor.ts"));
check("a fetched third-party tree carrying a .git or a filter attribute is refused before any git command runs, and every file of it is digested",
      runsCheck("replay-fetched-tree.ts"));
check("every sandboxed session process runs in its own process group, killed when it returns, so a background command that stays in the group is gone when the turn ends",
      runsCheck("replay-process-group.ts"));
check("the launcher renames the tree out of every sandbox's writable path before reading it, so a command that outlived its turn (setsid) cannot change any path the launcher reads",
      runsCheck("replay-hold-tree.ts"));
check("collectProduced never follows a symlink out of the clone into what it ships as produced",
      runsCheck("replay-produced-symlink.ts"));
check("no replay session can read the launcher's process: a fresh PID namespace under bwrap, no process-info outside the sandbox under Seatbelt",
      runsCheck("replay-bwrap-pid.ts"));
check("a third-party subject is fetched at its captured identity, its git host re-checked, and replayed only when its content and tree digests match",
      runsCheck("replay-third-party.ts"));
check("a candidate's patch applies into the launcher's clone with no filter the tree names ever running, and a diff that does not match leaves the tree unchanged",
      runsCheck("replay-apply-patch.ts"));
check("candidate_validate never builds: it asks for a build, only the requesting principal records one for the candidate's own patch within the lease, and the next call consumes it once",
      runsCheck("candidate-build-contract.ts"));
check("npm run candidate-build clones the base release, installs its own lockfile, builds and gates it inside the sandbox with no credential in reach, never blames the patch for a host problem, checks a third-party patch applies, and records the verdict",
      runsCheck("candidate-build-live.ts"));

check("complexityDelta is lines added minus lines removed plus 20 per added component minus 20 per removed one",
      runsCheck("eval-complexity.ts"));

check("the unified-diff parser counts added/removed lines and whole-file adds/deletes, touched files map onto the base subject's own component manifest, and a trivial proposer bundle is never reported as non_trivial",
      runsCheck("eval-candidates-pure.ts"));

check("pairedDecision returns a seeded, reproducible percentile-bootstrap interval of the mean per-case delta, improving above mme, not improving below it and unresolved in between",
      runsCheck("eval-paired-stats.ts"));

check("replay_start and replay_read refuse an unknown subject_version_id by name, the same as an unknown candidate_id, before either ever reaches zz.replay_run's own FK constraint",
      runsCheck("eval-replay-runs-guards.ts"));

check("producedSubjectText renders two different produced records into two different subject texts, and scoreReplay refuses an unknown replay_run_id or one with no produced output by name",
      runsCheck("eval-replay-score-produced.ts"));

check("paretoFrontier keeps exactly the non-dominated candidates on (pass vector, cost) and selectFinal breaks ties by lower complexity, lower latency, lower cost, then ascending id, excluding a guardrail failure outright",
      runsCheck("eval-selection.ts"));

check("releaseDecision applies only when every required owner approved the exact approved digest against the exact base subject, refusing no_release_owners, not_eligible, approval_required, digest_mismatch and stale_baseline in that order, and rollbackDecision is true on a guardrail failure or an established regression alone",
      runsCheck("eval-release-rules.ts"));

check("release_apply's inputs: the current version is the newest by semver with pre-release precedence identifier by identifier, an approval speaks only for owner teams its signer is a member of and only for the attempt and digest it cites, any applying attempt of the plugin refuses, named as stale past the bound, and a rolled-back version is retracted from both plugin_locate's head and release_apply's baseline by one shared rule",
      runsCheck("eval-release-apply-pure.ts"));

check("release_verify reads guardrails before the interval and over incomplete evidence, so a failed guardrail rolls back while the interval is unresolved or replays are still missing, before either pending answer, and one confidence decides both the unresolved check and rollbackDecision",
      runsCheck("eval-release-verify-reduction.ts"));

check("every refusal branch of planApply, recordRelease, releaseActorRefusal and improvementApprovalRefusal refuses by name, one query at a time, with release_apply bound to the attempt improvement.md cites and a registered-but-uncaptured newer version read as stale_baseline",
      runsCheck("eval-release-refusals.ts"));

check("the release CLI starts from the recorded base or a --base-ref its base tag contains, records a release by a published tag's commit containing the candidate, and --reconcile records released only when that tag contains the branch commit and failed only when no tag carries it and the release tag is not published",
      runsCheck("eval-release-git.ts"));

check("a verifier_token reaches one proof allocation only: its own case set, candidate and base subject on the proof split, never a caller-named case, another allocation's run or an evaluator-role event, and a proof-split read blanks every per-case result field",
      runsCheck("eval-verifier-binding.ts"));

check("candidate_prove judges an accepted pruning before asking for more repeats, and an unclear or unavailable leakage answer is not_established (leakage_unresolved), never a pass",
      runsCheck("eval-proof-verdict.ts"));

check("a search generation is the search's own round, capped by maxCandidatesPerGeneration and maxGenerations, and a malformed or empty search_policy is refused rather than defaulted",
      runsCheck("eval-search-rules.ts"));

check("replay_score refuses a credential scoped to the run's own replay team before anything is asked or written",
      runsCheck("eval-replay-score-guard.ts"));

check("withInitiativeFactsLock gives one holder per initiative and none across initiatives, is reentrant within one call chain so writeBranchFacts may run under it, and releases on a throw",
      runsCheck("initiative-facts-lock.ts"));

check("replay_case_set_build writes only inside its transaction: a qualification it established and every classification it asked are recorded through the transaction's client, and a concurrent case-set change is refused before any row is written",
      runsCheck("eval-replay-build-split.ts"));

check("a resolved proof keeps the case set's proof split spent after a decision or after runs observed the cases, and releases it when no run executed or only the leakage answer was unavailable",
      runsCheck("eval-proof-split-release.ts"));

check("SearchPolicy's generation bounds and minRepeats are positive integers, wallClockHours is positive, confidence lies inside (0, 1), and minMeaningfulEffect and equivalenceBand are non-negative; only an applicable dimension needs a positive weight",
      runsCheck("eval-search-policy-bounds.ts"));

check("a release tag without the candidate's commit is never recorded on its own: --reconcile names --accept-tag-without-candidate-commit, which records released by the published tag's commit with a reason only once the version is registered, and failed is never recorded while the release tag is published",
      runsCheck("eval-release-squash.ts"));

check("release_prepare and proposal_prepare write the ledger row and the branch fact on one pooled connection, under a transaction-level advisory lock on it, concurrent prepares on one initiative hold one connection between them, and a conflicting fact rolls everything back",
      runsCheck("eval-release-prepare-connection.ts"));

check("candidate_prove(abandon) revokes the verifier_token before cancelling anything and counts the allocation's runs inside the resolving transaction, after locking the token rows, so the proof split is released only when no run exists",
      runsCheck("eval-proof-abandon-order.ts"));
check("a verifier replay_start re-reads its token FOR SHARE right before the run insert, so a start racing an abandon is counted or refused",
      runsCheck("eval-replay-start-token-race.ts"));
check("measure keys resolve by name (none, one, or a duplicate refused naming its dimensions) and are unique protocol-wide; finding_record refuses an unknown measure_key, evaluator_qualify a non-model measure, and an unaffirmed protocol version is refused by evaluator_qualify and evaluation_start and never answered reuse by protocol_read",
      runsCheck("eval-protocol-gate.ts"));
check("the replay launcher runs every cleanup removal even when one throws, and a leftover keeps a completed run completed with a cleanup_warning",
      runsCheck("replay-launch-cleanup.ts"));
check("pluginDirComponents leaves a tests fixture SKILL.md out of a catalog capture's components at any depth",
      runsCheck("catalog-unshipped-skills.ts"));
check("release_prepare and proposal_prepare take only the initiative: the eval_run from its findings.md, the one proof_passed candidate (none or several refused by name), the newest improvement run",
      runsCheck("eval-prepare-from-initiative.ts"));
check("a record stage's ids come back from initiative_status in a new conversation, and next_move names the first record stage that has none",
      runsCheck("eval-stage-records.ts"));
check("a qualification control passes when the evaluator answers what the other plugin's numbers say, same-sign counts included",
      runsCheck("eval-qualify-controls.ts"));
check("a lost verifier_token is rotated for the same allocation: the old row revoked, the new one bound to the same candidate, case set and released subject",
      runsCheck("eval-verifier-rotate.ts"));

check("a waiver covers only its own step's unmet rule of exactly its kind — never a kind it is a substring of, one named in an about tail, or another step's same-kind gap",
      runsCheck("store-waivers.ts"));
