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
      // Validated, not `NOT VALID`: the carry left 336 rows that claimed `approved` with no
      // approved revision — the frozen copies it filed twice — and `002_store_carry_repair.sql`
      // deletes exactly those (guarded on the duplication still holding) and then validates this
      // constraint. A deployment that has run it enforces the rule on every row; a fresh install
      // enforces it from the start, because 001_init.sql creates the table empty.
      "CHECK ((((approved_revision IS NULL) OR (approved_revision <= current_revision)) AND ((status = 'approved'::text) = ((approved_revision IS NOT NULL) AND (approved_revision = current_revision)))))",
      "CHECK ((status = ANY (ARRAY[''::text, 'draft'::text, 'approved'::text, 'adopted'::text, 'superseded'::text])))",
    ],
    indexes: [
      "CREATE INDEX doc_body_trgm ON zz.doc USING gin (body zz.gin_trgm_ops)",
      "CREATE UNIQUE INDEX doc_id_unique ON zz.doc USING btree (id)",
      "CREATE INDEX doc_tags ON zz.doc USING gin (tags)",
      "CREATE INDEX doc_tsv ON zz.doc USING gin (body_tsv)",
    ],
    comment: "class=state_machine; authority=this; question=what is this document's identity and its gate status, as distinct from the revisions it has had?; transitions=draft->approved,approved->draft",
    // The signature field's comment went with the column it annotated. `doc.approved_by` was text
    // holding a person's email; the approval is `doc_revision.approved_by`, a `uuid` key into
    // `zz.principal`, written with the seal that covers the bytes it signed.
    columnComments: {
      path: "class=state_machine; authority=this; question=where does this document live inside its initiative's folder?",
      type: "class=state_machine; authority=this; question=which role does this document play, an agreement, a plan, a source, or another type its flow declares?",
      status: "class=state_machine; authority=this; question=is this document a draft, or approved at its current revision?",
      updated_at: "class=state_machine; authority=this; question=when was this document last written?",
      body_tsv: "class=projection; authority=zz.doc.body; question=what is this document's body as the search vector a full-text query matches?; rebuilt_from=body",
      body: "class=projection; authority=zz.doc_revision.body; question=what does this document's current revision say?; rebuilt_from=doc_revision[current_revision]",
      title: "class=projection; authority=zz.doc_revision.title; question=what is this document's current revision titled?; rebuilt_from=doc_revision[current_revision]",
      tags: "class=projection; authority=zz.doc_revision.tags; question=which tags does this document's current revision carry?; rebuilt_from=doc_revision[current_revision]",
      content_hash: "class=projection; authority=zz.doc_revision.content_hash; question=what is the hash of this document's current revision bytes?; rebuilt_from=doc_revision[current_revision]",
      created_at: "class=state_machine; authority=this; question=when did this document first exist, never moved by a later write as updated_at is, and the instant that scopes a measurement to one initiative's lifetime?",
      id: "class=state_machine; authority=this; question=what is this document's own identity?",
      initiative_id: "class=relation; authority=this; question=which initiative does this document belong to?",
      analyzer_version: "class=projection; authority=zz.doc.body; question=which analyzer generation produced this document's search vector, so a vector from another generation can be rederived?; rebuilt_from=body",
      current_revision: "class=state_machine; authority=this; question=which revision of this document is the current one?",
      approved_revision: "class=state_machine; authority=this; question=which revision of this document was approved last, if any has been?",
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
    comment: "class=state_machine; authority=this; question=which revision of this document is this, and does it still retain the exact bytes that were written?; transitions=written->approved",
    columnComments: {
      doc_id: "class=relation; authority=this; question=which document does this revision belong to?",
      revision: "class=state_machine; authority=this; question=which revision number of that document is this?",
      content_state: "class=state_machine; authority=this; question=does this revision still retain the exact bytes that were written, or is it a revision known to have existed whose bytes were overwritten before any approval snapshot?",
      title: "class=state_machine; authority=this; question=what was this revision titled?",
      body: "class=state_machine; authority=this; question=what did this revision say?",
      tags: "class=state_machine; authority=this; question=which tags did this revision carry?",
      content_hash: "class=state_machine; authority=this; question=what is the hash of this revision's bytes?",
      written_by: "class=state_machine; authority=this; question=which principal wrote this revision?",
      written_at: "class=state_machine; authority=this; question=when was this revision written?",
      revision_note: "class=state_machine; authority=this; question=what one line did the writer record about why this revision changed?",
      approved_by: "class=state_machine; authority=this; question=which principal approved these exact bytes, if they have been approved?",
      approved_at: "class=state_machine; authority=this; question=when were these exact bytes approved, if they have been?",
      fields: "class=state_machine; authority=this; question=which envelope fields does this revision carry that have no column of their own?",
      presented_at: "class=state_machine; authority=this; question=when were these exact bytes put in front of a person, the fact document_approve is refused by and a column rather than a sweepable event row so an approval gate cannot fail open?",
    },
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
    // A document's links go with the document, as its revisions do: both are children of `zz.doc`,
    // and a link naming a revision the cascade has just removed would point at nothing.
    // 009_doc_link_cascade.sql is the migration that makes the live catalog agree with this.
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
        onDelete: "CASCADE",
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
        onDelete: "CASCADE",
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
        onDelete: "CASCADE",
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
    comment: "class=relation; authority=this; question=which exact revision cites which other exact revision, or which source revision supports which document identity across its later revisions?",
    columnComments: {
      from_doc_id: "class=relation; authority=this; question=which document does the citing or supporting revision belong to?",
      from_revision: "class=relation; authority=this; question=which exact revision of that document does the citing or supporting?",
      to_doc_id: "class=relation; authority=this; question=which document is cited, or supported?",
      to_revision: "class=relation; authority=this; question=which exact revision is cited, null when only the target document's identity is supported?",
      kind: "class=relation; authority=this; question=is this a citation of one exact revision by another, or a source revision's support for a document identity?",
    },
  },
};
