/**
 * Plugin evaluation: what was observed — subject versions, snapshots and failure-mode sightings.
 */
import type { TableTarget } from "../scripts/schema/types.ts";

export const EVAL_OBSERVE: Record<string, TableTarget> = {
  eval_subject_version: {
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
        "declared_version",
        "text",
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
        "component_manifest",
        "jsonb",
        false,
        null,
      ],
      [
        "source_locator",
        "jsonb",
        false,
        null,
      ],
      [
        "release_identity",
        "jsonb",
        false,
        null,
      ],
      [
        "captured_at",
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
        "declared_version",
        "content_digest",
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
  eval_observation_snapshot: {
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
        "production_window",
        "jsonb",
        false,
        null,
      ],
      [
        "coverage",
        "jsonb",
        false,
        null,
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
        "runtime_identity",
        "jsonb",
        false,
        null,
      ],
      [
        "environment_digest",
        "text",
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
    ],
    primaryKey: [
      "id",
    ],
    uniques: [],
    foreignKeys: [
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
    checks: [],
    indexes: [],
    comment: null,
    columnComments: {
      facts: "Every ObservedFact computeObservation wrote for this snapshot (observe-facts.ts's OBSERVATION_FACT_KEYS), keyed by fact name. Null when the snapshot carries no computed facts, and every deterministic/outcome measure against it then answers excluded with a named reason. A deterministic/outcome measure reads one entry by dotted definition.factPath.",
    },
  },
  eval_evidence_snapshot: {
    columns: [
      [
        "id",
        "uuid",
        false,
        "gen_random_uuid()",
      ],
      [
        "observation_snapshot_id",
        "uuid",
        false,
        null,
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
        "coverage",
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
    ],
    primaryKey: [
      "id",
    ],
    uniques: [
      [
        "observation_snapshot_id",
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
    checks: [],
    indexes: [],
    comment: null,
    columnComments: {},
  },
  eval_failure_mode_candidate: {
    columns: [
      [
        "id",
        "uuid",
        false,
        "gen_random_uuid()",
      ],
      [
        "observation_snapshot_id",
        "uuid",
        false,
        null,
      ],
      [
        "stable_key",
        "text",
        true,
        null,
      ],
      [
        "description",
        "text",
        false,
        null,
      ],
      [
        "prevalence",
        "jsonb",
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
        "confidence",
        "numeric",
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
        "status",
        "text",
        false,
        null,
      ],
      [
        "merged_into_id",
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
    ],
    primaryKey: [
      "id",
    ],
    uniques: [],
    foreignKeys: [
      {
        columns: [
          "merged_into_id",
        ],
        refTable: "eval_failure_mode_candidate",
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
    checks: [
      "CHECK ((owner_kind = ANY (ARRAY['plugin'::text, 'dependency'::text, 'platform'::text, 'environment'::text, 'user_input'::text, 'unknown'::text])))",
      "CHECK ((status = ANY (ARRAY['candidate'::text, 'accepted'::text, 'rejected'::text, 'merged'::text])))",
    ],
    indexes: [],
    comment: null,
    columnComments: {},
  },
};
