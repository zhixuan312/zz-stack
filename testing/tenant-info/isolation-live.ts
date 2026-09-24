/**
 * The two cases that ask PostgreSQL instead of modelling it. `isolation.ts`'s offline group
 * computes idf in TypeScript over a fake index, which proves the comparator and the query
 * shape; these compute nothing and ask the database for the number a user's search would be
 * ranked by.
 *
 * COUPLED: `checks/tenant-isolation-statistics.ts` imports `validateIsolationObservation`
 * from `isolation.ts` by name, and a frozen check's bytes cannot follow a symbol elsewhere.
 * Nothing pins these two, which is why they are the half that lives here.
 */
import assert from "node:assert/strict";

export const LIVE_DB_ENV = "ZZ_TENANT_INFO_ISOLATED_DB_URL";

/**
 * A client on the isolated database, or a refusal naming what is missing.
 *
 * What these two cases measure is the one property the offline cases can only model: another
 * tenant's writes do not move this tenant's BM25 statistics.
 */
async function liveClient(): Promise<{ query: (t: string, p?: readonly unknown[]) => Promise<{ rows: Record<string, unknown>[] }>; close: () => Promise<void> }> {
  const { connectIsolated } = await import("../../packages/indexing/dist/tenant-projections.js");
  return connectIsolated((process.env[LIVE_DB_ENV] ?? "").trim()) as never;
}

const LIVE_A = "66666666-6666-4666-8666-666666666666";
const LIVE_B = "77777777-7777-4777-8777-777777777777";

async function seedLive(
  client: { query: (t: string, p?: readonly unknown[]) => Promise<{ rows: Record<string, unknown>[] }> },
  corpus: string, owner: string, count: number, term: string, hitEvery: number,
): Promise<void> {
  for (let i = 0; i < count; i++) {
    const body = i % hitEvery === 0 ? `filler filler ${term} filler` : "filler filler filler filler";
    await client.query(
      `insert into zz.search_current (corpus_key, owner_id, artifact_id, revision, content_hash,
         title, type, tags, path, raw_body, analyzer_version, projection_hash)
       values ($1,$2,$3,1,$4,'t','Decision','{}',$5,$6,'zz-lexical-v1',$7)
       on conflict do nothing`,
      [corpus, owner, `${owner.slice(0, 8)}-0000-4000-8000-${String(i).padStart(12, "0")}`,
       "a".repeat(64), `p${i}.md`, body, "b".repeat(64)]);
  }
}

/** Top-k for owner A, through the real lane query builder, against the real bm25 index. */
async function observeLive(
  client: { query: (t: string, p?: readonly unknown[]) => Promise<{ rows: Record<string, unknown>[] }> },
  corpus: string, owner: string, term: string,
): Promise<{ id: string; score: number }[]> {
  // COUPLED: the partition and the index both come from the production helpers, never
  // spelled again here. A table name built inline also reads to the gate's static scan as a
  // relation no migration creates.
  const { corpusBm25Index, corpusPartition } = await import("../../services/zz-core/dist/tenant-info/lanes.js");
  const index = corpusBm25Index("current", corpus);
  const partition = corpusPartition("current", corpus);
  const { rows } = await client.query(
    `select s.artifact_id, s.raw_body <@> to_bm25query($3, $4) as score
       from ${partition} s
      where s.corpus_key = $1 and s.owner_id = $2
      order by s.raw_body <@> to_bm25query($3, $4)
      limit 10`, [corpus, owner, term, index]);
  return rows.map((r) => ({ id: String(r.artifact_id), score: Number(r.score) }));
}

async function caseRealPg17StatisticalIsolation(): Promise<void> {
  const { ensureCorpus } = await import("../../packages/indexing/dist/tenant-projections.js");
  const client = await liveClient();
  const term = "zzisolationterm";
  const a = `iso_a_${Date.now()}`;
  const b = `iso_b_${Date.now()}`;
  try {
    await ensureCorpus(client as never, a);
    await ensureCorpus(client as never, b);
    await seedLive(client, a, LIVE_A, 40, term, 2);
    const before = await observeLive(client, a, LIVE_A, term);
    assert.ok(before.length > 0, "owner A must have real matches before anything is compared");
    assert.ok(before.some((r) => r.score < 0), "a real BM25 match scores negative; nothing matched");

    // Owner B, its own corpus, partition and index, with every document naming the term:
    // the maximum statistical pressure one tenant can put on another.
    await seedLive(client, b, LIVE_B, 500, term, 1);
    const after = await observeLive(client, a, LIVE_A, term);

    assert.deepEqual(after.map((r) => r.id), before.map((r) => r.id),
      "owner B's writes must not reorder owner A's results");
    for (const [i, row] of after.entries()) {
      assert.equal(row.score, before[i]!.score,
        `owner B's writes moved owner A's BM25 score at position ${i}: ` +
        `${before[i]!.score} -> ${row.score}. That is the cross-tenant statistics leak this ` +
        "delivery exists to prevent, and it is invisible to every row-level check.");
    }
  } finally {
    for (const c of [a, b]) {
      await client.query(`delete from zz.search_current where corpus_key=$1`, [c]).catch(() => undefined);
    }
    await client.close();
  }
}

async function caseRealPg17Bm25ScoreExpression(): Promise<void> {
  const { ensureCorpus } = await import("../../packages/indexing/dist/tenant-projections.js");
  const client = await liveClient();
  const corpus = `iso_score_${Date.now()}`;
  try {
    await ensureCorpus(client as never, corpus);
    await client.query(
      `insert into zz.search_current (corpus_key, owner_id, artifact_id, revision, content_hash,
         title, type, tags, path, raw_body, analyzer_version, projection_hash)
       values ($1,$2,$3,1,$4,'t','Decision','{}','m.md',$5,'zz-lexical-v1',$6),
              ($1,$2,$7,1,$4,'t','Decision','{}','u.md',$8,'zz-lexical-v1',$6)`,
      [corpus, LIVE_A, "88888888-0000-4000-8000-000000000001", "a".repeat(64),
       "the database performance plan", "b".repeat(64),
       "88888888-0000-4000-8000-000000000002", "an unrelated note about lunch"]);
    const rows = await observeLive(client, corpus, LIVE_A, "database performance");
    assert.equal(rows.length, 2);
    assert.ok(rows[0]!.score < 0,
      `the matching row must score negative, got ${rows[0]!.score} — "<@>" returns a negative BM25 score`);
    assert.ok(rows[0]!.score < rows[1]!.score,
      "ascending order must be descending relevance: the match must sort before the non-match");
    assert.equal(rows[0]!.id, "88888888-0000-4000-8000-000000000001");
  } finally {
    await client.query(`delete from zz.search_current where corpus_key=$1`, [corpus]).catch(() => undefined);
    await client.close();
  }
}

export const LIVE_CASES: Readonly<Record<string, () => Promise<void>>> = {
  real_pg17_statistical_isolation: caseRealPg17StatisticalIsolation,
  real_pg17_bm25_score_expression: caseRealPg17Bm25ScoreExpression,
};

