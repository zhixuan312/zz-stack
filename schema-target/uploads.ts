/**
 * Uploads: one file on its way into a document or a source, staged here and consumed by a write.
 *
 * `upload` is staging, never authority. Three writers own its columns in turn: zz-core's
 * `upload_start` mints the row (`id` to `expires_at`); the gateway's staging route binds the bytes
 * once (`byte_count` to `staged_by`, under `sha256 is null`); zz-core's consuming write marks it consumed
 * (`consumed_at` to `consumed_digest`) and removes `body` in the same commit. The document or source the
 * write produced is the authority for the text; this row only says which bytes arrived and which
 * write took them.
 *
 * Rows are kept without their body after consumption or expiry, so a consumed id is never new again.
 * The gateway's hourly sweep removes the body of an upload that expired unused.
 */
import type { TableTarget } from "../scripts/schema/types.ts";

export const UPLOADS: Record<string, TableTarget> = {
  upload: {
    columns: [
      [
        "id",
        "text",
        false,
        null,
      ],
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
        "filename",
        "text",
        false,
        null,
      ],
      [
        "link_secret_hash",
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
      [
        "expires_at",
        "timestamp with time zone",
        false,
        "(now() + '00:15:00'::interval)",
      ],
      [
        "byte_count",
        "integer",
        true,
        null,
      ],
      [
        "sha256",
        "text",
        true,
        null,
      ],
      [
        "body",
        "bytea",
        true,
        null,
      ],
      [
        "staged_via",
        "text",
        true,
        null,
      ],
      [
        "staged_by",
        "uuid",
        true,
        null,
      ],
      [
        "consumed_at",
        "timestamp with time zone",
        true,
        null,
      ],
      [
        "consumed_by_operation",
        "text",
        true,
        null,
      ],
      [
        "consumed_digest",
        "text",
        true,
        null,
      ],
    ],
    primaryKey: [
      "id",
    ],
    // The link is looked up by its secret's hash, and two links never share one.
    uniques: [
      [
        "link_secret_hash",
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
          "staged_by",
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
    // What the database can know about the lifecycle: a staging is bound whole or not at all, a
    // link staging names no principal and a token staging names one, a body exists only
    // while staged and unconsumed, a consumption is recorded whole and only of staged bytes.
    checks: [
      "CHECK (((body IS NULL) OR ((sha256 IS NOT NULL) AND (consumed_at IS NULL))))",
      "CHECK (((byte_count >= 0) AND (byte_count <= 8388608)))",
      "CHECK (((consumed_at IS NULL) OR (sha256 IS NOT NULL)))",
      "CHECK ((((consumed_at IS NULL) = (consumed_by_operation IS NULL)) AND ((consumed_at IS NULL) = (consumed_digest IS NULL))))",
      "CHECK ((expires_at > created_at))",
      "CHECK (((length(filename) >= 1) AND (length(filename) <= 255) AND (strpos(filename, '/'::text) = 0)))",
      "CHECK ((id ~ '^up_[a-z2-7]{26}$'::text))",
      "CHECK ((link_secret_hash ~ '^[0-9a-f]{64}$'::text))",
      "CHECK ((sha256 ~ '^[0-9a-f]{64}$'::text))",
      "CHECK (((staged_by IS NULL) = ((staged_via IS NULL) OR (staged_via = 'link'::text))))",
      "CHECK ((staged_via = ANY (ARRAY['token'::text, 'link'::text])))",
      "CHECK ((((sha256 IS NULL) = (byte_count IS NULL)) AND ((sha256 IS NULL) = (staged_via IS NULL))))",
    ],
    // The hourly sweep reads the bodies still held, by expiry.
    indexes: [
      "CREATE INDEX upload_sweep ON zz.upload USING btree (expires_at) WHERE (body IS NOT NULL)",
    ],
    comment: "class=state_machine; authority=this; question=which plain-text file has a principal begun to upload for which team, which bytes were staged for it and through which route, and which write consumed it?; transitions=minted->staged, staged->consumed, minted->expired, staged->expired; retention=kept without its body after consumption or expiry, so a consumed id is never new again; the consuming write removes the body in its own commit, and the gateway's hourly sweep removes the body of an upload that expired unused; the staging window is 15 minutes",
    columnComments: {
      id: "class=state_machine; authority=this; question=what is this upload's opaque identity, up_ and 26 base32 characters of 128 random bits, the id upload_start answers and a write consumes?",
      team_id: "class=relation; authority=this; question=which team was the upload started for, the only team a write may consume it in?",
      principal_id: "class=relation; authority=this; question=which principal started the upload, the only one whose token may stage it or whose write may consume it?",
      filename: "class=state_machine; authority=this; question=what filename did upload_start record, the one whose extension decides the plain-text family and governs every staging?",
      link_secret_hash: "class=ephemeral; authority=this; question=what is the sha256 of this upload's staging link secret, the capability that stages this one upload and nothing else?",
      created_at: "class=state_machine; authority=this; question=when was the upload started?",
      expires_at: "class=state_machine; authority=this; question=when does this upload's fifteen-minute window end, after which it is neither staged nor newly consumed?",
      byte_count: "class=state_machine; authority=this; question=how many bytes did the first staging bind, null until staged?",
      sha256: "class=state_machine; authority=this; question=what is the sha256 hex of the bytes the first staging bound, which no later staging may change, null until staged?",
      body: "class=ephemeral; authority=this; question=what bytes are staged and not yet consumed, removed by the consuming write or once the upload expires unused?",
      staged_via: "class=state_machine; authority=this; question=which route staged the bytes — token (the person's own token) or link (the staging link) — null until staged?",
      staged_by: "class=relation; authority=this; question=which principal's credential staged the bytes, null for a link staging, which authenticates nobody, and until staged?",
      consumed_at: "class=state_machine; authority=this; question=when did a write consume this upload, null until consumed?",
      consumed_by_operation: "class=state_machine; authority=this; question=which operation consumed this upload — the tool and the path it wrote — null until consumed?",
      consumed_digest: "class=state_machine; authority=this; question=which request digest did the consuming write carry, so its keyed replay is the same consumption rather than a second one, null until consumed?",
    },
  },
};
