/**
 * The shapes every module under `scripts/store-migration/` shares, and the one hash they agree on.
 *
 * The entry point reads the store and decides what each revision is; the modules beside it write
 * the rows, resolve the pins, verify the result and count the store's other records. They pass the
 * same four things between them — what the database answers with (`Queryable`), what a `zz.doc` row
 * is (`DocRow`), what a revision is (`Revision`, `Held`, `RevisionState`), and the hash of a
 * revision's bytes (`hashBytes`) — so those four live here rather than in whichever of them happens
 * to be first. A leaf: it imports nothing of its own.
 */
import { createHash } from "node:crypto";

/* ------------------------------------------------------------------ the database, one interface */

/** A real `pg.Client` (or `pg.Pool`) satisfies this structurally. Nothing here imports `pg` at
 *  module scope, so `scripts/rehearse/expect.ts` hands its already-connected client straight in and
 *  the CLI is the only caller that opens a connection of its own. */
export interface Queryable {
  query<T = Record<string, unknown>>(text: string, values?: readonly unknown[]):
    Promise<{ rows: T[] }>;
}

/** One row of `zz.doc`, as this carry addresses it: the identity of a document, and the store
 *  path it is read from.
 *
 *  The team and initiative slugs are NOT columns of `doc` any more —
 *  `007_drop_legacy_store.sql` dropped them with the rest of the file store's index — and the row
 *  reaches them through `initiative_id`: the initiative's own `slug`, and the team's through it.
 *  Both selects in `store-migration.ts` take them from that join, so the row and the file it is
 *  carried from are addressed by one pair rather than two spellings of it.
 *
 *  The citations are not here either, and they were a projection of the document's own bytes from
 *  the start: `indexDoc` wrote `list(env.evidence || env.sources)` and `env.supports` into the two
 *  dropped columns, and the carry reads them back off the file — see `citationsAt`. */
export interface DocRow {
  id: string;
  team_slug: string;
  initiative: string;
  path: string;
  status: string;
}

type RevisionState = "retained" | "missing_legacy";

/** A revision's bytes, and which of the three records they came from. */
interface Held {
  bytes: string;
  from: "working_tree" | "snapshot" | "git";
}

export interface Revision {
  number: number;
  state: RevisionState;
  held: Held | null;
  /** Why the bytes are not there, when they are not. Named from the store's own record. */
  missing: string | null;
  /**
   * A frozen approval copy of THIS revision exists and its bytes are not the live file's.
   *
   * `initiative_close` stamps `outcome`, `closed_by` and `accepted_by` onto the live document
   * after the approval froze a copy of it, so the two differ by that envelope stamp and nothing
   * else — real production data does this on 29 documents. The working tree still wins for the
   * current revision, because `doc.body` is a projection of `doc_revision[current_revision]` and
   * a projection that disagreed with the document would be the worse defect. `bodyDiffers` is the
   * case where the divergence is NOT the stamp: the approved content is then genuinely absent from
   * `doc_revision`, and the verification fails on it.
   */
  frozen: { bodyDiffers: boolean } | null;
}

/** One document the carry knows how to place: its row, its revision numbers, and the revision its
 *  `doc` row should name as current and approved. */
export interface Placed {
  doc: DocRow;
  numbers: number[];
  current: number;
  approved: number | null;
}

/** `doc_revision.content_hash`: the sha256 of the exact bytes a revision was written from.
 *
 * DELIBERATE: a hash of the bytes and not of a derived row. `zz.doc.content_hash` is the hash of
 * the JSON projection `indexDoc` builds, which is a different claim — it answers "would re-deriving
 * this row change it". This one answers "are these the bytes", which is what AC-8.1 asks and what
 * the verification compares a `retained` row against.
 */
export function hashBytes(bytes: string): string {
  return createHash("sha256").update(bytes, "utf8").digest("hex");
}
