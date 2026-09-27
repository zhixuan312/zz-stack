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
      [
        "approved_doc_revision",
        "integer",
        true,
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
        // The composite key is what makes the pin mean something: a version that names document X
        // and revision N is held to a revision OF X, which the single-column key cannot say.
        // MATCH SIMPLE, so a version that pins nothing at all is admitted.
        columns: [
          "approved_doc_id",
          "approved_doc_revision",
        ],
        refTable: "doc_revision",
        refColumns: [
          "doc_id",
          "revision",
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
    // `approved_doc_revision` and its composite key landed in phase 6, with `doc_revision`.
    // The second check is NOT VALID on purpose: 16 affirmed versions predate the column, and
    // AC-6.7 leaves a legacy row unpinned rather than guessing a revision from a timestamp.
    // `NOT VALID` enforces it on every later insert and update while leaving those rows alone.
    checks: [
      "CHECK ((((approved_doc_id IS NULL) = (affirmed_by IS NULL)) AND ((approved_doc_id IS NULL) = (affirmed_at IS NULL))))",
      "CHECK (((affirmed_at IS NULL) OR (approved_doc_revision IS NOT NULL))) NOT VALID",
    ],
    indexes: [],
    comment: "class=state_machine; authority=this; question=what frozen, immutable definition of good does one plugin have at protocol version N, and has an approved protocol.md been bound to it yet?; transitions=recorded->affirmed",
    columnComments: {
      id: "class=state_machine; authority=this; question=which protocol version does every dimension, measure, document binding and published score name as the definition it was produced under?",
      version: "class=state_machine; authority=this; question=which ordinal is this version of the lineage, the number whose successor refuses to reuse it?",
      purpose: "class=state_machine; authority=this; question=which plugin purpose does this version measure against, the text whose change makes the version stale?",
      qualification_policy: "class=state_machine; authority=this; question=which thresholds and minimum qualification rung must an evaluator clear before its answers may back a score under this version?",
      scoring_policy: "class=state_machine; authority=this; question=which establishment rules, such as bootstrap and minimum measure coverage, and which uncertainty settings does scoring under this version follow?",
      improvement_policy: "class=state_machine; authority=this; question=what release policy does this version apply, now that the critical guardrails have moved onto the measures and evolvable has been dropped?",
      content_digest: "class=state_machine; authority=this; question=what is the sha256 of this version's canonical body, the digest an approved protocol.md must quote before the version may be affirmed?",
      created_at: "class=state_machine; authority=this; question=when was this protocol version recorded?",
      plugin_id: "class=relation; authority=this; question=which plugin is this protocol version for?",
      protocol_key: "class=state_machine; authority=this; question=what is the lineage's display name, shown next to the version number?",
      observable_surfaces: "class=state_machine; authority=this; question=which tool and evidence surfaces does this version cover, so a surface outside the set counts as new evidence and forces a new version?",
      approved_doc_id: "class=relation; authority=this; question=which approved protocol.md document is bound to this version?",
      affirmed_by: "class=state_machine; authority=this; question=which principal affirmed this version by binding the approved document?",
      affirmed_at: "class=state_machine; authority=this; question=when was this version affirmed?",
      recorded_by: "class=state_machine; authority=this; question=which principal recorded this version?",
      approved_doc_revision: "class=state_machine; authority=this; question=which revision of the approved protocol.md was affirmed, so the binding names exact bytes rather than a document that may have moved since?",
    },
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
    comment: "class=immutable_history; authority=this; question=within one protocol version, which canonical meaning counts, with what weight, whether it is required for establishment, and whether it is applicable at all?",
    columnComments: {
      id: "class=immutable_history; authority=this; question=which dimension does a measure, or a per-run dimension score, belong to?",
      protocol_version_id: "class=relation; authority=this; question=which protocol version does this dimension belong to?",
      key: "class=immutable_history; authority=this; question=what does this protocol call this dimension, the name its measures and the dashboard cite it by?",
      canonical_kind: "class=immutable_history; authority=this; question=which of the six canonical evaluation meanings does this dimension measure?",
      weight: "class=immutable_history; authority=this; question=how much of the version's weighted sum does this dimension carry?",
      required: "class=immutable_history; authority=this; question=must this dimension be established for the score to count under this version?",
      applicable: "class=immutable_history; authority=this; question=does this dimension apply to this protocol's subjects, or was it declared out of scope?",
      not_applicable_reason: "class=immutable_history; authority=this; question=why was this dimension declared not applicable, the rationale the check pairs with the flag?",
    },
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
    comment: "class=immutable_history; authority=this; question=within a dimension of one protocol version, which measure is answered by which evaluator mechanism, with what weight, and read by what rule?",
    columnComments: {
      id: "class=immutable_history; authority=this; question=which measure does an assessment, a finding or a qualification name?",
      dimension_id: "class=relation; authority=this; question=which dimension of the version does this measure belong to?",
      key: "class=immutable_history; authority=this; question=what is this measure's name within its protocol version, the key findings, guardrails and qualification all cite?",
      evaluator_type: "class=immutable_history; authority=this; question=which mechanism answers this measure — a stored fact, a recorded outcome, a bounded semantic question, a generative critic or a human?",
      weight: "class=immutable_history; authority=this; question=how much of its dimension's weighted sum does this measure carry?",
      required: "class=immutable_history; authority=this; question=must this measure be answered for its dimension to be established?",
      definition: "class=immutable_history; authority=this; question=how is this measure read — the normalisation, maximum, applicability rule, documents, whole-document flag and qualification anchors that stay per-mechanism — now that the fact path, subject kind and positive answer live in columns?",
      evaluator_version_id: "class=relation; authority=this; question=which frozen semantic question backs this model-driven measure?",
      protocol_version_id: "class=relation; authority=this; question=which protocol version does this measure belong to, denormalised so its key is unique within the version and the composite key to its dimension is expressible?",
      fact_key: "class=immutable_history; authority=this; question=which observation fact does this deterministic or outcome measure read?",
      subject_kind: "class=immutable_history; authority=this; question=which kind of reference does this model-backed measure judge — a run, a document, a knowledge node, a bug or an event?",
      guardrail_threshold: "class=immutable_history; authority=this; question=above what reduced value does this measure fail as a critical, non-compensatory guardrail?",
    },
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
    comment: "class=immutable_history; authority=this; question=what is the frozen wording and answer shape of one semantic question at version N, the exact question every assessment of it names?",
    columnComments: {
      id: "class=immutable_history; authority=this; question=which evaluator version does an assessment name as the exact question it was answered with?",
      version: "class=immutable_history; authority=this; question=which ordinal is this version of the evaluator under its stable key?",
      question: "class=immutable_history; authority=this; question=what instruction text does this evaluator version ask, the wording a model call must be shown verbatim?",
      answer_schema: "class=immutable_history; authority=this; question=what answer shape does this evaluator return — a noul, choice or score type, with its criteria map — so a reader can parse what the model said?",
      positive_answer: "class=immutable_history; authority=this; question=which answer counts as the good one, the polarity the reducer reads, null where the evaluator has no good side?",
      content_digest: "class=immutable_history; authority=this; question=what is the sha256 of the question, answer schema and positive answer, the digest an unchanged wording is reused by?",
      stable_key: "class=immutable_history; authority=this; question=what is this evaluator's identity across versions, by convention prefixed with the owning plugin?",
    },
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
    comment: "class=immutable_history; authority=this; question=was measure M's evaluator found to be qualified at state S, on what evidence, by whom and when, with the latest row winning?",
    columnComments: {
      id: "class=immutable_history; authority=this; question=which qualification row does an assessment cite as the rung in force when its answer was taken or skipped?",
      state: "class=immutable_history; authority=this; question=at which qualification rung did this run find the measure's evaluator?",
      evidence: "class=immutable_history; authority=this; question=what anchor, planted-fault, control, stability and label counts did this qualification run produce, each result carrying the assessment id behind it?",
      qualified_at: "class=immutable_history; authority=this; question=when was this qualification recorded, the timestamp that decides which row is latest?",
      measure_id: "class=relation; authority=this; question=which measure's known-answer anchors were run?",
      qualified_by: "class=immutable_history; authority=this; question=which principal ran this qualification?",
    },
  },
};
