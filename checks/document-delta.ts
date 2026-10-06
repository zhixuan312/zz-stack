#!/usr/bin/env node
/**
 * The change set between two snapshots (`deltaOf`, services/zz-core/src/document-delta.ts): a table
 * of baseline/target pairs and the exact records each gives — a new section, a deleted one with its
 * extent, a rename, a reorder, a section moved under a renamed parent, two sections with one title,
 * preamble and trailing text, blank lines between sections, each metadata field, a fenced block
 * holding `#` lines, a CRLF body and a body with no headings — then the full fallback at its exact
 * boundary, and that every body byte is accounted for: one character inserted or deleted anywhere
 * in any body of the table gives at least one record, and a snapshot against itself gives none.
 * Run: node checks/document-delta.ts   (also run by scripts/gate.ts; needs `npm run build`)
 */
import { deepStrictEqual } from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const { deltaOf } = await import(pathToFileURL(join(process.cwd(), "services/zz-core/dist/document-delta.js")).href);

type Snap = { body: string; title: string; tags: string[]; stakeholder: string; fields: Record<string, string> };
const fail: string[] = [];

/** A paragraph long enough that a delta of a few records is shorter than the document. */
const F = Array.from({ length: 40 }, (_, i) => `word${i}`).join(" ") + ".";
/** A section: its heading line, a blank line, one paragraph, a line break. */
const sec = (h: string, w: string): string => `${h}\n\n${w} ${F}\n`;
/** A body: sections separated by one blank line, ending in one line break. */
const doc = (...parts: string[]): string => parts.join("\n");
const snap = (body: string, meta: Partial<Snap> = {}): Snap =>
  ({ body, title: "T", tags: [], stakeholder: "", fields: {}, ...meta });

/** `deltaOf(was, now)` gives exactly `want`: these records, or the full fallback. */
function records(why: string, was: Snap | string, now: Snap | string, want: unknown[] | "full"): void {
  const a = typeof was === "string" ? snap(was) : was;
  const b = typeof now === "string" ? snap(now) : now;
  const got = deltaOf(a, b);
  try {
    deepStrictEqual(got.kind === "delta" ? got.records : got.kind, want);
  } catch {
    fail.push(`${why}: ${JSON.stringify(got.kind === "delta" ? got.records : got)}`);
  }
}

const A = sec("## A", "a"), B = sec("## B", "b"), C = sec("## C", "c"), D = sec("## D", "d");
const bodies: string[] = [];
const pair = (was: string, now: string): [string, string] => { bodies.push(was, now); return [was, now]; };

// A snapshot against itself.
records("identical snapshots give no record", ...pair(doc(A, B), doc(A, B)), []);
{
  const got = deltaOf(snap(doc(A, B)), snap(doc(A, B)));
  if (got.kind !== "delta" || got.text !== "") fail.push(`identical snapshots: ${JSON.stringify(got)}`);
}

// New and deleted.
records("a new section is added at its position", ...pair(doc(A, B), doc(A, B, C)),
  [{ kind: "added", heading: "## C", at: 3 }]);
const gone = sec("## Gone", "gone");
records("a deleted section is removed with its old position and extent", ...pair(doc(A, gone, C), doc(A, C)),
  [{ kind: "removed", heading: "## Gone", from: 2, lines: 4, chars: "## Gone\n\ngone ".length + F.length + 2 }]);

// Renamed, reordered, moved.
records("a heading renamed over the same body is a rename, not an edit", ...pair(doc(A, sec("## Old", "same"), C),
  doc(A, sec("## New", "same"), C)), [{ kind: "renamed", from: "## Old", to: "## New", at: 2 }]);
records("a reorder moves the one section off the longest kept order", ...pair(doc(A, B, C, D), doc(A, C, B, D)),
  [{ kind: "moved", heading: "## C", from: 3, to: 2 }]);
