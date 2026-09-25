#!/usr/bin/env node
// Release-review fix (finding 12): replay_score refuses the candidate session's own credential —
// a PAT bound to the run's own replay team — the same rule replay_begin/replay_close apply
// (replay-close.ts's candidateCredentialRefusal), checked before anything is asked or written.
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const { scoreReplay } = await import(
  pathToFileURL(join(process.cwd(), "services/zz-core/dist/eval/replay-score.js")).href);

const RUN = "55555555-5555-5555-5555-555555555555";
const stub = {
  async query(text: string) {
    if (text.includes("join zz.eval_protocol_version")) {
      return {
        rows: [{
          id: RUN, status: "completed", case_id: "66666666-6666-6666-6666-666666666666",
          protocol_version_id: "77777777-7777-7777-7777-777777777777", protocol_version: 1,
          subject_version_id: null, candidate_id: "88888888-8888-8888-8888-888888888888",
          produced: null, team_slug: "replay-abc", split: "proof",
        }],
        rowCount: 1,
      };
    }
    throw new Error(`stub Db: unrecognised query — ${text}`);
  },
};

const refused = await scoreReplay(stub, RUN, "idem-1", "ada@zz.test", "replay-abc");
assert.match(refused.error, /replay_score refuses a credential scoped to the run's own replay team/,
  "the candidate's own run-bound PAT is refused by name");

const other = await scoreReplay(stub, RUN, "idem-2", "ada@zz.test", "some-other-team");
assert.match(other.error, /carries no produced output/,
  "a credential bound to another team passes the guard and reaches the next check");
const unbound = await scoreReplay(stub, RUN, "idem-3", "ada@zz.test", null);
assert.match(unbound.error, /carries no produced output/, "the launcher's unbound credential passes the guard");

console.log("ok eval-replay-score-guard");
