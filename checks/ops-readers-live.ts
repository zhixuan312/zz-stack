#!/usr/bin/env node
/**
 * checks/ops-readers-live.ts — the two operator readers of `zz.event`, `watch-results` and `tool-report`, run as
 * built against a migrated schema, read what the gateway writes:
 *
 *   - a refusal class that went from nothing to six in this window is an alert, read from the `refusal` column the
 *     telemetry writer fills, and every statement the monitor sends runs on the real schema;
 *   - `tool-report --actor <address>` selects exactly that address's calls, whatever client made them, by hashing the
 *     address the way the gateway's `callerKey` keys `detail.caller` — and an address given in another case still
 *     matches, because the identity middleware folds the address it forwards.
 *
 *   node checks/ops-readers-live.ts   # needs Docker and a built tree (`npm run build`)
 *
 * Exit 0: every case held. Exit 1: a case failed, quoting what was found. Exit 2: Docker is not available — not a pass.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { root } from "../scripts/deployment.ts";
import { failing, withThrowawayDbCheck, type Fail } from "../scripts/schema/throwaway.ts";

const NAME = "ops-readers-live";
const DONE = "ops-readers-live: watch-results alerts on a refusal class from the refusal column, and " +
  "tool-report --actor selects one address's calls by the gateway's own caller hash: ok";
const fail: Fail = failing(NAME);

const { callerKey } = await import(pathToFileURL(join(root, "services/gateway/dist/step-trace.js")).href) as
  { callerKey: (headers: Record<string, unknown>) => string };
const callerHash = (email: string, client?: string): string =>
  createHash("sha256").update(callerKey({ "x-zz-user-email": email, ...(client ? { "x-zz-client": client } : {}) }))
    .digest("hex").slice(0, 12);

process.exitCode = await withThrowawayDbCheck(NAME, DONE, async (c) => {
  // The throwaway's own psql, inside its container.
  // COUPLED: the container name `withThrowawayDb` gives the database it starts for this process.
  const container = `zz-schema-target-pg-${process.pid}`;
  const psql = `docker exec -i ${container} psql -U zz -d zz`;
  const tool = (file: string, ...argv: string[]) =>
    spawnSync(process.execPath, [join(root, "packages/tools/dist", file), "--psql", psql, ...argv],
      { encoding: "utf8" });

  const call = (ago: string, ok: boolean, refusal: string | null, email: string, client?: string) =>
    c.query(
      `insert into zz.event (ts, kind, subject, tool_key, ok, refusal, origin, detail)
       values (now() - $1::interval, 'tool_call', 'core:document_write', 'core:document_write', $2, $3, 'work', $4)`,
      [ago, ok, refusal, { caller: callerHash(email, client), ...(client ? { client } : {}) }]);
  for (let n = 0; n < 6; n++) await call("1 hour", false, "ERROR: path is required", "person@example.com", "zz-plugin");
  await call("1 hour", true, null, "smoke_eval@example.com");
  await call("2 hours", true, null, "smoke_eval@example.com", "smoke");
  await call("8 days", true, null, "person@example.com", "zz-plugin");

  const step2 = "--actor selects one address's calls across its clients";
  for (const actor of ["smoke_eval@example.com", "Smoke_Eval@Example.com"]) {
    const report = tool("testing/tool-report.js", "--actor", actor, "--origin", "all", "--json");
    let calls: unknown = null;
    try { calls = (JSON.parse(report.stdout) as { calls: number }).calls; } catch { /* reported below */ }
    if (report.status !== 0 || calls !== 2) {
      fail(step2, `--actor ${actor}: exit ${report.status}, calls ${String(calls)}, said ` +
        JSON.stringify((report.stdout + report.stderr).trim().slice(0, 600)));
    }
  }
  console.log(`  ${step2}`);
  const step1 = "a refusal class that went from 0 to 6 is an alert";
  const watched = tool("ops/watch-results.js");
  if (watched.status !== 1 || !/refusals up: 0 to 6/.test(watched.stdout)) {
    fail(step1, `exit ${watched.status}, said ${JSON.stringify((watched.stdout + watched.stderr).trim().slice(0, 600))}`);
  }
  console.log(`  ${step1}`);

  const step3 = "a query the database refuses is exit 2 with its error, not an empty window";
  const refused = tool("ops/watch-results.js", "--window", "nonsense");
  if (refused.status !== 2 || !/psql failed: .*invalid input syntax for type interval/s.test(refused.stderr)) {
    fail(step3, `exit ${refused.status}, said ${JSON.stringify((refused.stdout + refused.stderr).trim().slice(0, 600))}`);
  }
  console.log(`  ${step3}`);

});
