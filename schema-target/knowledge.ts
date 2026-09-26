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
        "team_slug",
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
        "superseded_by",
        "text",
        true,
        null,
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
        "evidence",
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
    ],
    primaryKey: [
      "id",
    ],
    uniques: [
      [
        "team_slug",
        "path",
      ],
    ],
    foreignKeys: [],
    checks: [
      "CHECK ((kind = ANY (ARRAY['decision'::text, 'design'::text, 'process'::text, 'knowledge'::text, 'behavior'::text, 'style'::text])))",
      "CHECK ((lifecycle = ANY (ARRAY['adopted'::text, 'superseded'::text])))",
    ],
    indexes: [
      "CREATE INDEX knowledge_node_tags ON zz.knowledge_node USING gin (tags)",
      "CREATE INDEX knowledge_node_team ON zz.knowledge_node USING btree (team_slug, lifecycle)",
      "CREATE INDEX knowledge_node_tsv ON zz.knowledge_node USING gin (body_tsv)",
    ],
    comment: null,
    columnComments: {},
  },
};
