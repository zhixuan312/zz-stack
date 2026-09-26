/**
 * The delivery record: initiatives, their documents and facts, and bugs.
 */
import type { TableTarget } from "../scripts/schema/types.ts";

export const DELIVERY: Record<string, TableTarget> = {
  initiative: {
    columns: [
      [
        "id",
        "uuid",
        false,
        "gen_random_uuid()",
      ],
      [
        "team_id",
        "uuid",
        false,
        null,
      ],
      [
        "slug",
        "text",
        false,
        null,
      ],
      [
        "flow",
        "text",
        true,
        null,
      ],
      [
        "opened_at",
        "timestamp with time zone",
        false,
        "now()",
      ],
      [
        "opened_by",
        "uuid",
        true,
        null,
      ],
      [
        "closed_at",
        "timestamp with time zone",
        true,
        null,
      ],
      [
        "closed_by",
        "uuid",
        true,
        null,
      ],
      [
        "outcome",
        "text",
        true,
        null,
      ],
      [
        "accepted_by",
        "text",
        true,
        null,
      ],
      [
        "no_signoff_reason",
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
        "team_id",
        "id",
      ],
      [
        "team_id",
        "slug",
      ],
    ],
    foreignKeys: [
      {
        columns: [
          "closed_by",
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
          "opened_by",
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
    checks: [
      "CHECK (((outcome <> 'accepted'::text) OR (accepted_by IS NOT NULL)))",
      "CHECK ((((closed_at IS NULL) = (outcome IS NULL)) AND ((closed_at IS NULL) = (closed_by IS NULL))))",
      "CHECK (((outcome IS NULL) OR (outcome = ANY (ARRAY['accepted'::text, 'delivered'::text, 'abandoned'::text]))))",
      "CHECK (((accepted_by IS NULL) OR (no_signoff_reason IS NULL)))",
      "CHECK ((slug ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}-[a-z0-9][a-z0-9-]*$'::text))",
    ],
    indexes: [],
    comment: "class=state_machine; authority=this; question=what is the lifecycle state of one piece of delivery work, from opened to its outcome?; transitions=open->accepted,open->delivered,open->abandoned",
    columnComments: {
      id: "class=state_machine; authority=this; question=what is this initiative's own identity?",
      team_id: "class=relation; authority=this; question=which team owns this initiative?",
      slug: "class=state_machine; authority=this; question=what is this initiative's stable, human-chosen identifier within its team?",
      flow: "class=state_machine; authority=this; question=which flow does this initiative run, if any?",
      opened_at: "class=state_machine; authority=this; question=when did this initiative's lifecycle begin?",
      opened_by: "class=state_machine; authority=this; question=which principal opened this initiative?",
      closed_at: "class=state_machine; authority=this; question=when did this initiative's lifecycle end, if it has?",
      closed_by: "class=state_machine; authority=this; question=which principal closed this initiative, if it has?",
      outcome: "class=state_machine; authority=this; question=what did this initiative's lifecycle conclude, if it has closed?",
      accepted_by: "class=state_machine; authority=this; question=who is recorded as having signed off on this initiative's accepted outcome, if it was accepted?",
      no_signoff_reason: "class=state_machine; authority=this; question=why was this initiative's accepted outcome accepted without a named sign-off, if so?",
    },
  },
  initiative_fact: {
    columns: [
      [
        "id",
        "bigint",
        false,
        null,
      ],
      [
        "team",
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
        "fact",
        "text",
        false,
        null,
      ],
      [
        "value",
        "text",
        false,
        null,
      ],
      [
        "set_at",
        "timestamp with time zone",
        false,
        "now()",
      ],
    ],
    primaryKey: [
      "id",
    ],
    uniques: [
      [
        "team",
        "initiative",
        "fact",
      ],
    ],
    foreignKeys: [],
    checks: [],
    indexes: [
      "CREATE INDEX initiative_fact_lookup_idx ON zz.initiative_fact USING btree (team, initiative)",
    ],
    comment: "Mirror of <initiative>/_facts.json for the console. The file is authoritative; a row here is never updated once written for a given (team, initiative, fact).",
    columnComments: {},
  },
  doc: {
    columns: [
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
        "path",
        "text",
        false,
        null,
      ],
      [
        "flow",
        "text",
        false,
        "''::text",
      ],
      [
        "type",
        "text",
        false,
        "''::text",
      ],
      [
        "status",
        "text",
        false,
        "''::text",
      ],
      [
        "outcome",
        "text",
        true,
        null,
      ],
      [
        "approved_by",
        "text",
        true,
        null,
      ],
      [
        "approved_at",
        "timestamp with time zone",
        true,
        null,
      ],
      [
        "updated_at",
        "timestamp with time zone",
        false,
        null,
      ],
      [
        "body_tsv",
        "tsvector",
        true,
        null,
      ],
      [
        "body",
        "text",
        false,
        "''::text",
      ],
      [
        "title",
        "text",
        false,
        "''::text",
      ],
      [
        "tags",
        "text[]",
        false,
        "'{}'::text[]",
      ],
      [
        "evidence",
        "text[]",
        false,
        "'{}'::text[]",
      ],
      [
        "superseded_by",
        "text",
        true,
        null,
      ],
      [
        "content_hash",
        "text",
        false,
        "''::text",
      ],
      [
        "created_at",
        "timestamp with time zone",
        false,
        "now()",
      ],
      [
        "closed_by",
        "text",
        true,
        null,
      ],
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
        "produced_by_run_id",
        "uuid",
        true,
        null,
      ],
      [
        "supports",
        "text",
        true,
        null,
      ],
      [
        "analyzer_version",
        "text",
        true,
        null,
      ],
    ],
    primaryKey: [
      "team_slug",
      "initiative",
      "path",
    ],
    uniques: [],
    foreignKeys: [
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
          "produced_by_run_id",
        ],
        refTable: "run",
        refColumns: [
          "id",
        ],
        onDelete: "SET NULL",
        deferrable: false,
      },
    ],
    checks: [
      "CHECK (((outcome IS NULL) OR (outcome = ANY (ARRAY['delivered'::text, 'accepted'::text, 'abandoned'::text]))))",
      "CHECK ((status = ANY (ARRAY[''::text, 'draft'::text, 'approved'::text, 'adopted'::text, 'superseded'::text])))",
    ],
    indexes: [
      "CREATE INDEX doc_evidence ON zz.doc USING gin (evidence)",
      "CREATE INDEX doc_supports ON zz.doc USING btree (team_slug, initiative, supports) WHERE (supports IS NOT NULL)",
      "CREATE INDEX doc_tags ON zz.doc USING gin (tags)",
      "CREATE INDEX doc_team_type ON zz.doc USING btree (team_slug, type, status)",
      "CREATE INDEX doc_tsv ON zz.doc USING gin (body_tsv)",
    ],
    comment: null,
    columnComments: {
      approved_by: "The one signature field. A person, never a team slug, \"the user\" or \"the agent\" — and\n   stamped by approve() / close() from the session, never typed by a model.",
      created_at: "When this document first existed. Never moves. `updated_at` is the last write; this is the\n   first, and it is what scopes a measurement to one initiative's lifetime.",
    },
  },
  decision: {
    columns: [
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
        "path",
        "text",
        false,
        null,
      ],
      [
        "role",
        "text",
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
        "verdict",
        "text",
        false,
        "''::text",
      ],
      [
        "qualifier",
        "text",
        false,
        "''::text",
      ],
      [
        "detail",
        "text",
        false,
        "''::text",
      ],
      [
        "checker",
        "text",
        false,
        "''::text",
      ],
      [
        "updated_at",
        "timestamp with time zone",
        false,
        "now()",
      ],
      [
        "doc_id",
        "uuid",
        true,
        null,
      ],
    ],
    primaryKey: [
      "team_slug",
      "initiative",
      "path",
      "key",
    ],
    uniques: [],
    foreignKeys: [
      {
        columns: [
          "doc_id",
        ],
        refTable: "doc",
        refColumns: [
          "id",
        ],
        onDelete: "CASCADE",
        deferrable: false,
      },
    ],
    checks: [
      "CHECK ((verdict = ANY (ARRAY[''::text, 'native'::text, 'achievable'::text, 'workaround'::text, 'not_possible'::text])))",
    ],
    indexes: [
      "CREATE INDEX decision_team_initiative ON zz.decision USING btree (team_slug, initiative)",
    ],
    comment: null,
    columnComments: {},
  },
  discussion_message: {
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
        "doc_path",
        "text",
        false,
        null,
      ],
      [
        "seq",
        "integer",
        false,
        null,
      ],
      [
        "principal_id",
        "uuid",
        false,
        null,
      ],
      [
        "body",
        "text",
        false,
        null,
      ],
      [
        "created_at",
        "timestamp with time zone",
        false,
        "now()",
      ],
    ],
    primaryKey: [
      "id",
    ],
    uniques: [
      [
        "team_slug",
        "initiative",
        "doc_path",
        "seq",
      ],
    ],
    foreignKeys: [
      {
        columns: [
          "principal_id",
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
    indexes: [
      "CREATE INDEX discussion_thread ON zz.discussion_message USING btree (team_slug, initiative, doc_path, seq)",
    ],
    comment: null,
    columnComments: {},
  },
  bug: {
    columns: [
      [
        "id",
        "uuid",
        false,
        "gen_random_uuid()",
      ],
      [
        "reported_at",
        "timestamp with time zone",
        false,
        "now()",
      ],
      [
        "reported_by",
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
        "title",
        "text",
        false,
        null,
      ],
      [
        "detail",
        "text",
        false,
        null,
      ],
      [
        "surface",
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
        "platform_version",
        "text",
        true,
        null,
      ],
      [
        "impact",
        "text",
        false,
        "'wrong_result'::text",
      ],
      [
        "status",
        "text",
        false,
        "'open'::text",
      ],
      [
        "resolution",
        "text",
        true,
        null,
      ],
      [
        "resolved_by",
        "text",
        true,
        null,
      ],
      [
        "resolved_at",
        "timestamp with time zone",
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
      "CHECK ((impact = ANY (ARRAY['blocks_work'::text, 'wrong_result'::text, 'confusing'::text, 'cosmetic'::text])))",
      "CHECK ((((status = 'open'::text) AND (resolution IS NULL) AND (resolved_by IS NULL) AND (resolved_at IS NULL)) OR ((status <> 'open'::text) AND (resolution IS NOT NULL) AND (resolved_by IS NOT NULL) AND (resolved_at IS NOT NULL))))",
      "CHECK ((status = ANY (ARRAY['open'::text, 'fixed'::text, 'not_a_bug'::text, 'duplicate'::text])))",
    ],
    indexes: [
      "CREATE INDEX bug_open ON zz.bug USING btree (status, reported_at DESC)",
      "CREATE INDEX bug_team ON zz.bug USING btree (team_slug, reported_at DESC)",
    ],
    comment: "Bugs reported by the people using this platform. Written by bug_report on /core, read by bug_list, closed by bug_resolve. Not knowledge (a report needs no evidence) and not an event (an event has no author).",
    columnComments: {},
  },
};
