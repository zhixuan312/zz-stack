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
          "id",
        ],
        refTable: "membership",
        refColumns: [
          "team_id",
          "principal_id",
        ],
        onDelete: "SET NULL",
        onDeleteColumns: [
          "active_team_id",
        ],
        deferrable: false,
      },
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
    comment: "class=current_state; authority=this; question=who is known to the platform, with what platform authority, whether they may act, and which team they chose to act for?",
    columnComments: {
      id: "class=current_state; authority=this; question=what is this person's stable identity?",
      email: "class=current_state; authority=this; question=what login address resolves this person at every door?",
      display_name: "class=current_state; authority=this; question=what human name is this person shown under?",
      role: "class=current_state; authority=this; question=what platform-wide authority does this person hold?",
      status: "class=current_state; authority=this; question=may this person act at all?",
      created_at: "class=current_state; authority=this; question=when was this person added?",
      active_team_id: "class=relation; authority=this; question=which team has this person chosen to act for?",
    },
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
      "CHECK ((slug ~ '^[a-z0-9][a-z0-9_-]{1,63}$'::text))",
      "CHECK ((status = ANY (ARRAY['active'::text, 'archived'::text])))",
    ],
    indexes: [],
    comment: "class=current_state; authority=this; question=what tenant exists under which slug, is it live or archived, and who created it?",
    columnComments: {
      id: "class=current_state; authority=this; question=what is this tenant's stable identity?",
      slug: "class=current_state; authority=this; question=what is this team's external address and artifact-store directory name?",
      name: "class=current_state; authority=this; question=what display name is this team shown under?",
      status: "class=current_state; authority=this; question=is this team live or archived?",
      created_by: "class=current_state; authority=this; question=which principal created this tenant?",
      created_at: "class=current_state; authority=this; question=when was this tenant created?",
    },
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
    indexes: [
      "CREATE INDEX membership_principal ON zz.membership USING btree (principal_id)",
    ],
    comment: "class=relation; authority=this; question=which person belongs to which team, in what team role, and who put them there?",
    columnComments: {
      team_id: "class=relation; authority=this; question=which team does this membership join?",
      principal_id: "class=relation; authority=this; question=which person does this membership join?",
      role: "class=relation; authority=this; question=what team authority does this person hold in this team?",
      added_by: "class=relation; authority=this; question=which principal added this person to this team?",
      created_at: "class=relation; authority=this; question=when was this person added to this team?",
    },
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
      [
        "oauth_client_id",
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
          "oauth_client_id",
        ],
        refTable: "mcp_oauth_client",
        refColumns: [
          "client_id",
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
    checks: [],
    indexes: [
      "CREATE UNIQUE INDEX pat_live_label ON zz.pat USING btree (principal_id, label) WHERE ((revoked_at IS NULL) AND (label <> ''::text))",
      "CREATE INDEX pat_principal ON zz.pat USING btree (principal_id)",
    ],
    comment: "class=current_state; authority=this; question=which bearer credential does a program hold to act as a person, confined to which team and client, with what lifetime and revocation?; retention=kept as durable provenance until explicitly revoked or expired; a revoked row is never deleted, because pat_list and client_revoke read it",
    columnComments: {
      id: "class=current_state; authority=this; question=what handle lists and revokes this token?",
      principal_id: "class=relation; authority=this; question=whose authority does this token carry?",
      token_hash: "class=current_state; authority=this; question=what is the sha256 of this token's bearer secret?",
      label: "class=current_state; authority=this; question=what purpose does this token serve, and what is it displayed as?",
      team_id: "class=relation; authority=this; question=which team is this token confined to, if any?",
      expires_at: "class=current_state; authority=this; question=when does this token stop working?",
      revoked_at: "class=current_state; authority=this; question=when was this token revoked?",
      last_used_at: "class=current_state; authority=this; question=when did this token last authenticate?",
      created_at: "class=current_state; authority=this; question=when was this token issued?",
      oauth_client_id: "class=relation; authority=this; question=which registered OAuth client was this token minted for?",
    },
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
      [
        "team_id",
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
      {
        columns: [
          "team_id",
        ],
        refTable: "team",
        refColumns: [
          "id",
        ],
        onDelete: "SET NULL",
        deferrable: false,
      },
    ],
    checks: [],
    indexes: [
      "CREATE INDEX console_session_expiry ON zz.console_session USING btree (expires_at)",
      "CREATE INDEX console_session_principal ON zz.console_session USING btree (principal_id)",
    ],
    comment: "class=current_state; authority=this; question=which browser is signed in as which person, with what lifetime and revocation, issued where and looking at which team?; retention=swept hourly by sweepSessions, which deletes a session 7 days past its expires_at or revoked_at; the sign-in lifetime itself is 12 hours",
    columnComments: {
      id: "class=current_state; authority=this; question=what handle identifies this signed-in browser?",
      principal_id: "class=relation; authority=this; question=whose session is this?",
      token_hash: "class=current_state; authority=this; question=what is the sha256 of this session's cookie secret?",
      issued_at: "class=current_state; authority=this; question=when was this browser signed in?",
      expires_at: "class=current_state; authority=this; question=when does this session end?",
      revoked_at: "class=current_state; authority=this; question=when was this session signed out?",
      last_seen_at: "class=current_state; authority=this; question=when did this session last make a request?",
      user_agent: "class=current_state; authority=this; question=which browser was this session issued to?",
      ip: "class=current_state; authority=this; question=what client address was this session issued from?",
      team_id: "class=relation; authority=this; question=which team is this browser looking at?",
    },
  },
};
