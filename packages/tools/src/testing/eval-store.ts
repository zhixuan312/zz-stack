/**
 * eval-store — put an evaluation where it survives, which is not a temp directory.
 *
 *   zz-tool eval-store --dir <rundir> --flow sm/ops-flow --skill sm-intent --version 1.0
 *   zz-tool eval-store --dir <rundir> --flow sm/ops-flow --skill sm-intent --version 1.0 --psql '<command>'
 *
 * WHY THIS EXISTS AT ALL. Every per-round score, every deviation classification and the whole
 * variance study lived in a session-scoped scratch directory — 57MB of it — and only the derived
 * prose summaries were ever written anywhere durable. A day of measurement was one cleanup away
 * from being unreproducible, and nothing said so.
 *
 * WHAT IT WRITES, AND THE ONE RULE THAT MATTERS. One row per subject per dimension, into
 * zz.eval_score. NEVER an average. An average over 30 pieces of work and an average over 130 are
 * not comparable, and a number collapsed at write time can never be un-collapsed at read time —
 * whereas rows re-average over any subset, so "compare these two versions on the work they both
 * covered" stays a set intersection instead of an impossibility.
 *
 * WHY A SUBJECT AND NOT A DOCUMENT. zz.eval_score points at zz.eval_subject, which CAPTURES what
 * was scored — team, initiative, path, content hash, git commit — rather than joining to the
 * team's document row. Two reasons, and the second is the quieter one:
 *
 *   reindexTeam DELETES zz.doc rows whose files are gone, so a team archiving their own work
 *   would have taken our measurement of our own skill with it. That nearly happened: resetting
 *   the evaluation store archived 37 initiatives and removed 132 rows.
 *
 *   Documents CHANGE after being scored — one initiative here holds spec.v1, spec.v2 and spec.v4.
 *   Joining to "the document" means a score silently becomes a score about text nobody judged.
 *   The content hash makes that impossible.
 *
 * The text itself is not copied. The team's store is a git repository, so the commit is enough to
 * read back exactly what was judged without us holding a second copy that outlives their
 * deletion.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { die, optional, parseArgs, required } from "../lib/cli.js";
import { DEFAULT_PSQL, psqlRows, psqlText } from "../lib/psql.js";
import { upsertRubric } from "../lib/rubric.js";

interface Mark { dimension: string; score: number; quote: string; why: string }
interface Judgement { id: string; agency: string; marks: Mark[]; mean: number;
                      worst: { quote: string; fix: string }; addressed: boolean }
interface Judged { step: string; overall: number; judgements: Judgement[] }
interface Rubric { step: string; role: string; dimensions: { name: string; five: string; one: string }[] }

const lit = (s: string): string => `'${String(s ?? "").replace(/'/g, "''")}'`;

/** One value out of one statement.
 *
 * psqlRows wraps whatever it is given as a SUBQUERY, and `insert ... returning` cannot be one.
 * Passing an insert straight in returns the empty string and looks exactly like a row that was
 * not found -- which is how the first run of this tool wrote 30 subjects, 0 scores, and reported
 * success. Writes go through `writing()`, which puts the insert in a CTE where it is legal. */
function one(psql: string, sql: string): string {
  const rows = psqlRows<{ v: string }>(psql, sql);
  return rows[0]?.v ?? "";
}

function writing(psql: string, insert: string): string {
  // psqlText, not psqlRows. psqlRows wraps its argument as a SUBQUERY, and Postgres allows a
  // data-modifying CTE only at the top level of a statement -- so an insert can never go through
  // it, in any wrapping. It does not error either: it comes back empty, which reads exactly like
  // a row that was not found. That is how the first two runs of this tool wrote 30 subjects, 0
  // scores, and printed "stored eval" with a blank id.
  return psqlText(psql, insert).split("\n")[0].trim();
}

