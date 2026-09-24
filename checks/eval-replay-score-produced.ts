#!/usr/bin/env node
// Fix dispatch on initiative 2026-09-24-plugin-eval-next-version, defect 1 (CRITICAL): a replay's
// score never measured the replay — replay_score asked a model-backed measure to judge a
// templated sentence naming an id, never anything the session actually produced. This is the
// offline half of that fix's own discriminator ("two stub sessions producing different outputs
// must get different scores"): producedSubjectText renders two different produced records into
// two different subject texts — the live half (a real replay_score call actually scoring two
// different transcripts two different ways) needs a database and a model behind it, established
// by agent-review of a live run instead. Also covers scoreReplay's two refusals that need no
// database row at all: an unknown replay_run_id, and a run with no produced output yet.
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const { producedSubjectText, scoreReplay } = await import(
  pathToFileURL(join(process.cwd(), "services/zz-core/dist/eval/replay-score.js")).href);

// ---- producedSubjectText: pure, and the root mechanism the whole fix depends on — if this
// renders two different inputs into the same text, no model downstream could ever tell them
// apart, whatever else is fixed.
const textA = producedSubjectText({
  transcript: "I renamed the export to computeTotal and added a unit test.",
  artifacts: [{ path: "src/total.ts", sha256: "a".repeat(64), bytes: 120, head: "export function computeTotal() {}" }],
});
const textB = producedSubjectText({
  transcript: "I could not find a way to satisfy the contract and left the file unchanged.",
  artifacts: [],
});
assert.notEqual(textA, textB, "two different produced records render two different subject texts");
assert.match(textA, /computeTotal/, "the transcript's own content reaches the rendered text");
assert.match(textA, /src\/total\.ts/, "an artifact's path reaches the rendered text");
assert.match(textB, /no files written|no files to its worktree|wrote no files/i,
  "an empty artifact list is said plainly, never rendered as an empty section");

// Same transcript, different artifacts — still different, so a measure judging the artifacts
// alone (not just the closing remark) still has something to discriminate on.
const textC = producedSubjectText({
  transcript: "Done.",
  artifacts: [{ path: "a.ts", sha256: "b".repeat(64), bytes: 10, head: "const a = 1;" }],
});
const textD = producedSubjectText({
  transcript: "Done.",
  artifacts: [{ path: "a.ts", sha256: "c".repeat(64), bytes: 10, head: "const a = 2;" }],
});
assert.notEqual(textC, textD, "the same closing remark over different file content still renders differently");

// ---- scoreReplay's two guards that need no real database row, a stub pool standing in for the
// query surface it touches before anything else.
const KNOWN_RUN = "55555555-5555-5555-5555-555555555555";
const stubNoRun = { async query() { return { rows: [], rowCount: 0 }; } };
const noRun = await scoreReplay(stubNoRun, KNOWN_RUN, "idem-1", "ada@zz.test");
assert.match(noRun.error, new RegExp(`ERROR: unknown replay_run_id ${KNOWN_RUN}`));

const stubNoProduced = {
  async query(text: string) {
    if (text.includes("join zz.eval_protocol_version")) {
      return {
        rows: [{
          id: KNOWN_RUN, status: "completed", case_id: "66666666-6666-6666-6666-666666666666",
          protocol_version_id: "77777777-7777-7777-7777-777777777777", protocol_version: 1,
          subject_version_id: "88888888-8888-8888-8888-888888888888", candidate_id: null,
          produced: null,
        }],
        rowCount: 1,
      };
    }
    throw new Error(`stub Db: unrecognised query — ${text}`);
  },
};
const noProduced = await scoreReplay(stubNoProduced, KNOWN_RUN, "idem-2", "ada@zz.test");
assert.match(noProduced.error, /carries no produced output to score/,
  "a run with no produced output refuses by name, rather than scoring an empty subject as if it meant something");

console.log("ok eval-replay-score-produced");
