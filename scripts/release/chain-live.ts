/**
 * chain-check.ts, run against the live deployment rather than from scripts/gate.ts.
 *
 * verifyLive()'s `doors` and `contract` layers prove a tool answers and the surface matches
 * source; neither proves a tool completes what it claims to. chain-check.ts writes a document,
 * approves it, closes the initiative and supersedes a knowledge node for real, against this
 * deployment, with no model in the loop. It needs a running deployment and a real token, so it
 * is not in the gate, which is offline.
 *
 * Its own token: ZZ_PROBE_TOKEN, a superadmin's. Part of the chain — bug_list, bug_resolve,
 * knowledge_reindex — is registered only for a superadmin, and chain-check skips what the token is
 * not offered. Walked with ZZ_TOKEN (whoever's it is — on this machine a member's smoke-test PAT), those
 * probes printed `skip` and the release read the run as a pass. Now, with no probe token, the chain
 * is still walked with ZZ_TOKEN and its superadmin probes come back `unknown: no probe token`; with
 * one that is not a superadmin's, the same probes come back `unknown` naming that. Never green,
 * never a rollback.
 *
 * COUPLED: the same three-verdict rule as the doctor's probes (scripts/doctor/run.ts) — a missing
 * credential is `unknown`, and only a run that happened and disagreed is `wrong`, the one a
 * release may roll back on.
 */
import { join } from "node:path";

import { asExecError, envToken, probeToken, publicUrl, root, run } from "../deployment.ts";
import { chainOutcome, chainToken, type Verdict } from "./chain-verdict.ts";
import { purgeProbes } from "./probe-purge.ts";
import { tokenHolder } from "./token-holder.ts";

export function chainCheck(): Verdict {
  const gw = publicUrl();
  const walk = chainToken(gw, envToken(), probeToken());
  if ("verdict" in walk) return walk;
  try {
    const out = run("node", [join(root, "packages/tools/dist/testing/chain-check.js")],
                    { env: { ...process.env, ZZ_GATEWAY: gw, ZZ_PAT: walk.token } });
    const outcome = chainOutcome(out, walk.probe);
    return outcome ? chainOutcome(out, walk.probe, tokenHolder(gw, walk.token)) : null;
  } catch (err) {
    // What chain-check itself printed, not the exception execFileSync wraps a nonzero exit
    // in — its FAILED lines already name the tool and the rule.
    const e = asExecError(err);
    const out = `${e.stdout ?? ""}${e.stderr ?? ""}`;
    const failing = out.split("\n").filter((l) => l.includes("FAILED:")).map((l) => l.trim());
    return { verdict: "wrong",
      detail: failing.length ? `chain-check: ${failing.join(" | ")}` : `chain-check exited nonzero: ${out.slice(-300)}` };
  } finally {
    purgeProbes();  // a chain check that failed still takes its initiative with it
  }
}
