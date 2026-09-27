/**
 * The document store: a document, the revisions it has had, and the citations between exact
 * revisions.
 *
 * `doc` is the authority for a document's identity and its status; `doc_revision` is the authority
 * for which revisions exist and for the content each one retained; `doc_link` records one citation
 * between two exact revisions, or one source revision's support for a document identity.
 *
 * `doc`'s `title`, `body`, `tags` and `content_hash` are a declared projection of
 * `doc_revision[current_revision]`, kept on the row because search and the console read them on
 * every call. `body_tsv` and `analyzer_version` are the search projection of `body`.
 *
 * `doc_revision.fields` is the envelope's OPEN payload: the fields a document carries that have no
 * column of their own — `stakeholder`, and every field a flow declares (sdlc's `blocks`,
 * zz-plugin-eval's `eval_run_id`), which is unbounded by construction. It is not a second home for
 * a fact that has one: the writer computes the residual against the columns' own keys, so a keyed
 * field never enters it, and the reader prefers the columns over it, so a stale key cannot answer
 * in a column's place.
 *
 * `doc` is the document's identity and its status. The three the file store's own index carried —
 * `team_slug`, `initiative` and `flow` — and the eight a close or an approval used to be stamped
 * onto — `outcome`, `closed_by`, `approved_by`, `approved_at`, `evidence`, `supports`,
 * `superseded_by` and `produced_by_run_id` — are DROPPED (Task I-45). The initiative is reached
 * through `initiative_id`; the outcome and the closer are keys of the current revision's `fields`;
 * the approval is a column of `doc_revision`; the citations are `doc_link` rows; and the run a
 * document was written under is the `zz.event` row that recorded the write, never a column.
 */
import type { TableTarget } from "../scripts/schema/types.ts";

