#!/usr/bin/env node
/**
 * The edit primitive: an exact batch applied to one original body, or EVERY reason it cannot be —
 * each failing edit named by its index, in the order sent — and the refusal text a repeated `find`
 * gets: its lines counted, at most 40 shown, the rest left to the detail.
 * Run: node checks/document-edits.ts   (also run by scripts/gate.ts)
 */
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const { applyEdits } = await import(pathToFileURL(join(process.cwd(), "services/zz-core/dist/document-edits.js")).href);
const { batchRefusal, refusalText } = await import(pathToFileURL(join(process.cwd(), "services/zz-core/dist/document-details.js")).href);
const fail: string[] = [];
const is = (cond: unknown, why: string) => { if (!cond) fail.push(why); };
const ok = (body: string, edits: { find: string; replace: string }[], want: string, why: string) => {
  const r = applyEdits(body, edits);
  is("body" in r && r.body === want, `${why}: ${JSON.stringify(r)}`);
};
const no = (body: string, edits: { find: string; replace: string }[], code: string, why: string) => {
  const r = applyEdits(body, edits);
  is("refusals" in r && r.refusals[0]?.code === code, `${why}: expected ${code}, got ${JSON.stringify(r)}`);
};

ok("中文🙂\r\nalpha\r\nbeta\r\n", [{ find: "alpha", replace: "A" }, { find: "beta", replace: "B" }],
   "中文🙂\r\nA\r\nB\r\n", "Unicode and CRLF survive two disjoint edits");
ok("left\nalpha\nright", [{ find: "alpha", replace: "" }], "left\n\nright", "an empty replace deletes");
ok("a b", [{ find: "a", replace: "b" }, { find: "b", replace: "c" }], "b c",
   "a replacement never becomes the next edit's target");
no("abc", [{ find: "missing", replace: "x" }], "NO_MATCH", "a find that is not there");
no("x x", [{ find: "x", replace: "y" }], "MULTIPLE_MATCHES", "a find that repeats");
no("aaaa", [{ find: "aa", replace: "b" }], "MULTIPLE_MATCHES", "overlapping occurrences of one find count");
no("abcdef", [{ find: "abc", replace: "x" }, { find: "bcde", replace: "y" }], "OVERLAPPING_EDITS", "two spans overlap");
no("abc", [{ find: "", replace: "x" }], "INVALID_EDIT", "an empty find");
no("abc", [], "EDIT_COUNT", "no edits");
no("abc", Array.from({ length: 129 }, (_, i) => ({ find: `f${i}`, replace: "" })), "EDIT_COUNT", "129 edits");
no("abc", [{ find: "a", replace: "x" }, { find: "missing", replace: "y" }], "NO_MATCH", "one bad edit fails the batch");
const rep = applyEdits("one\ntwo x\nthree x\n", [{ find: "x", replace: "y" }]);
is("refusals" in rep && JSON.stringify(rep.refusals[0].lines) === "[2,3]", `a repeated match names its lines: ${JSON.stringify(rep)}`);
const at = applyEdits("p\nq", [{ find: "p", replace: "P" }, { find: "zz", replace: "" }]);
is("refusals" in at && at.refusals.length === 1 && at.refusals[0].edit_index === 1,
   `the failing edit is named by index: ${JSON.stringify(at)}`);

// Every failing edit, in the order sent: each is judged against the one original body, so one
// failing says nothing about another.
const all = applyEdits("a b a c\nd", [{ find: "zz", replace: "" }, { find: "b", replace: "B" }, { find: "a", replace: "" },
                                      { find: "", replace: "x" }, { find: "b a", replace: "y" }, { find: "d", replace: "D" }]);
is("refusals" in all && JSON.stringify(all.refusals.map((r: { code: string; edit_index: number }) => `${r.edit_index}:${r.code}`))
     === JSON.stringify(["0:NO_MATCH", "2:MULTIPLE_MATCHES", "3:INVALID_EDIT", "4:OVERLAPPING_EDITS"]),
   `every failing edit is not named, in order: ${JSON.stringify(all)}`);

// A repeated `find`: its lines counted, 40 shown, the rest named by the detail.
const lines = Array.from({ length: 50 }, (_, i) => i + 1);
const many = batchRefusal("i/doc.md", { code: "MULTIPLE_MATCHES", edit_index: 0, match_count: 50, lines });
const said = refusalText([many]);
is(/^ERROR: MULTIPLE_MATCHES — edit 0 \(0-based\): `find` occurs 50 times in the body, on lines \(50\): 1, 2, .*, 40, …\. Send a longer/.test(said)
   && /\ndetails: `dr_[a-z2-7]{26}` — 10 entries not shown above$/.test(said),
   `a repeated find's 50 lines are not counted, capped at 40 and backed by a detail: ${said}`);
const two = refusalText([batchRefusal("i/doc.md", { code: "MULTIPLE_MATCHES", edit_index: 1, match_count: 2, lines: [3, 5] })]);
is(two === "ERROR: MULTIPLE_MATCHES — edit 1 (0-based): `find` occurs 2 times in the body, on lines (2): 3, 5. " +
          "Send a longer `find` that includes enough surrounding text to occur exactly once.",
   `an uncut refusal prints its whole list and no details line: ${two}`);

// A short repeated `find` in a long body numbers every occurrence in one forward pass. Counting
// each line from offset 0 again is quadratic: 14.7 s here, on the one event loop every team shares.
const big = Array.from({ length: 40_000 }, (_, i) => `line ${i} the quick brown fox`).join("\n");
const t0 = performance.now();
const slow = applyEdits(big, [{ find: "the", replace: "a" }]);
const took = performance.now() - t0;
is(took < 1500 && "refusals" in slow && slow.refusals[0].match_count === 40_000 && slow.refusals[0].lines[39_999] === 40_000,
   `40,000 occurrences are numbered in linear time: ${Math.round(took)} ms`);

if (fail.length) {
  console.error(`document-edits: ${fail.length} failure(s)\n  - ${fail.join("\n  - ")}`);
  process.exit(1);
}
console.log("document-edits: an exact batch applies to one original body, all or nothing, and names what it could not apply");
