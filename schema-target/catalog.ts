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
        "kind",
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
        "ordinal",
        "integer",
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
    checks: [
      "CHECK ((((kind = 'flow_step'::text) AND (flow IS NOT NULL)) OR ((kind = 'plugin_skill'::text) AND (flow IS NULL))))",
    ],
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
    checks: [],
    indexes: [],
    comment: null,
    columnComments: {
      body_hash: "sha256 of the SKILL.md below its frontmatter. Equal hashes mean the skill itself did not change.",
    },
  },
  skill_asset: {
    columns: [
      [
        "id",
        "uuid",
        false,
        "gen_random_uuid()",
      ],
      [
        "skill_version_id",
        "uuid",
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
        "path",
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
        "description",
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
        "skill_version_id",
        "path",
      ],
    ],
    foreignKeys: [
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
    ],
    checks: [
      "CHECK ((kind = ANY (ARRAY['script'::text, 'reference'::text, 'tool_index'::text])))",
    ],
    indexes: [],
    comment: null,
    columnComments: {},
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
        "owner_team",
        "text",
        true,
        null,
      ],
      [
        "evolvable",
        "boolean",
        false,
        "false",
      ],
      [
        "release_owners",
        "jsonb",
        false,
        "'[]'::jsonb",
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
    checks: [
      "CHECK ((origin = ANY (ARRAY['platform'::text, 'third_party'::text])))",
    ],
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
        "rubric_id",
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
      {
        columns: [
          "rubric_id",
        ],
        refTable: "rubric",
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
    ],
    primaryKey: [
      "plugin_version_id",
      "skill_version_id",
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
          "skill_version_id",
        ],
        refTable: "skill_version",
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
    checks: [],
    indexes: [],
    comment: null,
    columnComments: {},
  },
};
