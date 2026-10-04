/**
 * What the platform itself did: the append-only event log and the run summary each caller
 * conversation leaves. The model layer's record — `model_call` and `assessment` — is beside it in
 * `typed-service.ts`, and spread in below so `schema-target.ts` assembles the same group D.
 */
import type { TableTarget } from "../scripts/schema/types.ts";

import { TYPED_SERVICE } from "./typed-service.ts";

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
      "CREATE INDEX event_run_identity ON zz.event USING btree (team_id, initiative_id, skill_version_id, session)",
      "CREATE INDEX event_ts ON zz.event USING btree (ts DESC)",
    ],
    comment: "class=immutable_history; authority=this; question=what did the platform do or get asked to do, one append-only timestamped act — a tool call at a door, an admin act, a knowledge-journal act or a sign-in — the only fallback being /data/events-unwritten.jsonl when a write fails?; retention=audit kinds (admin.*, credential.*, console.*, team.*, bug.*, pkg.download) are kept indefinitely; tool_call and knowledge.* may age out once volume requires it, except a row an evaluation cites",
    columnComments: {
      id: "class=immutable_history; authority=this; question=what is this act's row identity, the one an evaluation cites as event:<id>?",
      ts: "class=immutable_history; authority=this; question=when did this act happen, one row per act and no update?",
      kind: "class=immutable_history; authority=this; question=what kind of act this is, from an open dot-separated vocabulary of lower-case words such as tool_call, knowledge.search or team.archive?",
      subject: "class=immutable_history; authority=this; question=what is this act about — the raw <door>:<tool> for a tool_call, a node or bug id elsewhere, or the raw query text for knowledge.search, kept deliberately although a tool call may not record the text it was asked?",
      detail: "class=immutable_history; authority=this; question=what open extra payload this act carries — the caller hash, client, argument names, ids, shapes and step_sha — now that run has moved to session and the ms and bytes keys have backfilled duration_ms and response_bytes?",
      ok: "class=immutable_history; authority=this; question=did the call work, in the platform's own terms rather than as a transport status, since an mcp tool that refuses answers http 200 with error: in its text, and every tool_call row must carry it?",
      refusal: "class=immutable_history; authority=this; question=what refusal sentence the platform returned, redacted and capped, when the call did not work?",
      run_id: "class=relation; authority=this; question=which skill_run groups this event, stamped in the same transaction as the event once the matching run identity is created or found and never timer-backfilled?",
      team_id: "class=relation; authority=this; question=which team this act belongs to, the composite keys to initiative and skill_run proving they share that team, null only where the team itself is gone?",
      duration_ms: "class=immutable_history; authority=this; question=how long the request took, null before 2026-09-14 13:06 where the latency sat in detail.ms until it was backfilled here?",
      request_bytes: "class=immutable_history; authority=this; question=how large the request body was, as content-length, null on rows written before measurement began on 2026-09-14 13:06?",
      response_bytes: "class=immutable_history; authority=this; question=how large the response body was, null before 2026-09-14 13:06 where detail.bytes stood in for it until the backfill?",
      batched: "class=immutable_history; authority=this; question=does this row share one json-rpc batch's latency and size with the other calls in it, so that a percentile reader must drop it — a real protocol case no client has sent yet, so every row is false?",
      plugin: "class=immutable_history; authority=this; question=which plugin's door served this call, a deliberate snapshot never resolved from flow_install or the x-zz-client header and null when no plugin door served it, although the 157 sdlc rows of 09-14 to 09-16 came from an older skill-based rule through zz.plugin_version_skill and no row records which rule stamped it?",
      plugin_version: "class=immutable_history; authority=this; question=which version the door's own plugin reported in its initialize handshake, never set while plugin is null but not necessarily set while plugin is — 64 rows carry a plugin with no version because the door had not handshaken in that process, and 175 of the values name no zz.plugin_version row?",
      tool_key: "class=immutable_history; authority=this; question=what the alias-resolved <door>:<tool> name of this call is, stamped at write so that a row reads as one series across a rename with no further lookup, required on every tool_call row and differing from subject on the 2205 rows renamed since?",
      refusal_owner: "class=immutable_history; authority=this; question=whose refusal this was — guardrail, ours, theirs or other — set only on a call that did not work, and possibly with no refusal text at all, as on the one row whose answer was unreadable?",
      actor_id: "class=relation; authority=this; question=which principal did this admin or knowledge-journal act, null on a tool_call, where the old actor text's empty string became null and every non-empty value resolved?",
      initiative_id: "class=relation; authority=this; question=which initiative the caller was working on, carried forward per caller, null when the act belongs to none?",
      session: "class=immutable_history; authority=this; question=what the caller's conversation key is — a hash of the caller's email, client and 45-minute bucket minted in gateway memory, which a gateway restart splits and which groups the events a skill_run is built from?",
      skill_version_id: "class=relation; authority=this; question=which skill version the caller was following, resolved at write as the latest released version of the skill the caller last loaded so that a later re-registration cannot move it, null when no skill was loaded?",
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
    comment: "class=current_state; authority=this; question=what has one caller conversation done with one skill version inside one initiative — how many calls, how many refusals, how much response body, and from when to when?; retention=follows event: never pruned on its own, and once raw telemetry ages out the summary stays the durable answer for its window",
    columnComments: {
      id: "class=current_state; authority=this; question=what this run's stable identity is, the one an evaluation cites as run:<uuid> and an event points at as its run_id?",
      initiative_id: "class=relation; authority=this; question=which initiative this run happened in, null for the 96 runs whose calls belonged to no initiative?",
      skill_version_id: "class=relation; authority=this; question=which skill version the run used, time-bound to the version current at the events it groups, never null?",
      session: "class=current_state; authority=this; question=what conversation key this run groups, the same key its events carry, never the empty string?",
      calls: "class=current_state; authority=this; question=how many events this run holds, maintained from the run's own events and changed only when the aggregate changes?",
      refusals: "class=current_state; authority=this; question=how many of this run's events did not work, maintained from the run's own events and never more than its calls?",
      bytes_total: "class=current_state; authority=this; question=what the sum of response_bytes over the run's events is, null when no event in the run was measured and distinct from 0, which means measured and empty, while the zeros written before migration 051 are ambiguous and were deliberately not converted?",
      started_at: "class=current_state; authority=this; question=when this run's first event happened, the min of its events' ts?",
      ended_at: "class=current_state; authority=this; question=when this run's last event happened, the max of its ts, never null so that a run always reads as closed?",
      team_id: "class=relation; authority=this; question=which team owns this run, taken from its events so that the 96 initiative-less runs are visible in team scope too?",
    },
  },
  ...TYPED_SERVICE,
};
