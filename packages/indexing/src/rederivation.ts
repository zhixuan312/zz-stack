/**
 * One existing `zz.doc`/`zz.knowledge_node` row's vector, rebuilt from what the row holds.
 * `body_tsv` and `analyzer_version` are the only columns a rederivation may touch; content,
 * revisions, approvals and historical citations stay as they are, and a row's `content_hash`
 * never gates it. An analyzer generation bump changes what a row's vector should be while its
 * content stays byte-identical.
 *
 * Generation, not content, is the cursor. A row's `analyzer_version` column says which analyzer
 * last wrote its `body_tsv`, and is `null` for every row older than the column.
 *
 * COUPLED: the walk is `index.ts`'s `reindexTeam`, and every row's vector comes from
 * `rebuildRowVector` below, which calls `buildRowVector` (`tenant-analysis.ts`) — the function the
 * write path calls on every write.
 */
import { buildRowVector } from "./tenant-analysis.js";

// One row's vector, from a raw database row

/** The columns `rebuildRowVector` reads. `title`/`body` are `not null default ''` and `tags` is
 *  `not null default '{}'` on both tables, but the column types do not promise that for every
 *  caller, and `buildRowVector`'s contract takes `{title, tags, body}` with no room for `null`. */
export interface RebuildRowInput {
  readonly title: string | null;
  readonly tags: readonly string[] | null;
  readonly body: string | null;
}

/** The vector the write path would produce for this row, rebuilt from what the row holds.
 *
 * COUPLED: the gate check `rederivation-generation.ts` reads this file's own source for an
 * `import { buildRowVector … }` line — that import is how it verifies the rederivation path and
 * the write path share one weighting implementation.
 *
 * DELIBERATE: not an alias of `buildRowVector`. What earns it its own name is the normalization a
 * raw database row needs. */
export function rebuildRowVector(row: RebuildRowInput): ReturnType<typeof buildRowVector> {
  return buildRowVector({
    title: row.title ?? "",
    tags: row.tags ?? [],
    body: row.body ?? "",
  });
}
