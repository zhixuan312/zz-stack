#!/usr/bin/env node
// I-15: the pure slice of reserved replay teams — the two refusals that fire before either
// function touches a database, so both run here with no platform db connected at all.
//   1. team_create refuses any `replay-` slug, superadmin included.
//   2. provisionReplayTeam refuses a caller whose own PAT is team-bound, with
//      replay_requires_unbound_credential.
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const contracts = await import(
  pathToFileURL(join(process.cwd(), "packages/contracts/dist/index.js")).href);
const { createTeam } = await import(
  pathToFileURL(join(process.cwd(), "services/gateway/dist/admin/teams.js")).href);

const { REPLAY_TEAM_PREFIX, REPLAY_REQUIRES_UNBOUND_CREDENTIAL, provisionReplayTeam } = contracts;

// team_create's reserved-prefix guard runs before createTeam ever calls platformDb(), so this
// exercises the real function with no pool initialised — a superadmin identity is enough to
// prove the refusal is not merely "not authorised".
const superadmin = {
  email: "root@example.com", displayName: "root", platformRole: "superadmin",
  teams: [], activeTeam: null, via: "forwarded",
};
const refusal = await createTeam(superadmin, `${REPLAY_TEAM_PREFIX}sdlc-a1b2c3d4`, "should not exist");
assert.equal(refusal.ok, false, "team_create must refuse a replay- slug, even for a superadmin");
assert.match(refusal.error, /reserved/i, "the refusal should name the reserved prefix");

// provisionReplayTeam refuses a team-bound caller before it ever queries its db argument — a
// stub whose query() throws proves the refusal happens first, not just that it happens.
const untouchedDb = {
  query: async () => {
    throw new Error("provisionReplayTeam touched the database before checking the caller's binding");
  },
};
await assert.rejects(
  provisionReplayTeam(untouchedDb, {
    principal: "person@example.com",
    principalPatTeam: "some-other-team",
    plugin: "sdlc",
    runId: "11111111-1111-1111-1111-111111111111",
    expiresAt: new Date().toISOString(),
  }),
  (err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    assert.match(message, new RegExp(REPLAY_REQUIRES_UNBOUND_CREDENTIAL));
    return true;
  },
  "a team-bound caller must be refused with replay_requires_unbound_credential, before touching the db",
);

console.log("ok replay-team-pure");
