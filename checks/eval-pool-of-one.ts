#!/usr/bin/env node
/**
 * checks/eval-pool-of-one.ts — the evaluation door's mutators finish on a pool of one connection.
 *
 *   node checks/eval-pool-of-one.ts   # needs Docker and a built tree (`npm run build`)
 *
 * `withIdempotency` (services/zz-core/src/eval/idempotency.ts) holds one pooled connection for its
 * transaction, and its callback may not ask the pool for a second: as many concurrent calls as the
 * pool has connections then each wait for one that never frees, and every tool in the process
 * stalls with them. A delta review found finding_decide's team check doing exactly that, one pool
 * query per decision inside the callback. With ZZ_DB_POOL_MAX=1 a single call shows it: the second
 * connection waits out ZZ_DB_CONNECT_TIMEOUT_MS and the call fails. It starts a throwaway PostgreSQL
 * and a real zz-core with a pool of one, seeds a team's evaluation run (eval-door-seed.ts), and
 * establishes:
 *
 *   - finding_decide on the team's own finding decides it, beside another team's finding in the same
 *     batch, which is refused in the words an unknown id gets.
 *
 * Exit 0: every case held. Exit 1: a case failed. Exit 2: Docker is not available.
 */
import { ask, evalDoor, finding, seed } from "../scripts/schema/eval-door-seed.ts";
import { withThrowawayCore } from "../scripts/schema/throwaway-core.ts";

const NAME = "eval-pool-of-one";
const DONE = "eval-pool-of-one: finding_decide finishes on a pool of one connection: ok";

// Read by the zz-core child this process starts, which inherits this environment.
process.env.ZZ_DB_POOL_MAX = "1";
process.env.ZZ_DB_CONNECT_TIMEOUT_MS = "3000";

process.exitCode = await withThrowawayCore(NAME, DONE, async (c) => {
  const s = await seed(c);
  const step = "finding_decide on a pool of one";
  const mine = await finding(c, s, "decided on one connection");
  const foreign = "00000000-0000-4000-8000-000000000001";
  const reply = await ask(evalDoor(c, c.email), "finding_decide", { idempotency_key: "pool-of-one",
    decisions: [{ finding_id: mine, decision: "rejected", note: "checked on a pool of one" },
                { finding_id: foreign, decision: "rejected", note: "nobody's" }] });
  let parsed: { decided?: number; refused?: string[] } = {};
  try { parsed = JSON.parse(reply); } catch { c.fail(step, `answered ${reply.slice(0, 300)}`); }
  if (parsed.decided !== 1 || parsed.refused?.length !== 1 || !parsed.refused[0].includes(foreign)) {
    c.fail(step, `answered ${reply.slice(0, 300)}`);
  }
  c.pass(`${step}: the team's finding decided, an unknown one refused by name`);
});
