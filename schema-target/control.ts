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
        "initiative_id",
        "uuid",
        false,
        null,
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
    comment: "class=current_state; authority=this; question=which initiative is enrolled in the control loop, and which reviewed module body did it enrol under?",
    columnComments: {
      id: "class=current_state; authority=this; question=what is this run's durable identity, the row its evidence and waivers hang from and cascade with?",
      module_digest: "class=current_state; authority=this; question=which module body it enrolled under, the one deliberate historical snapshot whose mismatch with today's module is what refuses a claim over an unreplayable history?",
      started_at: "class=current_state; authority=this; question=when was this initiative enrolled in the control loop?",
      initiative_id: "class=relation; authority=this; question=which initiative it governs, one row per initiative, cascading away with the initiative and sweeping the probe litter that matched none?",
      started_by: "class=current_state; authority=this; question=which principal enrolled it, null for the runs enrolled by the adoption script, which is not a principal?",
    },
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
    comment: "class=immutable_history; authority=this; question=what gate facts was a governed run told, in what order, against which module step, and which earlier entry a later one withdrew?",
    columnComments: {
      seq: "class=immutable_history; authority=this; question=in what order were this run's gate facts appended, the replay order the kernel reads them in?",
      run_id: "class=relation; authority=this; question=which governed run was told this fact?",
      entry_id: "class=immutable_history; authority=this; question=which fact is this — doc:<path>@v<n> for a document version, approval:<path>@v<n> for the version approved, or audit:<source path> — the identity the writer mints once per fact so unique (run_id, entry_id) holds?",
      step_id: "class=immutable_history; authority=this; question=which module step does this fact count for, a snapshot of the module's vocabulary at record time?",
      kind: "class=immutable_history; authority=this; question=is this fact a document write, an approval or an audit source, the fixed vocabulary the kernel branches on?",
      about: "class=immutable_history; authority=this; question=which document path does this document fact concern, or which entry id does this approval or audit fact concern, a same-run reference the writer derives from that path?",
      recorded_at: "class=immutable_history; authority=this; question=when was this fact recorded?",
      recorded_by: "class=immutable_history; authority=this; question=who recorded this fact, actor text whose values include the adoption script, which is not a principal?",
      supersedes: "class=immutable_history; authority=this; question=which earlier entry of this same run it withdraws, null when none stood, an FK that proves the withdrawal resolves inside the run and to a row that already exists?",
    },
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
    comment: "class=immutable_history; authority=this; question=which step's requirement did a person excuse on this run, and on what stated ground, never counting as evidence so the kernel still reports the gap?",
    columnComments: {
      seq: "class=immutable_history; authority=this; question=in what order were this run's waivers recorded?",
      run_id: "class=relation; authority=this; question=which governed run is this gap excused within, the run whose module digest pins the rules waived against?",
      step_id: "class=immutable_history; authority=this; question=which module step's requirement is excused?",
      kind: "class=immutable_history; authority=this; question=which requirement kind was excused — document, approval or audit — the same vocabulary evidence uses?",
      ground: "class=immutable_history; authority=this; question=on what stated ground did a person accept the missing step, never empty and the only place the reason is written down?",
      recorded_at: "class=immutable_history; authority=this; question=when was this waiver signed?",
      recorded_by: "class=immutable_history; authority=this; question=who signed it, actor text whose only value so far is the adoption script, which is not a principal?",
    },
  },
};
