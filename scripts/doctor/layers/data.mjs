/**
 * LAYER 6 — is the data behind the platform the shape this checkout expects?
 *
 * Last, because it is the layer whose disagreements are least likely to be the CAUSE of
 * anything else and most likely to be the consequence. A migration that never applied does not
 * take a door down; it takes one query down, weeks later, for one caller.
 *
 * Both probes read through the host's own configuration. `-U zz -d zz` was written here as a
 * literal while .env.example documents POSTGRES_USER and POSTGRES_DB as settable — on a
 * deployment that sets either, the probe fails, and this probe is what a release rolls back
 * on: a good version undone by a name the script guessed.
 */
import { REMOTE, root, run, ssh } from "../../deployment.mjs";
import { layer, probe } from "../run.mjs";

layer("data", "is the data the shape this checkout expects", ["services/gateway/migrations", "catalog"]);

/** psql on the host, through compose, with the role and database read rather than typed. */
const psql = (sql) => ssh(
  `cd ${REMOTE}/deploy && ` +
  `U=$(grep -oP '(?<=^POSTGRES_USER=).*' .env || echo zz) && ` +
  `D=$(grep -oP '(?<=^POSTGRES_DB=).*' .env || echo zz) && ` +
  `docker compose exec -T postgres psql -U "$U" -d "$D" -tAc ${JSON.stringify(sql)} 2>/dev/null || true`);

probe("every migration is applied, and every applied migration still exists", () => {
  const files = run("bash", ["-c", `ls ${root}/services/gateway/migrations/*.sql | xargs -n1 basename`])
    .split("\n").filter(Boolean);
  const applied = psql("select name from zz.schema_migration").split("\n").map((x) => x.trim()).filter(Boolean);
  if (!applied.length) throw new Error("could not read zz.schema_migration on the host");
  // BY NAME, BOTH DIRECTIONS — which the sentence above always claimed and a count comparison
  // never did. `applied >= files` passed a deleted migration (its row still counted), passed a
  // renamed one (old row plus new file, totals unchanged), and could only ever notice a file
  // nobody had run yet.
  const inDb = new Set(applied), onDisk = new Set(files);
  const unapplied = files.filter((f) => !inDb.has(f));
  const orphaned = applied.filter((a) => !onDisk.has(a));
  if (unapplied.length) return `on disk but never applied: ${unapplied.join(", ")}`;
  if (orphaned.length) return `applied but no longer in this checkout: ${orphaned.join(", ")}`;
  return null;
});

// The registry is written from the catalog by the release's own deploy step, so a catalog that
// grew a skill without a release leaves the two disagreeing — and the symptom is a skill an
// agent cannot load, which looks like the agent's fault.
probe("the skill registry is not behind the catalog", () => {
  const onDisk = Number(run("bash", ["-c",
    `find ${root}/catalog -name SKILL.md | wc -l`]).trim());
  if (!onDisk) return "this checkout's catalog holds no SKILL.md at all — the doctor is reading nothing";
  const rows = Number((psql("select count(*) from zz.skill").trim() || "0"));
  if (!rows) throw new Error("could not count zz.skill on the host");
  return rows >= onDisk ? null
    : `the catalog ships ${onDisk} skills and the registry holds ${rows} row(s) — the deploy step's ` +
      `registry update has not run for what is on disk`;
});

// EVERY RUN NAMES A VERSION, or the evaluation track is reading noise.
//
// zz.run is DERIVED from zz.event by reconcileRuns() on a timer, and it keyed the version on
// zz.event.step_version — a column stamped only when a skill is served whole through
// skill_read, which an installed skill read off disk never is. So every row the
// initiative-bearing insert wrote carried skill_version_id NULL; a NULL cannot match that
// insert's conflict target, because Postgres treats NULLs as distinct; `do update` therefore
// never fired and each pass of the timer appended another copy. The table reached 1791 rows of
// which 1787 were duplicates of two, growing by roughly 950 a day, every one of them with
// events attached by a linkback that matched NULLs deliberately.
//
// Nothing offline could see it. The gate is static and cannot reach a database; tsc cannot see
// inside a template literal; and a table full of rows that look like runs reads, in every
// query, as a healthy table. This is the probe that would have said so on day one, and it is
// here rather than in the gate for exactly that reason.
//
// READ-ONLY, like everything in this file. A null row is reported, never deleted: the cleanup
// is an operator's decision made once, and a doctor that fixed what it found would be a doctor
// nobody could safely run while something was broken.
probe("every run names the skill version it ran", () => {
  const total = Number((psql("select count(*) from zz.run").trim() || "0"));
  const orphan = psql("select count(*) from zz.run where skill_version_id is null").trim();
  if (orphan === "") throw new Error("could not count zz.run on the host");
  const n = Number(orphan);
  if (!n) return null;
  const pct = total ? Math.round((n / total) * 1000) / 10 : 0;
  return `${n} of ${total} zz.run rows (${pct}%) name no skill version. reconcileRuns() cannot ` +
         `dedupe them — a NULL never matches its conflict target — so the timer appends another ` +
         `copy every pass. Delete them once (they are derived, and re-derive from zz.event), ` +
         `and check that the version is resolved by released_at rather than by step_version`;
});
