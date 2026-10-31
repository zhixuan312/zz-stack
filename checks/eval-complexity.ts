#!/usr/bin/env node
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
const { complexityDelta, parseUnifiedDiff } = await import(pathToFileURL(join(process.cwd(), "services/zz-core/dist/eval/complexity.js")).href);
assert.equal(complexityDelta({ lines_added: 30, lines_removed: 10, components_added: 1, components_removed: 0 }), 40);
assert.equal(complexityDelta({ lines_added: 0, lines_removed: 50, components_added: 0, components_removed: 1 }), -70, "pruning is negative");
assert.equal(complexityDelta({ lines_added: 0, lines_removed: 0, components_added: 0, components_removed: 0 }), 0);

// A `diff -ruN` patch carries no `diff --git` headers: each file opens with `--- `/`+++ ` lines,
// which follow the previous file's last hunk and are not body lines of it. One body line that
// starts with `---` (a front-matter delimiter) is a removed line all the same.
const ruN = [
  "--- a/one.md\t2026-10-31", "+++ b/one.md\t2026-10-31", "@@ -1,3 +1,3 @@", " keep", "----", "+---", " end",
  "--- a/two.md\t2026-10-31", "+++ b/two.md\t2026-10-31", "@@ -1 +1,2 @@", " x", "+y",
  "--- /dev/null\t1970-01-01", "+++ b/three.md\t2026-10-31", "@@ -0,0 +1 @@", "+new",
].join("\n");
const stats = parseUnifiedDiff(ruN);
assert.deepEqual([stats.lines_added, stats.lines_removed], [3, 1], `a header-less patch counted ${stats.lines_added} added, ${stats.lines_removed} removed`);
assert.deepEqual(stats.files, [{ path: "one.md", change: "modified" }, { path: "two.md", change: "modified" },
                               { path: "three.md", change: "added" }], "a header-less patch names its files from --- and +++");
// The git form is unchanged.
const git = ["diff --git a/x.md b/x.md", "new file mode 100644", "--- /dev/null", "+++ b/x.md", "@@ -0,0 +1,2 @@", "+---", "+a"].join("\n");
assert.deepEqual(parseUnifiedDiff(git), { lines_added: 2, lines_removed: 0, files: [{ path: "x.md", change: "added" }] });
console.log("ok eval-complexity");
