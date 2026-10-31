/**
 * The generation-aware rederivation's planning and its record, over rows that already exist in
 * `zz.doc`/`zz.knowledge_node`. `body_tsv` and `analyzer_version` are the only columns a
 * rederivation may touch; content, revisions, approvals and historical citations stay as they are,
 * and a row's `content_hash` never gates it. An analyzer generation bump changes what a row's
 * vector should be while its content stays byte-identical.
 *
 * Generation, not content, is the cursor. A row's `analyzer_version` column says which analyzer
 * last wrote its `body_tsv`, and is `null` for every row older than the column. A row already at
 * the target generation is left untouched; every other row is rederived.
 *
 * COUPLED: the walk is `index.ts`'s `rederiveCorpus`, the same one `reindexTeam` runs, and every
 * row's vector comes from `rebuildRowVector` below, which calls `buildRowVector`
 * (`tenant-analysis.ts`) — the function the write path calls on every write.
 */
import { buildRowVector } from "./tenant-analysis.js";

/** The smallest shape the walk needs from a database connection: one `query(text, params)`. A
 *  pool and a single client both have it. */
export interface RederivationClient {
  query<T = Record<string, unknown>>(text: string, params?: readonly unknown[]): Promise<{ rows: T[] }>;
}

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

// Which corpora this pass knows, and only these

/** COUPLED: the corpora `index.ts`'s `CORPORA` walks, by table name. */
const REDERIVABLE_CORPORA = ["zz.doc", "zz.knowledge_node"] as const;

// Planning: pure, no I/O, no database in reach

export interface RebuildPlan {
  readonly corpora: readonly string[];
  readonly skipUnchangedContentHash: boolean;
  readonly resumable: boolean;
}

/** What a rebuild for `analyzer` (replacing whatever `previous` last served) would do — no
 *  I/O, and it never decides a single row's fate. Two generations already the same plan
 *  nothing: `corpora` comes back empty. Any other pair plans both application corpora, never
 *  skips a row on an unchanged content hash, and always declares itself resumable. */
export function planRebuild(input: { readonly analyzer: string; readonly previous: string }): RebuildPlan {
  if (input.analyzer === input.previous) {
    return { corpora: [], skipUnchangedContentHash: false, resumable: true };
  }
  return { corpora: [...REDERIVABLE_CORPORA], skipUnchangedContentHash: false, resumable: true };
}

// Generation compatibility: what a query path may say about a mismatch

export interface GenerationQuery {
  readonly indexGeneration: string;
  readonly queryGeneration: string;
  /** How far an actual rebuild has gotten, when the caller has that record in hand. Absent,
   *  this function can only tell "matches" from "does not" and never reports partial
   *  progress. */
  readonly progress?: { readonly rederived: number; readonly total: number };
}

export interface GenerationStatusResult {
  // `string`, not a literal union, so a caller comparing this against a value outside the
  // closed set this function currently returns can do so without narrowing first.
  readonly status: string;
}

/** Analyzer generation pairs a person has explicitly reviewed and declared query-compatible —
 *  empty today. `zz-lexical-v1` → `zz-lexical-v2` changed Han segmentation itself, which a
 *  boolean or phrase match under the old vocabulary cannot survive. A future bump that
 *  provably touches only ranking earns an entry here explicitly; nothing is inferred from the
 *  version numbers. */
const DECLARED_COMPATIBLE_PAIRS = new Set<string>();

function pairKey(a: string, b: string): string {
  return `${a}\u0000${b}`;
}

/** Whether a query issued expecting `queryGeneration` may trust an index built under
 *  `indexGeneration`. Matching generations are `ok`; a declared-compatible pair is
 *  `compatible_pair`. Anything else is `incomplete` when the caller's `progress` shows a
 *  rebuild under way and partial, `index_not_ready` otherwise. Never `ok` for a genuine
 *  mismatch: that returns a complete-looking empty result set indistinguishable from "nothing
 *  matched". */
export function queryGeneration(input: GenerationQuery): GenerationStatusResult {
  if (input.indexGeneration === input.queryGeneration) return { status: "ok" };
  if (DECLARED_COMPATIBLE_PAIRS.has(pairKey(input.indexGeneration, input.queryGeneration))
    || DECLARED_COMPATIBLE_PAIRS.has(pairKey(input.queryGeneration, input.indexGeneration))) {
    return { status: "compatible_pair" };
  }
  const p = input.progress;
  if (p && p.total > 0 && p.rederived > 0 && p.rederived < p.total) return { status: "incomplete" };
  return { status: "index_not_ready" };
}

// The rebuild record a caller gets back, per corpus

export interface CorpusRebuildRecord {
  readonly corpus: string;
  readonly analyzer: string;
  readonly sourceCensus: number;
  readonly rederived: number;
  readonly skipped: number;
  readonly failures: readonly { readonly key: string; readonly reason: string }[];
  /** The last key this run passed, or the watermark it resumed from when it passed none. Feed
   *  straight back in as `afterWatermark` to resume. */
  readonly watermark: string | null;
  /** Who ran this and how it read the corpus — supplied by the caller, never guessed: only the
   *  caller knows which process is executing and which connection it reads through. */
  readonly route: { readonly worker: string; readonly reader: string };
}