function main(argv: string[]): number {
  const args = parseArgs(argv, []);
  const dir = required(args, "dir", "the run directory holding judged.json");
  // No default and no fallback to sm/ops-flow. This tool used to hardcode the one flow that
  // existed; every other flow's rubric lived at a path this tool could never reach, and
  // nothing said so until eval-store silently scored against the wrong flow's rubric.
  const flow = required(args, "flow", "which flow's catalog owns this skill, e.g. sdlc/sdlc-flow", 2);
  const skill = required(args, "skill", "which skill was measured");
  const version = required(args, "version", "which version of it");
  const psql = args.flags.get("psql") || DEFAULT_PSQL;
  const root = optional(args, "root", "the repository root") ?? process.cwd();
  const judgeModel = optional(args, "judge-model", "which model marked it") ?? "sonnet";

  const judged = JSON.parse(readFileSync(join(dir, "judged.json"), "utf8")) as Judged;
  const ctlPath = join(dir, "judged-control.json");
  const control = existsSync(ctlPath)
    ? JSON.parse(readFileSync(ctlPath, "utf8")) as Judged : null;

  const rubricPath = join(root, `catalog/${flow}/skills/${skill}/evals/rubric.json`);
  if (!existsSync(rubricPath)) die(`no rubric at ${rubricPath} — a score with no stated rubric is not a measurement`, 2);
  const rubric = JSON.parse(readFileSync(rubricPath, "utf8")) as Rubric;

  // Which initiative and path each requirement wrote. Recorded by the runner at the time, by
  // exact path — matching by content was tried first and mis-attributed two documents.
  const produced = new Map<string, string>();
  const pPath = join(dir, "produced.txt");
  if (existsSync(pPath)) {
    for (const line of readFileSync(pPath, "utf8").split("\n")) {
      const [id, path] = line.trim().split(/\s+/);
      if (id && path) produced.set(id, path);
    }
  }

  const skillId = one(psql, `select id::text as v from zz.skill where name = ${lit(skill)}`);
  if (!skillId) die(`zz.skill has no row for ${skill} — it has never been seen running`);
  const svId = one(psql,
    `select id::text as v from zz.skill_version where skill_id = ${lit(skillId)}::uuid and version = ${lit(version)}`);
  if (!svId) die(`zz.skill_version has no ${skill} ${version}`);

  // A run that wrote nothing is not worth a row. Failing here beats an eval that reports success
  // over zero scores, which is what the first version of this did.
  if (!judged.judgements.length) die(`${dir}/judged.json holds no judgements`);

  // THE RUBRIC IS UPSERTED BY CONTENT, not by a counter — and the upsert itself lives in
  // lib/rubric.ts, because this was the ONLY door into zz.rubric and it is a door only a
  // document-producing skill can walk through. 36 of 41 skills produce no document; their
  // definitions of good had nowhere to land. rubric-load uses the same function.
  const got = upsertRubric(psql, skillId, rubric);
  const rubricId = got.id;
  if (got.created) {
    console.log(`  rubric ${skill} v${got.version} recorded, ${rubric.dimensions.length} dimensions`);
  }
  // The version being judged declares which ruler judges it. Reuse across versions is what keeps
  // them comparable; this is where that link is made rather than assumed.
  psqlText(psql, `update zz.skill_version set rubric_id = ${lit(rubricId)}::uuid where id = ${lit(svId)}::uuid`);

  const dimIds = new Map<string, string>();
  for (const r of psqlRows<{ id: string; name: string }>(psql,
    `select id::text as id, name from zz.rubric_dimension where rubric_id = ${lit(rubricId)}::uuid`)) {
    dimIds.set(r.name, r.id);
  }

  const evalId = writing(psql,
    `insert into zz.eval (skill_version_id, rubric_id, judge_model, selection_note, doc_count, finished_at)
     values (${lit(svId)}::uuid, ${lit(rubricId)}::uuid, ${lit(judgeModel)},
             ${lit(`${skill} ${version} over ${judged.judgements.length} pieces of work`)},
             ${judged.judgements.length}, now())
     returning id::text as v`);

  let subjects = 0, scores = 0, unquoted = 0, unfound = 0;
  for (const j of judged.judgements) {
    const path = produced.get(j.id) ?? "";
    const initiative = path.split("/")[0] ?? "";
    const docPath = path.split("/").slice(1).join("/");
    // The hash and commit come from the platform's own index, not from anything the judge said.
    const meta = psqlRows<{ hash: string }>(psql,
      `select content_hash as hash from zz.doc where initiative = ${lit(initiative)} and path = ${lit(docPath)} limit 1`);
    const subjectId = writing(psql,
      `insert into zz.eval_subject (eval_id, initiative_slug, path, content_hash, skill_version_id)
       values (${lit(evalId)}::uuid, ${lit(initiative)}, ${lit(docPath)},
               ${lit(meta[0]?.hash ?? "")}, ${lit(svId)}::uuid)
       on conflict (eval_id, initiative_slug, path) do update set path = excluded.path
       returning id::text as v`);
    subjects++;
    // IS THE QUOTE ACTUALLY IN THE DOCUMENT? The judge is told a score without a verbatim
    // quote is wrong, and nothing checked. A fabricated or paraphrased quote makes a score
    // look evidenced while resting on nothing, and it is indistinguishable afterwards from a
    // real one. judge-stats reports uncited scores on the trace side; this is the same
    // standard on the document side.
    //
    // From zz.doc.body, not the filesystem. This tool deliberately never reads the team's
    // store — "the text itself is not copied" — and it does not have to: the index already
    // carries the body it ranks and excerpts. No new argument, and it works from anywhere the
    // database is reachable.
    //
    // Whitespace-normalised, because a judge that re-wraps a quotation has still found it.
    // Counted and reported, never dropped: how well a judge evidences itself is a fact about
    // the judge worth keeping, and discarding the weak ones would flatter it.
    const norm = (t: string): string => t.replace(/\s+/g, " ").trim().toLowerCase();
    const bodyRow = psqlRows<{ body: string }>(psql,
      `select body from zz.doc where initiative = ${lit(initiative)} and path = ${lit(docPath)} limit 1`);
    const bodyText = norm(bodyRow[0]?.body ?? "");
    const ctl = control?.judgements.find((c) => c.id === j.id);
    for (const [isControl, marks] of [[false, j.marks], [true, ctl?.marks ?? []]] as [boolean, Mark[]][]) {
      for (const m of marks) {
        const dimId = dimIds.get(m.dimension);
        if (!dimId) continue;   // a dimension the rubric no longer has; not silently renamed
        if (!isControl) {
          const q = norm(m.quote ?? "");
          if (!q) unquoted++;
          else if (bodyText && !bodyText.includes(q)) unfound++;
        }
        psqlText(psql,
          `insert into zz.eval_score (eval_id, subject_id, dimension_id, score, quote, reason, is_control)
           values (${lit(evalId)}::uuid, ${lit(subjectId)}::uuid, ${lit(dimId)}::uuid,
                   ${Math.max(1, Math.min(5, m.score))}, ${lit(m.quote.slice(0, 2000))},
                   ${lit(m.why.slice(0, 2000))}, ${isControl})
           on conflict do nothing`);
        scores++;
      }
    }
  }

  // The recurring faults, and whether anything was done about them. `scope` is what decides
  // whether a fault can justify changing a skill at all: generic survives a change of subject
  // matter, specific does not.
  let findings = 0;
  const devPath = join(dir, "deviations.json");
  if (existsSync(devPath)) {
    const { deviations } = JSON.parse(readFileSync(devPath, "utf8")) as
      { deviations: { id: string; what: string; class: string }[] };
    const corpus = new Set(deviations.map((d) => d.id)).size;
    const pat = join(dir, "pattern.log");
    if (existsSync(pat)) {
      for (const line of readFileSync(pat, "utf8").split("\n")) {
        const m = /^\s+(\d+)\/(\d+)\s+\(\s*\d+%\)\s+(.+)$/.exec(line);
        if (!m) continue;
        psqlText(psql,
          `insert into zz.eval_finding (eval_id, pattern, docs_affected, scope, decision)
           values (${lit(evalId)}::uuid, ${lit(m[3].trim())}, ${Number(m[1])}, 'generic', 'deferred')`);
        findings++;
      }
    }
    console.log(`  ${deviations.length} deviations over ${corpus} pieces of work, ${findings} recurring`);
  }

  console.log(`\n  stored eval ${evalId}`);
  if (unquoted || unfound) {
    console.log(`  evidence: ${unquoted} score(s) carried no quote; ${unfound} quoted text not`);
    console.log("  found in the document. A score the judge could not evidence is stored and");
    console.log("  counted rather than dropped — how well it evidenced itself is a fact about");
    console.log("  the judge, and discarding the weak ones would flatter it.");
  }
  console.log(`    ${skill} ${version}, rubric ${rubricId.slice(0, 8)}, judged by ${judgeModel}`);
  console.log(`    ${subjects} subjects, ${scores} scores${control ? " (real and control)" : " — NO CONTROL, so this is not yet a measurement"}`);
  console.log(`    ${findings} recurring faults recorded as findings\n`);
  return 0;
}

try {
  process.exit(main(process.argv.slice(2)));
} catch (err) {
  console.error(String((err as Error)?.message ?? err));
  process.exit(2);
}
