#!/usr/bin/env node
/**
 * analyzer-opacity-run.ts — Task I-8's generator. Proves, against a REAL PostgreSQL at the
 * pinned image, that every term `zz-lexical-v2` currently emits for `OPACITY_CASES`
 * (`@zz/indexing`) survives PostgreSQL's own text-search tokenizer byte-identical, and writes
 * that proof to `testing/tenant-info/analyzer-opacity.golden.json`.
 *
 * WHY `to_tsvector('simple', ...)`, NOT A `bm25` INDEX. `services/zz-core/src/tenant-info/
 * lanes.ts` and migration 070 both record, in their own words, that pg_textsearch's real index
 * DDL "exists nowhere in this checkout" and decline to invent it. This generator holds the
 * same line: it creates the `pg_textsearch` EXTENSION (070 already does exactly that, real,
 * shipped DDL) so `pg_textsearch_version` in the provenance block is a genuine value read back
 * from `pg_extension`, but it builds no `bm25` index and runs no `to_bm25query` — inventing
 * either here would be exactly the fabrication this platform's data-safety rules forbid.
 * `to_tsvector('simple', term)` is stock, documented PostgreSQL, needs no extension and no
 * index, and is a faithful test of the actual property Task I-8's Contract names: does the
 * database's OWN text-search tokenizer split, stem or drop a term the analyzer emits. The
 * `simple` dictionary lowercases and does not stem — which is why `OPACITY_SEEDS`
 * (`tenant-analysis.ts`) is deliberately all-lowercase: a case-preserving term run into a
 * case-FOLDING dictionary would report a "mangled" term for a reason that has nothing to do
 * with opacity, and this fixture isolates the property under test from that orthogonal,
 * already-understood behavior.
 *
 * A THROWAWAY CONTAINER, NEVER THE PRODUCTION CLUSTER. Started from the exact image
 * `deploy/docker-compose.yml` pins (`postgresService`, the same reader `scripts/release/
 * build.ts`'s own throwaway-postgres step uses), named distinctively and reaped both on exit
 * and, for anything a previous crashed run left behind, on start — `reapLeaked`, the same
 * safeguard `build.ts` carries for exactly this failure mode.
 *
 * NO `pg` CLIENT LIBRARY. Every query in this file runs through `docker exec ... psql`, the
 * same mechanism `scripts/release/build.ts`'s own throwaway-postgres step uses — this
 * repository's root `package.json` declares no `pg` dependency (only `@zz/indexing` does, for
 * the services that own a live pool), and every existing `scripts/` caller reaches a throwaway
 * Postgres by shelling out to `psql` rather than adding one. `-v term=...` plus `:'term'` in
 * the query text is psql's own self-quoting substitution — it escapes whatever the term
 * contains as a SQL string literal, so no manual quote-escaping is needed here.
 *
 * A GENERATOR RUN WITH NO REACHABLE DATABASE FAILS. `die()` below exits non-zero before a
 * single byte of `testing/tenant-info/analyzer-opacity.golden.json` is written — the Contract's
 * own words are "it never writes a fixture from nothing."
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { analyzerDigestFor, OPACITY_CASES } from "@zz/indexing";

import { die, log, reapLeaked, root, run, step } from "../deployment.ts";
import { postgresService } from "../release/postgres-service.ts";

const GENERATOR_VERSION = "1.0.0";
const FIXTURE_PATH = join(root, "testing/tenant-info/analyzer-opacity.golden.json");
const CONTAINER_PREFIX = "zz-opacity-pg-";
const CONTAINER = `${CONTAINER_PREFIX}${process.pid}`;
const PG_USER = "zz";
const PG_PASSWORD = "opacity-fixture";
const PG_DB = "zz";

interface OpacityCase {
  readonly submitted: string;
  readonly stored: string;
}

/** Runs one statement inside the throwaway container via `psql`, tuples-only and unaligned so
 *  the output is exactly the rows, one field per line, nothing else to parse around.
 *
 *  THE SQL GOES IN ON STDIN, NEVER ON `-c`. `-v name=value` plus `:'name'` in the SQL text is
 *  psql's own self-quoting substitution — psql interpolates it BEFORE sending the statement to
 *  the server, so whatever `value` contains (including a term with a quote or a backslash in
 *  it) arrives at the server already escaped as a proper SQL literal, with no manual
 *  quote-escaping needed here. Measured directly against this pinned image: that substitution
 *  runs on psql's normal script/stdin input, but NOT inside a `-c "..."` argument, where a bare
 *  `:'name'` reaches the server unexpanded and is refused as a syntax error at `:`. `-i` on
 *  `docker exec` keeps the container's stdin open for it. */
function psql(sql: string, vars: Record<string, string> = {}): string {
  const args = ["exec", "-i", CONTAINER, "psql", "-U", PG_USER, "-d", PG_DB, "-v", "ON_ERROR_STOP=1"];
  for (const [name, value] of Object.entries(vars)) args.push("-v", `${name}=${value}`);
  args.push("-tA");
  // `run`'s own default `stdio` fixes stdin to `"ignore"`, which silently wins over `input`
  // rather than being overridden by it — measured directly: with the default left in place,
  // `docker exec -i` reads EOF immediately and every query returns empty output with no error.
  // Passing `stdio` explicitly here replaces that default rather than merging with it.
  return run("docker", args, { input: `${sql}\n`, stdio: ["pipe", "pipe", "pipe"] });
}

