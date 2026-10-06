#!/usr/bin/env node
/**
 * The edit primitive: an exact batch applied to one original body, or the reason it cannot be.
 * Run: node checks/document-edits.ts   (also run by scripts/gate.ts)
 */
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const { applyEdits } = await import(pathToFileURL(join(process.cwd(), "services/zz-core/dist/document-edits.js")).href);
const fail: string[] = [];
const is = (cond: unknown, why: string) => { if (!cond) fail.push(why); };
const ok = (body: string, edits: { find: string; replace: string }[], want: string, why: string) => {
  const r = applyEdits(body, edits);
  is("body" in r && r.body === want, `${why}: ${JSON.stringify(r)}`);
};
const no = (body: string, edits: { find: string; replace: string }[], code: string, why: string) => {
  const r = applyEdits(body, edits);
  is("code" in r && r.code === code, `${why}: expected ${code}, got ${JSON.stringify(r)}`);
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
is("lines" in rep && JSON.stringify(rep.lines) === "[2,3]", `a repeated match names its lines: ${JSON.stringify(rep)}`);
const at = applyEdits("p\nq", [{ find: "p", replace: "P" }, { find: "zz", replace: "" }]);
is("edit_index" in at && at.edit_index === 1, `the failing edit is named by index: ${JSON.stringify(at)}`);

if (fail.length) {
  console.error(`document-edits: ${fail.length} failure(s)\n  - ${fail.join("\n  - ")}`);
  process.exit(1);
}
console.log("document-edits: an exact batch applies to one original body, all or nothing, and names what it could not apply");
