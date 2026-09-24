// A migration that needs an extension says so, and the runner defers it rather than failing.
//
// What this prevents is not a crash. `services/gateway/src/db.ts` applies every unapplied
// migration on every boot. When one throws it rolls back, un-sets the pool and rethrows — and the
// caller logs "platform db init failed (continuing without it)" and starts the server anyway, a
// deliberate choice so a database problem does not take the platform down. The consequence for a
// migration that cannot run on the deployed cluster is the whole platform serving with no database
// while reporting itself up.
//
// COUPLED, and both halves are required: a migration naming `create extension` must carry a
// `-- requires-extension: <name>` directive, and the runner must still read it. Either alone is a
// guard that has stopped guarding — the directive with no reader is a comment, and the reader with
// no directive is a mechanism nothing uses, which is how a mechanism gets deleted as dead.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { requiredExtensions } from "../services/gateway/dist/db.js";

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

// Every directive, not the first. Driven against the runner's own exported function rather than
// asserted about its source text, because this is a behaviour rather than a presence. A reader
// written as `.exec(...)?.[1]` checks one requirement and attempts the file anyway when a second
// is missing — the exact outage the deferral exists for, re-entered through the guard itself.
const twoDirectives = "-- requires-extension: alpha\ncreate extension alpha;\n"
  + "-- requires-extension: beta\ncreate extension beta;\n";
const read = requiredExtensions(twoDirectives);
if (read.length !== 2 || read[0] !== "alpha" || read[1] !== "beta") {
  fail.push(`services/gateway/src/db.ts reads ${JSON.stringify(read)} from a migration declaring ` +
            "two extensions — it must read every requires-extension directive, not the first. A " +
            "migration whose second requirement goes unchecked is attempted on a cluster that " +
            "cannot run it, and the gateway then serves with no database at all");
}
if (requiredExtensions("-- nothing here\ncreate table t ();\n").length !== 0) {
  fail.push("services/gateway/src/db.ts finds a requirement in a migration that declares none");
}

for (const file of readdirSync(DIR).filter((f) => f.endsWith(".sql"))) {
  const sql = readFileSync(join(DIR, file), "utf8");
  // Comment lines are stripped first: this file's own prose names `create extension` while
  // explaining the rule, and a checker that reads its own homework back finds a violation
  // everywhere the rule is discussed.
  const code = sql.split("\n").filter((l) => !/^\s*--/.test(l)).join("\n");
  for (const m of code.matchAll(/create\s+extension\s+(?:if\s+not\s+exists\s+)?([a-z0-9_]+)/gi)) {
    const ext = m[1].toLowerCase();
    // Both ship with the PostgreSQL image this platform runs, so a declaration for them would be
    // ceremony rather than a guard.
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
