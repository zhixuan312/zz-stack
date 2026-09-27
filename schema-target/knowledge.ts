/**
 * The knowledge store.
 */
import type { TableTarget } from "../scripts/schema/types.ts";

export const KNOWLEDGE: Record<string, TableTarget> = {
  knowledge_node: {
    columns: [
      [
        "id",
        "uuid",
        false,
        "gen_random_uuid()",
      ],
      [
        "kind",
        "text",
        false,
        null,
      ],
      [
        "lifecycle",
        "text",
        false,
        "'adopted'::text",
      ],
      [
        "title",
        "text",
        false,
        "''::text",
      ],
      [
        "body",
        "text",
        false,
        "''::text",
      ],
      [
        "body_tsv",
        "tsvector",
        true,
        null,
      ],
      [
        "tags",
        "text[]",
        false,
        "'{}'::text[]",
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
        "updated_at",
        "timestamp with time zone",
        false,
        "now()",
      ],
      [
        "analyzer_version",
        "text",
        true,
        null,
      ],
      [
        "team_id",
        "uuid",
        false,
        null,
      ],
      [
        "node_ordinal",
        "text",
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
        "superseded_by_id",
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
        "team_id",
        "id",
      ],
      [
        "team_id",
        "node_ordinal",
      ],
    ],
    foreignKeys: [
      {
        columns: [
          "team_id",
          "superseded_by_id",
        ],
        refTable: "knowledge_node",
        refColumns: [
          "team_id",
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
      "CHECK ((kind = ANY (ARRAY['decision'::text, 'design'::text, 'process'::text, 'knowledge'::text, 'behavior'::text, 'style'::text])))",
      "CHECK ((lifecycle = ANY (ARRAY['adopted'::text, 'superseded'::text])))",
      "CHECK (((lifecycle = 'superseded'::text) = (superseded_by_id IS NOT NULL)))",
    ],
    indexes: [
      "CREATE INDEX knowledge_node_body_trgm ON zz.knowledge_node USING gin (body zz.gin_trgm_ops)",
      "CREATE INDEX knowledge_node_tags ON zz.knowledge_node USING gin (tags)",
      "CREATE INDEX knowledge_node_team ON zz.knowledge_node USING btree (team_id, lifecycle)",
      "CREATE INDEX knowledge_node_tsv ON zz.knowledge_node USING gin (body_tsv)",
    ],
    comment: null,
    columnComments: {},
  },
  knowledge_node_evidence: {
    columns: [
      [
        "node_id",
        "uuid",
        false,
        null,
      ],
      [
        "initiative_id",
        "uuid",
        false,
        null,
      ],
    ],
    primaryKey: [
      "node_id",
      "initiative_id",
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
        onDelete: "NO ACTION",
        deferrable: false,
      },
      {
        columns: [
          "node_id",
        ],
        refTable: "knowledge_node",
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
