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
 * The pattern is not an argument. It is `chain-check-`, fixed: a purge that takes a pattern from the
 * command line is one typo away from deleting a team's work.
 *
 * It used to have a second half that removed the probe's FILES from the artifact volume as well,
 * because the files were the source of truth and `zz.doc` was an index projected from them. The
 * rows are the record now and the volume is retired, so that half could only walk a directory that
 * no longer exists and report zero — dead weight in a script whose whole value is that an operator
 * can read it and know what it deletes.
 */
import pg from "pg";

/** The one pattern this script will ever match. See the docblock: not an argument. */
const PROBE = "chain-check-";
const LIKE = `%${PROBE}%`;

/** The probe initiatives themselves, named by id: the one relation every other count and delete
 *  below is measured against.
 *
 *  `zz.initiative.slug` is the only text column left that carries this pattern. `002_delivery_
 *  telemetry.sql` dropped `zz.event.initiative` and `zz.assessment.initiative` and gave both
 *  tables an `initiative_id` reference instead, so a purge still matching them on the slug would
 *  match nothing and report a clean store. */
const PROBES = `select i.id from zz.initiative i where i.slug like '${LIKE}'`;

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
    one("doc", `select count(*) n from zz.doc d
                  join zz.initiative i on i.id = d.initiative_id
                 where i.slug like '${LIKE}'`),
    one("initiative", `select count(*) n from zz.initiative where slug like '${LIKE}'`),
    one("event", `select count(*) n from zz.event where initiative_id in (${PROBES})`),
    one("run", `select count(*) n from zz.skill_run r where r.initiative_id in (${PROBES})`),
    // From zz.knowledge_node, which is where a node lives. A node is its own table rather than a
    // document, so a probe node is counted here and never among the documents above.
    one("node", `select count(*) n from zz.knowledge_node where slug ilike '${LIKE}'`),
    one("assessment", `select count(*) n from zz.assessment where initiative_id in (${PROBES})`),
    one("REAL initiative", `select count(*) n from zz.initiative where slug not like '${LIKE}'`),
    // Initiative documents only — nodes are their own table. Counting both makes deleting probe
    // nodes look like real documents going missing, and fires the survivor assertion on a purge that
    // did the right thing.
    one("REAL doc", `select count(*) n from zz.doc d
                       join zz.initiative i on i.id = d.initiative_id
                      where i.slug not like '${LIKE}' and d.path not like 'nodes/%'`),
    one("REAL node", `select count(*) n from zz.knowledge_node where slug not ilike '${LIKE}'`),
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
await db.query("begin");
try {
  const d = await db.query(
    `delete from zz.doc d using zz.initiative i
      where i.id = d.initiative_id and i.slug like '${LIKE}'`);
  const e = await db.query(`delete from zz.event where initiative_id in (${PROBES})`);
  // The chain check asks `assess` and records two audit rounds, and every answer is a row here.
  const a = await db.query(`delete from zz.assessment where initiative_id in (${PROBES})`);
  const k = await db.query(`delete from zz.knowledge_node where slug ilike '${LIKE}'`);
  const i = await db.query(`delete from zz.initiative where slug like '${LIKE}'`);
  console.log(`  knowledge nodes: ${k.rowCount}`);
  console.log(`  assessments: ${a.rowCount}`);
  await db.query("commit");
  console.log(`deleted: ${d.rowCount} doc, ${e.rowCount} event, ${i.rowCount} initiative (+ runs, by cascade)`);
} catch (err) {
  await db.query("rollback");
  throw err;
}

const after = await census();
console.log("after:", after);

// The assertion is about the survivors, not about the victims. "I deleted 463 rows" is satisfied by
// deleting the wrong 463; "every real initiative is still here" is not.
const bad: string[] = [];
for (const k of ["doc", "initiative", "event", "run", "node", "assessment"]) {
  if (after[k] !== 0) bad.push(`${after[k]} ${k} rows still match ${PROBE}`);
}
for (const k of ["REAL initiative", "REAL doc", "REAL node"]) {
  if (after[k] !== before[k]) bad.push(`${k}: ${before[k]} before, ${after[k]} after — this purge took real work with it`);
}
await db.end();
if (bad.length) { console.error("\nFAILED:\n" + bad.join("\n")); process.exit(1); }
console.log("\nok — every probe row gone, every real row untouched");
