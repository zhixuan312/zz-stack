#!/usr/bin/env node
/**
 * checks/core-scoped-answers.ts — what the core door records and answers stays inside what the
 * caller asked about: their own team, the filters they passed, the documents they were shown.
 *
 *   node checks/core-scoped-answers.ts   # needs Docker and a built tree (`npm run build`)
 *
 * It starts a throwaway PostgreSQL and a real zz-core on it (`withThrowawayCore`), with no
 * typed-service key, and drives the core door. What it establishes:
 *
 *   - `assess` naming an initiative slug only another team holds records the reading on the
 *     caller's own team and on no initiative;
 *   - `document_present` with an array whose later path is refused still answers the earlier
 *     document it recorded as presented;
 *   - `bug_list`'s `by_status` counts the reports its filters match, not every report;
 *   - `principalId` resolves a name only when exactly one active person carries it, and an empty
 *     name to nobody;
 *   - every comparison of `zz.principal.email` with a bound address in zz-core's source holds
 *     `lower()` on both sides, so it does not depend on the connection's search path reaching
 *     `citext`'s operators.
 *
 * The only database it touches is the one it started.
 *
 * Exit 0: every case held — one line per case, then the final line.
 * Exit 1: a case failed — the case and what was found.
 * Exit 2: Docker is not available — the check could not run, and that is not a pass.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { Mcp } from "@zz/mcp-client";

import { root } from "../scripts/deployment.ts";
import { withThrowawayCore, type Core } from "../scripts/schema/throwaway-core.ts";

const NAME = "core-scoped-answers";
const DONE = "core-scoped-answers: a reading stays on the asker's team, a present answers what it recorded, " +
  "bug_list counts what it filtered, and a person is resolved by an address in any case or by a name only one carries: ok";

// The child inherits this environment: with no key every reading is `unavailable` and still recorded.
delete process.env.TYPESAFE_API_KEY;

/** A second team holding an initiative slug the seeded team does not. */
async function otherTeamInitiative(c: Core, slug: string): Promise<string> {
  const { rows } = await c.sql.query<{ id: string }>(
    `with p as (insert into zz.principal (email, display_name) values ('other@example.test', 'Other') returning id),
          t as (insert into zz.team (slug, name, created_by) select 'other-team', 'Other', id from p returning id)
     insert into zz.initiative (team_id, slug, flow) select id, $1, '' from t returning team_id::text as id`, [slug]);
  return rows[0].id;
}

async function assessStaysOnTeam(c: Core): Promise<void> {
  const step = "assess under a slug only another team holds";
  const slug = "2026-10-30-theirs";
  const other = await otherTeamInitiative(c, slug);
  await c.ok(step, "assess", { family: "repeats_finding", subject: "F3 [S2] x: y", initiative: slug,
                               about: "sources/r2.md#F3" });
  const { rows } = await c.sql.query<{ team: string; initiative: string | null }>(
    `select t.slug as team, a.initiative_id::text as initiative from zz.assessment a
       join zz.team t on t.id = a.team_id where a.about = 'sources/r2.md#F3'`);
  if (rows.length !== 1 || rows[0].team !== c.team || rows[0].initiative !== null) {
    c.fail(step, `the reading was recorded as ${JSON.stringify(rows)}, not on ${c.team} with no initiative ` +
                 `(the other team is ${other})`);
  }
  c.pass(step);
}

async function presentAnswersWhatItRecorded(c: Core): Promise<void> {
  const step = "document_present with a refused later path";
  const slug = await c.open("present-many");
  await c.ok(step, "document_write", { path: `${slug}/notes.md`, content: "# Notes\n\nThe sentinel paragraph.\n" });
  const reply = await c.call(step, "document_present", { path: [`${slug}/notes.md`, `${slug}/../escape.md`] });
  if (!/The sentinel paragraph\./.test(reply)) {
    c.fail(step, `the reply withheld the document it presented: ${reply.slice(0, 400)}`);
  }
  if (!/^ERROR/m.test(reply.split("────────").at(-1) ?? "")) {
    c.fail(step, `the refused path was not answered with its refusal: ${reply.slice(-400)}`);
  }
  c.pass(step);
}

