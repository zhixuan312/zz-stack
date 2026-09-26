/**
 * The durable control loop: which module governs an initiative, what it was told, and what was waived.
 */
import type { TableTarget } from "../scripts/schema/types.ts";

export const CONTROL: Record<string, TableTarget> = {
  control_run: {
    columns: [
      [
        "id",
        "uuid",
        false,
        "gen_random_uuid()",
      ],
      [
        "team_slug",
        "text",
        false,
        null,
      ],
      [
        "initiative",
        "text",
        false,
        null,
      ],
      [
        "module_id",
        "text",
        false,
        null,
      ],
      [
        "module_digest",
        "text",
        false,
        null,
      ],
      [
        "subject",
        "text",
        false,
        null,
      ],
      [
        "profile",
        "jsonb",
        false,
        "'[]'::jsonb",
      ],
      [
        "started_at",
        "timestamp with time zone",
        false,
        "now()",
      ],
      [
        "started_by",
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
        "team_slug",
        "initiative",
      ],
    ],
    foreignKeys: [],
    checks: [],
    indexes: [],
    comment: null,
    columnComments: {},
  },
  control_evidence: {
    columns: [
      [
        "seq",
        "bigint",
        false,
        "nextval('zz.control_evidence_seq_seq'::regclass)",
      ],
      [
        "run_id",
        "uuid",
        false,
        null,
      ],
      [
        "entry_id",
        "text",
        false,
        null,
      ],
      [
        "step_id",
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
      [
        "about",
        "text",
        false,
        null,
      ],
      [
        "note",
        "text",
        false,
        "''::text",
      ],
      [
        "recorded_at",
        "timestamp with time zone",
        false,
        "now()",
      ],
      [
        "recorded_by",
        "text",
        true,
        null,
      ],
      [
        "supersedes",
        "text",
        true,
        null,
      ],
    ],
    primaryKey: [
      "seq",
    ],
    uniques: [],
    foreignKeys: [
      {
        columns: [
          "run_id",
        ],
        refTable: "control_run",
        refColumns: [
          "id",
        ],
        onDelete: "CASCADE",
        deferrable: false,
      },
    ],
    checks: [],
    indexes: [
      "CREATE INDEX control_evidence_run_seq ON zz.control_evidence USING btree (run_id, seq)",
      "CREATE INDEX control_evidence_supersedes ON zz.control_evidence USING btree (run_id, supersedes) WHERE (supersedes IS NOT NULL)",
    ],
    comment: null,
    columnComments: {},
  },
  control_waiver: {
    columns: [
      [
        "seq",
        "bigint",
        false,
        "nextval('zz.control_waiver_seq_seq'::regclass)",
      ],
      [
        "run_id",
        "uuid",
        false,
        null,
      ],
      [
        "step_id",
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
      [
        "ground",
        "text",
        false,
        null,
      ],
      [
        "recorded_at",
        "timestamp with time zone",
        false,
        "now()",
      ],
      [
        "recorded_by",
        "text",
        true,
        null,
      ],
    ],
    primaryKey: [
      "seq",
    ],
    uniques: [],
    foreignKeys: [
      {
        columns: [
          "run_id",
        ],
        refTable: "control_run",
        refColumns: [
          "id",
        ],
        onDelete: "CASCADE",
        deferrable: false,
      },
    ],
    checks: [],
    indexes: [
      "CREATE INDEX control_waiver_run ON zz.control_waiver USING btree (run_id)",
    ],
    comment: null,
    columnComments: {},
  },
};
