/**
 * Every parameter the search predicate binds is one its SQL references.
 *
 * `put()` appends to the bound array as a side effect of being called, so a fragment built
 * with `put(clause.text)` and then thrown away leaves the builder binding `$2` while
 * referencing `$1` and `$3`. PostgreSQL then refuses to parse the statement at all: `could not
 * determine data type of parameter $2`.
 *
 * COUPLED: `legacy-han-retrieval` and `text-search-config-agreement` read the predicate's text
 * — does it contain this substring, does it name that configuration — and a statement can
 * satisfy every such assertion while being unparseable. This check asks the relationship
 * between the two halves instead, and needs no database: the set of numbers the SQL references
 * must be exactly 1..args.length.
 *
 * Runs the builder against `dist` rather than reading it: a service's relative imports carry
 * the `.js` suffix NodeNext wants, which resolve only there. A probe that cannot run is
 * reported as that, never as a failure of the thing it was probing.
 */
import { execFileSync } from "node:child_process";
import { join } from "node:path";

import { root } from "../read.ts";
import { check } from "../run.ts";

check("every parameter the search predicate binds is one its SQL references", () => {
  const probe = `
    import { buildSearchPredicate } from ${JSON.stringify(join(root, "services/zz-core/dist/tools/search-predicate.js"))};
    const bad = [];
    // One per clause kind the grammar produces, in both scripts, and the combinations that
    // mix them — each one exercised BOTH as the exact attempt and as the broadening retry,
    // because the two take different arms and only one of them was ever wrong.
    const queries = [
      "migration", "migration schema rollback", '"old schema"', "migration -testing",
      "migration OR schema", "\\u8fc1\\u79fb", "\\u8fc1\\u79fb migration",
      '"\\u5ba1\\u6279\\u6d41\\u7a0b" -\\u6d4b\\u8bd5 \\u8fc1\\u79fb', "\\u8fc1\\u79fb OR migration",
    ];
    for (const query of queries) {
      for (const broadened of [false, true]) {
        const p = buildSearchPredicate({ query, team: "t", broadened, tags: ["x"], type: "decision" });
        const referenced = [...new Set([...p.sql.matchAll(/\\\$(\\d+)/g)].map((m) => Number(m[1])))].sort((a, b) => a - b);
        const want = p.args.map((_, i) => i + 1);
        if (referenced.length !== want.length || referenced.some((n, i) => n !== want[i])) {
          bad.push(JSON.stringify(query) + (broadened ? " (broadened)" : " (exact)") +
            ": binds " + p.args.length + " parameter(s) but references $" + (referenced.join(", $") || "none") +
            " - PostgreSQL cannot parse a statement whose numbering skips one, so this query answers nothing");
        }
      }
    }
    process.stdout.write(bad.join("; "));
  `;
  try {
    return execFileSync(process.execPath, ["--input-type=module", "-e", probe],
      { encoding: "utf8", cwd: root }).trim() || undefined;
  } catch (err) {
    const e = err as { stderr?: Buffer | string; message?: string };
    return `the search-predicate parameter probe could not be run: ${String(e.stderr ?? e.message ?? err).slice(-300)}`;
  }
});