records("a section moved and edited is both", ...pair(doc(A, B, C, D), doc(A, sec("## C", "c2"), B, D)),
  [{ kind: "moved", heading: "## C", from: 3, to: 2 }, { kind: "edited", heading: "## C", at: 2 }]);
const P = sec("# P", "p"), P2 = sec("# P2", "p"), X = sec("## X", "x"), Q = sec("# Q", "q"), SA = sec("## A", "under");
records("a section moved under a renamed parent: the rename and the move", ...pair(doc(P, X, Q, SA), doc(P2, SA, X, Q)),
  [{ kind: "renamed", from: "# P", to: "# P2", at: 1 }, { kind: "moved", heading: "## A", from: 4, to: 2 }]);

// Repeated headings: the title alone is not identity.
const N1 = sec("## Notes", "n1"), N2 = sec("## Notes", "n2");
records("two sections with one title: the second's edit names the second", ...pair(doc(N1, N2), doc(N1, sec("## Notes", "n2x"))),
  [{ kind: "edited", heading: "## Notes", at: 2 }]);
records("a same-titled section inserted first is the one added", ...pair(doc(N1, N2), doc(sec("## Notes", "n0"), N1, N2)),
  [{ kind: "added", heading: "## Notes", at: 1 }]);
const tbd = (h: string) => `${h}\n\nTBD\n`;
records("one short body under two new headings is never paired by guess", ...pair(doc(sec("## Long", "l"), tbd("## One"), tbd("## Two")),
  doc(sec("## Long", "l"), tbd("## Uno"), tbd("## Dos"))),
  [{ kind: "added", heading: "## Uno", at: 2 }, { kind: "added", heading: "## Dos", at: 3 },
   { kind: "removed", heading: "## One", from: 2, lines: 4, chars: 13 },
   { kind: "removed", heading: "## Two", from: 3, lines: 3, chars: 11 }]);

records("an empty section under a new heading is no rename: a blank body is no evidence",
  ...pair(doc(sec("## Long", "l"), "## Old\n", C), doc(sec("## Long", "l"), "## New\n", C)),
  [{ kind: "added", heading: "## New", at: 2 }, { kind: "removed", heading: "## Old", from: 2, lines: 2, chars: 8 }]);

// Preamble, trailing and the blank lines between sections.
const intro = `Intro ${F}\n`;
records("a changed preamble is its own record with both extents", ...pair(doc(intro, A, B), doc(`Intro! ${F}\n`, A, B)),
  [{ kind: "preamble", was: { lines: 2, chars: intro.length + 1 }, now: { lines: 2, chars: intro.length + 2 } }]);
records("text after the last section's content is trailing text", ...pair(doc(A, B), `${doc(A, B)}\n\n`),
  [{ kind: "trailing", was: "\n", now: "\n\n\n" }]);
records("a blank line added between two sections edits the one it follows", ...pair(doc(A, B), doc(`${A}\n`, B)),
  [{ kind: "edited", heading: "## A", at: 1 }]);
const plain = `${F}\n${F}\n${F}\n`;
// All preamble, so its one block is the whole body and any change to it is presented in full.
records("a body with no headings is all preamble", ...pair(plain, plain.replace("word7", "WORD7")), "full");

// Line endings and fences.
const crlf = (h: string, w: string) => `${h}\r\n\r\n${w} ${F}\r\n`;
records("a CRLF body: one changed section, its heading read without the carriage return",
  ...pair([crlf("# A", "alpha"), crlf("# B", "beta")].join("\r\n"), [crlf("# A", "alpha"), crlf("# B", "BETA")].join("\r\n")),
  [{ kind: "edited", heading: "# B", at: 2 }]);
const fenced = (line: string) => doc(`# A\n\n\`\`\`sh\n${line}\n\`\`\`\n\n${F}\n`, sec("# B", "b"));
records("a `#` line inside a fence is code, not a heading", ...pair(fenced("# not a heading"), fenced("# still not a heading")),
  [{ kind: "edited", heading: "# A", at: 1 }]);
