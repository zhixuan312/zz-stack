import { readFileSync } from "node:fs";
import { join } from "node:path";
import { root, withoutComments } from "../read.ts";
import { check } from "../run.ts";

check("the judged corpus still has the census every retrieval target is measured against", () => {
  const load = (n: string) => readFileSync(join(root, "testing/tenant-info", n), "utf8")
    .split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
  const q = load("queries.jsonl"), r = load("qrels.jsonl");
  if (q.length !== 600) return `queries.jsonl holds ${q.length} cases, not 600`;
  const ids = new Set(q.map((x) => x.id));
  if (ids.size !== 600) return `queries.jsonl holds ${ids.size} distinct ids, not 600`;
  const orphan = r.find((x) => !ids.has(x.query_id));
  if (orphan) return `qrels names query ${String(orphan.query_id)}, which queries.jsonl does not`;
  const eligible = q.filter((x) => x.split === "held-out" && x.answerable === true
                                   && x.category !== "isolation");
  const want: Record<string, number> = { en: 58, zh: 20, mixed: 20 };
  for (const [lang, n] of Object.entries(want)) {
    const got = eligible.filter((x) => x.language === lang).length;
    if (got !== n) {
      return `the held-out answerable ${lang} slice holds ${got} queries, not ${n} — `
           + `every per-language Recall@20 denominator moved, so the 0.95 targets no longer `
           + `mean what they were set to mean`;
    }
  }
});

check("the judge's mark scale is declared once, and the rescale reads it", () => {
  // `judge-score.ts` turns the mean of a historic round's marks into a score out of ten. Those marks
  // were given on the scale MARK_SCALE declares, so a rescale with a literal bound would normalise
  // them against a range they were never given on, silently, with every number downstream still
  // looking ordinary.
  const score = withoutComments(readFileSync(join(root, "services/zz-core/src/eval/judge-score.ts"), "utf8"));
  const decl = withoutComments(readFileSync(join(root, "packages/contracts/src/bands.ts"), "utf8"));
  if (!/export const MARK_SCALE = \{ min: (\d+), max: (\d+) \}/.test(decl)) {
    return "MARK_SCALE is no longer declared in contracts, so the scale has no single home again";
  }
  // The rescale expression, not the file. Asking whether `MARK_SCALE.min` appears in
  // `judge-score.ts` at all passes on `const SPAN = MARK_SCALE.max - MARK_SCALE.min`, leaving the
  // check green with the literal back in the rescale. What decides the answer is the expression, so
  // the expression is what gets read.
  const rescale = /const qual = qualMean === null[\s\S]{0,240}?;/.exec(score)?.[0] ?? "";
  if (!rescale) return "the qualitative rescale is gone or renamed — rewrite this check rather than leave it passing on its absence";
  if (!/MARK_SCALE\.min/.test(rescale)) {
    return `the qualitative mean is rescaled from a literal lower bound — ${rescale.replace(/\s+/g, " ").slice(0, 90)} — `
         + "while the marks it rescales were given on the declared scale, so the two can "
         + "disagree about what a mark means with every number downstream still looking ordinary";
  }
  if (!/SPAN|MARK_SCALE\.max/.test(rescale)) {
    return "the rescale's span is a literal, so only one end of the scale is declared";
  }
  return null;
});
