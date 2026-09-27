/**
 * Plugin evaluation: what was scored — runs, their per-dimension results, their assessments and
 * the retry ledger.
 */
import type { TableTarget } from "../scripts/schema/types.ts";

export const EVAL_RUN: Record<string, TableTarget> = {
  eval_run: {
    columns: [
      [
        "id",
        "uuid",
        false,
        "gen_random_uuid()",
      ],
      [
        "protocol_version_id",
        "uuid",
        false,
        null,
      ],
      [
        "score_status",
        "text",
        true,
        null,
      ],
      [
        "overall_score",
        "numeric",
        true,
        null,
      ],
      [
        "guardrail_status",
        "text",
        true,
        null,
      ],
      [
        "created_at",
        "timestamp with time zone",
        false,
        null,
      ],
      [
        "team_id",
        "uuid",
        false,
        null,
      ],
      [
        "initiative_id",
        "uuid",
        true,
        null,
      ],
      [
        "observation_snapshot_id",
        "uuid",
        false,
        null,
      ],
      [
        "score_lower",
        "numeric",
        true,
        null,
      ],
      [
        "score_upper",
        "numeric",
        true,
        null,
      ],
      [
        "measure_coverage",
        "numeric",
        true,
        null,
      ],
      [
        "establishment_blocked_by",
        "text[]",
        true,
        null,
      ],
      [
        "scorer_version",
        "text",
        true,
        null,
      ],
      [
        "started_by",
        "uuid",
        false,
        null,
      ],
      [
        "scored_at",
        "timestamp with time zone",
        true,
        null,
      ],
    ],
    primaryKey: [
      "id",
    ],
    uniques: [
      [
        "id",
        "protocol_version_id",
      ],
    ],
    foreignKeys: [
      {
        columns: [
          "observation_snapshot_id",
        ],
        refTable: "eval_observation_snapshot",
        refColumns: [
          "id",
        ],
        onDelete: "NO ACTION",
        deferrable: false,
      },
      {
        columns: [
          "protocol_version_id",
        ],
        refTable: "eval_protocol_version",
        refColumns: [
          "id",
        ],
        onDelete: "NO ACTION",
        deferrable: false,
      },
      {
        columns: [
          "started_by",
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
          "team_id",
          "initiative_id",
        ],
        refTable: "initiative",
        refColumns: [
          "team_id",
          "id",
        ],
        onDelete: "NO ACTION",
        deferrable: false,
      },
    ],
    // The lifecycle is `created -> scored`, and `scored_at` is the terminal marker: the run
    // carries a score status exactly when it has one, and a scored run refuses every later
    // re-scoring or result rewrite. `evidence_snapshot_id` was a second name for the observation
    // snapshot, `subject_version_id` was the release the snapshot already names, `run_status`,
    // `score_interval`, `guardrails` and `coverage` became columns or rows, and
    // `dimension_scores` became `eval_run_dimension`.
    checks: [
      "CHECK ((guardrail_status = ANY (ARRAY['pass'::text, 'fail'::text, 'not_established'::text])))",
      "CHECK (((overall_score >= (0)::numeric) AND (overall_score <= (10)::numeric)))",
      "CHECK ((score_status = ANY (ARRAY['established'::text, 'provisional'::text, 'not_established'::text])))",
      "CHECK (((scored_at IS NULL) = (score_status IS NULL)))",
    ],
    indexes: [
      "CREATE INDEX eval_run_protocol_version_id_created_at_idx ON zz.eval_run USING btree (protocol_version_id, created_at DESC)",
    ],
    comment: null,
    columnComments: {},
  },
  eval_run_dimension: {
    columns: [
      [
        "eval_run_id",
        "uuid",
        false,
        null,
      ],
      [
        "protocol_version_id",
        "uuid",
        false,
        null,
      ],
      [
        "dimension_id",
        "uuid",
        false,
        null,
      ],
      [
        "score",
        "numeric",
        true,
        null,
      ],
      [
        "coverage",
        "numeric",
        true,
        null,
      ],
    ],
    primaryKey: [
      "eval_run_id",
      "dimension_id",
    ],
    uniques: [],
    foreignKeys: [
      {
        columns: [
          "dimension_id",
          "protocol_version_id",
        ],
        refTable: "eval_dimension",
        refColumns: [
          "id",
          "protocol_version_id",
        ],
        onDelete: "NO ACTION",
        deferrable: false,
      },
      {
        columns: [
          "eval_run_id",
          "protocol_version_id",
        ],
        refTable: "eval_run",
        refColumns: [
          "id",
          "protocol_version_id",
        ],
        onDelete: "NO ACTION",
        deferrable: false,
      },
    ],
    // A run's published per-dimension result, inserted exactly once when the run is scored and
    // never updated: the score a reader sees is the score the run published. `score` and
    // `coverage` are nullable — a dimension that was not applicable and a coverage that was not
    // measured have always been recorded as absent, never as zero.
    checks: [
      "CHECK (((coverage >= (0)::numeric) AND (coverage <= (1)::numeric)))",
      "CHECK (((score >= (0)::numeric) AND (score <= (10)::numeric)))",
    ],
    indexes: [],
    comment: null,
    columnComments: {},
  },
  eval_assessment: {
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
        "measure_id",
        "uuid",
        false,
        null,
      ],
      [
        "assessment_id",
        "bigint",
        true,
        null,
      ],
      [
        "qualification_id",
        "uuid",
        true,
        null,
      ],
      [
        "created_at",
        "timestamp with time zone",
        false,
        null,
      ],
      [
        "subject_kind",
        "text",
        false,
        null,
      ],
      [
        "run_id",
        "uuid",
        true,
        null,
      ],
      [
        "doc_id",
        "uuid",
        true,
        null,
      ],
      [
        "doc_revision",
        "integer",
        true,
        null,
      ],
      [
        "knowledge_node_id",
        "uuid",
        true,
        null,
      ],
      [
        "bug_id",
        "uuid",
        true,
        null,
      ],
      [
        "event_id",
        "bigint",
        true,
        null,
      ],
      [
        "value",
        "numeric",
        true,
        null,
      ],
      [
        "raw_value",
        "jsonb",
        true,
        null,
      ],
      [
        "numerator",
        "integer",
        true,
        null,
      ],
      [
        "denominator",
        "integer",
        true,
        null,
      ],
      [
        "excluded_reason",
        "text",
        true,
        null,
      ],
    ],
    primaryKey: [
      "id",
    ],
    uniques: [
      [
        "eval_run_id",
        "measure_id",
        "subject_kind",
        "run_id",
        "doc_id",
        "doc_revision",
        "knowledge_node_id",
        "bug_id",
        "event_id",
      ],
    ],
    foreignKeys: [
      {
        columns: [
          "assessment_id",
        ],
        refTable: "assessment",
        refColumns: [
          "id",
        ],
        onDelete: "NO ACTION",
        deferrable: false,
      },
      {
        columns: [
          "bug_id",
        ],
        refTable: "bug",
        refColumns: [
          "id",
        ],
        onDelete: "NO ACTION",
        deferrable: false,
      },
      {
        columns: [
          "doc_id",
        ],
        refTable: "doc",
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
          "event_id",
        ],
        refTable: "event",
        refColumns: [
          "id",
        ],
        onDelete: "NO ACTION",
        deferrable: false,
      },
      {
        columns: [
          "knowledge_node_id",
        ],
        refTable: "knowledge_node",
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
          "qualification_id",
        ],
        refTable: "eval_evaluator_qualification",
        refColumns: [
          "id",
        ],
        onDelete: "NO ACTION",
        deferrable: false,
      },
      {
        columns: [
          "run_id",
        ],
        refTable: "skill_run",
        refColumns: [
          "id",
        ],
        onDelete: "NO ACTION",
        deferrable: false,
      },
    ],
    // The typed subject. `subject_ref` was free text carrying six shapes; the kind and the one
    // child key it names replace it, and the kind-shape check is what makes the pair truthful:
    // `run_level` is about the parent run's own observation snapshot and names no child subject,
    // and each other kind names exactly one. `evaluator_version_id` is reachable through the
    // measure, `evidence_ref` named the run's own snapshot, and `answer` jsonb became the four
    // columns a reducer reads. `doc_revision` is pinned in phase 6, with `doc_revision` itself.
    checks: [
      "CHECK ((((subject_kind = 'run_level'::text) AND (run_id IS NULL) AND (doc_id IS NULL) AND (knowledge_node_id IS NULL) AND (bug_id IS NULL) AND (event_id IS NULL)) OR ((subject_kind = 'run'::text) AND (run_id IS NOT NULL) AND (doc_id IS NULL) AND (knowledge_node_id IS NULL) AND (bug_id IS NULL) AND (event_id IS NULL)) OR ((subject_kind = 'document'::text) AND (run_id IS NULL) AND (doc_id IS NOT NULL) AND (knowledge_node_id IS NULL) AND (bug_id IS NULL) AND (event_id IS NULL)) OR ((subject_kind = 'knowledge'::text) AND (run_id IS NULL) AND (doc_id IS NULL) AND (knowledge_node_id IS NOT NULL) AND (bug_id IS NULL) AND (event_id IS NULL)) OR ((subject_kind = 'bug'::text) AND (run_id IS NULL) AND (doc_id IS NULL) AND (knowledge_node_id IS NULL) AND (bug_id IS NOT NULL) AND (event_id IS NULL)) OR ((subject_kind = 'event'::text) AND (run_id IS NULL) AND (doc_id IS NULL) AND (knowledge_node_id IS NULL) AND (bug_id IS NULL) AND (event_id IS NOT NULL))))",
      "CHECK (((value IS NULL) = (excluded_reason IS NOT NULL)))",
    ],
    indexes: [
      "CREATE INDEX eval_assessment_eval_run_id_idx ON zz.eval_assessment USING btree (eval_run_id)",
    ],
    comment: null,
    columnComments: {},
  },
  eval_idempotency: {
    columns: [
      [
        "tool",
        "text",
        false,
        null,
      ],
      [
        "idempotency_key",
        "text",
        false,
        null,
      ],
      [
        "request_digest",
        "text",
        false,
        null,
      ],
      [
        "result_table",
        "text",
        false,
        null,
      ],
      [
        "result_id",
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
      [
        "principal_id",
        "uuid",
        false,
        null,
      ],
    ],
    primaryKey: [
      "principal_id",
      "tool",
      "idempotency_key",
    ],
    uniques: [],
    foreignKeys: [
      {
        columns: [
          "principal_id",
        ],
        refTable: "principal",
        refColumns: [
          "id",
        ],
        onDelete: "NO ACTION",
        deferrable: false,
      },
    ],
    // Ephemeral, swept after 30 days, and keyed to the principal that made the call rather than
    // to the address it was made from.
    checks: [],
    indexes: [],
    comment: null,
    columnComments: {},
  },
};
