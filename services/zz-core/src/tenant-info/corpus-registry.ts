/**
 * Which corpora this deployment holds, who owns each one, and what audience it carries — the
 * registry `resolveCorpora` (retrieval.ts) takes and does not load for itself.
 *
 * Separate from the composed request path in `knowledge-search.ts`: this answers a question
 * about the deployment's configuration, read once per request before any authorization
 * decision, and it fails differently — a registry fault is a misconfigured deployment a
 * caller can do nothing about (`REGISTRY_MISCONFIGURED`), where a request fault is the
 * caller's.
 */
import {
  RetrievalError, type CorpusDescriptor, type RetrievalClient,
} from "./retrieval.js";
import { corpusBm25Index } from "./lanes.js";

// The corpus registry, loaded rather than assumed

/**
 * There is no registry table. A corpus is a runtime fact — `ensureCorpus`
 * (`packages/indexing/src/tenant-projections.ts`) attaches one list partition per corpus key
 * to each of the three `zz.search_*` parents the first time that corpus holds a row — so the
 * corpora that exist are exactly the (corpus_key, owner_id, scope) combinations those tables
 * carry, and this query asks them.
 *
 * COUPLED: `index_name` is the BM25 index on the corpus partition, spelled by
 * `corpusBm25Index` (lanes.ts) the way `ensureCorpus` (tenant-projections.ts) creates it. That
 * is the physical index whose term statistics a corpus's rows share, which is what
 * the one-owner-per-index rule is about.
 *
 * DELIBERATE: `audience` is derived from the lifecycle events, not from
 * `zz.artifact.audience`. Nothing writes that column and the search tables carry
 * no audience column at all, so a loader reading it would hand `resolveCorpora` a value that
 * is always absent — and `resolveCorpora` admits an entry through two named branches, so no
 * corpus would ever resolve. `policies.ts` writes a `published` event on publish and an
 * `unpublished` one on unpublish; the latest of the two is an artifact's publication state.
 *
 * DELIBERATE: all, not any, and fail-closed. A corpus is `published` only when every artifact
 * in it is currently published, and a corpus holding no artifacts is `private`. `search()`
 * authorizes once per corpus and never rechecks a single artifact, so publishing a corpus on
 * any one published artifact would disclose every unpublished neighbour to a shared reader.
 */
const CORPUS_REGISTRY_SQL = `
select c.corpus_key, c.owner_id, c.scope,
       count(*) as artifacts,
       count(*) filter (where live.kind = 'published') as published_artifacts
  from (
    select distinct corpus_key, owner_id, artifact_id, 'current'::text as scope from zz.search_current
    union all
    select distinct corpus_key, owner_id, artifact_id, 'evidence'::text as scope from zz.search_evidence
    union all
    select distinct corpus_key, owner_id, artifact_id, 'history'::text as scope from zz.search_history
  ) c
  left join lateral (
    select e.kind from zz.artifact_event e
     where e.owner_id = c.owner_id and e.artifact_id = c.artifact_id
       and e.kind in ('published', 'unpublished')
     order by e.sequence desc
     limit 1
  ) live on true
 group by c.corpus_key, c.owner_id, c.scope`;

interface RegistryRow {
  readonly corpus_key: string;
  readonly owner_id: string;
  readonly scope: string;
  readonly artifacts: number | string;
  readonly published_artifacts: number | string;
}

/**
 * Every corpus this deployment actually holds, as `resolveCorpora`'s registry.
 *
 * DELIBERATE: a two-owner corpus is refused here, naming both owners and the corpus, rather
 * than emitted for a later caller to refuse on. Both refusals are
 * `REGISTRY_MISCONFIGURED`; this one holds the rows that prove which corpus_key is at fault,
 * and it fails at load rather than once per request. Two owners sharing one physical index
 * share its term and document frequencies, so each one's writes move the other's bm25 scores
 * while every returned row stays correct — `testing/tenant-info/isolation.ts` measures it.
 */
export async function loadCorpusRegistry(client: RetrievalClient): Promise<CorpusDescriptor[]> {
  const { rows } = await client.query<RegistryRow>(CORPUS_REGISTRY_SQL, []);
  const ownerByIndex = new Map<string, string>();
  const registry: CorpusDescriptor[] = [];
  for (const row of rows) {
    const total = Number(row.artifacts);
    const published = Number(row.published_artifacts);
    // The BM25 index name, not the partition's: `to_bm25query`'s second argument is an index,
    // and PostgreSQL refuses a partition name there with "index ... is not on column
    // raw_body". `corpusBm25Index` spells it the way `ensureCorpus` creates it.
    const index_name = corpusBm25Index(row.scope, row.corpus_key);
    const seen = ownerByIndex.get(index_name);
    if (seen !== undefined && seen !== row.owner_id) {
      throw new RetrievalError("REGISTRY_MISCONFIGURED",
        `corpus ${JSON.stringify(row.corpus_key)} holds documents for two owners (${seen} and ` +
        `${row.owner_id}) at scope ${row.scope}: they would share the term statistics of one ` +
        `partition, ${index_name}, and each owner's writes would move the other's ranking`);
    }
    ownerByIndex.set(index_name, row.owner_id);
    registry.push({
      corpus_key: row.corpus_key,
      owner_id: row.owner_id,
      scope: row.scope,
      audience: total > 0 && published === total ? "published" : "private",
      index_name,
    });
  }
  return registry;
}

