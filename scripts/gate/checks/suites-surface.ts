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
check("initiative_status carries the current plan's waves, hotspots and violations, and an approved plan that does not validate says so in its next move",
      runsCheck("plan-waves-status.ts"));

check("audit rounds follow evidence, a spent budget or a reopened agreement waits on the stakeholder",
      runsCheck("audit-rounds.ts"));

check("review rounds follow evidence — fix, run_experiment, decide at the budget, settle — and a verifying document is approved on one acceptance-evidence row per declared criterion",
      runsCheck("review-rounds.ts"));

check("a spec is approved on a phase outline covering every AC and on core statements a spike actually tested",
      runsCheck("spec-gate.ts"));

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

check("the zz-core bootstrap reference protocol validates under EvaluationProtocol and carries exactly FR-57's frozen dimension weights, its release policy and bootstrap establishment, and no replay, search, selection or proof policy",
      runsCheck("eval-zz-core-protocol.ts"));

check("a deterministic/outcome measure reads any observed fact by a dotted factPath, normalised by rate/inverted_rate/threshold, missing evidence excludes rather than scoring 0, protocol_record refuses an unknown factPath or an unresolved criticalGuardrails key, and evaluateGuardrails never folds not_established into fail",
      runsCheck("eval-fact-path.ts"));

check("a request's digest ignores key order and the idempotency key, and a stored ledger row decides proceed, replay or conflict",
      runsCheck("eval-idempotency.ts"));

check("the evaluator registry's question digest matches the plan header's formula, and every entry point refuses before touching a database it does not have",
      runsCheck("eval-evaluators.ts"));

check("the qualification ladder is earned bottom-up from evidence counts and a protocol's own thresholds, zero anchors always refuses, and a 0-total category never counts as cleared",
      runsCheck("eval-qualification-ladder.ts"));

check("a run's overall score re-normalises across applicable and present dimensions, a missing required measure withholds establishment without voiding its dimension, unqualified evidence cannot establish, and a guardrail firing never moves the number",
      runsCheck("eval-score-formula.ts"));

check("a candidate build's environment is an allowlist with no model or platform credential in it, and the build installs a standalone clone of the subject's own release tag",
      runsCheck("candidate-isolation-pure.ts"));
check("the candidate build's git reads only its own repository outside the tree, so no fsmonitor, hook or filter planted in the tree runs, and the sandbox keeps that repository and the tree's gitfile read-only",
      runsCheck("candidate-git-fsmonitor.ts"));
check("a fetched third-party tree carrying a .git or a filter attribute is refused before any git command runs, and every file of it is digested",
      runsCheck("candidate-fetched-tree.ts"));
check("every sandboxed build process runs in its own process group, killed when it returns, so a background command that stays in the group is gone when the step ends",
      runsCheck("candidate-process-group.ts"));
check("the candidate build renames the tree out of every sandbox's writable path before reading it, so a command that outlived its step (setsid) cannot change any path the build reads",
      runsCheck("candidate-hold-tree.ts"));
check("no sandboxed build step can read the building process: a fresh PID namespace under bwrap, no process-info outside the sandbox under Seatbelt",
      runsCheck("candidate-bwrap-pid.ts"));
check("a third-party subject is fetched at its captured identity, its git host re-checked, and built only when its content and tree digests match",
      runsCheck("candidate-third-party.ts"));
check("a candidate's patch applies into the build's clone with no filter the tree names ever running, and a diff that does not match leaves the tree unchanged",
      runsCheck("candidate-apply-patch.ts"));
check("candidate_validate never builds: it asks for a build, only the requesting principal records one for the candidate's own patch within the lease, the next call consumes it once, and a passed build makes the candidate releasable",
      runsCheck("candidate-build-contract.ts"));
check("npm run candidate-build clones the base release, installs its own lockfile, builds and gates it inside the sandbox with no credential in reach, never blames the patch for a host problem, checks a third-party patch applies, and records the verdict",
      runsCheck("candidate-build-live.ts"));

check("complexityDelta is lines added minus lines removed plus 20 per added component minus 20 per removed one",
      runsCheck("eval-complexity.ts"));

check("the unified-diff parser counts added/removed lines and whole-file adds/deletes, touched files map onto the base subject's own component manifest, and a trivial proposer bundle is never reported as non_trivial",
      runsCheck("eval-candidates-pure.ts"));

check("releaseDecision applies only when every required owner approved the exact approved digest against the exact base subject, refusing no_release_owners, not_eligible, approval_required, digest_mismatch and stale_baseline in that order, and rollbackDecision is true on a guardrail failure or an established regression alone",
      runsCheck("eval-release-rules.ts"));

check("release_apply's inputs: semver precedence identifier by identifier, an approval speaks only for owner teams its signer is a member of and only for the attempt and digest it cites, any applying attempt of the plugin refuses, named as stale past the bound, and a rolled-back version is retracted by the one shared reader both plugin_locate's head and release_apply's baseline call",
      runsCheck("eval-release-apply-pure.ts"));

check("a catalog plugin's current version is the one the running deployment declares, never a higher legacy row, and an unregistered declared version is refused by name; any other plugin's is the newest by semver with retracted versions left out; plugin_locate's head, release_apply's baseline and knowledge's subject stamp all read it through currentVersionOf, and zz-core's runtime identity reports the real platform version, never serviceVersion's \"0.0.0\" fallback",
      runsCheck("eval-release-head.ts"));

