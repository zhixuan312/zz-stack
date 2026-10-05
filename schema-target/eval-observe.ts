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
    comment: "class=immutable_history; authority=this; question=what did one plugin release's real runs look like in one resolved window, with the facts computed from them and the denominators those rates carry?; retention=unswept: one row per observation of one plugin version and nothing deletes one, so the table grows with every evaluation and is bounded only by the plugin versions anybody still looks at",
    columnComments: {
      id: "class=immutable_history; authority=this; question=which snapshot do evaluation runs, findings and failure-mode sightings name as their evidence?",
      usable_run_count: "class=immutable_history; authority=this; question=how many runs in the window count as usable evidence?",
      total_run_count: "class=immutable_history; authority=this; question=how many runs fell in the window at all, the denominator a minimum-runs rule is read against?",
      evidence_digest: "class=immutable_history; authority=this; question=what is the sha256 of this snapshot's canonical facts, the value a recompute is compared against to report drift?",
      created_at: "class=immutable_history; authority=this; question=when was this snapshot captured?",
      facts: "class=immutable_history; authority=this; question=which facts did computeObservation write for this snapshot — every ObservedFact of observe-facts.ts's OBSERVATION_FACT_KEYS, keyed by fact name, one entry of which a deterministic or outcome measure reads by its dotted definition.factPath — and is it null when the snapshot carries no computed facts, every such measure then answering excluded with a named reason?",
      plugin_version_id: "class=relation; authority=this; question=which released plugin version was observed?",
      window_from: "class=immutable_history; authority=this; question=from when does the observed window open, null when no window was resolved?",
      window_to: "class=immutable_history; authority=this; question=until when does the observed window run, null when no window was resolved?",
      surface_observed: "class=immutable_history; authority=this; question=how many of the plugin's declared tool surfaces did the window actually observe?",
      surface_total: "class=immutable_history; authority=this; question=how many surfaces were there to observe?",
      surface_source: "class=immutable_history; authority=this; question=where did the surface total come from, so a coverage figure can be trusted?",
      platform_version: "class=immutable_history; authority=this; question=which platform build produced this observation?",
      recorded_by: "class=immutable_history; authority=this; question=which principal ran this observation?",
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
    comment: "class=current_state; authority=this; question=which distinct failure modes does one plugin have, one row per stable key, with what canonical description?",
    columnComments: {
      id: "class=current_state; authority=this; question=which failure mode do its sightings and the protocol versions that fold it in point at?",
      plugin_id: "class=relation; authority=this; question=which plugin does this failure mode belong to?",
      stable_key: "class=current_state; authority=this; question=what identifies this failure mode within its plugin — the failing tool and refusal rule, or the two stages of a return?",
      description: "class=current_state; authority=this; question=what is the canonical description of this failure mode, as distinct from what one sighting counted?",
      created_at: "class=current_state; authority=this; question=when was this failure mode first identified?",
    },
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
    comment: "class=immutable_history; authority=this; question=what one failure mode was found to look like in one observation snapshot, how prevalent it was, and who it is owned by?; retention=bounded by the observation snapshots it is discovered against; append-only with no sweep, and a sighting is never deleted or rewritten",
    columnComments: {
      id: "class=immutable_history; authority=this; question=which sighting is this, the row its evidence and provenance hang from?",
      failure_mode_id: "class=relation; authority=this; question=which failure mode is this a sighting of?",
      observation_snapshot_id: "class=relation; authority=this; question=in which observation snapshot was this failure mode seen?",
      description: "class=immutable_history; authority=this; question=how was this failure mode described in this sighting, including the counts it was seen with?",
      prevalence_numerator: "class=immutable_history; authority=this; question=in how many groups of this snapshot was the failure mode seen?",
      prevalence_denominator: "class=immutable_history; authority=this; question=how many groups were there to see it in, so the rate can be re-derived rather than trusted?",
      owner_kind: "class=immutable_history; authority=this; question=which party does this sighting blame — the plugin, a dependency, the platform, the environment, user input or unknown?",
      owner_ref: "class=immutable_history; authority=this; question=which named owner does this sighting point at, where one is known?",
      ownership_reason: "class=immutable_history; authority=this; question=why was this ownership classification reached, especially where it is unknown?",
      confidence: "class=immutable_history; authority=this; question=how confident was the ownership classifier in this sighting?",
      assessment_id: "class=relation; authority=this; question=which model answer behind this ownership classification can be read?",
      description_model_call_id: "class=relation; authority=this; question=which generative-critic model call wrote this description?",
      evidence_refs: "class=immutable_history; authority=this; question=which representative events and initiatives are the evidence for this sighting?",
      discovered_by: "class=immutable_history; authority=this; question=which principal's DISCOVER call found this sighting?",
      discovery_key: "class=immutable_history; authority=this; question=under which idempotency key was this sighting written, so a replayed DISCOVER call recovers its own rows?",
      created_at: "class=immutable_history; authority=this; question=when was this sighting recorded?",
    },
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
    comment: "class=relation; authority=this; question=which failure modes does one protocol version fold into its lineage?",
    columnComments: {
      protocol_version_id: "class=relation; authority=this; question=which protocol version folds in this failure mode?",
      failure_mode_id: "class=relation; authority=this; question=which failure mode does this protocol version fold in?",
    },
  },
};
