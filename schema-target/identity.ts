/**
 * Identity and access: people, teams, memberships, bearer tokens and console sessions.
 */
import type { TableTarget } from "../scripts/schema/types.ts";

export const IDENTITY: Record<string, TableTarget> = {
  principal: {
    columns: [
      [
        "id",
        "uuid",
        false,
        "gen_random_uuid()",
      ],
      [
        "email",
        "zz.citext",
        false,
        null,
      ],
      [
        "display_name",
        "text",
        false,
        "''::text",
      ],
      [
        "role",
        "text",
        false,
        "'member'::text",
      ],
      [
        "status",
        "text",
        false,
        "'active'::text",
      ],
      [
        "created_at",
        "timestamp with time zone",
        false,
        "now()",
      ],
      [
        "updated_at",
        "timestamp with time zone",
        false,
        "now()",
      ],
      [
        "active_team_id",
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
        "email",
      ],
    ],
    foreignKeys: [
      {
        columns: [
          "active_team_id",
        ],
        refTable: "team",
        refColumns: [
          "id",
        ],
        onDelete: "SET NULL",
        deferrable: false,
      },
    ],
    checks: [
      "CHECK ((role = ANY (ARRAY['superadmin'::text, 'member'::text])))",
      "CHECK ((status = ANY (ARRAY['active'::text, 'deactivated'::text])))",
    ],
    indexes: [],
    comment: null,
    columnComments: {},
  },
  team: {
    columns: [
      [
        "id",
        "uuid",
        false,
        "gen_random_uuid()",
      ],
      [
        "slug",
        "text",
        false,
        null,
      ],
      [
        "name",
        "text",
        false,
        null,
      ],
      [
        "status",
        "text",
        false,
        "'active'::text",
      ],
      [
        "created_by",
        "uuid",
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
        "slug",
      ],
    ],
    foreignKeys: [
      {
        columns: [
          "created_by",
        ],
        refTable: "principal",
        refColumns: [
          "id",
        ],
        onDelete: "NO ACTION",
        deferrable: false,
      },
    ],
    checks: [
      "CHECK ((status = ANY (ARRAY['active'::text, 'archived'::text])))",
    ],
    indexes: [],
    comment: null,
    columnComments: {},
  },
  membership: {
    columns: [
      [
        "team_id",
        "uuid",
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
        "role",
        "text",
        false,
        "'member'::text",
      ],
      [
        "added_by",
        "uuid",
        true,
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
      "team_id",
      "principal_id",
    ],
    uniques: [],
    foreignKeys: [
      {
        columns: [
          "added_by",
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
          "principal_id",
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
      "CHECK ((role = ANY (ARRAY['admin'::text, 'member'::text])))",
    ],
    indexes: [],
    comment: null,
    columnComments: {},
  },
  pat: {
    columns: [
      [
        "id",
        "uuid",
        false,
        "gen_random_uuid()",
      ],
      [
        "principal_id",
        "uuid",
        false,
        null,
      ],
      [
        "token_hash",
        "text",
        false,
        null,
      ],
      [
        "label",
        "text",
        false,
        "''::text",
      ],
      [
        "team_id",
        "uuid",
        true,
        null,
      ],
      [
        "expires_at",
        "timestamp with time zone",
        true,
        null,
      ],
      [
        "revoked_at",
        "timestamp with time zone",
        true,
        null,
      ],
      [
        "last_used_at",
        "timestamp with time zone",
        true,
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
        "token_hash",
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
    indexes: [],
    comment: null,
    columnComments: {},
  },
  console_session: {
    columns: [
      [
        "id",
        "uuid",
        false,
        "gen_random_uuid()",
      ],
      [
        "principal_id",
        "uuid",
        false,
        null,
      ],
      [
        "token_hash",
        "text",
        false,
        null,
      ],
      [
        "issued_at",
        "timestamp with time zone",
        false,
        "now()",
      ],
      [
        "expires_at",
        "timestamp with time zone",
        false,
        null,
      ],
      [
        "revoked_at",
        "timestamp with time zone",
        true,
        null,
      ],
      [
        "last_seen_at",
        "timestamp with time zone",
        true,
        null,
      ],
      [
        "user_agent",
        "text",
        true,
        null,
      ],
      [
        "ip",
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
        "token_hash",
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
        onDelete: "CASCADE",
        deferrable: false,
      },
    ],
    checks: [],
    indexes: [
      "CREATE INDEX console_session_expiry ON zz.console_session USING btree (expires_at)",
      "CREATE INDEX console_session_principal ON zz.console_session USING btree (principal_id)",
    ],
    comment: null,
    columnComments: {},
  },
};
