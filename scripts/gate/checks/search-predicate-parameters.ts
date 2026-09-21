/**
 * Every parameter the search predicate BINDS is one its SQL REFERENCES.
 *
 * WHAT THIS CATCHES, and it had already happened. `put()` appends to the bound array as a
 * side effect of being called. An ASCII fragment was built with `put(clause.text)` and then
 * thrown away, because that clause goes down the `asciiRaw` path instead — so the builder
 * bound `$2`, referenced `$1` and `$3`, and PostgreSQL refused to parse the statement at all:
 * `could not determine data type of parameter $2`, for EVERY ascii query, which is every
 * query this platform actually receives. `knowledge_search` was one call away from answering
 * nothing to anybody.
 *
 * WHY THE TWO EXISTING CHECKS DID NOT SEE IT. `legacy-han-retrieval` and
 * `text-search-config-agreement` both read the predicate's TEXT — does it contain this
 * substring, does it name that configuration — and a statement can satisfy every assertion
 * about what its text contains while being unparseable. Neither executes a predicate, and
 * neither counts what it bound. This check asks the one question that is about the
 * relationship between the two halves, and it needs no database to ask it: the set of numbers
 * the SQL references must be exactly 1..args.length.
 *
 * RUNS the builder against `dist` rather than reading it: a service's own relative imports
 * carry the `.js` suffix NodeNext wants, which resolve only there. A probe that cannot run is
 * reported as that, never as a failure of the thing it was probing.
 */
import { execFileSync } from "node:child_process";
import { join } from "node:path";

import { root } from "../read.ts";
import { check } from "../run.ts";

check("every parameter the search predicate binds is one its SQL references", () => {
  const probe = `
    import { buildSearchPredicate } from ${JSON.stringify(join(root, "services/zz-core/dist/tools/knowledge-search.js"))};
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
