#!/usr/bin/env node
// Task I-18's own pure slice beyond complexityDelta (the plan-authored eval-complexity.ts covers
// that one alone): the unified-diff parser, the component mapping candidate_record's touched_
// components reads from, and the proposer bundle's non_trivial rule (AC-37.1).
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

import type {
  ComplexityInput, ManifestComponent, PatchFile, PatchStats, TouchedComponent,
} from "../services/zz-core/dist/eval/complexity.js";
import type {
  ProposerBundleRaw, RawAssessment, RawFinding, RawRejectedCandidate,
} from "../services/zz-core/dist/eval/proposer-bundle.js";

const complexity = await import(
  pathToFileURL(join(process.cwd(), "services/zz-core/dist/eval/complexity.js")).href);
const bundle = await import(
  pathToFileURL(join(process.cwd(), "services/zz-core/dist/eval/proposer-bundle.js")).href);

const { parseUnifiedDiff, componentCounts, touchedComponents, patchDigest, hypothesisDigest, complexityDelta } = complexity;
const { buildProposerBundle } = bundle;

// -- parseUnifiedDiff --------------------------------------------------------------------
const diff = [
  "diff --git a/skills/foo/SKILL.md b/skills/foo/SKILL.md",
  "index 111..222 100644",
  "--- a/skills/foo/SKILL.md",
  "+++ b/skills/foo/SKILL.md",
  "@@ -1,2 +1,3 @@",
  " unchanged line",
  "-old line",
  "+new line one",
  "+new line two",
  // A removed line that is itself the three characters "---" (every SKILL.md's own YAML
  // front-matter delimiter) and an added line starting "++" — regression fixture for the bug
  // the advisor caught: counting +/- by prefix alone, rather than by "inside a hunk", mistook a
  // body line that merely LOOKS like a +++/--- path header for one and silently dropped it.
  "-" + "---",
  "+" + "++not-a-header",
  "diff --git a/skills/bar/SKILL.md b/skills/bar/SKILL.md",
  "new file mode 100644",
  "index 000..333",
  "--- /dev/null",
  "+++ b/skills/bar/SKILL.md",
  "@@ -0,0 +1,1 @@",
  "+brand new skill",
  "diff --git a/skills/baz/SKILL.md b/skills/baz/SKILL.md",
  "deleted file mode 100644",
  "index 444..000",
  "--- a/skills/baz/SKILL.md",
  "+++ /dev/null",
  "@@ -1,1 +0,0 @@",
  "-gone",
].join("\n");

const stats: PatchStats = parseUnifiedDiff(diff);
assert.equal(stats.lines_added, 4, "2 body adds + 1 body add that looks like a path header + 1 new-file body line");
assert.equal(stats.lines_removed, 3, "1 body remove + 1 body remove that looks like a path header + 1 deleted-file body line");
assert.equal(stats.files.length, 3);
const files: readonly PatchFile[] = stats.files;
// SYNTHETIC: these are fixture patch-file paths, not real skill files this check reads.
assert.deepEqual(files.map((f) => [f.path, f.change]), [
  ["skills/foo/SKILL.md", "modified"], // SYNTHETIC: fixture path, not a real file
  ["skills/bar/SKILL.md", "added"], // SYNTHETIC: fixture path, not a real file
  ["skills/baz/SKILL.md", "removed"], // SYNTHETIC: fixture path, not a real file
]);

const counts = componentCounts(files);
assert.deepEqual(counts, { added: 1, removed: 1 });

// candidate_record's own composition of parseUnifiedDiff + componentCounts + complexityDelta —
// exercised end to end here, against real diff-derived numbers rather than a hand-picked one,
// with the exact ComplexityInput shape candidates.ts builds and passes.
const complexityInput: ComplexityInput = {
  lines_added: stats.lines_added, lines_removed: stats.lines_removed,
  components_added: counts.added, components_removed: counts.removed,
};
assert.equal(complexityDelta(complexityInput), 4 - 3 + 20 * 1 - 20 * 1, "4 added, 3 removed, one new file, one deleted file");

// -- touchedComponents --------------------------------------------------------------------
const manifest: ManifestComponent[] = [{ kind: "skill", name: "foo" }];
const touched: TouchedComponent[] = touchedComponents(files, manifest);
assert.equal(touched[0].kind, "skill");
assert.equal(touched[0].name, "foo");
assert.equal(touched[0].in_manifest, true, "matched the base subject's own manifest entry");
assert.equal(touched[1].in_manifest, false, "a brand-new skill names nothing the base manifest had");
assert.equal(touched[1].kind, "skill", "still inferred from its own /skills/ path");

// -- digests --------------------------------------------------------------------------------
assert.equal(patchDigest(diff), patchDigest(diff), "deterministic over the same diff text");
assert.notEqual(patchDigest(diff), patchDigest(diff + "\n"), "sensitive to the diff's own bytes");
assert.equal(
  hypothesisDigest("Retry the flaky call.  "), hypothesisDigest("retry the flaky call."),
  "normalised — whitespace/case never change the idea being compared");
assert.notEqual(hypothesisDigest("Retry the flaky call."), hypothesisDigest("Cache the flaky call."));

// -- buildProposerBundle ---------------------------------------------------------------------
const emptyRaw: ProposerBundleRaw = { findings: [], assessments: [], rejected: [] };
const empty = buildProposerBundle(emptyRaw);
assert.equal(empty.non_trivial, false, "nothing recorded yet is a trivial bundle");

const richFindings: RawFinding[] = [
  { id: "f1", kind: "defect", pattern: "Refuses every request naming a date range.", evidence_refs: [] },
  { id: "f2", kind: "defect", pattern: "User had to restate the goal twice before it understood.", evidence_refs: [] },
  { id: "f3", kind: "strength", pattern: "Handles the happy path cleanly.", evidence_refs: [] },
];
const richAssessments: RawAssessment[] = [
  { measure_key: "m1", subject_ref: "s1", value: 0.2, excluded_reason: null, detail: { reading: "weak" } },
  { measure_key: "m2", subject_ref: "s1", value: null, excluded_reason: "no comparable answer", detail: {} },
];
const richRejected: RawRejectedCandidate[] = [
  { candidate_id: "c1", hypothesis: "add a retry", status: "rolled_back" },
];
const richRaw: ProposerBundleRaw = { findings: richFindings, assessments: richAssessments, rejected: richRejected };
const rich = buildProposerBundle(richRaw);
assert.equal(rich.non_trivial, true);
assert.equal(rich.failing_traces.length, 2, "both assessments score below the 0.5 threshold");
assert.equal(rich.evaluator_critiques.length, 1);
assert.equal(rich.errors.length, 1);
assert.equal(rich.refusal_text.length, 1, "the refusal-shaped defect");
assert.equal(rich.corrections.length, 1, "the other defect, not refusal-shaped");
assert.equal(rich.prior_rejected_hypotheses.length, 1);
assert.deepEqual([...bundle.REJECTED_CANDIDATE_STATUSES], ["invalid", "rolled_back"],
  "a failed build and a release real use rolled back are the two ideas never proposed again");

console.log("ok eval-candidates-pure");
