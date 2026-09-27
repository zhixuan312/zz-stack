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
      [
        "actor_id",
        "uuid",
        true,
        null,
      ],
      [
        "initiative_id",
        "uuid",
        true,
        null,
      ],
      [
        "session",
        "text",
        false,
        "''::text",
      ],
      [
        "skill_version_id",
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
          "actor_id",
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
          "initiative_id",
        ],
        refTable: "initiative",
        refColumns: [
          "id",
        ],
        onDelete: "SET NULL",
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
        onDelete: "SET NULL",
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
        onDelete: "SET NULL",
        onDeleteColumns: [
          "initiative_id",
        ],
        deferrable: false,
      },
      {
        columns: [
          "team_id",
          "run_id",
        ],
        refTable: "skill_run",
        refColumns: [
          "team_id",
          "id",
        ],
        onDelete: "SET NULL",
        onDeleteColumns: [
          "run_id",
        ],
        deferrable: false,
      },
    ],
    checks: [
      "CHECK (((initiative_id IS NULL) OR (team_id IS NOT NULL)))",
      "CHECK ((kind ~ '^[a-z_]+(\\.[a-z_]+)?$'::text))",
      "CHECK (((refusal_owner IS NULL) OR ((refusal_owner = ANY (ARRAY['guardrail'::text, 'ours'::text, 'theirs'::text, 'other'::text])) AND (ok = false))))",
      "CHECK (((run_id IS NULL) OR (team_id IS NOT NULL)))",
      "CHECK (((kind <> 'tool_call'::text) OR ((ok IS NOT NULL) AND (tool_key IS NOT NULL))))",
    ],
    indexes: [
      "CREATE INDEX event_kind_ts ON zz.event USING btree (kind, ts)",
      "CREATE INDEX event_refusal_owner_idx ON zz.event USING btree (refusal_owner) WHERE (ok = false)",
      "CREATE INDEX event_run ON zz.event USING btree (run_id) WHERE (run_id IS NOT NULL)",
    ],
    comment: null,
    columnComments: {
      ok: "Whether the call worked, in the platform's own terms — never a transport status. An MCP\n   tool that refuses answers HTTP 200 with ERROR: in its text.",
      plugin: "Which plugin owns the skill the caller had loaded, resolved through zz.plugin_version_skill from currentStep() — never from flow_install and never from the x-zz-client header. Null when no skill was loaded, or the step names none that a plugin has released.",
      plugin_version: "The released version of `plugin` that shipped the skill version the caller was on. Null exactly when plugin is null.",
      tool_key: "The alias-resolved `<surface>:<tool>` name (Task I-2's resolver), so a row written after this column existed already reads as one series across a rename with no further lookup.",
    },
  },
  skill_run: {
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
        false,
        null,
      ],
      [
        "session",
        "text",
        false,
        "''::text",
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
        false,
        null,
      ],
      [
        "team_id",
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
        "initiative_id",
        "skill_version_id",
        "session",
      ],
      [
        "team_id",
        "id",
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
        onDelete: "CASCADE",
        deferrable: false,
      },
    ],
    checks: [
      "CHECK ((ended_at >= started_at))",
      "CHECK (((0 <= refusals) AND (refusals <= calls)))",
    ],
    indexes: [
      "CREATE INDEX run_skill_version ON zz.skill_run USING btree (skill_version_id, started_at DESC)",
      "CREATE UNIQUE INDEX skill_run_identity ON zz.skill_run USING btree (team_id, initiative_id, skill_version_id, session) NULLS NOT DISTINCT",
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
        "error",
        "text",
        true,
        null,
      ],
    ],
    primaryKey: [
      "id",
    ],
    uniques: [],
    foreignKeys: [],
    checks: [
      "CHECK (((error IS NULL) OR (NOT ok)))",
    ],
    indexes: [
      "CREATE INDEX model_call_failed_ts ON zz.model_call USING btree (ts DESC) WHERE (NOT ok)",
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
        "about",
        "text",
        true,
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
        "model_call_id",
        "bigint",
        true,
        null,
      ],
      [
        "asked_by",
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
          "asked_by",
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
          "model_call_id",
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
          "team_id",
        ],
        refTable: "team",
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
        onDelete: "SET NULL",
        onDeleteColumns: [
          "initiative_id",
        ],
        deferrable: false,
      },
    ],
    checks: [
      "CHECK ((answer_kind = ANY (ARRAY['noul'::text, 'choice'::text, 'score'::text])))",
      "CHECK (((answer_kind <> ALL (ARRAY['choice'::text, 'score'::text])) OR (distribution IS NOT NULL) OR ((reading = 'unavailable'::text) AND (reason IS NOT NULL))))",
      "CHECK (((family IS NULL) OR ((reading IS NOT NULL) AND (answer_kind = 'noul'::text))))",
      "CHECK (((family IS NOT NULL) <> (evaluator_version_id IS NOT NULL)))",
      "CHECK ((reading = ANY (ARRAY['yes'::text, 'no'::text, 'unclear'::text, 'unavailable'::text])))",
      "CHECK (((reading = 'unavailable'::text) = (reason IS NOT NULL)))",
    ],
    indexes: [],
    comment: "Every semantic-assessment question the platform asked the typed service, with its provenance. A reading of unavailable carries its reason.",
    columnComments: {
      evaluator_version_id: "Set instead of family for a plugin-eval question. Exactly one of the two is non-null.",
      distribution: "The full answer distribution for a choice/score evaluator question. probability keeps carrying the noul probability.",
      answer_kind: "noul | choice | score — which typed-service primitive answered this question. Defaults to noul, so every row written before this migration reads as noul unchanged.",
    },
  },
};
