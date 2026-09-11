/**
 * eval-record — store ONE judgement of one document, from a judge that is not eval-judge.
 *
 *   zz-tool eval-record --step sm-intent --version 1.0 \
 *     --team product-1 --initiative 2026-09-04-noise-complaint-mediation --path intent.md \
 *     --judge sam@example.com \
 *     --score "Outcome as state, not solution=4" --score "Fidelity — no invention, no silent resolution=5" \
 *     --note "constraints/outcome bleed, second occurrence"
 *
 * WHY THIS EXISTS, and it is the same hole rubric-load filled one layer up. zz.eval_score
 * had exactly one door: eval-store, which reads a `judged.json` that only eval-judge writes.
 * So a score produced any other way — a stakeholder reading the document at its gate, a
 * reviewer disagreeing with the judge, a human spot-check of a run — had nowhere to go.
 *
 * That is not hypothetical. Two full initiatives were scored gate by gate against the
 * shipped rubrics on 2026-09-04, every dimension reasoned and quoted, and every number went
 * into a markdown file in a scratch directory because there was no command that would take
 * it. The dashboard correctly reported those documents as `judged: never`. Work that is not
 * stored did not happen, and a mechanism that only accepts one judge's output is a mechanism
 * that quietly discards every other judge.
 *
 * THE JUDGE IS RECORDED, and that is the point rather than a detail. zz.eval.judge_model
 * already exists; this writes the judge's own name into it. Scores from different judges
 * must never be averaged or differenced — a delta between a model's baseline and a person's
 * read measures the instrument, not the work — so the column that keeps them apart is the
 * one thing this must not get wrong. Every reader of zz.eval_score can then group by it.
 *
 * NOT A REPLACEMENT for eval-judge. A model judging thirty documents against one rubric is
 * how a corpus gets a comparable baseline, and nothing here scales. This is for the
 * judgements a person actually makes, one document at a time, which until now were the only
 * ones the platform could not keep.
 */
import { die, optional, parseArgs, required } from "../lib/cli.js";
import { DEFAULT_PSQL, psqlRows, psqlText } from "../lib/psql.js";

const lit = (s: string): string => `'${String(s ?? "").replace(/'/g, "''")}'`;

interface Dim { id: string; name: string }

