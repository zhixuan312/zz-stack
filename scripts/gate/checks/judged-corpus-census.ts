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

check("the judge's mark scale is declared once, and both readers of it agree", () => {
  // TWO SPELLINGS OF ONE SCALE, NEITHER READING THE OTHER. The prompt named its ends with the
  // literals `5 = ` and `1 = `; `judge-score.ts` rescaled the mean with `(qualMean - 1) / 4`.
  // A ruler on any other scale would have been PROMPTED for one range and NORMALISED against
  // another, silently, with every number downstream still looking ordinary.
  //
  // The same shape as the telemetry and the control loop naming different stages for one act,
  // and as a search excluding a superseded row on two signals while counting it on one. Each
  // half self-consistent; nothing asking whether they agree.
  const prompt = withoutComments(readFileSync(join(root, "services/zz-core/src/eval/judge.ts"), "utf8"));
  const score = withoutComments(readFileSync(join(root, "services/zz-core/src/eval/judge-score.ts"), "utf8"));
  const decl = withoutComments(readFileSync(join(root, "packages/contracts/src/bands.ts"), "utf8"));
  const m = /export const MARK_SCALE = \{ min: (\d+), max: (\d+) \}/.exec(decl);
  if (!m) return "MARK_SCALE is no longer declared in contracts, so the scale has no single home again";
  if (/\\n {4}5 = |\\n {4}1 = /.test(prompt)) {
    return "the judge's prompt spells the ends of the scale as literals instead of reading "
         + "MARK_SCALE, so the prompt and the rescale can disagree about what a mark means";
  }
  if (!/MARK_SCALE\.max/.test(prompt) || !/MARK_SCALE\.min/.test(prompt)) {
    return "the judge's prompt does not read MARK_SCALE for both ends of the scale it asks for";
  }
  // THE RESCALE EXPRESSION, NOT THE FILE. The first draft of this clause asked whether
  // `MARK_SCALE.min` appeared in `judge-score.ts` at all — and it does, inside
  // `const SPAN = MARK_SCALE.max - MARK_SCALE.min`, so putting the literal back into the
  // rescale left the check green. That is the same mistake this whole family of checks is
  // about, made while writing a check about it, and it is the second time in one session: the
  // superseded-result counter's first check tested a function body that carried the string in
  // its TYPE ANNOTATION. What decides the answer is the expression, so the expression is what
  // gets read.
  const rescale = /const qual = qualMean === null[\s\S]{0,240}?;/.exec(score)?.[0] ?? "";
  if (!rescale) return "the qualitative rescale is gone or renamed — rewrite this check rather than leave it passing on its absence";
  if (!/MARK_SCALE\.min/.test(rescale)) {
    return `the qualitative mean is rescaled from a literal lower bound — ${rescale.replace(/\s+/g, " ").slice(0, 90)} — `
         + "while the prompt that produced the mark reads the declared scale, so the two can "
         + "disagree about what a mark means with every number downstream still looking ordinary";
  }
  if (!/SPAN|MARK_SCALE\.max/.test(rescale)) {
    return "the rescale's span is a literal, so only one end of the scale is declared";
  }
  // AND THE ONE THING THIS DOES NOT FIX, asserted so nobody reads the check as more than it is.
  // The ruler's own columns are `five_means` and `one_means` — in the type, in the SQL and in
  // the table — which encodes the same two numbers a third time. Moving the scale means
  // migrating them, and this check exists partly to keep that statement true.
  if (!/five_means/.test(prompt)) {
    return "the dimension no longer carries five_means — if the scale has genuinely moved, this "
         + "check and the comment beside MARK_SCALE both need rewriting rather than passing";
  }
  return null;
});
