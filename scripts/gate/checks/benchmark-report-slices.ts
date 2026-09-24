import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { evaluateTargets } from "../../tenant-info/benchmark.ts";
import { root } from "../read.ts";
import { check, note } from "../run.ts";

check("a benchmark report proves each language slice separately or leaves its target blocked", () => {
  const blocked = evaluateTargets({});
  if (blocked.passed) return "an empty measurement set evaluated to a pass; absence must be blocked, never zero";

  const p = join(root, "testing/tenant-info/benchmark-report.json");
  if (!existsSync(p)) {
    // DELIBERATE: absence notes rather than fails. The title's second half — "or leaves its
    // target blocked" — is the satisfied one here, and the clause above has already proved
    // that an empty measurement set does not evaluate to a pass. The note is what tells a
    // reader of a green gate that the eleven clauses below did not run.
    //
    // The report cannot be produced in this checkout: benchmark-measure-run.ts needs a live
    // database, a workspace, and two runtime facts only the serving process can supply.
    note("    benchmark-report-slices: no benchmark report on disk, so the per-slice clauses " +
         "below did not run. Their target stays blocked, which is not a pass.");
    return;
  }
  const r = JSON.parse(readFileSync(p, "utf8"));
  const want: Record<string, number> = { en: 58, zh: 20, mixed: 20 };
  for (const [lang, denom] of Object.entries(want)) {
    const s = r.slices?.[lang];
    if (!s) return `the report carries no ${lang} slice; a per-language target cannot be met by an aggregate`;
    if (!s.denominator) return `the ${lang} slice has no denominator`;
    if (s.denominator !== denom) return `the ${lang} slice reports denominator ${s.denominator}, not the measured ${denom}`;
    if (typeof s.recall_at_20 !== "number") return `the ${lang} slice reports no recall_at_20`;
    if (s.recall_at_20 < 0.95) return `the ${lang} slice is ${s.recall_at_20} against a 0.95 target (n=${denom}: one miss is ${(1 - 1 / denom).toFixed(3)})`;
  }
  if (r.pooled) return "slices were pooled; a failing slice cannot pass by aggregation";
  if (r.route !== "public_handler") return `the report measured via ${r.route}, not the real public handler and serializer`;
});
