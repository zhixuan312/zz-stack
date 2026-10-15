#!/usr/bin/env node
/**
 * checks/words.ts — how a body's words are counted, and the one pace every writing estimate is made at
 * (AC-2.10, AC-5.4).
 *
 *   node checks/words.ts   # needs a built tree (`npm run build`)
 *
 * It calls the contracts' own built `countWords`, `writingEstimate` and `WORDS_PER_HOUR` over written
 * cases. What it establishes:
 *
 *   - a text's words are its maximal runs of non-whitespace: composed and decomposed forms count alike,
 *     Markdown marks and URLs are words, a run of Chinese characters is one word and an ideographic
 *     space separates two, and the envelope never counts;
 *   - an estimate divides its words by WORDS_PER_HOUR, 500, and carries its basis, its words, the pace,
 *     the hours and the coverage it was given; a missing word count is never turned into hours;
 *   - the pace is one constant: the built module with only that constant changed makes every estimate at
 *     the new pace, and the source names the value nowhere else.
 *
 * DELIBERATE: every non-ASCII character below is written as an escape, so this file stays plain English.
 *
 * Exit 0: every case held — one line per case, then the final line.
 * Exit 1: a case failed — the case and what was found.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { root } from "../scripts/deployment.ts";

type Coverage = Record<"documents" | "revisions" | "importMade" | "unrecorded" | "mixed" | "datedByLastWrite" | "undated" | "missingLegacy", number>;
type Estimate = { basis: string; words: number | null; assumedWordsPerHour: number; hours: number | null; coverage: Coverage };
interface Words {
  WORDS_PER_HOUR: number;
  countWords: (text: string) => number;
  writingEstimate: (words: number | null, basis: "retained_stock" | "period_net_additions", coverage: Coverage) => Estimate;
}

const NAME = "words";
const DIST = join(root, "packages", "contracts", "dist");
const W = (await import(pathToFileURL(join(DIST, "index.js")).href)) as Words;

let failed = false;
function expect(step: string, ok: boolean, found: unknown): void {
  if (ok) return;
  console.error(`${NAME}: FAILED at "${step}": found ${JSON.stringify(found)}`);
  failed = true;
}
const pass = (step: string): void => { if (!failed) console.log(`  ${step}: ok`); };

// The words of a text.
const counts: [string, string, number][] = [
  ["plain words", "one two  three\n\tfour", 4],
  ["nothing at all", "", 0],
  ["only whitespace", " \n\t \u00a0 ", 0],
  ["a composed form", "caf\u00e9 au lait", 3],
  ["the same text decomposed", "cafe\u0301 au lait", 3],
  ["Markdown marks", "# Title\n\n- **bold** item\n\n```ts\nconst x = 1;\n```", 11],
  ["a link and a bare URL", "see [the guide](https://example.test/a?b=c) or https://example.test/x#y", 5],
  ["a run of Chinese characters", "\u4e2d\u6587\u5199\u4f5c", 1],
  ["Chinese characters an ideographic space apart", "\u4e2d\u6587\u3000\u5199\u4f5c", 2],
  ["Chinese beside Latin", "\u4e2d\u6587 words \u5199\u4f5c", 3],
  ["a document with its envelope", "---\nflow: sdlc-flow\ntype: spec\nstatus: draft\n---\n\nHello world\n", 2],
  ["an envelope and nothing else", "---\nflow: sdlc-flow\nstatus: draft\n---\n", 0],
];
for (const [step, text, n] of counts) expect(step, W.countWords(text) === n, { text, words: W.countWords(text), expected: n });
expect("composed and decomposed count alike", W.countWords("cafe\u0301 nai\u0308ve") === W.countWords("caf\u00e9 na\u00efve"),
  [W.countWords("cafe\u0301 nai\u0308ve"), W.countWords("caf\u00e9 na\u00efve")]);
pass("words are maximal runs of non-whitespace in NFC: composed and decomposed alike, Markdown and URLs words, a run of " +
     "Chinese one word, and the envelope never counts");

// The estimate.
const COVERAGE: Coverage = { documents: 4, revisions: 9, importMade: 1, unrecorded: 1, mixed: 1, datedByLastWrite: 1, undated: 0, missingLegacy: 2 };
expect("the pace", W.WORDS_PER_HOUR === 500, W.WORDS_PER_HOUR);
for (const basis of ["retained_stock", "period_net_additions"] as const) {
  const e = W.writingEstimate(7000, basis, COVERAGE);
  expect(`an estimate on ${basis}`, JSON.stringify(e) === JSON.stringify({ basis, words: 7000, assumedWordsPerHour: 500, hours: 14, coverage: COVERAGE }), e);
  const none = W.writingEstimate(null, basis, COVERAGE);
  expect(`no words on ${basis}`, none.words === null && none.hours === null && none.assumedWordsPerHour === 500 && none.coverage === COVERAGE, none);
}
expect("zero words is zero hours", W.writingEstimate(0, "period_net_additions", COVERAGE).hours === 0, W.writingEstimate(0, "period_net_additions", COVERAGE));
pass("an estimate divides by WORDS_PER_HOUR (500) and carries its basis, words, pace, hours and coverage; no words is no hours");

// One constant: the built module, that constant alone changed, estimates everything at the new pace.
const built = readFileSync(join(DIST, "words.js"), "utf8");
const declared = built.match(/WORDS_PER_HOUR = 500;/g)?.length ?? 0;
expect("the built module declares the pace once", declared === 1, declared);
const src = readFileSync(join(root, "packages", "contracts", "src", "words.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
expect("the source names 500 once, in the constant", (src.match(/\b500\b/g)?.length ?? 0) === 1, src.match(/.*\b500\b.*/g));
const dir = mkdtempSync(join(tmpdir(), "zz-words-"));
try {
  const changed = built.replace("WORDS_PER_HOUR = 500;", "WORDS_PER_HOUR = 250;")
    .replace('from "./index.js"', `from ${JSON.stringify(pathToFileURL(join(DIST, "index.js")).href)}`);
  writeFileSync(join(dir, "words.mjs"), changed);
  const V = (await import(pathToFileURL(join(dir, "words.mjs")).href)) as Words;
  for (const basis of ["retained_stock", "period_net_additions"] as const) {
    const e = V.writingEstimate(7000, basis, COVERAGE);
    expect(`at another pace on ${basis}`, e.assumedWordsPerHour === 250 && e.hours === 28 && e.words === 7000 && e.basis === basis, e);
  }
  expect("the count is unchanged by the pace", V.countWords("---\nflow: x\n---\n\nHello world") === 2, V.countWords("---\nflow: x\n---\n\nHello world"));
} finally {
  rmSync(dir, { recursive: true, force: true });
}
pass("the pace is one constant: the module with it changed to 250 states 250 and doubles every estimate's hours");

if (failed) process.exit(1);
console.log("words: a body's words are its runs of non-whitespace in NFC with the envelope left out, and every estimate is " +
            "its words over the one pace, WORDS_PER_HOUR, carrying its basis and coverage: ok");
