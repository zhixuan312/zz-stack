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
