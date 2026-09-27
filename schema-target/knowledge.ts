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
    comment: "class=current_state; authority=this; question=which lessons does this shelf currently carry, what does each say, and which have been superseded by which?",
    columnComments: {
      id: "class=current_state; authority=this; question=what is this node's stable identity?",
      kind: "class=current_state; authority=this; question=which of the six node kinds is this lesson?",
      lifecycle: "class=current_state; authority=this; question=does this node still stand, or has it been superseded?",
      title: "class=current_state; authority=this; question=what is this node titled?",
      body: "class=current_state; authority=this; question=what does this lesson say?",
      body_tsv: "class=projection; authority=zz.knowledge_node.body; question=what does this node's body look like as the search vector a full-text query matches?; rebuilt_from=body",
      tags: "class=current_state; authority=this; question=which subjects is this node tagged under?",
      content_hash: "class=current_state; authority=this; question=what hash of this node's derived fields lets a reindex skip it because nothing it derives has changed?",
      created_at: "class=current_state; authority=this; question=when was this node minted?",
      updated_at: "class=current_state; authority=this; question=when did this node last change?",
      analyzer_version: "class=projection; authority=zz.knowledge_node.body; question=which analyzer generation produced this node's search vector, so a vector from another generation can be rederived?; rebuilt_from=body",
      team_id: "class=relation; authority=this; question=which shelf does this node belong to?",
      node_ordinal: "class=current_state; authority=this; question=which ordinal does this node's file carry within its shelf?",
      slug: "class=current_state; authority=this; question=what is this node's slug in its shelf-local file address?",
      superseded_by_id: "class=relation; authority=this; question=which node supersedes this one?",
    },
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
    comment: "class=relation; authority=this; question=which initiatives was this node learned from, including initiatives of a team other than the node's own shelf, since a citation is not tenant-scoped?",
    columnComments: {
      node_id: "class=relation; authority=this; question=which node does this learned-from link belong to?",
      initiative_id: "class=relation; authority=this; question=which initiative was this node learned from?",
    },
  },
};
