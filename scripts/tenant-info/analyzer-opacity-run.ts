#!/usr/bin/env node
/**
 * analyzer-opacity-run.ts — proves, against a real PostgreSQL at the pinned image, that every
 * term the analyzer currently emits for `OPACITY_CASES` (`@zz/indexing`) survives
 * PostgreSQL's own text-search tokenizer byte-identical, and writes that proof to
 * `testing/tenant-info/analyzer-opacity.golden.json`.
 *
 * DELIBERATE: `to_tsvector('simple', ...)`, not a `bm25` index. This creates the `pg_textsearch`
 * extension and reads `pg_textsearch_version` back from `pg_extension` for the provenance block,
 * but builds no `bm25` index and runs no `to_bm25query`. `to_tsvector('simple', term)` is stock
 * PostgreSQL, needs no extension and no index, and tests the property the contract names: does
 * the database's own tokenizer split, stem or drop a term the analyzer emits. The `simple`
 * dictionary lowercases and does not stem, which is why `OPACITY_SEEDS` (`tenant-analysis.ts`)
 * is all-lowercase — a case-preserving term run into a case-folding dictionary would report a
 * mangled term for a reason that has nothing to do with opacity.
 *
 * A throwaway container, never the production cluster. Started from the exact image
 * `deploy/docker-compose.yml` pins (`postgresService`), named distinctively, and reaped both on
 * exit and on start via `reapLeaked`, for anything a crashed run left behind.
 *
 * No `pg` client library: every query runs through `docker exec ... psql`, the same mechanism
 * `scripts/release/build.ts` uses. This repository's root `package.json` declares no `pg`
 * dependency.
 *
 * A generator run with no reachable database fails: `die()` exits non-zero before a single byte
 * of the fixture is written.
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
 *  the output is exactly the rows, one field per line.
 *
 *  DELIBERATE: the SQL goes in on stdin, never on `-c`. `-v name=value` plus `:'name'` in the
 *  SQL text is psql's own self-quoting substitution, interpolated before the statement is sent,
 *  so a term containing a quote or a backslash arrives already escaped as a SQL literal. That
 *  substitution runs on psql's stdin input but not inside a `-c "..."` argument, where a bare
 *  `:'name'` reaches the server unexpanded and is refused as a syntax error at `:`. `-i` on
 *  `docker exec` keeps the container's stdin open for it. */
function psql(sql: string, vars: Record<string, string> = {}): string {
  const args = ["exec", "-i", CONTAINER, "psql", "-U", PG_USER, "-d", PG_DB, "-v", "ON_ERROR_STOP=1"];
  for (const [name, value] of Object.entries(vars)) args.push("-v", `${name}=${value}`);
  args.push("-tA");
  // `run`'s own default `stdio` fixes stdin to `"ignore"`, which wins over `input` rather than
  // being overridden by it: `docker exec -i` then reads EOF immediately and every query returns
  // empty output with no error. Passing `stdio` explicitly replaces that default.
  return run("docker", args, { input: `${sql}\n`, stdio: ["pipe", "pipe", "pipe"] });
}

/** Every lexeme PostgreSQL's own `simple` tokenizer produces for one submitted term — zero
 *  lexemes means the term was dropped, more than one means it was split, and one lexeme that
 *  does not equal the term means it was rewritten (stemmed or case-folded). All three are the
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

  // Registered before anything starts, same as build.ts's own throwaway-postgres step: a die()
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

    // `pg_isready` alone is not enough: the postgres image runs a temporary server during
    // initdb which answers it before the final restart that creates `POSTGRES_DB`. Probing
    // `select 1` against the named database is what proves the fixture database is reachable.
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

    // Real, shipped DDL only: the same `create extension if not exists pg_textsearch;` the
    // search projections are created under. No index, no `to_bm25query`: see the header for why.
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
      // The fixture above is written first and is honest about what happened. It still fails
      // loudly, and the gate's frozen check reaches the same failure independently by reading
      // the fixture back.
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
