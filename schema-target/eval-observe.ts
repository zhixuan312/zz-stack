/**
 * Plugin evaluation: what was observed — releases, snapshots and failure-mode sightings.
 */
import type { TableTarget } from "../scripts/schema/types.ts";

export const EVAL_OBSERVE: Record<string, TableTarget> = {
  eval_observation_snapshot: {
    columns: [
      [
        "id",
        "uuid",
        false,
        "gen_random_uuid()",
      ],
      [
        "usable_run_count",
        "integer",
        false,
        null,
      ],
      [
        "total_run_count",
        "integer",
        false,
        null,
      ],
      [
        "evidence_digest",
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
        "facts",
        "jsonb",
        true,
        null,
      ],
      [
        "plugin_version_id",
        "uuid",
        false,
        null,
      ],
      [
        "window_from",
        "timestamp with time zone",
        true,
        null,
      ],
      [
        "window_to",
        "timestamp with time zone",
        true,
        null,
      ],
      [
        "surface_observed",
        "integer",
        false,
        null,
      ],
      [
        "surface_total",
        "integer",
        false,
        null,
      ],
      [
        "surface_source",
        "text",
        true,
        null,
      ],
      [
        "platform_version",
        "text",
        false,
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
    uniques: [],
    foreignKeys: [
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
    // The release observed is a `plugin_version`; `subject_version_id` was a second name for it.
    // `production_window`, `coverage` and `runtime_identity` were three jsonb bags whose figures
    // `evaluation_score`'s coverage floor and `plugin_profile` read as columns. The window is
    // nullable because a snapshot that resolved none says so rather than inventing one.
    checks: [
      "CHECK ((usable_run_count <= total_run_count))",
      "CHECK ((window_from <= window_to))",
    ],
    indexes: [],
    comment: null,
    columnComments: {
      facts: "Every ObservedFact computeObservation wrote for this snapshot (observe-facts.ts's OBSERVATION_FACT_KEYS), keyed by fact name. Null when the snapshot carries no computed facts, and every deterministic/outcome measure against it then answers excluded with a named reason. A deterministic/outcome measure reads one entry by dotted definition.factPath.",
    },
  },
  eval_failure_mode: {
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
        "stable_key",
        "text",
        false,
        null,
      ],
      [
        "description",
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
    ],
    primaryKey: [
      "id",
    ],
    uniques: [
      [
        "plugin_id",
        "stable_key",
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
    // The identity of a failure mode: current state, one row per `(plugin, stable key)`. What was
    // found of it in one snapshot is a sighting, so nothing here moves when a later DISCOVER finds
    // the same mode again.
    checks: [],
    indexes: [],
    comment: null,
    columnComments: {},
  },
  eval_failure_mode_sighting: {
    columns: [
      [
        "id",
        "uuid",
        false,
        "gen_random_uuid()",
      ],
      [
        "failure_mode_id",
        "uuid",
        false,
        null,
      ],
      [
        "observation_snapshot_id",
        "uuid",
        false,
        null,
      ],
      [
        "description",
        "text",
        false,
        null,
      ],
      [
        "prevalence_numerator",
        "integer",
        false,
        null,
      ],
      [
        "prevalence_denominator",
        "integer",
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
        "ownership_reason",
        "text",
        true,
        null,
      ],
      [
        "confidence",
        "numeric",
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
        "description_model_call_id",
        "bigint",
        true,
        null,
      ],
      [
        "evidence_refs",
        "jsonb",
        false,
        null,
      ],
      [
        "discovered_by",
        "uuid",
        true,
        null,
      ],
      [
        "discovery_key",
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
          "description_model_call_id",
        ],
        refTable: "model_call",
        refColumns: [
          "id",
        ],
        onDelete: "NO ACTION",
        deferrable: false,
      },
      {
        columns: [
          "discovered_by",
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
          "failure_mode_id",
        ],
        refTable: "eval_failure_mode",
        refColumns: [
          "id",
        ],
        onDelete: "NO ACTION",
        deferrable: false,
      },
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
    ],
    // One finding of one failure mode in one snapshot: immutable history. The prevalence is two
    // figures rather than a rate so a reader can re-derive the rate, and the ownership is its own
    // columns rather than a status on the identity — a mode this run called a guardrail refusal
    // and a later run called a platform fault says both.
    checks: [
      "CHECK ((owner_kind = ANY (ARRAY['plugin'::text, 'dependency'::text, 'platform'::text, 'environment'::text, 'user_input'::text, 'unknown'::text])))",
      "CHECK ((prevalence_numerator <= prevalence_denominator))",
    ],
    indexes: [],
    comment: null,
    columnComments: {},
  },
  eval_protocol_failure_mode: {
    columns: [
      [
        "protocol_version_id",
        "uuid",
        false,
        null,
      ],
      [
        "failure_mode_id",
        "uuid",
        false,
        null,
      ],
    ],
    primaryKey: [
      "protocol_version_id",
      "failure_mode_id",
    ],
    uniques: [],
    foreignKeys: [
      {
        columns: [
          "failure_mode_id",
        ],
        refTable: "eval_failure_mode",
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
    // A protocol's lineage: which failure modes it folds in. It was a jsonb array of stable keys
    // on the version, which no reader could join.
    checks: [],
    indexes: [],
    comment: null,
    columnComments: {},
  },
};
