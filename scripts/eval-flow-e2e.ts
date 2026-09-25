#!/usr/bin/env node
/**
 * eval-flow-e2e.ts — walk the whole zz-plugin-eval flow, zz-core as the subject, through the real
 * doors of a scratch deployment, and fail at the first stage an agent following the skills could
 * not finish.
 *
 * A reviewer reading the eight stage skills can infer whether an agent could get from IDENTIFY to
 * a closed initiative. This replaces the inference with a run: every argument to every call is
 * the operator's (the initiative, the plugin name) or a value an earlier call returned, and every
 * stage starts in a fresh conversation that sees nothing but what it can read back from the
 * initiative. No SQL is read to find an id — that is exactly what an agent cannot do.
 *
 *   npm run eval-flow-e2e                 stand a scratch stack up, walk, tear it down
 *   npm run eval-flow-e2e -- --keep       leave the stack up afterwards, for reading
 *
 * What is real: postgres (the deployment's own image), zz-core and the gateway from the current
 * tree, the registries a release writes, every door, `npm run candidate-build` inside its OS
 * sandbox, `zz-tool release-apply` and `release-rollback`, and the post-release judgement on real
 * use the walk seeds after deploying the release. What is not: the two model endpoints (a
 * deterministic stub on loopback, eval-flow-e2e/stub-model.ts), the release/rollback commands
 * (stubs that tag, push to a bare origin and register, eval-flow-e2e/release.ts), and the deploy
 * (zz-core restarted announcing the released version, eval-flow-e2e/stack.ts).
 *
 * It needs docker and runs for minutes, so it is not a gate check.
 *
 * Loopback only. The walk is handed its gateway, token and database by the stack it stood up, and
 * checks them against the same fail-closed allowlist scripts/control-loop-e2e.ts uses — this
 * writes sixteen initiatives, a release and a rollback into whatever it is pointed at.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";

import { transcript } from "./eval-flow-e2e/doors.ts";
import { improve, promoteVerify } from "./eval-flow-e2e/improve.ts";
import { seedUsage } from "./eval-flow-e2e/seed.ts";
import { down, restartGateway, up, type Stack } from "./eval-flow-e2e/stack.ts";
import { asked, startStub } from "./eval-flow-e2e/stub-model.ts";
import { Conversation } from "./eval-flow-e2e/doors.ts";
import { defineQualify, discover, evaluate, explain, identify, observe, type Walk } from "./eval-flow-e2e/walk.ts";

const LOOPBACK = /^(https?:\/\/)?(127\.0\.0\.1|localhost|\[::1\])(:\d+)?([/?]|$)/;
const localDb = (url: string): boolean => /@(127\.0\.0\.1|localhost|\[::1\])[:/]/.test(url);

function refuseUnlessScratch(url: string, pat: string, db: string): string | null {
  if (!url || !pat || !db) return "REFUSED — no gateway, token or database to walk against.";
  if (!LOOPBACK.test(url)) return `REFUSED — ${url} is not a loopback address.`;
  if (!localDb(db)) return "REFUSED — the database is not on this machine.";
  return null;
}

async function walk(stack: Stack): Promise<void> {
  const refusal = refuseUnlessScratch(stack.url, stack.pat, stack.db);
  if (refusal) throw new Error(refusal);
  const tag = `evalflow-${Date.now().toString(36)}`;
  const t0 = Date.now();
  const lap = (what: string): void => console.log(`  ${((Date.now() - t0) / 1000).toFixed(0).padStart(5)}s  ${what}`);

  const seeded = await seedUsage(stack.url, stack.pat, tag);
  await restartGateway(stack);   // reconcileRuns turns the event log into runs at boot
  lap(`setup: ${seeded.length} closed sdlc-flow initiatives of real zz-core use`);

  // The operator's two inputs, and nothing else crosses into the stages.
  const opener = new Conversation(stack.url, stack.pat, "operator");
  const opened = await opener.call("core", "initiative_open", { slug: `${tag}-evaluate-zz-core`, flow: "zz-plugin-eval" });
  const w: Walk = { url: stack.url, pat: stack.pat, initiative: String(opened.initiative), plugin: "zz-core" };
  lap(`operator: opened ${w.initiative}, plugin ${w.plugin}`);

  lap(`1 IDENTIFY       subject ${await identify(w)}`);
  const o = await observe(w);
  lap(`2 OBSERVE        snapshot ${o.snapshot}, ${o.usable} usable runs`);
  lap(`3 DISCOVER       ${await discover(w)} candidate(s)`);
  const d = await defineQualify(w);
  lap(`4 DEFINE/QUALIFY protocol ${d.protocol}; ${Object.entries(d.qualified).map(([k, v]) => `${k}=${v}`).join(", ")}`);
  const e = await evaluate(w);
  lap(`5 EVALUATE       eval_run ${e.evalRun}, overall ${String(e.score.overall_score)} (${String(e.score.score_status)})`);
  lap(`6 EXPLAIN        defect ${(await explain(w)).defect}`);
  const i = await improve(w, stack);
  lap(`7 IMPROVE        candidate ${i.candidate}, built and gated ${i.build}`);
  const p = await promoteVerify(w, stack, tag);
  lap(`8 PROMOTE/VERIFY released ${p.released}, ${p.runs} real runs, verify ${p.verdict} (${p.reason}), rolled back, closed`);
}

function report(ok: boolean, stubLog: string): void {
  console.log("\n  transcript (stage · tool · what came back):");
  // A run of identical silent calls prints once, with its count.
  const rows = transcript.filter((x) => x.stage !== "seed");
  for (let i = 0; i < rows.length; i += 1) {
    const r = rows[i];
    let n = 1;
    while (!r.note && rows[i + n]?.tool === r.tool && rows[i + n]?.stage === r.stage && !rows[i + n]?.note) n += 1;
    console.log(`    ${r.stage.padEnd(26)} ${(n > 1 ? `${r.tool} x${n}` : r.tool).padEnd(24)} ${r.note}`);
    i += n - 1;
  }
  console.log(`\n  model stub, questions by family: ${[...asked.entries()].map(([k, v]) => `${k}=${v}`).join(", ")}`);
  console.log(`  every question the stub answered: ${stubLog}`);
  console.log(ok ? "\n  eval-flow-e2e: ok" : "\n  eval-flow-e2e: FAILED");
}

async function main(): Promise<void> {
  const keep = process.argv.includes("--keep");
  // The stub starts first: the containers are told its port when they start.
  const stubLog = join(tmpdir(), `eval-flow-e2e-stub-${process.pid}.jsonl`);
  const { server, port } = await startStub(stubLog);
  let stack: Stack | null = null;
  let ok = false;
  try {
    stack = await up(port);
    console.log(`  stack ${stack.prefix}: gateway ${stack.url}, database ${stack.db.replace(/:[^:@/]+@/, ":***@")}`);
    await walk(stack);
    ok = true;
  } catch (err) {
    console.error(`\n  FAILED — ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    report(ok, stubLog);
    if (stack && keep) console.log(`  kept: ${stack.work} (containers ${stack.prefix}-*)`);
    else if (stack) down(stack);
    server.close();
  }
  process.exit(ok ? 0 : 1);
}

void main();
