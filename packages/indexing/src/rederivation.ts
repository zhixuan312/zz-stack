/**
 * A generation-aware rederivation pass over rows that already exist in
 * `zz.doc`/`zz.knowledge_node`, not over files on disk. `body_tsv` and `analyzer_version` are
 * the only columns it may touch; content, revisions, approvals and historical citations stay
 * as they are, and a row's `content_hash` never gates it. An analyzer generation bump changes
 * what a row's vector should be while its content stays byte-identical.
 * COUPLED: `index.ts`'s `reindexTeam`/`reindexAllTeams` rebuild rows from `.md` files instead.
 *
 * Generation, not content, is the cursor. A row's `analyzer_version` column says which
 * analyzer last wrote its `body_tsv`, and is `null` for every row older than the column. A
 * row already at the target generation is left untouched; every other row is rederived.
 *
 * Resumable by keyset, never by offset. Each corpus is walked in its own primary-key order,
 * and the watermark returned is the last key successfully passed, encoded for that corpus's
 * key shape. Resuming re-opens the cursor strictly greater than the watermark.
 *
 * COUPLED: every row's vector comes from `rebuildRowVector` (`tenant-rebuild.ts`), which calls
 * `buildRowVector` (`tenant-analysis.ts`) — the function the write path calls on every write.
 * `bodyTsvSql`/`bodyTsvParams` are the write path's own construction, imported rather than
 * restated, so the two halves of a row cannot be stored through different configurations.
 */
import { rebuildRowVector } from "./tenant-rebuild.js";
import { bodyTsvParams, bodyTsvSql } from "./tenant-analysis.js";
import type { ProjectionClient } from "./tenant-projections.js";

/** The smallest shape this pass needs from a database connection — identical to
 *  `tenant-projections.ts`'s `ProjectionClient`, aliased under this pass's own name. */
export type RederivationClient = ProjectionClient;

// Which corpora this pass knows, and only these

const REDERIVABLE_CORPORA = ["zz.doc", "zz.knowledge_node"] as const;
type RederivableCorpus = typeof REDERIVABLE_CORPORA[number];

function isRederivableCorpus(corpus: string): corpus is RederivableCorpus {
  return (REDERIVABLE_CORPORA as readonly string[]).includes(corpus);
}

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
  /** The last key this run passed, encoded for this corpus — `null` only when the corpus was
   *  empty from the very first page. Feed straight back in as `afterWatermark` to resume. */
  readonly watermark: string | null;
  /** `true` only when this run's last page came back short of a full batch — the end of the
   *  table, not "this run stopped". A caller resuming from `watermark` after `false` picks up
   *  where this run left off. */
  readonly complete: boolean;
  /** Who ran this and how it read the corpus — supplied by the caller, never guessed: only the
   *  caller knows which process is executing and which connection it reads through. */
  readonly route: { readonly worker: string; readonly reader: string };
}

const DEFAULT_BATCH_SIZE = 200;

// zz.doc: primary key is the (team_slug, initiative, path) triple

interface DocKey { readonly team_slug: string; readonly initiative: string; readonly path: string; }

function encodeDocKey(k: DocKey): string { return JSON.stringify([k.team_slug, k.initiative, k.path]); }
function decodeDocKey(w: string): DocKey {
  const [team_slug, initiative, path] = JSON.parse(w) as [string, string, string];
  return { team_slug, initiative, path };
}

interface DocRow extends DocKey {
  readonly title: string | null;
  readonly tags: readonly string[] | null;
  readonly body: string | null;
  readonly analyzer_version: string | null;
}

async function fetchDocPage(client: RederivationClient, after: DocKey | null, limit: number): Promise<DocRow[]> {
  const result = after
    ? await client.query<DocRow>(
        `select team_slug, initiative, path, title, tags, body, analyzer_version
           from zz.doc
          where (team_slug, initiative, path) > ($1, $2, $3)
          order by team_slug, initiative, path
          limit $4`,
        [after.team_slug, after.initiative, after.path, limit])
    : await client.query<DocRow>(
        `select team_slug, initiative, path, title, tags, body, analyzer_version
           from zz.doc
          order by team_slug, initiative, path
          limit $1`,
        [limit]);
  return result.rows;
}

async function writeDocRow(
  client: RederivationClient, key: DocKey, vector: ReturnType<typeof rebuildRowVector>, analyzer: string,
): Promise<void> {
  // Only the two derived columns move. Every other column is absent from this statement
  // entirely, not merely left out of the SET list.
  await client.query(
    `update zz.doc
        set analyzer_version = $4,
            body_tsv = ${bodyTsvSql(5)}
      where team_slug = $1 and initiative = $2 and path = $3`,
    [key.team_slug, key.initiative, key.path, analyzer, ...bodyTsvParams(vector)]);
}

// zz.knowledge_node: primary key is the uuid `id` column

interface NodeRow {
  readonly id: string;
  readonly title: string | null;
  readonly tags: readonly string[] | null;
  readonly body: string | null;
  readonly analyzer_version: string | null;
}