export const DOCUMENTS: Record<string, TableTarget> = {
  doc: {
    columns: [
      [
        "path",
        "text",
        false,
        null,
      ],
      [
        "type",
        "text",
        false,
        "''::text",
      ],
      [
        "status",
        "text",
        false,
        "''::text",
      ],
      [
        "updated_at",
        "timestamp with time zone",
        false,
        null,
      ],
      [
        "body_tsv",
        "tsvector",
        true,
        null,
      ],
      [
        "body",
        "text",
        false,
        "''::text",
      ],
      [
        "title",
        "text",
        false,
        "''::text",
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
        "id",
        "uuid",
        false,
        "gen_random_uuid()",
      ],
      [
        "initiative_id",
        "uuid",
        false,
        null,
      ],
      [
        "analyzer_version",
        "text",
        true,
        null,
      ],
      [
        "current_revision",
        "integer",
        true,
        null,
      ],
      [
        "approved_revision",
        "integer",
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
          "id",
          "approved_revision",
        ],
        refTable: "doc_revision",
        refColumns: [
          "doc_id",
          "revision",
        ],
        onDelete: "NO ACTION",
        deferrable: false,
      },
      {
        columns: [
          "id",
          "current_revision",
        ],
        refTable: "doc_revision",
        refColumns: [
          "doc_id",
          "revision",
        ],
        onDelete: "NO ACTION",
        deferrable: true,
      },
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
    ],
    checks: [
      "CHECK ((((approved_revision IS NULL) OR (approved_revision <= current_revision)) AND ((status = 'approved'::text) = ((approved_revision IS NOT NULL) AND (approved_revision = current_revision))))) NOT VALID",
      "CHECK ((status = ANY (ARRAY[''::text, 'draft'::text, 'approved'::text, 'adopted'::text, 'superseded'::text])))",
    ],
    indexes: [
      "CREATE INDEX doc_body_trgm ON zz.doc USING gin (body zz.gin_trgm_ops)",
      "CREATE UNIQUE INDEX doc_id_unique ON zz.doc USING btree (id)",
      "CREATE INDEX doc_tags ON zz.doc USING gin (tags)",
      "CREATE INDEX doc_tsv ON zz.doc USING gin (body_tsv)",
    ],
    comment: null,
    // The signature field's comment went with the column it annotated. `doc.approved_by` was text
    // holding a person's email; the approval is `doc_revision.approved_by`, a `uuid` key into
    // `zz.principal`, written with the seal that covers the bytes it signed.
    columnComments: {
      created_at: "When this document first existed. Never moves. `updated_at` is the last write; this is the\n   first, and it is what scopes a measurement to one initiative's lifetime.",
    },
  },
  doc_revision: {
    columns: [
      [
        "doc_id",
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
        "content_state",
        "text",
        false,
        null,
      ],
      [
        "title",
        "text",
        true,
        null,
      ],
      [
        "body",
        "text",
        true,
        null,
      ],
      [
        "tags",
        "text[]",
        true,
        null,
      ],
      [
        "content_hash",
        "text",
        true,
        null,
      ],
      [
        "written_by",
        "uuid",
        true,
        null,
      ],
      [
        "written_at",
        "timestamp with time zone",
        true,
        null,
      ],
      [
        "revision_note",
        "text",
        true,
        null,
      ],
      [
        "approved_by",
        "uuid",
        true,
        null,
      ],
      [
        "approved_at",
        "timestamp with time zone",
        true,
        null,
      ],
      // The envelope's open payload: `stakeholder`, and every field a FLOW declares — an unbounded
      // set by construction, which is why it is a map rather than more columns. Last in ordinal
      // order because `004_envelope_fields.sql` adds it, and an `ADD COLUMN` appends.
      //
      // Null means the revision carries no field outside the columns, which is the common case. The
      // writer computes the residual against the columns' own keys and the reader prefers the
      // columns over it, so a column's fact is never answered from here; both rules live in
      // `services/zz-core/src/versions.ts`, and `checks/envelope-fields.ts` is what holds the two
      // halves together.
      [
        "fields",
        "jsonb",
        true,
        null,
      ],
      // The presentation fact: the instant this revision's bytes were put in front of a person.
      // A COLUMN and not a row in the event log, because `document_approve` is refused by it and an
      // approval gate whose evidence is sweepable fails OPEN — the one direction a gate must never
      // fail in. The `shown` rows stay in `zz.event` as a projection beside it.
      [
        "presented_at",
        "timestamp with time zone",
        true,
        null,
      ],
    ],
    primaryKey: [
      "doc_id",
      "revision",
    ],
    uniques: [
      [
        "doc_id",
        "revision",
      ],
    ],
    foreignKeys: [
      {
        columns: [
          "doc_id",
        ],
        refTable: "doc",
        refColumns: [
          "id",
        ],
        onDelete: "CASCADE",
        deferrable: false,
      },
    ],
    checks: [
      "CHECK (((approved_by IS NULL) = (approved_at IS NULL)))",
      "CHECK ((content_state = ANY (ARRAY['retained'::text, 'missing_legacy'::text])))",
      "CHECK ((((content_state = 'retained'::text) AND (title IS NOT NULL) AND (body IS NOT NULL) AND (tags IS NOT NULL) AND (content_hash IS NOT NULL)) OR ((content_state = 'missing_legacy'::text) AND (title IS NULL) AND (body IS NULL) AND (tags IS NULL) AND (content_hash IS NULL))))",
      "CHECK (((content_state <> 'missing_legacy'::text) OR ((approved_by IS NULL) AND (approved_at IS NULL))))",
    ],
    indexes: [],
    comment: null,
    columnComments: {
      presented_at: "class=current_state; authority=this; question=When were these exact bytes put in front of a person? It is what `document_approve` is refused by, and a column rather than an event row so no sweep can take it.",},
  },
  doc_link: {
    columns: [
      [
        "from_doc_id",
        "uuid",
        false,
        null,
      ],
      [
        "from_revision",
        "integer",
        false,
        null,
      ],
      [
        "to_doc_id",
        "uuid",
        false,
        null,
      ],
      [
        "to_revision",
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
    ],
    primaryKey: null,
    uniques: [],
    foreignKeys: [
      {
        columns: [
          "from_doc_id",
          "from_revision",
        ],
        refTable: "doc_revision",
        refColumns: [
          "doc_id",
          "revision",
        ],
        onDelete: "NO ACTION",
        deferrable: false,
      },
      {
        columns: [
          "to_doc_id",
        ],
        refTable: "doc",
        refColumns: [
          "id",
        ],
        onDelete: "NO ACTION",
        deferrable: false,
      },
      {
        columns: [
          "to_doc_id",
          "to_revision",
        ],
        refTable: "doc_revision",
        refColumns: [
          "doc_id",
          "revision",
        ],
        onDelete: "NO ACTION",
        deferrable: false,
      },
    ],
    checks: [
      "CHECK ((kind = ANY (ARRAY['cites'::text, 'supports'::text])))",
      "CHECK ((((kind = 'cites'::text) AND (to_revision IS NOT NULL)) OR ((kind = 'supports'::text) AND (to_revision IS NULL))))",
    ],
    indexes: [
      "CREATE UNIQUE INDEX doc_link_unique ON zz.doc_link USING btree (from_doc_id, from_revision, to_doc_id, to_revision, kind) NULLS NOT DISTINCT",
    ],
    comment: null,
    columnComments: {},
  },
};
