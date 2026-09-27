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
    comment: null,
    columnComments: {
      retired: "No longer in the catalog. Kept because zz.run and zz.doc attribute documents to its versions.",
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
    comment: null,
    columnComments: {
      body_hash: "sha256 of the SKILL.md below its frontmatter. Equal hashes mean the skill itself did not change.",
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
    comment: null,
    columnComments: {},
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
    comment: null,
    columnComments: {},
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
    comment: null,
    columnComments: {},
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
    comment: null,
    columnComments: {},
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
    comment: null,
    columnComments: {},
  },
};
