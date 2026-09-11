/**
 * A definition of good, written down once and stored the same way by everything that stores one.
 *
 * WHY THIS LEFT eval-store. Storing a rubric was a side-effect of storing an EVALUATION: the
 * only path into zz.rubric ran through `judged.json`, and eval-store refuses a run that judged
 * nothing. That is correct for the six ops-flow steps and wrong for everything else — of 41
 * registered skills, 5 produce a gated document. The other 36 could have a rubric written,
 * reviewed and shipped in the catalog and still report "no definition of good", because the
 * only door into the table was one they can never walk through.
 *
 * So the upsert lives here, and two callers use it: eval-store, which still stores a rubric
 * alongside the scores it justifies, and rubric-load, which stores one for a skill that will
 * never produce a document to score.
 *
 * BY CONTENT, NOT BY A COUNTER, and that rule is the whole reason this is a function rather
 * than an insert. Re-storing the same definition twice must not invent a second one; a
 * definition that genuinely CHANGED must not silently reuse the old one's identity, or scores
 * taken with two different rulers get averaged together and nothing says so. The dimension
 * names are the signature: same names, same ruler.
 */
import { psqlRows, psqlText } from "./psql.js";

export interface RubricFile {
  step: string;
  role?: string;
  /** What the judge is handed. The catalog has always declared this — every rubric.json
   *  carries `produces_document` and `vendored` — and nothing carried it into the database,
   *  so the judge inferred the subject from what the skill happened to leave behind. For a
   *  VENDORED file that inference is wrong in the one way that matters: its ruler asks
   *  whether the file earns its place beside the block's own tools, which no run trace can
   *  answer, and traces were all the judge could see. */
  vendored?: boolean;
  produces_document?: boolean;
  /** WHAT THIS RULER IS FOR, said outright, overriding the inference below it.
   *
   * The two flags above describe the SKILL — where it came from, whether it writes a
   * document. What a ruler judges is a different decision and the flags were being made to
   * carry it: `vendored` forced `body`, and no body round has ever cleared the collapse line,
   * because the control for a body subject is another skill's text and a decent one answers
   * the same generic questions. A ruler that cannot fail its control measures nothing.
   *
   * So a ruler may now name its subject. `trace` is the one this exists for: a vendored
   * skill's usefulness IN USE is answerable from a run and not from the file. */
  subject?: "auto" | "document" | "trace" | "body";
  dimensions: { name: string; five: string; one: string }[];
}

/** The subject a rubric file implies. `vendored` wins: a vendored skill's ruler is about the
 *  file, whatever else it does. Then the catalog's own `produces_document`. Then `auto`,
 *  which is the judge's existing behaviour — documents where they exist, traces otherwise —
 *  and the right answer for a flow stage. */
function subjectOf(r: RubricFile): "auto" | "document" | "trace" | "body" {
  // THE FILE MAY SAY, and where it does the file wins.
  //
  // Everything below this line is inference, and one of the inferences has now been measured
  // wrong. `vendored` meant "judge the text", because a vendored skill's question was taken to
  // be whether the copy earns its place beside the block's own tools. That is a real question
  // and it is unanswerable by this design: the control for a body subject is another skill's
  // text, which answers the same generic questions perfectly well, so the control cannot fail.
  // Eight body rounds across three judge configurations, not one clearing the collapse line.
  //
  // Being vendored is a fact about where a skill came from. What it should be judged ON is a
  // separate decision, and it belongs to whoever cuts the ruler.
  if (r.subject) return r.subject;
  if (r.vendored) return "body";
  if (r.produces_document === false) return "trace";
  return "auto";
}

const lit = (s: string): string => `'${String(s ?? "").replace(/'/g, "''")}'`;

/** The rubric's id for this skill, creating it if this exact set of dimensions is new.
 *  `created` is what a caller reports; it is never a reason to behave differently. */
export function upsertRubric(psql: string, skillId: string, rubric: RubricFile):
    { id: string; version: string; created: boolean } {
  const sig = rubric.dimensions.map((d) => d.name).sort().join("|");
  const found = psqlRows<{ id: string; version: string }>(psql,
    `select r.id::text as id, r.version from zz.rubric r
      where r.skill_id = ${lit(skillId)}::uuid
        and (select string_agg(name, '|' order by name) from zz.rubric_dimension where rubric_id = r.id)
            = ${lit(sig)}`);
  if (found.length) {
    // The subject is refreshed even when the dimensions are unchanged: the column arrived
    // after these rows did, so every rubric loaded before it says `auto` and would keep
    // saying so forever. It is catalog-declared config, not a measurement, so re-reading it
    // from the file changes nothing anybody has scored.
    psqlText(psql, `update zz.rubric set subject = ${lit(subjectOf(rubric))}
                     where id = ${lit(found[0].id)}::uuid`);
    return { id: found[0].id, version: found[0].version, created: false };
  }

  const prev = psqlRows<{ v: string }>(psql,
    `select coalesce(max(version::numeric), 0)::text as v from zz.rubric where skill_id = ${lit(skillId)}::uuid`);
  const version = String(Number(prev[0]?.v ?? "0") + 1);
  // psqlText, NOT psqlRows, and the difference is silent. psqlRows wraps what it is given as a
  // SUBQUERY, and Postgres allows a data-modifying statement only at the top level — so an
  // insert put through it does not error, it comes back EMPTY, which reads exactly like a row
  // that was not found. eval-store's `writing()` carries this warning because it cost that tool
  // two runs of 30 subjects and 0 scores; moving the upsert here re-earned it in one.
  const id = psqlText(psql,
    `insert into zz.rubric (skill_id, version, subject)
     values (${lit(skillId)}::uuid, ${lit(version)}, ${lit(subjectOf(rubric))})
     returning id::text`).split("\n")[0].trim();
  if (!id) throw new Error(`could not create a rubric row for skill ${skillId}`);
  for (const [i, d] of rubric.dimensions.entries()) {
    psqlText(psql, `insert into zz.rubric_dimension (rubric_id, name, five_means, one_means, ordinal)
                    values (${lit(id)}::uuid, ${lit(d.name)}, ${lit(d.five)}, ${lit(d.one)}, ${i})
                    on conflict (rubric_id, name) do nothing`);
  }
  return { id, version, created: true };
}

/** What a rubric file has to say before it counts as a definition of good.
 *  Returns the reason it does not, or null. */
export function whyNotARubric(raw: unknown): string | null {
  const r = raw as Partial<RubricFile> | null;
  if (!r || typeof r !== "object") return "is not a JSON object";
  if (!Array.isArray(r.dimensions) || !r.dimensions.length) return "names no dimensions";
  for (const [i, d] of r.dimensions.entries()) {
    if (!d || typeof d.name !== "string" || !d.name.trim()) return `dimension ${i} has no name`;
    // BOTH ANCHORS, ALWAYS. A dimension with only the five is a wish, not a ruler: a judge
    // handed "excellent means X" and nothing for the bottom has to invent the scale it is
    // scoring against, and two runs then disagree for reasons no one can read.
    if (typeof d.five !== "string" || !d.five.trim()) return `dimension "${d.name}" has no five`;
    if (typeof d.one !== "string" || !d.one.trim()) return `dimension "${d.name}" has no one`;
  }
  return null;
}
