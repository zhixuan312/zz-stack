#!/usr/bin/env node
/**
 * A document's body survives a read and a write unchanged: `documentBody` returns what the author
 * wrote, without the blank lines that separate it from the envelope.
 *
 * The envelope and the body are joined by a blank line when a document is stamped and again when
 * a stored revision is recomposed for a reader. Left on the body, that separator came back on
 * every read and went into the store on every write that started from one, so each patch or
 * revise grew the body's leading blank lines by one — every current body in production started
 * with one, 135 revisions with three or more — and an edit's line numbers were off by as many
 * (the Phase 0 skeleton of 2026-10-06-doc-write-and-update-paradigm read lines 6 and 8 for text
 * on lines 3 and 5).
 *
 * Run: node checks/document-body-roundtrip.ts   (after npm run build; also run by scripts/gate.ts)
 */
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const { documentBody } = await import(pathToFileURL(join(process.cwd(), "packages/contracts/dist/index.js")).href);
const fail: string[] = [];
const is = (cond: unknown, why: string) => { if (!cond) fail.push(why); };

const ENV = "---\ntitle: Notes\nversion: 1\n---\n";
const BODY = "# Notes\n\nalpha line\n\n\nbeta line\n";

is(documentBody(`${ENV}${BODY}`) === BODY, "a body directly under the envelope is not returned as written");
is(documentBody(`${ENV}\n${BODY}`) === BODY, "the stamping separator stays on the body");
is(documentBody(`${ENV}\n\n\n${BODY}`) === BODY, "several separating blank lines stay on the body");
is(documentBody(BODY) === BODY, "a body with no envelope is changed");
is(documentBody(`\n\n${BODY}`) === `\n\n${BODY}`, "leading lines of a text with no envelope are taken as a separator");

// The round trip a patch makes: stamp, store the body, recompose for a reader, edit what was read.
let text = `${ENV}\n${BODY}`;
for (let i = 0; i < 3; i++) text = `${ENV}\n${documentBody(text)}`;
is(documentBody(text) === BODY, `three read-and-write round trips changed the body: ${JSON.stringify(documentBody(text).slice(0, 12))}`);

const lines = documentBody(`${ENV}\n${BODY}`).split("\n");
is(lines[2] === "alpha line" && lines[5] === "beta line",
   "line 3 of what the author wrote is not line 3 of the body an edit counts in");

if (fail.length) {
  console.error(`document-body-roundtrip: ${fail.length} failure(s)\n  - ${fail.join("\n  - ")}`);
  process.exit(1);
}
console.log("document-body-roundtrip: the body is what the author wrote, through any number of reads and writes");
