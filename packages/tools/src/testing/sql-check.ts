/**
 * sql-check — every query in this repository, asked of a real Postgres: would you run this?
 *
 *   zz-tool testing/sql-check [--psql '<command>'] [--src <dir>]
 *
 * The queries live in template literals, so nothing else in this repository checks them: the
 * gate is offline and does not run SQL, the type system sees a string, and the release's
 * service-start step only proves the service is alive — a statement Postgres refuses to parse fails only when called.
 *
 * PREPARE is the whole idea. Postgres parses a prepared statement, resolves every table and
 * column, and applies the rules a plain parse cannot — DISTINCT against ORDER BY, GROUP BY
 * against the select list, types across an operator — without executing anything or touching a
 * row. So this needs a schema and not data: an empty database the gateway has migrated is a
 * complete oracle, which also makes it the check that catches a query still naming a column a
 * migration dropped.
 *
 * What it cannot check, it names. A few queries build part of their text at runtime, and a
 * statement with a hole in it is not a statement, so substituting something plausible would
 * check a query this repository does not contain. Those are reported every run, with the
 * reason.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { die, parseArgs } from "../lib/cli.js";
import { type QuerySite, queriesIn as queriesInSource } from "../lib/sql-scan.js";
import { DEFAULT_PSQL, psqlTry } from "../lib/psql.js";

/** Where the queries are. Sources, not dist: a template literal survives compilation, but
 * the line number that makes a failure actionable does not. */
const SRC = ["services", "packages"];

/** This file, which contains the pattern that finds `.query(` and would otherwise find it
 * here. A check that reads its own text as evidence reports a defect nobody can fix. */
const SELF = "packages/tools/src/testing/sql-check.ts";

/**
 * What PREPARE accepts: SELECT, INSERT, UPDATE, DELETE, MERGE, VALUES, and a WITH leading
 * any of them. Nothing else, and that is a rule about PREPARE rather than about the
 * statement — `create table` and `begin` are perfectly good SQL that a prepared statement
 * cannot hold.
 *
 * Named rather than silently dropped: what this excludes is the migration runner's own DDL and
 * transaction control, which are correct code. */
const PREPARABLE = /^\s*(with|select|insert|update|delete|merge|values)\b/i;

interface Found {
  file: string;
  line: number;
  sql: string;
  /** Set when the text is not a whole statement, and therefore not checkable. */
  why?: string;
}

function sources(root: string, dirs: string[]): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: string[];
    try { entries = readdirSync(dir).sort(); } catch { return; }
    for (const e of entries) {
      if (e === "node_modules" || e === "dist") continue;
      const p = join(dir, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (e.endsWith(".ts")) out.push(p);
    }
  };
  for (const d of dirs) walk(join(root, d));
  return out;
}

/**
 * Every `.query(...)` in a file, with the statement it was handed.
 *
 * COUPLED: the scan is `@zz/tools/lib/sql-scan`, which the gate's console check also uses to hold
 * console.ts to literals; the two have to agree exactly on where a statement starts and ends.
 *
 * What stays here is what only this tool decides: whether PREPARE will accept a statement.
 */
function queriesIn(file: string, root: string): Found[] {
  const rel = file.slice(root.length + 1);
  return queriesInSource(readFileSync(file, "utf8")).map(({ line, sql, why }: QuerySite) => {
    if (why) return { file: rel, line, sql, why };
    if (/\$\{/.test(sql)) {
      return { file: rel, line, sql, why: "built at runtime, so there is no one statement to check" };
    }
    if (!PREPARABLE.test(sql)) {
      return { file: rel, line, sql,
               why: `PREPARE holds no ${(/^\s*(\w+)/.exec(sql)?.[1] ?? "such").toLowerCase()} statement` };
    }
    return { file: rel, line, sql };
  });
}

function main(): number {
  const { flags } = parseArgs(process.argv.slice(2));
  const psql = flags.get("psql") || DEFAULT_PSQL;
  const root = flags.get("src") || process.cwd();

  const found = sources(root, SRC)
    .filter((f) => f.slice(root.length + 1) !== SELF)
    .flatMap((f) => queriesIn(f, root));
  if (!found.length) {
    // Non-zero: finding no queries in a repository that has them means the walk is pointed
    // somewhere wrong, and "0 failures" would be the most confident wrong answer available.
    console.log(`\n  CANNOT TELL: no queries found under ${SRC.join(", ")} in ${root}.`);
    console.log("  This repository has them; finding none means --src names the wrong tree.\n");
    return 2;
  }

  // One connection's worth of work, but each statement on its own call: a batch would stop
  // at the first refusal and report one failure where there might be several.
  const checkable = found.filter((f) => !f.why);
  const skipped = found.filter((f) => f.why);
  const failures: string[] = [];

  const ready = psqlTry(psql, "select 1;");
  if (!ready.ok) {
    return die(`no database to check against: ${ready.error.slice(-300)}\n` +
               `  ran: ${psql}\n` +
               "  this needs an EMPTY database the gateway has migrated — schema, not data.");
  }

  checkable.forEach((q, n) => {
    const name = `zzchk_${n}`;
    // DEALLOCATE in the same input, so a run leaves the session as it found it and the name
    // cannot collide with itself on a retry.
    const r = psqlTry(psql, `prepare ${name} as ${q.sql};\ndeallocate ${name};`);
    if (!r.ok) {
      const msg = r.error.split("\n").filter((l) => /^(ERROR|DETAIL|HINT):/.test(l)).join(" ")
                  || r.error.split("\n")[0] || "refused";
      failures.push(`${q.file}:${q.line} — ${msg}`);
    }
  });

  console.log(`\n  ${checkable.length} of ${found.length} queries prepared against the live schema.`);

  if (skipped.length) {
    console.log(`\n  ${skipped.length} not checkable, and why:`);
    for (const s of skipped) console.log(`    ${s.file}:${s.line} — ${s.why}`);
  }

  if (!failures.length) {
    console.log("\n  Every query Postgres was shown, it agreed to run.\n");
    return 0;
  }

  console.log(`\n  ${failures.length} query/queries Postgres refuses:\n`);
  for (const f of failures) console.log(`    ${f}`);
  console.log("\n  A refused query does not run slowly or return the wrong rows. It does not");
  console.log("  run, so whatever route reaches it answers 500 to everyone, every time.\n");
  return 1;
}

process.exit(main());
