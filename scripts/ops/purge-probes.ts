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
 * judged against. So this runs where the files and the database both are, by somebody who went
 * there on purpose.
 *
 *   node scripts/ops/purge-probes.ts              # counts only, changes nothing
 *   node scripts/ops/purge-probes.ts --apply      # deletes
 *
 * The pattern is not an argument. It is `chain-check-`, fixed: a purge that takes a pattern from the
 * command line is one typo away from deleting a team's work.
 */
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import pg from "pg";

/** The one pattern this script will ever match. See the docblock: not an argument. */
const PROBE = "chain-check-";
const LIKE = `%${PROBE}%`;

const APPLY = process.argv.includes("--apply");
const ARTIFACTS = process.env.ZZ_ARTIFACTS ?? "/artifacts";

const db = new pg.Pool({ connectionString: process.env.TEAM_DB_URL });

/** Counted before and after, and both are printed: a purge that reports only what it intended to do
 * is a purge nobody can check. */
async function census() {
  const one = async (label: string, sql: string) =>
    [label, Number((await db.query(sql)).rows[0].n)] as const;
  return Object.fromEntries(await Promise.all([
    one("doc", `select count(*) n from zz.doc where initiative like '${LIKE}'`),
    one("initiative", `select count(*) n from zz.initiative where slug like '${LIKE}'`),
    one("event", `select count(*) n from zz.event where initiative like '${LIKE}'`),
    one("run", `select count(*) n from zz.run r join zz.initiative i on i.id = r.initiative_id
                where i.slug like '${LIKE}'`),
    // From zz.knowledge_node, which is where a node lives. Counting zz.doc
    // reads 0 whatever the store holds, so the DELETE below deletes nothing and a purge that removed
    // the files leaves their index rows behind.
    one("node", `select count(*) n from zz.knowledge_node where path ilike '${LIKE}'`),
    one("REAL initiative", `select count(*) n from zz.initiative where slug not like '${LIKE}'`),
    // Initiative documents only — nodes are their own table. Counting both makes deleting probe
    // nodes look like real documents going missing, and fires the survivor assertion on a purge that
    // did the right thing.
    one("REAL doc", `select count(*) n from zz.doc
                     where initiative not like '${LIKE}' and path not like 'nodes/%'`),
    one("REAL node", `select count(*) n from zz.knowledge_node where path not ilike '${LIKE}'`),
  ]));
}

/** Probe initiative directories on disk, which are the source of truth — `zz.doc` is an index
 * projected from each file's frontmatter, so a row deleted without its file comes back on the next
 * reindex. Both halves or neither. */
function probeDirs(): string[] {
  const teams = join(ARTIFACTS, "teams");
  if (!existsSync(teams)) return [];
  return readdirSync(teams).flatMap((team) => {
    const dir = join(teams, team);
    return readdirSync(dir)
      .filter((name) => name.includes(PROBE))
      .map((name) => join(dir, name));
  });
}

/** The probe's knowledge nodes, which do not live under an initiative and so are invisible to the
 * initiative purge: chain-check calls `knowledge_add`, and a node lands in `<team>/_knowledge/nodes/`
 * keyed by nothing that purge can see.
 *
 * Matched on the path, never the title. A real node called "A check not wired into the gate is not
 * enforced — unless it cannot be" mentions the chain check in its title and is somebody's actual
 * finding. The probes are two generated stems, `chain-check-subject-probe.md` and
 * `chain-check-subject-probe-superseding.md`. */
function probeNodes(): string[] {
  const teams = join(ARTIFACTS, "teams");
  if (!existsSync(teams)) return [];
  return readdirSync(teams).flatMap((team) => {
    const dir = join(teams, team, "_knowledge", "nodes");
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((name) => name.includes(PROBE))
      .map((name) => join(dir, name));
  });
}

/** Drop each deleted node's row from its shelf's `index.md`, keyed on the id in its file name.
 *
 *  Returns how many rows went, so a purge that found files and changed no index says so. */
