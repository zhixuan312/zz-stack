#!/usr/bin/env node
// Three relations were stored as text on this table: the shelf as a slug, the successor as a bare
// ordinal resolved by LIKE, and the evidence as initiative slugs — of which 58 point at another
// team's shelf and one is ambiguous, because a slug is team-scoped and an identity is not. `path`
// held two facts in one column, and the spec's Data model splits it. What this asserts is that no
// statement names the retired columns and that each replacement has a writer. A name-scan over
// prose would be a check that cannot pass, so it reads statement literals only.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const retired = ["team_slug", "path", "superseded_by", "evidence"];
const files = execFileSync("git", ["ls-files", "services", "packages"], { encoding: "utf8" })
  .split("\n").filter((f) => f.endsWith(".ts") && !f.includes("/dist/"));

/** Every string a lexer would call one, whatever quote opens it and with escapes honoured.
 *
 *  DELIBERATE: a walk, not a regex that pairs quotes. The regex this replaced could pair a quote
 *  inside one statement with one inside the NEXT: a template whose SQL carries a quote before its
 *  `from` — `to_char(ts at time zone 'UTC')` is one — cannot close on its own backtick, because the
 *  match refuses to cross a quote, so the engine pairs it with a later statement's backtick and
 *  reads every line between them as one statement. Anything in between that spells a retired
 *  column's name — a response field, a comment — is then reported as named by that SQL. This check
 *  said exactly that about console/knowledge.ts on a change that named no such column, which is
 *  what a check that reports the wrong thing costs.
 *
 *  A `${…}` inside a template is not walked into: `check:sql` refuses a statement built at runtime
 *  anywhere in this repository, so a SQL template here holds no hole to step through. */
function literals(src: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < src.length; i++) {
    const q = src[i];
    if (q !== '"' && q !== "'" && q !== "`") continue;
    let j = i + 1;
    for (; j < src.length; j++) {
      if (src[j] === "\\") { j++; continue; }
      if (src[j] === q) break;
      if (q !== "`" && src[j] === "\n") break;   // an unterminated single-line string ends the run
    }
    out.push(src.slice(i + 1, Math.min(j, src.length)));
    i = j;
  }
  return out;
}

/** The literals that are SQL, by the same heads the gate's own scanners look for. */
const sqlLiterals = (src: string): string[] =>
  literals(src).filter((s) => /\b(?:select\s[\s\S]*?\bfrom\b|insert\s+into\b|update\s+[a-z_.]+\s+set\b|delete\s+from\b)/i.test(s));

const hits: string[] = [];
for (const f of files) {
  for (const sql of sqlLiterals(readFileSync(f, "utf8"))) {
    // A bare name is a node column only when the statement binds the node table.
    if (!/\bknowledge_node\b/i.test(sql)) continue;
    for (const c of retired) {
      if (new RegExp(`(?:^|[\\s,.(])${c}\\b`, "i").test(sql)) hits.push(`${f}: knowledge_node.${c} in a statement`);
    }
  }
}
assert.deepEqual(hits, [], "no statement names a column the reshape retired");

// Each replacement has a writer, or the reshape is a rename that wrote nothing. The writer is
// `packages/indexing/src/index.ts` — `indexNode`/`supersedeNode`, the one pair that writes a
// knowledge node now that `indexDoc` is gone with the file store.
const indexer = readFileSync("packages/indexing/src/index.ts", "utf8");
for (const [what, re] of [["team_id", /team_id/], ["node_ordinal", /node_ordinal|nodeOrdinal/],
                          ["slug", /slug/], ["superseded_by_id", /superseded_by_id|supersededById/]] as const) {
  assert.ok(re.test(indexer), `the node writer names ${what}`);
}
assert.ok(/knowledge_node_evidence/.test(indexer), "the node writer writes the evidence relation");
assert.ok(/knowledge_node_evidence/.test(readFileSync("services/zz-core/src/tools/knowledge-search.ts", "utf8")),
  "the neighbour lane reads it");

console.log("ok knowledge-node-ids");
