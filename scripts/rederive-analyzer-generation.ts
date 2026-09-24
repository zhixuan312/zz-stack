#!/usr/bin/env node
/**
 * Rederive `zz.doc`/`zz.knowledge_node` under the current analyzer generation.
 * `packages/indexing`'s `rederiveAll`/`rederiveCorpus` do the walk; this script supplies the
 * connection, the generation pair, and the caller-known route `CorpusRebuildRecord.route` asks
 * for.
 *
 * Dry run is the default and never writes: bare, this prints `planRebuild`'s plan and each
 * corpus's current row count. `--write` is the only path that calls `rederiveAll`.
 *
 * A real rederivation is an operational act with its own authorization. This script reads
 * `TEAM_DB_URL`/`DATABASE_URL` from the environment and never assumes which database that is.
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