async function fetchNodePage(client: RederivationClient, after: string | null, limit: number): Promise<NodeRow[]> {
  const result = after
    ? await client.query<NodeRow>(
        `select id::text as id, title, tags, body, analyzer_version
           from zz.knowledge_node
          where id > $1::uuid
          order by id
          limit $2`,
        [after, limit])
    : await client.query<NodeRow>(
        `select id::text as id, title, tags, body, analyzer_version
           from zz.knowledge_node
          order by id
          limit $1`,
        [limit]);
  return result.rows;
}

async function writeNodeRow(
  client: RederivationClient, id: string, vector: ReturnType<typeof rebuildRowVector>, analyzer: string,
): Promise<void> {
  await client.query(
    `update zz.knowledge_node
        set analyzer_version = $2,
            body_tsv = ${bodyTsvSql(3)}
      where id = $1::uuid`,
    [id, analyzer, ...bodyTsvParams(vector)]);
}

// Census, and the walk itself

/** `corpus` is narrowed to `RederivableCorpus` by every caller before this runs, and the two
 *  members of that closed set are this pass's own table names — never text a caller supplies,
 *  which is what makes interpolating it into the query text safe. */
async function census(client: RederivationClient, corpus: RederivableCorpus): Promise<number> {
  const result = await client.query<{ n: string }>(`select count(*)::text as n from ${corpus}`);
  return Number(result.rows[0]?.n ?? "0");
}

/** Walks one corpus, from `request.afterWatermark` or the start, rederiving every row whose
 *  `analyzer_version` is not already `request.analyzer`; never gated on content. Every vector
 *  comes from `rebuildRowVector`, and this function never re-derives a term itself. A row that
 *  throws is recorded in `failures` and the walk continues past it, so a permanently-failing
 *  row cannot block every row after it on a resume. */
export async function rederiveCorpus(
  client: RederivationClient,
  request: {
    readonly corpus: string;
    readonly analyzer: string;
    readonly afterWatermark?: string | null;
    readonly batchSize?: number;
    readonly route: { readonly worker: string; readonly reader: string };
  },
): Promise<CorpusRebuildRecord> {
  if (!isRederivableCorpus(request.corpus)) {
    throw new RangeError(`${request.corpus} is not a corpus this rederivation pass knows — refusing rather than guessing its schema`);
  }
  const corpus = request.corpus;
  const limit = request.batchSize ?? DEFAULT_BATCH_SIZE;
  const sourceCensus = await census(client, corpus);

  let rederived = 0, skipped = 0;
  const failures: { key: string; reason: string }[] = [];
  let watermark = request.afterWatermark ?? null;
  let complete = false;

  if (corpus === "zz.doc") {
    let after = watermark ? decodeDocKey(watermark) : null;
    for (;;) {
      const page = await fetchDocPage(client, after, limit);
      for (const row of page) {
        const key: DocKey = { team_slug: row.team_slug, initiative: row.initiative, path: row.path };
        try {
          if (row.analyzer_version !== request.analyzer) {
            await writeDocRow(client, key, rebuildRowVector(row), request.analyzer);
            rederived++;
          } else {
            skipped++;
          }
        } catch (err) {
          failures.push({ key: encodeDocKey(key), reason: err instanceof Error ? err.message : String(err) });
        }
        after = key;
        watermark = encodeDocKey(key);
      }
      if (page.length < limit) { complete = true; break; }
    }
  } else {
    let after = watermark;
    for (;;) {
      const page = await fetchNodePage(client, after, limit);
      for (const row of page) {
        try {
          if (row.analyzer_version !== request.analyzer) {
            await writeNodeRow(client, row.id, rebuildRowVector(row), request.analyzer);
            rederived++;
          } else {
            skipped++;
          }
        } catch (err) {
          failures.push({ key: row.id, reason: err instanceof Error ? err.message : String(err) });
        }
        after = row.id;
        watermark = row.id;
      }
      if (page.length < limit) { complete = true; break; }
    }
  }

  return { corpus, analyzer: request.analyzer, sourceCensus, rederived, skipped, failures, watermark, complete, route: request.route };
}

/** Every corpus `planRebuild` names for this generation pair, walked in the order it returns
 *  them — no parallelism across corpora, so a caller reading progress mid-run sees at most one
 *  corpus in flight. `afterWatermarks` resumes each corpus independently, keyed by corpus
 *  name, from a prior run's `CorpusRebuildRecord.watermark`. */
export async function rederiveAll(
  client: RederivationClient,
  request: {
    readonly analyzer: string;
    readonly previous: string;
    readonly afterWatermarks?: Readonly<Record<string, string | null>>;
    readonly batchSize?: number;
    readonly route: { readonly worker: string; readonly reader: string };
  },
): Promise<readonly CorpusRebuildRecord[]> {
  const plan = planRebuild({ analyzer: request.analyzer, previous: request.previous });
  const records: CorpusRebuildRecord[] = [];
  for (const corpus of plan.corpora) {
    records.push(await rederiveCorpus(client, {
      corpus, analyzer: request.analyzer,
      afterWatermark: request.afterWatermarks?.[corpus] ?? null,
      batchSize: request.batchSize, route: request.route,
    }));
  }
  return records;
}
