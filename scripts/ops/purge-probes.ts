/**
 * Remove what the live chain check left behind.
 *
 * `chain-check` opens a FRESH initiative on every run — `chain-check-<DDMM>-<uuid4>` — walks a
 * whole flow through it, and closes it. Closing is not deleting, and nothing ever deleted it,
 * so every run of `scripts/release.ts` against a live deployment left an initiative and every
 * document it wrote permanently in that deployment's store.
 *
 * Measured on 2026-09-16, three days after the first probe run: 58 probe initiatives holding
 * 463 indexed rows, against 17 real ones — and 240 of the platform's 350 runs. Four of the
 * probe initiatives were on `xuan`, a real person's team, which is how it was noticed.
 *
 * That is not untidiness, it is the DENOMINATOR. Every ratio anybody computes about this
 * platform — how long a run takes, which plugin a call belongs to, how many gates are waiting
 * on a person — is taken over these tables, and a store that is four fifths probe output
 * cannot answer any of those questions. Three separate measurements were wrong this way
 * before anyone looked.
 *
 * AN OPERATOR SCRIPT, DELIBERATELY NOT A TOOL ON ANY DOOR. Deletion is the one act that can
 * destroy the record a gate was recorded on, and no agent needs it: an agent that can delete
 * a gated document can erase the evidence it was judged against. So this runs where the files
 * and the database both are, by somebody who went there on purpose.
 *
 *   node scripts/ops/purge-probes.ts              # counts only, changes nothing
 *   node scripts/ops/purge-probes.ts --apply      # deletes
 *
 * THE PATTERN IS NOT AN ARGUMENT. It is `chain-check-`, fixed, because a purge that takes a
 * pattern from the command line is one typo away from deleting a team's work — and the only
 * thing this exists to remove is traffic the platform generated against itself.
 */
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import pg from "pg";

/** The one pattern this script will ever match. See the docblock: not an argument. */
const PROBE = "chain-check-";
const LIKE = `%${PROBE}%`;

const APPLY = process.argv.includes("--apply");
const ARTIFACTS = process.env.ZZ_ARTIFACTS ?? "/artifacts";

const db = new pg.Pool({ connectionString: process.env.TEAM_DB_URL });

/** Counted BEFORE and AFTER, and both are printed. A purge that reports only what it intended
 * to do is a purge nobody can check; the pair is what shows it did that and nothing else. */
async function census() {
  const one = async (label: string, sql: string) =>
    [label, Number((await db.query(sql)).rows[0].n)] as const;
  return Object.fromEntries(await Promise.all([
    one("doc", `select count(*) n from zz.doc where initiative like '${LIKE}'`),
    one("initiative", `select count(*) n from zz.initiative where slug like '${LIKE}'`),
    one("event", `select count(*) n from zz.event where initiative like '${LIKE}'`),
    one("run", `select count(*) n from zz.run r join zz.initiative i on i.id = r.initiative_id
                where i.slug like '${LIKE}'`),
    one("node", `select count(*) n from zz.doc where path like 'nodes/%' and path ilike '${LIKE}'`),
    one("REAL initiative", `select count(*) n from zz.initiative where slug not like '${LIKE}'`),
    // INITIATIVE documents only. This counted every zz.doc row whose initiative is not a
    // probe's — which includes the knowledge nodes, because a node's `initiative` is the one
    // it was minted from. So deleting 58 probe NODES dropped this by 58 and the survivor
    // assertion fired on a purge that had done exactly the right thing. One subject per count.
    one("REAL doc", `select count(*) n from zz.doc
                     where initiative not like '${LIKE}' and path not like 'nodes/%'`),
    one("REAL node", `select count(*) n from zz.doc where path like 'nodes/%' and path not ilike '${LIKE}'`),
  ]));
}

/** Probe initiative directories on disk, which are the SOURCE OF TRUTH — `zz.doc` is an index
 * projected from each file's frontmatter, so a row deleted without its file comes back on the
 * next reindex. Both halves or neither. */
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

/** The probe's KNOWLEDGE NODES, which do not live under an initiative and so survived the
 * first version of this script entirely. chain-check calls `knowledge_add`, and a node lands
 * in `<team>/_knowledge/nodes/` keyed by nothing the initiative purge can see: 58 of them were
 * left behind, 5 on a real person's team.
 *
 * MATCHED ON THE PATH, NEVER THE TITLE. One real node on this deployment is called "A check
 * not wired into the gate is not enforced — unless it cannot be", which mentions the chain
 * check in its title and is somebody's actual finding. Matching titles would have deleted it.
 * The 58 real probes are two generated stems, `chain-check-subject-probe.md` and
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

// ORDER MATTERS, and it is the foreign keys that set it. `zz.doc.initiative_id` references
// `zz.initiative` with NO ACTION, so the documents go first or the initiative delete is
// refused. `zz.run.initiative_id` is ON DELETE CASCADE, so the 240 probe runs go with their
// initiatives whether or not this script mentions them — that is the schema's decision, not
// this script's, and it is named here so nobody is surprised by the count.
//
// The events go too. They have no foreign key, so leaving them would orphan 1,882 rows
// pointing at initiatives that no longer exist — rows that would go on poisoning exactly the
// measurements this purge exists to clean, while referring to nothing a reader could open.
await db.query("begin");
try {
  const d = await db.query(`delete from zz.doc where initiative like '${LIKE}'`);
  const e = await db.query(`delete from zz.event where initiative like '${LIKE}'`);
  const i = await db.query(`delete from zz.initiative where slug like '${LIKE}'`);
  const k = await db.query(`delete from zz.doc where path like 'nodes/%' and path ilike '${LIKE}'`);
  console.log(`  knowledge nodes: ${k.rowCount}`);
  await db.query("commit");
  console.log(`deleted: ${d.rowCount} doc, ${e.rowCount} event, ${i.rowCount} initiative (+ runs, by cascade)`);
} catch (err) {
  await db.query("rollback");
  throw err;
}

for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
for (const f of nodes) rmSync(f, { force: true });
console.log(`removed ${dirs.length} directories and ${nodes.length} knowledge nodes`);

const after = await census();
console.log("after:", after);

// THE ASSERTION IS ABOUT THE SURVIVORS, not about the victims. "I deleted 463 rows" is
// satisfied by deleting the wrong 463; "every real initiative is still here" is not.
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
