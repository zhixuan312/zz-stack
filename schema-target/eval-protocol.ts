/**
 * Plugin evaluation: what good means — protocols, dimensions, measures and evaluators.
 */
import type { TableTarget } from "../scripts/schema/types.ts";

export const EVAL_PROTOCOL: Record<string, TableTarget> = {
  eval_protocol_version: {
    columns: [
      [
        "id",
        "uuid",
        false,
        "gen_random_uuid()",
      ],
      [
        "version",
        "integer",
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
        "created_at",
        "timestamp with time zone",
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
        "protocol_key",
        "text",
        false,
        null,
      ],
      [
        "observable_surfaces",
        "text[]",
        false,
        null,
      ],
      [
        "approved_doc_id",
        "uuid",
        true,
        null,
      ],
      [
        "affirmed_by",
        "uuid",
        true,
        null,
      ],
      [
        "affirmed_at",
        "timestamp with time zone",
        true,
        null,
      ],
      [
        "recorded_by",
        "uuid",
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
        "version",
      ],
    ],
    foreignKeys: [
      {
        columns: [
          "affirmed_by",
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
          "approved_doc_id",
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
          "recorded_by",
        ],
        refTable: "principal",
        refColumns: [
          "id",
        ],
        onDelete: "NO ACTION",
        deferrable: false,
      },
    ],
    // The payload is immutable and the lifecycle is `recorded -> affirmed`: the affirmation
    // fields fill once and the three move together, which is the whole of this constraint.
    // `approved_doc_revision` and its composite key land in phase 6, with `doc_revision`.
    checks: [
      "CHECK ((((approved_doc_id IS NULL) = (affirmed_by IS NULL)) AND ((approved_doc_id IS NULL) = (affirmed_at IS NULL))))",
    ],
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
    uniques: [
      [
        "id",
        "protocol_version_id",
      ],
      [
        "protocol_version_id",
        "key",
      ],
    ],
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
      "CHECK (((weight >= (0)::numeric) AND (weight <= (1)::numeric)))",
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
      [
        "protocol_version_id",
        "uuid",
        false,
        null,
      ],
      [
        "fact_key",
        "text",
        true,
        null,
      ],
      [
        "subject_kind",
        "text",
        true,
        null,
      ],
      [
        "guardrail_threshold",
        "numeric",
        true,
        null,
      ],
    ],
    primaryKey: [
      "id",
    ],
    uniques: [
      [
        "protocol_version_id",
        "key",
      ],
    ],
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
    // `suite` is gone: which suite a measure belongs to was a second name for how it is
    // evaluated. The two biconditionals are the shape that replaces it — a measure reads a fact
    // exactly when it is deterministic or outcome-driven, and defers to an evaluator version
    // exactly when a model backs it.
    checks: [
      "CHECK (((evaluator_type <> ALL (ARRAY['bounded_semantic'::text, 'generative_critic'::text])) OR (evaluator_version_id IS NOT NULL)))",
      "CHECK ((evaluator_type = ANY (ARRAY['deterministic'::text, 'outcome'::text, 'bounded_semantic'::text, 'generative_critic'::text, 'human'::text])))",
      "CHECK (((evaluator_type = ANY (ARRAY['bounded_semantic'::text, 'generative_critic'::text])) = (evaluator_version_id IS NOT NULL)))",
      "CHECK (((evaluator_type = ANY (ARRAY['deterministic'::text, 'outcome'::text])) = (fact_key IS NOT NULL)))",
    ],
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
        "positive_answer",
        "text",
        true,
        null,
      ],
      [
        "content_digest",
        "text",
        false,
        null,
      ],
      [
        "stable_key",
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
        "content_digest",
      ],
      [
        "stable_key",
        "version",
      ],
    ],
    foreignKeys: [],
    // `evaluator` was a header holding only a stable key and a kind, and the kind was never read;
    // the key lives on the version now. `polarity` jsonb became the one answer that counts as
    // positive — null where an evaluator named none — and `model_policy` is gone with it.
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
      [
        "measure_id",
        "uuid",
        false,
        null,
      ],
      [
        "qualified_by",
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
          "qualified_by",
        ],
        refTable: "principal",
        refColumns: [
          "id",
        ],
        onDelete: "NO ACTION",
        deferrable: false,
      },
    ],
    // A qualification is about a measure: the evaluator version and the protocol version it was
    // run against are both reachable through `measure_id`, and `subject_scope` said only what the
    // measure already says. Each `evidence.results[]` entry carries its own `assessment_id`.
    checks: [
      "CHECK ((state = ANY (ARRAY['unqualified'::text, 'mechanically_qualified'::text, 'operationally_qualified'::text, 'human_calibrated'::text])))",
    ],
    indexes: [
      "CREATE INDEX eval_evaluator_qualification_measure_id_qualified_at_idx ON zz.eval_evaluator_qualification USING btree (measure_id, qualified_at DESC)",
    ],
    comment: null,
    columnComments: {},
  },
};