function main(argv: string[]): number {
  const args = parseArgs(argv, []);
  const psql = optional(args, "psql", "how to reach the database") ?? DEFAULT_PSQL;
  const step = required(args, "step", "which skill was measured");
  const version = required(args, "version", "which version of it produced the document");
  const team = required(args, "team", "the team whose store holds the document");
  const initiative = required(args, "initiative", "the initiative slug");
  const path = required(args, "path", "the document, relative to the initiative");
  const judge = required(args, "judge", "who judged — a person, not a model, or say which model");
  const note = optional(args, "note", "one line on what this judgement turned on") ?? "";

  // `--score "<dimension name>=<1-5>"`, repeated. The NAME, not an index: a rubric's
  // dimensions are identified by name everywhere else here, and an ordinal would silently
  // re-point at a different dimension the moment a rubric gains one.
  const given = args.repeated.get("score") ?? [];
  if (!given.length) return die("no --score given; pass --score \"<dimension>=<1-5>\" once per dimension");

  const skill = psqlRows<{ id: string }>(psql,
    `select id::text as id from zz.skill where name = ${lit(step)}`);
  if (!skill.length) return die(`zz.skill has no row for ${step} — run register-skills first`);
  const sv = psqlRows<{ id: string; rubric_id: string | null }>(psql,
    `select id::text as id, rubric_id::text as rubric_id from zz.skill_version
      where skill_id = ${lit(skill[0].id)}::uuid and version = ${lit(version)}`);
  if (!sv.length) return die(`zz.skill_version has no ${step} ${version}`);

  // The rubric this version declares, or the skill's only one. A judgement whose rubric
  // cannot be named is a number with no scale behind it, so this refuses rather than guesses.
  const rubric = psqlRows<{ id: string; version: string }>(psql,
    sv[0].rubric_id
      ? `select id::text as id, version from zz.rubric where id = ${lit(sv[0].rubric_id)}::uuid`
      : `select id::text as id, version from zz.rubric where skill_id = ${lit(skill[0].id)}::uuid
          order by version::numeric desc limit 1`);
  if (!rubric.length) {
    return die(`no rubric for ${step} — write one at <skill>/evals/rubric.json and run rubric-load`);
  }
  const dims = psqlRows<Dim>(psql,
    `select id::text as id, name from zz.rubric_dimension where rubric_id = ${lit(rubric[0].id)}::uuid`);

  const marks: { dim: Dim; score: number }[] = [];
  for (const g of given) {
    const at = String(g).lastIndexOf("=");
    if (at < 1) return die(`--score must be "<dimension>=<1-5>", got: ${g}`);
    const name = String(g).slice(0, at).trim();
    const score = Number(String(g).slice(at + 1).trim());
    if (!Number.isFinite(score) || score < 1 || score > 5) {
      return die(`score for "${name}" must be between 1 and 5, got: ${String(g).slice(at + 1)}`);
    }
    // ONE DECIMAL, stored as given. The first version rounded to whole numbers because the
    // column was a smallint, and that moved one document's mean from 3.90 to 4.20 — bigger
    // than most of the differences these scores exist to detect. Migration 028 made the
    // column numeric(2,1), so the check here is exactly what the column holds: refuse
    // anything finer rather than resume the quiet rounding at a smaller scale.
    if (Math.round(score * 10) !== score * 10) {
      return die(`score for "${name}" must have at most one decimal place, got: ${score}`);
    }
    const dim = dims.find((d) => d.name === name);
    if (!dim) {
      return die(`"${name}" is not a dimension of ${step}'s rubric v${rubric[0].version}. It has:\n` +
                 dims.map((d) => `  ${d.name}`).join("\n"));
    }
    marks.push({ dim, score });
  }

  const evalId = psqlText(psql,
    `insert into zz.eval (skill_version_id, rubric_id, judge_model, selection_note, doc_count, finished_at)
     values (${lit(sv[0].id)}::uuid, ${lit(rubric[0].id)}::uuid, ${lit(judge)}, ${lit(note)}, 1, now())
     returning id::text`).split("\n")[0].trim();
  if (!evalId) return die("could not create the eval row");

  const subjectId = psqlText(psql,
    `insert into zz.eval_subject (eval_id, team_id, initiative_slug, path, skill_version_id, doc_id)
     select ${lit(evalId)}::uuid, t.id, ${lit(initiative)}, ${lit(path)}, ${lit(sv[0].id)}::uuid,
            (select d.id from zz.doc d
              where d.initiative = ${lit(initiative)} and d.path = ${lit(path)} limit 1)
       from zz.team t where t.slug = ${lit(team)}
     returning id::text`).split("\n")[0].trim();
  if (!subjectId) return die(`no team ${team} — the subject could not be recorded`);

  for (const m of marks) {
    psqlText(psql,
      `insert into zz.eval_score (eval_id, subject_id, dimension_id, score, reason, is_control)
       values (${lit(evalId)}::uuid, ${lit(subjectId)}::uuid, ${lit(m.dim.id)}::uuid,
               ${m.score}, ${lit(note)}, false)
       on conflict (eval_id, subject_id, dimension_id, is_control) do update set
         score = excluded.score, reason = excluded.reason`);
  }

  const mean = marks.reduce((n, m) => n + m.score, 0) / marks.length;
  console.log(`\n  ${step} ${version} · ${initiative}/${path}`);
  console.log(`  rubric v${rubric[0].version}, judged by ${judge}`);
  for (const m of marks) console.log(`    ${String(m.score)}  ${m.dim.name}`);
  console.log(`  mean ${mean.toFixed(2)} over ${marks.length} of ${dims.length} dimension(s)\n`);
  if (marks.length < dims.length) {
    console.log("  Not every dimension was scored. That is allowed and it is visible:");
    console.log("  a mean over some dimensions is not comparable with a mean over all of them.\n");
  }
  return 0;
}

try {
  process.exit(main(process.argv.slice(2)));
} catch (err) {
  console.error(String((err as Error)?.message ?? err));
  process.exit(2);
}
