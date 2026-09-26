/**
 * How a person signs in: passkeys, their ceremonies and enrolments, and the MCP OAuth handshake.
 */
import type { TableTarget } from "../scripts/schema/types.ts";

export const SIGN_IN: Record<string, TableTarget> = {
  passkey: {
    columns: [
      [
        "id",
        "text",
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
        "public_key",
        "bytea",
        false,
        null,
      ],
      [
        "counter",
        "bigint",
        false,
        "0",
      ],
      [
        "transports",
        "text[]",
        true,
        null,
      ],
      [
        "label",
        "text",
        true,
        null,
      ],
      [
        "created_at",
        "timestamp with time zone",
        false,
        "now()",
      ],
      [
        "last_used_at",
        "timestamp with time zone",
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
      "CREATE INDEX passkey_principal ON zz.passkey USING btree (principal_id)",
    ],
    comment: null,
    columnComments: {},
  },
  passkey_challenge: {
    columns: [
      [
        "id",
        "uuid",
        false,
        "gen_random_uuid()",
      ],
      [
        "challenge",
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
        "principal_id",
        "uuid",
        true,
        null,
      ],
      [
        "redirect_to",
        "text",
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
    uniques: [],
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
    checks: [
      "CHECK ((kind = ANY (ARRAY['register'::text, 'login'::text])))",
    ],
    indexes: [
      "CREATE INDEX passkey_challenge_age ON zz.passkey_challenge USING btree (created_at)",
    ],
    comment: null,
    columnComments: {},
  },
  passkey_enrolment: {
    columns: [
      [
        "token_hash",
        "text",
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
        "issued_by",
        "uuid",
        true,
        null,
      ],
      [
        "expires_at",
        "timestamp with time zone",
        false,
        null,
      ],
      [
        "used_at",
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
      "token_hash",
    ],
    uniques: [],
    foreignKeys: [
      {
        columns: [
          "issued_by",
        ],
        refTable: "principal",
        refColumns: [
          "id",
        ],
        onDelete: "SET NULL",
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
        onDelete: "CASCADE",
        deferrable: false,
      },
    ],
    checks: [],
    indexes: [
      "CREATE INDEX passkey_enrolment_expiry ON zz.passkey_enrolment USING btree (expires_at)",
      "CREATE INDEX passkey_enrolment_principal ON zz.passkey_enrolment USING btree (principal_id)",
    ],
    comment: null,
    columnComments: {},
  },
  mcp_oauth_client: {
    columns: [
      [
        "client_id",
        "text",
        false,
        null,
      ],
      [
        "redirect_uris",
        "jsonb",
        false,
        null,
      ],
      [
        "name",
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
    ],
    primaryKey: [
      "client_id",
    ],
    uniques: [],
    foreignKeys: [],
    checks: [],
    indexes: [],
    comment: null,
    columnComments: {},
  },
  mcp_oauth_authz: {
    columns: [
      [
        "id",
        "text",
        false,
        null,
      ],
      [
        "client_id",
        "text",
        false,
        null,
      ],
      [
        "principal_id",
        "uuid",
        true,
        null,
      ],
      [
        "redirect_uri",
        "text",
        false,
        null,
      ],
      [
        "code_challenge",
        "text",
        false,
        null,
      ],
      [
        "state",
        "text",
        false,
        "''::text",
      ],
      [
        "resource",
        "text",
        false,
        "''::text",
      ],
      [
        "used",
        "boolean",
        false,
        "false",
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
    uniques: [],
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
      "CREATE INDEX mcp_oauth_authz_age ON zz.mcp_oauth_authz USING btree (created_at)",
    ],
    comment: null,
    columnComments: {},
  },
};
