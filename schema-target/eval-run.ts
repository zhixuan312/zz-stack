/**
 * Plugin evaluation: what was scored — runs, their assessments, and the retry ledger.
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
        "subject_version_id",
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
        "evidence_snapshot_id",
        "uuid",
        false,
        null,
      ],
      [
        "run_status",
        "text",
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
        "score_interval",
        "jsonb",
        true,
        null,
      ],
      [
        "dimension_scores",
        "jsonb",
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
        "coverage",
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
      [
        "guardrails",
        "jsonb",
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
          "evidence_snapshot_id",
        ],
        refTable: "eval_evidence_snapshot",
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
          "subject_version_id",
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
      "CHECK ((guardrail_status = ANY (ARRAY['pass'::text, 'fail'::text, 'not_established'::text])))",
      "CHECK ((run_status = ANY (ARRAY['pending'::text, 'running'::text, 'completed'::text, 'failed'::text, 'cancelled'::text])))",
      "CHECK ((score_status = ANY (ARRAY['established'::text, 'provisional'::text, 'not_established'::text])))",
    ],
    indexes: [],
    comment: null,
    columnComments: {
      guardrails: "evaluateGuardrails() output for this run's protocol.improvement.criticalGuardrails: [{key, threshold, value, status}]. guardrail_status is the reduced pass/fail/not_established this column explains.",
    },
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
        "evaluator_version_id",
        "uuid",
        true,
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
        "subject_ref",
        "text",
        false,
        null,
      ],
      [
        "evidence_ref",
        "text",
        false,
        null,
      ],
      [
        "answer",
        "jsonb",
        false,
        null,
      ],
      [
        "policy_version",
        "text",
        false,
        null,
      ],
      [
        "resulting_action",
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
    ],
    primaryKey: [
      "id",
    ],
    uniques: [],
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
          "evaluator_version_id",
        ],
        refTable: "eval_evaluator_version",
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
    ],
    checks: [],
    indexes: [],
    comment: null,
    columnComments: {},
  },
  eval_idempotency: {
    columns: [
      [
        "principal",
        "text",
        false,
        null,
      ],
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
    ],
    primaryKey: [
      "principal",
      "tool",
      "idempotency_key",
    ],
    uniques: [],
    foreignKeys: [],
    checks: [],
    indexes: [],
    comment: null,
    columnComments: {},
  },
};
