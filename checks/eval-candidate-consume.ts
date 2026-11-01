#!/usr/bin/env node
/**
 * checks/eval-candidate-consume.ts — the request a `candidate_validate` consume is recorded under
 * in the idempotency ledger names the build it consumes, not the candidate alone. Pure: the built
 * `candidate-validate.js` and `idempotency.js`, no database.
 *
 *   node checks/eval-candidate-consume.ts   # needs a built tree (`npm run build`)
 *
 * A candidate whose first build timed out goes back to recorded and is built again. Digested by
 * its id alone, a key reused for the second consume was the first request replayed: nothing moved,
 * the second build stayed unconsumed in awaiting_build, and the reply could still say valid
 * (second read, rs12-1). Bound to the build, the reuse is another request, refused as a conflict.
 *
 * Exit 0: every case held. Exit 1: the failing cases, each with what it got.
 */
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const load = (p: string) => import(pathToFileURL(join(process.cwd(), p)).href);
const { consumeRequest } = await load("services/zz-core/dist/eval/candidate-validate.js") as {
  consumeRequest(c: { id: string; build_recorded_at: Date | null }): Record<string, unknown>;
};
const { requestDigest } = await load("services/zz-core/dist/eval/idempotency.js") as {
  requestDigest(args: Record<string, unknown>): string;
};

const id = "11111111-1111-1111-1111-111111111111";
const first = new Date("2026-10-31T10:00:00.000Z");
const second = new Date("2026-10-31T11:00:00.000Z");
const digest = (at: Date | null) => requestDigest(consumeRequest({ id, build_recorded_at: at }));

let failed = 0;
const holds = (name: string, ok: boolean, got: unknown): void => {
  if (!ok) failed += 1;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `\n         got ${JSON.stringify(got)}`}`);
};

holds("a second build's consume is another request than the first's", digest(first) !== digest(second),
  consumeRequest({ id, build_recorded_at: second }));
holds("the same build's consume, retried, is the same request", digest(first) === digest(new Date(first.getTime())),
  consumeRequest({ id, build_recorded_at: first }));
holds("the request still names the candidate", consumeRequest({ id, build_recorded_at: first }).candidate_id === id,
  consumeRequest({ id, build_recorded_at: first }));

if (failed) process.exit(1);
console.log("ok eval-candidate-consume");
