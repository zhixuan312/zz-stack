/**
 * rubric-load — put every definition of good the catalog carries into the platform's tables.
 *
 *   zz-tool rubric-load
 *   zz-tool rubric-load --skill sm-build --psql '<command>' --dry-run
 *   zz-tool rubric-load --skill sm-select --version 1.1 --affirm
 *
 * WHY A SKILL NEEDS ONE EVEN WHEN NOTHING SCORES IT. A rubric is not only a judge's
 * instruction sheet. It is the answer to "what would better look like", written down before
 * anybody tries to improve the skill — and a skill with no answer to that cannot be shown to
 * have got better, or worse, or to have been worth changing at all. Of 41 registered skills,
 * 5 produce a gated document. The other 36 were unimprovable in exactly that sense: their
 * definitions of good could be written, reviewed and shipped in the catalog and still never
 * reach the database, because the only path into zz.rubric ran through eval-store, which
 * refuses a run that judged no documents.
 *
 * This is that missing door. It reads `<skill>/evals/rubric.json` wherever the catalog keeps
 * one and upserts it — same content signature, same table, same rows eval-store would have
 * written — so `loop-eval`'s "NO DEFINITION OF GOOD" list is about skills nobody has defined
 * rather than skills nobody could store.
 *
 * --affirm RECORDS A DECISION THE GATE MAKES, and without it that gate could not be closed.
 * `zz.skill_version.rubric_id` is what says "this version is judged by this ruler", and the
 * only thing that ever set it was eval-store, as a side effect of storing a judged run. So
 * re-affirming a ruler BEFORE judging — which is the entire point of zz-skill-define's gate —
 * had nowhere to land: you had to judge first to record the ruler you were supposed to agree
 * on first. 5 of 73 versions declared one, and the rest were not undecided so much as
 * unrecordable.
 *
 * WHAT IT DOES NOT DO is score anything. Storing the ruler and taking the measurement are
 * different acts, and conflating them is what made this necessary.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { die, optional, parseArgs } from "../lib/cli.js";
import { DEFAULT_PSQL, psqlRows, psqlText } from "../lib/psql.js";
import { type RubricFile, upsertRubric, whyNotARubric } from "../lib/rubric.js";

const lit = (s: string): string => `'${String(s ?? "").replace(/'/g, "''")}'`;

/** Every `evals/rubric.json` under a root, by the skill directory that holds it. The skill's
 *  NAME is its directory — the same rule register-skills uses to decide what a skill is, so
 *  the two tools cannot disagree about which skill a file belongs to. */
function rubricFiles(root: string): { skill: string; file: string }[] {
  const out: { skill: string; file: string }[] = [];
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const here = join(dir, e.name);
      const rubric = join(here, "evals", "rubric.json");
      if (existsSync(rubric) && existsSync(join(here, "SKILL.md"))) {
        out.push({ skill: e.name, file: rubric });
      }
      walk(here);
    }
  };
  for (const top of ["catalog", "blocks", "skills"]) walk(join(root, top));
  return out;
}

function main(argv: string[]): number {
  const args = parseArgs(argv, ["dry-run", "affirm"]);
  const psql = optional(args, "psql", "how to reach the database") ?? DEFAULT_PSQL;
  const root = optional(args, "root", "the repository root") ?? process.cwd();
  const only = optional(args, "skill", "just this one skill");
  const forVersion = optional(args, "version", "the version to affirm the ruler for");

  // AFFIRM IS A DIFFERENT ACT FROM LOADING, and it is deliberately explicit. Loading puts a
  // definition of good in the table; affirming says a particular VERSION is judged by it.
  // Doing the second implicitly on every load would silently re-point older versions at a
  // rubric nobody agreed applied to them, and every score taken under the old one would
  // quietly change what it claimed to measure.
  if (args.flags.has("affirm")) {
    if (!only || !forVersion) return die("--affirm needs --skill and --version");
    const sv = psqlRows<{ id: string; rubric: string | null }>(psql,
      `select sv.id::text as id, r.id::text as rubric
         from zz.skill s
         join zz.skill_version sv on sv.skill_id = s.id
         left join zz.rubric r on r.skill_id = s.id
        where s.name = ${lit(only)} and sv.version = ${lit(forVersion)}
        order by r.version::numeric desc limit 1`);
    if (!sv.length) return die(`no ${only} ${forVersion} in zz.skill_version`);
    if (!sv[0].rubric) {
      return die(`${only} has no rubric to affirm — write one at <skill>/evals/rubric.json, ` +
                 "load it, then affirm it for this version");
    }
    psqlText(psql, `update zz.skill_version set rubric_id = ${lit(sv[0].rubric)}::uuid
                     where id = ${lit(sv[0].id)}::uuid`);
    console.log(`\n  ${only} ${forVersion} is now judged by this skill's current rubric.`);
    console.log("  Scores taken from here are comparable with every other round under it.\n");
    return 0;
  }

  const files = rubricFiles(root).filter((f) => !only || f.skill === only);
  if (!files.length) {
    console.log(`\n  No evals/rubric.json found under ${root}${only ? ` for ${only}` : ""}.\n`);
    return 1;
  }

  let stored = 0, already = 0, skipped = 0;
  console.log("");
  for (const { skill, file } of files.sort((a, b) => a.skill.localeCompare(b.skill))) {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(file, "utf8"));
    } catch (err) {
      console.log(`    ${skill.padEnd(22)} SKIPPED — ${(err as Error).message}`);
      skipped++; continue;
    }
    const why = whyNotARubric(raw);
    if (why) {
      console.log(`    ${skill.padEnd(22)} SKIPPED — ${why}`);
      skipped++; continue;
    }
    const rubric = raw as RubricFile;

    // A skill the registry has never heard of is a registration problem, not a rubric one,
    // and saying which it is saves the reader a search. register-skills runs first.
    const row = psqlRows<{ id: string }>(psql,
      `select id::text as id from zz.skill where name = ${lit(skill)}`);
    if (!row.length) {
      console.log(`    ${skill.padEnd(22)} SKIPPED — not in zz.skill; run register-skills first`);
      skipped++; continue;
    }

    if (args.flags.has("dry-run")) {
      console.log(`    ${skill.padEnd(22)} would store ${rubric.dimensions.length} dimension(s)`);
      stored++; continue;
    }
    const got = upsertRubric(psql, row[0].id, rubric);
    console.log(`    ${skill.padEnd(22)} ${got.created ? `stored v${got.version}` : `already v${got.version}`}` +
                `, ${rubric.dimensions.length} dimension(s)`);
    if (got.created) stored++; else already++;
  }

  console.log(`\n  ${stored} stored${args.flags.has("dry-run") ? " (dry run)" : ""}` +
              `, ${already} already defined, ${skipped} skipped\n`);
  return skipped ? 1 : 0;
}

try {
  process.exit(main(process.argv.slice(2)));
} catch (err) {
  console.error(String((err as Error)?.message ?? err));
  process.exit(2);
}
