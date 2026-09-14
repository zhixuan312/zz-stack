#!/usr/bin/env node
/**
 * Does `shownSinceLastChange` actually answer the question it claims to?
 *
 * A PREPARED SCRIPT, deliberately, and this file is the argument for the idea. The behaviour
 * below was first verified by pulling the compiled function out of `dist/server.js` with a
 * regular expression and running it through `new Function` — composed on the spot, correct
 * that once, and gone. Nothing could re-run it, so nothing would notice the day the function
 * changed. Choosing a prepared check and running it beats writing one live: same answer,
 * repeatable, and it fails when the thing it guards moves.
 *
 * Fixtures rather than a live store: the answer must not depend on a machine or a network.
 * The first four cases are the real shapes out of 2026-09-10-progressive-sdlc-deck, which is
 * where the gap was found — four of that initiative's six approvals had no fetch since the
 * content last moved.
 *
 * Run: node checks/attest-shown.ts   (also run by scripts/gate.ts)
 */
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const mod = join(process.cwd(), "services/zz-core/dist/attest.js");
const { shownSinceLastChange } = await import(pathToFileURL(mod).href);

const root = mkdtempSync(join(tmpdir(), "zz-attest-"));
const INIT = "2026-01-01-fixture";
mkdirSync(join(root, INIT), { recursive: true });

/** One activity.jsonl line per entry: [action, document]. */
const write = (entries: [string, string][]) =>
  writeFileSync(
    join(root, INIT, "activity.jsonl"),
    entries.map(([action, doc]) => JSON.stringify({
      ts: "2026-01-01T00:00:00.000Z", user: "a@b", action, path: `${INIT}/${doc}`,
    })).join("\n") + "\n",
  );

const cases: [string, boolean | null, [string, string][]][] = [
  ["written then shown then approved      -> fetched", true,
   [["document_write", "d.md"], ["shown", "d.md"], ["document_approve", "d.md"]]],
  ["revised then approved, never shown    -> NOT fetched", false,
   [["document_write", "d.md"], ["shown", "d.md"], ["document_approve", "d.md"],
    ["document_revise", "d.md"], ["document_approve", "d.md"]]],
  ["shown, then PATCHED, then approved    -> NOT fetched", false,
   [["document_write", "d.md"], ["shown", "d.md"], ["document_patch", "d.md"], ["document_approve", "d.md"]]],
  ["shown AFTER the last patch            -> fetched", true,
   [["document_write", "d.md"], ["document_patch", "d.md"], ["shown", "d.md"], ["document_approve", "d.md"]]],
  // Another document's fetch must not vouch for this one — the log is shared per initiative.
  ["another document was the one shown    -> NOT fetched", false,
   [["document_write", "d.md"], ["shown", "other.md"], ["document_approve", "d.md"]]],
  // Silence, not a warning, when there is nothing to be "since".
  ["no recorded change at all             -> null (silent)", null,
   [["shown", "d.md"]]],
];

let failed = 0;
for (const [name, want, entries] of cases) {
  write(entries);
  const got = shownSinceLastChange(root, `${INIT}/d.md`);
  const ok = got === want;
  if (!ok) failed += 1;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}  (got ${got})`);
}
// No log file at all, and a path that is not '<initiative>/<doc>.md'.
for (const [name, arg, want] of [
  ["no activity log at all                -> null (silent)", "2026-01-01-absent/d.md", null],
  ["a path that is not initiative/doc     -> null (silent)", "d.md", null],
]) {
  const got = shownSinceLastChange(root, arg);
  const ok = got === want;
  if (!ok) failed += 1;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}  (got ${got})`);
}

// ── AND THE APPROVAL PATH ACTUALLY ASKS ───────────────────────────────────────────────────
//
// Everything above drives `shownSinceLastChange` directly against a temporary store, which
// proves the function is right and proves NOTHING about whether anything calls it. Task I-20
// measured the consequence: unwire the call from `document_approve`, leave the import in place,
// and this file still printed "8 cases passed" against an approval that had stopped asking.
// `checks/eval-tools-moved.ts` does not close it either — it asserts initiative-acts IMPORTS
// attest, and an unused import is still an import.
//
// A function that works and a path that uses it are two claims, and a check that drives the
// function can only ever make the first.
const HANDLER = "services/zz-core/src/tools/initiative-acts.ts";
const src = readFileSync(HANDLER, "utf8");
const approve = src.slice(src.indexOf('"document_approve"'));
const body = approve.slice(0, approve.indexOf("\n  );"));
if (!body.includes("shownSinceLastChange(")) {
  console.error(`\nattest-shown: ${HANDLER}'s document_approve handler never calls ` +
    "shownSinceLastChange — so an approval is recorded without asking whether the document was " +
    "ever shown to the person approving it, which is the one thing this file exists to attest.");
  failed++;
}

if (failed) {
  console.error(`\nattest-shown: ${failed} case(s) failed`);
  process.exit(1);
}
console.log(`\nattest-shown: ${cases.length + 2} cases passed`);
