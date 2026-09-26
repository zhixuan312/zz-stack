#!/usr/bin/env node
/**
 * The live chain check is walked with a superadmin's token, and never passes on a skip.
 *
 * Drives scripts/release/chain-verdict.ts with no deployment:
 *   1. token selection: ZZ_PROBE_TOKEN when set; ZZ_TOKEN, marked as no probe token, when not;
 *      `unknown` for a malformed probe token, no address, or no token at all;
 *   2. a run that exited 0 but printed a superadmin `skip` line (chain-check.ts's
 *      knowledge_reindex, chain-bugs.ts's bug_list/bug_resolve) -> `unknown: no probe token`
 *      without one, `unknown` naming the role with one — never green; no such line -> clean;
 *   3. the skip lines it reads are the ones chain-check and chain-bugs really print — read from
 *      their source, so a reworded skip cannot silently turn back into a pass;
 *   4. chainCheck reads probeToken, not envToken — the admin token is the one that skipped.
 *
 * Run: node checks/release-probe-token.ts
 */
import { readFileSync } from "node:fs";

import { chainOutcome, chainToken, skippedSuperadmin } from "../scripts/release/chain-verdict.ts";

const fail: string[] = [];
const is = (cond: unknown, why: string) => { if (!cond) fail.push(why); };

// 1. Token selection
const URL = "https://zz.example";
const sel = chainToken(URL, "zzp_admin", "zzp_super");
is("token" in sel && sel.token === "zzp_super" && sel.probe, "a probe token is set and the chain is not walked with it");
const noProbe = chainToken(URL, "zzp_admin", "");
is("token" in noProbe && noProbe.token === "zzp_admin" && !noProbe.probe,
   "no probe token, and the chain is not walked with ZZ_TOKEN marked as lacking one");
is("verdict" in chainToken(URL, "zzp_admin", "zzp_ab cd # comment"), "a malformed probe token was accepted");
is("verdict" in chainToken("", "zzp_admin", "zzp_super"), "no address and the walk would still run");
is("verdict" in chainToken(URL, "", ""), "no token of either kind and the walk would still run");

// 2. Outcomes
const REINDEX = "  skip  knowledge_reindex is behind `if (sup)` and this token's role is not offered it — nothing measured";
const BUGS = "  skip  bug_list/bug_resolve are behind `if (sup)` and this token's role is not offered them";
const OTHER = "  skip  a registered source cannot be overwritten — source_list named no path";
const run = `ok\n${REINDEX}\n${BUGS}\n${OTHER}\n40/40 platform checks passed\n`;
const absent = chainOutcome(run, false);
is(absent?.verdict === "unknown" && /no probe token/.test(absent.detail) && /2 superadmin probe/.test(absent.detail),
   "no probe token and skipped superadmin probes is not `unknown: no probe token` counting two");
const wrongRole = chainOutcome(run, true);
is(wrongRole?.verdict === "unknown" && /not a superadmin's/.test(wrongRole.detail),
   "a probe token that still skipped superadmin probes is not an unknown naming its role");
const named = chainOutcome(run, false, "smoke@example.com (member)");
is(named !== null && /walked with ZZ_TOKEN, which is smoke@example\.com \(member\)/.test(named.detail),
   "the unknown does not say whose token walked the chain");
is(chainOutcome(`ok\n${OTHER}\n40/40 platform checks passed\n`, false) === null,
   "a skip that is not a superadmin's turned a clean run into an unknown");

// 3. The lines are the real ones
for (const f of ["packages/tools/src/testing/chain-check.ts", "packages/tools/src/testing/chain-bugs.ts"]) {
  const printed = [...readFileSync(f, "utf8").matchAll(/console\.log\("(  skip  [^"]*`if \(sup\)`[^"]*)"/g)].map((m) => m[1]);
  is(printed.length > 0, `${f} prints no superadmin skip line this check recognises — reworded, and a skip would pass again`);
  for (const line of printed) is(skippedSuperadmin(line).length === 1, `${f}'s skip line "${line}" is not recognised`);
}

// 4. The token it reads
const src = readFileSync("scripts/release/chain-live.ts", "utf8");
const body = src.slice(src.indexOf("export function chainCheck"));
is(/chainToken\(gw, envToken\(\), probeToken\(\)\)/.test(body) && /chainOutcome\(out, walk\.probe[,)]/.test(body),
   "chainCheck no longer selects its token through chainToken, or no longer tells chainOutcome which it used");

if (fail.length) {
  console.error(`release-probe-token: ${fail.length} failure(s)`);
  for (const f of fail) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("release-probe-token: no probe token or a skipped superadmin probe is unknown; the walk reads ZZ_PROBE_TOKEN");
