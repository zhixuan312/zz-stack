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
        "initiative_id",
        "uuid",
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
        "started_at",
        "timestamp with time zone",
        false,
        "now()",
      ],
      [
        "started_by",
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
        "initiative_id",
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
          "started_by",
        ],
        refTable: "principal",
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
    uniques: [
      [
        "run_id",
        "entry_id",
      ],
    ],
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
      {
        columns: [
          "run_id",
          "supersedes",
        ],
        refTable: "control_evidence",
        refColumns: [
          "run_id",
          "entry_id",
        ],
        onDelete: "NO ACTION",
        deferrable: false,
      },
    ],
    checks: [
      "CHECK ((kind = ANY (ARRAY['document'::text, 'approval'::text, 'audit'::text])))",
    ],
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
    uniques: [
      [
        "run_id",
        "step_id",
        "kind",
      ],
    ],
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
    checks: [
      "CHECK ((btrim(ground) <> ''::text))",
      "CHECK ((kind = ANY (ARRAY['document'::text, 'approval'::text, 'audit'::text])))",
    ],
    indexes: [
      "CREATE INDEX control_waiver_run ON zz.control_waiver USING btree (run_id)",
    ],
    comment: null,
    columnComments: {},
  },
};
