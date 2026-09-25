#!/usr/bin/env node
// Round-3 review, the abandon race: replay_start checks its verifier_token before its transaction
// opens, and candidate_prove(abandon) can revoke the token in between. replay_start now re-reads
// the token row inside its own transaction, right before the run insert, FOR SHARE
// (`liveAllocationRefusal`, replay-verifier.ts): a start racing an abandon either commits before
// the revoke — the revoke waits on the lock, so the abandon's cancel and count see the run — or
// sees the revoke and is refused by name. Proven with a stub Db (what the re-read asks and how
// it answers) and on replay-runs.ts's own text (where the re-read sits: inside the transaction,
// after everything else, before the insert).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const { liveAllocationRefusal } = await import(
  pathToFileURL(join(process.cwd(), "services/zz-core/dist/eval/replay-verifier.js")).href);

const ALLOC = "70000000-0000-4000-8000-000000000001";
const seen: { sql: string; values: unknown[] }[] = [];
const stub = (live: boolean) => ({
  async query(text: string, values: unknown[] = []) {
    seen.push({ sql: text.replace(/\s+/g, " ").trim(), values });
    return { rows: live ? [{ id: ALLOC }] : [], rowCount: live ? 1 : 0 };
  },
});

assert.equal(await liveAllocationRefusal(stub(true), ALLOC), null, "an unrevoked token lets the start through");
assert.match(await liveAllocationRefusal(stub(false), ALLOC), /^ERROR: verifier_token revoked while this replay_start was in flight/,
  "a token revoked since the start's first check is refused by name");
const [read] = seen;
assert.match(read.sql, /from zz\.replay_verifier_token where id = \$1::uuid and revoked_at is null for share$/,
  "the re-read asks for this allocation's row, unrevoked, FOR SHARE");
assert.doesNotMatch(read.sql, /for key share/,
  "never FOR KEY SHARE: the revoke's NO KEY UPDATE would not wait for it, and would commit past the start");
assert.deepEqual(read.values, [ALLOC]);

// Where it sits in replay_start: inside the idempotent transaction (on `client`), after the case
// draw and the team provisioning, immediately before the run insert.
const src = readFileSync(join(process.cwd(), "services/zz-core/src/eval/replay-runs.ts"), "utf8");
const start = src.indexOf('principal, "replay_start", idempotency_key');
const draw = src.indexOf("verifierCaseDraw(client", start);
const provision = src.indexOf("provisionReplayTeam(client", start);
const recheck = src.indexOf("liveAllocationRefusal(client, allocation.id)", start);
const insert = src.indexOf("insert into zz.replay_run", start);
assert.ok(start > 0 && draw > start && provision > draw, "replay_start's transaction draws and provisions");
assert.ok(recheck > provision && recheck < insert, "the re-read is the last thing before the run insert");
assert.deepEqual(src.slice(recheck, insert).match(/await [\w.]+/g), ["await client.query"],
  "nothing else runs between the re-read and the insert — the one await left is the insert's own");

console.log("ok eval-replay-start-token-race");