check("release_verify judges a release on real use: it waits for the protocol's minimum of real runs and an evaluation of them, rolls back on a failed critical guardrail before reading the score or on a score beyond the regression band below the base, and never rolls back with no base score",
      runsCheck("eval-release-verify-reduction.ts"));

check("every refusal branch of planApply, recordRelease, releaseActorRefusal and improvementApprovalRefusal refuses by name, one query at a time, with release_apply bound to the attempt improvement.md cites and a registered-but-uncaptured newer version read as stale_baseline",
      runsCheck("eval-release-refusals.ts"));

check("the release CLI starts from the recorded base or a --base-ref its base tag contains, records a release by a published tag's commit containing the candidate, and --reconcile records released only when that tag contains the branch commit and failed only when no tag carries it and the release tag is not published",
      runsCheck("eval-release-git.ts"));

check("withInitiativeFactsLock gives one holder per initiative and none across initiatives, is reentrant within one call chain so writeBranchFacts may run under it, and releases on a throw",
      runsCheck("initiative-facts-lock.ts"));

check("the protocol's improvement.release names a positive integer of real runs and a non-negative regression band, no protocol carries a replay, search, selection or proof policy, and only an applicable dimension needs a positive weight",
      runsCheck("eval-release-policy-bounds.ts"));

check("a release tag without the candidate's commit is never recorded on its own: --reconcile names --accept-tag-without-candidate-commit, which records released by the published tag's commit with a reason only once the version is registered, and failed is never recorded while the release tag is published",
      runsCheck("eval-release-squash.ts"));

check("release_prepare and proposal_prepare write the ledger row and the branch fact on one pooled connection, under a transaction-level advisory lock on it, concurrent prepares on one initiative hold one connection between them, and a conflicting fact rolls everything back",
      runsCheck("eval-release-prepare-connection.ts"));

check("measure keys resolve by name (none, one, or a duplicate refused naming its dimensions) and are unique protocol-wide; finding_record refuses an unknown measure_key, evaluator_qualify a non-model measure, and an unaffirmed protocol version is refused by evaluator_qualify and evaluation_start and never answered reuse by protocol_read",
      runsCheck("eval-protocol-gate.ts"));
check("pluginDirComponents leaves a tests fixture SKILL.md out of a catalog capture's components at any depth",
      runsCheck("catalog-unshipped-skills.ts"));
check("release_prepare and proposal_prepare take only the initiative: the eval_run from its findings.md, the one valid candidate (none, or several with no candidate_id naming one, refused by name), the newest improvement run",
      runsCheck("eval-prepare-from-initiative.ts"));
check("a record stage's ids come back from initiative_status in a new conversation, and next_move names the first record stage that has none",
      runsCheck("eval-stage-records.ts"));
check("a model-backed measure qualifies against its own declared anchors, faults and controls: a truthful evaluator reaches operationally_qualified, a mislabelled anchor is unqualified naming anchorPassRate and the anchor id, and every zz-core.v1 semantic measure carries anchors of both answers",
      runsCheck("eval-qualify-anchors.ts"));
check("one excluded measure lowers its dimension's coverage but never nulls the dimension or the overall; the status reads the run's coverage against a named floor", runsCheck("eval-score-coverage.ts"));
check("OBSERVE counts only a plugin's own tools, attributed by the door that serves them, so observed never exceeds total, and its traces return the observed run ids with their team", runsCheck("eval-observe-surface.ts"));
check("evaluation_assess asks a model-backed measure only about refs of its own kind, never asks an unqualified evaluator, reads a deterministic fact once per run, and evaluation_score returns every reading with its assessment_id", runsCheck("eval-assess-routing.ts"));
check("a finding is corrected by recording its replacement with supersedes: the old one closes in the same write, a correction stays in its own eval_run, and findings.md renders only current findings, naming what each correction replaced", runsCheck("eval-finding-supersede.ts"));
check("the release reads the catalog owner team off the host's deploy/.env, hands it to register-plugins as owner and release_owners, and a register-plugins failure is a verification failure", runsCheck("release-plugin-owners.ts"));
check("a registered skill's content_hash is the sha256 of its SKILL.md", runsCheck("skill-digest-sha256.ts"));
check("DISCOVER folds one refusal rule into one candidate whatever files it named, and a two-decimal-rounded distribution is answered", runsCheck("eval-discover-rules.ts"));
check("handover.md requires the document its branch closes on, and is writable once the initiative closes there", runsCheck("eval-handover-branch.ts"));

check("a waiver covers only its own step's unmet rule of exactly its kind — never a kind it is a substring of, one named in an about tail, or another step's same-kind gap",
      runsCheck("store-waivers.ts"));
check("document_approve refuses a document whose current content was never presented", runsCheck("approve-needs-present.ts"));
check("a document too long for one result reads and presents in parts that round-trip, and counts as presented only when the parts cover it", runsCheck("document-parts.ts"));
check("the live chain check walks with a superadmin probe token, and a missing token or a skipped superadmin probe is unknown", runsCheck("release-probe-token.ts"));
check("the doctor's pre-deploy subset holds the status-gate probe, excludes migrations, and runs before step 4", runsCheck("doctor-predeploy.ts"));
