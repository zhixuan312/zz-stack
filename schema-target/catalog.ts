/**
 * What the platform ships: skills, plugins, their versions and served surfaces.
 */
import type { TableTarget } from "../scripts/schema/types.ts";

export const CATALOG: Record<string, TableTarget> = {
  skill: {
    columns: [
      [
        "id",
        "uuid",
        false,
        "gen_random_uuid()",
      ],
      [
        "name",
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
        "retired",
        "boolean",
        false,
        "false",
      ],
    ],
    primaryKey: [
      "id",
    ],
    uniques: [
      [
        "name",
      ],
    ],
    foreignKeys: [],
    // `kind` was `flow is null` spelled twice; `flow` is the fact and the constraint that held
    // the two spellings together went with the column.
    checks: [],
    indexes: [],
    comment: "class=current_state; authority=this; question=which skill names has the catalog ever shipped, which flow each is a step of, and which are no longer in the catalog?",
    columnComments: {
      id: "class=current_state; authority=this; question=what is this skill's stable identity, the row its versions and every attribution through them hang from?",
      name: "class=current_state; authority=this; question=what is this skill's catalog name, the external address that is unique across the whole catalog?",
      flow: "class=current_state; authority=this; question=which flow manifest names this skill as one of its steps, null when it is a plugin skill rather than a flow step, and the fact a subject's profile filters on to exclude a flow's own skills?",
      retired: "class=current_state; authority=this; question=is this skill no longer in the catalog, a flag whose identity row survives because runs and documents still attribute to its versions?",
    },
  },
  skill_version: {
    columns: [
      [
        "id",
        "uuid",
        false,
        "gen_random_uuid()",
      ],
      [
        "skill_id",
        "uuid",
        false,
        null,
      ],
      [
        "version",
        "text",
        false,
        null,
      ],
      [
        "content_hash",
        "text",
        false,
        "''::text",
      ],
      [
        "released_at",
        "timestamp with time zone",
        false,
        "now()",
      ],
      [
        "body_hash",
        "text",
        false,
        "''::text",
      ],
    ],
    primaryKey: [
      "id",
    ],
    uniques: [
      [
        "skill_id",
        "id",
      ],
      [
        "skill_id",
        "version",
      ],
    ],
    foreignKeys: [
      {
        columns: [
          "skill_id",
        ],
        refTable: "skill",
        refColumns: [
          "id",
        ],
        onDelete: "NO ACTION",
        deferrable: false,
      },
    ],
    // `not valid` on purpose: 198 legacy values keep whatever format they were written in, and a
    // subject digest depends on them, so the rule binds every later insert and no existing row.
    checks: [
      "CHECK ((content_hash ~ '^[0-9a-f]{64}$'::text)) NOT VALID",
    ],
    indexes: [],
    comment: "class=immutable_history; authority=this; question=what exact bytes of a skill were registered as which version, the only surviving record of them because git history is deliberately destroyed?",
    columnComments: {
      id: "class=immutable_history; authority=this; question=which released skill version does a run, a document or a plugin membership attribute to?",
      skill_id: "class=relation; authority=this; question=which skill does this released version belong to?",
      version: "class=immutable_history; authority=this; question=which version string did the skill declare when this row was registered?",
      content_hash: "class=immutable_history; authority=this; question=what is the whole-file identity of the released SKILL.md, where a legacy <size>-<hex> value predates the sha256 format, is already baked into a subject digest, and so must never be rewritten even though the sha256 check binds only later rows?",
      released_at: "class=immutable_history; authority=this; question=when was this version first registered, the only 'live from' anchor for the bytes it names?",
      body_hash: "class=immutable_history; authority=this; question=what is the sha256 of the SKILL.md below its frontmatter, so equal hashes say a version bump changed only the frontmatter, and no reader can recompute it once git history is gone?",
    },
  },
  plugin: {
    columns: [
      [
        "id",
        "uuid",
        false,
        "gen_random_uuid()",
      ],
      [
        "name",
        "text",
        false,
        null,
      ],
      [
        "origin",
        "text",
        false,
        null,
      ],
      [
        "owner_team_id",
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
        "name",
      ],
    ],
    foreignKeys: [
      {
        columns: [
          "owner_team_id",
        ],
        refTable: "team",
        refColumns: [
          "id",
        ],
        onDelete: "NO ACTION",
        deferrable: false,
      },
    ],
    // `evolvable` and the `release_owners` jsonb are gone: whether a plugin may be improved is
    // not a separate flag on it, and who may release it is a relation (`plugin_release_owner`),
    // not a list nobody can join.
    checks: [
      "CHECK ((origin = ANY (ARRAY['platform'::text, 'third_party'::text])))",
    ],
    indexes: [],
    comment: "class=current_state; authority=this; question=which plugins the platform knows, whether each is ours or a third party's, and which team maintains it?",
    columnComments: {
      id: "class=current_state; authority=this; question=what is this plugin's stable identity, the row its versions, protocol versions and release authority hang from?",
      name: "class=current_state; authority=this; question=what is this plugin's unique name, the external address that IDENTIFY and the console resolve through?",
      origin: "class=current_state; authority=this; question=is this plugin one the platform released or a third-party capture, the fact that decides which registration path may write it?",
      owner_team_id: "class=relation; authority=this; question=which team maintains this plugin, a display fact that grants no release authority?",
    },
  },
  plugin_release_owner: {
    columns: [
      [
        "plugin_id",
        "uuid",
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
      "plugin_id",
      "team_id",
    ],
    uniques: [],
    foreignKeys: [
      {
        columns: [
          "plugin_id",
        ],
        refTable: "plugin",
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
        onDelete: "NO ACTION",
        deferrable: false,
      },
    ],
    checks: [],
    indexes: [],
    comment: "class=relation; authority=this; question=which teams' members may approve and apply a release of which plugin?",
    columnComments: {
      plugin_id: "class=relation; authority=this; question=which plugin does this release authority belong to?",
      team_id: "class=relation; authority=this; question=which team holds this plugin's release authority?",
    },
  },
  plugin_version: {
    columns: [
      [
        "id",
        "uuid",
        false,
        "gen_random_uuid()",
      ],
      [
        "plugin_id",
        "uuid",
        false,
        null,
      ],
      [
        "version",
        "text",
        false,
        null,
      ],
      [
        "digest",
        "text",
        false,
        null,
      ],
      [
        "released_at",
        "timestamp with time zone",
        false,
        "now()",
      ],
      [
        "component_manifest",
        "jsonb",
        true,
        null,
      ],
      [
        "source_locator",
        "jsonb",
        true,
        null,
      ],
      [
        "tree_digest",
        "text",
        true,
        null,
      ],
      [
        "resolved_commit",
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
        "plugin_id",
        "version",
      ],
    ],
    foreignKeys: [
      {
        columns: [
          "plugin_id",
        ],
        refTable: "plugin",
        refColumns: [
          "id",
        ],
        onDelete: "NO ACTION",
        deferrable: false,
      },
    ],
    // `rubric_id` is gone with the rubric family, and `digest` is the release identity: written
    // once at insert and never rewritten, so a released version is a stable thing to evaluate.
    // The four source columns — `component_manifest`, `source_locator`, `tree_digest`,
    // `resolved_commit` — are null for a catalog release and set for a third-party capture.
    checks: [],
    indexes: [],
    comment: "class=immutable_history; authority=this; question=which plugin was released as which version with which content digest, written once and never rewritten?",
    columnComments: {
      id: "class=immutable_history; authority=this; question=which released plugin version do its tools, skill memberships, observation snapshots and evaluation subjects hang from?",
      plugin_id: "class=relation; authority=this; question=which plugin was this version released from?",
      version: "class=immutable_history; authority=this; question=which version did the plugin declare for this release?",
      digest: "class=immutable_history; authority=this; question=what content digest did the release vouch for these exact bytes, the identity an evaluation subject is compared against?",
      released_at: "class=immutable_history; authority=this; question=when was this version first registered, the release order that version strings cannot give once a plugin has been renumbered?",
      component_manifest: "class=immutable_history; authority=this; question=which components made up this version of a third-party capture, null for a catalog release?",
      source_locator: "class=immutable_history; authority=this; question=where was this third-party capture taken from, null for a catalog release?",
      tree_digest: "class=immutable_history; authority=this; question=what digest did the captured source tree have, null for a catalog release?",
      resolved_commit: "class=immutable_history; authority=this; question=which commit was the captured source resolved to, null for a catalog release?",
    },
  },
  plugin_version_skill: {
    columns: [
      [
        "plugin_version_id",
        "uuid",
        false,
        null,
      ],
      [
        "skill_version_id",
        "uuid",
        false,
        null,
      ],
      [
        "skill_id",
        "uuid",
        false,
        null,
      ],
    ],
    primaryKey: [
      "plugin_version_id",
      "skill_id",
    ],
    uniques: [],
    foreignKeys: [
      {
        columns: [
          "plugin_version_id",
        ],
        refTable: "plugin_version",
        refColumns: [
          "id",
        ],
        onDelete: "CASCADE",
        deferrable: false,
      },
      {
        columns: [
          "skill_id",
          "skill_version_id",
        ],
        refTable: "skill_version",
        refColumns: [
          "skill_id",
          "id",
        ],
        onDelete: "NO ACTION",
        deferrable: false,
      },
    ],
    // One version per skill per plugin version: the key names the skill, so a plugin version
    // cannot bind two versions of one skill — and the composite foreign key is what makes
    // `skill_id` truthful rather than a second copy of the version's own skill.
    checks: [],
    indexes: [],
    comment: "class=relation; authority=this; question=which skill version did each plugin version ship?",
    columnComments: {
      plugin_version_id: "class=relation; authority=this; question=which plugin version shipped this skill version?",
      skill_version_id: "class=relation; authority=this; question=which version of the skill did this plugin version ship?",
      skill_id: "class=relation; authority=this; question=which skill does this membership bind, the key column that stops one plugin version binding two versions of the same skill?",
    },
  },
  plugin_tool: {
    columns: [
      [
        "plugin_version_id",
        "uuid",
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
        "door",
        "text",
        false,
        null,
      ],
    ],
    primaryKey: [
      "plugin_version_id",
      "name",
    ],
    uniques: [],
    foreignKeys: [
      {
        columns: [
          "plugin_version_id",
        ],
        refTable: "plugin_version",
        refColumns: [
          "id",
        ],
        onDelete: "CASCADE",
        deferrable: false,
      },
    ],
    checks: [
      "CHECK ((door = ANY (ARRAY['core'::text, 'eval'::text, 'manage'::text])))",
    ],
    indexes: [],
    comment: "class=immutable_history; authority=this; question=which MCP tool names, and on which door, did this plugin version serve, captured at boot so it cannot be rebuilt without booting that build again?",
    columnComments: {
      plugin_version_id: "class=relation; authority=this; question=which plugin version served this tool?",
      name: "class=immutable_history; authority=this; question=what tool name did this plugin version serve?",
      door: "class=immutable_history; authority=this; question=which door served this tool, a fact that stays true history after a door moves elsewhere?",
    },
  },
};