function dropIndexRows(files: string[]): number {
  const byShelf = new Map<string, Set<string>>();
  for (const f of files) {
    const shelf = join(f, "..", "..", "index.md");
    const id = /(^|\/)(\d+)-/.exec(f)?.[2];
    if (!id) continue;
    const got = byShelf.get(shelf);
    if (got) got.add(id); else byShelf.set(shelf, new Set([id]));
  }
  let dropped = 0;
  for (const [shelf, ids] of byShelf) {
    if (!existsSync(shelf)) continue;
    const kept = readFileSync(shelf, "utf8").split("\n").filter((line) => {
      const id = /^\|\s*(\d+)\s*\|/.exec(line)?.[1];
      if (id && ids.has(id)) { dropped += 1; return false; }
      return true;
    });
    writeFileSync(shelf, kept.join("\n"));
  }
  return dropped;
}

const before = await census();
const dirs = probeDirs();
const nodes = probeNodes();
console.log("before:", before);
console.log(`probe initiative directories on disk: ${dirs.length}`);
console.log(`probe knowledge nodes on disk:        ${nodes.length}`);

if (!APPLY) {
  console.log("\nDRY RUN — nothing was deleted. Re-run with --apply.");
  await db.end();
  process.exit(0);
}

// Order matters, and the foreign keys set it. `zz.doc.initiative_id` references `zz.initiative` with
// NO ACTION, so the documents go first or the initiative delete is refused. `zz.run.initiative_id` is
// ON DELETE CASCADE, so probe runs go with their initiatives whether or not this script mentions
// them — the schema's decision, named here so nobody is surprised by the count.
//
// The events go too. They have no foreign key, so leaving them orphans rows pointing at initiatives
// that no longer exist — rows that would go on poisoning the measurements this purge exists to
// clean, while referring to nothing a reader could open.
await db.query("begin");
try {
  const d = await db.query(`delete from zz.doc where initiative like '${LIKE}'`);
  const e = await db.query(`delete from zz.event where initiative like '${LIKE}'`);
  const i = await db.query(`delete from zz.initiative where slug like '${LIKE}'`);
  const k = await db.query(`delete from zz.knowledge_node where path ilike '${LIKE}'`);
  console.log(`  knowledge nodes: ${k.rowCount}`);
  await db.query("commit");
  console.log(`deleted: ${d.rowCount} doc, ${e.rowCount} event, ${i.rowCount} initiative (+ runs, by cascade)`);
} catch (err) {
  await db.query("rollback");
  throw err;
}

for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
for (const f of nodes) rmSync(f, { force: true });
// And the index a person reads. `_knowledge/index.md` is appended to on every mint and rebuilt by
// nothing, so deleting a node's file and its row leaves the node listed in the one place
// `zz-platform` tells every agent to look first.
//
// By id, never by title — the same rule probeNodes() keeps. A node's id is the leading number of its
// file name, so the rows to drop are derived from the files just deleted rather than matched on
// words a real finding might also carry.
const droppedRows = dropIndexRows(nodes);
console.log(`removed ${dirs.length} directories, ${nodes.length} knowledge nodes and ${droppedRows} index row(s)`);

const after = await census();
console.log("after:", after);

// The assertion is about the survivors, not about the victims. "I deleted 463 rows" is satisfied by
// deleting the wrong 463; "every real initiative is still here" is not.
const bad: string[] = [];
for (const k of ["doc", "initiative", "event", "run", "node"]) {
  if (after[k] !== 0) bad.push(`${after[k]} ${k} rows still match ${PROBE}`);
}
for (const k of ["REAL initiative", "REAL doc", "REAL node"]) {
  if (after[k] !== before[k]) bad.push(`${k}: ${before[k]} before, ${after[k]} after — this purge took real work with it`);
}
await db.end();
if (bad.length) { console.error("\nFAILED:\n" + bad.join("\n")); process.exit(1); }
console.log("\nok — every probe row gone, every real row untouched");
