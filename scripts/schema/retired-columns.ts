/**
 * The columns the phase-3 evaluation reshape retired, keyed by the table they were retired from — the
 * name a statement binds, which for a renamed column is the NEW name.
 *
 * Its net effect, read off the target against the folded baseline rather than off its `drop column`
 * statements: `observable_surfaces` is dropped, re-added as `observable_surfaces_text` and renamed
 * back, so the name that is gone is `observable_surfaces_text`, and `polarity` is retired by a rename
 * no drop names.
 *
 * COUPLED: checks/dropped-columns.ts and checks/eval-family-readers.ts both read this one record, and
 * eval-family-readers.ts's `CARRIED_BEFORE` needs an entry for every name in it.
 */
export const PHASE3_RETIRED_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  eval_run: ["coverage", "dimension_scores", "evidence_snapshot_id", "guardrails", "run_status",
             "score_interval", "subject_version_id"],
  eval_assessment: ["answer", "evaluator_version_id", "evidence_ref", "policy_version",
                    "resulting_action", "subject_ref"],
  eval_dimension: ["name"],
  eval_evaluator_qualification: ["evaluator_version_id", "protocol_version_id", "subject_scope"],
  eval_evaluator_version: ["evaluator_id", "model_policy", "polarity"],
  eval_idempotency: ["principal"],
  eval_measure: ["suite"],
  eval_observation_snapshot: ["coverage", "environment_digest", "production_window",
                              "runtime_identity", "subject_version_id"],
  eval_protocol_version: ["approved_document_path", "failure_taxonomy", "observable_surfaces_text",
                          "protocol_id", "subject_compatibility", "suites"],
  plugin: ["evolvable", "owner_team", "release_owners"],
  plugin_version: ["rubric_id"],
  skill: ["kind", "ordinal"],
};
