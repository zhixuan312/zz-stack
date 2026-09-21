/**
 * corpus-registry.ts — which corpora this deployment actually holds, who owns each one, and
 * what audience it carries.
 *
 * ITS OWN FILE, AND ITS OWN SUBJECT. `resolveCorpora` (retrieval.ts, I-16) takes
 * `registry: readonly CorpusRegistryEntry[]` and its own comment says the caller owns loading
 * it; nothing did, which is why the retrieval stack had no reachable entry point at all. This
 * is that loader. It moved out of `services/zz-core/src/tools/knowledge-search.ts` — the
 * integration target the specification declares — when that file, carrying the whole composed
 * request path as well, reached 766 lines against a measured 700-line ceiling.
 *
 * WHICH HALF MOVED was decided the way it was for `lanes.ts` and `pinned-read.ts` before it.
 * No frozen check pins a symbol to either path, so the seam is what the two halves are ABOUT:
 * this one answers a question about the deployment's CONFIGURATION — which partitions exist and
 * what each one may be shown to — and is read once per request before any authorization
 * decision; the other serves one request. They fail differently too: a registry fault is a
 * misconfigured deployment a caller can do nothing about (`REGISTRY_MISCONFIGURED`), and a
 * request fault is the caller's.
 */
import {
  RetrievalError, type CorpusDescriptor, type RetrievalClient,
} from "./retrieval.js";
import { corpusBm25Index } from "./lanes.js";

// ── the corpus registry, loaded rather than assumed ────────────────────────────────────────

/**
 * `resolveCorpora` takes `registry: readonly CorpusRegistryEntry[]` and its own comment says
 * the caller owns loading it. Nothing loaded one — which is why the integration waited: four
 * recall lanes behind an authorization gate whose input did not exist.
 *
 * WHERE AN ENTRY COMES FROM. There is no registry table, and inventing one would be a schema
 * this delivery never declared. A corpus is a RUNTIME fact — `ensureCorpus`
 * (`packages/indexing/src/tenant-projections.ts`) attaches one list partition per corpus key to
 * each of the three `zz.search_*` parents the first time that corpus holds a row — so the
 * corpora that exist are exactly the (corpus_key, owner_id, scope) combinations those tables
 * carry, and this query asks them.
 *
 * `index_name` IS THE PARTITION, spelled the way `ensureCorpus` spells it (`<parent>_<key>`).
 * That is the physical index whose term statistics a corpus's rows share, which is the thing
 * `assertOneOwnerPerIndex` is about — not a name invented for the registry to have a field.
 *
 * `audience` IS DERIVED FROM THE LIFECYCLE EVENTS, not from `zz.artifact.audience`. That column
 * exists and is null on every row: nothing writes it, and migration 070's search tables carry
 * no audience column at all, so a loader reading it would hand `resolveCorpora` a value that is
 * structurally always absent — and `resolveCorpora` admits an entry through exactly two named
 * branches, so "always absent" means "no corpus ever resolves". What DOES get written is the
 * event `policies.ts` names: `publish` → a `published` event, `unpublish` → an `unpublished`
 * one (`LIFECYCLE_EVENT_KIND`). The latest of those two for an artifact is its publication
 * state, and a corpus's audience is the aggregate below.
 *
 * ALL, NOT ANY, AND FAIL-CLOSED. A corpus is `published` only when EVERY artifact in it is
 * currently published; an artifact that was never published, or whose latest transition is
 * `unpublished`, makes the whole corpus `private`. `search()` authorizes once per corpus and
 * never rechecks a single artifact's publication state, so "any published artifact publishes
 * the corpus" would disclose every unpublished neighbour sharing it to a shared reader. A
 * corpus holding no artifacts is `private` for the same reason — an empty grant is not a grant.
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
 * REFUSES A TWO-OWNER CORPUS HERE, naming both owners and the corpus, rather than emitting
 * entries and letting `assertOneOwnerPerIndex` refuse them at every later call. Both refusals
 * are `REGISTRY_MISCONFIGURED` and both are correct; this one can say WHICH corpus_key is
 * misconfigured, because it is holding the rows that prove it, and it fails at load rather than
 * once per request. The invariant is the same one `testing/tenant-info/isolation.ts` measures:
 * two owners sharing one physical index share its term and document frequencies, so each one's
 * writes move the other's bm25 scores while every returned row stays perfectly correct.
 */
export async function loadCorpusRegistry(client: RetrievalClient): Promise<CorpusDescriptor[]> {
  const { rows } = await client.query<RegistryRow>(CORPUS_REGISTRY_SQL, []);
  const ownerByIndex = new Map<string, string>();
  const registry: CorpusDescriptor[] = [];
  for (const row of rows) {
    const total = Number(row.artifacts);
    const published = Number(row.published_artifacts);
    // THE BM25 INDEX NAME, not the partition's. `to_bm25query`'s second argument is an INDEX,
    // and this computed a partition name — one field standing for two different objects, which
    // a real PostgreSQL 17 refused the first time the lane ran: "index ... is not on column
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

