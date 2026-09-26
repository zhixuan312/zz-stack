/**
 * The artifact backbone.
 */
import type { TableTarget } from "../scripts/schema/types.ts";

export const ARTIFACT: Record<string, TableTarget> = {
  artifact: {
    columns: [
      [
        "owner_id",
        "uuid",
        false,
        null,
      ],
      [
        "artifact_id",
        "uuid",
        false,
        null,
      ],
      [
        "artifact_class",
        "text",
        false,
        null,
      ],
      [
        "current_path",
        "text",
        false,
        null,
      ],
      [
        "current_revision",
        "integer",
        true,
        null,
      ],
      [
        "content_hash",
        "text",
        false,
        null,
      ],
      [
        "head_event_sequence",
        "integer",
        false,
        null,
      ],
      [
        "created_at",
        "timestamp with time zone",
        true,
        null,
      ],
      [
        "audience",
        "text",
        true,
        null,
      ],
      [
        "profile",
        "text",
        true,
        null,
      ],
    ],
    primaryKey: [
      "owner_id",
      "artifact_id",
    ],
    uniques: [],
    foreignKeys: [],
    checks: [
      "CHECK ((artifact_class = ANY (ARRAY['source'::text, 'work_document'::text, 'knowledge_concept'::text])))",
      "CHECK (((current_revision IS NULL) OR (current_revision > 0)))",
      "CHECK ((head_event_sequence > 0))",
    ],
    indexes: [
      "CREATE INDEX artifact_by_class ON zz.artifact USING btree (owner_id, artifact_class)",
    ],
    comment: null,
    columnComments: {},
  },
  artifact_revision: {
    columns: [
      [
        "owner_id",
        "uuid",
        false,
        null,
      ],
      [
        "artifact_id",
        "uuid",
        false,
        null,
      ],
      [
        "revision",
        "integer",
        false,
        null,
      ],
      [
        "content_hash",
        "text",
        false,
        null,
      ],
      [
        "payload",
        "jsonb",
        false,
        null,
      ],
      [
        "cause_refs",
        "jsonb",
        false,
        "'[]'::jsonb",
      ],
      [
        "sources",
        "jsonb",
        false,
        "'[]'::jsonb",
      ],
      [
        "generated_by",
        "text",
        true,
        null,
      ],
      [
        "generated_at",
        "timestamp with time zone",
        true,
        null,
      ],
      [
        "origin_profile",
        "text",
        false,
        null,
      ],
      [
        "legacy_unresolved_sources",
        "jsonb",
        false,
        "'[]'::jsonb",
      ],
      [
        "previous_revision",
        "integer",
        true,
        null,
      ],
    ],
    primaryKey: [
      "owner_id",
      "artifact_id",
      "revision",
    ],
    uniques: [],
    foreignKeys: [
      {
        columns: [
          "owner_id",
          "artifact_id",
        ],
        refTable: "artifact",
        refColumns: [
          "owner_id",
          "artifact_id",
        ],
        onDelete: "NO ACTION",
        deferrable: false,
      },
    ],
    checks: [
      "CHECK ((origin_profile = ANY (ARRAY['native'::text, 'legacy_import'::text])))",
      "CHECK (((previous_revision IS NULL) OR (previous_revision > 0)))",
      "CHECK ((revision > 0))",
    ],
    indexes: [],
    comment: null,
    columnComments: {},
  },
  artifact_event: {
    columns: [
      [
        "event_id",
        "uuid",
        false,
        null,
      ],
      [
        "transaction_id",
        "text",
        false,
        null,
      ],
      [
        "owner_id",
        "uuid",
        false,
        null,
      ],
      [
        "artifact_id",
        "uuid",
        false,
        null,
      ],
      [
        "sequence",
        "integer",
        false,
        null,
      ],
      [
        "at",
        "timestamp with time zone",
        false,
        null,
      ],
      [
        "actor",
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
        "revision",
        "integer",
        true,
        null,
      ],
      [
        "content_hash",
        "text",
        false,
        null,
      ],
      [
        "cause_refs",
        "jsonb",
        false,
        "'[]'::jsonb",
      ],
      [
        "data",
        "jsonb",
        false,
        "'{}'::jsonb",
      ],
    ],
    primaryKey: [
      "event_id",
    ],
    uniques: [
      [
        "owner_id",
        "artifact_id",
        "sequence",
      ],
    ],
    foreignKeys: [
      {
        columns: [
          "owner_id",
          "artifact_id",
        ],
        refTable: "artifact",
        refColumns: [
          "owner_id",
          "artifact_id",
        ],
        onDelete: "NO ACTION",
        deferrable: false,
      },
    ],
    checks: [
      "CHECK ((kind = ANY (ARRAY['created'::text, 'revised'::text, 'approved'::text, 'verified'::text, 'status_changed'::text, 'moved'::text, 'input_attached'::text, 'input_dispositioned'::text, 'provenance_corrected'::text, 'superseded'::text, 'published'::text, 'unpublished'::text, 'legacy_imported'::text])))",
      "CHECK (((revision IS NULL) OR (revision > 0)))",
      "CHECK ((sequence > 0))",
    ],
    indexes: [
      "CREATE INDEX artifact_event_transaction ON zz.artifact_event USING btree (transaction_id)",
    ],
    comment: null,
    columnComments: {},
  },
  artifact_edge: {
    columns: [
      [
        "source_owner_id",
        "uuid",
        false,
        null,
      ],
      [
        "source_artifact_id",
        "uuid",
        false,
        null,
      ],
      [
        "source_revision",
        "integer",
        true,
        null,
      ],
      [
        "kind",
        "text",
        false,
        null,
      ],
      [
        "target_owner_id",
        "uuid",
        false,
        null,
      ],
      [
        "target_artifact_id",
        "uuid",
        false,
        null,
      ],
      [
        "target_revision",
        "integer",
        true,
        null,
      ],
      [
        "target_hash",
        "text",
        false,
        null,
      ],
      [
        "citation_id",
        "text",
        true,
        null,
      ],
      [
        "asserted_event_id",
        "uuid",
        false,
        null,
      ],
      [
        "retracted_event_id",
        "uuid",
        true,
        null,
      ],
    ],
    primaryKey: [
      "source_owner_id",
      "source_artifact_id",
      "kind",
      "target_owner_id",
      "target_artifact_id",
      "asserted_event_id",
    ],
    uniques: [],
    foreignKeys: [
      {
        columns: [
          "asserted_event_id",
        ],
        refTable: "artifact_event",
        refColumns: [
          "event_id",
        ],
        onDelete: "NO ACTION",
        deferrable: false,
      },
      {
        columns: [
          "retracted_event_id",
        ],
        refTable: "artifact_event",
        refColumns: [
          "event_id",
        ],
        onDelete: "NO ACTION",
        deferrable: false,
      },
    ],
    checks: [
      "CHECK ((kind = ANY (ARRAY['derived_from'::text, 'cites'::text, 'revision_of'::text, 'supersedes'::text])))",
      "CHECK (((source_revision IS NULL) OR (source_revision > 0)))",
      "CHECK (((target_revision IS NULL) OR (target_revision > 0)))",
    ],
    indexes: [
      "CREATE INDEX artifact_edge_target ON zz.artifact_edge USING btree (target_owner_id, target_artifact_id)",
    ],
    comment: null,
    columnComments: {},
  },
  artifact_passage: {
    columns: [
      [
        "id",
        "bigint",
        false,
        null,
      ],
      [
        "owner_id",
        "uuid",
        false,
        null,
      ],
      [
        "artifact_id",
        "uuid",
        false,
        null,
      ],
      [
        "revision",
        "integer",
        false,
        null,
      ],
      [
        "scope",
        "text",
        false,
        null,
      ],
      [
        "corpus_key",
        "text",
        false,
        null,
      ],
      [
        "ordinal",
        "integer",
        false,
        null,
      ],
      [
        "byte_start",
        "integer",
        false,
        null,
      ],
      [
        "byte_end",
        "integer",
        false,
        null,
      ],
      [
        "raw_text",
        "text",
        false,
        null,
      ],
      [
        "analyzed_text",
        "text",
        false,
        null,
      ],
      [
        "analyzer_version",
        "text",
        false,
        null,
      ],
    ],
    primaryKey: [
      "id",
    ],
    uniques: [
      [
        "owner_id",
        "artifact_id",
        "revision",
        "scope",
        "corpus_key",
        "ordinal",
      ],
    ],
    foreignKeys: [],
    checks: [
      "CHECK ((byte_start >= 0))",
      "CHECK ((byte_end >= byte_start))",
      "CHECK ((ordinal >= 0))",
      "CHECK ((revision > 0))",
      "CHECK ((scope = ANY (ARRAY['current'::text, 'evidence'::text, 'history'::text])))",
    ],
    indexes: [
      "CREATE INDEX artifact_passage_owner ON zz.artifact_passage USING btree (owner_id, artifact_id, revision, scope)",
    ],
    comment: null,
    columnComments: {},
  },
  artifact_identifier: {
    columns: [
      [
        "id",
        "bigint",
        false,
        null,
      ],
      [
        "owner_id",
        "uuid",
        false,
        null,
      ],
      [
        "artifact_id",
        "uuid",
        false,
        null,
      ],
      [
        "revision",
        "integer",
        false,
        null,
      ],
      [
        "scope",
        "text",
        false,
        null,
      ],
      [
        "corpus_key",
        "text",
        false,
        null,
      ],
      [
        "passage_id",
        "bigint",
        false,
        null,
      ],
      [
        "identifier_text",
        "text",
        false,
        null,
      ],
      [
        "normalized_text",
        "text",
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
          "passage_id",
        ],
        refTable: "artifact_passage",
        refColumns: [
          "id",
        ],
        onDelete: "CASCADE",
        deferrable: false,
      },
    ],
    checks: [
      "CHECK ((revision > 0))",
      "CHECK ((scope = ANY (ARRAY['current'::text, 'evidence'::text, 'history'::text])))",
    ],
    indexes: [
      "CREATE INDEX artifact_identifier_normalized ON zz.artifact_identifier USING btree (normalized_text)",
      "CREATE INDEX artifact_identifier_owner ON zz.artifact_identifier USING btree (owner_id, artifact_id, revision, scope)",
      "CREATE INDEX artifact_identifier_trgm ON zz.artifact_identifier USING gist (normalized_text zz.gist_trgm_ops)",
    ],
    comment: null,
    columnComments: {},
  },
  artifact_projection_commit: {
    columns: [
      [
        "owner_id",
        "uuid",
        false,
        null,
      ],
      [
        "transaction_id",
        "text",
        false,
        null,
      ],
      [
        "sequence",
        "integer",
        false,
        null,
      ],
      [
        "applied_at",
        "timestamp with time zone",
        false,
        "now()",
      ],
    ],
    primaryKey: [
      "owner_id",
      "transaction_id",
    ],
    uniques: [],
    foreignKeys: [],
    checks: [
      "CHECK ((sequence > 0))",
    ],
    indexes: [],
    comment: null,
    columnComments: {},
  },
  artifact_projection_watermark: {
    columns: [
      [
        "owner_id",
        "uuid",
        false,
        null,
      ],
      [
        "head_sequence",
        "integer",
        false,
        "0",
      ],
      [
        "updated_at",
        "timestamp with time zone",
        false,
        "now()",
      ],
    ],
    primaryKey: [
      "owner_id",
    ],
    uniques: [],
    foreignKeys: [],
    checks: [
      "CHECK ((head_sequence >= 0))",
    ],
    indexes: [],
    comment: null,
    columnComments: {},
  },
};
