/**
 * rederivation.ts — Task I-13: a generation-aware rederivation pass over rows that ALREADY
 * exist in `zz.doc`/`zz.knowledge_node`, not over files on disk. `index.ts`'s own
 * `reindexTeam`/`reindexAllTeams` rebuild a team's rows FROM its `.md` files and already call
 * `buildRowVector` on every write; this pass exists because that is not this task's contract —
 * `body_tsv` and `analyzer_version` are the only columns a rederivation may touch (content,
 * revisions, approvals and historical citations stay exactly as they are), and a row's own
 * `content_hash` never gates it. An analyzer generation bump changes what a row's vector
 * SHOULD be while its content stays byte-identical, which is exactly the case
 * `derivationFingerprint` (`tenant-analysis.ts`) was written to distinguish from "the source
 * changed" — and exactly the case `planRebuild`'s `skipUnchangedContentHash` refuses to hide.
 * Measured on this deployment: 841 `zz.doc` rows and 902 `zz.knowledge_node` rows exist today,
 * of which 173 documents and 5 nodes contain an unspaced Han run — none of it findable through
 * `body_tsv` until a row this old is rederived, because nothing about those rows' CONTENT is
 * stale.
 *
 * GENERATION, NOT CONTENT, IS THE CURSOR FOR "DOES THIS ROW NEED WORK." A row's own
 * `analyzer_version` column (migration 072) says which analyzer last wrote its `body_tsv` —
 * `null` for every row older than that migration. A row whose `analyzer_version` already
 * equals the target generation is left untouched; every other row is rederived, whether or
 * not its content has changed since the day it was written.
 *
 * RESUMABLE BY KEYSET, NEVER BY OFFSET. Each corpus is walked in one stable order — its own
 * primary key — and the watermark this pass returns is the last key it successfully passed,
 * encoded as a string specific to that corpus's key shape. Resuming means re-opening the same
 * cursor with the key strictly greater than the watermark: a row already advanced past is
 * never re-read, and a row not yet reached is never skipped, however many times a run is
 * interrupted and restarted.
 *
 * ONE CONSTRUCTION FOR THE VECTOR, NEVER A SECOND ONE. Every row's weighted term vector comes
 * from `rebuildRowVector` (`tenant-rebuild.ts`), which itself calls `buildRowVector`
 * (`tenant-analysis.ts`) — the exact function the write path calls on every new write. This
 * file never calls `analyze` itself and never re-derives the title/tags/body-to-A/B/C mapping;
 * `bodyTsvSql`/`bodyTsvParams` below are the write path's own `body_tsv` construction, imported
 * rather than restated, so the configuration each half of a row is stored through cannot differ
 * between a row this pass rewrites and a row `indexDoc` writes.
 */
import { rebuildRowVector } from "./tenant-rebuild.js";
import { bodyTsvParams, bodyTsvSql } from "./tenant-analysis.js";
import type { ProjectionClient } from "./tenant-projections.js";

/** The smallest shape this pass needs from a database connection — identical to
 *  `tenant-projections.ts`'s `ProjectionClient` (one `query`, no transaction control this pass
 *  needs of its own), aliased under this pass's own name because "a rederivation client" and
 *  "a migration-070 projection client" are two different callers' idea of the same shape, not
 *  one concept borrowed from the other. */
export type RederivationClient = ProjectionClient;

// ── which corpora this pass knows, and only these ──────────────────────────────────────────

const REDERIVABLE_CORPORA = ["zz.doc", "zz.knowledge_node"] as const;
type RederivableCorpus = typeof REDERIVABLE_CORPORA[number];

function isRederivableCorpus(corpus: string): corpus is RederivableCorpus {
  return (REDERIVABLE_CORPORA as readonly string[]).includes(corpus);
}

// ── planning: pure, no I/O, no database in reach ────────────────────────────────────────────

export interface RebuildPlan {
  readonly corpora: readonly string[];
  readonly skipUnchangedContentHash: boolean;
  readonly resumable: boolean;
}

/** What a rebuild for `analyzer` (replacing whatever `previous` last served) WOULD do — no
 *  I/O, and never itself decides a single row's fate. Two generations that are already the
 *  same name nothing to rebuild: `corpora` comes back empty, which is the honest plan for
 *  "nothing changed," not a refusal to plan at all. Any other pair plans both application
 *  corpora, never skips a row on an unchanged content hash (the analyzer changed; the hash did
 *  not), and always declares itself resumable — the keyset watermark this file's own header
 *  describes, not an optional feature a caller has to ask for. */
export function planRebuild(input: { readonly analyzer: string; readonly previous: string }): RebuildPlan {
  if (input.analyzer === input.previous) {
    return { corpora: [], skipUnchangedContentHash: false, resumable: true };
  }
  return { corpora: [...REDERIVABLE_CORPORA], skipUnchangedContentHash: false, resumable: true };
}

// ── generation compatibility: what a query path may say about a mismatch ───────────────────