const tilde = (line: string) => doc(`# A\n\n~~~\n${line}\n~~~\n\n${F}\n`, sec("# B", "b"));
records("a fenced `#` line added or removed moves no section", ...pair(tilde("x"), tilde("## fake\nx")),
  [{ kind: "edited", heading: "# A", at: 1 }]);

// Metadata: one record per changed field, in a fixed order; tag order is not a change.
records("each metadata field is its own record", snap(doc(A, B), { title: "Old", tags: ["b", "a"], stakeholder: "kim", fields: { due: "1", gone: "x" } }),
  snap(doc(A, B), { title: "New", tags: ["a", "b", "c"], stakeholder: "lee", fields: { due: "2", owner: "me" } }),
  [{ kind: "metadata", field: "title", was: "Old", now: "New" },
   { kind: "metadata", field: "tags", was: "a, b", now: "a, b, c" },
   { kind: "metadata", field: "stakeholder", was: "kim", now: "lee" },
   { kind: "metadata", field: "fields.due", was: "1", now: "2" },
   { kind: "metadata", field: "fields.gone", was: "x", now: "" },
   { kind: "metadata", field: "fields.owner", was: "", now: "me" }]);
records("tags in another order are the same tags", snap(doc(A), { tags: ["b", "a"] }), snap(doc(A), { tags: ["a", "b"] }), []);

// The delta's text: the records, then every added or edited block in full.
{
  const got = deltaOf(snap(doc(A, B)), snap(doc(A, sec("## B", "b2"), C)));
  const want = `edited "## B" at section 2\nadded "## C" at section 3\n\n## B\n\nb2 ${F}\n\n## C\n\nc ${F}`;
  if (got.kind !== "delta" || got.text !== want) fail.push(`the delta text is the records then each changed block: ${JSON.stringify(got)}`);
}

// The full fallback, at its boundary: a delta as long as the target's body is full, one shorter is not.
{
  const line = 'title: was "A"; now "B"';
  const at = (n: number) => deltaOf(snap("x".repeat(n), { title: "A" }), snap("x".repeat(n), { title: "B" }));
  const equal = at(line.length), shorter = at(line.length + 1);
  if (equal.kind !== "full") fail.push(`a delta exactly as long as the body is full: ${JSON.stringify(equal)}`);
  if (shorter.kind !== "delta" || shorter.text !== line) fail.push(`a delta one character shorter is a delta: ${JSON.stringify(shorter)}`);
  records("everything replaced is full", doc(A), doc(sec("## Z", "z")), "full");
}

// Every byte accounted for: a snapshot against itself has no record, and one character inserted or
// deleted at any offset of any body above has at least one.
let probes = 0;
for (const body of new Set(bodies)) {
  const self = deltaOf(snap(body), snap(body));
  if (self.kind === "delta" && self.records.length) fail.push(`a body against itself has records: ${JSON.stringify(body)}`);
  for (let i = 0; i <= body.length; i++) {
    const edits = [body.slice(0, i) + "Z" + body.slice(i), body.slice(0, i) + "\n" + body.slice(i)];
    if (i < body.length) edits.push(body.slice(0, i) + body.slice(i + 1));
    for (const now of edits) {
      probes++;
      const got = deltaOf(snap(body), snap(now));
      if (got.kind === "delta" && !got.records.length) {
        fail.push(`a one-character change at offset ${i} gave no record: ${JSON.stringify(now.slice(Math.max(0, i - 20), i + 20))}`);
        break;
      }
    }
  }
}

if (fail.length) {
  console.error(`document-delta: ${fail.length} failure(s)\n  - ${fail.join("\n  - ")}`);
  process.exit(1);
}
console.log(`document-delta: every case gives its exact records, the full fallback holds at its boundary, ` +
            `and ${probes} one-character changes each gave a record`);
