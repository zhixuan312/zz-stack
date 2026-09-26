/**
 * Plugin evaluation: what good means — protocols, dimensions, measures and evaluators.
 */
import type { TableTarget } from "../scripts/schema/types.ts";

export const EVAL_PROTOCOL: Record<string, TableTarget> = {
  eval_protocol: {
    columns: [
      [
        "id",
        "uuid",
        false,
        "gen_random_uuid()",
      ],
      [
        "plugin_id",
        "uuid",
        false,
        null,
      ],
      [
        "protocol_key",
        "text",
        false,
        null,
      ],
    ],
    primaryKey: [
      "id",
    ],
    uniques: [
      [
        "plugin_id",
        "protocol_key",
      ],
    ],
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
    checks: [],
    indexes: [],
    comment: null,
    columnComments: {},
  },
  eval_protocol_version: {
    columns: [
      [
        "id",
        "uuid",
        false,
        "gen_random_uuid()",
      ],
      [
        "protocol_id",
        "uuid",
        false,
        null,
      ],
      [
        "version",
        "integer",
        false,
        null,
      ],
      [
        "subject_compatibility",
        "jsonb",
        false,
        null,
      ],
      [
        "purpose",
        "text",
        false,
        null,
      ],
      [
        "observable_surfaces",
        "jsonb",
        false,
        null,
      ],
      [
        "failure_taxonomy",
        "jsonb",
        false,
        null,
      ],
      [
        "suites",
        "jsonb",
        false,
        null,
      ],
      [
        "qualification_policy",
        "jsonb",
        false,
        null,
      ],
      [
        "scoring_policy",
        "jsonb",
        false,
        null,
      ],
      [
        "improvement_policy",
        "jsonb",
        false,
        null,
      ],
      [
        "content_digest",
        "text",
        false,
        null,
      ],
      [
        "approved_document_path",
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
    uniques: [
      [
        "protocol_id",
        "version",
      ],
    ],
    foreignKeys: [
      {
        columns: [
          "protocol_id",
        ],
        refTable: "eval_protocol",
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
  eval_dimension: {
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
        "key",
        "text",
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
        "canonical_kind",
        "text",
        false,
        null,
      ],
      [
        "weight",
        "numeric",
        false,
        null,
      ],
      [
        "required",
        "boolean",
        false,
        null,
      ],
      [
        "applicable",
        "boolean",
        false,
        "true",
      ],
      [
        "not_applicable_reason",
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
          "protocol_version_id",
        ],
        refTable: "eval_protocol_version",
        refColumns: [
          "id",
        ],
        onDelete: "NO ACTION",
        deferrable: false,
      },
    ],
    checks: [
      "CHECK ((canonical_kind = ANY (ARRAY['effectiveness'::text, 'reliability'::text, 'constraint_adherence'::text, 'recovery_robustness'::text, 'efficiency'::text, 'generalization'::text])))",
      "CHECK (((applicable AND (not_applicable_reason IS NULL)) OR ((NOT applicable) AND (not_applicable_reason IS NOT NULL))))",
    ],
    indexes: [],
    comment: null,
    columnComments: {},
  },
  eval_measure: {
    columns: [
      [
        "id",
        "uuid",
        false,
        "gen_random_uuid()",
      ],
      [
        "dimension_id",
        "uuid",
        false,
        null,
      ],
      [
        "key",
        "text",
        false,
        null,
      ],
      [
        "evaluator_type",
        "text",
        false,
        null,
      ],
      [
        "weight",
        "numeric",
        false,
        null,
      ],
      [
        "suite",
        "text",
        false,
        null,
      ],
      [
        "required",
        "boolean",
        false,
        null,
      ],
      [
        "definition",
        "jsonb",
        false,
        null,
      ],
      [
        "evaluator_version_id",
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
          "dimension_id",
        ],
        refTable: "eval_dimension",
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
    ],
    checks: [
      "CHECK (((evaluator_type <> ALL (ARRAY['bounded_semantic'::text, 'generative_critic'::text])) OR (evaluator_version_id IS NOT NULL)))",
      "CHECK ((evaluator_type = ANY (ARRAY['deterministic'::text, 'outcome'::text, 'bounded_semantic'::text, 'generative_critic'::text, 'human'::text])))",
      "CHECK ((suite = ANY (ARRAY['capability'::text, 'regression'::text, 'production'::text])))",
    ],
    indexes: [],
    comment: null,
    columnComments: {},
  },
  eval_evaluator: {
    columns: [
      [
        "id",
        "uuid",
        false,
        "gen_random_uuid()",
      ],
      [
        "stable_key",
        "text",
        false,
        null,
      ],
      [
        "kind",
        "text",
        false,
        null,
      ],
    ],
    primaryKey: [
      "id",
    ],
    uniques: [
      [
        "stable_key",
      ],
    ],
    foreignKeys: [],
    checks: [],
    indexes: [],
    comment: null,
    columnComments: {},
  },
  eval_evaluator_version: {
    columns: [
      [
        "id",
        "uuid",
        false,
        "gen_random_uuid()",
      ],
      [
        "evaluator_id",
        "uuid",
        false,
        null,
      ],
      [
        "version",
        "integer",
        false,
        null,
      ],
      [
        "question",
        "text",
        false,
        null,
      ],
      [
        "answer_schema",
        "jsonb",
        false,
        null,
      ],
      [
        "polarity",
        "jsonb",
        false,
        null,
      ],
      [
        "model_policy",
        "jsonb",
        false,
        null,
      ],
      [
        "content_digest",
        "text",
        false,
        null,
      ],
    ],
    primaryKey: [
      "id",
    ],
    uniques: [
      [
        "evaluator_id",
        "version",
      ],
    ],
    foreignKeys: [
      {
        columns: [
          "evaluator_id",
        ],
        refTable: "eval_evaluator",
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
  eval_evaluator_qualification: {
    columns: [
      [
        "id",
        "uuid",
        false,
        "gen_random_uuid()",
      ],
      [
        "evaluator_version_id",
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
        "subject_scope",
        "jsonb",
        false,
        null,
      ],
      [
        "state",
        "text",
        false,
        null,
      ],
      [
        "evidence",
        "jsonb",
        false,
        null,
      ],
      [
        "qualified_at",
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
          "protocol_version_id",
        ],
        refTable: "eval_protocol_version",
        refColumns: [
          "id",
        ],
        onDelete: "NO ACTION",
        deferrable: false,
      },
    ],
    checks: [
      "CHECK ((state = ANY (ARRAY['unqualified'::text, 'mechanically_qualified'::text, 'operationally_qualified'::text, 'human_calibrated'::text])))",
    ],
    indexes: [],
    comment: null,
    columnComments: {},
  },
};
