/**
 * Sign-in: passkeys, the ceremonies that enrol and use them, and the OAuth clients and
 * authorization codes the hosted MCP clients arrive through.
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
    comment: "class=current_state; authority=this; question=which registered authenticator proves which person at the browser door?",
    columnComments: {
      id: "class=current_state; authority=this; question=what is this WebAuthn credential id?",
      principal_id: "class=relation; authority=this; question=which person owns this authenticator?",
      public_key: "class=current_state; authority=this; question=what COSE public key verifies this authenticator's assertions?",
      counter: "class=current_state; authority=this; question=what signature counter has this authenticator reached?",
      transports: "class=current_state; authority=this; question=how is this authenticator reached?",
      label: "class=current_state; authority=this; question=what device name is this authenticator shown under?",
      created_at: "class=current_state; authority=this; question=when was this device enrolled?",
      last_used_at: "class=current_state; authority=this; question=when did this device last sign in?",
    },
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
      [
        "expires_at",
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
      "CHECK (((kind = 'register'::text) = (principal_id IS NOT NULL)))",
    ],
    indexes: [
      "CREATE INDEX passkey_challenge_expiry ON zz.passkey_challenge USING btree (expires_at)",
    ],
    comment: "class=ephemeral; authority=this; question=which WebAuthn challenge has this server issued to one browser, awaiting the signed answer to it?; retention=swept by the hourly sweepSessions once expires_at passes, and consumed by the single-use delete at the ceremony; the challenge window is 5 minutes",
    columnComments: {
      id: "class=ephemeral; authority=this; question=what ceremony handle is carried in the zz_ceremony cookie?",
      challenge: "class=ephemeral; authority=this; question=what value must the authenticator sign?",
      kind: "class=ephemeral; authority=this; question=is this challenge a registration or a login?",
      principal_id: "class=relation; authority=this; question=which person is this registration challenge for?",
      redirect_to: "class=ephemeral; authority=this; question=where does this ceremony land after sign-in?",
      created_at: "class=ephemeral; authority=this; question=when was this challenge issued?",
      expires_at: "class=ephemeral; authority=this; question=when does this challenge's five-minute window end?",
    },
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
    ],
    primaryKey: [
      "token_hash",
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
      "CREATE INDEX passkey_enrolment_expiry ON zz.passkey_enrolment USING btree (expires_at)",
      "CREATE INDEX passkey_enrolment_principal ON zz.passkey_enrolment USING btree (principal_id)",
    ],
    comment: "class=ephemeral; authority=this; question=which single-use, expiring invitation lets one named principal register a passkey?; retention=swept 7 days after use or expiry, within 14 days of issue; the durable audit is the admin.issue_enrolment event",
    columnComments: {
      token_hash: "class=ephemeral; authority=this; question=what is the sha256 of this invitation link's secret?",
      principal_id: "class=relation; authority=this; question=which person may enrol with this link?",
      expires_at: "class=ephemeral; authority=this; question=when does this invitation's seven-day window end?",
      used_at: "class=ephemeral; authority=this; question=when was this invitation spent?",
    },
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
      [
        "revoked_at",
        "timestamp with time zone",
        true,
        null,
      ],
    ],
    primaryKey: [
      "client_id",
    ],
    uniques: [],
    foreignKeys: [],
    checks: [],
    indexes: [],
    comment: "class=current_state; authority=this; question=which OAuth public client registered itself, and which redirect URIs may it receive codes at?; retention=durable until explicitly revoked by client_revoke: an open registration endpoint makes the table unbounded, and inactivity alone never deletes a registration",
    columnComments: {
      client_id: "class=current_state; authority=this; question=what is this client's public identity?",
      redirect_uris: "class=current_state; authority=this; question=which redirect URIs may this client receive a code at?",
      name: "class=current_state; authority=this; question=what name did this client declare for itself?",
      created_at: "class=current_state; authority=this; question=when did this client register?",
      revoked_at: "class=current_state; authority=this; question=when was this client's registration revoked?",
    },
  },
  mcp_oauth_authz: {
    columns: [
      [
        "client_id",
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
        "resource",
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
        "code_hash",
        "text",
        false,
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
    ],
    primaryKey: [
      "code_hash",
    ],
    uniques: [],
    foreignKeys: [
      {
        columns: [
          "client_id",
        ],
        refTable: "mcp_oauth_client",
        refColumns: [
          "client_id",
        ],
        onDelete: "CASCADE",
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
      "CREATE INDEX mcp_oauth_authz_expiry ON zz.mcp_oauth_authz USING btree (expires_at)",
    ],
    comment: "class=ephemeral; authority=this; question=which authorization code is issued to which client for which person and door, awaiting a single PKCE exchange?; retention=swept by the hourly sweepSessions once expires_at passes, and consumed atomically at the PKCE exchange; the code window is 10 minutes",
    columnComments: {
      client_id: "class=relation; authority=this; question=which registered client was this code issued to?",
      principal_id: "class=relation; authority=this; question=which person authorized this code?",
      redirect_uri: "class=ephemeral; authority=this; question=which redirect URI is this code bound to?",
      code_challenge: "class=ephemeral; authority=this; question=what PKCE S256 challenge must the exchange answer?",
      resource: "class=ephemeral; authority=this; question=which MCP door was this code authorized for?",
      created_at: "class=ephemeral; authority=this; question=when was this code issued?",
      code_hash: "class=ephemeral; authority=this; question=what is the sha256 of the authorization code?",
      expires_at: "class=ephemeral; authority=this; question=when does this code's ten-minute window end?",
      used_at: "class=ephemeral; authority=this; question=when was this code exchanged?",
    },
  },
};
