// A migration that needs an extension says so, and the runner defers it rather than failing.
//
// WHAT THIS PREVENTS IS NOT A CRASH. `services/gateway/src/db.ts` applies every unapplied
// migration on every boot. When one throws it rolls back, un-sets the pool and rethrows — and
// the caller logs "platform db init failed (continuing without it)" and starts the server
// anyway, which is a deliberate choice made so a database problem does not take the platform
// down. The consequence for a migration that cannot run on the deployed cluster is therefore
// the whole platform serving with no database while reporting itself up.
//
// Measured on this deployment while writing the tenant-information migration: PostgreSQL 16.15
// with exactly `citext` and `plpgsql` installed, and a migration needing `pg_textsearch` whose
// PostgreSQL 17 image arrives in a later, separately rehearsed cutover.
//
// TWO HALVES, BOTH REQUIRED. A migration naming `create extension` must carry a
// `-- requires-extension: <name>` directive, and the runner must still read it. Either alone is
// a guard that has stopped guarding: the directive with no reader is a comment, and the reader
// with no directive is a mechanism nothing uses, which is how a mechanism gets deleted as dead.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const DIR = "services/gateway/migrations";
const fail: string[] = [];

const runner = readFileSync("services/gateway/src/db.ts", "utf8");
if (!/requires-extension/.test(runner)) {
  fail.push("services/gateway/src/db.ts no longer reads the requires-extension directive — a " +
            "migration needing an absent extension would take the platform's database down");
}
if (!/pg_available_extensions/.test(runner)) {
  fail.push("services/gateway/src/db.ts no longer asks which extensions this cluster offers");
}

for (const file of readdirSync(DIR).filter((f) => f.endsWith(".sql"))) {
  const sql = readFileSync(join(DIR, file), "utf8");
  // Comment lines are stripped first: this file's own prose names `create extension` while
  // explaining the rule, and a checker that reads its own homework back finds a violation
  // everywhere the rule is discussed.
  const code = sql.split("\n").filter((l) => !/^\s*--/.test(l)).join("\n");
  for (const m of code.matchAll(/create\s+extension\s+(?:if\s+not\s+exists\s+)?([a-z0-9_]+)/gi)) {
    const ext = m[1].toLowerCase();
    // Two ship with PostgreSQL itself on every image this platform has ever run, so requiring a
    // declaration for them would be ceremony rather than a guard.
    if (ext === "plpgsql" || ext === "citext") continue;
    const declared = new RegExp(`^--\\s*requires-extension:\\s*${ext}\\s*$`, "im").test(sql);
    if (!declared) {
      fail.push(`${DIR}/${file} creates extension "${ext}" and declares no ` +
                `"-- requires-extension: ${ext}" line — on a cluster without it this migration ` +
                `throws, and the gateway then serves with no database at all`);
    }
  }
}

if (fail.length) { console.error(fail.join("\n")); process.exit(1); }
console.log("migration-extension-declared: ok");
