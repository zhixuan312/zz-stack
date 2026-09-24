import { analyze, ANALYZER_NAME } from "@zz/indexing";
import { check } from "../run.ts";

check("an unspaced Han run is analysed into the terms a reader would search for", () => {
  // DELIBERATE: `as string` is load-bearing. ANALYZER_NAME is a const, so TypeScript narrows
  // it to its literal type and a direct comparison stops typechecking the moment the identity
  // is no longer v1. Widening keeps the runtime guard and lets the file compile either way.
  if ((ANALYZER_NAME as string) === "zz-lexical-v1") return "the analyzer identity was not bumped, so every derived row still reads as current";
  const a = analyze("这个迁移会破坏旧的模式");
  const base = a.base.map((t) => t.term);
  for (const want of ["迁", "移", "模", "式"]) {
    if (!base.includes(want)) return `base analysis lost ${want} from 这个迁移会破坏旧的模式`;
  }
  const bigrams = new Set(a.ranking);
  const qianyi = "zh" + [..."迁移"].map((c) => c.codePointAt(0)!.toString(16).padStart(6, "0")).join("");
  if (qianyi.length !== 14) return `the bigram codec produced ${qianyi.length} characters, not 14`;
  if (!bigrams.has(qianyi)) return "迁移 is not an adjacent-bigram ranking term, so ranking cannot prefer it";
  // Supplementary plane: iterate scalars, not UTF-16 units.
  const supp = analyze("\u{20000}\u{20001}");
  if (supp.base.length !== 2) return `a supplementary-plane pair analysed to ${supp.base.length} base terms, not 2 — UTF-16 units are being iterated`;
  // Offsets must address the original bytes.
  const src = "前migration后";
  for (const t of analyze(src).base) {
    const slice = Buffer.from(src, "utf8").subarray(t.start, t.end).toString("utf8");
    if (!slice.length) return `term ${t.term} carries a byte range that does not address its source`;
  }
});
