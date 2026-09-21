import { readFileSync } from "node:fs";
import { join } from "node:path";
import { analyzerDigestFor, OPACITY_CASES } from "@zz/indexing";
import { root } from "../read.ts";
import { check } from "../run.ts";

check("the analyzer-opacity fixture records a real run of the CURRENT analyzer", () => {
  const p = join(root, "testing/tenant-info/analyzer-opacity.golden.json");
  let g: { provenance?: Record<string, string>; cases?: Array<{ submitted: string; stored: string }> };
  try { g = JSON.parse(readFileSync(p, "utf8")); }
  catch { return "testing/tenant-info/analyzer-opacity.golden.json is missing — the opacity claim rests on nothing"; }

  const prov = g.provenance;
  if (!prov) return "the fixture carries no provenance block, so a hand-written file is indistinguishable from a real run";
  for (const k of ["generator_version", "pg_version", "pg_textsearch_version", "generated_at", "analyzer_digest"]) {
    if (!prov[k]) return `the fixture's provenance names no ${k}`;
  }
  const now = analyzerDigestFor(OPACITY_CASES);
  if (prov.analyzer_digest !== now) {
    return `the fixture was generated from analyzer output whose digest was ${prov.analyzer_digest}, but the current `
         + `analyzer emits ${now} — the fixture is stale or hand-authored, so it evidences nothing about today's analyzer`;
  }
  const cases = g.cases ?? [];
  if (cases.length !== OPACITY_CASES.length) {
    return `the fixture holds ${cases.length} cases against ${OPACITY_CASES.length} declared cases`;
  }
  const mangled = cases.filter((c) => c.submitted !== c.stored);
  if (mangled.length) {
    return `the database rewrote ${mangled.length} analyzer term(s), so a ranking term does not survive indexing: `
         + mangled.slice(0, 3).map((c) => `${c.submitted} -> ${c.stored}`).join(", ");
  }
});
