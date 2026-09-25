#!/usr/bin/env node
/**
 * `withInitiativeFactsLock` (initiative-record.ts) — the lock a `_facts.json` read-check-write
 * holds — on the no-database path, the one a checkout runs:
 *
 *   1. two holders of the same initiative never overlap, and the second sees the first's write;
 *   2. two different initiatives do not wait on each other;
 *   3. it is reentrant within one call chain, so a holder may call `writeBranchFacts`, which
 *      takes it again, without waiting on itself forever;
 *   4. a holder that throws releases the lock for the next one.
 *
 * Run: node checks/initiative-facts-lock.ts   (also run by scripts/gate.ts)
 */
import { join } from "node:path";
import { pathToFileURL } from "node:url";

delete process.env.TEAM_DB_URL;
const { withInitiativeFactsLock } = await import(
  pathToFileURL(join(process.cwd(), "services/zz-core/dist/initiative-record.js")).href);

const fail: string[] = [];
const is = (cond: unknown, why: string) => { if (!cond) fail.push(why); };
const tick = () => new Promise((r) => setTimeout(r, 5));

// 1. same initiative: serialized, and the second read sees the first write
{
  let value = 0;
  let inside = 0;
  let overlapped = false;
  const bump = () => withInitiativeFactsLock("a", async () => {
    if (++inside > 1) overlapped = true;
    const read = value;
    await tick();
    value = read + 1;
    inside--;
  });
  await Promise.all([bump(), bump(), bump()]);
  is(!overlapped && value === 3, `same-initiative holders overlapped (value ${value}, overlapped ${overlapped})`);
}

// 2. different initiatives run side by side
{
  const order: string[] = [];
  await Promise.all([
    withInitiativeFactsLock("b", async () => { order.push("b-in"); await tick(); await tick(); order.push("b-out"); }),
    withInitiativeFactsLock("c", async () => { order.push("c-in"); await tick(); order.push("c-out"); }),
  ]);
  is(order.indexOf("c-in") < order.indexOf("b-out"), `a different initiative waited on another's lock: ${order.join(",")}`);
}

// 3. reentrant within one call chain
{
  const nested = await Promise.race([
    withInitiativeFactsLock("d", () => withInitiativeFactsLock("d", async () => "nested")),
    new Promise((r) => setTimeout(() => r("deadlocked"), 1000)),
  ]);
  is(nested === "nested", `a nested hold of the same initiative did not run: ${String(nested)}`);
}

// 4. a throw releases
{
  const threw = await withInitiativeFactsLock("e", async () => { throw new Error("boom"); }).catch((e: Error) => e.message);
  const after = await Promise.race([
    withInitiativeFactsLock("e", async () => "released"),
    new Promise((r) => setTimeout(() => r("still held"), 1000)),
  ]);
  is(threw === "boom" && after === "released", `a throwing holder did not release the lock: ${String(threw)} / ${String(after)}`);
}

if (fail.length) {
  console.error(`initiative-facts-lock: ${fail.length} failure(s)\n  - ${fail.join("\n  - ")}`);
  process.exit(1);
}
console.log("initiative-facts-lock: one holder per initiative, none across initiatives, reentrant within a call " +
            "chain, and released on a throw");
