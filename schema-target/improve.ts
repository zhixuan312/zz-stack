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
        "eval_run_id",
        "uuid",
        false,
        null,
      ],
      [
        "kind",
        "text",
        false,
        null,
      ],
      [
        "pattern",
        "text",
        false,
        null,
      ],
      [
        "owner_kind",
        "text",
        false,
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
        "decision",
        "text",
        true,
        null,
      ],
      [
        "decided_by",
        "uuid",
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
        "superseded_by",
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
    ],
    primaryKey: [
      "id",
    ],
    uniques: [
      [
        "eval_run_id",
        "id",
      ],
    ],
    foreignKeys: [
      {
        columns: [
          "decided_by",
        ],
        refTable: "principal",
        refColumns: [
          "id",
        ],
        onDelete: "NO ACTION",
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
          "eval_run_id",
          "superseded_by",
        ],
        refTable: "eval_finding",
        refColumns: [
          "eval_run_id",
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
    ],
    checks: [
      "CHECK ((decision = ANY (ARRAY['applied'::text, 'rejected'::text, 'deferred'::text])))",
      "CHECK ((kind = ANY (ARRAY['strength'::text, 'defect'::text, 'unknown'::text])))",
      "CHECK (((kind = 'strength'::text) = (decision IS NULL)))",
      "CHECK ((owner_kind = ANY (ARRAY['plugin'::text, 'dependency'::text, 'platform'::text, 'environment'::text, 'user_input'::text, 'unknown'::text])))",
      "CHECK (((owner_kind <> 'plugin'::text) OR (owner_ref IS NULL)))",
      "CHECK (((eval_run_id IS NULL) OR (kind IS NOT NULL)))",
      "CHECK (((superseded_by IS NULL) OR (decision = 'rejected'::text)))",
    ],
    indexes: [
      "CREATE INDEX eval_finding_eval_run_id_idx ON zz.eval_finding USING btree (eval_run_id)",
    ],
    comment: null,
    columnComments: {
      decision_note: "Why it was applied or rejected. Empty while deferred -- the open state needs no reason, and the two closed ones do.",
      eval_run_id: "The run that concluded this finding (finding_record). Every finding names one, and the legacy round column it shared this table with went with the round tables.",
      kind: "strength | defect | unknown. A strength is terminal at insert — it is what is working, not open work, so its decision is null.",
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
    indexes: [
      "CREATE INDEX improvement_run_eval_run_id_created_at_idx ON zz.improvement_run USING btree (eval_run_id, created_at DESC)",
    ],
    comment: null,
    columnComments: {},
  },
  improvement_run_finding: {
    columns: [
      [
        "improvement_run_id",
        "uuid",
        false,
        null,
      ],
      [
        "finding_id",
        "uuid",
        false,
        null,
      ],
    ],
    primaryKey: [
      "improvement_run_id",
      "finding_id",
    ],
    uniques: [],
    foreignKeys: [
      {
        columns: [
          "finding_id",
        ],
        refTable: "eval_finding",
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
        onDelete: "CASCADE",
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
        "base_plugin_version_id",
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
        "patch",
        "text",
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
        "proposed_by",
        "uuid",
        false,
        null,
      ],
      [
        "proposer_client",
        "text",
        true,
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
          "base_plugin_version_id",
        ],
        refTable: "plugin_version",
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
      {
        columns: [
          "proposed_by",
        ],
        refTable: "principal",
        refColumns: [
          "id",
        ],
        onDelete: "NO ACTION",
        deferrable: false,
      },
    ],
    checks: [
      "CHECK ((status = ANY (ARRAY['recorded'::text, 'awaiting_build'::text, 'valid'::text, 'invalid'::text])))",
    ],
    indexes: [],
    comment: null,
    columnComments: {
      status: "recorded -> awaiting_build -> valid or invalid. The attempt states, released and rolled_back, live on release_attempt; a reader joins that row rather than reading a copy here.",
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
        "plugin_id",
        "uuid",
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
        "released_plugin_version_id",
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
        "verdict",
        "text",
        true,
        null,
      ],
      [
        "verified_at",
        "timestamp with time zone",
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
        "reason",
        "text",
        true,
        null,
      ],
      [
        "applied_by",
        "uuid",
        true,
        null,
      ],
      [
        "applying_at",
        "timestamp with time zone",
        true,
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
          "applied_by",
        ],
        refTable: "principal",
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
          "released_plugin_version_id",
        ],
        refTable: "plugin_version",
        refColumns: [
          "id",
        ],
        onDelete: "NO ACTION",
        deferrable: false,
      },
    ],
    checks: [
      "CHECK (((release_ref IS NULL) OR (release_ref ~ '^[0-9a-f]{40}$'::text)))",
      "CHECK (((status = ANY (ARRAY['released'::text, 'rolled_back'::text])) = (released_plugin_version_id IS NOT NULL)))",
      "CHECK ((status = ANY (ARRAY['prepared'::text, 'applying'::text, 'released'::text, 'refused'::text, 'failed'::text, 'rolled_back'::text])))",
      "CHECK ((verdict = ANY (ARRAY['established'::text, 'rolled_back'::text, 'not_established'::text])))",
    ],
    indexes: [
      "CREATE UNIQUE INDEX release_attempt_applying_plugin_idx ON zz.release_attempt USING btree (plugin_id) WHERE (status = 'applying'::text)",
      "CREATE UNIQUE INDEX release_attempt_live_candidate_idx ON zz.release_attempt USING btree (candidate_id) WHERE (status = ANY (ARRAY['applying'::text, 'released'::text]))",
    ],
    comment: null,
    columnComments: {
      verification: "The evidence the verdict rests on: {post_release_runs, released_eval_run_id, released_overall, base_eval_run_id, base_overall, delta, regression_band, guardrail_status}. Null until the released subject has enough real runs and an evaluation to judge. The verdict itself is the verdict column, and when it landed is verified_at.",
      reason: "Why this attempt ended as it did: releaseDecision's own reason on a refusal, the failing command's output tail (release_record) on a failure, the operator's reason on a rollback, or the accepted override (--reconcile --accept-tag-without-candidate-commit) on a reconciled release. Null for prepared/applying, and for a release proved without an override.",
      plugin_id: "The plugin this attempt releases — the base subject's own plugin, written by release_prepare. Keys release_attempt_applying_plugin_idx: at most one applying attempt per plugin.",
      applying_at: "When release_apply moved this attempt to applying. An attempt still applying long after the CLI's own gate and release timeouts is stale: release_apply names it for reconciliation.",
      applied_by: "The principal whose release_apply moved this attempt to applying. release_record and release_verify accept that principal or a member of a required owner team, nobody else.",
    },
  },
  release_attempt_owner: {
    columns: [
      [
        "release_attempt_id",
        "uuid",
        false,
        null,
      ],
      [
        "team_id",
        "uuid",
        false,
        null,
      ],
    ],
    primaryKey: [
      "release_attempt_id",
      "team_id",
    ],
    uniques: [],
    foreignKeys: [
      {
        columns: [
          "release_attempt_id",
        ],
        refTable: "release_attempt",
        refColumns: [
          "id",
        ],
        onDelete: "CASCADE",
        deferrable: false,
      },
      {
        columns: [
          "team_id",
        ],
        refTable: "team",
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
};
