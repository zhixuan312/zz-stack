import { lanesFor } from "@zz/indexing";
import { check } from "../run.ts";

check("native lanes keep their own applicability and grow no tag lane", () => {
  const names = (q: string) => lanesFor(q).map((l) => l.name);
  const han = names("这个迁移会破坏旧的模式");
  if (!han.includes("bm25")) return "Chinese prose does not reach the BM25 lane";
  if (han.includes("tag")) return "a tag lane was reintroduced; tags are filters and tie-breaks";
  if (han.includes("fuzzy")) return "Chinese prose reached the fuzzy identifier lane, which indexes identifiers and not bodies";
  const ident = names("primary_evidence-000037.txt");
  if (!ident.includes("exact")) return "an exact identifier does not reach the exact lane";
  for (const l of lanesFor("迁移")) {
    if (l.applicability === undefined) return `lane ${l.name} declares no applicability rule`;
  }
});
