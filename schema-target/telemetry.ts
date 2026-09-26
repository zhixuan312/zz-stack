/**
 * What the platform did: events, grouped skill runs, model calls and typed assessments.
 */
import type { TableTarget } from "../scripts/schema/types.ts";

export const TELEMETRY: Record<string, TableTarget> = {
  event: {
    columns: [
      [
        "id",
        "bigint",
        false,
        null,
      ],
      [
        "ts",
        "timestamp with time zone",
        false,
        "now()",
      ],
      [
        "actor",
        "text",
        false,
        null,
      ],
      [
        "team_slug",
        "text",
        true,
        null,
      ],
      [
        "kind",
        "text",
        false,
        null,
      ],
      [
        "subject",
        "text",
        false,
        "''::text",
      ],
      [
        "detail",
        "jsonb",
        false,
        "'{}'::jsonb",
      ],
      [
        "initiative",
        "text",
        true,
        null,
      ],
      [
        "flow",
        "text",
        true,
        null,
      ],
      [
        "step",
        "text",
        true,
        null,
      ],
      [
        "step_version",
        "text",
        true,
        null,
      ],
      [
        "ok",
        "boolean",
        true,
        null,
      ],
      [
        "refusal",
        "text",
        true,
        null,
      ],
      [
        "run_id",
        "uuid",
        true,
        null,
      ],
      [
        "team_id",
        "uuid",
        true,
        null,
      ],
      [
        "duration_ms",
        "integer",
        true,
        null,
      ],
      [
        "request_bytes",
        "integer",
        true,
        null,
      ],
      [
        "response_bytes",
        "integer",
        true,
        null,
      ],
      [
        "batched",
        "boolean",
        false,
        "false",
      ],
      [
        "plugin",
        "text",
        true,
        null,
      ],
      [
        "plugin_version",
        "text",
        true,
        null,
      ],
      [
        "tool_key",
        "text",
        true,
        null,
      ],
      [
        "refusal_owner",
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
    checks: [],
    indexes: [
      "CREATE INDEX event_initiative ON zz.event USING btree (team_slug, initiative) WHERE (initiative IS NOT NULL)",
      "CREATE INDEX event_kind_ts ON zz.event USING btree (kind, ts)",
      "CREATE INDEX event_refusal_owner_idx ON zz.event USING btree (refusal_owner) WHERE (ok = false)",
      "CREATE INDEX event_run ON zz.event USING btree (run_id) WHERE (run_id IS NOT NULL)",
      "CREATE INDEX event_step ON zz.event USING btree (step, step_version) WHERE (step IS NOT NULL)",
      "CREATE INDEX event_team_ts ON zz.event USING btree (team_slug, ts)",
    ],
    comment: null,
    columnComments: {
      initiative: "Join key to zz.doc and zz.decision. Carried forward per caller from the last call that named\n   one, because most calls do not take it as an argument.",
      flow: "The flow the call's initiative runs, as declared at initiative_open; empty for a call made outside any initiative. Not attribution: use plugin / plugin_version for which plugin owns this call.",
      step: "The skill this call was following, or NULL when none was. Never the empty string: `??` does not coalesce it, so an empty step reaches this column verbatim and is unjoinable to zz.skill while still looking like a value. Producers say unknown by omitting the field.",
      step_version: "The version declared by the skill that was served WHOLE, or NULL. A supporting file beside a skill carries no version, and that is recorded as NULL rather than as an empty string, for the same reason as step.",
      ok: "Whether the call worked, in the platform's own terms — never a transport status. An MCP\n   tool that refuses answers HTTP 200 with ERROR: in its text.",
      plugin: "Which plugin owns the skill the caller had loaded, resolved through zz.plugin_version_skill from currentStep() — never from flow_install and never from the x-zz-client header. Null when no skill was loaded, or the step names none that a plugin has released.",
      plugin_version: "The released version of `plugin` that shipped the skill version the caller was on. Null exactly when plugin is null.",
      tool_key: "The alias-resolved `<surface>:<tool>` name (Task I-2's resolver), so a row written after this column existed already reads as one series across a rename with no further lookup.",
    },
  },
  run: {
    columns: [
      [
        "id",
        "uuid",
        false,
        "gen_random_uuid()",
      ],
      [
        "initiative_id",
        "uuid",
        true,
        null,
      ],
      [
        "skill_version_id",
        "uuid",
        true,
        null,
      ],
      [
        "caller_session",
        "text",
        false,
        "''::text",
      ],
      [
        "turns",
        "integer",
        false,
        "0",
      ],
      [
        "calls",
        "integer",
        false,
        "0",
      ],
      [
        "refusals",
        "integer",
        false,
        "0",
      ],
      [
        "bytes_total",
        "bigint",
        true,
        null,
      ],
      [
        "started_at",
        "timestamp with time zone",
        false,
        "now()",
      ],
      [
        "ended_at",
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
        "initiative_id",
        "skill_version_id",
        "caller_session",
      ],
    ],
    foreignKeys: [
      {
        columns: [
          "initiative_id",
        ],
        refTable: "initiative",
        refColumns: [
          "id",
        ],
        onDelete: "CASCADE",
        deferrable: false,
      },
      {
        columns: [
          "skill_version_id",
        ],
        refTable: "skill_version",
        refColumns: [
          "id",
        ],
        onDelete: "NO ACTION",
        deferrable: false,
      },
    ],
    checks: [],
    indexes: [
      "CREATE UNIQUE INDEX run_no_initiative ON zz.run USING btree (skill_version_id, caller_session) WHERE (initiative_id IS NULL)",
      "CREATE INDEX run_skill_version ON zz.run USING btree (skill_version_id, started_at DESC)",
    ],
    comment: null,
    columnComments: {
      bytes_total: "Sum of response_bytes over the run's events. Null when no event in the run was measured — distinct from 0, which means measured and empty. Zeros written before migration 051 are ambiguous and were deliberately not converted.",
    },
  },
  model_call: {
    columns: [
      [
        "id",
        "bigint",
        false,
        null,
      ],
      [
        "ts",
        "timestamp with time zone",
        false,
        "now()",
      ],
      [
        "event_id",
        "bigint",
        true,
        null,
      ],
      [
        "plugin",
        "text",
        true,
        null,
      ],
      [
        "purpose",
        "text",
        false,
        null,
      ],
      [
        "model",
        "text",
        false,
        null,
      ],
      [
        "input_tokens",
        "integer",
        true,
        null,
      ],
      [
        "output_tokens",
        "integer",
        true,
        null,
      ],
      [
        "cache_read_tokens",
        "integer",
        true,
        null,
      ],
      [
        "duration_ms",
        "integer",
        true,
        null,
      ],
      [
        "ok",
        "boolean",
        false,
        null,
      ],
      [
        "attempts",
        "integer",
        false,
        "1",
      ],
      [
        "confidence",
        "numeric",
        true,
        null,
      ],
      [
        "note",
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
          "event_id",
        ],
        refTable: "event",
        refColumns: [
          "id",
        ],
        onDelete: "SET NULL",
        deferrable: false,
      },
    ],
    checks: [],
    indexes: [
      "CREATE INDEX model_call_failed_ts ON zz.model_call USING btree (ts DESC) WHERE (NOT ok)",
      "CREATE INDEX model_call_plugin_ts ON zz.model_call USING btree (plugin, ts)",
      "CREATE INDEX model_call_purpose_ts ON zz.model_call USING btree (purpose, ts)",
    ],
    comment: null,
    columnComments: {},
  },
  assessment: {
    columns: [
      [
        "id",
        "bigint",
        false,
        null,
      ],
      [
        "family",
        "text",
        true,
        null,
      ],
      [
        "instruction_version",
        "integer",
        false,
        null,
      ],
      [
        "question_digest",
        "text",
        false,
        null,
      ],
      [
        "reading",
        "text",
        true,
        null,
      ],
      [
        "probability",
        "numeric",
        true,
        null,
      ],
      [
        "requested_model",
        "text",
        true,
        null,
      ],
      [
        "resolved_model",
        "text",
        true,
        null,
      ],
      [
        "identity_assurance",
        "text",
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
        "initiative",
        "text",
        true,
        null,
      ],
      [
        "about",
        "text",
        true,
        null,
      ],
      [
        "asked_by",
        "text",
        false,
        null,
      ],
      [
        "asked_at",
        "timestamp with time zone",
        false,
        "now()",
      ],
      [
        "evaluator_version_id",
        "uuid",
        true,
        null,
      ],
      [
        "distribution",
        "jsonb",
        true,
        null,
      ],
      [
        "answer_kind",
        "text",
        false,
        "'noul'::text",
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
    ],
    checks: [
      "CHECK ((answer_kind = ANY (ARRAY['noul'::text, 'choice'::text, 'score'::text])))",
      "CHECK (((answer_kind <> ALL (ARRAY['choice'::text, 'score'::text])) OR (distribution IS NOT NULL) OR ((reading = 'unavailable'::text) AND (reason IS NOT NULL))))",
      "CHECK (((family IS NULL) OR ((reading IS NOT NULL) AND (answer_kind = 'noul'::text))))",
      "CHECK (((family IS NOT NULL) <> (evaluator_version_id IS NOT NULL)))",
      "CHECK ((reading = ANY (ARRAY['yes'::text, 'no'::text, 'unclear'::text, 'unavailable'::text])))",
    ],
    indexes: [
      "CREATE INDEX assessment_initiative_idx ON zz.assessment USING btree (initiative, asked_at)",
    ],
    comment: "Every semantic-assessment question the platform asked the typed service, with its provenance. A reading of unavailable carries its reason.",
    columnComments: {
      evaluator_version_id: "Set instead of family for a plugin-eval question. Exactly one of the two is non-null.",
      distribution: "The full answer distribution for a choice/score evaluator question. probability keeps carrying the noul probability.",
      answer_kind: "noul | choice | score — which typed-service primitive answered this question. Defaults to noul, so every row written before this migration reads as noul unchanged.",
    },
  },
};
