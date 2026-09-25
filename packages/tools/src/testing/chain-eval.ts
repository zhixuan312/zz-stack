/**
 * The /eval door, walked against a live deployment.
 *
 * Every tool here takes `plugin`/`version`/`eval_id` identifiers and answers about a plugin's
 * release history — state this run's throwaway initiative does not create and this script does not
 * control — which makes it a different subject from the governed walk next door, where every
 * assertion is about one initiative's documents.
 *
 * COUPLED: `checks/chain-check-wiring.ts` follows this import, so a tool exercised here counts as
 * exercised.
 */
import { randomUUID } from "node:crypto";

/** The pieces chain-check owns, handed in rather than re-made, so this walks the same door
 *  into the same result set. */
interface EvalDeps {
  callEval: (tool: string, args: unknown) => Promise<string>;
  eitherOr: (name: string, got: string, acceptableRefusal: RegExp) => void;
  /** The plugin these tools are aimed at — the catalog entry this run's flow belongs to. */
  PLUGIN: string;
}

export async function walkEvalDoor({ callEval, eitherOr, PLUGIN }: EvalDeps): Promise<void> {
  // Whether this deployment has ever released a plugin, holds a historic round, or even holds a
  // platform database is state this throwaway initiative does not create. So each call below is
  // aimed at a refusal these tools document for exactly that case — "no released version is
  // recorded", "is not an evaluation" — rather than at manufacturing a real release and a scored
  // run, which needs a live judge. Getting this far exercises the door, the schema and every
  // refusal branch that runs before a model is reached.
  eitherOr("plugin_locate answers or refuses by a named cause",
    await callEval("plugin_locate", { plugin: PLUGIN }),
    /no platform database|no released version/);
  // Deterministic and safe against any live state: PLUGIN is this run's own flow, which the
  // catalog carries, so plugin_register refuses it before it ever reaches the database — the
  // same refusal a real caller gets for trying to register a plugin the catalog already owns.
  eitherOr("plugin_register refuses a name the catalog already owns",
    await callEval("plugin_register", {
      name: PLUGIN, version: "0", source_kind: "local_dir", source_locator: "/nonexistent",
      idempotency_key: randomUUID(),
    }), /is a catalog plugin/);
  eitherOr("plugin_conform reads this plugin's own catalog entry",
    await callEval("plugin_conform", { plugin: PLUGIN, version: "0" }),
    /is not in the catalog/);
  // Task I-7: plugin_profile now takes a subject_version_id (from plugin_locate) and an
  // evidence_window, not a bare plugin/version — a random uuid is safe against any live state,
  // the same way finding_decide's probe below is: it decides nothing and matches no subject.
  eitherOr("plugin_profile answers or refuses by a named cause",
    await callEval("plugin_profile", {
      subject_version_id: randomUUID(), evidence_window: { last_runs: 5 },
      idempotency_key: randomUUID(),
    }), /no platform database|unknown subject_version_id/);
  eitherOr("protocol_read answers or refuses by a named cause",
    await callEval("protocol_read", { subject_version_id: randomUUID() }),
    /no platform database|unknown subject_version_id/);
  eitherOr("protocol_affirm refuses a protocol_version_id nothing minted",
    await callEval("protocol_affirm", {
      protocol_version_id: randomUUID(), initiative: "chain-check-probe", idempotency_key: randomUUID(),
    }), /no platform database|unknown protocol_version_id/);
  eitherOr("round_scores refuses an eval_id nothing minted",
    await callEval("round_scores", { eval_id: randomUUID() }),
    /no platform database|is not an evaluation/);
  eitherOr("protocol_record refuses a body EvaluationProtocol does not validate",
    await callEval("protocol_record", {
      subject_version_id: randomUUID(), protocol_body: {}, idempotency_key: randomUUID(),
    }), /no platform database|unknown subject_version_id|"code"/);
  // Task I-13: finding_record now binds to an eval_run_id (migration 078), not the legacy round's
  // eval_id — a random uuid is safe against any live state, the same way every other probe here is.
  eitherOr("finding_record refuses an eval_run_id nothing minted",
    await callEval("finding_record", {
      eval_run_id: randomUUID(),
      finding: { kind: "unknown", pattern: "chain-check probe", owner_kind: "unknown", evidence_refs: [] },
      idempotency_key: randomUUID(),
    }), /no platform database|no eval_run/);
  // A random UUID decides nothing, which makes this probe safe against a live deployment:
  // finding_decide is the one tool on this door that closes a row somebody else recorded, and the id
  // below matches none.
  eitherOr("finding_decide refuses an id nothing minted",
    await callEval("finding_decide", {
      decisions: [{ finding_id: randomUUID(), decision: "rejected", note: "chain-check probe" }],
      idempotency_key: randomUUID(),
    }), /no platform database|names no finding|none of the/);
  // Task I-9: a random observation_snapshot_id decides nothing and matches no snapshot — safe
  // against any live state, the same way plugin_profile's probe above is.
  eitherOr("failure_discover refuses an observation_snapshot_id nothing minted",
    await callEval("failure_discover", {
      observation_snapshot_id: randomUUID(), idempotency_key: randomUUID(),
    }), /no platform database|unknown observation_snapshot_id/);
  // Task I-11: a random protocol_version_id decides nothing and matches no protocol — safe
  // against any live state, the same way protocol_affirm's probe above is.
  eitherOr("evaluator_qualify refuses a protocol_version_id nothing minted",
    await callEval("evaluator_qualify", {
      protocol_version_id: randomUUID(), evaluator_version_id: randomUUID(), idempotency_key: randomUUID(),
    }), /no platform database|unknown protocol_version_id/);
  // Task I-13: three random uuids decide nothing on any live state, the same way the probes
  // above are safe.
  eitherOr("evaluation_start refuses an observation_snapshot_id nothing minted",
    await callEval("evaluation_start", {
      subject_version_id: randomUUID(), protocol_version_id: randomUUID(),
      observation_snapshot_id: randomUUID(), idempotency_key: randomUUID(),
    }), /no platform database|unknown observation_snapshot_id|unknown subject_version_id/);
  eitherOr("evaluation_assess refuses an eval_run_id nothing minted",
    await callEval("evaluation_assess", {
      eval_run_id: randomUUID(), subject_refs: ["chain-check-probe"], idempotency_key: randomUUID(),
    }), /no platform database|unknown eval_run_id/);
  eitherOr("evaluation_score refuses an eval_run_id nothing minted",
    await callEval("evaluation_score", {
      eval_run_id: randomUUID(), idempotency_key: randomUUID(),
    }), /no platform database|unknown eval_run_id/);
  // Task I-14: a random subject_version_id decides nothing and matches no subject — refused
  // before source_scope is ever resolved, the same way every other probe here is safe against
  // any live state. source_scope still has to be well-formed for the schema to accept the call
  // at all, so it names a real (but nonexistent) initiative rather than an empty scope.
  eitherOr("replay_case_set_build refuses a subject_version_id nothing minted",
    await callEval("replay_case_set_build", {
      subject_version_id: randomUUID(), protocol_version_id: randomUUID(),
      source_scope: { initiatives: ["chain-check-probe"] }, idempotency_key: randomUUID(),
    }), /no platform database|unknown subject_version_id/);
  // Task I-16: a random case_set_id decides nothing and matches no case set — refused before
  // any team is provisioned, the same way every other probe here is safe against any live
  // state. subject_version_id (rather than candidate_id) satisfies the exactly-one check so
  // the call reaches the case-set lookup at all.
  eitherOr("replay_start refuses a case_set_id nothing minted",
    await callEval("replay_start", {
      case_set_id: randomUUID(), subject_version_id: randomUUID(), split: "evolve", repeats: 1,
      idempotency_key: randomUUID(),
    }), /no platform database|unknown subject_version_id|unknown case set/);
  eitherOr("replay_read refuses a replay_run_id nothing minted",
    await callEval("replay_read", { replay_run_id: randomUUID() }),
    /no platform database|unknown replay_run_id/);
  eitherOr("replay_begin refuses a replay_run_id nothing minted",
    await callEval("replay_begin", { replay_run_id: randomUUID(), idempotency_key: randomUUID() }),
    /no platform database|unknown replay_run_id/);
  eitherOr("replay_close refuses a replay_run_id nothing minted",
    await callEval("replay_close", {
      replay_run_id: randomUUID(), status: "cancelled", idempotency_key: randomUUID(),
    }), /no platform database|unknown replay_run_id/);
  // Task I-18: a random eval_run_id decides nothing and matches no run — refused before any
  // finding is ever read, the same way every other probe here is safe against any live state.
  eitherOr("improvement_start refuses an eval_run_id nothing minted",
    await callEval("improvement_start", {
      eval_run_id: randomUUID(), finding_ids: [randomUUID()], idempotency_key: randomUUID(),
    }), /no platform database|no eval_run/);
  // A random improvement_run_id decides nothing and matches no run — refused before
  // base_subject_version_id is ever resolved.
  eitherOr("candidate_record refuses an improvement_run_id nothing minted",
    await callEval("candidate_record", {
      improvement_run_id: randomUUID(), base_subject_version_id: randomUUID(), parents: [],
      hypothesis: "chain-check probe hypothesis", expected_effect: {},
      patchset: { diff: "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n" },
      idempotency_key: randomUUID(),
    }), /no platform database|no improvement_run/);
  // Task I-19: a random replay_run_id decides nothing and matches no run — refused before any
  // measure is ever assessed, the same way every other probe here is safe against any live state.
  eitherOr("replay_score refuses a replay_run_id nothing minted",
    await callEval("replay_score", { replay_run_id: randomUUID(), idempotency_key: randomUUID() }),
    /no platform database|unknown replay_run_id/);
  // A random candidate_id decides nothing and matches no candidate — refused before this
  // deployment's own checkout is ever touched, so this probe never spends a build or a gate run.
  eitherOr("candidate_validate refuses a candidate_id nothing minted",
    await callEval("candidate_validate", { candidate_id: randomUUID(), idempotency_key: randomUUID() }),
    /no platform database|no candidate/);
  // Task I-20: a random improvement_run_id decides nothing and matches no run — refused before
  // its own eval_run/subject is ever resolved, the same way improvement_start's probe above is
  // safe against any live state.
  eitherOr("candidate_search refuses an improvement_run_id nothing minted",
    await callEval("candidate_search", { improvement_run_id: randomUUID(), idempotency_key: randomUUID() }),
    /no platform database|no improvement_run/);
  // Task I-21: a random candidate_id decides nothing and matches no candidate — refused before
  // any proof context (its own improvement_run, case set or protocol) is ever resolved, the same
  // way candidate_validate's probe above is safe against any live state.
  eitherOr("candidate_prove refuses a candidate_id nothing minted",
    await callEval("candidate_prove", { candidate_id: randomUUID(), idempotency_key: randomUUID() }),
    /no platform database|no candidate/);
  // Fix dispatch on I-21: abandon: true reaches the SAME loadCandidate lookup before anything
  // abandon-specific runs, so a random candidate_id refuses identically — exercised here so the
  // tool's new argument is at least reachable through the door, not merely typed.
  eitherOr("candidate_prove refuses abandon on a candidate_id nothing minted",
    await callEval("candidate_prove", { candidate_id: randomUUID(), abandon: true, idempotency_key: randomUUID() }),
    /no platform database|no candidate/);
  // Task I-22: a random candidate_id decides nothing and matches no candidate — refused before
  // any subject or owner is ever resolved, the same way candidate_prove's own probe above is
  // safe against any live state.
  eitherOr("release_prepare refuses a candidate_id nothing minted",
    await callEval("release_prepare", {
      candidate_id: randomUUID(), initiative: "chain-check-probe", idempotency_key: randomUUID(),
    }), /no platform database|no candidate/);
  // Task I-23: same shape again — a random candidate_id resolves no candidate row before either
  // tool ever reaches the advisory lock or the database's live state, so both are safe against
  // whatever this deployment has or has not released.
  eitherOr("release_apply refuses a candidate_id nothing minted",
    await callEval("release_apply", {
      candidate_id: randomUUID(), approved_patch_digest: "chain-check-probe-digest",
      initiative: "chain-check-probe", idempotency_key: randomUUID(),
    }), /no platform database|no candidate/);
  eitherOr("release_record refuses a release_attempt_id nothing minted",
    await callEval("release_record", {
      release_attempt_id: randomUUID(), status: "failed", failure_tail: "chain-check-probe",
      idempotency_key: randomUUID(),
    }), /no platform database|no release_attempt/);
  // Task I-24: same shape once more — a random release_attempt_id resolves no row before this
  // tool ever plans a replay or touches the case-set/protocol lookups, so the probe is safe
  // against whatever this deployment has or has not verified.
  eitherOr("release_verify refuses a release_attempt_id nothing minted",
    await callEval("release_verify", {
      release_attempt_id: randomUUID(), idempotency_key: randomUUID(),
    }), /no platform database|no release_attempt/);
  // Task I-25: a random improvement_run_id decides nothing and matches no run — refused before
  // any subject or ownership is ever resolved, the same way improvement_start's own probe above
  // is safe against any live state.
  eitherOr("proposal_prepare refuses an improvement_run_id nothing minted",
    await callEval("proposal_prepare", {
      improvement_run_id: randomUUID(), initiative: "chain-check-probe", idempotency_key: randomUUID(),
    }), /no platform database|no improvement_run/);
}