async function bugTallyFollowsFilters(c: Core): Promise<void> {
  const step = "bug_list by_status under a filter";
  await c.sql.query(
    `insert into zz.bug (title, detail, impact, reported_by)
     select x.title, 'detail', x.impact, p.id from zz.principal p,
            (values ('one', 'wrong_result'), ('two', 'wrong_result'), ('three', 'blocks_work')) x(title, impact)
      where p.email = $1`, [c.email]);
  // `bug_list` is on the core door only for the operator's role.
  const operator = new Mcp(c.mcp.url, { client: NAME, timeoutMs: 60_000, headers: {
    "x-zz-user-email": c.email, "x-zz-user-name": "Skeleton", "x-zz-user-id": "", "x-zz-user-role": "admin",
    "x-zz-via": "forwarded", "x-zz-pat-team": "", "x-zz-session-team": "" } });
  const reply = JSON.parse(await c.ok(step, "bug_list", { impact: "blocks_work" }, operator)) as
    { showing: number; by_status: Record<string, number> };
  if (reply.showing !== 1 || reply.by_status.open !== 1) {
    c.fail(step, `showing ${reply.showing} with by_status ${JSON.stringify(reply.by_status)} — the tally counts ` +
                 "reports the filter excluded");
  }
  c.pass(step);
}

async function principalByName(c: Core): Promise<void> {
  const step = "principalId by a name";
  const { pool } = await c.inProcess();
  const { principalId } = await import(pathToFileURL(join(root, "services/zz-core/dist/versions.js")).href) as
    typeof import("../services/zz-core/dist/versions.js");
  await c.sql.query(
    `insert into zz.principal (email, display_name) values
       ('alex1@example.test', 'Alex Tan'), ('alex2@example.test', 'Alex Tan'),
       ('blank@example.test', ''), ('una@example.test', 'Una Lim')`);
  const una = (await c.sql.query<{ id: string }>("select id::text as id from zz.principal where email = 'una@example.test'")).rows[0].id;
  const shared = await principalId(pool, "Alex Tan");
  const blank = await principalId(pool, "");
  const unique = await principalId(pool, "una lim");
  if (shared !== null) c.fail(step, `a name two people carry resolved to ${shared}`);
  if (blank !== null) c.fail(step, `an empty name resolved to ${blank}`);
  if (unique !== una) c.fail(step, `a name one person carries resolved to ${unique}, not ${una}`);
  c.pass(step);
}

/** A comparison of `email` with a bound address that `lower()` does not hold on both sides. The
 *  column is `citext`, whose operators live in schema `zz`: on a connection whose search path does
 *  not reach `zz` — every zz-core connection where the database user is not named `zz` — a bare
 *  `email = $1` compares as text and misses an address stored in another case. */
async function emailLookupsAreCaseless(c: Core): Promise<void> {
  const step = "every address lookup in zz-core compares lower() of both sides";
  const bare: string[] = [];
  const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true })
    .flatMap((e) => e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : []);
  for (const file of walk(join(root, "services/zz-core/src"))) {
    readFileSync(file, "utf8").split("\n").forEach((line, i) => {
      if (/\bemail = \$\d/.test(line) && !/lower\([a-z.]*email\) = lower\(\$\d\)/.test(line)) {
        bare.push(`${file.slice(root.length + 1)}:${i + 1}`);
      }
    });
  }
  if (bare.length) c.fail(step, `compared as text: ${bare.join(", ")}`);
  c.pass(step);
}

// Every case runs, and the failures are reported together: the cases share nothing but the database.
process.exitCode = await withThrowawayCore(NAME, DONE, async (c) => {
  const failed: string[] = [];
  for (const run of [assessStaysOnTeam, presentAnswersWhatItRecorded, bugTallyFollowsFilters, principalByName,
                     emailLookupsAreCaseless]) {
    try {
      await run(c);
    } catch (err) {
      failed.push((err as Error).message);
    }
  }
  if (failed.length) c.fail("the cases above", `${failed.length} failed:\n  ${failed.join("\n  ")}`);
});
