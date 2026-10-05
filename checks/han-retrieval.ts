#!/usr/bin/env node
// Chinese retrieval is the half of AC-4.2 a schema cannot prove. The old path matches Han as a
// literal substring, which works and is sequential; the trigram index I-33 adds is what makes it an
// index scan, and whether the query reaches that index is a property of the DATABASE rather than of
// the source. This asserts the source's decision, and says plainly that the database half is
// `scripts/gate/checks/text-search-config-agreement.ts`'s — which is why that check is re-pointed here instead
// of this one claiming a plan it never runs.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync("services/zz-core/src/tools/search-predicate.ts", "utf8");

// The Han clause is still a substring match — not narrowed to an equality a trigram index cannot serve.
assert.ok(/ILIKE|like/i.test(src), "the Han clause is still a substring match");
assert.ok(/HAN_SCALAR_RE|HAN_SQL_CLASS/.test(src), "the predicate still knows what Han is");

// The half nothing reads is a decision, not an oversight: either the read path ranks through it,
// or the writer stopped filling it. One of the two must be visible here.
const search = readFileSync("services/zz-core/src/tools/knowledge-search.ts", "utf8");
const analysis = readFileSync("packages/indexing/src/tenant-analysis.ts", "utf8");
// Comments stripped: `simple` appears in that file's prose at four places, so reading it raw
// would let either branch turn on a comment rather than on the writer.
const code = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const ranked = /simple/i.test(code(search)) && /QUERY_CONFIG/.test(code(search));
const stopped = !/simple/i.test(code(analysis));
assert.ok(ranked || stopped,
  "the Han half of body_tsv is either read or no longer written — a write-only half is the defect");

// The database half has a home, and it survived the layer's removal.
//
// Asserted on what the file IS, not on its size. `readFileSync(...).length > 0` is satisfied by a
// stub: emptying its checks out and leaving a file with a comment in it kept this green while the
// thing it names — a check that the query and the write path agree on a configuration — was gone.
// These are its two halves, one per lane, by the names it registers them under.
const agreement = readFileSync("scripts/gate/checks/text-search-config-agreement.ts", "utf8");
assert.ok((agreement.match(/^check\(/gm) ?? []).length >= 4,
  "the config-agreement check is re-pointed, not deleted — it registers fewer checks than the four it is for");
assert.ok(/stored a latin term through/.test(agreement) && /Han clause through/.test(agreement),
  "the config-agreement check no longer names either lane — one of the two configurations it exists to hold together is gone from it");

console.log("ok han-retrieval");
