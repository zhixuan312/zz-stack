/**
 * How many words a body holds, by the hash of its bytes: a fact about the bytes, kept as a row so a
 * console page does not have to read them to know it.
 *
 * Record and Home both report words written, and both count them from `countWords` over the body of
 * every revision the team's flow documents have had. That is a pure function of bytes the platform
 * never changes, and it was recomputed from scratch by every process that ever started: on this
 * deployment 922 revisions, 123 MB of text, 1.4 s inside PostgreSQL and about as long again matching
 * word boundaries in Node — paid by the first Home or Record a restarted gateway answered, on every
 * start, for a number that had not moved since the revision was written.
 *
 * DELIBERATE: content-addressed, not revision-addressed. The same bytes reach several revisions (a
 * revision filed again after an approval, a close rewriting a document to the same text), and one
 * row answers for all of them; the hash the console already keys its in-process cache by is the one
 * that names the count here.
 *
 * DELIBERATE: `counted_by` names the GENERATION of `countWords` that produced the row. The function
 * is the platform's own — what a word is can change with a release — and a count is only reusable by
 * the same generation of it. A row from another generation is re-counted and overwritten, so a
 * changed counter costs the read once and then nothing, instead of answering old numbers forever.
 *
 * DELIBERATE: filled on read. A writer would have to count on the write path, in the transaction
 * that files a revision, for a figure only the console reads; and every writer would have to
 * remember. The row is a cache of a pure function, inserted `on conflict do update` so two readers
 * racing on the same hash cannot disagree, and a failed insert is logged and not raised: the read
 * already has its answer.
 */
import type pg from "pg";

import { countWords } from "@zz/contracts";

/** The generation of `countWords` these rows were counted with. Bump it whenever that function's
 *  answer changes for the same bytes; every row is then re-counted once, by the reads that need it. */
const COUNTED_BY = 1;

/** The words of each named hash, counted now for the ones no row answers for.
 *
 *  `docIds` is the scope a body is fetched in: a hash is counted from a revision of one of these
 *  documents, so the fetch cannot reach a revision no caller could have named. */
export async function wordCounts(
  db: pg.Pool, docIds: readonly string[], hashes: readonly string[],
): Promise<Map<string, number>> {
  const words = new Map<string, number>();
  if (hashes.length === 0) return words;
  const known = await db.query<{ content_hash: string; words: number }>(
    "select content_hash, words from zz.doc_words where content_hash = any($1::text[]) and counted_by = $2",
    [[...hashes], COUNTED_BY]);
  for (const row of known.rows) words.set(row.content_hash, row.words);
  const missing = hashes.filter((h) => !words.has(h));
  if (missing.length === 0) return words;

  const bodies = await db.query<{ hash: string; body: string }>(
    `select distinct on (r.content_hash) r.content_hash as hash, r.body
       from zz.doc_revision r
      where r.doc_id = any($1::uuid[]) and r.content_hash = any($2::text[])`, [[...docIds], missing]);
  const counted: [string, number][] = bodies.rows.map((row) => [row.hash, countWords(row.body)]);
  for (const [hash, n] of counted) words.set(hash, n);

  // Counted first, stored second: the answer is the caller's whatever happens to the row. A hash the
  // scope did not hold a body for is counted for no read at all, so it is not written either — the
  // next read that can see its body counts it then.
  if (counted.length > 0) {
    try {
      await db.query(
        `insert into zz.doc_words (content_hash, words, counted_by)
         select * from unnest($1::text[], $2::integer[], $3::integer[])
         on conflict (content_hash) do update
            set words = excluded.words, counted_by = excluded.counted_by, counted_at = now()`,
        [counted.map(([hash]) => hash), counted.map(([, n]) => n), counted.map(() => COUNTED_BY)]);
    } catch (err) {
      console.error("console words: a count could not be kept, the read stands:", err);
    }
  }
  return words;
}
