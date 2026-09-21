#!/usr/bin/env node
/**
 * Rederive `zz.doc`/`zz.knowledge_node` under the current analyzer generation — Task I-13's
 * worker. `packages/indexing`'s `rederiveAll`/`rederiveCorpus` do the actual walk; this script
 * only supplies the connection, the generation pair, and the caller-known route this pass'
 * own `CorpusRebuildRecord.route` field asks for (`tenant-projections.ts`'s own rule: "only
 * the caller knows that mapping").
 *
 * DRY RUN IS THE DEFAULT AND IT NEVER WRITES. Bare, this prints `planRebuild`'s own plan and
 * each corpus's current row count and does nothing else — no connection is even asked to run a
 * rederivation. `--write` is the only path that calls `rederiveAll`, matching this repository's
 * existing `backfill-eval-axes.ts`.
 *
 * NEVER POINT THIS AT PRODUCTION FROM AN UNATTENDED RUN. A real rederivation is an operational
 * act with its own authorization, exactly like `backfill-eval-axes.ts`'s own — this script
 * only reads `TEAM_DB_URL`/`DATABASE_URL` from the environment and never assumes which
 * database that is.
 *
 *   node scripts/rederive-analyzer-generation.ts            # plan only, writes nothing
 *   node scripts/rederive-analyzer-generation.ts --write     # actually rederive
 */
import {
  planRebuild, queryGeneration, rederiveAll, ANALYZER_NAME,
  type CorpusRebuildRecord,
} from "@zz/indexing";
import {
  connectIsolated,
} from "../packages/indexing/dist/tenant-projections.js";

const WRITE = process.argv.includes("--write");
const PREVIOUS_ANALYZER = process.env.REDERIVE_PREVIOUS_ANALYZER || "zz-lexical-v1";

const url = process.env.TEAM_DB_URL || process.env.DATABASE_URL;
if (!url) {
  console.error("no TEAM_DB_URL / DATABASE_URL in the environment");
  process.exit(1);
}

const plan = planRebuild({ analyzer: ANALYZER_NAME, previous: PREVIOUS_ANALYZER });
console.log(`generation ${PREVIOUS_ANALYZER} -> ${ANALYZER_NAME}`);
console.log(`plan: corpora=[${plan.corpora.join(", ")}] skipUnchangedContentHash=${plan.skipUnchangedContentHash} resumable=${plan.resumable}`);

const oneSided = queryGeneration({ indexGeneration: PREVIOUS_ANALYZER, queryGeneration: ANALYZER_NAME });
console.log(`a query issued for ${ANALYZER_NAME} against an index still at ${PREVIOUS_ANALYZER} reads: ${oneSided.status}`);

const client = await connectIsolated(url);
try {
  if (!WRITE) {
    for (const corpus of plan.corpora) {
      const n = (await client.query<{ n: string }>(`select count(*)::text as n from ${corpus}`)).rows[0]?.n ?? "0";
      console.log(`  ${corpus}: ${n} row(s) — would be walked; nothing written (pass --write to apply)`);
    }
    console.log("\nnothing written — pass --write to apply.");
  } else {
    const records: readonly CorpusRebuildRecord[] = await rederiveAll(client, {
      analyzer: ANALYZER_NAME, previous: PREVIOUS_ANALYZER,
      route: { worker: "scripts/rederive-analyzer-generation.ts", reader: "keyset-cursor" },
    });
    for (const r of records) {
      console.log(`  ${r.corpus}: census=${r.sourceCensus} rederived=${r.rederived} skipped=${r.skipped} `
        + `failures=${r.failures.length} complete=${r.complete} watermark=${r.watermark ?? "<none>"}`);
      for (const f of r.failures) console.log(`    FAILED ${f.key}: ${f.reason}`);
    }
    console.log("\nwritten.");
  }
} finally {
  await client.close();
}
