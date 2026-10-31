/**
 * Remove what the live chain check left behind.
 *
 * `chain-check` opens a fresh initiative on every run — `chain-check-<DDMM>-<uuid4>` — walks a whole
 * flow through it, and closes it. Closing is not deleting, so every run of `scripts/release.ts`
 * against a live deployment leaves an initiative and every document it wrote permanently in that
 * deployment's store.
 *
 * That is the denominator, not untidiness: every ratio anybody computes about this platform — how
 * long a run takes, which plugin a call belongs to, how many gates are waiting on a person — is
 * taken over these tables, and a store that is mostly probe output cannot answer any of them.
 *
 * An operator script, deliberately not a tool on any door. Deletion can destroy the record a gate
 * was recorded on, and an agent that can delete a gated document can erase the evidence it was
 * judged against. So this runs where the database is, by somebody who went there on purpose.
 *
 *   node scripts/ops/purge-probes.ts              # counts only, changes nothing
 *   node scripts/ops/purge-probes.ts --apply      # deletes
 *
 * What it deletes is not an argument, and not a pattern a person's work can share: an initiative whose
 * slug has exactly the shape chain-check mints, `<date>-chain-check-<DDMM>-<four hex>`, and a lesson
 * whose every citation is one of those. A person's `fix-chain-check-wiring`, or a lesson titled
 * "Chain-check leaves litter", is theirs whatever its name says.
 *
 * It used to have a second half that removed the probe's FILES off the team-store volume as well,
 * because the files were the source of truth and `zz.doc` was an index projected from them. The
 * rows are the record now and that volume is retired, so the half could only walk a directory that
 * no longer exists and report zero — dead weight in a script whose whole value is that an operator
 * can read it and know what it deletes.
 */
import pg from "pg";

/** The probe initiatives, by the exact name chain-check mints (packages/tools/src/testing/chain-check.ts
 *  `freshSlug`, under the date the platform prepends): the one relation every count and delete below is
 *  measured against. */
const PROBES = `select i.id from zz.initiative i
                 where i.slug ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}-chain-check-[0-9]{4}-[0-9a-f]{4}$'`;
/** The probe lessons: nodes whose every citation is a probe initiative (chain-shelf.ts files them with
 *  the probe as their only evidence). A node that cites anything else is somebody's lesson. */
const PROBE_NODES = `select e.node_id from zz.knowledge_node_evidence e
                      group by e.node_id
                     having bool_and(e.initiative_id in (${PROBES}))`;

const APPLY = process.argv.includes("--apply");

const db = new pg.Pool({ connectionString: process.env.TEAM_DB_URL });

/** Counted before and after, and both are printed: a purge that reports only what it intended to do
 *  is a purge nobody can check. */
async function census() {
  const one = async (label: string, sql: string) =>
    [label, Number((await db.query(sql)).rows[0].n)] as const;
  return Object.fromEntries(await Promise.all([
    // `zz.doc` no longer carries the initiative's own name: those columns went with the file
    // store, and a document's initiative is the row it is filed under. Counting on the retired
    // column is what killed this script mid-purge and left probe litter that then failed every
    // later release's verification — the litter this very sweep exists to remove.
    one("doc", `select count(*) n from zz.doc where initiative_id in (${PROBES})`),
    one("initiative", `select count(*) n from zz.initiative where id in (${PROBES})`),
    one("event", `select count(*) n from zz.event where initiative_id in (${PROBES})`),
    one("run", `select count(*) n from zz.skill_run r where r.initiative_id in (${PROBES})`),
    // From zz.knowledge_node, which is where a node lives. A node is its own table rather than a
    // document, so a probe node is counted here and never among the documents above.
    one("node", `select count(*) n from zz.knowledge_node where id in (${PROBE_NODES})`),
    one("assessment", `select count(*) n from zz.assessment where initiative_id in (${PROBES})`),
    one("REAL initiative", `select count(*) n from zz.initiative where id not in (${PROBES})`),
    // Initiative documents only — nodes are their own table. Counting both makes deleting probe
    // nodes look like real documents going missing, and fires the survivor assertion on a purge that
    // did the right thing.
    one("REAL doc", `select count(*) n from zz.doc d
                      where d.initiative_id not in (${PROBES}) and d.path not like 'nodes/%'`),
    one("REAL node", `select count(*) n from zz.knowledge_node where id not in (${PROBE_NODES})`),
  ]));
}