/** Every lexeme PostgreSQL's own `simple` tokenizer produces for one submitted term — zero
 *  lexemes means the term was DROPPED, more than one means it was SPLIT, and one lexeme that
 *  does not equal the term means it was REWRITTEN (stemmed or case-folded). All three are the
 *  "database rewrites, stems, splits or drops" the Contract's Errors bullet names. */
function lexemesFor(term: string): string[] {
  const out = psql(
    "select lexeme from unnest(to_tsvector('simple', :'term')) as u(lexeme, positions, weights)",
    { term },
  );
  return out.length === 0 ? [] : out.split("\n");
}

async function main(): Promise<void> {
  step("I-8", "analyzer opacity fixture — a real PostgreSQL run");

  // Registered BEFORE anything starts, same as build.ts's own throwaway-postgres step: a die()
  // between here and the teardown at the end must not leave a container running.
  const drop = (): void => {
    try { run("docker", ["rm", "-f", CONTAINER]); } catch { /* already gone, or never started */ }
  };
  process.on("exit", drop);
  reapLeaked(CONTAINER_PREFIX);

  let pgVersion = "";
  let pgTextsearchVersion = "";
  const cases: OpacityCase[] = [];

  try {
    const pgsvc = postgresService(root);
    log(`  starting ${pgsvc.image} as ${CONTAINER}`);
    try {
      run("docker", ["run", "-d", "--name", CONTAINER,
                     "-e", `POSTGRES_USER=${PG_USER}`, "-e", `POSTGRES_PASSWORD=${PG_PASSWORD}`,
                     "-e", `POSTGRES_DB=${PG_DB}`, pgsvc.image, ...pgsvc.command]);
    } catch (e) {
      die(`could not start the fixture database (${pgsvc.image}): ${(e as Error).message}\n`
          + "no fixture written — a generator run with no reachable database writes nothing.");
    }

    // `pg_isready` alone is not enough: the official postgres image runs a TEMPORARY server
    // during initdb, which answers `pg_isready` before the final restart that actually creates
    // `POSTGRES_DB` and starts listening for real. Probing `select 1` against the named
    // database is what actually proves the fixture database is reachable, not just that some
    // postmaster somewhere is up.
    let ready = false;
    for (let i = 0; i < 90; i++) {
      try {
        run("docker", ["exec", CONTAINER, "psql", "-U", PG_USER, "-d", PG_DB, "-tAc", "select 1"]);
        ready = true;
        break;
      } catch {
        execFileSyncSleep();
      }
    }
    if (!ready) {
      die("the fixture PostgreSQL never became ready within 90s\n"
          + "no fixture written — a generator run with no reachable database writes nothing.");
    }

    // Real, shipped DDL only — the same `create extension if not exists pg_textsearch;`
    // migration 070 runs. No index, no `to_bm25query`: see the header for why.
    try {
      psql("create extension if not exists pg_textsearch");
    } catch (e) {
      die(`could not create the pg_textsearch extension on the fixture database: ${(e as Error).message}\n`
          + "no fixture written — a generator run with no reachable database writes nothing.");
    }

    pgVersion = psql("select version()");
    pgTextsearchVersion = psql("select extversion from pg_extension where extname = 'pg_textsearch'");
    if (!pgVersion || !pgTextsearchVersion) {
      die("the fixture database answered but named no server_version or pg_textsearch extversion\n"
          + "no fixture written — a generator run with no reachable database writes nothing.");
    }
    log(`  pg_version: ${pgVersion}`);
    log(`  pg_textsearch_version: ${pgTextsearchVersion}`);
    log(`  submitting ${OPACITY_CASES.length} analyzer term(s)`);

    const mangled: string[] = [];
    for (const term of OPACITY_CASES) {
      const lexemes = lexemesFor(term);
      const stored = lexemes.length === 1 ? lexemes[0] : lexemes.join("+");
      cases.push({ submitted: term, stored });
      if (lexemes.length !== 1 || lexemes[0] !== term) {
        mangled.push(`${term} -> ${lexemes.length === 0 ? "<dropped>" : stored}`);
      }
    }

    const provenance = {
      generator_version: GENERATOR_VERSION,
      pg_version: pgVersion,
      pg_textsearch_version: pgTextsearchVersion,
      generated_at: new Date().toISOString(),
      analyzer_digest: analyzerDigestFor(OPACITY_CASES),
    };
    mkdirSync(join(root, "testing/tenant-info"), { recursive: true });
    writeFileSync(FIXTURE_PATH, `${JSON.stringify({ provenance, cases }, null, 2)}\n`);
    log(`  wrote ${FIXTURE_PATH.slice(root.length + 1)} (${cases.length} case(s))`);

    if (mangled.length > 0) {
      // The fixture above is written first and is honest about what happened — this generator
      // does not suppress a genuine result. It still fails loudly: the Contract's own words are
      // "a term the database rewrites, stems, splits or drops fails the generator and names the
      // term in both forms," and the gate's frozen check will independently reach the same
      // failure by reading the fixture back.
      die(`the database rewrote ${mangled.length} analyzer term(s) — a real finding, not a bug `
          + `in this generator:\n${mangled.map((m) => `    ${m}`).join("\n")}`);
    }
    log("  every submitted term came back byte-identical");
  } finally {
    drop();
    process.removeListener("exit", drop);
  }
}

// A tiny blocking sleep between readiness polls, matching build.ts's own `execSync("sleep 1")`.
function execFileSyncSleep(): void {
  run("sleep", ["1"]);
}

main().catch((e: unknown) => die(e instanceof Error ? e.stack ?? e.message : String(e)));
