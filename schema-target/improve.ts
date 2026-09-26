/**
 * What an evaluation concluded, and the improve and promote loop that acts on it.
 */
import type { TableTarget } from "../scripts/schema/types.ts";

export const IMPROVE: Record<string, TableTarget> = {
  eval_finding: {
    columns: [
      [
        "id",
        "uuid",
        false,
        "gen_random_uuid()",
      ],
      [
        "eval_id",
        "uuid",
        true,
        null,
      ],
      [
        "pattern",
        "text",
        false,
        null,
      ],
      [
        "docs_affected",
        "integer",
        false,
        "0",
      ],
      [
        "scope",
        "text",
        true,
        null,
      ],
      [
        "proposed_change",
        "text",
        false,
        "''::text",
      ],
      [
        "decision",
        "text",
        false,
        "'deferred'::text",
      ],
      [
        "resulted_in_skill_version_id",
        "uuid",
        true,
        null,
      ],
      [
        "created_at",
        "timestamp with time zone",
        false,
        "now()",
      ],
      [
        "decided_by",
        "text",
        true,
        null,
      ],
      [
        "decided_at",
        "timestamp with time zone",
        true,
        null,
      ],
      [
        "decision_note",
        "text",
        false,
        "''::text",
      ],
      [
        "owner_kind",
        "text",
        true,
        null,
      ],
      [
        "owner_ref",
        "text",
        true,
        null,
      ],
      [
        "measure_id",
        "uuid",
        true,
        null,
      ],
      [
        "evidence_refs",
        "jsonb",
        false,
        "'[]'::jsonb",
      ],
      [
        "expected_effect",
        "jsonb",
        true,
        null,
      ],
      [
        "eval_run_id",
        "uuid",
        true,
        null,
      ],
      [
        "kind",
        "text",
        true,
        null,
      ],
      [
        "superseded_by",
        "uuid",
        true,
        null,
      ],
    ],
    primaryKey: [
      "id",
    ],
    uniques: [],
    foreignKeys: [
      {
        columns: [
          "eval_id",
        ],
        refTable: "eval",
        refColumns: [
          "id",
        ],
        onDelete: "CASCADE",
        deferrable: false,
      },
      {
        columns: [
          "eval_run_id",
        ],
        refTable: "eval_run",
        refColumns: [
          "id",
        ],
        onDelete: "NO ACTION",
        deferrable: false,
      },
      {
        columns: [
          "measure_id",
        ],
        refTable: "eval_measure",
        refColumns: [
          "id",
        ],
        onDelete: "NO ACTION",
        deferrable: false,
      },
      {
        columns: [
          "resulted_in_skill_version_id",
        ],
        refTable: "skill_version",
        refColumns: [
          "id",
        ],
        onDelete: "SET NULL",
        deferrable: false,
      },
      {
        columns: [
          "superseded_by",
        ],
        refTable: "eval_finding",
        refColumns: [
          "id",
        ],
        onDelete: "NO ACTION",
        deferrable: false,
      },
    ],
    checks: [
      "CHECK ((decision = ANY (ARRAY['applied'::text, 'rejected'::text, 'deferred'::text])))",
      "CHECK ((kind = ANY (ARRAY['strength'::text, 'defect'::text, 'unknown'::text])))",
      "CHECK ((owner_kind = ANY (ARRAY['plugin'::text, 'dependency'::text, 'platform'::text, 'environment'::text, 'user_input'::text, 'unknown'::text])))",
      "CHECK (((eval_id IS NOT NULL) <> (eval_run_id IS NOT NULL)))",
      "CHECK (((eval_run_id IS NULL) OR (kind IS NOT NULL)))",
      "CHECK ((scope = ANY (ARRAY['generic'::text, 'specific'::text])))",
    ],
    indexes: [],
    comment: null,
    columnComments: {
      decision_note: "Why it was applied or rejected. Empty while deferred -- the open state needs no reason, and the two closed ones do.",
      eval_run_id: "Set instead of eval_id for an EVALUATE-produced finding (finding_record). Exactly one of the two is non-null.",
      kind: "strength | defect | unknown — required when eval_run_id is set; null on every legacy round finding, which carries scope instead.",
      superseded_by: "The finding that corrected this one, when finding_record(supersedes) replaced it. Null for a current finding. A superseded finding is also decision=rejected, so it stays closed for every reader.",
    },
  },
  improvement_run: {
    columns: [
      [
        "id",
        "uuid",
        false,
        "gen_random_uuid()",
      ],
      [
        "eval_run_id",
        "uuid",
        false,
        null,
      ],
      [
        "finding_ids",
        "jsonb",
        false,
        null,
      ],
      [
        "created_at",
        "timestamp with time zone",
        false,
        null,
      ],
    ],
    primaryKey: [
      "id",
    ],
    uniques: [],
    foreignKeys: [
      {
        columns: [
          "eval_run_id",
        ],
        refTable: "eval_run",
        refColumns: [
          "id",
        ],
        onDelete: "NO ACTION",
        deferrable: false,
      },
    ],
    checks: [],
    indexes: [],
    comment: null,
    columnComments: {},
  },
  candidate: {
    columns: [
      [
        "id",
        "uuid",
        false,
        "gen_random_uuid()",
      ],
      [
        "improvement_run_id",
        "uuid",
        false,
        null,
      ],
      [
        "base_subject_version_id",
        "uuid",
        false,
        null,
      ],
      [
        "hypothesis",
        "text",
        false,
        null,
      ],
      [
        "expected_effect",
        "jsonb",
        false,
        null,
      ],
      [
        "patchset",
        "jsonb",
        false,
        null,
      ],
      [
        "patch_digest",
        "text",
        false,
        null,
      ],
      [
        "complexity_delta",
        "integer",
        false,
        null,
      ],
      [
        "touched_components",
        "jsonb",
        false,
        null,
      ],
      [
        "touched_owners",
        "jsonb",
        false,
        null,
      ],
      [
        "proposer_identity",
        "jsonb",
        false,
        null,
      ],
      [
        "status",
        "text",
        false,
        null,
      ],
      [
        "created_at",
        "timestamp with time zone",
        false,
        null,
      ],
      [
        "build_requested_at",
        "timestamp with time zone",
        true,
        null,
      ],
      [
        "build_requested_by",
        "text",
        true,
        null,
      ],
      [
        "build_result",
        "jsonb",
        true,
        null,
      ],
      [
        "build_recorded_at",
        "timestamp with time zone",
        true,
        null,
      ],
    ],
    primaryKey: [
      "id",
    ],
    uniques: [],
    foreignKeys: [
      {
        columns: [
          "base_subject_version_id",
        ],
        refTable: "eval_subject_version",
        refColumns: [
          "id",
        ],
        onDelete: "NO ACTION",
        deferrable: false,
      },
      {
        columns: [
          "improvement_run_id",
        ],
        refTable: "improvement_run",
        refColumns: [
          "id",
        ],
        onDelete: "NO ACTION",
        deferrable: false,
      },
    ],
    checks: [
      "CHECK ((status = ANY (ARRAY['recorded'::text, 'awaiting_build'::text, 'valid'::text, 'invalid'::text, 'released'::text, 'rolled_back'::text])))",
    ],
    indexes: [],
    comment: null,
    columnComments: {
      status: "rolled_back: release_record set the same candidate's own release_attempt to rolled_back after packages/tools/src/release/rollback.ts restored the prior released version — set alongside it, in the same recordRelease transaction, never on its own.",
      build_result: "What npm run candidate-build recorded through candidate_build_record: {ok, stage, log_tail, commands, patch_digest}. Kept once candidate_validate consumes it, so improvement.md and the console can say how the released patch was built and gated.",
    },
  },
  release_attempt: {
    columns: [
      [
        "id",
        "uuid",
        false,
        "gen_random_uuid()",
      ],
      [
        "candidate_id",
        "uuid",
        false,
        null,
      ],
      [
        "base_subject_version_id",
        "uuid",
        false,
        null,
      ],
      [
        "approved_patch_digest",
        "text",
        false,
        null,
      ],
      [
        "required_owners",
        "jsonb",
        false,
        null,
      ],
      [
        "approval_refs",
        "jsonb",
        false,
        null,
      ],
      [
        "status",
        "text",
        false,
        null,
      ],
      [
        "released_subject_version_id",
        "uuid",
        true,
        null,
      ],
      [
        "release_ref",
        "text",
        true,
        null,
      ],
      [
        "verification",
        "jsonb",
        true,
        null,
      ],
      [
        "rolled_back",
        "boolean",
        false,
        "false",
      ],
      [
        "created_at",
        "timestamp with time zone",
        false,
        null,
      ],
      [
        "reason",
        "text",
        true,
        null,
      ],
      [
        "plugin_id",
        "uuid",
        false,
        null,
      ],
      [
        "applied_by",
        "text",
        true,
        null,
      ],
      [
        "applying_at",
        "timestamp with time zone",
        true,
        null,
      ],
    ],
    primaryKey: [
      "id",
    ],
    uniques: [],
    foreignKeys: [
      {
        columns: [
          "base_subject_version_id",
        ],
        refTable: "eval_subject_version",
        refColumns: [
          "id",
        ],
        onDelete: "NO ACTION",
        deferrable: false,
      },
      {
        columns: [
          "candidate_id",
        ],
        refTable: "candidate",
        refColumns: [
          "id",
        ],
        onDelete: "NO ACTION",
        deferrable: false,
      },
      {
        columns: [
          "plugin_id",
        ],
        refTable: "plugin",
        refColumns: [
          "id",
        ],
        onDelete: "NO ACTION",
        deferrable: false,
      },
      {
        columns: [
          "released_subject_version_id",
        ],
        refTable: "eval_subject_version",
        refColumns: [
          "id",
        ],
        onDelete: "NO ACTION",
        deferrable: false,
      },
    ],
    checks: [
      "CHECK ((status = ANY (ARRAY['prepared'::text, 'applying'::text, 'released'::text, 'refused'::text, 'failed'::text, 'rolled_back'::text])))",
    ],
    indexes: [
      "CREATE UNIQUE INDEX release_attempt_applying_plugin_idx ON zz.release_attempt USING btree (plugin_id) WHERE (status = 'applying'::text)",
      "CREATE UNIQUE INDEX release_attempt_live_candidate_idx ON zz.release_attempt USING btree (candidate_id) WHERE (status = ANY (ARRAY['applying'::text, 'released'::text]))",
    ],
    comment: null,
    columnComments: {
      verification: "release_verify's decision, once it has one: {verdict (established | rolled_back | not_established), reason, evidence: {post_release_runs, released_eval_run_id, released_overall, base_eval_run_id, base_overall, delta, regression_band, guardrail_status}, rollback_plan}. Null until the released subject has enough real runs and an evaluation to judge.",
      reason: "Why this attempt ended as it did: releaseDecision's own reason on a refusal, the failing command's output tail (release_record) on a failure, the operator's reason on a rollback, or the accepted override (--reconcile --accept-tag-without-candidate-commit) on a reconciled release. Null for prepared/applying, and for a release proved without an override.",
      plugin_id: "The plugin this attempt releases — the base subject's own plugin, written by release_prepare. Keys release_attempt_applying_plugin_idx: at most one applying attempt per plugin.",
      applied_by: "The principal whose release_apply moved this attempt to applying. release_record and release_verify accept that principal or a member of a required owner team, nobody else.",
      applying_at: "When release_apply moved this attempt to applying. An attempt still applying long after the CLI's own gate and release timeouts is stale: release_apply names it for reconciliation.",
    },
  },
};
