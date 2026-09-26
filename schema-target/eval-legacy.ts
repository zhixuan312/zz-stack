/**
 * The legacy evaluation rounds, superseded by the plugin-eval family.
 */
import type { TableTarget } from "../scripts/schema/types.ts";

export const EVAL_LEGACY: Record<string, TableTarget> = {
  rubric: {
    columns: [
      [
        "id",
        "uuid",
        false,
        "gen_random_uuid()",
      ],
      [
        "version",
        "text",
        false,
        null,
      ],
      [
        "derived_from_eval",
        "uuid",
        true,
        null,
      ],
      [
        "approved_by",
        "text",
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
        "subject",
        "text",
        false,
        "'auto'::text",
      ],
      [
        "plugin_id",
        "uuid",
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
          "plugin_id",
        ],
        refTable: "plugin",
        refColumns: [
          "id",
        ],
        onDelete: "NO ACTION",
        deferrable: false,
      },
    ],
    checks: [
      "CHECK ((subject = ANY (ARRAY['auto'::text, 'document'::text, 'trace'::text, 'initiative'::text])))",
    ],
    indexes: [
      "CREATE UNIQUE INDEX rubric_plugin_id_version_key ON zz.rubric USING btree (plugin_id, version)",
    ],
    comment: null,
    columnComments: {
      subject: "What this ruler is applied to: the documents the subject produced, its run traces, or auto — documents where they exist and traces otherwise.",
    },
  },
  rubric_dimension: {
    columns: [
      [
        "id",
        "uuid",
        false,
        "gen_random_uuid()",
      ],
      [
        "rubric_id",
        "uuid",
        false,
        null,
      ],
      [
        "name",
        "text",
        false,
        null,
      ],
      [
        "five_means",
        "text",
        false,
        null,
      ],
      [
        "one_means",
        "text",
        false,
        null,
      ],
      [
        "ordinal",
        "integer",
        false,
        "0",
      ],
      [
        "kind",
        "text",
        false,
        "'qualitative'::text",
      ],
      [
        "threshold",
        "text",
        false,
        "''::text",
      ],
      [
        "threshold_reason",
        "text",
        false,
        "''::text",
      ],
      [
        "levels",
        "text[]",
        true,
        null,
      ],
      [
        "reads",
        "text[]",
        false,
        "'{}'::text[]",
      ],
    ],
    primaryKey: [
      "id",
    ],
    uniques: [
      [
        "rubric_id",
        "name",
      ],
    ],
    foreignKeys: [
      {
        columns: [
          "rubric_id",
        ],
        refTable: "rubric",
        refColumns: [
          "id",
        ],
        onDelete: "NO ACTION",
        deferrable: false,
      },
    ],
    checks: [
      "CHECK ((kind = ANY (ARRAY['qualitative'::text, 'quantitative'::text])))",
    ],
    indexes: [],
    comment: null,
    columnComments: {
      reads: "Dotted paths into the facts sheet plugin_profile produces, e.g. record.revised_with_evidence_pct. Empty for a qualitative dimension, which reads the artifact instead. A quantitative dimension whose paths are not on the sheet cannot be measured, and is refused at ruler_record.",
    },
  },
  eval: {
    columns: [
      [
        "id",
        "uuid",
        false,
        "gen_random_uuid()",
      ],
      [
        "rubric_id",
        "uuid",
        false,
        null,
      ],
      [
        "judge_model",
        "text",
        false,
        "''::text",
      ],
      [
        "selection_note",
        "text",
        false,
        "''::text",
      ],
      [
        "doc_count",
        "integer",
        false,
        "0",
      ],
      [
        "started_at",
        "timestamp with time zone",
        false,
        "now()",
      ],
      [
        "finished_at",
        "timestamp with time zone",
        true,
        null,
      ],
      [
        "is_control",
        "boolean",
        false,
        "false",
      ],
      [
        "plugin_version_id",
        "uuid",
        false,
        null,
      ],
      [
        "controls",
        "uuid",
        true,
        null,
      ],
      [
        "initiative",
        "text",
        true,
        null,
      ],
      [
        "team_slug",
        "text",
        true,
        null,
      ],
      [
        "effectiveness",
        "numeric",
        true,
        null,
      ],
      [
        "headroom_points",
        "numeric",
        true,
        null,
      ],
      [
        "headroom_named",
        "integer",
        true,
        null,
      ],
      [
        "headroom_state",
        "text",
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
          "controls",
        ],
        refTable: "eval",
        refColumns: [
          "id",
        ],
        onDelete: "SET NULL",
        deferrable: false,
      },
      {
        columns: [
          "plugin_version_id",
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
          "rubric_id",
        ],
        refTable: "rubric",
        refColumns: [
          "id",
        ],
        onDelete: "NO ACTION",
        deferrable: false,
      },
    ],
    checks: [],
    indexes: [
      "CREATE INDEX eval_controls_idx ON zz.eval USING btree (controls) WHERE (controls IS NOT NULL)",
      "CREATE INDEX eval_latest_for_plugin_idx ON zz.eval USING btree (plugin_version_id, started_at DESC) WHERE ((NOT is_control) AND (headroom_state IS NOT NULL))",
    ],
    comment: null,
    columnComments: {
      initiative: "The initiative this round was run inside — stamped by round_judge from its caller, never inferred from a name or a date. Null on rounds taken before migration 067.",
      effectiveness: "0-10, as judge-score.ts computed it at round_recommend. Null when the round was void (a collapsed control), and null on rounds taken before migration 067.",
      headroom_state: "One of: no change needed, change identified, unexplained gap, not measured. The second axis. It reports what the evidence says about the gap and prescribes nothing — whether a change CAN be made is not something a score establishes.",
    },
  },
  eval_subject: {
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
        false,
        null,
      ],
      [
        "team_id",
        "uuid",
        true,
        null,
      ],
      [
        "initiative_slug",
        "text",
        false,
        null,
      ],
      [
        "path",
        "text",
        true,
        null,
      ],
      [
        "content_hash",
        "text",
        false,
        "''::text",
      ],
      [
        "git_commit",
        "text",
        false,
        "''::text",
      ],
      [
        "doc_id",
        "uuid",
        true,
        null,
      ],
      [
        "evaluated_at",
        "timestamp with time zone",
        false,
        "now()",
      ],
      [
        "run_id",
        "uuid",
        true,
        null,
      ],
      [
        "plugin_version_id",
        "uuid",
        true,
        null,
      ],
    ],
    primaryKey: [
      "id",
    ],
    uniques: [
      [
        "eval_id",
        "initiative_slug",
        "path",
      ],
    ],
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
          "plugin_version_id",
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
          "run_id",
        ],
        refTable: "run",
        refColumns: [
          "id",
        ],
        onDelete: "SET NULL",
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
    checks: [
      "CHECK ((((path IS NOT NULL) AND (run_id IS NULL)) OR ((path IS NULL) AND (run_id IS NOT NULL))))",
    ],
    indexes: [
      "CREATE INDEX eval_subject_doc ON zz.eval_subject USING btree (initiative_slug, path)",
    ],
    comment: null,
    columnComments: {
      run_id: "The window of work judged, when a skill produces no document. Exactly one of path/run_id.",
    },
  },
  eval_score: {
    columns: [
      [
        "eval_id",
        "uuid",
        false,
        null,
      ],
      [
        "subject_id",
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
        "numeric(2,1)",
        false,
        null,
      ],
      [
        "quote",
        "text",
        false,
        "''::text",
      ],
      [
        "reason",
        "text",
        false,
        "''::text",
      ],
      [
        "is_control",
        "boolean",
        false,
        "false",
      ],
      [
        "confidence",
        "numeric",
        true,
        null,
      ],
      [
        "probabilities",
        "jsonb",
        true,
        null,
      ],
    ],
    primaryKey: [
      "eval_id",
      "subject_id",
      "dimension_id",
      "is_control",
    ],
    uniques: [],
    foreignKeys: [
      {
        columns: [
          "dimension_id",
        ],
        refTable: "rubric_dimension",
        refColumns: [
          "id",
        ],
        onDelete: "NO ACTION",
        deferrable: false,
      },
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
          "subject_id",
        ],
        refTable: "eval_subject",
        refColumns: [
          "id",
        ],
        onDelete: "CASCADE",
        deferrable: false,
      },
    ],
    checks: [
      "CHECK (((score >= (1)::numeric) AND (score <= (5)::numeric)))",
    ],
    indexes: [],
    comment: null,
    columnComments: {
      score: "One dimension, 1.0-5.0. Halves allowed: a judge who means 4.5 must not be recorded as 5.",
    },
  },
};