const before = await census();
console.log("before:", before);

if (!APPLY) {
  console.log("\nDRY RUN — nothing was deleted. Re-run with --apply.");
  await db.end();
  process.exit(0);
}

// Order matters, and the delete actions set it: every row naming a probe initiative goes before
// the initiative itself. `zz.doc.initiative_id`, `zz.event.initiative_id` and
// `zz.assessment.initiative_id` are all ON DELETE SET NULL, so deleting the initiative first
// would not be refused — it would take the reference away, leave the rows behind, and put them
// out of reach of this script and of any second run of it.
//
// `zz.skill_run.initiative_id` is the one that is ON DELETE CASCADE, so probe runs go with their
// initiatives whether or not this script mentions them — the schema's decision, named here so
// nobody is surprised by the count.
//
// The events go too, and they are not merely untidy: each one now carries `initiative_id`, so
// leaving them would be rows referring to an initiative that no longer exists — poisoning the
// measurements this purge exists to clean, while pointing at nothing a reader could open.
//
// DELIBERATE: nothing deletes `zz.doc_link` first any more. It used to, because `doc_link`'s key
// to `zz.doc` did not cascade while `doc_revision`'s did, and a plain delete of a document died
// on `doc_link_to_doc_id_fkey` with the probe rows half-removed; `009_doc_link_cascade.sql`
// (folded into 001_init.sql) gave it the cascade its sibling always had, so the schema does it.
// One client, so the transaction is one connection: a pool's own query may take a different one per
// statement, and `begin` on one leaves every delete after it outside the transaction.
const tx = await db.connect();
try {
  await tx.query("begin");
  const d = await tx.query(`delete from zz.doc where initiative_id in (${PROBES})`);
  const e = await tx.query(`delete from zz.event where initiative_id in (${PROBES})`);
  // The chain check asks `assess` and records two audit rounds, and every answer is a row here.
  const a = await tx.query(`delete from zz.assessment where initiative_id in (${PROBES})`);
  // Before the initiatives: a probe lesson is known by the probe initiatives it cites.
  const k = await tx.query(`delete from zz.knowledge_node where id in (${PROBE_NODES})`);
  const i = await tx.query(`delete from zz.initiative where id in (${PROBES})`);
  console.log(`  knowledge nodes: ${k.rowCount}`);
  console.log(`  assessments: ${a.rowCount}`);
  await tx.query("commit");
  console.log(`deleted: ${d.rowCount} doc, ${e.rowCount} event, ${i.rowCount} initiative (+ runs, by cascade)`);
} catch (err) {
  await tx.query("rollback");
  throw err;
} finally {
  tx.release();
}

const after = await census();
console.log("after:", after);

// The assertion is about the survivors, not about the victims. "I deleted 463 rows" is satisfied by
// deleting the wrong 463; "every real initiative is still here" is not.
const bad: string[] = [];
for (const k of ["doc", "initiative", "event", "run", "node", "assessment"]) {
  if (after[k] !== 0) bad.push(`${after[k]} ${k} rows of chain-check's are still there`);
}
for (const k of ["REAL initiative", "REAL doc", "REAL node"]) {
  if (after[k] !== before[k]) bad.push(`${k}: ${before[k]} before, ${after[k]} after — this purge took real work with it`);
}
await db.end();
if (bad.length) { console.error("\nFAILED:\n" + bad.join("\n")); process.exit(1); }
console.log("\nok — every probe row gone, every real row untouched");
