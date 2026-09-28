#!/usr/bin/env node
/**
 * A knowledge node is read from the shelf it is on — its `team_id`, and nothing else.
 *
 * The defect this pins: `document_read` resolved `_knowledge/nodes/<ordinal>-<slug>.md` only
 * inside its `scope === "platform"` branch and always against `KNOWLEDGE_TEAM`. A node on a
 * team's own shelf therefore fell through to the document read — which looks for a `doc` row that
 * a node has never had — and the refusal sent the caller to `scope: "platform"`, which answered
 * "does not exist on the platform shelf". Two refusals for a node `knowledge_search` had just
 * returned with `shelf: "team"`, and 877 of those were in production.
 *
 * The addressing lives in `services/zz-core/src/tools/journal.ts` and this reads it there; the
 * two document tools reach it by calling it, which is the second half of the evidence — a rule
 * held in a module nothing calls protects nothing.
 *
 * Asserts the SHAPE, because the behaviour needs a database and an authenticated caller.
 */
import { readFileSync } from "node:fs";

const fail: string[] = [];
const is = (ok: unknown, why: string) => { if (!ok) fail.push(why); };

const src = readFileSync("services/zz-core/src/tools/artifacts.ts", "utf8");
const journal = readFileSync("services/zz-core/src/tools/journal.ts", "utf8");

// 1. The address is parsed once, and the shelf is chosen by `scope` — never by the path alone.
is(/export function journalOrdinal/.test(journal),
   "the journal module does not parse a node address — `_knowledge/nodes/…` is resolved as a document");
is(!/if \(scope === "platform"\)/.test(journal),
   "resolving a node is conditional on `scope === \"platform\"` again — a team-shelf node is unreadable");
const shelf = /const shelf = ([^;]+);/.exec(journal)?.[1] ?? "";
is(/scope === "platform"/.test(shelf) && /\bteam\b/.test(shelf),
   `the shelf read is not chosen by \`scope\` (got: ${shelf || "nothing"}) — one shelf would answer for every caller`);

// 2. The refusal names the shelf it read, and points at the other one only when a node is there.
is(/does not exist on your team's shelf/.test(journal),
   "an absent node is not refused by naming the caller's own shelf");
const otherAt = journal.indexOf("if (!scope && team)");
is(otherAt > 0 && /scope: "platform"/.test(journal.slice(otherAt, otherAt + 900)),
   "the second-shelf hint is gone — a caller whose node is on the platform shelf cannot be told");

// 3. Both halves reach the same table, so what the store lists is what it can read.
is(/from zz\.knowledge_node k/.test(journal),
   "the journal does not read zz.knowledge_node — a node the search returned cannot be served");
is(/`_knowledge\/nodes\/\$\{n\.node_ordinal\}-\$\{n\.slug\}\.md`/.test(journal),
   "the journal's addresses are not built, so what the listing shows cannot be read back by path");

// 4. The two tools call it: the read serves a node, the listing shows the shelf's nodes.
is(/await readJournalNode\(p, \{ rel, ordinal, team, scope \}\)/.test(src),
   "document_read does not resolve a node through the journal — a `_knowledge/nodes/…` path is read as a document");
is(/await listJournalNodes\(p, team, base \?\? ""\)/.test(src),
   "document_list does not list the journal — `document_list(prefix: \"_knowledge\")` answers []");

if (fail.length) {
  console.error(`knowledge-shelf-read: ${fail.length} failure(s)`);
  for (const f of fail) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("ok knowledge-shelf-read");
