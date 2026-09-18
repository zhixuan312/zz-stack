/**
 * Walk the CURRENT chain-check against an ALREADY-RELEASED image.
 *
 *   npx tsx scripts/release/walk-released.ts <version>
 *
 * WHY THIS EXISTS AND WHY IT IS NOT THE DRY RUN. `tool-chain.ts` stands the platform up from
 * the image being released and proves the check GREEN against the code about to ship. That is
 * the half that stops a rollback. It cannot prove the other half: that a check written for a
 * contract change actually FAILS on the code that contract replaced. A check that passes
 * against both is a check that is measuring nothing, and this repository has shipped two of
 * those — 0.46 and 0.47 both rolled back on assertions that had been quietly vacuous.
 *
 * So: same walk, same containers, an older tag. Run it, read the FAILED lines, and satisfy
 * yourself that each one names a rule you deliberately changed. Nothing is pushed and
 * production is never touched — the whole stack is a throwaway on a private network.
 */
import { die } from "../deployment.ts";
import { walkToolChain } from "./tool-chain.ts";

const version = process.argv[2];
if (!version) die("name the released version to walk against, e.g. 0.49.0");
walkToolChain(version);