export interface GenerationQuery {
  readonly indexGeneration: string;
  readonly queryGeneration: string;
  /** How far an actual rebuild has gotten, when the caller has that record in hand — a live
   *  query endpoint deciding what to tell a caller mid-rebuild, never this function's own
   *  guess. Absent, this function can only ever tell "matches" from "does not," which is why
   *  it never reports partial progress without it — that would be exactly the kind of
   *  fabrication this platform's own data-safety rules refuse elsewhere. */
  readonly progress?: { readonly rederived: number; readonly total: number };
}

export interface GenerationStatusResult {
  // `string`, not a literal union — the same reasoning `RowVectorTerm.weight` states in
  // `tenant-analysis.ts`: a caller comparing this against a value outside the closed set this
  // function currently returns must be able to, without narrowing it first.
  readonly status: string;
}

/** Analyzer generation pairs a person has explicitly reviewed and declared query-compatible —
 *  empty today, on purpose. `zz-lexical-v1` → `zz-lexical-v2` changed Han segmentation itself
 *  (`tenant-analysis.ts`'s own header), which is exactly the kind of change a boolean/phrase
 *  match under the old vocabulary cannot survive; nothing has been declared compatible with
 *  anything yet, and a future analyzer bump that provably touches only ranking earns an entry
 *  here explicitly rather than this function inferring one from the version numbers alone. */
const DECLARED_COMPATIBLE_PAIRS = new Set<string>();

function pairKey(a: string, b: string): string {
  return `${a}\u0000${b}`;
}

/** Whether a query issued expecting `queryGeneration` may trust an index actually built under
 *  `indexGeneration`. Matching generations are `ok`. A declared-compatible pair (see above) is
 *  `compatible_pair`. Anything else is a real mismatch, disclosed rather than silently served:
 *  `incomplete` when the caller's own `progress` shows a rebuild under way and partial,
 *  `index_not_ready` otherwise — no rebuild has reached this corpus at all, as far as this call
 *  can tell. NEVER `ok` for a genuine mismatch: a one-sided upgrade that reported `ok` would
 *  return a confident, complete-looking empty result set indistinguishable from "nothing
 *  matched," which is a worse failure than refusing the query outright. */
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

// ── the rebuild record a caller gets back, per corpus ───────────────────────────────────────

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
  /** `true` only when this run's last page came back short of a full batch — the honest end
   *  of the table, not "this run stopped." A caller resuming from `watermark` after `false`
   *  picks up exactly where this run left off, whether it stopped because of a real error, a
   *  process restart, or simply has not reached the end yet. */
  readonly complete: boolean;
  /** Who actually ran this and how it read the corpus — supplied by the caller, never guessed,
   *  matching this package's existing rule for `corpusKey` in `tenant-projections.ts` ("only
   *  the caller knows that mapping"): only the caller knows which process is executing this
   *  and which connection it is reading through. */
  readonly route: { readonly worker: string; readonly reader: string };
}

const DEFAULT_BATCH_SIZE = 200;

// ── zz.doc: primary key is the (team_slug, initiative, path) triple ────────────────────────

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
  // Only the two derived columns move — title/body/tags/status/approvals and every other
  // column this task's contract names as untouched are absent from this statement entirely,
  // not merely left out of the SET list by convention.
  await client.query(
    `update zz.doc
        set analyzer_version = $4,
            body_tsv = ${bodyTsvSql(5)}
      where team_slug = $1 and initiative = $2 and path = $3`,
    [key.team_slug, key.initiative, key.path, analyzer, ...bodyTsvParams(vector)]);
}

// ── zz.knowledge_node: primary key is the uuid `id` column ─────────────────────────────────

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

// ── census, and the walk itself ─────────────────────────────────────────────────────────────

/** `corpus` is narrowed to `RederivableCorpus` by every caller below before this runs, and
 *  the two members of that closed set ARE this pass's own table names — never text a caller
 *  supplies, which is what makes interpolating it into the query text safe here the same way
 *  `ensureCorpus`'s regex-validated `corpusKey` is safe in `tenant-projections.ts`. */
async function census(client: RederivationClient, corpus: RederivableCorpus): Promise<number> {
  const result = await client.query<{ n: string }>(`select count(*)::text as n from ${corpus}`);
  return Number(result.rows[0]?.n ?? "0");
}

/** Walks ONE corpus, from `request.afterWatermark` (or the start), rederiving every row whose
 *  `analyzer_version` is not already `request.analyzer` — never gated on content, per this
 *  task's own contract. Every row's vector comes from `rebuildRowVector`, which is this pass's
 *  only path to `buildRowVector`'s weighting; this function never re-derives a term itself. A
 *  row that throws is recorded in `failures` and the walk continues past it — one bad row must
 *  not abandon the whole corpus, and a permanently-failing row must not block every row after
 *  it from ever being reached on a resume. */
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

/** Every corpus `planRebuild` names for this generation pair, walked in the order `planRebuild`
 *  returns them — no parallelism across corpora, so a caller reading progress mid-run always
 *  sees at most one corpus in flight. `afterWatermarks` resumes each corpus independently, keyed
 *  by corpus name, from a prior interrupted run's own `CorpusRebuildRecord.watermark`. */
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
