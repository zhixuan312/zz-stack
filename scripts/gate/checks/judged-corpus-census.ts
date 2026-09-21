import { readFileSync } from "node:fs";
import { join } from "node:path";
import { root } from "../read.ts";
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
