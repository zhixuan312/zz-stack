import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { root } from "../read.ts";
import { check } from "../run.ts";

function execStderr(err: unknown): string {
  const e = err as { stderr?: Buffer | string; message?: string };
  return String(e.stderr ?? e.message ?? err);
}

check("the legacy handler builds a predicate that can match a term inside an unspaced Han run", () => {
  // DELIBERATE: runs the builder in a spawned probe rather than importing it. A service's
  // source cannot be imported from here — its relative imports carry the `.js` suffix
  // NodeNext wants, which resolves only in `dist`. A probe that cannot run is reported as
  // that, never as a failure of the thing it was probing.
  const probe = `
    import { buildSearchPredicate } from ${JSON.stringify(join(root, "services/zz-core/dist/tools/search-predicate.js"))};
    const bad = [];
    const p = buildSearchPredicate({ query: "迁移" });
    if (/websearch_to_tsquery\\('english'/.test(p.sql)) {
      bad.push("the handler still pins the english text-search configuration for a Han clause, which reduces 这个迁移会破坏旧的模式 to a single token - 迁移 cannot match inside it");
    }
    if (!p.terms.includes("迁")) bad.push("the Han query was not analysed into base terms");
    const hard = buildSearchPredicate({ query: '"审批流程" -测试 迁移', broadened: true });
    if (!hard.sql.includes("审批流程")) bad.push("broadening dropped the quoted phrase");
    if (!hard.excluded.includes("测试")) bad.push("broadening dropped the exclusion");
    if (!hard.sql.includes("team_slug")) bad.push("broadening dropped the team scope predicate");
    process.stdout.write(bad.join("; "));
  `;
  try {
    const out = execFileSync("node", ["--input-type=module", "-e", probe], { encoding: "utf8" });
    return out.trim() || undefined;
  } catch (err) {
    return `the search-predicate builder could not be run: ${execStderr(err).slice(-200)}`;
  }
});
